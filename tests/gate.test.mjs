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
