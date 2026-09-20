/**
 * The pre-publication audit, as tests.
 *
 * Same two directions as `tests/invariants.test.mjs`: against the **real
 * repository**, so a rule that matters fails a test rather than only a tool
 * somebody remembers to run; and against **synthetic trees**, so each check is
 * proven to fire. The seed rule in particular has to be shown to catch a single
 * added package, because that is the exact edit that turns a harmless demo into a
 * disclosure — and it is one line in one JSON file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SEED,
  CREDENTIAL_RE,
  checkSeedStack,
  checkNoEndpointDisclosure,
  checkNoRunDirTracked,
  scanForCredentials,
  scanHistory,
  audit,
} from '../lib/pubsafe.mjs';

const ROOT = process.cwd();

function syntheticRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-pub-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2), 'utf8');
  }
  return dir;
}

/** The seed stack, so a synthetic tree starts from a publishable baseline. */
function seedStack() {
  return {
    packages: SEED.packages.map((name) => ({ name, ecosystem: 'npm', pinned: '1.0.0' })),
    watch: { upstreams: [...SEED.upstreams], feeds: [...SEED.feeds] },
  };
}

/* ------------------------------------------------------------ seed stack --- */

test('the seed stack as shipped passes', () => {
  const root = syntheticRoot({ 'data/stack.json': seedStack() });
  const result = checkSeedStack(root);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.watched, SEED.packages.length);
});

test('one added package is a finding, and it is named', () => {
  // The whole rule in a single edit: this is what a maintainer does by accident
  // when they point the demo at their own work.
  const stack = seedStack();
  stack.packages.push({ name: 'internal/payments-service', ecosystem: 'Go', pinned: 'v0.4.1' });
  const root = syntheticRoot({ 'data/stack.json': stack });
  const result = checkSeedStack(root);
  assert.equal(result.ok, false, 'a package that is specific to one organisation must not be published');
  assert.equal(result.violations[0].kind, 'packages');
  assert.deepEqual(result.violations[0].added, ['internal/payments-service']);
  assert.match(result.violations[0].rule, /seed list only/);
});

test('a private upstream is a finding even when the packages are untouched', () => {
  const stack = seedStack();
  stack.watch.upstreams.push('acme-corp/platform');
  const result = checkSeedStack(syntheticRoot({ 'data/stack.json': stack }));
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].kind, 'upstreams');
  assert.deepEqual(result.violations[0].added, ['acme-corp/platform']);
});

test('reordering is not a violation — only a substitution is', () => {
  const stack = seedStack();
  stack.packages.reverse();
  stack.watch.feeds.reverse();
  assert.equal(checkSeedStack(syntheticRoot({ 'data/stack.json': stack })).ok, true);
});

test('a removed package is a finding too, so the demo cannot quietly shrink', () => {
  const stack = seedStack();
  stack.packages = stack.packages.slice(0, -1);
  const result = checkSeedStack(syntheticRoot({ 'data/stack.json': stack }));
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].removed.length, 1);
});

test('a missing or unparseable stack fails rather than passing vacuously', () => {
  assert.equal(checkSeedStack(syntheticRoot({})).ok, false);
  const broken = syntheticRoot({ 'data/stack.json': '{ not json' });
  const result = checkSeedStack(broken);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].error, /unparseable/);
});

/* --------------------------------------------------- endpoint disclosure --- */

test('an absent endpoint record is fine', () => {
  const result = checkNoEndpointDisclosure(syntheticRoot({}));
  assert.equal(result.ok, true);
  assert.equal(result.absent, true);
});

test('a committed host is a finding — the endpoint is the user\u2019s business', () => {
  const root = syntheticRoot({
    'data/endpoint.json': { host: 'gateway.internal.example', model: 'a-model', probed_at: '2026-01-01T00:00:00Z' },
  });
  const result = checkNoEndpointDisclosure(root);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.violations.map((v) => v.field).sort(),
    ['host', 'model'],
  );
});

/* ------------------------------------------------------------ scratch dir --- */

test('a tracked .run/ path is a finding', () => {
  const result = checkNoRunDirTracked(['README.md', '.run/decisions.json', '.run']);
  assert.equal(result.ok, false);
  assert.equal(result.violations.length, 2);
  assert.match(result.violations[0].rule, /runtime scratch/);
});

test('a path that merely starts with the letters .run is not', () => {
  assert.equal(checkNoRunDirTracked(['runtime/notes.md', '.runbook.md']).ok, true);
});

/* --------------------------------------------------------- credential scan --- */

test('a credential-shaped string is caught and never echoed back in full', () => {
  const key = `sk-${'a'.repeat(32)}`;
  const result = scanForCredentials(`token = '${key}'`, 'tree');
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].line, 1);
  assert.ok(result.violations[0].token.length < key.length, 'a finding must not become a second copy');
  assert.ok(!result.violations[0].token.includes('a'.repeat(10)));
});

test('the repository\u2019s own pattern literal does not match itself', () => {
  // If it did, `ci.yml` would fail its own no-secrets-in-tree job and this tool
  // would report a credential in every checkout.
  assert.doesNotMatch(CREDENTIAL_RE.source, CREDENTIAL_RE);
  const asWritten = "if git grep -nIE '(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,})' -- . ; then";
  assert.equal(scanForCredentials(asWritten, 'ci.yml').ok, true);
});

test('the test fixture is not a credential', () => {
  assert.equal(scanForCredentials("LLM_API_KEY: 'sk-test-not-a-real-key',", 'tests').ok, true);
});

test('a github token and an AWS key id are caught too', () => {
  assert.equal(scanForCredentials(`ghp_${'b'.repeat(36)}`, 'x').ok, false);
  assert.equal(scanForCredentials(`AKIA${'C'.repeat(16)}`, 'x').ok, false);
});

/* ------------------------------------------------------ credential history --- */

test('a history finding names the commit, so it can be rewritten', () => {
  const sha = 'a'.repeat(40);
  const key = `sk-${'b'.repeat(32)}`;
  // Exactly what `git grep -n <pattern> <rev>…` emits.
  const result = scanHistory(`${sha}:src/config.ts:42:const k = '${key}';`);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].commit, sha.slice(0, 12));
  assert.equal(result.violations[0].file, 'src/config.ts');
  assert.equal(result.violations[0].line, 42);
  assert.ok(result.violations[0].token.length < key.length, 'a finding must not become a second copy');
});

test('a history line without a credential is not a finding', () => {
  assert.equal(scanHistory(`${'a'.repeat(40)}:README.md:1:# Git-Agent`).ok, true);
  assert.equal(scanHistory('').ok, true);
});

test('a CRLF history line is still scanned', () => {
  // `git grep` prints the file's own line ending. `.` never matches `\r` and `$`
  // is not multiline, so without stripping it every match in a CRLF file is
  // dropped — the check failing open on Windows line endings.
  const sha = 'e'.repeat(40);
  const key = `sk-${'f'.repeat(32)}`;
  const result = scanHistory(`${sha}:src/win.ts:7:const k = '${key}';\r`);
  assert.equal(result.ok, false, 'a CRLF file must not hide a credential');
  assert.equal(result.violations[0].line, 7);
});

test('the audit fails closed when the repository cannot be read', () => {
  // "could not check" must never print the same word as "checked, found
  // nothing". This tool certifies a one-way door; a certification it cannot
  // substantiate is worse than none, and it used to exit 0 here.
  const tool = path.join(ROOT, 'tools/check-public-safety.mjs');
  const exitOf = (env) => {
    try {
      execFileSync(process.execPath, [tool], {
        cwd: ROOT,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      return 0;
    } catch (err) {
      return err.status;
    }
  };
  assert.equal(exitOf({}), 0, 'the real repository is safe to publish');
  assert.equal(exitOf({ GIT_DIR: '/nonexistent' }), 1, 'a broken git must not certify safety');
});

test('the audit locates a history hit instead of counting output lines', () => {
  // The distinction this pins: `scanForCredentials` would have reported
  // `history:1` — the first line of the *output*, which is not a location in the
  // repository at all, and leaves a maintainer nothing to rewrite.
  const sha = 'c'.repeat(40);
  const key = `ghp_${'d'.repeat(36)}`;
  const result = audit(syntheticRoot({ 'data/stack.json': seedStack() }), {
    tracked: [],
    treeText: '',
    historyText: `${sha}:lib/llm.mjs:9:  apiKey: '${key}',`,
  });
  assert.equal(result.ok, false);
  const v = result.results['no credential in history'].violations[0];
  assert.equal(v.commit, sha.slice(0, 12));
  assert.equal(v.file, 'lib/llm.mjs');
  assert.equal(v.line, 9);
});

/* ------------------------------------------------------------------ audit --- */

test('the audit composes every check', () => {
  const root = syntheticRoot({ 'data/stack.json': seedStack() });
  const result = audit(root, { tracked: ['README.md'], treeText: '', historyText: '' });
  assert.equal(result.ok, true, JSON.stringify(result.results));
  assert.deepEqual(Object.keys(result.results).sort(), [
    'endpoint disclosure',
    'no credential in history',
    'no credential in the tree',
    'no scratch tracked',
    'seed stack',
  ]);
});

test('one bad input fails the whole audit', () => {
  const stack = seedStack();
  stack.watch.upstreams.push('acme-corp/platform');
  const root = syntheticRoot({ 'data/stack.json': stack });
  assert.equal(audit(root, { tracked: [], treeText: '', historyText: '' }).ok, false);
});

/* --------------------------------------------------------- the real repo --- */

test('the repository as it stands is safe to publish', () => {
  const result = audit(ROOT, { tracked: [], treeText: '', historyText: '' });
  const broken = Object.entries(result.results)
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => `${name}: ${JSON.stringify(r.violations)}`);
  assert.equal(result.ok, true, broken.join('\n'));
});

test('the seed list recorded here matches the stack this repository ships', () => {
  const result = checkSeedStack(ROOT);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.ok(SEED.feeds.every((f) => f.startsWith('https://')), 'a feed must be https');
});
