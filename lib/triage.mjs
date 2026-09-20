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
 * values and calibrated probabilities; the threshold that turns a probability
 * into a decision is code, and it lives here.
 *
 * What is recorded is what makes this auditable: the probability vector, the
 * confidence, the threshold τ, and the resolved model version. You cannot
 * replay a model call. You can replay a decision.
 */

import * as v from './version.mjs';

export const TAU_DEFAULT = 0.6;
export const CONFIDENCE_FLOOR = 0.35;

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
 * Returns typed answers plus the resolved model version. Never prose.
 */
export async function typedDecide(advisory, pkg, { baseUrl, apiKey, model, timeoutMs = 15_000 }) {
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
    selectedModels: model ? [model] : undefined,
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

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/systemone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`typed layer HTTP ${res.status}`);
  const json = await res.json();

  return {
    answers: json.answers ?? json.results ?? {},
    modelVersion: json.model_version ?? json.modelVersion ?? json.model ?? null,
    raw: json,
  };
}

/* ------------------------------------------------------------ compose ---- */

/**
 * Compose layers into one decision.
 *
 * Rules are authoritative when they are confident. The typed layer is consulted
 * only on `uncertain`, and it may only move an uncertain case — it can never
 * overturn a rule that already reached a verdict. Thresholding is code.
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

  const reach = typed.answers?.reaches_a_trust_boundary?.noul ?? null;
  const uses = typed.answers?.we_use_the_vulnerable_component?.noul ?? null;
  const confidence = Math.min(
    typed.answers?.reaches_a_trust_boundary?.confidence ?? 1,
    typed.answers?.we_use_the_vulnerable_component?.confidence ?? 1,
  );

  const vector = { reaches_a_trust_boundary: reach, we_use_the_vulnerable_component: uses, confidence };

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
  if (confidence < CONFIDENCE_FLOOR) {
    return {
      decision: DECISIONS.UNCERTAIN,
      reason: 'the typed layer answered below the confidence floor, so this still needs your call',
      layer: 'typed',
      evidence: { ...rules.evidence, ...vector, score: null },
      tau,
      typed: { ...vector, score: null },
      modelVersion: typed.modelVersion,
    };
  }

  const score = Math.max(uses ?? 0, (uses ?? 0) * 0.5 + (reach ?? 0) * 0.5);
  const decision = score >= tau ? DECISIONS.ACT : DECISIONS.WATCH;
  const scored = { ...vector, score: Math.round(score * 1000) / 1000 };
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
      model_version: final.modelVersion,
      severity: final.evidence?.severity ?? null,
      severity_label: severityLabel(advisory),
      typed_error: typedError,
    });
  }

  return out;
}
