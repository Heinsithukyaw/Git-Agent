/**
 * The published page.
 *
 * `render-site.mjs` reads two projected artifacts — `data/public-summary.json`
 * and `digest/public-<date>.md` — both written by the commit job. It never sees
 * a payload and never projects: `pages.yml` checks out committed files and
 * downloads no artifact, so a `(payload, policy)` filter has no execution point
 * here. That makes the **read set** the boundary, and these tests pin it from
 * both sides:
 *
 *   - the private files are present in the sandbox and must not reach the page;
 *   - the public digest is narration-free by construction, and the page must
 *     render it rather than the private one that shares its directory and date.
 *
 * The digest fixture is produced by the real `renderDigest`, fed the real prose a
 * live run returned. Producer and consumer, rather than a hand-written stand-in
 * for either.
 *
 * This is an integration test on purpose. The option is unit-tested in
 * `tests/render.test.mjs`, but an option that is tested and not *wired* proves
 * nothing — so the script is run as a child process with a temporary working
 * directory, the way `tests/heartbeat.test.mjs` runs the failure path:
 * `lib/store.mjs` resolves against the process's cwd and the imports resolve
 * against the script's own location.
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
const DATE = '2026-09-20';

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

/**
 * A distinctive phrase that exists only in the narration, so its absence is
 * evidence.
 *
 * Deliberately *not* `we import express`. That phrase is also the fixture
 * decision's `reason`, so it renders in the public template's decision table and
 * a sentinel taken from it appears in both documents — an assertion that cannot
 * fail, which is how this test first passed while proving nothing about whether
 * the narration was dropped.
 */
const NARRATION_ONLY = 'not on an imported symbol';

const PAYLOAD = {
  observed_at: '2026-09-20T19:29:40.852Z',
  packages: [{ name: 'lodash', ecosystem: 'npm', pinned: '4.17.21' }],
  advisories: [],
  releases: [],
  feeds: [],
  errors: [],
};

const DECISIONS = [
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
];

/**
 * A sandbox holding **both** the private and the public artifacts, as the commit
 * job leaves them on disk: two digests in one directory sharing a date, and two
 * summaries in `data/`.
 */
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-site-'));
  fs.mkdirSync(path.join(dir, 'digest'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });

  // The private digest: the full document, narration and all. It shares the
  // directory and the date with the public one, which is exactly why the
  // renderer's narrowing has to be explicit.
  const privateMarkdown = renderDigest({
    payload: PAYLOAD,
    decisions: DECISIONS,
    narration: LIVE_PROSE,
    narrationStatus: { configured: true, ok: true, kind: null, status: 200 },
  });
  fs.writeFileSync(path.join(dir, `digest/${DATE}.md`), privateMarkdown, 'utf8');

  // The public digest: projected, and narration-free — prose is not filterable,
  // so the public document is the template.
  const publicMarkdown = renderDigest({
    payload: PAYLOAD,
    decisions: DECISIONS,
    narration: null,
    narrationStatus: { configured: false, ok: false, kind: 'not-configured', status: null },
  });
  fs.writeFileSync(path.join(dir, `digest/public-${DATE}.md`), publicMarkdown, 'utf8');

  // The private summary. A sentinel is placed in it on purpose: if the renderer
  // ever reads this file, the sentinel reaches the page and the sweep below says
  // so. In production this file holds counts derived from the *unprojected* set,
  // which is a disclosure of its own — see `lib/public-surface.mjs` — and since
  // the drop record moved off the public surface, it is here too.
  fs.writeFileSync(
    path.join(dir, 'data/summary.json'),
    JSON.stringify(
      {
        observed_at: PAYLOAD.observed_at,
        advisories: 1,
        actionable: 1,
        private_sentinel: 'internal/payments-service',
        drop: { deny_all: false, dropped: 3, counts: { packages: 3 }, kinds: ['packages'], withheld: ['watch'] },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // The projected summary, in the shape the commit job writes: counts from the
  // publishable set, the **reduced** heartbeat, and no drop record. The heartbeat
  // is `{ last_run_at, last_status }` — `consecutive_failures` and
  // `last_success_at` are facts about the private run, and the drop record is a
  // cardinality of the private stack. Both stay in `data/summary.json` above.
  fs.writeFileSync(
    path.join(dir, 'data/public-summary.json'),
    JSON.stringify(
      {
        observed_at: PAYLOAD.observed_at,
        advisories: 1,
        actionable: 1,
        uncertain: 0,
        clear: 0,
        packages: 1,
        sources_failed: 0,
        last_run_at: '2026-09-20T19:29:46.000Z',
        last_status: 'ok',
        heartbeat: { last_run_at: '2026-09-20T19:29:46.000Z', last_status: 'ok' },
        commands: [{ verb: 'why', arg: 'lodash', outcome: 'answered' }],
      },
      null,
      2,
    ) + '\n',
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

/** Every file under `site/`, as text. */
function siteFiles(dir) {
  const files = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(next);
      else files.push({ rel: next, text: fs.readFileSync(path.join(dir, next), 'utf8') });
    }
  };
  walk('site');
  return files;
}

test('the published page carries exactly one H1, and it is the page header', () => {
  const dir = sandbox();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const index = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
  assert.equal(h1Count(index), 1, 'the shell header is the only H1 on the page');

  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'site/api/digest.json'), 'utf8'));
  assert.equal(h1Count(doc.html), 0, 'the embedded document contributes no H1');
  assert.match(doc.html, /<h2>Act on these<\/h2>/, 'the template sections still render');
  assert.doesNotMatch(doc.html, /Dependency digest — observed/, 'the restated title is gone from the page');
});

test('the page renders the public digest, not the private one beside it', () => {
  // The two files share a directory and a date, so this is the assertion that the
  // narrowing is real. The narration exists only in the private document.
  const dir = sandbox();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'site/api/digest.json'), 'utf8'));
  assert.equal(doc.date, DATE);
  assert.doesNotMatch(doc.html, new RegExp(NARRATION_ONLY), 'the public digest carries no narration');
  assert.doesNotMatch(doc.markdown, new RegExp(NARRATION_ONLY));

  // And the positive control: the private document really does contain it, so the
  // absence above is the narrowing and not an empty fixture.
  const privateMarkdown = fs.readFileSync(path.join(dir, `digest/${DATE}.md`), 'utf8');
  assert.match(privateMarkdown, new RegExp(NARRATION_ONLY));
});

test('the private summary never reaches the page', () => {
  const dir = sandbox();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const files = siteFiles(dir);
  assert.ok(files.length > 0);
  for (const f of files) {
    assert.ok(!f.text.includes('internal/payments-service'), `the private summary leaked into ${f.rel}`);
  }
  // The projected summary is what the page got.
  const published = JSON.parse(fs.readFileSync(path.join(dir, 'site/api/summary.json'), 'utf8'));
  assert.equal(published.packages, 1);
  assert.deepEqual(published.commands, [{ verb: 'why', arg: 'lodash', outcome: 'answered' }]);
});

test('the committed markdown keeps its title, so the digest reads correctly on its own', () => {
  const dir = sandbox();
  run(dir);

  const onDisk = fs.readFileSync(path.join(dir, `digest/public-${DATE}.md`), 'utf8');
  const markdownH1 = onDisk.split('\n').filter((l) => /^#\s/.test(l));
  assert.equal(markdownH1.length, 1, 'one H1 in the document, and it is the template\'s');
  assert.equal(markdownH1[0], '# Dependency digest', 'the digest is its own document in the repository');

  // The raw markdown travels to the page too, for consumers that want it. It is
  // not what gets rendered, so the title stays in it.
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'site/api/digest.json'), 'utf8'));
  assert.equal(doc.markdown, onDisk);
});

test('a private digest with no public one publishes no digest, rather than the private one', () => {
  // The failure the narrowing prevents: "the latest .md" would pick the private
  // document whenever no public one exists, and the page would publish the
  // narration and the unprojected tables.
  const dir = sandbox();
  fs.rmSync(path.join(dir, `digest/public-${DATE}.md`));
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'site/api/digest.json'), 'utf8'));
  assert.equal(doc.html, null, 'no public digest means no digest, not the private one');
  assert.equal(doc.markdown, null);
  assert.equal(h1Count(fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8')), 1);
});

test('the page renders with nothing published yet, rather than failing', () => {
  // A fresh template has no `digest/` at all until the first run commits one.
  // The site job still has to produce a page.
  const dir = sandbox();
  fs.rmSync(path.join(dir, 'digest'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'site/api/digest.json'), 'utf8'));
  assert.equal(doc.html, null);
  assert.equal(h1Count(fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8')), 1);
});

test('the page never prints a failure streak, or a cardinality of the private stack', () => {
  // The third heartbeat placement: the template prints
  // `heartbeat.consecutive_failures` whenever it is truthy, so the fix is that the
  // field is not on the public object at all. Confirmed in the rendered bytes
  // rather than by reasoning about the ternary.
  const dir = sandbox();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);

  const index = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
  assert.match(index, /Last run/, 'the liveness line renders, so the absence below is not an empty page');
  assert.doesNotMatch(index, /consecutive failure/);

  const published = fs.readFileSync(path.join(dir, 'site/api/summary.json'), 'utf8');
  for (const field of ['consecutive_failures', 'last_success_at', 'drop', 'dropped']) {
    assert.ok(!published.includes(`"${field}"`), `the page must not carry ${field}`);
  }
});

test('the streak sweep can fail — a private heartbeat shape in the public summary prints the phrase', () => {
  // The must-fail twin. Without it, the assertion above would pass just as well
  // on a template that had stopped rendering the liveness line entirely.
  const dir = sandbox();
  const summaryPath = path.join(dir, 'data/public-summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  summary.heartbeat = { ...summary.heartbeat, consecutive_failures: 3 };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const index = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
  assert.match(index, /3 consecutive failure/, 'the sweep must be able to see the phrase it forbids');
});

test('a withheld digest says so — a broken marker is not a quiet day', () => {
  // `buildPublicSurface()` keeps a broken marker loud (`withheld_reason`, plus
  // the count) and a deny-all silent. The page honoured neither half: measured,
  // a summary carrying `withheld_reason` rendered **byte-identical** to a healthy
  // instance with nothing to report. An operator whose marker was never read — a
  // typo, a missing key — saw a clean empty page and had no signal at all, which
  // is the failure §I11 exists to forbid: a component that produced nothing must
  // record why.
  const dir = sandbox();
  const summaryPath = path.join(dir, 'data/public-summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  summary.withheld_reason = 'invalid-marker';
  summary.invalid_marker = 2;
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const index = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
  assert.match(index, /being withheld/, 'a broken marker has to be visible on the page');
  assert.match(index, /2 problem/, 'the count travels; the entries do not');
  assert.match(index, /To fix it/, 'the page guides: it names the file and what to check');
  // The counts are derived from a document this run refused to write, so they
  // read "0 packages watched" — which is false, and contradicts the sentence
  // directly above it saying the stack is not empty. They are replaced rather
  // than printed, and the replacement says why, so the absence is not a bug.
  assert.doesNotMatch(index, /packages watched/, 'a withheld run must not print false zeros');
  assert.match(index, /Counts are not shown/, 'the absence is explained rather than left bare');
});

test('a deny-all stays silent — the banner keys on the reason, not on a zero count', () => {
  // The twin, and the half that is easy to get wrong. A deny-all is a *choice*,
  // not a failure: "everything was withheld" is itself a statement about the
  // private stack, so it must stay indistinguishable from a quiet day. A banner
  // keyed on a zero count rather than on `withheld_reason` would print here.
  //
  // The assertion is only non-vacuous beside the test above: that one proves the
  // phrase is reachable, this one proves it is not reached by an empty day.
  const dir = sandbox();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const index = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
  assert.doesNotMatch(index, /being withheld/);
  // A quiet day keeps its counts. This is what makes the assertion above
  // non-vacuous in the other direction too: suppressing the band is not a
  // general behaviour, it is a consequence of having nothing true to show.
  assert.match(index, /packages watched/, 'a quiet day still shows its counts');
});

test('the header pill never claims ok while the digest is being withheld', () => {
  // `publicHeartbeat()` re-derives `last_status` from the **published** error
  // list, so a run that withheld everything still reports `ok`: it published
  // nothing, therefore nothing failed. Rendered as a pill beside the H1, that
  // put a calm "OK" two lines above a banner saying the digest was being
  // withheld — the reader's first impression, and the wrong one.
  //
  // `headerStatus()` reads `withheld_reason`, the same field the banner reads,
  // so the two cannot disagree. This does not fix `publicHeartbeat()`: whether a
  // withheld run should be recorded as a failure is a question about the private
  // run, and answering it here would put a second opinion about status on the
  // public surface. It only stops the page making a claim it cannot support.
  //
  // Both directions are asserted. Either half alone passes on a page that prints
  // no pill at all, which is exactly the state this test exists to rule out.
  const healthy = sandbox();
  const okRun = run(healthy);
  assert.equal(okRun.status, 0, okRun.stderr);
  assert.match(fs.readFileSync(path.join(healthy, 'site/index.html'), 'utf8'), />OK</);

  const withheld = sandbox();
  const summaryPath = path.join(withheld, 'data/public-summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  summary.withheld_reason = 'invalid-marker';
  summary.invalid_marker = 2;
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n', 'utf8');

  const withheldRun = run(withheld);
  assert.equal(withheldRun.status, 0, withheldRun.stderr);
  const index = fs.readFileSync(path.join(withheld, 'site/index.html'), 'utf8');
  assert.match(index, />WITHHELD</, 'the pill has to agree with the banner beneath it');
  assert.doesNotMatch(index, />OK</, 'the reassuring pill is the one thing that must not survive');
});

test('the page draws the run, and the drawing names every stage and the gate', () => {
  // The run strip is the only place the page describes the *system* rather than
  // this run, which is why it renders even on an instance that has never
  // executed: a page that still explains what would happen beats an empty one.
  //
  // The graph it draws is read off `digest.yml` — `fetch` -> `narrate` ->
  // `commit`, with `heartbeat` reached only from the failure branch. Four jobs
  // and not one is a consequence of I1, and the gate is drawn on the wire
  // between `narrate` and `commit` because that is the claim being made: the
  // deciding step is not the step holding the model key.
  //
  // Asserted on the stage names and not on the element, because a strip whose
  // nodes were lost to a bad edit would still be an `<svg>` and would still pass
  // a presence check.
  const dir = sandbox();
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const index = fs.readFileSync(path.join(dir, 'site/index.html'), 'utf8');
  for (const stage of ['FETCH', 'NARRATE', 'COMMIT', 'HEARTBEAT']) {
    assert.match(index, new RegExp(`>${stage}<`), `the strip names ${stage}`);
  }
  assert.match(index, />GATE</, 'the strip marks the gate');
  assert.match(index, /no model key/, 'and says which job does not hold one');
});
