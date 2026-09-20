#!/usr/bin/env node
/**
 * The pre-publication audit — run this before this repository is published.
 *
 * `tools/check-invariants.mjs` answers "is the repository consistent with the
 * design?". This answers a different question: **"is it safe to make this
 * public?"** The two are not the same, and the difference is the reason this file
 * exists rather than another invariant:
 *
 *   - Invariants run on every push, in every repository created from this
 *     template. The seed rule cannot live there — it would fail a user's CI the
 *     moment they watch their own packages, which is the first thing the template
 *     asks them to do.
 *   - Publishing is a one-way door. Forks and archives survive a revert, so
 *     "publish, then check" is not an available ordering. This runs first.
 *
 * The history half is the part nothing else covers. `ci.yml`'s
 * `no-secrets-in-tree` scans the working tree, and GitHub's secret scanning is
 * free on public repositories only — so a secret committed and later removed is
 * invisible to every other check in this repository.
 *
 * Usage: node tools/check-public-safety.mjs [--json]
 */

import { execFileSync } from 'node:child_process';
import { audit, CREDENTIAL_RE } from '../lib/pubsafe.mjs';

const args = process.argv.slice(2);

function usage() {
  return [
    'usage: node tools/check-public-safety.mjs [--json]',
    '',
    '  (no flag)  audit the repository for anything that must not be published',
    '  --json     machine-readable output',
    '',
    'Exit 0 means safe to publish. Any other exit means do not.',
  ].join('\n');
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(usage());
  process.exit(0);
}

/**
 * `git grep` exits 1 when nothing matched, which is the clean case and not an
 * error. Anything else is a real failure and must not read as "clean".
 */
function grep(argv) {
  try {
    return execFileSync('git', argv, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  } catch (err) {
    if (err.status === 1) return '';
    throw new Error(`git ${argv[0]} failed: ${err.message}`);
  }
}

function trackedPaths() {
  return grep(['ls-files'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Every revision, so a secret that was removed is still found. */
function historyText() {
  const revs = grep(['rev-list', '--all'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!revs.length) return '';
  return grep(['grep', '-nIE', CREDENTIAL_RE.source, ...revs]);
}

function main() {
  let tracked = [];
  let treeText = '';
  let historyText_ = '';
  let gitNote = null;

  try {
    tracked = trackedPaths();
    // `--untracked` so the audit covers work that is staged for the very commit
    // that would publish it. Ignored paths (`.run/`, `.workbuddy-ai/`) stay out
    // of scope, which is what keeps this from scanning a session log.
    treeText = grep(['grep', '--untracked', '-nIE', CREDENTIAL_RE.source]);
    historyText_ = historyText();
  } catch (err) {
    gitNote = `git checks skipped: ${err.message}`;
  }

  const result = audit(process.cwd(), { tracked, treeText, historyText: historyText_ });

  if (gitNote) {
    // Fail closed. "I could not read the repository" and "I read it and found
    // nothing" must never print the same word — this tool certifies a one-way
    // door, and a certification it cannot substantiate is worse than none. A
    // missing or broken git used to yield `safe to publish`, exit 0.
    result.results['git readable'] = {
      ok: false,
      violations: [
        {
          rule: '§2.1: the repository could not be read, so nothing below was actually checked',
          error: gitNote,
        },
      ],
    };
    result.ok = false;
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify({ ...result, gitNote }, null, 2));
  } else {
    const width = Math.max(...Object.keys(result.results).map((k) => k.length));
    for (const [name, check] of Object.entries(result.results)) {
      const detail = check.ok
        ? check.absent
          ? 'absent'
          : check.watched !== undefined
            ? `${check.watched} seed package(s)`
            : 'clean'
        : `${check.violations.length} finding(s)`;
      console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(width)}  ${detail}`);
      for (const v of check.violations ?? []) {
        console.log(`        · ${v.rule ?? v.error ?? JSON.stringify(v)}`);
        if (v.rule && v.error) console.log(`          ${v.error}`);
        if (v.file) console.log(`          ${v.file}${v.line ? `:${v.line}` : ''}`);
        // Only the history scan knows this, and it is the whole remedy: the
        // commit is what has to be rewritten.
        if (v.commit) console.log(`          commit ${v.commit}`);
        if (v.added?.length) console.log(`          added: ${v.added.join(', ')}`);
        if (v.removed?.length) console.log(`          removed: ${v.removed.join(', ')}`);
      }
    }
    console.log('');
    console.log(result.ok ? 'safe to publish' : 'NOT safe to publish');
  }

  if (!result.ok) process.exit(1);
}

main();
