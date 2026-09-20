/**
 * What must be true before this repository is published.
 *
 * AGENTS.md §2.1 states the rule this module exists for:
 *
 *   > **The seed stack is a demo, not a placeholder.** This repository runs the
 *   > real pipeline against `data/stack.json` on a schedule and publishes the
 *   > result. … Keep it that way: a seed entry that is *specific to one
 *   > organisation* does not belong here, because the demo digest is public.
 *
 * That paragraph used to end with *"Not enforced by anything — that is a
 * judgement, and it is the one rule in this document that is a preference."*
 * A preference is a rule that erodes, and this one erodes in the worst possible
 * direction: the watch list is both the list of packages watched **and** the
 * command argument allowlist, so an entry naming a private repository publishes
 * an organisation's dependency posture, permanently, in a repository that also
 * has forks.
 *
 * **Why this is not an invariant in `lib/invariants.mjs`.** Those run on every
 * push, in every repository created from this template. Asserting "the stack
 * equals the seed" there would fail a user's CI the moment they watch their own
 * packages — which is the first thing the template asks them to do. The seed rule
 * is a rule about *this* repository, so it is checked by a tool a maintainer runs
 * before publishing, not by a check that fires on a user's instance.
 *
 * The rest of the module covers the same question from the other side: the
 * conditions under which publishing is safe at all.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * The demo's watch list, recorded so a change to it is a deliberate, reviewable
 * diff rather than a silent drift. Adding a package here means editing this list
 * in the same commit, which is the point.
 */
export const SEED = {
  packages: ['express', 'lodash', 'react', 'requests', 'serde', 'github.com/gin-gonic/gin'],
  upstreams: ['nodejs/node'],
  feeds: ['https://github.blog/changelog/feed/'],
};

/**
 * Credential shapes, deliberately the same vocabulary `ci.yml` uses.
 *
 * The two regexes below are literals, so they cannot match themselves: after
 * `sk-` this pattern needs twenty alphanumerics and the literal supplies a `[`.
 * The same property is what makes the `sk-test-not-a-real-key` fixture safe.
 */
export const CREDENTIAL_RE =
  /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16})/;

const SEED_RULE = '§2.1: the published demo watches the seed list only';

/**
 * The seed stack is unchanged.
 *
 * Compared as sets, so reordering is not a violation and a substitution is.
 */
export function checkSeedStack(root = process.cwd()) {
  const rel = 'data/stack.json';
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { ok: false, violations: [{ file: rel, error: 'missing' }] };

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    return { ok: false, violations: [{ file: rel, error: `unparseable: ${err.message}` }] };
  }

  const got = {
    packages: (doc.packages ?? []).map((p) => p.name),
    upstreams: doc.watch?.upstreams ?? [],
    feeds: doc.watch?.feeds ?? [],
  };

  const violations = [];
  for (const kind of ['packages', 'upstreams', 'feeds']) {
    const want = SEED[kind];
    const added = got[kind].filter((x) => !want.includes(x));
    const removed = want.filter((x) => !got[kind].includes(x));
    if (added.length || removed.length) {
      violations.push({
        file: rel,
        kind,
        added,
        removed,
        rule: `${SEED_RULE} — a name that is specific to one organisation does not belong in a public digest`,
      });
    }
  }
  return { ok: violations.length === 0, violations, watched: got.packages.length };
}

/**
 * The committed endpoint record names no infrastructure.
 *
 * `data/endpoint.json` is written by the probe and committed, so on a public
 * repository the host and model a user configured become world-readable. The
 * design's position is that the endpoint is the user's own business (I8) — a
 * committed host contradicts it.
 */
export function checkNoEndpointDisclosure(root = process.cwd()) {
  const rel = 'data/endpoint.json';
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return { ok: true, absent: true };

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (err) {
    return { ok: false, violations: [{ file: rel, error: `unparseable: ${err.message}` }] };
  }

  const violations = [];
  for (const field of ['host', 'model']) {
    if (doc[field]) {
      violations.push({
        file: rel,
        field,
        rule: `§2.1: the committed endpoint record publishes the ${field} the user configured`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** A tracked path under `.run/` is runtime scratch that was committed by mistake. */
export function checkNoRunDirTracked(tracked = []) {
  const bad = tracked.filter((p) => p === '.run' || p.startsWith('.run/'));
  return {
    ok: bad.length === 0,
    violations: bad.map((p) => ({ path: p, rule: '§2.1: runtime scratch must not be published' })),
  };
}

/**
 * Scan text for a credential shape.
 *
 * Pure, and takes the label rather than a path, because the caller scans two
 * different things: files in the working tree, and every blob in history. The
 * history half is the one a private repository cannot delegate to the platform —
 * GitHub's secret scanning is free on public repositories only, so a secret
 * committed and then removed is invisible to every other check here.
 */
export function scanForCredentials(text, label) {
  const violations = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(CREDENTIAL_RE);
    if (m) {
      violations.push({
        file: label,
        line: i + 1,
        // The match is truncated: a finding must not become a second copy of
        // the thing it is reporting.
        token: `${m[0].slice(0, 6)}…`,
        rule: '§2.1: a credential-shaped string must not be published',
      });
    }
  });
  return { ok: violations.length === 0, violations };
}

/**
 * Scan `git grep` output that already carries its own location.
 *
 * `git grep -n <pattern> <rev>…` emits `<rev>:<path>:<line>:<text>`, so the
 * commit and the path are known before this is called. Passing that through
 * `scanForCredentials` would report the *output* line number instead — which
 * tells a maintainer that a credential was committed somewhere, and nothing
 * about which commit to rewrite. A finding you cannot locate is a finding you
 * cannot act on, and this is the one check whose remedy is history rewriting.
 *
 * The match is still truncated, because a finding must not become a second copy
 * of the thing it is reporting.
 *
 * Two limits, both deliberate and both narrow: the revision must be the
 * lowercase hex `git rev-list --all` produces, and only the line's *text* is
 * scanned — a credential inside a path is not a finding. A path that itself
 * contains a `:<digits>:` sequence splits at the first one, which misattributes
 * the location rather than losing it, and a location is still reported.
 */
export function scanHistory(text) {
  const violations = [];
  for (const line of text.split('\n')) {
    // `git grep` prints the file's own line ending, so a CRLF file yields a
    // trailing `\r`. `.` never matches `\r` and `$` is not multiline here, so
    // without this every match in a CRLF file is silently dropped — a safety
    // check failing open on Windows line endings.
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!raw) continue;
    const loc = raw.match(/^([0-9a-f]{7,40}):(.+?):(\d+):(.*)$/);
    if (!loc) continue;
    const hit = loc[4].match(CREDENTIAL_RE);
    if (!hit) continue;
    violations.push({
      file: loc[2],
      commit: loc[1].slice(0, 12),
      line: Number(loc[3]),
      token: `${hit[0].slice(0, 6)}…`,
      rule: '§2.1: a credential-shaped string must not be published',
    });
  }
  return { ok: violations.length === 0, violations };
}

/** Run every check. */
export function audit(root = process.cwd(), { tracked = [], treeText = '', historyText = '' } = {}) {
  const results = {
    'seed stack': checkSeedStack(root),
    'endpoint disclosure': checkNoEndpointDisclosure(root),
    'no scratch tracked': checkNoRunDirTracked(tracked),
    'no credential in the tree': scanForCredentials(treeText, 'tree'),
    'no credential in history': scanHistory(historyText),
  };
  return { ok: Object.values(results).every((r) => r.ok), results };
}
