/**
 * Advisory triage.
 *
 * Two properties are load-bearing and both are tested here:
 *
 *   1. **Rules are authoritative.** The typed layer may only move a case the
 *      rules could not decide. It can never overturn a verdict that was reached
 *      deterministically, because a model that can override arithmetic is a
 *      model that can silently clear a real advisory.
 *   2. **Thresholding is code.** The model returns typed values and a
 *      confidence; the comparison against τ happens here, and is replayable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECISIONS, TAU_DEFAULT, CONFIDENCE_FLOOR, rulesDecide, compose, severityScore, severityLabel, triage } from '../lib/triage.mjs';

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
  const composed = compose({ rules, typed: { answers: { we_use_the_vulnerable_component: { noul: 0, confidence: 1 } }, modelVersion: 'x' } });
  assert.equal(composed.decision, DECISIONS.ACT, 'a typed layer must not overturn a rule');
  assert.equal(composed.layer, 'rules');
  assert.equal(composed.typed, null);
});

test('an uncertain case with no typed layer is surfaced, not resolved', () => {
  const composed = compose({ rules: rulesDecide(advisory(), pkg({ usage: {} })), typed: null });
  assert.equal(composed.decision, DECISIONS.UNCERTAIN);
  assert.match(composed.reason, /needs your call/);
});

test('a typed answer below the confidence floor does not decide anything', () => {
  const rules = rulesDecide(advisory(), pkg({ usage: {} }));
  const typed = {
    answers: {
      reaches_a_trust_boundary: { noul: 1, confidence: CONFIDENCE_FLOOR - 0.01 },
      we_use_the_vulnerable_component: { noul: 1, confidence: CONFIDENCE_FLOOR - 0.01 },
    },
    modelVersion: 'm1',
  };
  const composed = compose({ rules, typed });
  assert.equal(composed.decision, DECISIONS.UNCERTAIN);
  assert.match(composed.reason, /below the confidence floor/);
});

test('a typed answer at or above tau is act, below is watch', () => {
  const rules = rulesDecide(advisory(), pkg({ usage: {} }));
  const answer = (uses, reach) => ({
    answers: {
      we_use_the_vulnerable_component: { noul: uses, confidence: 0.9 },
      reaches_a_trust_boundary: { noul: reach, confidence: 0.9 },
    },
    modelVersion: 'm1',
  });

  const act = compose({ rules, typed: answer(0.9, 0.9) });
  assert.equal(act.decision, DECISIONS.ACT);
  assert.equal(act.layer, 'typed');
  assert.equal(act.modelVersion, 'm1');

  const watch = compose({ rules, typed: answer(0.4, 0.2) });
  assert.equal(watch.decision, DECISIONS.WATCH);
});

test('tau is recorded with the decision, because a decision is replayable', () => {
  const composed = compose({ rules: rulesDecide(advisory(), pkg()), typed: null, tau: 0.75 });
  assert.equal(composed.tau, 0.75);
  assert.equal(compose({ rules: rulesDecide(advisory(), pkg()) }).tau, TAU_DEFAULT);
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
