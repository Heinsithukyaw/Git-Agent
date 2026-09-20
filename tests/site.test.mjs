/**
 * The published page.
 *
 * `render-site.mjs` embeds the committed digest into a page shell that already
 * carries an `<h1>` in its header. Embedding the document's own title under that
 * produced **two identical `<h1>Dependency digest</h1>` elements** on the
 * published page — the duplicate a reader reports, from the template rather than
 * from the model. The markdown keeps its title, because read on its own in
 * `digest/` it needs one; only the embedding drops it.
 *
 * This is an integration test on purpose. The option is unit-tested in
 * `tests/render.test.mjs`, but an option that is tested and not *wired* proves
 * nothing — that is the failure mode `references/verifying-your-checks.md` calls
 * "the documented surface and the wired one will drift". So the script is run as
 * a child process with a temporary working directory, the way
 * `tests/heartbeat.test.mjs` runs the failure path: `lib/store.mjs` resolves
 * against the process's cwd and the imports resolve against the script's own
 * location.
 *
 * The digest fixture is produced by the real `renderDigest`, fed the real prose a
 * live run returned. Producer and consumer, rather than a hand-written stand-in
 * for either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderDigest } from '../lib/render.mjs';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts/render-site.mjs');

/** The prose a live `deepseek-v4-flash` run returned. See `.workbuddy-ai/evidence/live-run-2026-09-21.md`. */
const LIVE_PROSE = [
  '# Dependency digest — observed 2026-09-20T19:29:40.852Z',
  '',
  '## Act',
  '',
  '**express — pinned 4.18.2** (we import express)',
  '- GHSA-qw6h-vgh9-j6wx — fixed in 4.20.0 — severity 5',
  '',
  '## Watch',
  '',
  '**lodash — pinned 4.17.21** (affected, not on an imported symbol)',
].join('\n');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-site-'));
  fs.mkdirSync(path.join(dir, 'digest'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });

  const markdown = renderDigest({
    payload: {
      observed_at: '2026-09-20T19:29:40.852Z',
      packages: [{ name: 'lodash', ecosystem: 'npm', pinned: '4.17.21' }],
      advisories: [],
      releases: [],
      feeds: [],
      errors: [],
    },
    decisions: [
      {
        advisory_id: 'GHSA-qw6h-vgh9-j6wx',
        package: 'express',
        pinned: '4.18.2',
        upgrade: '4.20.0',
        decision: 'act',
        reason: 'affected, and we import express',
        severity: 5,
        layer: 'rules',
      },
    ],
    narration: LIVE_PROSE,
    narrationStatus: { configured: true, ok: true, kind: null, status: 200 },
  });
  fs.writeFileSync(path.join(dir, 'digest/2026-09-20.md'), markdown, 'utf8');
  fs.writeFileSync(
    path.join(dir, 'data/summary.json'),
    JSON.stringify({ observed_at: '2026-09-20T19:29:40.852Z', advisories: 1, actionable: 1 }, null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'data/heartbeat.json'),
    JSON.stringify({ last_run_at: '2026-09-20T19:29:46.000Z', last_status: 'ok', consecutive_failures: 0 }, null, 2) + '\n',
    'utf8',
  );
  return dir;
}

function run(dir) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo' },
  });
}

const h1Count = (html) => (html.match(/<h1[ >]/g) ?? []).length;

test('the published page carries exactly one H1, and it is the page header', () => {
  const dir = sandbox();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const index = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
  assert.equal(h1Count(index), 1, 'the shell header is the only H1 on the page');

  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'site/data/digest.json'), 'utf8'));
  assert.equal(h1Count(doc.html), 0, 'the embedded document contributes no H1');
  assert.match(doc.html, /<h2>Act on these<\/h2>/, 'the template sections still render');
  assert.match(doc.html, /<h3>Act<\/h3>/, 'and the narration keeps its grouping, one level down');
  assert.doesNotMatch(doc.html, /Dependency digest — observed/, 'the restated title is gone from the page');
});

test('the committed markdown keeps its title, so `digest/` reads correctly on its own', () => {
  const dir = sandbox();
  run(dir);

  const onDisk = fs.readFileSync(path.join(dir, 'digest/2026-09-20.md'), 'utf8');
  const markdownH1 = onDisk.split('\n').filter((l) => /^#\s/.test(l));
  assert.equal(markdownH1.length, 1, 'one H1 in the document, and it is the template\'s');
  assert.equal(markdownH1[0], '# Dependency digest', 'the digest is its own document in the repository');

  // The raw markdown travels to the page too, for consumers that want it. It is
  // not what gets rendered, so the title stays in it.
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'site/data/digest.json'), 'utf8'));
  assert.equal(doc.markdown, onDisk);
});

test('the page renders with no digest published yet, rather than failing', () => {
  // A fresh template has no `digest/` at all until the first run commits one.
  // The site job still has to produce a page.
  const dir = sandbox();
  fs.rmSync(path.join(dir, 'digest'), { recursive: true, force: true });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'site/data/digest.json'), 'utf8'));
  assert.equal(doc.html, null);
  assert.equal(h1Count(fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8')), 1);
});
