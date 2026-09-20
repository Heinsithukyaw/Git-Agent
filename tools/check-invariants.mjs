#!/usr/bin/env node
/**
 * The rules in AGENTS.md, runnable.
 *
 * Three modes, because the checks answer three different questions:
 *
 *   (no flag)   is the repository on disk consistent with the design?
 *   --dirty     did the run just touch anything outside the write allowlist?
 *   --allowlist does the writer actually refuse out-of-scope paths?
 *
 * The first is run in CI on every push. The second and third are run in the
 * digest's commit job, after the writes and before the commit — which is the
 * only moment at which a bounded write can still be caught rather than undone.
 *
 * This file is deliberately dumb: it reads, it compares, it exits non-zero.
 * Every decision about *what* an invariant means lives in lib/invariants.mjs,
 * so there is exactly one place to change a rule.
 */

import { execFileSync } from 'node:child_process';
import { runAll, checkDirtyPaths } from '../lib/invariants.mjs';
import { assertWritable, COLLECTOR_ALLOWLIST, CI_ALLOWLIST } from '../lib/store.mjs';

const args = process.argv.slice(2);
const help = args.includes('--help') || args.includes('-h');

function usage() {
  return [
    'usage: node tools/check-invariants.mjs [--dirty] [--allowlist] [--json]',
    '',
    '  (no flag)   run every invariant check over the repository on disk',
    '  --dirty     assert every path in `git status --porcelain` is inside the allowlist',
    '  --allowlist assert the writer refuses out-of-scope paths (fail-closed)',
    '  --json      machine-readable output',
  ].join('\n');
}

/* --------------------------------------------------------------- --dirty --- */

function porcelain() {
  try {
    return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
  } catch (err) {
    console.error(`::error::could not read git status: ${err.message}`);
    process.exit(1);
  }
}

function dirtyMode() {
  const result = checkDirtyPaths(porcelain(), CI_ALLOWLIST);
  const paths = porcelain()
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  return {
    ok: result.ok,
    mode: '--dirty',
    checked: paths.length,
    allowlist: CI_ALLOWLIST,
    violations: result.violations,
  };
}

/* ----------------------------------------------------------- --allowlist --- */

/**
 * Fail-closed, asserted rather than assumed.
 *
 * These paths are the ones that matter: a source file, a workflow, a traversal,
 * and an absolute path. If any of them were ever writable, a prompt injection
 * would have somewhere to land.
 */
const OUT_OF_SCOPE = [
  'src/index.ts',
  'lib/store.mjs',
  '.github/workflows/digest.yml',
  '../escape.json',
  'data/../../etc/passwd',
  '/tmp/absolute.json',
  '',
];

const IN_SCOPE = [
  'data/summary.json',
  'history/runs.jsonl',
  'digest/2026-01-01.md',
  'assets/badge.svg',
  'README.md',
  'site/index.html',
];

function allowlistMode() {
  const violations = [];

  for (const p of OUT_OF_SCOPE) {
    let refused = false;
    try {
      assertWritable(p, COLLECTOR_ALLOWLIST);
    } catch {
      refused = true;
    }
    if (!refused) violations.push({ path: p, rule: 'I3: out-of-scope path was accepted' });
  }

  for (const p of IN_SCOPE) {
    let accepted = true;
    try {
      assertWritable(p, CI_ALLOWLIST);
    } catch {
      accepted = false;
    }
    if (!accepted) violations.push({ path: p, rule: 'I3: in-scope path was refused' });
  }

  return {
    ok: violations.length === 0,
    mode: '--allowlist',
    checked: OUT_OF_SCOPE.length + IN_SCOPE.length,
    allowlist: CI_ALLOWLIST,
    violations,
  };
}

/* ---------------------------------------------------------------- output --- */

function report(result) {
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const { results } = result;
  const width = Math.max(...Object.keys(results).map((k) => k.length));
  let failed = 0;

  for (const [name, check] of Object.entries(results)) {
    const detail = check.skipped
      ? 'skipped — nothing to check yet'
      : check.ok
        ? summaryOf(check)
        : `${check.violations.length} violation(s)`;
    console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(width)}  ${detail}`);
    if (!check.ok) {
      failed++;
      for (const v of check.violations.slice(0, 10)) {
        console.log(`        · ${v.rule ?? v.error ?? JSON.stringify(v)}`);
        if (v.file) console.log(`          ${v.file}${v.job ? ` (job: ${v.job})` : ''}`);
      }
    }
  }

  console.log('');
  console.log(
    failed === 0
      ? `${Object.keys(results).length} invariant(s) hold`
      : `${failed} invariant(s) broken`,
  );
}

function summaryOf(check) {
  if (check.rows !== undefined) return `${check.rows} row(s), chain intact`;
  if (check.pins !== undefined) return `${check.pins.length} action(s) pinned to a commit`;
  if (check.allowed !== undefined) return `allowlist ${check.allowed.join(' / ')}`;
  if (check.checked !== undefined) return `${check.checked} cross-job file(s) carried by an upload`;
  if (check.documented !== undefined) {
    return `${check.documented.length} name(s) documented, ${check.read.length} read by code`;
  }
  return 'holds';
}

function reportSingle(result) {
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.ok) {
    console.log(`ok    ${result.mode} — ${result.checked} path(s) checked`);
  } else {
    console.log(`FAIL  ${result.mode}`);
    for (const v of result.violations) console.log(`        · ${v.rule ?? JSON.stringify(v)}`);
  }
}

/* ------------------------------------------------------------------ main --- */

function main() {
  if (help) {
    console.log(usage());
    return;
  }

  if (args.includes('--dirty')) {
    const r = dirtyMode();
    reportSingle(r);
    if (!r.ok) process.exit(1);
    return;
  }

  if (args.includes('--allowlist')) {
    const r = allowlistMode();
    reportSingle(r);
    if (!r.ok) process.exit(1);
    return;
  }

  const result = runAll(process.cwd());
  report(result);
  if (!result.ok) process.exit(1);
}

main();
