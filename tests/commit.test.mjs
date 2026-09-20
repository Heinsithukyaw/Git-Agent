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
import { parseYaml } from '../lib/invariants.mjs';

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

/**
 * What a keyless run records: no endpoint was asked for, so there is no gap.
 *
 * This is the *default* here, not the absence of a record, and the difference is
 * load-bearing. `narrate-step` writes `narration.json` on every path that
 * returns, including this one, so a sandbox with no record at all is not
 * modelling a keyless instance — it is modelling a narrate stage that delivered
 * nothing, which `commit-step` treats as a failure.
 */
const KEYLESS_STATUS = { configured: false, ok: false, kind: 'not-configured', status: null };

/**
 * The artifacts the narrate job produces, as the commit job receives them.
 *
 * The two flags model the two ways the stage can fail to deliver, and they are
 * different states rather than one:
 *
 *   - `decisionsDelivered: false` alone is the **crash**: `narrate-step` writes
 *     its provisional `narration.json` before anything that can throw, so the
 *     record arrives and the decision set does not.
 *   - both false is the **job**: it died before the step ran at all, so the
 *     run-state artifact is empty and neither file crosses the boundary.
 */
function sandbox({
  prose = null,
  narrationStatus = KEYLESS_STATUS,
  decisionsDelivered = true,
  narrationDelivered = true,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-commit-'));
  fs.mkdirSync(path.join(dir, '.run'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.run/payload.json'), JSON.stringify(payload(), null, 2) + '\n', 'utf8');
  if (decisionsDelivered) {
    fs.writeFileSync(path.join(dir, '.run/decisions.json'), JSON.stringify(decisions(), null, 2) + '\n', 'utf8');
  }
  if (prose !== null) fs.writeFileSync(path.join(dir, '.run/prose.md'), prose, 'utf8');
  if (narrationDelivered) {
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

test('the decision rows survive the job boundary — the artifact handoff, simulated', () => {
  // Every other test in this file fabricates `.run/decisions.json` straight into
  // the sandbox, and that fabrication is exactly why the pipeline could ship
  // green while publishing "0 to act on": it hides the boundary. On GitHub the
  // commit job is a fresh runner that sees only what the narrate job uploaded.
  //
  // So the upload list is read out of the real workflow and *only* those paths
  // are copied across. This is the closest a local test can get to the platform
  // fact, and it is the test whose absence let the defect ship.
  const wf = parseYaml(fs.readFileSync(path.join(REPO, '.github/workflows/digest.yml'), 'utf8'));

  // Every artifact this workflow can carry, by name.
  const byName = new Map();
  for (const job of Object.values(wf.jobs)) {
    for (const step of job.steps ?? []) {
      if (String(step.uses ?? '').split('@')[0] !== 'actions/upload-artifact') continue;
      const paths = String(step.with?.path ?? '')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      byName.set(String(step.with?.name), paths);
    }
  }

  // What the commit job actually receives is the union of the artifacts it
  // downloads — `payload` from the fetch job and the run state from narrate.
  // Modelling it as "the narrate job's upload" would be wrong in a way that
  // looks right: the payload arrives by a different artifact entirely.
  const downloaded = [];
  for (const step of wf.jobs.commit.steps ?? []) {
    if (String(step.uses ?? '').split('@')[0] !== 'actions/download-artifact') continue;
    downloaded.push(String(step.with?.name));
  }
  assert.ok(downloaded.length >= 2, `the commit job downloads ${JSON.stringify(downloaded)}`);

  const crossing = downloaded.flatMap((name) => byName.get(name) ?? []);
  assert.ok(
    crossing.includes('.run/decisions.json'),
    `the decision rows must cross the job boundary; the commit job receives ${JSON.stringify(crossing)}`,
  );

  // What narrate leaves behind on a keyless run: the triage output and the
  // narration record, no prose, no endpoint probe.
  const produced = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-narrate-'));
  fs.mkdirSync(path.join(produced, '.run'), { recursive: true });
  fs.writeFileSync(path.join(produced, '.run/payload.json'), JSON.stringify(payload(), null, 2), 'utf8');
  fs.writeFileSync(path.join(produced, '.run/decisions.json'), JSON.stringify(decisions(), null, 2), 'utf8');
  fs.writeFileSync(
    path.join(produced, '.run/narration.json'),
    JSON.stringify(
      { recorded_at: OBSERVED, configured: false, ok: false, kind: 'not-configured', status: null },
      null,
      2,
    ),
    'utf8',
  );

  // A fresh runner: only the uploaded paths cross.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-commit-'));
  for (const rel of crossing) {
    const from = path.join(produced, rel);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const rows = JSON.parse(fs.readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8').trim().split('\n')[0]);
  assert.equal(
    rows.counts.decisions,
    2,
    'an empty decision set that still reports ok is the defect this pins',
  );
  assert.equal(
    rows.narration_status.configured,
    false,
    'and the narration record must cross too, or I11 cannot tell a broken endpoint from a keyless instance',
  );

  // The absence signal: both are written only from `decisions`, so their absence
  // in a commit is what the artifact gap looks like from outside the pipeline.
  assert.ok(fs.existsSync(path.join(dir, 'data/triage.jsonl')), 'triage rows reach the append-only log');
  assert.ok(fs.existsSync(path.join(dir, 'history/events.jsonl')), 'and so do the transitions');
});

test('a narrate stage that delivered nothing publishes nothing but the heartbeat', () => {
  // The route this closes. `needs.narrate.result` is `success` under
  // `continue-on-error: true`, so a narrate job that died from an exception used
  // to leave this job with an empty decision set — which it read as "0 to act on"
  // and reported as `ok`. Refusing to publish is the fix; the `heartbeat` job in
  // `digest.yml` is what keeps the liveness signal moving anyway.
  const dir = sandbox({ decisionsDelivered: false, narrationDelivered: false });
  const result = run(dir);

  assert.equal(result.status, 1, 'a run whose substance is missing must fail loudly');
  assert.match(result.stderr, /did not deliver its output/);
  assert.match(result.stderr, /\.run\/decisions\.json/);
  assert.match(result.stderr, /\.run\/narration\.json/);

  // The heartbeat moves. That is the whole point of the exemption (I4): a broken
  // agent that commits nothing gets its schedule disabled after 60 days.
  const heartbeat = JSON.parse(fs.readFileSync(path.join(dir, 'data/heartbeat.json'), 'utf8'));
  assert.equal(heartbeat.last_status, 'failed');
  assert.equal(heartbeat.consecutive_failures, 1);

  // And nothing else does. A digest rendered from a decision set nobody computed
  // is the failure mode, so there must be no digest at all.
  assert.deepEqual(written(dir), ['data/heartbeat.json']);
});

test('a crash between the provisional record and the decision set is caught too', () => {
  // The narrower of the two states, and the one the provisional write exists to
  // make visible: `narration.json` arrives carrying `kind: 'started'`, because
  // `narrate-step` writes it before `readPayload()` and `triage()`, either of
  // which can throw. So the record is present and says "began, never finished" —
  // which must not read as a keyless instance, and must not be published as one.
  const dir = sandbox({
    decisionsDelivered: false,
    narrationStatus: { configured: null, ok: false, kind: 'started' },
  });
  const result = run(dir);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /\.run\/decisions\.json/, 'the missing half is named');
  assert.doesNotMatch(result.stderr, /\.run\/narration\.json/, 'and the delivered half is not');
  assert.deepEqual(written(dir), ['data/heartbeat.json']);
});

test('a narrate step that crashed still degrades rather than failing the run', () => {
  // The distinction the status vocabulary exists for. The decision set arrived, so
  // the digest is complete and correct — only the prose is missing — and a
  // narration failure must never fail a run whose product is intact. The record,
  // not the platform's masked job result, is what decides this.
  const dir = sandbox({
    narrationStatus: { configured: true, ok: false, kind: 'crashed', status: null, detail: 'TypeError' },
  });
  const result = run(dir);

  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(fs.readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8').trim());
  assert.equal(row.status, 'degraded');
  assert.equal(row.narration_status.kind, 'crashed', 'the why travels, not just the that');
  assert.match(fs.readFileSync(path.join(dir, 'digest/2026-09-20.md'), 'utf8'), /failed before it could call the model/);
});

test('a decision set that is present but empty is still a published digest', () => {
  // The other half of the same distinction, and the reason the check is on the
  // *file* rather than on its length: an empty set is a real answer — "we looked
  // and found nothing" — and it must keep producing a digest. Failing closed here
  // would trade a false negative for a false alarm.
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, '.run/decisions.json'), '[]', 'utf8');
  const result = run(dir);

  assert.equal(result.status, 0, result.stderr);
  const row = JSON.parse(fs.readFileSync(path.join(dir, 'history/runs.jsonl'), 'utf8').trim());
  assert.equal(row.counts.decisions, 0);
  assert.equal(row.status, 'ok');
  assert.ok(fs.existsSync(path.join(dir, 'digest/2026-09-20.md')), 'an empty set is still a digest');
});

test('the committed endpoint record carries no host and no model', () => {
  // `lib/probe.mjs` no longer emits either, and `commit-step` projects the record
  // through an allowlist anyway — this file is a one-way door, committed to a
  // repository that may be public. Both halves are pinned here;
  // `checkNoEndpointDisclosure()` re-checks the committed result before
  // publication, which is what would catch a field wrongly added to the allowlist.
  const dir = sandbox();
  fs.writeFileSync(
    path.join(dir, '.run/endpoint.json'),
    JSON.stringify(
      {
        probed_at: OBSERVED,
        configured: true,
        host: 'gateway.internal.example',
        model: 'a-model',
        capabilities: { chat_completions: true },
        timings: { chat_ms: 42 },
      },
      null,
      2,
    ),
    'utf8',
  );
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const committed = JSON.parse(fs.readFileSync(path.join(dir, 'data/endpoint.json'), 'utf8'));
  assert.equal(committed.host, undefined, "the host is the user's, not the template's (I8)");
  assert.equal(committed.model, undefined);
  assert.equal(committed.capabilities.chat_completions, true, 'the measurement is the point');
  assert.equal(committed.timings.chat_ms, 42);
});
