/**
 * The invariants, as tests.
 *
 * `tools/check-invariants.mjs` runs these over the repository on disk in CI.
 * This file runs the same checks two ways:
 *
 *   - against the **real repository**, so a broken invariant fails a test rather
 *     than only a workflow;
 *   - against **synthetic trees**, so the checks are proven to fire. A check that
 *     has never been seen to fail is a check nobody can trust.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseYaml,
  checkOnePrivilegePerJob,
  checkSandboxIsolated,
  checkNoVendorNames,
  checkGatePlacement,
  checkDirtyPaths,
  checkHeartbeatExempt,
  checkHashChain,
  checkPagesHoldNoKey,
  checkActionsPinned,
  checkAuthorGateMirrorsScript,
  runAll,
} from '../lib/invariants.mjs';
import { CI_ALLOWLIST } from '../lib/store.mjs';

const ROOT = process.cwd();

function syntheticRoot(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-inv-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

/* ----------------------------------------------------------- YAML subset --- */

test('the reader handles the subset this repository writes', () => {
  const doc = parseYaml(
    [
      'name: digest',
      'on:',
      '  schedule:',
      "    - cron: '17 6 * * *'",
      '  workflow_dispatch:',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  commit:',
      '    permissions:',
      '      contents: write',
      '    steps:',
      '      - name: Run',
      '        run: |',
      '          set -euo pipefail',
      '          node tools/check-invariants.mjs --dirty',
      '        env:',
      '          X: ${{ secrets.TOKEN }}',
    ].join('\n'),
  );
  assert.equal(doc.name, 'digest');
  assert.equal(doc.permissions.contents, 'read');
  assert.equal(doc.jobs.commit.permissions.contents, 'write');
  assert.equal(doc.jobs.commit.steps.length, 1);
  assert.equal(doc.jobs.commit.steps[0].name, 'Run');
  assert.match(doc.jobs.commit.steps[0].run, /--dirty/);
  assert.match(doc.jobs.commit.steps[0].env.X, /secrets\.TOKEN/);
});

test('an empty inline mapping is read as empty, not as a string', () => {
  const doc = parseYaml('permissions: {}\n');
  assert.deepEqual(doc.permissions, {});
});

/* ------------------------------------------------------- I1 privilege --- */

test('a job holding a secret and a write token is a violation', () => {
  const root = syntheticRoot({
    '.github/workflows/bad.yml': [
      'name: bad',
      'jobs:',
      '  merged:',
      '    permissions:',
      '      contents: write',
      '    steps:',
      '      - run: echo ${{ secrets.LLM_API_KEY }}',
    ].join('\n'),
  });
  const result = checkOnePrivilegePerJob(root);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].job, 'merged');
  assert.match(result.violations[0].rule, /I1/);
});

test('a job holding only a secret, or only a write token, is fine', () => {
  const root = syntheticRoot({
    '.github/workflows/good.yml': [
      'name: good',
      'jobs:',
      '  reads:',
      '    permissions:',
      '      contents: read',
      '    steps:',
      '      - run: echo ${{ secrets.LLM_API_KEY }}',
      '  writes:',
      '    permissions:',
      '      contents: write',
      '    steps:',
      '      - run: git push',
    ].join('\n'),
  });
  assert.equal(checkOnePrivilegePerJob(root).ok, true);
});

test('inheriting write-all at the workflow level is a violation, not a loophole', () => {
  const root = syntheticRoot({
    '.github/workflows/inherit.yml': [
      'name: inherit',
      'permissions: write-all',
      'jobs:',
      '  leaky:',
      '    steps:',
      '      - run: echo ${{ secrets.LLM_API_KEY }}',
    ].join('\n'),
  });
  assert.equal(checkOnePrivilegePerJob(root).ok, false);
});

test('an unparseable workflow is a violation rather than a silent pass', () => {
  const root = syntheticRoot({ '.github/workflows/broken.yml': 'name: broken\nthis line has no colon\n' });
  const result = checkOnePrivilegePerJob(root);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].error, /unparseable/);
});

test('a jobs block that is not a mapping is a violation, not an empty check', () => {
  const root = syntheticRoot({ '.github/workflows/sequence.yml': 'name: sequence\njobs:\n  - not a job\n' });
  const result = checkOnePrivilegePerJob(root);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].error, /jobs is not a mapping/);
});

test('the platform token does not count as a secret, but a PAT does', () => {
  const platform = syntheticRoot({
    '.github/workflows/platform.yml': [
      'name: platform',
      'jobs:',
      '  push:',
      '    permissions:',
      '      contents: write',
      '    steps:',
      '      - run: git push',
      '        env:',
      '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    ].join('\n'),
  });
  assert.equal(
    checkOnePrivilegePerJob(platform).ok,
    true,
    'GITHUB_TOKEN is scoped to the job permissions, so it is not the second privilege',
  );

  const pat = syntheticRoot({
    '.github/workflows/pat.yml': [
      'name: pat',
      'jobs:',
      '  push:',
      '    permissions:',
      '      contents: write',
      '    steps:',
      '      - run: git push',
      '        env:',
      '          GITHUB_TOKEN: ${{ secrets.GH_TOKEN }}',
    ].join('\n'),
  });
  assert.equal(checkOnePrivilegePerJob(pat).ok, false);
});

/* --------------------------------------------------------- I8 vendor --- */

test('a provider name in executable code is a violation', () => {
  const root = syntheticRoot({ 'lib/client.mjs': "const url = 'https://api.openai.com/v1';\n" });
  const result = checkNoVendorNames(root);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].rule, /I8/);
});

test('a provider name in a comment is documentation, not an opinion', () => {
  const root = syntheticRoot({
    'lib/client.mjs': '// The request shape is the one the market calls OpenAI-compatible.\nexport const x = 1;\n',
  });
  assert.equal(checkNoVendorNames(root).ok, true);
});

test('the vocabulary list itself is exempt, but the rest of the file is not', () => {
  const root = syntheticRoot({
    'lib/invariants.mjs': "const VENDOR_PATTERNS = [/\\bopenai\\b/i];\nconst surprise = 'gpt-4';\n",
  });
  const result = checkNoVendorNames(root);
  assert.equal(result.ok, false, 'a provider name outside the vocabulary block must still be caught');
  assert.equal(result.violations[0].token, 'gpt-4');
});

/* ------------------------------------------------------- I2 placement --- */

test('only the keyless commit and reply steps may reach the gate', () => {
  const root = syntheticRoot({
    'scripts/commit-step.mjs': "import { assertGrounded } from '../lib/gate.mjs';\n",
    'scripts/narrate-step.mjs': "import { check } from '../lib/gate.mjs';\n",
  });
  const result = checkGatePlacement(root);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].file, 'scripts/narrate-step.mjs');
});

/* ---------------------------------------------------------- I3 writes --- */

test('every dirty path inside the allowlist is accepted', () => {
  const porcelain = [
    ' M data/summary.json',
    '?? digest/2026-01-01.md',
    ' M README.md',
    ' M site/index.html',
  ].join('\n');
  assert.equal(checkDirtyPaths(porcelain, CI_ALLOWLIST).ok, true);
});

test('a dirty path outside the allowlist is refused, and the path is named', () => {
  const result = checkDirtyPaths(' M lib/store.mjs\n M data/summary.json', CI_ALLOWLIST);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].path, 'lib/store.mjs');
});

test('an empty diff is fine', () => {
  assert.equal(checkDirtyPaths('', CI_ALLOWLIST).ok, true);
  assert.equal(checkDirtyPaths('\n\n', CI_ALLOWLIST).ok, true);
});

/* -------------------------------------------------------- I4 heartbeat --- */

test('exactly one file is outside the change gate', () => {
  assert.equal(checkHeartbeatExempt(ROOT).ok, true);
});

/* ------------------------------------------------------ I12 action pins --- */

const SHA = '11d5960a326750d5838078e36cf38b85af677262';

test('an action referenced by tag is a violation, and the ref is named', () => {
  const root = syntheticRoot({
    '.github/workflows/float.yml': [
      'name: float',
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@v4',
    ].join('\n'),
  });
  const result = checkActionsPinned(root);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].ref, 'actions/checkout@v4');
  assert.match(result.violations[0].rule, /I12/);
});

test('a branch ref is a violation too — main is as mutable as v4', () => {
  const root = syntheticRoot({
    '.github/workflows/branch.yml': 'name: b\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@main\n',
  });
  assert.equal(checkActionsPinned(root).ok, false);
});

test('a short SHA is not a pin', () => {
  const root = syntheticRoot({
    '.github/workflows/short.yml': 'name: s\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@11d5960\n',
  });
  assert.equal(checkActionsPinned(root).ok, false, 'a prefix can still be ambiguous; require all 40 hex');
});

test('a commit pin is accepted, and the pin is reported', () => {
  const root = syntheticRoot({
    '.github/workflows/pinned.yml': `name: p\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@${SHA} # v4.4.0\n`,
  });
  const result = checkActionsPinned(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pins, [`actions/checkout@${SHA}`]);
});

test('a local reusable workflow is this repository, not a third party', () => {
  const root = syntheticRoot({
    '.github/workflows/caller.yml': 'name: c\njobs:\n  a:\n    uses: ./.github/workflows/sandbox.yml\n',
  });
  const result = checkActionsPinned(root);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pins, [], 'a local workflow is not a pin and should not be counted as one');
});

test('a container action must be pinned by digest', () => {
  const byTag = syntheticRoot({
    '.github/workflows/docker.yml': 'name: d\njobs:\n  a:\n    steps:\n      - uses: docker://alpine:3.20\n',
  });
  assert.equal(checkActionsPinned(byTag).ok, false);

  const digest = 'a'.repeat(64);
  const byDigest = syntheticRoot({
    '.github/workflows/docker.yml': `name: d\njobs:\n  a:\n    steps:\n      - uses: docker://alpine@sha256:${digest}\n`,
  });
  assert.equal(checkActionsPinned(byDigest).ok, true);
});

test('the repository pins every action it uses', () => {
  const result = checkActionsPinned(ROOT);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.ok(result.pins.length >= 6, `expected at least six distinct actions, saw ${result.pins.length}`);
  for (const pin of result.pins) assert.match(pin, /@[0-9a-f]{40}$/);
});

/* ---------------------------------------------- I13 author gate mirrors --- */

function guardedWorkflow(allowlist) {
  return [
    'name: ask',
    'on:',
    '  issue_comment:',
    '    types: [created]',
    '  issues:',
    '    types: [opened]',
    'jobs:',
    '  route:',
    '    if: |',
    '      github.event.issue.pull_request == null',
    `      && contains(fromJSON('${JSON.stringify(allowlist)}'), github.event.comment.author_association)`,
    "      && startsWith(github.event.issue.title, '/agent ')",
    '    steps:',
    '      - run: node scripts/route-step.mjs',
  ].join('\n');
}

const SCRIPT = "export const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);\n";

test('an issue_comment workflow with no author guard is a violation', () => {
  const root = syntheticRoot({
    'lib/commands.mjs': SCRIPT,
    '.github/workflows/unguarded.yml': [
      'name: unguarded',
      'on:',
      '  issue_comment:',
      '    types: [created]',
      'jobs:',
      '  route:',
      '    steps:',
      '      - run: node scripts/route-step.mjs',
    ].join('\n'),
  });
  const result = checkAuthorGateMirrorsScript(root);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].rule, /I13/);
});

test('the regression that prompted this check — a null comparison — is caught', () => {
  const root = syntheticRoot({
    'lib/commands.mjs': SCRIPT,
    '.github/workflows/loose.yml': [
      'name: loose',
      'on:',
      '  issue_comment:',
      '    types: [created]',
      'jobs:',
      '  route:',
      "    if: github.event.comment.author_association != 'NONE'",
      '    steps:',
      '      - run: node scripts/route-step.mjs',
    ].join('\n'),
  });
  const result = checkAuthorGateMirrorsScript(root);
  assert.equal(result.ok, false, "!= 'NONE' is looser than the gate it fronts");
});

test('a guard naming exactly the script allowlist is accepted', () => {
  const root = syntheticRoot({
    'lib/commands.mjs': SCRIPT,
    '.github/workflows/guarded.yml': guardedWorkflow(['OWNER', 'MEMBER', 'COLLABORATOR']),
  });
  const result = checkAuthorGateMirrorsScript(root);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.deepEqual(result.allowed, ['OWNER', 'MEMBER', 'COLLABORATOR']);
});

test('the allowlist is read from the script, not assumed', () => {
  const twoOnly = "export const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER']);\n";

  const matches = syntheticRoot({
    'lib/commands.mjs': twoOnly,
    '.github/workflows/guarded.yml': guardedWorkflow(['OWNER', 'MEMBER']),
  });
  assert.equal(checkAuthorGateMirrorsScript(matches).ok, true, 'the workflow names the same two');

  const drifted = syntheticRoot({
    'lib/commands.mjs': twoOnly,
    '.github/workflows/guarded.yml': guardedWorkflow(['OWNER', 'MEMBER', 'COLLABORATOR']),
  });
  assert.equal(
    checkAuthorGateMirrorsScript(drifted).ok,
    false,
    'a workflow guard wider than the script gate is exactly the drift this check exists for',
  );
});

test('the title prefix must carry its delimiter, so /agentfoo is not admitted', () => {
  const root = syntheticRoot({
    'lib/commands.mjs': SCRIPT,
    '.github/workflows/no-delimiter.yml': [
      'name: no-delimiter',
      'on:',
      '  issue_comment:',
      '    types: [created]',
      'jobs:',
      '  route:',
      `    if: contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)`,
      "      && startsWith(github.event.issue.title, '/agent')",
      '    steps:',
      '      - run: node scripts/route-step.mjs',
    ].join('\n'),
  });
  const result = checkAuthorGateMirrorsScript(root);
  assert.equal(result.ok, false, "startsWith '/agent' also matches a title of '/agentfoo'");
  assert.match(result.violations[0].rule, /delimiter/);
});

test('an opened issue is admitted only by the /agent title prefix', () => {
  const root = syntheticRoot({
    'lib/commands.mjs': SCRIPT,
    '.github/workflows/no-prefix.yml': [
      'name: no-prefix',
      'on:',
      '  issue_comment:',
      '    types: [created]',
      'jobs:',
      '  route:',
      `    if: contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)`,
      '    steps:',
      '      - run: node scripts/route-step.mjs',
    ].join('\n'),
  });
  const result = checkAuthorGateMirrorsScript(root);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].rule, /title prefix/);
});

test('a workflow that does not run on issue_comment needs no guard', () => {
  const root = syntheticRoot({
    'lib/commands.mjs': SCRIPT,
    '.github/workflows/scheduled.yml': [
      'name: scheduled',
      'on:',
      '  schedule:',
      "    - cron: '17 6 * * *'",
      'jobs:',
      '  fetch:',
      '    steps:',
      '      - run: node scripts/fetch-step.mjs',
    ].join('\n'),
  });
  assert.equal(checkAuthorGateMirrorsScript(root).ok, true);
});

test('a script with no declared allowlist fails loudly rather than passing', () => {
  const root = syntheticRoot({
    'lib/commands.mjs': 'export const SOMETHING_ELSE = 1;\n',
    '.github/workflows/guarded.yml': guardedWorkflow(['OWNER', 'MEMBER', 'COLLABORATOR']),
  });
  const result = checkAuthorGateMirrorsScript(root);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].error, /ALLOWED_ASSOCIATIONS not found/);
});

test('the repository guards every issue_comment workflow with the script allowlist', () => {
  const result = checkAuthorGateMirrorsScript(ROOT);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.deepEqual(result.allowed, ['OWNER', 'MEMBER', 'COLLABORATOR']);
});

/* ---------------------------------------------------------- the real repo --- */

test('the repository on disk satisfies every invariant', () => {
  const result = runAll(ROOT);
  const broken = Object.entries(result.results)
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => `${name}: ${JSON.stringify(r.violations)}`);
  assert.equal(result.ok, true, broken.join('\n'));
});

test('the sandbox workflow holds no secret and no write scope', () => {
  assert.equal(checkSandboxIsolated(ROOT).ok, true);
});

test('no page holds a credential, calls a model, or dispatches a workflow', () => {
  assert.equal(checkPagesHoldNoKey(ROOT).ok, true);
});

test('the run log chains, or is empty', () => {
  const result = checkHashChain(ROOT);
  assert.equal(result.ok, true);
});
