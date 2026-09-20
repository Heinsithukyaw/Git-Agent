/**
 * Advisory triage, in three layers.
 *
 *   Layer 1 — rules.       Version arithmetic, symbol matching, severity.
 *                          Deterministic, testable, versionable in a diff.
 *                          This is a real implementation, not a placeholder:
 *                          with no model key at all the agent still decides.
 *   Layer 2 — typed layer. Optional, off by default. Asked only what rules
 *                          cannot answer, one atomic question at a time.
 *   Layer 3 — escalation.  Genuinely ambiguous cases are surfaced for the
 *                          narrator to ask about, never silently resolved.
 *
 * The decision rule is ours, not the model's. A typed layer returns typed
 * values; the rule that turns them into a decision is code, and it lives here.
 *
 * What is recorded is what makes this auditable: the typed values, the
 * composite score, the threshold τ, and the resolved model version. You cannot
 * replay a model call. You can replay a decision.
 *
 * **A `noul` answer carries no `confidence` field.** The number *is* the answer
 * and the certainty in one, so reading a confidence off it does not fail — it
 * silently reads `undefined`, and the usual `?? 1` guard then turns "no such
 * field" into maximum certainty and every downstream floor stops firing. The
 * guard is a two-sided band instead: a score in the middle of the range is no
 * signal rather than a weak yes, and no signal is escalated, never resolved.
 */

import * as v from './version.mjs';

export const TAU_DEFAULT = 0.6;

/**
 * The model the typed layer is asked for when the user names none.
 *
 * `jev-latest` is the vendor's own alias and the default in both of their SDKs,
 * so a template that made the user discover it would be a worse template. It is
 * an *alias*, though, and therefore a moving target: the response reports the
 * versioned id that actually answered, that id is recorded on every row, and
 * pinning it here is the documented step once thresholds have been tuned
 * against a particular version. The endpoint has no default — `JEV_BASE_URL` is
 * required — so this constant is not an opinion about *where* to send the
 * request, only about which of that service's own models to ask for.
 */
export const DEFAULT_TYPED_MODEL = 'jev-latest';

/**
 * Status codes worth a second attempt.
 *
 * `529` is the one that matters and the one a generic list leaves out: it is
 * "the service is overloaded", a transient condition, and treating it as
 * permanent turns a busy minute into a failed run. The set otherwise matches
 * `lib/llm.mjs`, which is deliberate — two clients, one retry policy.
 */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const DEFAULT_TYPED_TIMEOUT_MS = 15_000;
const DEFAULT_TYPED_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 20_000;
/** Truncation for an error body, which is committed to a public log. */
const ERROR_BODY_CHARS = 200;

export const DECISIONS = {
  CLEAR: 'clear',         // not affected — nothing to do
  WATCH: 'watch',         // affected, but not on a path we use
  ACT: 'act',             // affected and reachable — bump it
  MITIGATE: 'mitigate',   // affected, no fixed version available
  UNCERTAIN: 'uncertain', // rules ran out; needs layer 2, or a human
};

/* ------------------------------------------------------------- severity ---- */

/** CVSS vector -> approximate numeric score. Returns null when absent. */
export function severityScore(advisory) {
  const sev = advisory?.severity;
  // `null` is the common case, not the edge case: OSV omits severity on many
  // advisories, and lib/sources.mjs normalises that to an explicit null. A
  // `typeof sev === 'object'` test without this guard dereferences null and
  // takes the whole triage run down.
  if (sev === null || sev === undefined) return null;
  if (typeof sev === 'number') return Number.isFinite(sev) ? sev : null;
  if (typeof sev === 'string') {
    // A numeric string is a score. A word such as "HIGH" is not, and inventing a
    // number for it would put a made-up figure in an audited record — it is
    // surfaced as a label instead, by severityLabel().
    const t = sev.trim();
    return /^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : null;
  }
  if (Array.isArray(sev)) {
    const withScore = sev.find((s) => typeof s?.score === 'string');
    if (withScore) return parseCvss(withScore.score);
    return null;
  }
  if (typeof sev === 'object' && typeof sev.score === 'string') return parseCvss(sev.score);
  return null;
}

/**
 * The label the source published, when it published a word instead of a score.
 *
 * Quoted, never converted: the digest is allowed to repeat what the source said
 * and is not allowed to translate it into a number it did not receive.
 */
export function severityLabel(advisory) {
  const sev = advisory?.severity;
  if (typeof sev !== 'string') return null;
  const t = sev.trim();
  if (!t || /^\d+(\.\d+)?$/.test(t)) return null;
  return t;
}

function parseCvss(str) {
  // Accept "CVSS:3.1/AV:N/..." or a bare numeric score.
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const base = { AV: 0.85, AC: 0.77, PR: 0.85, UI: 0.85, S: 'U', C: 0, I: 0, A: 0 };
  const parts = Object.fromEntries(
    str.split('/').filter((p) => p.includes(':')).map((p) => p.split(':')),
  );
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[parts.AV] ?? 0.85;
  const ac = { L: 0.77, H: 0.44 }[parts.AC] ?? 0.77;
  const pr = { N: 0.85, L: 0.62, H: 0.27 }[parts.PR] ?? 0.85;
  const ui = { N: 0.85, R: 0.62 }[parts.UI] ?? 0.85;
  const cia = (x) => ({ H: 0.56, L: 0.22, N: 0 }[x] ?? 0);
  const iss = 1 - (1 - cia(parts.C)) * (1 - cia(parts.I)) * (1 - cia(parts.A));
  const impact = 6.42 * iss;
  const exploitability = 8.22 * av * ac * pr * ui;
  const raw = impact > 0 ? Math.min(impact + exploitability, 10) : 0;
  return Math.round(raw * 10) / 10;
}

/* ---------------------------------------------------------------- rules ---- */

/** Do the advisory's details name a symbol we actually import? */
function symbolMatch(advisory, pkg) {
  const symbols = pkg?.usage?.imported_symbols;
  if (!Array.isArray(symbols) || symbols.length === 0) return 'unknown';
  const details = `${advisory.summary ?? ''}\n${advisory.details ?? ''}`.toLowerCase();
  if (!details.trim()) return 'unknown';
  const hit = symbols.filter((s) => {
    const esc = String(s).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![a-z0-9_])${esc}(?![a-z0-9_])`).test(details);
  });
  return hit.length ? { hit } : { hit: [] };
}

/**
 * Layer 1. Pure function of the payload — no network, no model, no clock.
 */
export function rulesDecide(advisory, pkg) {
  const pinned = pkg?.pinned ?? null;
  const allRanges = advisory.affected ?? [];
  const ranges = allRanges.filter((r) => r.type === 'ECOSYSTEM' || !r.type);
  // Ranges we cannot evaluate with version arithmetic. A GIT range names
  // commits, so "the pinned version is outside it" is not a conclusion this
  // code is entitled to draw — and drawing it would report a real advisory as
  // clear, which is the one failure mode the whole design is arranged against.
  const unevaluableRanges = allRanges.length - ranges.length;
  const affected = pinned ? v.inAnyRange(pinned, ranges) : null;
  const upgrade = pinned ? v.smallestUpgrade(pinned, ranges) : null;
  const score = severityScore(advisory);
  const symbols = symbolMatch(advisory, pkg);

  const evidence = {
    pinned,
    affected,
    ranges: ranges.length,
    unevaluable_ranges: unevaluableRanges,
    upgrade,
    severity: score,
    symbols: symbols === 'unknown' ? 'unknown' : symbols.hit,
    runtime: pkg?.usage?.runtime ?? null,
  };

  if (affected === null) {
    return { decision: DECISIONS.UNCERTAIN, reason: 'pinned version unknown', evidence };
  }
  if (!ranges.length && unevaluableRanges > 0) {
    return {
      decision: DECISIONS.UNCERTAIN,
      reason: `affected ranges are published only as ${[...new Set(allRanges.map((r) => r.type ?? 'untyped'))].join('/')}, which version arithmetic cannot evaluate`,
      evidence,
    };
  }
  if (!affected) {
    return { decision: DECISIONS.CLEAR, reason: 'pinned version is outside the affected range', evidence };
  }
  if (!upgrade) {
    return { decision: DECISIONS.MITIGATE, reason: 'affected, and no fixed version is published', evidence };
  }
  if (symbols === 'unknown') {
    return { decision: DECISIONS.UNCERTAIN, reason: 'affected, but usage is unmapped — reachability unknown', evidence };
  }
  if (symbols.hit.length > 0) {
    return { decision: DECISIONS.ACT, reason: `affected, and we import ${symbols.hit.join(', ')}`, evidence };
  }
  return { decision: DECISIONS.WATCH, reason: 'affected, but not on a symbol we import', evidence };
}

/* --------------------------------------------------------- typed layer ---- */

/**
 * Layer 2. Atomic decomposition: not "is this dangerous?" but the two judgments
 * that together imply it, each narrow enough to be inspected and tuned.
 *
 * Returns typed answers, the resolved model version, and the token usage. Never
 * prose.
 *
 * The request shape is the part that is easy to get wrong, because the vendor's
 * own pages disagree with each other. The field is **`model`, and it is a
 * string** — not `selectedModels`, which survives only in some of their stale
 * examples. A request that sends `selectedModels` and omits `model` fails
 * validation with `422`; and a value built as `model ? [model] : undefined`
 * drops the field entirely when the config is empty, which fails identically.
 * `tests/triage.test.mjs` asserts the body for exactly that reason: nothing did,
 * and the bug shipped.
 */
export async function typedDecide(
  advisory,
  pkg,
  { baseUrl, apiKey, model, timeoutMs = DEFAULT_TYPED_TIMEOUT_MS, retries = DEFAULT_TYPED_RETRIES },
) {
  if (!baseUrl || !apiKey) {
    throw new Error('typed layer is enabled but has no base URL or key configured');
  }
  const state = {
    advisory: {
      id: advisory.id,
      summary: advisory.summary ?? '',
      details: (advisory.details ?? '').slice(0, 3000),
      affected: (advisory.affected ?? []).map((r) => `${r.introduced} .. ${r.fixed ?? 'unfixed'}`).join(' | '),
    },
    ours: {
      package: pkg?.name ?? null,
      pinned: pkg?.pinned ?? null,
      usage: {
        imported_symbols: pkg?.usage?.imported_symbols ?? [],
        call_sites: pkg?.usage?.call_sites ?? [],
        runtime: pkg?.usage?.runtime ?? null,
      },
    },
  };

  const body = {
    state,
    model: model || DEFAULT_TYPED_MODEL,
    questions: {
      we_use_the_vulnerable_component: {
        type: 'noul',
        instructions: {
          question: 'Does `advisory.details` describe a flaw in one of `ours.usage.imported_symbols`?',
          compare: ['`advisory.details`', '`ours.usage.imported_symbols`'],
          focus: 'Require the flawed component to be one we actually import.',
        },
        criteria: {
          true: { what: 'The vulnerable component is among our imported symbols' },
          false: { what: 'The vulnerable component is not imported, or is unclear' },
        },
      },
      reaches_a_trust_boundary: {
        type: 'noul',
        instructions: {
          question: 'Does any path in `ours.usage.call_sites` handle untrusted input?',
          inspect: '`ours.usage.call_sites`',
          focus: 'Judge exposure, not exploitability.',
        },
      },
    },
  };

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/systemone`;
  let lastErr;
  let lastRes = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, retryDelayMs(lastRes, attempt)));
    lastRes = null;
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // A timeout or a socket error is as transient as a 503, and the loop is
      // the only thing that can decide that. Without this the first network
      // hiccup ends the run.
      lastErr = err.name === 'TimeoutError' ? new Error(`typed layer timed out after ${timeoutMs}ms`) : err;
      continue;
    }

    if (RETRY_STATUS.has(res.status) && attempt < retries) {
      lastErr = new Error(`typed layer returned HTTP ${res.status}`);
      // Kept so the next iteration can honour a `retry-after` from this one.
      lastRes = res;
      continue;
    }
    if (!res.ok) {
      // The body is the only thing that says *which* field failed validation,
      // so a bare status code turns a 422 into a guess. It is truncated because
      // it lands in a committed record on a public repository.
      const detail = await res
        .text()
        .then((t) => t.replace(/\s+/g, ' ').trim().slice(0, ERROR_BODY_CHARS))
        .catch(() => '');
      throw new Error(`typed layer returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    }

    const json = await res.json();
    return {
      answers: json?.answers ?? {},
      // `json.model` reports the *versioned* id that answered. `model_version`
      // and `modelVersion` are not fields of this API — reading them returns
      // undefined, which is how a row ends up claiming no provenance at all.
      modelVersion: json?.model ?? null,
      usage: json?.usage ?? null,
    };
  }
  throw lastErr ?? new Error('typed layer call failed');
}

/**
 * How long to wait before attempt `attempt`.
 *
 * `retry-after` wins when the service sent one, because it knows more about its
 * own load than an exponential backoff does. Both forms the header allows are
 * handled — delay-seconds and an HTTP-date — and the result is capped, since a
 * service that asks for an hour is a service to skip, not to wait on.
 */
function retryDelayMs(res, attempt) {
  const raw = res?.headers?.get?.('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_DELAY_MS);
  }
  return Math.min(500 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/* ------------------------------------------------------------ compose ---- */

/**
 * Compose layers into one decision.
 *
 * Rules are authoritative when they are confident. The typed layer is consulted
 * only on `uncertain`, and it may only move an uncertain case — it can never
 * overturn a rule that already reached a verdict. Thresholding is code.
 *
 * The threshold is a **band**, and the band is the correction that matters. A
 * `noul` is a probability that carries its own certainty, so a value near the
 * middle is *no signal*, not medium intensity — `>= 0.5` is the wrong way to
 * read one. A single threshold therefore has to guess in exactly the region
 * where guessing is least defensible, and both answers are guessed in the same
 * direction, because both feed one score. Widening the threshold into a band
 * puts that region somewhere honest instead: it escalates.
 *
 * The band is symmetric about the middle and its width is set by τ, so there is
 * still exactly one tunable parameter. Where to put it is a cost question —
 * move it down when acting on a false yes is expensive, up when missing a true
 * yes is — and this layer sits behind a human-reviewed digest, so the cheap
 * error is a false act and the expensive one is a silent clear.
 */
export function compose({ rules, typed = null, tau = TAU_DEFAULT }) {
  if (rules.decision !== DECISIONS.UNCERTAIN) {
    return {
      decision: rules.decision,
      reason: rules.reason,
      layer: 'rules',
      evidence: rules.evidence,
      tau,
      typed: null,
      modelVersion: null,
    };
  }
  if (!typed) {
    return {
      decision: DECISIONS.UNCERTAIN,
      reason: `${rules.reason} — no typed layer configured, so this needs your call`,
      layer: 'rules',
      evidence: rules.evidence,
      tau,
      typed: null,
      modelVersion: null,
    };
  }

  const reach = noulOf(typed.answers, 'reaches_a_trust_boundary');
  const uses = noulOf(typed.answers, 'we_use_the_vulnerable_component');
  const vector = { reaches_a_trust_boundary: reach, we_use_the_vulnerable_component: uses };

  // The reasons below are deliberately number-free, and that is load-bearing
  // rather than stylistic. `buildFacts()` hands this string to the narrator, and
  // the narrator's output is checked by the containment gate against the fetched
  // payload — where a score such as 0.72 does not appear, because it is
  // arithmetic over model output, not a fact about the world. A number in this
  // string is therefore a sentence the gate is right to reject.
  //
  // The numbers live in `typed.score` and the top-level `tau`, where they are
  // structured and auditable. `renderReply()`'s `why` verb prints them from
  // there, and that is safe: the gate in `reply-step.mjs` covers `modelAnswer`,
  // the model's raw text, not the rendered reply, which is a deterministic
  // template over stored rows.

  // A missing answer is not a `no`. The two are the same value to arithmetic
  // and opposite claims about the world: absent means the call did not return a
  // usable answer, and reading that as zero would clear a real advisory — the
  // one failure mode this whole design is arranged against. So it escalates.
  if (reach === null || uses === null) {
    return {
      decision: DECISIONS.UNCERTAIN,
      reason: 'the typed layer returned nothing usable for this case, so this still needs your call',
      layer: 'typed',
      evidence: { ...rules.evidence, ...vector, score: null },
      tau,
      typed: { ...vector, score: null },
      modelVersion: typed.modelVersion,
    };
  }

  // Equal weights, in code where they can be reviewed and changed without
  // rerunning inference. Equal because the two questions are a conjunction —
  // the second only means anything if the first holds — and because a mean
  // keeps the escalation band symmetric about the middle. A weighted sum would
  // tilt the band, which is a policy decision this layer has no evidence for.
  const score = Math.round(((uses + reach) / 2) * 1000) / 1000;

  // The band's lower edge. `Math.min` is not defensive noise: it makes the
  // band *close* rather than *invert* for τ below 0.5. A τ under a half means
  // "act on a coin-flip", and there is no middle left to escalate — which is a
  // coherent setting, but only if it degrades to a plain threshold instead of
  // silently swallowing every score.
  const bandLow = Math.min(1 - tau, tau);

  if (score > bandLow && score < tau) {
    return {
      decision: DECISIONS.UNCERTAIN,
      reason:
        'the typed layer put this in the middle of its range, which is no signal rather than a weak yes, so this needs your call',
      layer: 'typed',
      evidence: { ...rules.evidence, ...vector, score },
      tau,
      typed: { ...vector, score },
      modelVersion: typed.modelVersion,
    };
  }

  const decision = score >= tau ? DECISIONS.ACT : DECISIONS.WATCH;
  const scored = { ...vector, score };
  return {
    decision,
    reason:
      decision === DECISIONS.ACT
        ? 'the typed layer judged this reachable'
        : 'the typed layer judged this not reachable enough to act',
    layer: 'typed',
    evidence: { ...rules.evidence, ...scored },
    tau,
    typed: scored,
    modelVersion: typed.modelVersion,
  };
}

/* -------------------------------------------------------------- triage ---- */

/**
 * Read one `noul` value out of an answers map.
 *
 * Returns a number in `[0, 1]`, or `null` when the answer is absent or is not a
 * usable number. `null` is a distinct outcome from `0`, and `compose()` treats
 * it as such — see the guard there. Anything outside the documented range is
 * clamped rather than trusted, so a malformed answer cannot manufacture a score
 * that decides.
 */
function noulOf(answers, key) {
  const raw = answers?.[key]?.noul;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, 0), 1);
}

/**
 * Triage a whole payload.
 *
 * @param {object} payload   the fetched payload from lib/sources.mjs
 * @param {object} [opts]    { typed: { enabled, baseUrl, apiKey, model }, tau }
 * @returns {Promise<object[]>} one decision record per (advisory × package)
 */
export async function triage(payload, { typed = { enabled: false }, tau = TAU_DEFAULT } = {}) {
  const byName = new Map((payload.packages ?? []).map((p) => [p.name, p]));
  const out = [];

  for (const advisory of payload.advisories ?? []) {
    const pkg = byName.get(advisory.package) ?? null;
    const rules = rulesDecide(advisory, pkg);

    let typedResult = null;
    let typedError = null;
    if (rules.decision === DECISIONS.UNCERTAIN && typed.enabled) {
      try {
        typedResult = await typedDecide(advisory, pkg, typed);
      } catch (err) {
        typedError = String(err.message ?? err);
      }
    }

    const final = compose({ rules, typed: typedResult, tau });
    out.push({
      observed_at: payload.observed_at,
      advisory_id: advisory.id,
      aliases: advisory.aliases ?? [],
      package: advisory.package,
      ecosystem: advisory.ecosystem,
      pinned: pkg?.pinned ?? null,
      upgrade: final.evidence?.upgrade ?? null,
      decision: final.decision,
      reason: final.reason,
      layer: final.layer,
      tau: final.tau,
      typed: final.typed,
      // `usage` is the only record of what the call cost, and input tokens are
      // the charged half. Discarding it makes the layer's cost unauditable.
      typed_usage: typedResult?.usage ?? null,
      model_version: final.modelVersion,
      severity: final.evidence?.severity ?? null,
      severity_label: severityLabel(advisory),
      typed_error: typedError,
    });
  }

  return out;
}
