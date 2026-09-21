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
 * **What the canary does not prove.** `scripts/render-site.mjs` does not call
 * `projectPublishable()` yet — wiring the projection into the site job is a
 * separate slice. So the canary proves the projection's *output* is clean when it
 * is what gets rendered, and that the sweep can detect the leak it guards
 * against. It does not prove the shipped site job applies the projection. That
 * claim needs the wiring, and it is not made here.
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
  dropRecord,
} from '../lib/publishable.mjs';
import { renderDigest, renderSummary } from '../lib/render.mjs';

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

/** Render `site/` from the payloads given, exactly as the site job would. */
function render(dir, { digestPayload, summaryPayload }) {
  fs.mkdirSync(path.join(dir, 'digest'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'data/summary.json'),
    JSON.stringify(renderSummary({ payload: summaryPayload, decisions: [], heartbeat: null }), null, 2) + '\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'digest/2026-09-21.md'),
    renderDigest({ payload: digestPayload, decisions: [] }),
    'utf8',
  );
  return spawnSync(process.execPath, [SCRIPT], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REPOSITORY: 'owner/repo' },
  });
}

test('publish canary: a private package never reaches any file under site/', () => {
  const s = stack();
  const pl = payload();
  const projected = projectPublishable(pl, readPolicy(s));

  const dir = mkdtemp();
  const result = render(dir, { digestPayload: projected, summaryPayload: projected });
  assert.equal(result.status, 0, result.stderr);

  const files = readSiteTree(dir);
  assert.ok(files.length > 0, 'the render produced no files, so the sweep proves nothing');
  for (const f of files) {
    assert.ok(!containsToken(f.text, SENTINEL), `${SENTINEL} leaked into ${f.rel}`);
    assert.ok(!containsToken(f.text, PRIVATE_UPSTREAM), `${PRIVATE_UPSTREAM} leaked into ${f.rel}`);
  }

  // The positive control. Without it, a sweep whose matcher had stopped working
  // would be green over a leak.
  assert.ok(
    files.some((f) => containsToken(f.text, 'express')),
    'the sweep must be able to find a public name, or absence means nothing',
  );
});

test('the canary is not vacuous: rendering the unprojected payload leaks the sentinel', () => {
  // The must-fail twin. This is what makes the canary a check rather than a
  // decoration: it demonstrates that the sweep detects the exact leak it exists
  // to catch, when the projection is not applied.
  const pl = payload();
  const dir = mkdtemp();
  const result = render(dir, { digestPayload: pl, summaryPayload: pl });
  assert.equal(result.status, 0, result.stderr);

  const files = readSiteTree(dir);
  assert.ok(
    files.some((f) => containsToken(f.text, SENTINEL)),
    'the sweep must find the sentinel when the projection is skipped',
  );
});

/* ------------------------------------------------------------- the repo --- */

test('the published summary carries the verb and the argument, never the author login', () => {
  // `scripts/render-site.mjs` writes `history/commands.jsonl` rows into a
  // world-readable Pages artifact. The rows carry a GitHub login, and
  // `lib/render.mjs:390-394` states the rule they break: "a login belongs to a
  // person rather than to this repository." The login stays in
  // `history/commands.jsonl`; it must not survive into `site/`.
  const dir = mkdtemp();
  fs.mkdirSync(path.join(dir, 'history'), { recursive: true });
  const rows = [
    { comment_id: 1, author: 'octocat', verb: 'why', arg: 'lodash', started_at: 't', outcome: 'answered' },
    { comment_id: 2, author: 'someone-else', verb: 'pause', arg: null, started_at: 't', outcome: 'recorded' },
  ];
  const raw = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'history/commands.jsonl'), raw, 'utf8');
  assert.ok(raw.includes('octocat'), 'the fixture really carries a login, or its absence proves nothing');

  const projected = projectPublishable(payload(), readPolicy(stack()));
  const result = render(dir, { digestPayload: projected, summaryPayload: projected });
  assert.equal(result.status, 0, result.stderr);

  const summary = JSON.parse(fs.readFileSync(path.join(dir, 'site/data/summary.json'), 'utf8'));
  assert.deepEqual(summary.commands, [
    { verb: 'why', arg: 'lodash', outcome: 'answered' },
    { verb: 'pause', arg: null, outcome: 'recorded' },
  ]);
  const serialised = JSON.stringify(summary);
  assert.ok(!serialised.includes('octocat'), 'the login must not reach the published summary');
  assert.ok(!serialised.includes('someone-else'));
  assert.ok(!serialised.includes('"author"'), 'and neither must the field itself');
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
