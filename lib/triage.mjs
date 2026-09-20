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

export const TAU_DEFAULT = 0.8;

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
 * Retry policy, copied from the vendor's SDK rather than invented.
 *
 * Their `RetryPolicy` defaults are explicit — `maxRetries` 2, `backoffInitialMs`
 * 500 doubling to `backoffMaxMs` 5000, `backoffJitter` 0.25, `respectRetryAfter`
 * true up to `maxRetryAfterMs` 60000, and connection and timeout errors retried —
 * so a direct HTTP call can match them instead of guessing.
 *
 * The status list is the part a hand-rolled client gets wrong. Theirs is
 * **408, 429, and the whole of 500–599**, which means `529 Overloaded` was
 * already covered and a hand-picked `{500, 502, 503, 504, 529}` silently drops
 * 501, 505, 507 and the rest of the range. Treating an unknown 5xx as permanent
 * turns a busy minute into a failed run.
 */
const DEFAULT_TYPED_RETRIES = 2;
const BACKOFF_INITIAL_MS = 500;
const BACKOFF_MAX_MS = 5_000;
const BACKOFF_JITTER = 0.25;
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_TYPED_TIMEOUT_MS = 10_000;
/** Truncation for an error body, which is committed to a public log. */
const ERROR_BODY_CHARS = 200;

function isRetryable(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

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

/** The distinct range types in a list, for a message a human has to read. */
const typesOf = (rs) => [...new Set(rs.map((r) => r.type ?? 'untyped'))].join('/');

/**
 * Layer 1. Pure function of the payload — no network, no model, no clock.
 */
export function rulesDecide(advisory, pkg) {
  const pinned = pkg?.pinned ?? null;
  const allRanges = advisory.affected ?? [];
  // Which range types this arithmetic can evaluate. OSV publishes SEMVER for npm
  // and ECOSYSTEM for PyPI and others — measured, not assumed. Both are version
  // ranges and both are checkable. This filter used to accept ECOSYSTEM and
  // reject SEMVER, which silently marked every npm advisory as unevaluable.
  const isEvaluable = (r) => r.type === 'SEMVER' || r.type === 'ECOSYSTEM' || !r.type;
  const ranges = allRanges.filter(isEvaluable);
  // Ranges we cannot evaluate with version arithmetic. A GIT range names
  // commits, so "the pinned version is outside it" is not a conclusion this
  // code is entitled to draw — and drawing it would report a real advisory as
  // clear, which is the one failure mode the whole design is arranged against.
  const unevaluable = allRanges.filter((r) => !isEvaluable(r));
  const unevaluableRanges = unevaluable.length;
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
  // Nothing to evaluate is not the same as "outside the range". An empty set is
  // vacuously satisfied by "the pinned version is outside every one of them" —
  // `inAnyRange(pinned, [])` returns false for exactly that reason — so falling
  // through to CLEAR from here reports a live advisory as clear. That is how a
  // source returning no range data at all (which is what `/v1/querybatch` did)
  // turned eleven affected advisories into a digest reading "0 to act on".
  // Absence of evidence is not evidence of absence.
  if (!ranges.length) {
    return {
      decision: DECISIONS.UNCERTAIN,
      reason: allRanges.length
        ? `affected ranges are published only as ${typesOf(allRanges)}, which version arithmetic cannot evaluate`
        : 'no affected range was published, so this advisory cannot be cleared',
      evidence,
    };
  }
  // Part of the range set is unevaluable, so we can prove we are affected but
  // not that we are not. An unevaluable range cannot un-affect us.
  if (!affected && unevaluableRanges > 0) {
    return {
      decision: DECISIONS.UNCERTAIN,
      reason: `not matched by the evaluable ranges, but ${unevaluableRanges} range(s) published as ${typesOf(unevaluable)} cannot be checked`,
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
 * Which of the typed layer's questions has a subject to reason about.
 *
 * Both questions compare the advisory against a list *we* supply, and either
 * list can be empty. A question about an empty list is not a question: "is the
 * flaw in one of the components we import?" asked of a package whose usage is
 * unmapped has exactly one possible answer, and it is an answer about zero
 * things. The model returns it with high certainty, so the band does not catch
 * it either — a `noul` of 0.04 is decisive, and it is decisive about nothing.
 *
 * That is how an empty list silently turns "reachability is unknowable in
 * principle" into "not reachable". The rules tier declined to reach that verdict
 * — that is precisely why the case is uncertain — and the typed layer must not
 * reach it by answering a vacuous question. So the question is not asked, and
 * the result says so, which is what `compose()` reads.
 */
export function answerableQuestions(pkg) {
  const has = (v) => Array.isArray(v) && v.length > 0;
  return {
    we_use_the_vulnerable_component: has(pkg?.usage?.imported_symbols),
    reaches_a_trust_boundary: has(pkg?.usage?.call_sites),
  };
}

/**
 * The two questions, and nothing else.
 *
 * Held as data rather than inline so `typedDecide()` can ask the subset that has
 * a premise. Both are `noul` — a probability carrying its own certainty — because
 * a plain yes/no would discard the "I can't tell" that the band exists to read.
 */
const QUESTION_DEFS = {
  we_use_the_vulnerable_component: {
    type: 'noul',
    instructions: {
      question: 'Does `advisory.details` describe a flaw in one of `ours.usage.imported_symbols`?',
      compare: ['`advisory.details`', '`ours.usage.imported_symbols`'],
      focus: 'Require the flawed component to be one we actually import.',
    },
    // `criteria` is optional, and it earns its place only when the yes/no
    // boundary is subtle — this one is. Two things it must do, both from the
    // vendor's own guidance: pin the boundary with a definition *and*
    // examples on each side, and — the part that is easy to get wrong — tell
    // the model that a hard-to-read advisory is not a no. An earlier version
    // of this said "not imported, **or is unclear**", which instructs the
    // model to answer 0 when it cannot tell. That converts the one input the
    // band depends on into a confident no, and the whole escalation path
    // stops firing. The `noul` value is where "I can't tell" is expressed;
    // the criteria must not take that away.
    criteria: {
      true: {
        what: 'The flaw described in `advisory.details` is in a component listed in `ours.usage.imported_symbols`',
        examples: ['A flaw in one of the symbols we import'],
      },
      false: {
        what: 'The flaw described in `advisory.details` is in a component we do not import',
        not_for: 'Do not answer no because the advisory is hard to read or the affected range is unclear — that is what the middle of the range is for',
        examples: ['A flaw in a different part of the same package, which we do not import'],
      },
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
};

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
 * examples. A request that sends `selectedModels` and omits `model` is rejected;
 * and a value built as `model ? [model] : undefined` drops the field entirely
 * when the config is empty, which is rejected identically. `tests/triage.test.mjs`
 * asserts the body for exactly that reason: nothing did, and the bug shipped.
 *
 * The rejection is **HTTP 400, not the 422 the API reference documents**, and the
 * body depends on what was wrong. A structurally invalid request — `selectedModels`
 * instead of `model`, or the field dropped — returns
 * `{"detail":{"error_type":"api_usage_error","message":"Invalid request."}}`, which
 * names nothing. A *valid* request naming a model the account cannot use returns
 * `{"detail":{"error_type":"api_usage_error","message":"Unknown model: gpt-4o"}}`,
 * which names it exactly. Both measured against the live service.
 *
 * So the captured body below is worth keeping — it is the whole diagnosis in the
 * second case — but it is not a guarantee, and the first case is the one this
 * code is most likely to produce. Do not build anything that assumes the body
 * will tell you which field to fix.
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

  // Only the questions that have something to compare against. The rest would
  // return a confident answer about an empty list, which reads downstream as a
  // decisive no — see `answerableQuestions()`.
  const ask = answerableQuestions(pkg);
  const questions = Object.fromEntries(Object.entries(QUESTION_DEFS).filter(([key]) => ask[key]));
  const unasked = Object.keys(QUESTION_DEFS).filter((key) => !ask[key]);

  if (!Object.keys(questions).length) {
    // Nothing to ask, so nothing is asked and no request is sent. That is not an
    // optimisation: a request whose `questions` map is empty asks the service to
    // answer nothing, and the honest record is that the premise was missing, not
    // that the call failed. Returning the shape the caller already handles keeps
    // that distinction in one place — `compose()` reads `unasked`.
    return { answers: {}, modelVersion: null, usage: null, unasked };
  }

  const body = { state, model: model || DEFAULT_TYPED_MODEL, questions };

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

    if (isRetryable(res.status) && attempt < retries) {
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
      unasked,
    };
  }
  throw lastErr ?? new Error('typed layer call failed');
}

/**
 * Read a numeric header, or `null` when it is absent.
 *
 * The `null` case is the whole point of this helper. `Number(null)` is `0`, not
 * `NaN`, so the obvious `const n = Number(res.headers.get('retry-after'))`
 * silently reads a missing header as a zero-second delay — which disables the
 * backoff entirely and makes every retry fire immediately. A retry storm is
 * exactly what the jitter and the backoff exist to prevent.
 */
function numericHeader(res, name) {
  const raw = res?.headers?.get?.(name);
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * How long to wait before attempt `attempt`.
 *
 * The vendor's SDK honours `Retry-After` (and `retry-after-ms`) up to a minute,
 * and falls back to jittered exponential backoff beyond that — because a server
 * asking for an hour is a server to skip, not to wait on. Both header forms are
 * handled, delay-seconds and an HTTP-date.
 *
 * The jitter is not decoration: without it every client retrying a 429 comes back
 * in the same millisecond and the retry storm recreates the overload.
 */
function retryDelayMs(res, attempt) {
  const backoff = () => {
    const base = Math.min(BACKOFF_INITIAL_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
    return base - Math.random() * base * BACKOFF_JITTER;
  };

  const afterMs = numericHeader(res, 'retry-after-ms');
  if (afterMs !== null && afterMs >= 0) {
    return afterMs <= MAX_RETRY_AFTER_MS ? afterMs : backoff();
  }

  const afterSeconds = numericHeader(res, 'retry-after');
  if (afterSeconds !== null && afterSeconds >= 0) {
    const ms = afterSeconds * 1000;
    return ms <= MAX_RETRY_AFTER_MS ? ms : backoff();
  }

  // The header may also be an HTTP-date, which is not a number.
  const raw = res?.headers?.get?.('retry-after');
  if (raw !== null && raw !== undefined) {
    const at = Date.parse(String(raw));
    if (Number.isFinite(at)) {
      const ms = Math.max(at - Date.now(), 0);
      return ms <= MAX_RETRY_AFTER_MS ? ms : backoff();
    }
  }
  return backoff();
}

/* ------------------------------------------------------------ compose ---- */

/**
 * Compose layers into one decision.
 *
 * Rules are authoritative when they are confident. The typed layer is consulted
 * only on `uncertain`, and it may only move an uncertain case — it can never
 * overturn a rule that already reached a verdict. Thresholding is code.
 *
 * The threshold is a **band, applied to each answer**, and both halves of that
 * sentence are the vendor's documented pattern rather than a choice of ours:
 *
 *     YES = 0.8; NO = 0.2;
 *     if (NO < wants_human && wants_human < YES) send_to_review(...)
 *
 * A `noul` is a probability that carries its own certainty, so a value near the
 * middle is *no signal*, not medium intensity — `>= 0.5` is the wrong way to
 * read one. Hence a band rather than a threshold.
 *
 * **Per answer, not on an average of them.** An earlier version of this averaged
 * the two values and banded the mean, which quietly undoes the band: a decisive
 * `1.0` next to an unsure `0.5` averages to `0.75` and reads as confident. The
 * model said "yes and no are equally likely" about whether we even use the
 * vulnerable component, and the mean overruled it. Averaging a probability with
 * its own negation is not a summary of the two, it is a third thing that neither
 * answer supports.
 *
 * The band is symmetric about the middle and its edges are τ and `1 - τ`, so
 * there is still exactly one tunable parameter. Where to put it is a cost
 * question — the vendor's rule is to raise it when acting on a false yes is
 * expensive and lower it when missing a true yes is. τ defaults to the value
 * their own example uses; this layer sits behind a human-reviewed digest, where
 * a false act costs a review and a silent clear costs a missed advisory, which
 * argues for lowering it once the layer has been piloted on real advisories.
 *
 * **A question with no premise was never asked, and that is not a `no`.** The
 * band catches a model that cannot tell. It cannot catch a question that has
 * nothing to compare against: ask "is the flaw in one of the components we
 * import?" about a package whose imported-symbol list is empty and the answer
 * comes back `0.04` — decisive, and decisive about zero things. Composing that
 * would turn the rules tier's `uncertain` ("reachability unknown") into `watch`
 * ("not on a path we use"), which is the silent clear this whole design exists
 * to prevent. So `typedDecide()` does not ask those questions, and the missing
 * answers escalate here like any other absent answer — with a reason that names
 * the real problem, because "the call failed" and "you have not mapped this
 * package's usage" send a human to two different places.
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

  // Questions `typedDecide()` did not ask, because their subject list is empty.
  // Read off the result rather than recomputed here, so a hand-built `typed`
  // (as in the tests) defaults to "everything was asked" — the shape a caller
  // who did not go through `typedDecide()` is entitled to assume.
  const unasked = Array.isArray(typed.unasked) ? typed.unasked : [];

  // The reasons below are deliberately number-free, and that is load-bearing
  // rather than stylistic. `buildFacts()` hands this string to the narrator, and
  // the narrator's output is checked by the containment gate against the fetched
  // payload — where a score such as 0.72 does not appear, because it is
  // arithmetic over model output, not a fact about the world. A number in this
  // string is therefore a sentence the gate is right to reject.
  //
  // The numbers live in `typed.*` and the top-level `tau`, where they are
  // structured and auditable. `renderReply()`'s `why` verb prints them from
  // there, and that is safe: the gate in `reply-step.mjs` covers `modelAnswer`,
  // the model's raw text, not the rendered reply, which is a deterministic
  // template over stored rows.

  // A missing answer is not a `no`. The two are the same value to arithmetic
  // and opposite claims about the world: absent means the call did not return a
  // usable answer, and reading that as zero would clear a real advisory — the
  // one failure mode this whole design is arranged against. So it escalates.
  //
  // Two different things arrive here, and they are worth telling apart: a call
  // that came back without a usable answer, and a question that was never asked
  // because its subject list is empty. The first is a malfunction to go and
  // look at; the second is a gap in what the package declares, and the fix is
  // to map its usage. A single sentence covering both sends a human to the
  // wrong one, so they get separate sentences.
  if (reach === null || uses === null) {
    return {
      decision: DECISIONS.UNCERTAIN,
      reason: unasked.length
        ? `${rules.reason} — and the typed layer had nothing to compare against, so this still needs your call`
        : 'the typed layer returned nothing usable for this case, so this still needs your call',
      layer: 'typed',
      evidence: { ...rules.evidence, ...vector, unsure: null, unasked },
      tau,
      typed: { ...vector, unsure: null, unasked },
      modelVersion: typed.modelVersion,
    };
  }

  // The band's lower edge, rounded because `1 - 0.8` is `0.19999999999999996`
  // and the documented boundary is exactly `0.2`. Without the rounding a `noul`
  // of exactly `0.2` falls *inside* the band and escalates, which is the one
  // value the vendor's own example treats as a decisive no. `Math.min` is the
  // other half: it makes the band *close* rather than *invert* for τ below 0.5.
  // A τ under a half means "act on a coin-flip", and there is no middle left to
  // escalate — coherent, but only if it degrades to a plain threshold instead of
  // silently swallowing every answer.
  const noEdge = Math.min(Number((1 - tau).toFixed(3)), tau);

  // Each answer is read on its own, because each carries its own certainty.
  // A value strictly inside the band is the model declining to call it, and
  // that goes to a person rather than to either code path.
  const unsure = Object.entries(vector)
    .filter(([, value]) => value > noEdge && value < tau)
    .map(([key]) => key);

  if (unsure.length > 0) {
    return {
      decision: DECISIONS.UNCERTAIN,
      reason:
        'the typed layer put a question in the middle of its range, which is no signal rather than a weak yes, so this needs your call',
      layer: 'typed',
      evidence: { ...rules.evidence, ...vector, unsure, unasked },
      tau,
      typed: { ...vector, unsure, unasked },
      modelVersion: typed.modelVersion,
    };
  }

  // Both answers are decisive, so the composition is the conjunction the two
  // questions were chosen to express: the advisory matters only if we use the
  // vulnerable component *and* it is reachable from untrusted input. Either one
  // decisively no means it is not on a path we use.
  const decision = uses >= tau && reach >= tau ? DECISIONS.ACT : DECISIONS.WATCH;
  return {
    decision,
    reason:
      decision === DECISIONS.ACT
        ? 'the typed layer judged this reachable'
        : 'the typed layer judged this not reachable enough to act',
    layer: 'typed',
    evidence: { ...rules.evidence, ...vector, unasked },
    tau,
    // `unsure` is present on every path so the row shape does not change with
    // the outcome: `null` when the call returned nothing usable, the names of
    // the questions the model declined to call, and `[]` when both were
    // decisive. A consumer that has to guess which keys exist is a consumer
    // that will read a missing key as a false one. `unasked` follows the same
    // rule, and is `[]` on every path but the two that escalate for want of a
    // premise — where it is the whole reason.
    typed: { ...vector, unsure: [], unasked },
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
