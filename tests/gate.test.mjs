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
import { buildFacts, attachDecisions, explainFacts } from '../lib/render.mjs';

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
      // OSV's real shape. A scalar `severity: '7.4'` is not a shape the API
      // returns, and writing it here is what let a fatal defect pass review: the
      // fixture supplied a number the live payload does not, so the
      // fact-grounding test below asserted a property that only held for the
      // fixture. The numeric score is arithmetic over this vector, and it lives
      // on the decision row, not in the payload.
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      // npm publishes SEMVER ranges; PyPI publishes ECOSYSTEM ones. A fixture
      // that gives an npm package an ECOSYSTEM range is testing a shape that
      // cannot arrive.
      affected: [{ type: 'SEMVER', introduced: '0', fixed: '4.17.21' }],
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

test('a bare name at the end of a sentence does not swallow the full stop either', () => {
  // The scoped form was already covered. The keyword and state forms were not,
  // and a live run produced `express.`, `merge.` and `Session.` as entities —
  // names no payload can contain. Found by running it, not by reading it.
  const payload = { packages: [{ name: 'express', ecosystem: 'npm' }], advisories: [] };
  for (const prose of [
    'This is reachable, and we import express.',
    'The package express is pinned.',
    'Bump express.',
    'The dependency express is affected.',
  ]) {
    for (const p of extract(prose).packages) {
      assert.doesNotMatch(p, /[._-]$/, `"${prose}" produced the entity ${JSON.stringify(p)}`);
    }
    const result = check(prose, payload);
    assert.equal(result.ok, true, `"${prose}" -> ${JSON.stringify(result.violations)}`);
  }
});

test('a copula is not a state verb, so an ordinary noun before "is" is not a package', () => {
  // `PACKAGE_STATE_RE` accepted `is|are|was|…` as the predicate, so any noun
  // followed by a copula became a package name. A live run produced `issues`
  // from "the same underlying issues is not stated" and `upgrade` from "the
  // upgrade is available".
  for (const prose of [
    'Whether the entries describe the same underlying issues is not stated.',
    'The upgrade is available.',
    'The reason is unclear.',
  ]) {
    assert.deepEqual([...extract(prose).packages], [], `"${prose}" invented a package`);
  }
  // ...and the form the rule exists for still matches, copula or not.
  for (const prose of ['lodash is pinned.', 'lodash is affected.', 'lodash affected.', 'lodash is vulnerable.']) {
    assert.ok(extract(prose).packages.has('lodash'), `"${prose}" lost the package`);
  }
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
    // Usage is mapped, because the typed layer needs a premise to be asked
    // anything at all: a question about an empty symbol list is a question about
    // nothing, and `answerableQuestions()` declines it. So the uncertainty here
    // comes from the advisory instead — a range published only as commits, which
    // version arithmetic cannot evaluate. That is a real shape, and it leaves the
    // typed layer the only path that can move the case.
    {
      name: 'lodash',
      ecosystem: 'npm',
      pinned: '4.17.15',
      usage: { imported_symbols: ['merge'], call_sites: ['src/a.ts:1'], runtime: 'node' },
    },
  ],
  advisories: [
    {
      id: 'GHSA-35jh-r3h4-6jhm',
      package: 'lodash',
      ecosystem: 'npm',
      summary: 'prototype pollution',
      details: 'The merge helper does not guard against prototype pollution.',
      // OSV's real shape, not a convenient scalar. See PAYLOAD above.
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      affected: [{ type: 'GIT', introduced: '0', fixed: '9f2c1a4' }],
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
function derivedFor(decisions) {
  return [
    decisions.length,
    decisions.filter((d) => d.decision === 'act').length,
    decisions.filter((d) => d.decision === 'uncertain').length,
  ];
}

/**
 * The contract, asserted directly: the narrator and the gate read one document.
 *
 * This is the test that would have caught the defect that made narration
 * impossible. It must build the document the way production does —
 * `attachDecisions(payload, decisions)` — and gate against *that*, because the
 * whole failure was that the gate was handed a different document than the
 * narrator was. Gating the facts against the bare payload, as this used to,
 * re-creates the bug inside the test that exists to catch it.
 */
function assertEveryFactIsGroundable(payload, decisions, label) {
  const doc = attachDecisions(payload, decisions);
  const facts = buildFacts(doc);
  assert.ok(facts.length > 0, `${label}: no facts were produced, so this proves nothing`);
  const derived = derivedFor(decisions);
  for (const fact of facts) {
    try {
      assertGrounded(fact, doc, { derived });
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
  assert.equal(row.typed.we_use_the_vulnerable_component, 0.95, 'the raw answer is kept, not a summary of it');
  assert.equal(row.typed.reaches_a_trust_boundary, 0.9);
  assert.deepEqual(row.typed.unsure, [], 'both answers were decisive, and that is recorded');
  assert.equal(row.tau, 0.8, 'tau is recorded on the row');
  assert.equal(row.model_version, 'stub-2026-01-01', 'the resolved model is read from `model`');
  assert.ok(!('confidence' in row.typed), 'a noul answer carries no confidence to record');
  assert.doesNotMatch(row.reason, /\d/, 'a number in the reason is a sentence the gate must reject');
});

test('the wording this replaced is still rejected, even against the projected document', async () => {
  // The projection folds decision rows into the payload, so anything written
  // into a `reason` becomes groundable. This is the test that folding did not
  // launder the one number the design deliberately keeps out of the narrator's
  // reach. It holds for two reasons, both asserted here: reasons are digit-free
  // (above), and `typed.*` and `tau` are not in the projection (below).
  const decisions = await triageWithTyped({
    we_use_the_vulnerable_component: { type: 'noul', noul: 0.95 },
    reaches_a_trust_boundary: { type: 'noul', noul: 0.9 },
  });
  const doc = attachDecisions(UNCERTAIN_PAYLOAD, decisions);

  const old =
    'GHSA-35jh-r3h4-6jhm affects lodash pinned at 4.17.15; decision act because typed layer scored 0.72 ≥ τ 0.6 — treat as reachable';
  const result = check(old, doc, { derived: derivedFor(decisions) });
  assert.equal(result.ok, false, 'the pre-fix reason must still fail the gate — that is why it changed');
  assert.ok(
    result.violations.some((v) => v.token === '0.72' || v.token === '0.6'),
    `expected the score or tau to be the offending entity, saw ${JSON.stringify(result.violations.map((v) => v.token))}`,
  );
});

/* --------------------------------------- the document is the permission list --- */

test('the projection is the permission list, and the typed layer is outside it', async () => {
  const decisions = await triageWithTyped({
    we_use_the_vulnerable_component: { type: 'noul', noul: 0.95 },
    reaches_a_trust_boundary: { type: 'noul', noul: 0.9 },
  });
  const row = decisions[0];
  const doc = attachDecisions(UNCERTAIN_PAYLOAD, decisions);

  assert.equal(row.typed.we_use_the_vulnerable_component, 0.95, 'the score is on the decision row');
  assert.equal(row.tau, 0.8, 'and so is tau');
  assert.equal('typed' in doc.decisions[0], false, 'neither is in the document the narrator reads');
  assert.equal('tau' in doc.decisions[0], false);

  // So a number from the typed layer stays an entity the gate rejects. This is
  // the tripwire the number-free-reasons rule used to provide at runtime, now
  // asserted directly rather than inferred from a production failure.
  for (const text of ['the reach score was 0.95', 'the threshold tau was 0.8']) {
    const r = check(text, doc, { derived: derivedFor(decisions) });
    assert.equal(r.ok, false, `expected the gate to reject "${text}"`);
  }
});

test('a numeric severity is groundable because the decision row is in the document', async () => {
  // The exact defect, pinned. `triage` computes a numeric severity from OSV's
  // CVSS vector; the payload holds only the vector string. While the gate read
  // the bare payload and the narrator read `(payload, decisions)`, every fact
  // carrying a severity was ungroundable — 10 of 16 in a live run — so narration
  // could never commit, and 207 green tests did not notice.
  const decisions = await triage(UNCERTAIN_PAYLOAD, { typed: { enabled: false } });
  const row = decisions[0];
  assert.equal(typeof row.severity, 'number', 'the score is arithmetic over the vector, so it is a number');

  const facts = buildFacts(attachDecisions(UNCERTAIN_PAYLOAD, decisions));
  const withSeverity = facts.filter((f) => f.includes('severity'));
  assert.ok(
    withSeverity.length > 0,
    'the fixture must actually produce a severity fact, or this test proves nothing',
  );

  const doc = attachDecisions(UNCERTAIN_PAYLOAD, decisions);
  for (const fact of withSeverity) {
    const r = check(fact, doc, { derived: derivedFor(decisions) });
    assert.equal(r.ok, true, `ungroundable: ${fact}\n${JSON.stringify(r.violations)}`);
  }

  // Against the bare payload it still fails. If this ever passes, the projection
  // is doing nothing and the test above is vacuous.
  const againstBarePayload = check(withSeverity[0], UNCERTAIN_PAYLOAD, { derived: derivedFor(decisions) });
  assert.equal(againstBarePayload.ok, false, 'the payload alone must not ground the severity');
});

test('every fact the explain narrator is given is in the record it is gated against', () => {
  // The `ask` path has no payload. `reply-step.mjs` grounds the answer against
  // `{ record, stack }` — the stored decision row plus the watch list — and the
  // fact list is a projection of that record. Same rule, different document:
  // nothing the narrator is told may be missing from the ground. Asserted field
  // by field, so a fact added that is not a record field fails a test rather
  // than a live reply.
  //
  // The symbol is the interesting case: `reason` names `merge`, which is only
  // groundable because `stack` carries `usage.imported_symbols`. That is the
  // mechanism, and this is the assertion that it is load-bearing.
  const record = {
    advisory_id: 'GHSA-35jh-r3h4-6jhm',
    package: 'lodash',
    ecosystem: 'npm',
    pinned: '4.17.15',
    upgrade: '4.17.21',
    decision: 'act',
    reason: 'affected, and we import merge',
    layer: 'rules',
    tau: 0.8,
    model_version: null,
    severity: 7.4,
    typed: null,
  };
  const ground = {
    record,
    stack: {
      packages: [
        {
          name: 'lodash',
          ecosystem: 'npm',
          pinned: '4.17.15',
          usage: { imported_symbols: ['merge', 'get'], call_sites: [], runtime: 'node' },
        },
      ],
    },
  };

  const facts = explainFacts(record);
  assert.ok(facts.length > 0, 'no facts were produced, so this proves nothing');
  for (const fact of facts) {
    const r = check(fact, ground, { derived: [] });
    assert.equal(r.ok, true, `ungroundable fact for the explain path: ${fact}\n${JSON.stringify(r.violations)}`);
  }

  // The one thing the narrator is not told is `typed`, so it is never in the
  // fact list — and a reply cannot state it.
  assert.doesNotMatch(facts.join('\n'), /typed/);

  // And the symbol really is doing the work: drop it from the stack and the
  // reason stops being groundable, which is what makes the assertion above
  // meaningful rather than incidental.
  const withoutSymbols = { record, stack: { packages: [{ name: 'lodash', ecosystem: 'npm' }] } };
  const reasonFact = facts.find((f) => f.includes('import merge'));
  assert.ok(reasonFact, 'the fixture must produce a symbol-bearing fact');
  assert.equal(check(reasonFact, withoutSymbols, { derived: [] }).ok, false);
});
