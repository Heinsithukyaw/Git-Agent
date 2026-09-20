/**
 * Advisory triage.
 *
 * Three properties are load-bearing and all are tested here:
 *
 *   1. **Rules are authoritative.** The typed layer may only move a case the
 *      rules could not decide. It can never overturn a verdict that was reached
 *      deterministically, because a model that can override arithmetic is a
 *      model that can silently clear a real advisory.
 *   2. **Thresholding is code.** The model returns typed values; the comparison
 *      against τ happens here, and is replayable.
 *   3. **The request the code sends is the request the API documents.** Nothing
 *      asserted that, and a request that was rejected on every call shipped
 *      because of it. A stubbed response cannot catch it: the stub is wrong in
 *      the same direction as the code, so it stays green forever.
 *   4. **A question with no premise is not asked.** The band catches a model
 *      that cannot tell; it cannot catch a question about an empty list, whose
 *      confident `no` would silently clear a real advisory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISIONS,
  TAU_DEFAULT,
  DEFAULT_TYPED_MODEL,
  answerableQuestions,
  rulesDecide,
  compose,
  severityScore,
  severityLabel,
  triage,
  typedDecide,
} from '../lib/triage.mjs';

const pkg = (over = {}) => ({
  name: 'lodash',
  ecosystem: 'npm',
  pinned: '4.17.15',
  usage: { imported_symbols: ['merge'], call_sites: ['src/a.ts:1'], runtime: 'node' },
  ...over,
});

const advisory = (over = {}) => ({
  id: 'GHSA-35jh-r3h4-6jhm',
  package: 'lodash',
  ecosystem: 'npm',
  summary: 'prototype pollution in merge',
  details: 'The merge function is vulnerable to prototype pollution.',
  affected: [{ type: 'ECOSYSTEM', introduced: '0', fixed: '4.17.21' }],
  ...over,
});

/* ---------------------------------------------------------------- rules --- */

test('an unknown pinned version is uncertain, never clear', () => {
  const r = rulesDecide(advisory(), pkg({ pinned: null }));
  assert.equal(r.decision, DECISIONS.UNCERTAIN);
  assert.equal(r.reason, 'pinned version unknown');
});

test('a version outside the affected range is clear', () => {
  const r = rulesDecide(advisory(), pkg({ pinned: '4.18.0' }));
  assert.equal(r.decision, DECISIONS.CLEAR);
});

test('affected with no published fix is mitigate, not act', () => {
  const r = rulesDecide(advisory({ affected: [{ type: 'ECOSYSTEM', introduced: '0', fixed: null }] }), pkg());
  assert.equal(r.decision, DECISIONS.MITIGATE);
});

test('affected with unmapped usage is uncertain, because reachability is unknowable', () => {
  const r = rulesDecide(advisory(), pkg({ usage: {} }));
  assert.equal(r.decision, DECISIONS.UNCERTAIN);
  assert.match(r.reason, /usage is unmapped/);
});

test('affected, fixed, and a symbol we import is act', () => {
  const r = rulesDecide(advisory(), pkg());
  assert.equal(r.decision, DECISIONS.ACT);
  assert.match(r.reason, /we import merge/);
  assert.equal(r.evidence.upgrade, '4.17.21');
});

test('affected and fixed, but not on a symbol we import, is watch', () => {
  const r = rulesDecide(advisory({ summary: 'a flaw', details: 'unrelated prose' }), pkg());
  assert.equal(r.decision, DECISIONS.WATCH);
});

test('a range we cannot evaluate is uncertain, never clear', () => {
  const r = rulesDecide(advisory({ affected: [{ type: 'GIT', introduced: '0', fixed: '99.0.0' }] }), pkg());
  assert.equal(
    r.decision,
    DECISIONS.UNCERTAIN,
    'a GIT range names commits, so version arithmetic cannot clear the advisory',
  );
  assert.equal(r.evidence.unevaluable_ranges, 1);
  assert.match(r.reason, /version arithmetic cannot evaluate/);
});

test('an advisory with no ranges at all is treated as not affected', () => {
  const r = rulesDecide(advisory({ affected: [] }), pkg());
  assert.equal(r.decision, DECISIONS.CLEAR);
});

/* ------------------------------------------------------------- severity --- */

test('severity is read from a number, a vector, or a bare score', () => {
  assert.equal(severityScore({ severity: 7.4 }), 7.4);
  assert.equal(severityScore({ severity: [{ score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] }) > 9, true);
  assert.equal(severityScore({ severity: { score: '5.5' } }), 5.5);
});

test('an absent severity is null, not a crash', () => {
  // OSV omits severity on many advisories and lib/sources.mjs normalises that to
  // an explicit null, so this is the common shape rather than the edge case.
  assert.equal(severityScore({ severity: null }), null);
  assert.equal(severityScore({}), null);
  assert.equal(severityScore({ severity: [] }), null);
  assert.equal(severityScore({ severity: Number.NaN }), null);
});

test('a numeric severity string is a score, a word is not', () => {
  assert.equal(severityScore({ severity: '7.4' }), 7.4);
  assert.equal(severityScore({ severity: ' 9.8 ' }), 9.8);
  assert.equal(severityScore({ severity: 'HIGH' }), null, 'a word is never turned into a number');
});

test('a qualitative severity is surfaced as a label, quoted from the source', () => {
  assert.equal(severityLabel({ severity: 'HIGH' }), 'HIGH');
  assert.equal(severityLabel({ severity: 'CRITICAL' }), 'CRITICAL');
  assert.equal(severityLabel({ severity: '7.4' }), null, 'a score is not a label');
  assert.equal(severityLabel({ severity: 7.4 }), null);
  assert.equal(severityLabel({ severity: null }), null);
  assert.equal(severityLabel({}), null);
});

/* -------------------------------------------------------------- compose --- */

test('rules are authoritative when they reached a verdict', () => {
  const rules = rulesDecide(advisory(), pkg());
  const composed = compose({ rules, typed: { answers: { we_use_the_vulnerable_component: { noul: 0 } }, modelVersion: 'x' } });
  assert.equal(composed.decision, DECISIONS.ACT, 'a typed layer must not overturn a rule');
  assert.equal(composed.layer, 'rules');
  assert.equal(composed.typed, null);
});

test('an uncertain case with no typed layer is surfaced, not resolved', () => {
  const composed = compose({ rules: rulesDecide(advisory(), pkg({ usage: {} })), typed: null });
  assert.equal(composed.decision, DECISIONS.UNCERTAIN);
  assert.match(composed.reason, /needs your call/);
});

/* ------------------------------------------------------- the noul band --- */

const uncertainRules = () => rulesDecide(advisory(), pkg({ usage: {} }));

/**
 * A typed-layer result with the only shape the API can actually return.
 *
 * A `noul` answer is `{type, noul}`. The earlier fixtures here added a
 * `confidence` key that `noul` does not have, which is how a test came to assert
 * a shape production could never produce — and to pass while doing it.
 */
const typedWith = (uses, reach) => ({
  answers: {
    we_use_the_vulnerable_component: { type: 'noul', noul: uses },
    reaches_a_trust_boundary: { type: 'noul', noul: reach },
  },
  modelVersion: 'jev-1.13.0',
});

test('a typed answer in the middle of the range escalates instead of deciding', () => {
  // 0.5 is the documented "no signal" value: equal probability for yes and no.
  // The bug this replaces read `confidence` off these answers, fell back to
  // `?? 1`, and so treated "no such field" as maximum certainty.
  const composed = compose({ rules: uncertainRules(), typed: typedWith(0.5, 0.5) });
  assert.equal(composed.decision, DECISIONS.UNCERTAIN);
  assert.match(composed.reason, /no signal/);
  assert.deepEqual(
    composed.typed.unsure.sort(),
    ['reaches_a_trust_boundary', 'we_use_the_vulnerable_component'],
    'both questions are recorded as uncalled, so the escalation is auditable',
  );
  assert.ok(!('confidence' in composed.typed), 'a noul answer has no confidence to record');
});

test('the band is read per answer, so a decisive answer cannot vouch for an unsure one', () => {
  // This is the case an average hides, and it is why the band is not on the
  // mean. 1.0 next to 0.5 averages to 0.75, which looks confident — but the
  // model said "yes and no are equally likely" about whether we even use the
  // vulnerable component. Averaging a probability with its own negation is a
  // third number that neither answer supports.
  for (const [uses, reach] of [[1, 0.5], [0.5, 1], [0.95, 0.45], [0.45, 0.95]]) {
    const composed = compose({ rules: uncertainRules(), typed: typedWith(uses, reach) });
    assert.equal(
      composed.decision,
      DECISIONS.UNCERTAIN,
      `uses=${uses} reach=${reach}: an answer in the middle must escalate even beside a decisive one`,
    );
  }
});

test('two decisive answers are composed as the conjunction the questions express', () => {
  const rules = uncertainRules();
  // We use the vulnerable component, and it is reachable: act.
  assert.equal(compose({ rules, typed: typedWith(1, 1) }).decision, DECISIONS.ACT);
  // We use it, but no call site handles untrusted input: watch. Both answers are
  // decisive, so this is a verdict and not an escalation — the mean used to
  // escalate it by accident, because 0.5 happened to be the midpoint.
  assert.equal(compose({ rules, typed: typedWith(1, 0) }).decision, DECISIONS.WATCH);
  // We do not use it: watch, whatever the second answer says.
  assert.equal(compose({ rules, typed: typedWith(0.1, 0.1) }).decision, DECISIONS.WATCH);
  assert.equal(compose({ rules, typed: typedWith(0.1, 1) }).decision, DECISIONS.WATCH);
});

test('an absent answer escalates — it is never read as a no', () => {
  const rules = uncertainRules();
  const missing = compose({ rules, typed: { answers: { we_use_the_vulnerable_component: { type: 'noul', noul: 0.9 } }, modelVersion: 'm' } });
  assert.equal(missing.decision, DECISIONS.UNCERTAIN, 'a dropped answer must not clear a real advisory');
  assert.equal(missing.typed.unsure, null, 'nothing was called, so nothing is recorded as uncalled');
  assert.deepEqual(missing.typed.unasked, [], 'a hand-built result claims every question was asked');
  assert.match(missing.reason, /nothing usable/);

  const malformed = compose({ rules, typed: { answers: { we_use_the_vulnerable_component: { noul: 0.9 }, reaches_a_trust_boundary: { noul: 'not a number' } }, modelVersion: 'm' } });
  assert.equal(malformed.decision, DECISIONS.UNCERTAIN);
});

test('a decisive pair above tau is act, and the model version is kept', () => {
  const act = compose({ rules: uncertainRules(), typed: typedWith(0.9, 0.9) });
  assert.equal(act.decision, DECISIONS.ACT);
  assert.equal(act.layer, 'typed');
  assert.equal(act.modelVersion, 'jev-1.13.0');
  assert.deepEqual(act.typed.unsure, [], 'nothing was unsure, and that is recorded as an empty list');
  assert.deepEqual(act.typed.unasked, [], 'every question had a premise, and that is recorded too');
  assert.equal(act.typed.we_use_the_vulnerable_component, 0.9, 'the raw answers are kept, not a summary');
});

test('the band moves with tau, so there is still exactly one tunable parameter', () => {
  // At τ 0.9 the band is (0.1, 0.9): almost everything escalates. That is the
  // right posture when acting on a false yes is expensive.
  const narrow = compose({ rules: uncertainRules(), typed: typedWith(0.6, 0.6), tau: 0.9 });
  assert.equal(narrow.decision, DECISIONS.UNCERTAIN);
  // At τ 0.6 the same answer is decisive.
  const wide = compose({ rules: uncertainRules(), typed: typedWith(0.6, 0.6), tau: 0.6 });
  assert.equal(wide.decision, DECISIONS.ACT);
});

test('the band edges are exact, so a noul of exactly 0.2 is a decisive no', () => {
  // `1 - 0.8` is `0.19999999999999996` in binary floating point, so the naive
  // edge puts 0.2 *inside* the band. The vendor's example treats 0.2 as a no,
  // and the boundary of a decision rule should be exact rather than almost.
  const rules = uncertainRules();
  assert.equal(compose({ rules, typed: typedWith(0.2, 0.2) }).decision, DECISIONS.WATCH);
  assert.equal(compose({ rules, typed: typedWith(0.8, 0.8) }).decision, DECISIONS.ACT);
  // And the two edges really are the boundary.
  assert.equal(compose({ rules, typed: typedWith(0.201, 0.201) }).decision, DECISIONS.UNCERTAIN);
  assert.equal(compose({ rules, typed: typedWith(0.799, 0.799) }).decision, DECISIONS.UNCERTAIN);
});

test('a tau below the middle closes the band instead of inverting it', () => {
  // "Act on a coin-flip" is a coherent setting: it leaves no middle to
  // escalate. What it must not do is produce a band with its edges swapped,
  // which would swallow every answer and decide nothing at all.
  const rules = uncertainRules();
  const atMiddle = compose({ rules, typed: typedWith(0.5, 0.5), tau: 0.4 });
  assert.equal(atMiddle.decision, DECISIONS.ACT, 'with no band left, the threshold is the whole rule');
  const below = compose({ rules, typed: typedWith(0.2, 0.2), tau: 0.4 });
  assert.equal(below.decision, DECISIONS.WATCH);
  const high = compose({ rules, typed: typedWith(0.9, 0.9), tau: 0.4 });
  assert.equal(high.decision, DECISIONS.ACT);
});

test('tau is recorded with the decision, because a decision is replayable', () => {
  const composed = compose({ rules: rulesDecide(advisory(), pkg()), typed: null, tau: 0.75 });
  assert.equal(composed.tau, 0.75);
  assert.equal(compose({ rules: rulesDecide(advisory(), pkg()) }).tau, TAU_DEFAULT);
});

/* --------------------------------------------------- typed-layer transport --- */

/** Capture the request the code actually sends, and answer with `respond`. */
async function captureRequest(respond, opts = {}) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return respond(seen.length);
  };
  try {
    const result = await typedDecide(advisory(), pkg(), {
      baseUrl: 'https://typed.invalid/v1',
      apiKey: 'test-key',
      model: opts.model,
      retries: opts.retries ?? 0,
    });
    return { seen, result };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const okResponse = (json) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => json,
});

test('the request body uses `model` as a string, which is what the API documents', async () => {
  // The defect this pins: `selectedModels: model ? [model] : undefined`. Their
  // stale examples show `selectedModels`, the API reference and the SDK do not,
  // and a request carrying it fails validation on every single call.
  const { seen } = await captureRequest(() => okResponse({ answers: {} }), { model: 'jev-1.13.0' });
  const body = seen[0].body;
  assert.equal(body.model, 'jev-1.13.0');
  assert.equal(typeof body.model, 'string', '`model` is a string, not a one-element array');
  assert.ok(!('selectedModels' in body), 'selectedModels is not a field of this API');
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.equal(seen[0].url, 'https://typed.invalid/v1/systemone');
});

test('an unset model still sends a usable string, never undefined', async () => {
  const { seen } = await captureRequest(() => okResponse({ answers: {} }));
  assert.equal(seen[0].body.model, DEFAULT_TYPED_MODEL);
  assert.equal(typeof seen[0].body.model, 'string', 'a dropped field is a rejected request, which is the bug again');
});

test('every question is asked as a noul, and the state carries the advisory', async () => {
  const { seen } = await captureRequest(() => okResponse({ answers: {} }));
  const { questions, state } = seen[0].body;
  assert.deepEqual(Object.keys(questions).sort(), ['reaches_a_trust_boundary', 'we_use_the_vulnerable_component']);
  for (const q of Object.values(questions)) assert.equal(q.type, 'noul');
  assert.equal(state.advisory.id, 'GHSA-35jh-r3h4-6jhm');
  assert.equal(state.ours.package, 'lodash');
});

test('the criteria must not tell the model that unclear means no', async () => {
  // The band depends entirely on the model being able to answer "I can't tell"
  // by landing in the middle. A `false` description that folds "unclear" into
  // "no" removes that, and the escalation path silently stops firing — so this
  // is a correctness property of the criteria, not a wording preference.
  const { seen } = await captureRequest(() => okResponse({ answers: {} }));
  const q = seen[0].body.questions.we_use_the_vulnerable_component;
  assert.ok(q.criteria?.true && q.criteria?.false, 'the subtle boundary is why criteria exist here');
  assert.equal(typeof q.criteria.true.what, 'string');
  assert.equal(typeof q.criteria.false.what, 'string');
  assert.doesNotMatch(
    q.criteria.false.what,
    /unclear/i,
    'the no-side *definition* must not fold "unclear" into "no" — the middle of the range is where that goes',
  );
  assert.match(q.criteria.false.not_for, /unclear/i, 'and it says so explicitly, on the no side');
  assert.ok(Array.isArray(q.criteria.true.examples), 'each side is pinned with an example, as documented');
  assert.ok(Array.isArray(q.criteria.false.examples));
});

test('the versioned model and the token usage are read off the response', async () => {
  const { result } = await captureRequest(() =>
    okResponse({
      answers: { we_use_the_vulnerable_component: { type: 'noul', noul: 0.91 } },
      model: 'jev-1.13.0',
      usage: { input_tokens: 412, output_tokens: 3 },
    }),
  );
  assert.equal(result.modelVersion, 'jev-1.13.0', 'the response field is `model`, not `model_version`');
  assert.equal(result.usage.input_tokens, 412);
  assert.equal(result.answers.we_use_the_vulnerable_component.noul, 0.91);
});

/**
 * A response that fails once, then succeeds.
 *
 * The header lookup is deliberately name-aware. A stub whose `get` returns a
 * fixed string for every name makes the test read a `retry-after-ms` that the
 * server never sent, which is the same class of mistake as a fixture asserting
 * a shape the API cannot produce.
 */
const failsOnce = (status, headers = {}) => (n) =>
  n === 1
    ? {
        ok: false,
        status,
        headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
        text: async () => 'busy',
      }
    : okResponse({ answers: {} });

test('every retryable status is retried, including the 5xx codes a hand-picked list drops', async () => {
  // 501 and 507 are the point: a hand-picked `{500, 502, 503, 504, 529}` retries
  // 503 and 529 but treats these as permanent, while the vendor's SDK retries the
  // whole 500–599 range. `retry-after: 0` keeps the test fast.
  for (const status of [408, 429, 500, 501, 503, 507, 529, 599]) {
    const { seen } = await captureRequest(failsOnce(status, { 'retry-after': '0' }), { retries: 1 });
    assert.equal(seen.length, 2, `HTTP ${status} should have been retried`);
  }
});

test('a 4xx that is not 408 or 429 is permanent, so it is not retried', async () => {
  for (const status of [400, 401, 403, 404]) {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: false, status, headers: { get: () => null }, text: async () => 'nope' };
    };
    try {
      await assert.rejects(
        typedDecide(advisory(), pkg(), { baseUrl: 'https://typed.invalid/v1', apiKey: 'k', retries: 2 }),
        new RegExp(`HTTP ${status}`),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls, 1, `HTTP ${status} is the request being wrong, so retrying cannot help`);
  }
});

test('a rejected request is not retried, and its body is kept as a diagnostic', async () => {
  // Both bodies below are the ones the live service actually returns — measured,
  // not invented. An earlier version of this test stubbed
  // `{"detail":"model: field required"}`, which names the offending field. The
  // real body for a structurally invalid request names nothing. That is the same
  // mistake the header of this file warns about: a fixture asserting a shape
  // production cannot produce, so the test proved the stub rather than the
  // contract.
  //
  // The status is 400, not the 422 the API reference documents. Measured.
  const CASES = [
    {
      why: 'a structurally invalid request names nothing',
      body: '{"detail":{"error_type":"api_usage_error","message":"Invalid request."}}',
      expect: /400.*api_usage_error/,
    },
    {
      why: 'an unknown model value is named exactly, so the body is the whole diagnosis',
      body: '{"detail":{"error_type":"api_usage_error","message":"Unknown model: gpt-4o"}}',
      expect: /400.*Unknown model: gpt-4o/,
    },
  ];

  for (const c of CASES) {
    let calls = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: false, status: 400, headers: { get: () => null }, text: async () => c.body };
    };
    try {
      await assert.rejects(
        typedDecide(advisory(), pkg(), { baseUrl: 'https://typed.invalid/v1', apiKey: 'k', retries: 2 }),
        c.expect,
        c.why,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(calls, 1, 'a rejected request cannot be fixed by retrying it');
  }
});

test('a retry-after header is honoured over the default backoff', async () => {
  const started = Date.now();
  const { seen } = await captureRequest(failsOnce(429, { 'retry-after': '1' }), { retries: 1 });
  assert.equal(seen.length, 2);
  assert.ok(Date.now() - started >= 900, 'a retry-after of 1s must actually be waited out');
});

test('with no retry-after at all, the backoff still waits', async () => {
  // The case the mutation test found uncovered. `Number(null)` is `0`, not
  // `NaN`, so reading an absent header with `Number(...)` yields a zero-second
  // delay — retries fire immediately and the backoff and jitter do nothing.
  // Every other retry test here sends a header, so none of them noticed.
  const started = Date.now();
  const { seen } = await captureRequest(failsOnce(503), { retries: 1 });
  assert.equal(seen.length, 2);
  assert.ok(Date.now() - started >= 250, 'an absent header must not read as a zero-second delay');
});

test('a retry-after beyond the cap falls back to backoff instead of waiting it out', async () => {
  // A server asking for an hour is a server to skip, not to wait on. The vendor's
  // SDK caps this at a minute and backsoffs beyond that.
  const started = Date.now();
  const { seen } = await captureRequest(failsOnce(429, { 'retry-after': '3600' }), { retries: 1 });
  assert.equal(seen.length, 2);
  assert.ok(Date.now() - started < 5_000, 'an hour-long retry-after must not be honoured literally');
});

test('triage records the usage, so what the layer cost is auditable', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => okResponse({ answers: {}, model: 'jev-1.13.0', usage: { input_tokens: 7, output_tokens: 1 } });
  try {
    // Usage is mapped and the pinned version is not, so the case is uncertain
    // *and* the typed layer has something to ask about. The earlier version of
    // this test used `usage: {}`, which no longer reaches the network at all —
    // a question about an empty symbol list is not asked.
    const rows = await triage(
      { observed_at: '2026-01-01T00:00:00.000Z', packages: [pkg({ pinned: null })], advisories: [advisory()] },
      { typed: { enabled: true, baseUrl: 'https://typed.invalid/v1', apiKey: 'k' } },
    );
    assert.equal(rows[0].typed_usage.input_tokens, 7);
    assert.equal(rows[0].model_version, 'jev-1.13.0');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* -------------------------------------------------------- the premise --- */

/**
 * The defect these tests close.
 *
 * Both questions compare the advisory against a list we supply, and either list
 * can be empty. Asked about an empty list, the model answers `no` — decisively,
 * because there is nothing to find. The band cannot catch it: `0.04` is not in
 * the middle, it is a confident answer about zero things.
 *
 * So the rules tier's `uncertain` ("usage is unmapped — reachability unknown")
 * became `watch` ("not on a path we use"), which is a verdict the rules tier had
 * explicitly declined to reach. Measured against the live service, not theorised:
 * that is what it returned.
 */

test('a question with no premise is not answerable, and one with a premise is', () => {
  assert.deepEqual(answerableQuestions(pkg()), {
    we_use_the_vulnerable_component: true,
    reaches_a_trust_boundary: true,
  });
  assert.deepEqual(answerableQuestions(pkg({ usage: {} })), {
    we_use_the_vulnerable_component: false,
    reaches_a_trust_boundary: false,
  });
  // The two lists are independent, so one question can be askable while the
  // other is not.
  assert.deepEqual(answerableQuestions(pkg({ usage: { imported_symbols: ['merge'] } })), {
    we_use_the_vulnerable_component: true,
    reaches_a_trust_boundary: false,
  });
  // An absent package is the same as an empty usage map, not a crash.
  assert.deepEqual(answerableQuestions(null), {
    we_use_the_vulnerable_component: false,
    reaches_a_trust_boundary: false,
  });
});

test('with no premise at all, no request is sent', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return okResponse({ answers: { we_use_the_vulnerable_component: { type: 'noul', noul: 0.02 } } });
  };
  try {
    const rows = await triage(
      { observed_at: '2026-01-01T00:00:00.000Z', packages: [pkg({ usage: {} })], advisories: [advisory()] },
      { typed: { enabled: true, baseUrl: 'https://typed.invalid/v1', apiKey: 'k' } },
    );
    assert.equal(calls, 0, 'a request whose every question is about an empty list can only be answered about nothing');
    assert.equal(rows[0].decision, DECISIONS.UNCERTAIN);
    assert.equal(rows[0].typed_usage, null, 'no call was made, so nothing was charged');
    assert.equal(rows[0].model_version, null, 'and nothing answered, so there is no provenance to claim');
    assert.deepEqual(
      rows[0].typed.unasked.sort(),
      ['reaches_a_trust_boundary', 'we_use_the_vulnerable_component'],
      'the record says why it escalated, so nobody goes looking for a broken endpoint',
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('two decisive answers about an empty list are not a verdict', async () => {
  const realFetch = globalThis.fetch;
  // Exactly what the live service returned when asked about `usage: {}`.
  globalThis.fetch = async () =>
    okResponse({
      answers: {
        we_use_the_vulnerable_component: { type: 'noul', noul: 0.05 },
        reaches_a_trust_boundary: { type: 'noul', noul: 0.04 },
      },
      model: 'stub',
    });
  try {
    const rows = await triage(
      { observed_at: '2026-01-01T00:00:00.000Z', packages: [pkg({ usage: {} })], advisories: [advisory()] },
      { typed: { enabled: true, baseUrl: 'https://typed.invalid/v1', apiKey: 'k' } },
    );
    assert.equal(rows[0].decision, DECISIONS.UNCERTAIN, 'a confident no about nothing is not a confident no');
    assert.match(rows[0].reason, /nothing to compare against/);
    assert.match(rows[0].reason, /usage is unmapped/, 'the rules reason is kept, because it names the real gap');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a half-empty premise asks only the question that has one', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return okResponse({
      answers: { we_use_the_vulnerable_component: { type: 'noul', noul: 0.95 } },
      model: 'stub',
    });
  };
  try {
    // Uncertain because the pinned version is unknown, so the premise gate is
    // the only thing under test here.
    const rows = await triage(
      {
        observed_at: '2026-01-01T00:00:00.000Z',
        packages: [pkg({ pinned: null, usage: { imported_symbols: ['merge'] } })],
        advisories: [advisory()],
      },
      { typed: { enabled: true, baseUrl: 'https://typed.invalid/v1', apiKey: 'k' } },
    );
    assert.deepEqual(
      Object.keys(bodies[0].questions),
      ['we_use_the_vulnerable_component'],
      'the call-site question has no premise, so it is not in the request',
    );
    assert.equal(rows[0].decision, DECISIONS.UNCERTAIN, 'the unasked half still cannot be assumed');
    assert.deepEqual(rows[0].typed.unasked, ['reaches_a_trust_boundary']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* --------------------------------------------------------------- triage --- */

test('triage returns one record per advisory, with the evidence kept', async () => {
  const payload = {
    observed_at: '2026-01-01T00:00:00.000Z',
    packages: [pkg()],
    advisories: [advisory({ severity: 'HIGH' })],
  };
  const rows = await triage(payload, { typed: { enabled: false } });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.observed_at, payload.observed_at);
  assert.equal(row.advisory_id, 'GHSA-35jh-r3h4-6jhm');
  assert.equal(row.package, 'lodash');
  assert.equal(row.pinned, '4.17.15');
  assert.equal(row.upgrade, '4.17.21');
  assert.equal(row.decision, DECISIONS.ACT);
  assert.equal(row.layer, 'rules');
  assert.equal(row.tau, TAU_DEFAULT);
  assert.equal(row.typed, null);
  assert.equal(row.severity, null, 'a word is not a score');
  assert.equal(row.severity_label, 'HIGH', 'but the word is kept, because the source said it');
});

test('triage with no model configured is a complete, correct result', async () => {
  const payload = { observed_at: '2026-01-01T00:00:00.000Z', packages: [pkg({ pinned: '4.18.0' })], advisories: [advisory()] };
  const rows = await triage(payload);
  assert.equal(rows[0].decision, DECISIONS.CLEAR);
});

test('an advisory whose package is not in the payload is uncertain, not dropped', async () => {
  const payload = { observed_at: '2026-01-01T00:00:00.000Z', packages: [], advisories: [advisory()] };
  const rows = await triage(payload);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, DECISIONS.UNCERTAIN);
  assert.equal(rows[0].pinned, null);
});
