/**
 * The publication allowlist, as tests.
 *
 * `lib/publishable.mjs` is a security control, so the standard here is the one
 * AGENTS.md §5 states and `tests/pubsafe.test.mjs` applies: **a check that has
 * never been seen to fail is not a check**. Every refusal below has a paired case
 * that must *pass* when the defect is absent, because a validator that refuses
 * everything is indistinguishable from one that works — right up until it
 * publishes the whole watch list.
 *
 * The last two tests are the publish canary. It is the only test here that turns
 * an invisible disclosure into a red run: a sentinel `(name, ecosystem)` present
 * in `packages` and absent from every `public_*` is asserted absent from every
 * file under `site/` after a real render, with a positive control so that absence
 * means something — and a must-fail twin that renders the *unprojected* payload
 * and requires the sweep to find the sentinel.
 *
 * **What the canary does and does not prove.** It calls the shipped
 * `buildPublicSurface`, which is what `scripts/commit-step.mjs` calls, so a
 * defect in the assembly fails here rather than only in production. What it does
 * not exercise is the *call site*: it writes the two artifacts itself and then
 * runs `scripts/render-site.mjs`, so it never runs `commit-step`. The ordering of
 * the projection against the gate is therefore asserted statically — I2's second
 * clause — and not by this test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  POLICY_KEYS,
  canonicalName,
  readPolicy,
  validatePolicy,
  projectPublishable,
  projectDecisions,
  dropRecord,
} from '../lib/publishable.mjs';
import { renderDigest, renderSummary } from '../lib/render.mjs';
import {
  buildPublicSurface,
  publicDigestPath,
  projectCommands,
  PUBLIC_SUMMARY,
} from '../lib/public-surface.mjs';

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/render-site.mjs');
const SENTINEL = 'internal/payments-service';
const PRIVATE_UPSTREAM = 'acme-corp/platform';
const PRIVATE_FEED = 'https://internal.example/feed.xml';

/* ------------------------------------------------------------- fixtures --- */

/** A stack with one private package, one private upstream and one private feed. */
function stack(overrides = {}) {
  return {
    packages: [
      { name: 'express', ecosystem: 'npm', pinned: '4.18.2' },
      { name: 'requests', ecosystem: 'PyPI', pinned: '2.31.0' },
      { name: SENTINEL, ecosystem: 'Go', pinned: 'v0.4.1' },
    ],
    watch: {
      upstreams: ['nodejs/node', PRIVATE_UPSTREAM],
      feeds: ['https://github.blog/changelog/feed/', PRIVATE_FEED],
    },
    public_packages: ['express', 'requests'],
    public_upstreams: ['nodejs/node'],
    public_feeds: ['https://github.blog/changelog/feed/'],
    ...overrides,
  };
}

/** The payload shape `gather()` returns, with the private entities in it. */
function payload() {
  return {
    observed_at: '2026-09-21T06:12:00.000Z',
    packages: [
      { name: 'express', ecosystem: 'npm', pinned: '4.18.2', upstream: { latest: '4.20.0' }, fetched_at: 'x' },
      { name: 'requests', ecosystem: 'PyPI', pinned: '2.31.0', upstream: { latest: '2.32.0' }, fetched_at: 'x' },
      { name: SENTINEL, ecosystem: 'Go', pinned: 'v0.4.1', upstream: { latest: 'v0.5.0' }, fetched_at: 'x' },
    ],
    advisories: [
      { id: 'GHSA-aaaa-bbbb-cccc', package: 'express', ecosystem: 'npm', summary: 'a real one' },
      { id: 'GHSA-dddd-eeee-ffff', package: SENTINEL, ecosystem: 'Go', summary: 'a private one' },
    ],
    releases: [
      { kind: 'release', slug: 'nodejs/node', tag: 'v22.0.0', url: 'https://example.invalid/node' },
      { kind: 'release', slug: PRIVATE_UPSTREAM, tag: 'v1.0.0', url: 'https://example.invalid/private' },
    ],
    feeds: [
      { kind: 'feed', url: 'https://github.blog/changelog/feed/', items: [{ title: 'public item', link: 'x', published: 'y' }] },
      { kind: 'feed', url: PRIVATE_FEED, items: [{ title: 'private item', link: 'x', published: 'y' }] },
    ],
    errors: [
      { source: 'osv', error: 'the whole source did not answer' },
      { source: 'npm', name: 'express', error: 'HTTP 500' },
      { source: 'Go', name: SENTINEL, error: 'unsupported ecosystem' },
      { source: 'github', name: PRIVATE_UPSTREAM, error: 'HTTP 404' },
      { source: 'feed', name: PRIVATE_FEED, error: 'timeout' },
    ],
    watch: {
      upstreams: ['nodejs/node', PRIVATE_UPSTREAM],
      feeds: ['https://github.blog/changelog/feed/', PRIVATE_FEED],
    },
  };
}

/**
 * Decision rows — the *second* document the renderer reads.
 *
 * `renderDigest` renders a table whose Package column is `decision.package`, so a
 * projected payload with unprojected decisions still publishes a private name.
 * A fixture with no decisions would make the canary green over exactly that
 * defect, which is why one of these rows is for the sentinel.
 */
function decisions() {
  return [
    {
      observed_at: '2026-09-21T06:12:00.000Z',
      advisory_id: 'GHSA-aaaa-bbbb-cccc',
      package: 'express',
      ecosystem: 'npm',
      pinned: '4.18.2',
      upgrade: '4.20.0',
      decision: 'act',
      reason: 'affected, and we import express',
      layer: 'rules',
      severity: 5.3,
    },
    {
      observed_at: '2026-09-21T06:12:00.000Z',
      advisory_id: 'GHSA-dddd-eeee-ffff',
      package: SENTINEL,
      ecosystem: 'Go',
      pinned: 'v0.4.1',
      upgrade: 'v0.5.0',
      decision: 'act',
      reason: 'affected, and we import a private symbol',
      layer: 'rules',
      severity: 9.1,
    },
  ];
}

/**
 * Command rows as `history/commands.jsonl` holds them — login included.
 *
 * The third row is the one that matters. `validate()` only requires a `why` /
 * `bump` / `wrong` argument to be **watched** (`lib/commands.mjs:183-189`), and
 * watched is a superset of published, so this row is a legitimate command for a
 * package the instance watches and has not listed. Stripping the login left the
 * argument in, and the name rendered into the public digest. A fixture whose
 * only arguments were public would make the canary green over exactly that.
 */
function commands() {
  return [
    { comment_id: 1, author: 'octocat', verb: 'why', arg: 'express', started_at: 't', outcome: 'answered' },
    { comment_id: 2, author: 'someone-else', verb: 'pause', arg: null, started_at: 't', outcome: 'recorded' },
    { comment_id: 3, author: 'octocat', verb: 'why', arg: SENTINEL, started_at: 't', outcome: 'answered' },
  ];
}

/** The rows as the digest would render them if nothing filtered the argument. */
function rawCommandRows() {
  return commands().map(({ verb, arg, outcome }) => ({ verb, arg, outcome }));
}

/* -------------------------------------------------------------- reading --- */

test('POLICY_KEYS is exactly the three lists the digest can render a name from', () => {
  assert.deepEqual(POLICY_KEYS, ['public_packages', 'public_upstreams', 'public_feeds']);
});

test('readPolicy keeps a missing key undefined, so presence differs from an empty list', () => {
  // The whole validator rests on this: `[]` is a deliberate deny-all, a missing
  // key is a marker nobody wrote. A reader that defaulted to `[]` would accept
  // the second as the first.
  const policy = readPolicy({ public_packages: [], public_upstreams: ['nodejs/node'] });
  assert.deepEqual(policy.public_packages, []);
  assert.equal(policy.public_feeds, undefined);
});

/* ------------------------------------------------------------ validator --- */

test('a missing policy key is refused, and the refusal names the key', () => {
  const s = stack();
  delete s.public_feeds;
  const result = validatePolicy(s);
  assert.equal(result.ok, false);
  const v = result.violations.find((x) => x.list === 'public_feeds');
  assert.ok(v, 'the missing key must be named, or the fix is not obvious');
  assert.equal(v.error, 'missing');
  assert.match(v.rule, /present/);
});

test('the same stack with every key present is accepted — the check is not vacuous', () => {
  // The must-pass twin of the test above. Without it, a validator that always
  // refused would look identical.
  assert.equal(validatePolicy(stack()).ok, true, JSON.stringify(validatePolicy(stack()).violations));
});

test('an explicit empty list is a valid deny-all, not a violation', () => {
  const s = stack({ public_packages: [], public_upstreams: [], public_feeds: [] });
  const result = validatePolicy(s);
  assert.equal(result.ok, true, JSON.stringify(result.violations));

  const projected = projectPublishable(payload(), readPolicy(s));
  assert.deepEqual(projected.packages, []);
  assert.deepEqual(projected.releases, []);
  assert.deepEqual(projected.feeds, []);
  assert.equal(dropRecord(payload(), projected, readPolicy(s)).deny_all, true);
});

test('deny-all is distinguished from a missing key in the drop record', () => {
  const missing = stack();
  delete missing.public_feeds;
  const policy = readPolicy(missing);
  const projected = projectPublishable(payload(), policy);
  assert.equal(dropRecord(payload(), projected, policy).deny_all, false, 'a missing key is not a deny-all');
});

test('an entry that is not in the source set is refused, and the entry is named', () => {
  const result = validatePolicy(stack({ public_packages: ['express', 'lodahs'] }));
  assert.equal(result.ok, false);
  const v = result.violations.find((x) => x.entry === 'lodahs');
  assert.ok(v, 'the typo must be named');
  assert.equal(v.list, 'public_packages');
  assert.match(v.error, /not a member/);
});

test('an upstream that is not watched is refused, and the entry is named', () => {
  // The upstream-typo case. A *watched* upstream listed in `public_upstreams` is
  // a deliberate act — the allowlist is the permission, so the validator has
  // nothing to refuse it for. What it refuses is a name the watch list does not
  // contain: publishing an upstream that is not watched is not a narrower
  // publication, it is a different one, and the run would go green over it.
  const result = validatePolicy(
    stack({
      watch: { upstreams: ['nodejs/node'], feeds: ['https://github.blog/changelog/feed/'] },
      public_upstreams: ['nodejs/node', PRIVATE_UPSTREAM],
    }),
  );
  assert.equal(result.ok, false);
  const v = result.violations.find((x) => x.list === 'public_upstreams');
  assert.equal(v.entry, PRIVATE_UPSTREAM);
  assert.match(v.error, /watch\.upstreams/);
});

test('a feed that is not watched is refused, and the entry is named', () => {
  const result = validatePolicy(
    stack({
      watch: { upstreams: ['nodejs/node'], feeds: ['https://github.blog/changelog/feed/'] },
      public_feeds: ['https://github.blog/changelog/feed/', PRIVATE_FEED],
    }),
  );
  assert.equal(result.ok, false);
  const v = result.violations.find((x) => x.list === 'public_feeds');
  assert.equal(v.entry, PRIVATE_FEED);
  assert.match(v.error, /watch\.feeds/);
});

test('an entry matching two ecosystems is refused, and told to disambiguate', () => {
  const ambiguous = stack({
    packages: [
      { name: 'requests', ecosystem: 'PyPI', pinned: '2.31.0' },
      { name: 'requests', ecosystem: 'npm', pinned: '2.88.2' },
    ],
    public_packages: ['requests'],
  });
  const result = validatePolicy(ambiguous);
  assert.equal(result.ok, false);
  const v = result.violations.find((x) => x.list === 'public_packages');
  assert.match(v.error, /disambiguate/);

  // The must-pass twin: naming the ecosystem resolves it, which is what the
  // message tells the user to do.
  const fixed = validatePolicy({
    ...ambiguous,
    public_packages: [{ name: 'requests', ecosystem: 'PyPI' }],
  });
  assert.equal(fixed.ok, true, JSON.stringify(fixed.violations));
});

/* ------------------------------------------------- canonicalisation (N4) --- */

test('a PyPI case variant is the same package', () => {
  const s = stack({
    packages: [{ name: 'requests', ecosystem: 'PyPI', pinned: '2.31.0' }],
    public_packages: ['Requests'],
    public_upstreams: [],
    public_feeds: [],
  });
  assert.equal(validatePolicy(s).ok, true, JSON.stringify(validatePolicy(s).violations));

  const projected = projectPublishable(
    { observed_at: 'x', packages: [{ name: 'requests', ecosystem: 'PyPI' }], advisories: [], releases: [], feeds: [], errors: [] },
    readPolicy(s),
  );
  assert.equal(projected.packages.length, 1, '`Requests` and `requests` are one package to PyPI');

  // And the other direction, so the match is not an artefact of which side is
  // canonicalised.
  const reverse = validatePolicy({
    ...s,
    packages: [{ name: 'Requests', ecosystem: 'PyPI', pinned: '2.31.0' }],
    public_packages: ['requests'],
  });
  assert.equal(reverse.ok, true, JSON.stringify(reverse.violations));
});

test('canonicalisation is scoped to PyPI — an npm name is not folded', () => {
  // The must-fail twin. If `canonicalName` lowercased unconditionally, this
  // would pass and a marker could claim a package it does not name.
  assert.equal(canonicalName('Requests', 'npm'), 'Requests');
  const result = validatePolicy(
    stack({
      packages: [{ name: 'requests', ecosystem: 'npm', pinned: '2.88.2' }],
      public_packages: ['Requests'],
      public_upstreams: [],
      public_feeds: [],
    }),
  );
  assert.equal(result.ok, false, 'npm is case-sensitive; `Requests` is not `requests`');
});

/* ------------------------------------------------------------- projection --- */

test('a private (name, ecosystem) is absent from the projected payload', () => {
  const pl = payload();
  const projected = projectPublishable(pl, readPolicy(stack()));
  const names = projected.packages.map((p) => `${p.name}@${p.ecosystem}`);
  assert.deepEqual(names, ['express@npm', 'requests@PyPI']);
  assert.equal(projected.observed_at, pl.observed_at, 'the observation time is preserved (I11)');
});

test('the projection never mutates its input', () => {
  const pl = payload();
  const before = JSON.stringify(pl);
  projectPublishable(pl, readPolicy(stack()));
  assert.equal(JSON.stringify(pl), before);
});

test('the drop is caused by the policy, not by the record being absent', () => {
  // The must-fail direction for the projection: the sentinel is really in the
  // input, and listing it really does publish it. Without both halves, "absent
  // from the projection" would also be true of a filter that dropped everything.
  const pl = payload();
  assert.ok(pl.packages.some((p) => p.name === SENTINEL), 'the sentinel is in the input');
  const policy = readPolicy(stack());
  assert.ok(!projectPublishable(pl, policy).packages.some((p) => p.name === SENTINEL));

  const listed = projectPublishable(pl, {
    ...policy,
    public_packages: [...policy.public_packages, { name: SENTINEL, ecosystem: 'Go' }],
  });
  assert.ok(listed.packages.some((p) => p.name === SENTINEL), 'a listed package is published');
});

test('dropping a package drops the advisory, release and feed rows that refer to it', () => {
  const projected = projectPublishable(payload(), readPolicy(stack()));
  assert.ok(!projected.advisories.some((a) => a.package === SENTINEL), 'its advisory is dropped with it');
  assert.deepEqual(projected.releases.map((r) => r.slug), ['nodejs/node']);
  assert.deepEqual(projected.feeds.map((f) => f.url), ['https://github.blog/changelog/feed/']);
});

test('a decision row for a private package is dropped with the package', () => {
  // The route a payload-only projection misses. The decision set is a separate
  // document, and `renderDigest` renders `decision.package` in its table.
  assert.ok(decisions().some((d) => d.package === SENTINEL), 'the fixture has a private decision in it');
  const projected = projectDecisions(decisions(), readPolicy(stack()));
  assert.deepEqual(projected.map((d) => d.package), ['express']);
});

test('an error bound to no entity survives; one bound to a private entity does not', () => {
  const projected = projectPublishable(payload(), readPolicy(stack()));
  assert.deepEqual(
    projected.errors.map((e) => `${e.source}:${e.name ?? ''}`),
    ['osv:', 'npm:express'],
    'a whole-source failure is not entity-bound; a named failure is only kept when its entity is published',
  );
});

test('watch is absent from the projected payload', () => {
  // Nothing renders it, which is exactly why its survival would be invisible.
  const pl = payload();
  assert.ok('watch' in pl, 'the input carries the private watch list');
  const projected = projectPublishable(pl, readPolicy(stack()));
  assert.equal('watch' in projected, false);
});

/* ------------------------------------------------------------ drop record --- */

test('a projection that dropped nothing still produces a record', () => {
  const s = stack({
    packages: [{ name: 'express', ecosystem: 'npm', pinned: '4.18.2' }],
    watch: { upstreams: ['nodejs/node'], feeds: ['https://github.blog/changelog/feed/'] },
    public_packages: ['express'],
    public_upstreams: ['nodejs/node'],
    public_feeds: ['https://github.blog/changelog/feed/'],
  });
  const pl = {
    observed_at: 'x',
    packages: [{ name: 'express', ecosystem: 'npm' }],
    advisories: [],
    releases: [{ slug: 'nodejs/node' }],
    feeds: [{ url: 'https://github.blog/changelog/feed/' }],
    errors: [{ source: 'osv', error: 'down' }],
  };
  const projected = projectPublishable(pl, readPolicy(s));
  const record = dropRecord(pl, projected, readPolicy(s));
  assert.equal(record.dropped, 0);
  assert.deepEqual(record.kinds, []);
  assert.equal(record.deny_all, false);
  assert.ok(record.counts, 'a component that published nothing must still say so (I11)');
});

test('the drop record carries counts and kinds, never names', () => {
  const pl = payload();
  const s = stack();
  const projected = projectPublishable(pl, readPolicy(s));
  const record = dropRecord(pl, projected, readPolicy(s));
  const serialised = JSON.stringify(record);
  for (const name of [SENTINEL, PRIVATE_UPSTREAM, PRIVATE_FEED]) {
    assert.ok(
      !serialised.includes(name),
      `the record must not become a second copy of ${name} (lib/pubsafe.mjs:156-158)`,
    );
  }
  assert.deepEqual(record.kinds, ['packages', 'advisories', 'releases', 'feeds', 'errors']);
  assert.equal(record.counts.packages, 1);
  assert.deepEqual(record.withheld, ['watch'], 'the watch list was dropped; its size is not reported');
});

/* ---------------------------------------------------- the public surface --- */

const HEARTBEAT = { last_run_at: '2026-09-21T06:12:01.000Z', last_status: 'ok', consecutive_failures: 0 };

/** Write the two artifacts the commit job produces into a sandbox tree. */
function writeSurface(dir, { digest, summary }) {
  fs.mkdirSync(path.join(dir, 'digest'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, publicDigestPath(summary.observed_at)), digest, 'utf8');
  fs.writeFileSync(path.join(dir, PUBLIC_SUMMARY), JSON.stringify(summary, null, 2) + '\n', 'utf8');
}

function runSite(dir) {
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo' },
  });
}

test('an invalid marker withholds the public surface, and says which way it failed', () => {
  // A missing key is not a deny-all. If the page rendered "withheld: all" for a
  // typo it would be indistinguishable from a deliberate deny-all, and the
  // operator would get no signal that the marker was never read.
  const broken = stack();
  delete broken.public_feeds;
  const surface = buildPublicSurface({ payload: payload(), decisions: decisions(), stack: broken });

  assert.equal(surface.ok, false);
  assert.equal(surface.summary.packages, 0);
  assert.equal(surface.summary.withheld_reason, 'invalid-marker');
  assert.equal(surface.summary.drop.deny_all, false, 'a missing key is not a deny-all');
  assert.ok(surface.summary.invalid_marker >= 1, 'the count of violations travels');

  // The entries do not travel: a violation names a policy entry, and a mistyped
  // entry can be a private name.
  const published = JSON.stringify(surface.summary) + surface.digest;
  assert.ok(!published.includes('public_feeds'));
  for (const name of [SENTINEL, PRIVATE_UPSTREAM, PRIVATE_FEED]) {
    assert.ok(!published.includes(name), `${name} must not reach the public surface`);
  }
});

test('a valid deny-all publishes nothing, and is recorded as a deny-all', () => {
  const s = stack({ public_packages: [], public_upstreams: [], public_feeds: [] });
  const surface = buildPublicSurface({ payload: payload(), decisions: decisions(), stack: s });
  assert.equal(surface.ok, true);
  assert.equal(surface.summary.packages, 0);
  assert.equal(surface.summary.drop.deny_all, true);
  assert.equal(surface.summary.withheld_reason, undefined, 'a deny-all is not an invalid marker');
});

test('every published count is derived from the projected set, not the private one', () => {
  // FM-c. `packages: 3` on a page showing two rows states the size of what was
  // withheld, and the count is a fact about the private stack just as a name is.
  const surface = buildPublicSurface({ payload: payload(), decisions: decisions(), stack: stack() });
  assert.equal(surface.summary.packages, 2, 'three watched, two publishable');
  assert.equal(surface.summary.advisories, 1, 'two advisories, one for a publishable package');
});

test('the public summary carries the verb and a published argument, never the author or a private name', () => {
  // The rows carry a GitHub login and the summary is rendered onto a
  // world-readable page. `lib/render.mjs:390-394` states the rule: "a login
  // belongs to a person rather than to this repository." The argument is the
  // second entity-bearing field in the same row, and it is the one that was left
  // in — the row survives `validate()` because the package is watched.
  const rows = commands();
  assert.ok(JSON.stringify(rows).includes('octocat'), 'the fixture really carries a login');
  assert.ok(JSON.stringify(rows).includes(SENTINEL), 'and a watched-but-unpublished argument');

  const surface = buildPublicSurface({ payload: payload(), decisions: decisions(), stack: stack(), commands: rows });
  assert.deepEqual(
    surface.summary.commands,
    [
      { verb: 'why', arg: 'express', outcome: 'answered' },
      { verb: 'pause', arg: null, outcome: 'recorded' },
    ],
    'the published argument survives and the private one does not',
  );

  const published = JSON.stringify(surface.summary) + surface.digest;
  assert.ok(!published.includes('octocat'), 'the login must not reach the public surface');
  assert.ok(!published.includes('someone-else'));
  assert.ok(!published.includes('"author"'), 'and neither must the field itself');
  assert.ok(!containsToken(published, SENTINEL), 'nor the argument of a command about an unlisted package');
});

test('the command filter is not vacuous: an unfiltered row publishes the private argument', () => {
  // The must-fail twin. `projectCommands` is the only thing between a
  // watched-but-unpublished argument and the page: with the argument filter
  // removed, the name lands in the digest — which is what the canary sweep and
  // the assertion above would then find.
  const policy = readPolicy(stack());
  const digest = renderDigest({
    payload: projectPublishable(payload(), policy),
    decisions: projectDecisions(decisions(), policy),
    narration: null,
    narrationStatus: null,
    commands: rawCommandRows(),
  });
  assert.ok(containsToken(digest, SENTINEL), 'the unfiltered command list carries the private argument');
  assert.ok(containsToken(digest, 'express'), 'and the public argument, so the fixture is not empty');

  assert.deepEqual(
    projectCommands(commands(), policy).map((c) => c.arg),
    ['express', null],
    'and the filter is what removes the third',
  );
});

/* ------------------------------------------------------------- the canary --- */

/**
 * Every file under `site/`, as text.
 *
 * The sweep is over the written bytes, not over an in-memory object: the leak
 * that matters is what was written.
 */
function readSiteTree(dir) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(next);
      else files.push({ rel: next, text: fs.readFileSync(path.join(dir, next), 'utf8') });
    }
  };
  walk('site');
  return files;
}

/**
 * Delimited-token match, not substring: `express ⊃ press` and `lodash ⊃ dash`,
 * so a raw substring sweep would fail spuriously — and a check that fails when it
 * should not gets disabled. Package-name characters are `[A-Za-z0-9._/@-]`, so a
 * match must be flanked by a character outside that class.
 */
function containsToken(text, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9._/@-])${escaped}([^A-Za-z0-9._/@-]|$)`).test(text);
}

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-canary-'));
}

test('publish canary: the shipped assembly keeps a private package out of every file under site/', () => {
  // The shipped path, not a re-implementation of it: `buildPublicSurface` is
  // what `commit-step` calls, so a defect in the assembly fails here. A canary
  // that assembled the artifacts itself would test the canary.
  //
  // Three routes carry the sentinel in this fixture — the package list, the
  // decision table, and a command whose argument names it — so a single missing
  // filter turns the sweep red rather than one route going unnoticed.
  const surface = buildPublicSurface({
    payload: payload(),
    decisions: decisions(),
    stack: stack(),
    heartbeat: HEARTBEAT,
    commands: commands(),
  });
  assert.equal(surface.ok, true, JSON.stringify(surface.violations));

  const dir = mkdtemp();
  writeSurface(dir, surface);
  const result = runSite(dir);
  assert.equal(result.status, 0, result.stderr);

  const files = readSiteTree(dir);
  assert.ok(files.length > 0, 'the render produced no files, so the sweep proves nothing');
  for (const f of files) {
    assert.ok(!containsToken(f.text, SENTINEL), `${SENTINEL} leaked into ${f.rel}`);
    assert.ok(!containsToken(f.text, PRIVATE_UPSTREAM), `${PRIVATE_UPSTREAM} leaked into ${f.rel}`);
    assert.ok(!f.text.includes('octocat'), `the author login leaked into ${f.rel}`);
  }

  // The positive control. Without it, a sweep whose matcher had stopped working
  // would be green over a leak.
  assert.ok(
    files.some((f) => containsToken(f.text, 'express')),
    'the sweep must be able to find a public name, or absence means nothing',
  );
});

test('the canary is not vacuous: the unprojected documents leak the sentinel through the decisions route', () => {
  // The must-fail twin, and the one that would have caught the hole in the first
  // version of this canary: it passed `decisions: []`, so a projected payload
  // with unprojected decisions would have published a private package name in
  // the decision table while the sweep stayed green.
  const pl = payload();
  const policy = readPolicy(stack());
  const rawDigest = renderDigest({
    payload: pl,
    decisions: decisions(),
    narration: null,
    narrationStatus: null,
    commands: projectCommands(commands(), policy),
  });
  assert.ok(
    containsToken(rawDigest, SENTINEL),
    'the unprojected digest carries the private package through its decision table',
  );

  const dir = mkdtemp();
  writeSurface(dir, {
    digest: rawDigest,
    summary: {
      ...renderSummary({ payload: pl, decisions: decisions(), heartbeat: null }),
      heartbeat: null,
      commands: projectCommands(commands(), policy),
    },
  });
  const result = runSite(dir);
  assert.equal(result.status, 0, result.stderr);

  const files = readSiteTree(dir);
  assert.ok(
    files.some((f) => containsToken(f.text, SENTINEL)),
    'the sweep must find the sentinel when the projection is skipped',
  );
});

test('the canary mirror: render-site emits the projected summary and ignores the private one', () => {
  // The other half of the boundary. The renderer has no payload to project
  // against, so its safety is entirely "which files does it read" — and that is
  // asserted statically by I16. This is the behavioural counterpart: a private
  // summary sitting beside the public one must not reach the page.
  const surface = buildPublicSurface({
    payload: payload(),
    decisions: decisions(),
    stack: stack(),
    heartbeat: HEARTBEAT,
  });
  const dir = mkdtemp();
  writeSurface(dir, surface);
  fs.writeFileSync(
    path.join(dir, 'data/summary.json'),
    JSON.stringify({ packages: 99, private_sentinel: SENTINEL }, null, 2) + '\n',
    'utf8',
  );

  const result = runSite(dir);
  assert.equal(result.status, 0, result.stderr);

  const files = readSiteTree(dir);
  for (const f of files) {
    assert.ok(!containsToken(f.text, SENTINEL), `the private summary leaked into ${f.rel}`);
  }
  const published = JSON.parse(fs.readFileSync(path.join(dir, 'site/data/summary.json'), 'utf8'));
  assert.equal(published.packages, 2, 'the page got the projected count, not the private one');
});

test('the shipped data/stack.json carries a valid marker that names the seed stack', () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stack.json'), 'utf8'));
  const result = validatePolicy(shipped);
  assert.equal(result.ok, true, JSON.stringify(result.violations));

  const policy = readPolicy(shipped);
  assert.deepEqual(policy.public_packages, shipped.packages.map((p) => p.name));
  assert.deepEqual(policy.public_upstreams, shipped.watch.upstreams);
  assert.deepEqual(policy.public_feeds, shipped.watch.feeds);
});
