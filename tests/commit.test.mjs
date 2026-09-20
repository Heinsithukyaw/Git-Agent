/**
 * The commit job.
 *
 * `commit-step.mjs` is the only component that decides what gets written, and it
 * is the component no prompt injection can reach — it holds a write token and no
 * model key (I1). Until now nothing ran it: the gate was unit-tested, the
 * renderer was unit-tested, and the **order** between them was a comment and a
 * code-reading fact.
 *
 * So the order is asserted here by its effect on the filesystem rather than by
 * reading the file. The property is the one the header states — *"if the gate
 * fails, nothing is written except the heartbeat"* — and it is exactly the
 * property a reordering breaks: render before gate and the digest is already on
 * disk by the time the process exits non-zero. A test that checked "the gate was
 * called" would pass against that reordering. Counting the files does not.
 *
 * Run as a child process with a temporary working directory, the way
 * `tests/heartbeat.test.mjs` runs the failure path and `tests/site.test.mjs` runs
 * the renderer: `lib/store.mjs` resolves against the process's cwd and the
 * imports resolve against the script's own location.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check } from '../lib/gate.mjs';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts/commit-step.mjs');
const OBSERVED = '2026-09-20T19:29:40.852Z';

/**
 * The payload, in the shape OSV actually returns: `severity` is an array of
 * CVSS **vector strings**, and the numeric score is arithmetic `triage.mjs` does
 * afterwards. That is the whole reason the decision rows have to be folded into
 * the gated document, so a fixture that put a number here would hide the defect
 * it is meant to expose.
 */
function payload() {
  return {
    observed_at: OBSERVED,
    packages: [
      {
        name: 'express',
        ecosystem: 'npm',
        pinned: '4.18.2',
        usage: { imported_symbols: ['express', 'Router'], runtime: 'node' },
        upstream: { ecosystem: 'npm', name: 'express', latest: '5.2.1' },
      },
      { name: 'lodash', ecosystem: 'npm', pinned: '4.17.21', usage: { imported_symbols: ['merge'] } },
    ],
    advisories: [
      {
        id: 'GHSA-qw6h-vgh9-j6wx',
        aliases: ['CVE-2024-43796'],
        summary: 'express vulnerable to XSS via response.redirect()',
        modified: '2026-09-10T03:50:18.298562940Z',
        severity: [
          { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:L' },
          { type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:P/VC:N/VI:N/VA:N/SC:L/SI:L/SA:L' },
        ],
        affected: [{ type: 'SEMVER', introduced: '0', fixed: '4.20.0', last_affected: null }],
      },
      {
        id: 'GHSA-r5fr-rjxr-66jc',
        aliases: [],
        summary: 'lodash command injection',
        modified: '2026-09-10T03:50:18.298562940Z',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
        affected: [{ type: 'SEMVER', introduced: '0', fixed: '4.18.0', last_affected: null }],
      },
    ],
    releases: [],
    feeds: [],
    errors: [],
    watch: { packages: ['express', 'lodash'] },
  };
}

/**
 * `severity: 5.3` is the number the gate can only ground once the decision rows
 * are folded in. It is not anywhere in the payload above, and it cannot be —
 * OSV publishes the vector, not the score.
 */
function decisions() {
  return [
    {
      observed_at: OBSERVED,
      advisory_id: 'GHSA-qw6h-vgh9-j6wx',
      aliases: ['CVE-2024-43796'],
      package: 'express',
      ecosystem: 'npm',
      pinned: '4.18.2',
      upgrade: '4.20.0',
      decision: 'act',
      reason: 'affected, and we import express',
      layer: 'rules',
      tau: 0.8,
      typed: null,
      model_version: null,
      severity: 5.3,
      severity_label: null,
    },
    {
      observed_at: OBSERVED,
      advisory_id: 'GHSA-r5fr-rjxr-66jc',
      aliases: [],
      package: 'lodash',
      ecosystem: 'npm',
      pinned: '4.17.21',
      upgrade: '4.18.0',
      decision: 'act',
      reason: 'affected, and we import merge',
      layer: 'rules',
      tau: 0.8,
      typed: null,
      model_version: null,
      severity: 8.1,
      severity_label: null,
    },
  ];
}

/** Grounded prose, but only against the *folded* document. See the premise test. */
const GROUNDED = [
  'express is pinned at 4.18.2 and affected by GHSA-qw6h-vgh9-j6wx.',
  'The fix is in 4.20.0, and the severity is 5.3.',
].join(' ');

/** A package the payload has never heard of. */
const UNGROUNDED = 'lodash is pinned at 4.17.21, and we also import left-pad.';

function sandbox({ prose = null, narrationStatus = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-commit-'));
  fs.mkdirSync(path.join(dir, '.run'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.run/payload.json'), JSON.stringify(payload(), null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.run/decisions.json'), JSON.stringify(decisions(), null, 2) + '\n', 'utf8');
  if (prose !== null) fs.writeFileSync(path.join(dir, '.run/prose.md'), prose, 'utf8');
  if (narrationStatus) {
    fs.writeFileSync(
      path.join(dir, '.run/narration.json'),
      JSON.stringify({ recorded_at: OBSERVED, ...narrationStatus }, null, 2) + '\n',
      'utf8',
    );
  }
  return dir;
}

function run(dir, env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', ...env },
  });
}

/** Every file written into the sandbox outside `.run/`, relative and slash-separated. */
function written(dir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (child === '.run') continue;
        walk(child);
      } else {
        out.push(child);
      }
    }
  };
  walk('');
  return out.sort();
}

const OK_STATUS = { configured: true, ok: true, kind: null, status: 200 };

test('a failed gate writes only the heartbeat — which is what pins the gate before the render', () => {
  const dir = sandbox({ prose: UNGROUNDED, narrationStatus: OK_STATUS });
  const result = run(dir);

  assert.equal(result.status, 1, 'the run must fail loudly, not commit bad prose');
  assert.match(result.stderr, /containment gate FAILED/);
  assert.match(result.stderr, /left-pad/, 'the violation names the entity');

  // The ordering assertion. Render before gate and `digest/` is already written
  // by the time the process exits 1; append before gate and `history/` is too.
  assert.deepEqual(written(dir), ['data/heartbeat.json'], 'nothing but the heartbeat survives a failed gate');

  const heartbeat = JSON.parse(fs.readFileSync(path.join(dir, 'data/heartbeat.json'), 'utf8'));
  assert.equal(heartbeat.last_status, 'failed');
  assert.equal(heartbeat.consecutive_failures, 1, 'and the streak moves, so the failure is not silent');
});

test('a grounded narration is committed, and the run records that it was', () => {
  const dir = sandbox({ prose: GROUNDED, narrationStatus: OK_STATUS });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const digestPath = path.join(dir, 'digest/2026-09-20.md');
  assert.ok(fs.existsSync(digestPath), 'the digest is written on the success path');
  const digest = fs.readFileSync(digestPath, 'utf8');
  assert.match(digest, /GHSA-qw6h-vgh9-j6wx/, 'the prose is in it');
  assert.match(digest, /## Act on these/, 'and so is the deterministic table');
  assert.equal(digest.split('\n').filter((l) => /^#\s/.test(l)).length, 1, 'one H1, as ever');

  const rows = fs
    .readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].narration, true, 'the run records that prose was committed');
  assert.equal(rows[0].narration_status.configured, true);
  assert.deepEqual(rows[0].counts, { decisions: 2, act: 2, uncertain: 0 });

  assert.ok(fs.existsSync(path.join(dir, 'data/summary.json')));
  assert.match(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), /git-agent:begin/);
});

test('a fact only the decision rows carry is groundable at the entry point', () => {
  // The premise, asserted rather than assumed. `5.3` is arithmetic over OSV's
  // CVSS vector: it is in the decision rows and it cannot be in the payload. If
  // this prose were groundable against the bare payload too, the test below
  // would pass while proving nothing.
  assert.equal(check(GROUNDED, payload()).ok, false, 'the premise: not groundable without the decisions');
  assert.deepEqual(
    check(GROUNDED, payload()).violations.map((v) => v.token).sort(),
    ['5.3'],
    'and it is exactly the computed severity that is missing',
  );

  // So this passing is evidence that `commit-step` hands the gate the document
  // the narrator was given — the payload with the decisions folded in — and not
  // `payload.json` alone. Reverting that line fails here, not in production.
  const dir = sandbox({ prose: GROUNDED, narrationStatus: OK_STATUS });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'digest/2026-09-20.md')));
});

test('a narration that was configured and produced a title only is rendered as a gap', () => {
  // `prose.md` is only ever written on the success path, so this run answered
  // 200 and said nothing. Dropping the title must not turn it into a run that
  // reads like a deliberately keyless instance.
  const dir = sandbox({ prose: '# Dependency digest\n', narrationStatus: OK_STATUS });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const digest = fs.readFileSync(path.join(dir, 'digest/2026-09-20.md'), 'utf8');
  assert.match(digest, /## Gaps in this run/);
  assert.match(digest, /`narration`/);
  assert.match(digest, /wrote a title and nothing else/);
  assert.equal(digest.split('\n').filter((l) => /^#\s/.test(l)).length, 1);

  // Not a failure, either: the digest is complete without it. Degraded, not
  // failed — the same distinction `narration_status` exists to express.
  const rows = JSON.parse(fs.readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(rows.status, 'degraded');
  assert.equal(rows.narration, true);
});

test('a keyless instance writes a complete digest and claims no gap', () => {
  // The other half of the distinction, at the entry point: no prose, no
  // narration record. A supported mode, not a degradation.
  const dir = sandbox();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const digest = fs.readFileSync(path.join(dir, 'digest/2026-09-20.md'), 'utf8');
  assert.doesNotMatch(digest, /## Gaps in this run/);
  assert.match(digest, /## Act on these/, 'and the deterministic digest is the whole product');

  const rows = JSON.parse(fs.readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(rows.status, 'ok');
  assert.equal(rows.narration, false);
});

test('the client identity stays in the artifact and out of everything committed', () => {
  // A relay that gates on client identity refuses a request *before* reading the
  // credential, and its error names the client rather than the key — so "the key
  // is wrong" and "the identity you configured is no longer accepted" are the
  // same 401. The identity is the only fact that separates them, so the narrate
  // job records it. It stops there: the identity names the infrastructure, and
  // both the digest and the run chain are committed.
  //
  // This also pins that `commit-step` enumerates the fields it carries forward
  // rather than spreading the artifact. `...narrationStatus` would fail here.
  const dir = sandbox({
    prose: GROUNDED,
    narrationStatus: { ...OK_STATUS, user_agent: 'a-tool/1.2.3' },
  });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  assert.doesNotMatch(
    fs.readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8'),
    /a-tool/,
    'the run chain is committed, so the identity does not travel in it',
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(dir, 'digest/2026-09-20.md'), 'utf8'),
    /a-tool/,
    'and the digest is the most public surface of all',
  );
});
