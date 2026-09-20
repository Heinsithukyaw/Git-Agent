/**
 * Version arithmetic.
 *
 * The property under test is not "compares versions correctly" in the abstract —
 * it is that **an unknown version never looks safe**. `parse` returns null rather
 * than guessing, and null sorts last everywhere it is used, so an advisory on a
 * version this code cannot read is escalated rather than cleared.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../lib/version.mjs';

test('parses the dialects that actually appear in lockfiles', () => {
  assert.deepEqual(
    { ...v.parse('1.2.3'), raw: undefined },
    { major: 1, minor: 2, patch: 3, pre: null, raw: undefined },
  );
  assert.equal(v.parse('v1.2.3').patch, 3);
  assert.equal(v.parse('1.2').patch, 0, 'a partial version pads rather than fails');
  assert.equal(v.parse('1.2.3-alpha.1').pre, 'alpha.1');
});

test('build metadata is dropped, because SemVer says it does not affect precedence', () => {
  assert.equal(v.parse('1.2.3+build.7').patch, 3);
  assert.equal(v.parse('1.2.3+build.7').pre, null);
  assert.equal(v.parse('v1.9.1+incompatible').patch, 1, 'a Go module version is readable');
  assert.equal(v.compare('1.2.3+a', '1.2.3+b'), 0);
  assert.equal(v.compare('1.2.3-rc.1+build', '1.2.3-rc.1'), 0);
});

test('refuses what it cannot read, instead of guessing', () => {
  for (const bad of ['latest', '1.x', '', '   ', 1.2, null, undefined, '1.2.3.4.5', 'x.y.z']) {
    assert.equal(v.parse(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('orders numerically, not lexically', () => {
  assert.equal(v.compare('1.2.3', '1.2.4'), -1);
  assert.equal(v.compare('1.10.0', '1.9.0'), 1, '10 is not less than 9');
  assert.equal(v.compare('2.0.0', '1.99.99'), 1);
  assert.equal(v.compare('1.2.3', '1.2.3'), 0);
});

test('a pre-release sorts below its release', () => {
  assert.equal(v.compare('1.0.0-alpha', '1.0.0'), -1);
  assert.equal(v.compare('1.0.0', '1.0.0-alpha'), 1);
  assert.equal(v.compare('1.0.0-alpha.1', '1.0.0-alpha.2'), -1);
});

test('an unknown version sorts last, so it never looks safe', () => {
  assert.equal(v.compare('latest', '1.0.0'), 1);
  assert.equal(v.compare('1.0.0', 'latest'), -1);
  assert.equal(v.compare('latest', 'also-not-a-version'), 0);
});

test('inRange treats fixed as exclusive and last_affected as inclusive', () => {
  assert.equal(v.inRange('1.2.3', { introduced: '0', fixed: '1.2.4' }), true);
  assert.equal(v.inRange('1.2.4', { introduced: '0', fixed: '1.2.4' }), false);
  assert.equal(v.inRange('1.2.3', { introduced: '1.0.0', last_affected: '1.2.3' }), true);
  assert.equal(v.inRange('1.0.0', { introduced: '1.2.0', fixed: '1.3.0' }), false);
});

test('inRange returns null for an unparseable version, which is not "safe"', () => {
  assert.equal(v.inRange('nonsense', { introduced: '0', fixed: '9.9.9' }), null);
});

test('inAnyRange is false for an empty range list, and for unknowns', () => {
  assert.equal(v.inAnyRange('1.0.0', []), false);
  assert.equal(v.inAnyRange('nonsense', [{ introduced: '0', fixed: '9.9.9' }]), false);
  assert.equal(v.inAnyRange('1.0.0', [{ introduced: '0', fixed: '0.9.0' }, { introduced: '1.0.0', fixed: '2.0.0' }]), true);
});

test('smallestUpgrade picks the lowest fix that is actually an upgrade', () => {
  assert.equal(v.smallestUpgrade('1.2.0', [{ fixed: '1.3.0' }, { fixed: '1.2.5' }]), '1.2.5');
  assert.equal(v.smallestUpgrade('1.2.0', [{ fixed: '1.2.0' }]), null, 'the pinned version is not an upgrade');
  assert.equal(v.smallestUpgrade('1.2.0', [{ fixed: null }]), null);
  assert.equal(v.smallestUpgrade('1.2.0', []), null);
});

test('distance classifies the gap, for sorting the digest by urgency', () => {
  assert.equal(v.distance('1.0.0', '2.0.0'), 'major');
  assert.equal(v.distance('1.0.0', '1.1.0'), 'minor');
  assert.equal(v.distance('1.0.0', '1.0.1'), 'patch');
  assert.equal(v.distance('1.0.0', '1.0.0'), 'none');
  assert.equal(v.distance('nonsense', '1.0.0'), null);
});
