/**
 * Every shipped module parses.
 *
 * This is the cheapest check in the suite and it exists because of one specific
 * defect, nine times over: `scripts/render-site.mjs` builds both pages inside a
 * single template literal — stylesheet included — so a backtick *anywhere*
 * inside it, even in a CSS comment, closes the string. The file then fails to
 * parse, and the error names the word after the backtick rather than the
 * comment that caused it:
 *
 *     SyntaxError: Unexpected identifier 'body'
 *
 * That cost nine round trips across two sessions, and nothing here caught it.
 * The gap is measurable rather than theoretical: **three of the eleven scripts
 * are not referenced by any test** — `act-step.mjs`, `pr-step.mjs` and
 * `probe-step.mjs` — so a syntax error in any of them passes `npm test` in
 * full. The others are only caught because some test happens to spawn them, and
 * then the failure surfaces as a confusing failure *of that test* rather than
 * as "this file does not parse".
 *
 * `node --check` is the right primitive: it parses without executing, so a
 * script that reads a key or writes to a repository is safe to check. It is
 * also exactly the command that would have caught all nine occurrences.
 *
 * The self-test at the end is not decoration. `spawnSync` with the wrong
 * arguments, or a `--check` that silently stopped reporting, would make every
 * assertion below pass while checking nothing — and a check that cannot fail is
 * worse than no check, because it is trusted. So the mechanism is proved on a
 * file that must be rejected, in the same shape as the real defect.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.cwd();

/** The shipped Node code — everything a job or the CI check actually runs. */
const ROOTS = ['scripts', 'lib', 'tools'];

function modulesUnder(rel) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith('.mjs')) out.push(next);
    }
  };
  walk(rel);
  return out;
}

/** Parse a file without running it. Returns the child's result. */
const check = (abs) => spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });

test('every shipped module parses — a stray backtick in the page template is a syntax error', () => {
  const modules = ROOTS.flatMap(modulesUnder);

  // A broken walk would make the loop below assert nothing at all, and pass.
  assert.ok(modules.length >= 20, `expected the shipped modules, found ${modules.length}`);
  for (const required of ['scripts/render-site.mjs', 'lib/store.mjs', 'tools/check-invariants.mjs']) {
    assert.ok(modules.includes(required), `${required} was not walked`);
  }

  const broken = [];
  for (const rel of modules) {
    const result = check(path.join(REPO, rel));
    if (result.status !== 0) {
      broken.push(`${rel}\n${(result.stderr || result.stdout || '').trim()}`);
    }
  }
  assert.deepEqual(broken, [], `module(s) do not parse:\n\n${broken.join('\n\n')}`);
});

test('the syntax check can fail — the mechanism is proved, not assumed', (t) => {
  // The real defect, in miniature: a backtick inside a CSS comment inside the
  // template literal that builds the page. Written out rather than described,
  // so this test fails if `--check` ever stops rejecting it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-syntax-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'page.mjs');
  fs.writeFileSync(
    bad,
    [
      'function page() {',
      '  return `<!doctype html>',
      '<style>',
      '  /* do not write `color-scheme: dark` in here */',
      '  :root { color-scheme: dark; }',
      '</style>`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = check(bad);
  assert.notEqual(result.status, 0, 'a stray backtick in the page template must not parse');
  assert.match(result.stderr, /SyntaxError/, 'and it must be reported as a syntax error');

  // The twin, so the assertion above is not satisfied by `--check` failing on
  // everything: the same file with the backticks replaced parses.
  const good = path.join(dir, 'page-ok.mjs');
  fs.writeFileSync(
    good,
    fs.readFileSync(bad, 'utf8').replace(/`color-scheme: dark`/, '"color-scheme: dark"'),
    'utf8',
  );
  assert.equal(check(good).status, 0, 'the same file with quotes must parse');
});
