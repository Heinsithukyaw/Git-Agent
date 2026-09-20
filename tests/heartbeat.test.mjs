/**
 * The failure path.
 *
 * This is the one job that only ever runs when something else has already gone
 * wrong, which is exactly the kind of code that is never exercised and quietly
 * rots. The property it defends: **a run that produced nothing still leaves a
 * mark**, because a repository whose scheduled workflow commits nothing for 60
 * days has its schedule disabled, and the failure becomes permanent and silent.
 *
 * The script is run as a child process with a temporary working directory, which
 * is how it runs in CI: `lib/store.mjs` resolves against the process's cwd, and
 * the imports resolve against the script's own location.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts/heartbeat-step.mjs');
const MARKER_BEGIN = '<!-- git-agent:begin -->';
const MARKER_END = '<!-- git-agent:end -->';

function sandbox({ heartbeat = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-hb-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  if (heartbeat) {
    fs.writeFileSync(path.join(dir, 'data/heartbeat.json'), JSON.stringify(heartbeat, null, 2) + '\n', 'utf8');
  }
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    `# Git Agent\n\nintro\n\n${MARKER_BEGIN}\n### As of yesterday\n\n**1 to act on**\n${MARKER_END}\n\nfooter\n`,
    'utf8',
  );
  return dir;
}

function run(dir, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', ...env },
  });
  return result;
}

test('a failed run increments the streak and records the run', () => {
  const dir = sandbox();
  const result = run(dir, { HEARTBEAT_STATUS: 'failed', FETCH_RESULT: 'failure' });
  assert.equal(result.status, 0, result.stderr);

  const heartbeat = JSON.parse(fs.readFileSync(path.join(dir, 'data/heartbeat.json'), 'utf8'));
  assert.equal(heartbeat.last_status, 'failed');
  assert.equal(heartbeat.consecutive_failures, 1);
  assert.equal(heartbeat.last_success_at, null);
  assert.ok(heartbeat.last_run_at);

  const rows = fs
    .readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 1, 'a run that produced nothing is still a run');
  assert.equal(rows[0].status, 'failed');
  assert.equal(
    rows[0].reason,
    'The fetch job did not produce a payload (result: failure).',
    'the reason names the job that actually failed',
  );
  assert.ok(rows[0].hash, 'the run log stays chained');
});

test('the reason names the job that failed, not the one that was skipped', () => {
  // When `fetch` fails, the `commit` job is *skipped* rather than failed, and
  // `needs.commit.result` reads `skipped`. Reporting that as the cause would name
  // the wrong job — so `fetch` is checked first, and this pins that ordering.
  const dir = sandbox();
  run(dir, { HEARTBEAT_STATUS: 'failed', FETCH_RESULT: 'failure', COMMIT_RESULT: 'skipped' });

  const row = JSON.parse(fs.readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8').trim());
  assert.equal(row.reason, 'The fetch job did not produce a payload (result: failure).');
});

test('a failed commit is its own reason, and reaches the same liveness signal', () => {
  // The second cause this job covers, and the one that used to leave the
  // repository untouched: `commit-step` refuses to publish when the narrate stage
  // delivered no decision set, so the commit job fails and nothing moves. Without
  // this branch the refusal would be silent for 60 days and then permanent.
  const dir = sandbox();
  run(dir, { HEARTBEAT_STATUS: 'failed', FETCH_RESULT: 'success', COMMIT_RESULT: 'failure' });

  const row = JSON.parse(fs.readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8').trim());
  assert.equal(row.reason, 'The commit job did not publish a digest (result: failure).');
  const heartbeat = JSON.parse(fs.readFileSync(path.join(dir, 'data/heartbeat.json'), 'utf8'));
  assert.equal(heartbeat.consecutive_failures, 1);
});

test('the streak is monotonic while the agent stays broken', () => {
  const dir = sandbox();
  run(dir, { HEARTBEAT_STATUS: 'failed' });
  run(dir, { HEARTBEAT_STATUS: 'failed' });
  const third = run(dir, { HEARTBEAT_STATUS: 'failed' });
  assert.equal(third.status, 0);

  const heartbeat = JSON.parse(fs.readFileSync(path.join(dir, 'data/heartbeat.json'), 'utf8'));
  assert.equal(heartbeat.consecutive_failures, 3);

  const rows = fs
    .readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean);
  assert.equal(rows.length, 3, 'three runs, three rows — no state in which nothing is written');
});

test('a success resets the streak', () => {
  const dir = sandbox({ heartbeat: { consecutive_failures: 4, last_success_at: null } });
  run(dir, { HEARTBEAT_STATUS: 'ok' });

  const heartbeat = JSON.parse(fs.readFileSync(path.join(dir, 'data/heartbeat.json'), 'utf8'));
  assert.equal(heartbeat.consecutive_failures, 0);
  assert.equal(heartbeat.last_status, 'ok');
  assert.ok(heartbeat.last_success_at);
});

test('the README region states the failure instead of showing a stale summary', () => {
  const dir = sandbox();
  run(dir, { HEARTBEAT_STATUS: 'failed', FETCH_RESULT: 'failure' });

  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /The last run did not complete\./);
  assert.match(readme, /The fetch job did not produce a payload \(result: failure\)\./);
  assert.match(readme, /consecutive failures: 1/);
  assert.doesNotMatch(readme, /1 to act on/, 'the previous summary must not survive a failure');
  assert.match(readme, /^# Git Agent/, 'the rest of the README is untouched');
  assert.match(readme, /footer/);
});

test('a README with no markers is left alone rather than corrupted', () => {
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, 'README.md'), '# Git Agent\n\nno markers here\n', 'utf8');
  const result = run(dir, { HEARTBEAT_STATUS: 'failed' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# Git Agent\n\nno markers here\n');
});

test('the failure path writes nothing outside the collector allowlist', () => {
  const dir = sandbox();
  run(dir, { HEARTBEAT_STATUS: 'failed' });
  const written = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else written.push(child.split(path.sep).join('/'));
    }
  };
  walk('.');
  for (const file of written) {
    assert.ok(
      file === 'README.md' || file.startsWith('data/') || file.startsWith('history/'),
      `${file} is outside the collector allowlist`,
    );
  }
});
