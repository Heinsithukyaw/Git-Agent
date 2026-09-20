/**
 * The containment gate.
 *
 * This is the file that matters most, because the gate is the only thing
 * standing between a model's output and a commit. Two failure modes have to be
 * held apart, and the tests are grouped by which one they defend:
 *
 *   - a **false negative** — an invented entity reaches the digest. Silent,
 *     and the reason the gate exists.
 *   - a **false positive** — correct prose is rejected. Loud, but fatal in a
 *     different way: the run fails, narration never commits, and the gate gets
 *     switched off "temporarily".
 *
 * The second mode is not hypothetical. An earlier version of the extractor read
 * `4.17.15` and the tail of `GHSA-35jh-r3h4-6jhm` as package names, and treated
 * every lowercase word on a package-ish line as one too. Every grounded sentence
 * failed. Those exact cases are pinned below.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, extract, indexPayload, assertGrounded } from '../lib/gate.mjs';
import { triage } from '../lib/triage.mjs';
import { buildFacts } from '../lib/render.mjs';

const PAYLOAD = {
  observed_at: '2026-01-01T00:00:00.000Z',
  packages: [
    {
      name: 'lodash',
      ecosystem: 'npm',
      pinned: '4.17.15',
      usage: { imported_symbols: ['merge', 'get'], call_sites: ['src/a.ts:1'], runtime: 'node' },
    },
  ],
  advisories: [
    {
      id: 'GHSA-35jh-r3h4-6jhm',
      package: 'lodash',
      summary: 'prototype pollution',
      severity: '7.4',
      affected: [{ type: 'ECOSYSTEM', introduced: '0', fixed: '4.17.21' }],
    },
  ],
  releases: [{ slug: 'nodejs/node', tag: 'v22.0.0', published_at: '2026-01-01T00:00:00.000Z' }],
  feeds: [],
  errors: [],
};

/* ------------------------------------------------- false positives (loud) --- */

test('grounded prose passes', () => {
  const cases = [
    'GHSA-35jh-r3h4-6jhm affects lodash pinned at 4.17.15; fixed in 4.17.21.',
    'One advisory is reachable from code you import.',
    'The package lodash is pinned and needs a bump.',
    'We import merge from lodash, so the affected range applies.',
    'Nothing needs a decision today.',
    'nodejs/node released v22.0.0.',
    'lodash is pinned at 4.17.15, and merge is imported at src/a.ts:1.',
  ];
  for (const prose of cases) {
    const result = check(prose, PAYLOAD);
    assert.equal(
      result.ok,
      true,
      `expected PASS, got violations: ${JSON.stringify(result.violations)} — "${prose}"`,
    );
  }
});

test('an advisory id and a version literal are not also package names', () => {
  const found = extract('GHSA-35jh-r3h4-6jhm affects lodash pinned at 4.17.15; fixed in 4.17.21.');
  assert.equal(found.packages.has('35jh-r3h4-6jhm'), false);
  assert.equal(found.packages.has('4.17.15'), false);
  assert.equal(found.packages.has('4.17.21.'), false);
});

test('a package name at the end of a sentence does not swallow the full stop', () => {
  const payload = { packages: [{ name: '@babel/core', ecosystem: 'npm' }] };
  const result = check('The package @babel/core is in the payload.', payload);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('a symbol named in the payload is not treated as an invention', () => {
  const result = check('We import merge from lodash.', PAYLOAD);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('derived scalars are allowed when they are passed explicitly', () => {
  const payload = { packages: [{ name: 'lodash' }], advisories: [{ id: 'GHSA-aaaa-bbbb-cccc' }] };
  const without = check('2 advisories are open.', payload);
  assert.equal(without.ok, false, 'a derived count must not be assumed');
  const withDerived = check('2 advisories are open.', payload, { derived: [2] });
  assert.equal(withDerived.ok, true, JSON.stringify(withDerived.violations));
});

/* ------------------------------------------------- false negatives (quiet) --- */

test('an invented advisory id is caught', () => {
  const result = check('GHSA-9999-aaaa-bbbb affects lodash.', PAYLOAD);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].kind, 'advisory');
  assert.equal(result.violations[0].token, 'GHSA-9999-AAAA-BBBB');
});

test('an invented version is caught', () => {
  const result = check('Bump lodash to 4.99.0.', PAYLOAD);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].kind, 'version');
  assert.equal(result.violations[0].token, '4.99.0');
});

test('an invented bare package name is caught', () => {
  const result = check('The package leftpad is also affected.', PAYLOAD);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].kind, 'package');
  assert.equal(result.violations[0].token, 'leftpad');
});

test('an invented scoped package is caught', () => {
  const result = check('lodash is affected, and so is @evil/pkg.', PAYLOAD);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.token === '@evil/pkg'));
});

test('an invented count is caught', () => {
  const result = check('5 advisories are open.', PAYLOAD);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.kind === 'number' && v.token === '5'));
});

test('assertGrounded throws with the offending entity in the message', () => {
  assert.throws(
    () => assertGrounded('GHSA-9999-aaaa-bbbb affects lodash.', PAYLOAD),
    /containment gate FAILED[\s\S]*GHSA-9999-AAAA-BBBB/,
  );
});

test('assertGrounded returns the result when the prose is grounded', () => {
  const result = assertGrounded('lodash is pinned at 4.17.15.', PAYLOAD);
  assert.equal(result.ok, true);
});

/* ------------------------------------------------------------- edge cases --- */

test('a non-string input fails closed rather than throwing', () => {
  const result = check(null, PAYLOAD);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].kind, 'input');
});

test('an empty payload rejects everything it did not contain', () => {
  const result = check('lodash is pinned at 4.17.15.', {});
  assert.equal(result.ok, false);
});

test('indexPayload accepts a watch list as a permitted source of names', () => {
  const indexed = indexPayload({ watch: { packages: ['left-pad'] } });
  assert.equal(indexed.packages.has('left-pad'), true);
});

test('the checked counts are reported, so a silent empty extract is visible', () => {
  const result = check('GHSA-35jh-r3h4-6jhm affects lodash pinned at 4.17.15.', PAYLOAD);
  assert.equal(result.checked.advisories, 1);
  assert.ok(result.checked.packages >= 1);
  assert.equal(result.checked.versions, 1);
});

/* ------------------------------------------ the narrator's input contract --- */

/**
 * Everything `buildFacts()` hands the narrator must be passable by the gate.
 *
 * The narrator is asked to write prose *from these strings*, and its output is
 * then checked against the payload. So a fact containing a number the payload
 * does not is a trap with only two exits: the narrator omits it and loses
 * information, or it repeats it and the whole narration is rejected. The fact
 * list is the gate's input contract, and it is worth asserting directly.
 *
 * This is the class-level version of a bug that was live. The typed layer wrote
 * `scored 0.72 ≥ τ 0.6` into its reason, `buildFacts` passed that reason
 * through verbatim, and the gate then rejected any sentence repeating the score
 * — correctly, because a threshold crossing is arithmetic over model output, not
 * a fact about the world. The layer ships off by default, so nothing had caught
 * it.
 */

const UNCERTAIN_PAYLOAD = {
  observed_at: '2026-01-01T00:00:00.000Z',
  packages: [
    // No imported symbols, so the rules cannot judge reachability and the case
    // reaches the typed layer — which is the only path that matters here.
    { name: 'lodash', ecosystem: 'npm', pinned: '4.17.15', usage: {} },
  ],
  advisories: [
    {
      id: 'GHSA-35jh-r3h4-6jhm',
      package: 'lodash',
      ecosystem: 'npm',
      summary: 'prototype pollution',
      details: 'The merge helper does not guard against prototype pollution.',
      severity: '7.4',
      affected: [{ type: 'ECOSYSTEM', introduced: '0', fixed: '4.17.21' }],
    },
  ],
  releases: [],
  feeds: [],
  errors: [],
};

/** Run triage with `fetch` stubbed to a canned typed-layer response. */
async function triageWithTyped(answers) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    // `model`, not `model_version`: the latter is not a field of this API, and
    // a stub that invents it hides the fact that the code reads it.
    json: async () => ({ answers, model: 'stub-2026-01-01' }),
  });
  try {
    return await triage(UNCERTAIN_PAYLOAD, {
      typed: { enabled: true, baseUrl: 'https://endpoint.invalid/v1', apiKey: 'k', model: 'stub' },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** The same `derived` list commit-step.mjs passes, so this mirrors production. */
function derivedFor(payload, decisions) {
  return [
    decisions.length,
    decisions.filter((d) => d.decision === 'act').length,
    decisions.filter((d) => d.decision === 'uncertain').length,
    (payload.packages ?? []).length,
    (payload.advisories ?? []).length,
    (payload.releases ?? []).length,
    (payload.errors ?? []).length,
  ];
}

function assertEveryFactIsGroundable(payload, decisions, label) {
  const facts = buildFacts(payload, decisions);
  assert.ok(facts.length > 0, `${label}: no facts were produced, so this proves nothing`);
  const derived = derivedFor(payload, decisions);
  for (const fact of facts) {
    try {
      assertGrounded(fact, payload, { derived });
    } catch (err) {
      assert.fail(`${label}: the narrator was handed an ungroundable fact\n  ${fact}\n  ${err.message}`);
    }
  }
  return facts;
}

test('every fact the narrator receives is one the gate can accept — rules path', async () => {
  const decisions = await triage(UNCERTAIN_PAYLOAD, { typed: { enabled: false } });
  assertEveryFactIsGroundable(UNCERTAIN_PAYLOAD, decisions, 'rules only');
});

test('every fact the narrator receives is one the gate can accept — typed layer decided', async () => {
  const decisions = await triageWithTyped({
    we_use_the_vulnerable_component: { type: 'noul', noul: 0.95 },
    reaches_a_trust_boundary: { type: 'noul', noul: 0.9 },
  });
  assert.equal(decisions[0].layer, 'typed', 'the stub should have moved an uncertain case');
  assert.equal(decisions[0].decision, 'act');
  const facts = assertEveryFactIsGroundable(UNCERTAIN_PAYLOAD, decisions, 'typed layer, above tau');
  assert.match(facts.join('\n'), /judged this reachable/);
});

test('every fact the narrator receives is one the gate can accept — typed layer in the band', async () => {
  const decisions = await triageWithTyped({
    we_use_the_vulnerable_component: { type: 'noul', noul: 0.5 },
    reaches_a_trust_boundary: { type: 'noul', noul: 0.5 },
  });
  assert.equal(decisions[0].decision, 'uncertain', 'in the band, nothing is decided');
  const facts = assertEveryFactIsGroundable(UNCERTAIN_PAYLOAD, decisions, 'typed layer, in the band');
  assert.match(facts.join('\n'), /no signal/);
});

test('the typed layer records its numbers structurally, not in the prose', async () => {
  const decisions = await triageWithTyped({
    we_use_the_vulnerable_component: { type: 'noul', noul: 0.95 },
    reaches_a_trust_boundary: { type: 'noul', noul: 0.9 },
  });
  const row = decisions[0];
  assert.equal(typeof row.typed.score, 'number', 'the score must be recorded, not discarded');
  assert.equal(row.tau, 0.6, 'tau is recorded on the row');
  assert.equal(row.typed.score, 0.925, 'the score is the mean of the two answers, rounded');
  assert.equal(row.model_version, 'stub-2026-01-01', 'the resolved model is read from `model`');
  assert.ok(!('confidence' in row.typed), 'a noul answer carries no confidence to record');
  assert.doesNotMatch(row.reason, /\d/, 'a number in the reason is a sentence the gate must reject');
});

test('the wording this replaced is still rejected, so the fix is not cosmetic', () => {
  const old = 'GHSA-35jh-r3h4-6jhm affects lodash pinned at 4.17.15; decision act because typed layer scored 0.72 ≥ τ 0.6 — treat as reachable';
  const result = check(old, UNCERTAIN_PAYLOAD, { derived: [1, 1, 0, 1, 1, 0, 0] });
  assert.equal(result.ok, false, 'the pre-fix reason must still fail the gate — that is why it changed');
  assert.ok(
    result.violations.some((v) => v.token === '0.72' || v.token === '0.6'),
    `expected the score or tau to be the offending entity, saw ${JSON.stringify(result.violations.map((v) => v.token))}`,
  );
});
