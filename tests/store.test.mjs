/**
 * The write path — bounded writes, the change gate, and the hash chain.
 *
 * `lib/store.mjs` resolves every path against the process's working directory at
 * import time, so this file runs inside a temporary directory. That is not a
 * workaround: it is the only way to test a fail-closed writer without the
 * possibility of writing to the real repository when the writer is wrong.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-store-'));
process.chdir(TMP);

const store = await import('../lib/store.mjs');

before(() => {
  assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(TMP));
});

/* ------------------------------------------------------- bounded writes --- */

test('the allowlist refuses everything outside it', () => {
  const refused = [
    'src/index.ts',
    'lib/store.mjs',
    '.github/workflows/digest.yml',
    '../escape.json',
    'data/../../etc/passwd',
    '/tmp/absolute.json',
    '',
    null,
    42,
  ];
  for (const p of refused) {
    assert.throws(() => store.assertWritable(p), /write denied/, `expected refusal for ${JSON.stringify(p)}`);
  }
});

test('the allowlist accepts the paths the pipeline actually writes', () => {
  for (const p of ['data/summary.json', 'history/runs.jsonl', 'digest/2026-01-01.md', 'assets/badge.svg', 'README.md']) {
    assert.equal(store.assertWritable(p), p);
  }
});

test('site/ is writable by CI and not by the collector', () => {
  assert.throws(() => store.assertWritable('site/index.html'), /write denied/);
  assert.equal(store.assertWritable('site/index.html', store.CI_ALLOWLIST), 'site/index.html');
});

/* ---------------------------------------------------------- change gate --- */

test('an identical write is not a change', () => {
  const first = store.writeIfChanged('data/summary.json', { a: 1 });
  assert.equal(first.changed, true);
  const second = store.writeIfChanged('data/summary.json', { a: 1 });
  assert.equal(second.changed, false);
  assert.equal(second.reason, 'identical');
});

test('a volatile timestamp does not restamp the file', () => {
  store.writeIfChanged('data/summary.json', { a: 1, generated_at: '2026-01-01T00:00:00.000Z' });
  const again = store.writeIfChanged('data/summary.json', { a: 1, generated_at: '2026-06-01T12:00:00.000Z' });
  assert.equal(again.changed, false, 'the change gate must strip volatile scalars before comparing');
});

test('a real difference is a change', () => {
  store.writeIfChanged('data/summary.json', { a: 1 });
  const changed = store.writeIfChanged('data/summary.json', { a: 2 });
  assert.equal(changed.changed, true);
  assert.equal(changed.reason, 'differs');
});

test('exactly one file is exempt from the gate, and it is the heartbeat', () => {
  assert.deepEqual(store.GATE_EXEMPT, ['data/heartbeat.json']);
  assert.equal(store.isGateExempt('data/heartbeat.json'), true);
  assert.equal(store.isGateExempt('data/summary.json'), false);
});

test('the heartbeat is rewritten even when nothing changed', () => {
  const heartbeat = { last_run_at: '2026-01-01T00:00:00.000Z', last_status: 'ok', consecutive_failures: 0 };
  assert.equal(store.writeIfChanged('data/heartbeat.json', heartbeat).changed, true);
  const second = store.writeIfChanged('data/heartbeat.json', heartbeat);
  assert.equal(second.changed, true, 'the exemption exists so a broken agent keeps committing');
  assert.equal(second.reason, 'exempt');
});

test('stripVolatile removes timestamps at any depth', () => {
  const stripped = store.stripVolatile({
    keep: 1,
    updated_at: 'x',
    nested: { observed_at: 'x', keep: 2, list: [{ run_id: 'x', keep: 3 }] },
  });
  assert.deepEqual(stripped, { keep: 1, nested: { keep: 2, list: [{ keep: 3 }] } });
});

/* -------------------------------------------------------- append-only ----- */

test('rows append and read back, and a corrupt row is loud', () => {
  store.appendRow('history/events.jsonl', { kind: 'flagged', advisory_id: 'A' });
  store.appendRow('history/events.jsonl', { kind: 'cleared', advisory_id: 'B' });
  const rows = store.readRows('history/events.jsonl');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].kind, 'cleared');
  assert.equal(store.lastRow('history/events.jsonl').advisory_id, 'B');

  fs.appendFileSync(path.join(TMP, 'history/events.jsonl'), 'not json\n', 'utf8');
  assert.throws(() => store.readRows('history/events.jsonl'), /corrupt row 2/);
});

test('a missing file reads as empty rather than throwing', () => {
  assert.deepEqual(store.readRows('history/nothing-here.jsonl'), []);
  assert.equal(store.lastRow('history/nothing-here.jsonl'), null);
});

test('an absolute read path is honoured, not re-joined with the root', () => {
  // The regression: `path.join(root, absolutePath)` yields `root + absolutePath`,
  // a path that never exists. The command log's idempotency check reads through
  // an absolute path, so every re-run saw "not handled yet" and acted twice.
  store.appendRow('history/absolute.jsonl', { n: 1 });
  const abs = path.join(TMP, 'history/absolute.jsonl');
  assert.equal(store.readRows(abs).length, 1);
  assert.deepEqual(store.readJson(abs), { n: 1 });
});

/* ----------------------------------------------------------- hash chain --- */

test('the run log chains, and each row covers the previous hash', () => {
  store.appendRun('history/runs.jsonl', { run_id: '1', status: 'ok' });
  store.appendRun('history/runs.jsonl', { run_id: '2', status: 'ok' });
  store.appendRun('history/runs.jsonl', { run_id: '3', status: 'degraded' });

  const rows = store.readRows('history/runs.jsonl');
  assert.equal(rows[0].prevHash, null);
  assert.equal(rows[1].prevHash, rows[0].hash);
  assert.equal(rows[2].prevHash, rows[1].hash);
  assert.deepEqual(store.verifyChain('history/runs.jsonl'), { ok: true, rows: 3 });
});

test('editing a past row breaks the chain from that row onward', () => {
  const file = path.join(TMP, 'history/runs.jsonl');
  const rows = store.readRows('history/runs.jsonl');
  rows[1].status = 'tampered';
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

  const result = store.verifyChain('history/runs.jsonl');
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
  assert.equal(result.reason, 'hash mismatch');
});

test('a row appended without a hash is refused rather than silently unchained', () => {
  fs.appendFileSync(path.join(TMP, 'history/runs.jsonl'), JSON.stringify({ run_id: 'x' }) + '\n', 'utf8');
  assert.throws(() => store.appendRun('history/runs.jsonl', { run_id: '4' }), /hash chain broken/);
});

/* ------------------------------------------------------------- helpers ---- */

test('sha256 is stable and readJson tolerates absence', () => {
  assert.equal(store.sha256('a'), store.sha256('a'));
  assert.notEqual(store.sha256('a'), store.sha256('b'));
  assert.equal(store.readJson('data/does-not-exist.json', { fallback: true }).fallback, true);
});
