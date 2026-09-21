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
  checkConfigSurface,
  checkArtifactHandoff,
  checkPublicRendererReadsNoPrivatePath,
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

/* -------------------------------------------------- I14 config surface --- */

/** A synthetic AGENTS.md carrying only the I8 table the check reads. */
function agentsWithTable(names) {
  return [
    '### I8 — No provider names in the code',
    '',
    'Configuration surface, and nothing more:',
    '',
    '| Name | Kind | Value |',
    '|---|---|---|',
    ...names.map((n) => `| \`${n}\` | variable | a test value |`),
    '',
    '### I9 — The agent is fully useful with no model key',
    '',
  ].join('\n');
}

function envWorkflow(envLines) {
  return [
    'name: digest',
    'on:',
    '  schedule:',
    "    - cron: '17 6 * * *'",
    'jobs:',
    '  narrate:',
    '    steps:',
    '      - run: node scripts/narrate-step.mjs',
    '        env:',
    ...envLines.map((l) => `          ${l}`),
  ].join('\n');
}

function rulesOf(result) {
  return result.violations.map((v) => v.rule ?? v.error).join('\n');
}

test('a workflow asking for a variable the table does not document is a violation', () => {
  const root = syntheticRoot({
    'AGENTS.md': agentsWithTable(['LLM_MODEL']),
    '.github/workflows/digest.yml': envWorkflow([
      'LLM_MODEL: ${{ vars.LLM_MODEL }}',
      'LLM_TYPO: ${{ vars.LLM_TYPO }}',
    ]),
    'scripts/narrate-step.mjs': 'const m = process.env.LLM_MODEL;\n',
  });
  const result = checkConfigSurface(root);
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /vars\.LLM_TYPO is not in the I8 configuration table/);
});

test('the regression that prompted this check — a documented knob wired nowhere — is caught', () => {
  const root = syntheticRoot({
    'AGENTS.md': agentsWithTable(['JEV_ENABLED', 'JEV_MODEL']),
    '.github/workflows/digest.yml': envWorkflow(['JEV_ENABLED: ${{ vars.JEV_ENABLED }}']),
    'scripts/narrate-step.mjs': 'const m = process.env.JEV_MODEL;\n',
  });
  const result = checkConfigSurface(root);
  assert.equal(result.ok, false, 'the table documented a knob no workflow delivered');
  assert.match(rulesOf(result), /JEV_MODEL is read by code but passed by no workflow/);
});

test('a name passed by a workflow but absent from the table is still a violation', () => {
  const root = syntheticRoot({
    'AGENTS.md': agentsWithTable(['LLM_MODEL']),
    '.github/workflows/digest.yml': envWorkflow([
      'LLM_MODEL: ${{ vars.LLM_MODEL }}',
      'LLM_TIMEOUT: 30',
    ]),
    'lib/llm.mjs': 'const t = process.env.LLM_TIMEOUT;\n',
  });
  const result = checkConfigSurface(root);
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /LLM_TIMEOUT is read by code but absent from the I8 configuration table/);
  assert.doesNotMatch(rulesOf(result), /passed by no workflow/, 'it is passed — the table is what is missing');
});

test('a table and workflows that agree pass, and both sets are reported', () => {
  const root = syntheticRoot({
    'AGENTS.md': agentsWithTable(['LLM_API_KEY', 'LLM_BASE_URL']),
    '.github/workflows/digest.yml': envWorkflow([
      'LLM_API_KEY: ${{ secrets.LLM_API_KEY }}',
      'LLM_BASE_URL: ${{ vars.LLM_BASE_URL }}',
    ]),
    'lib/llm.mjs': 'const a = process.env.LLM_API_KEY;\nconst b = process.env.LLM_BASE_URL;\n',
  });
  const result = checkConfigSurface(root);
  assert.equal(result.ok, true, rulesOf(result));
  assert.deepEqual(result.documented, ['LLM_API_KEY', 'LLM_BASE_URL']);
  assert.deepEqual(result.read, ['LLM_API_KEY', 'LLM_BASE_URL']);
});

test('the platform token is not part of the configuration surface', () => {
  const root = syntheticRoot({
    'AGENTS.md': agentsWithTable(['LLM_MODEL']),
    '.github/workflows/commit.yml': envWorkflow(['GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}']),
  });
  assert.equal(
    checkConfigSurface(root).ok,
    true,
    'the user cannot configure GITHUB_TOKEN, so demanding a table row for it would be noise',
  );
});

test('step plumbing is not demanded as configuration', () => {
  const root = syntheticRoot({
    'AGENTS.md': agentsWithTable(['LLM_MODEL']),
    '.github/workflows/digest.yml': envWorkflow([
      'COMMENT_ID: ${{ github.event.comment.id }}',
      'NARRATE_RESULT: ${{ needs.narrate.result }}',
    ]),
    'scripts/commit-step.mjs': 'const c = process.env.COMMENT_ID;\nconst n = process.env.NARRATE_RESULT;\n',
  });
  assert.equal(
    checkConfigSurface(root).ok,
    true,
    'these are composed by the workflow, not configured by the user',
  );
});

test('a name read through bracket access counts as read', () => {
  const root = syntheticRoot({
    'AGENTS.md': agentsWithTable(['LLM_MODEL']),
    '.github/workflows/digest.yml': envWorkflow(['LLM_MODEL: ${{ vars.LLM_MODEL }}']),
    'lib/llm.mjs': "const m = process.env['LLM_MODEL'];\n",
  });
  const result = checkConfigSurface(root);
  assert.equal(result.ok, true, rulesOf(result));
  assert.deepEqual(result.read, ['LLM_MODEL']);
});

test('a missing table anchor fails rather than passing vacuously', () => {
  const root = syntheticRoot({
    'AGENTS.md': '### I8 — No provider names in the code\n\nnothing here\n',
    '.github/workflows/digest.yml': envWorkflow(['LLM_MODEL: ${{ vars.LLM_MODEL }}']),
  });
  const result = checkConfigSurface(root);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].error, /anchor is missing/);
});

test('an empty table fails rather than passing vacuously', () => {
  const root = syntheticRoot({
    'AGENTS.md': agentsWithTable([]),
    '.github/workflows/digest.yml': envWorkflow(['LLM_MODEL: ${{ vars.LLM_MODEL }}']),
  });
  const result = checkConfigSurface(root);
  assert.equal(result.ok, false);
  assert.match(result.violations[0].error, /pass vacuously/);
});

test('the repository documents every variable its workflows ask for, and wires every one it documents', () => {
  const result = checkConfigSurface(ROOT);
  assert.equal(result.ok, true, rulesOf(result));
  assert.ok(result.documented.includes('JEV_MODEL'), 'the knob this check was written for');
  assert.ok(result.read.includes('JEV_MODEL'), 'and the code that reads it');
});

/* ------------------------------------------------- I15 artifact handoff --- */

/**
 * Two step scripts with the shape the real pipeline has: one writes a file into
 * `.run/`, the other reads it. Run by hand they share a directory; on GitHub they
 * are separate jobs, and only an artifact bridges them.
 */
const WRITES_DECISIONS = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const RUN_DIR = '.run';",
  "fs.writeFileSync(path.join(RUN_DIR, 'decisions.json'), '[]', 'utf8');",
  '',
].join('\n');

const READS_DECISIONS = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const RUN_DIR = '.run';",
  "const d = JSON.parse(fs.readFileSync(path.join(RUN_DIR, 'decisions.json'), 'utf8'));",
  '',
].join('\n');

/** The producer writes through a `const`, the way `narrate-step` writes narration.json. */
const WRITES_VIA_ALIAS = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const RUN_DIR = '.run';",
  "const NARRATION = path.join(RUN_DIR, 'narration.json');",
  "fs.writeFileSync(NARRATION, '{}', 'utf8');",
  '',
].join('\n');

const READS_NARRATION = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "const RUN_DIR = '.run';",
  "const s = fs.existsSync(path.join(RUN_DIR, 'narration.json'));",
  '',
].join('\n');

function pipelineWorkflow({ upload = null, download = null, downloadPath = '.run' } = {}) {
  const lines = ['name: pipeline', 'jobs:', '  produce:', '    steps:', '      - run: node scripts/produce-step.mjs'];
  if (upload) {
    lines.push(
      `      - uses: actions/upload-artifact@${SHA}`,
      '        with:',
      '          name: state',
      `          path: ${upload}`,
    );
  }
  lines.push('  consume:', '    needs: produce', '    steps:');
  if (download) {
    lines.push(
      `      - uses: actions/download-artifact@${SHA}`,
      '        with:',
      `          name: ${download}`,
      `          path: ${downloadPath}`,
    );
  }
  lines.push('      - run: node scripts/consume-step.mjs');
  return lines.join('\n');
}

test('a file one step writes and another reads must travel as an artifact', () => {
  const root = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': pipelineWorkflow(),
  });
  const result = checkArtifactHandoff(root);
  assert.equal(result.ok, false, 'the file crosses a job boundary and nothing carries it');
  assert.equal(result.violations[0].path, '.run/decisions.json');
  assert.equal(result.violations[0].script, 'scripts/consume-step.mjs');
  assert.equal(result.violations[0].producer, 'scripts/produce-step.mjs');
  assert.match(result.violations[0].rule, /I15/);
});

test('the same pipeline passes once the file is uploaded and downloaded', () => {
  const root = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': pipelineWorkflow({ upload: '.run/decisions.json', download: 'state' }),
  });
  const result = checkArtifactHandoff(root);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.checked, 1, 'and the check did real work rather than passing vacuously');
});

test('a write through a const is a write, not a read', () => {
  // If the alias were read as a read, `narration.json` would have no producer in
  // this workflow and the check would pass on a pipeline that never delivers it.
  const missing = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_VIA_ALIAS,
    'scripts/consume-step.mjs': READS_NARRATION,
    '.github/workflows/pipeline.yml': pipelineWorkflow(),
  });
  const result = checkArtifactHandoff(missing);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].path, '.run/narration.json');
  assert.equal(
    result.violations[0].producer,
    'scripts/produce-step.mjs',
    'the const indirection has to be resolved, or the producer is invisible',
  );

  const carried = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_VIA_ALIAS,
    'scripts/consume-step.mjs': READS_NARRATION,
    '.github/workflows/pipeline.yml': pipelineWorkflow({ upload: '.run/narration.json', download: 'state' }),
  });
  assert.equal(checkArtifactHandoff(carried).ok, true);
});

test('an async write is a write — fs.promises.writeFile is not invisible', () => {
  // The vocabulary was `writeFileSync` and `appendFileSync` only, so a producer
  // that wrote asynchronously looked exactly like one that wrote nothing — and
  // nothing had to carry a file it had written. The pipeline is one refactor away
  // from that shape, and the refactor would have been silent.
  const writesAsync = [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "const RUN_DIR = '.run';",
    "await fs.promises.writeFile(path.join(RUN_DIR, 'decisions.json'), '[]', 'utf8');",
    '',
  ].join('\n');

  const root = syntheticRoot({
    'scripts/produce-step.mjs': writesAsync,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': pipelineWorkflow(),
  });
  const result = checkArtifactHandoff(root);
  assert.equal(result.ok, false, 'the async producer has to be seen');
  assert.equal(result.violations[0].producer, 'scripts/produce-step.mjs');
  assert.equal(result.violations[0].path, '.run/decisions.json');
});

test('an upload of the directory, or of a glob, carries the files under it', () => {
  // Both were false positives: the path did not match the file *exactly*, so a
  // workflow that uploaded `.run/` wholesale was told it carried nothing. That is
  // the wrong direction to be wrong in — a check that cries wolf gets disabled.
  for (const upload of ['.run', '.run/*']) {
    const root = syntheticRoot({
      'scripts/produce-step.mjs': WRITES_DECISIONS,
      'scripts/consume-step.mjs': READS_DECISIONS,
      '.github/workflows/pipeline.yml': pipelineWorkflow({ upload, download: 'state' }),
    });
    const result = checkArtifactHandoff(root);
    assert.equal(
      result.ok,
      true,
      `"${upload}" carries .run/decisions.json: ${JSON.stringify(result.violations)}`,
    );
    assert.equal(result.checked, 1, 'and the check still did real work');
  }

  // The other direction, so the widening is not simply "anything carries
  // anything": a path that names a *different* file still carries nothing.
  const wrong = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': pipelineWorkflow({ upload: '.run/prose.md', download: 'state' }),
  });
  assert.equal(checkArtifactHandoff(wrong).ok, false, 'a sibling file is not the file');
});

test('a producer invoked through npm run is resolved, and an unresolvable one is not guessed at', () => {
  const workflow = [
    'name: pipeline',
    'jobs:',
    '  produce:',
    '    steps:',
    '      - run: npm run gather',
    '  consume:',
    '    needs: produce',
    '    steps:',
    '      - run: node scripts/consume-step.mjs',
    '',
  ].join('\n');

  const resolved = syntheticRoot({
    'package.json': JSON.stringify({ scripts: { gather: 'node scripts/produce-step.mjs' } }),
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': workflow,
  });
  const result = checkArtifactHandoff(resolved);
  assert.equal(result.ok, false, 'an npm-invoked producer writes the file too');
  assert.equal(result.violations[0].producer, 'scripts/produce-step.mjs');

  // An unresolvable name is not evidence of anything. Inventing a violation from
  // one is how a check earns the reputation that gets it switched off.
  const unresolved = syntheticRoot({
    'package.json': JSON.stringify({ scripts: { gather: 'echo nothing to see here' } }),
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': workflow,
  });
  const other = checkArtifactHandoff(unresolved);
  assert.equal(other.ok, true, 'no producer in this workflow, so nothing is demanded');
  assert.equal(other.checked, 0);
});

test('a folded scalar folds, because the reader used to treat > exactly like |', () => {
  // Not cosmetic. Both consumers of a block scalar in this repository — an
  // upload's path list and a `run:` script — are sensitive to exactly the
  // difference, so reading a folded scalar as a literal one meant reading a
  // workflow GitHub would never produce.
  const literal = parseYaml(
    ['name: pipeline', 'jobs:', '  one:', '    steps:', '      - run: |', '          echo one', '          echo two', ''].join('\n'),
  );
  assert.equal(literal.jobs.one.steps[0].run, 'echo one\necho two');

  const folded = parseYaml(['a: >', '  one', '  two', '', '  three', ''].join('\n'));
  assert.equal(folded.a, 'one two\nthree', 'a newline becomes a space, a blank line becomes a newline');

  const stripped = parseYaml(['a: >-', '  one', '  two', ''].join('\n'));
  assert.equal(stripped.a, 'one two');
});

test('downloading an artifact nothing uploads is a violation', () => {
  const root = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': pipelineWorkflow({ download: 'ghost' }),
  });
  const result = checkArtifactHandoff(root);
  assert.equal(result.ok, false);
  assert.match(result.violations.map((v) => v.rule).join('\n'), /downloads artifact "ghost"/);
});

test('a step that only writes needs nothing delivered to it', () => {
  const root = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    '.github/workflows/producer.yml': 'name: p\njobs:\n  produce:\n    steps:\n      - run: node scripts/produce-step.mjs\n',
  });
  const result = checkArtifactHandoff(root);
  assert.equal(result.ok, true);
  assert.equal(result.checked, 0, 'nothing crosses a boundary, so nothing is demanded');
});

test('carried is not delivered — a download into the wrong directory is a violation', () => {
  // The blind spot this pins: the artifact name matches, so the cheap half is
  // happy, and the file lands in `state/` where `consume-step` never looks.
  // Re-pointing a download path is the original defect one layer over.
  const root = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': pipelineWorkflow({
      upload: '.run/decisions.json',
      download: 'state',
      downloadPath: 'state',
    }),
  });
  const result = checkArtifactHandoff(root);
  assert.equal(result.ok, false, 'the file is uploaded but never lands where the reader looks');
  assert.match(result.violations[0].rule, /never downloads it into \.run\//);
});

test('an upload in a third job does not cover a boundary it does not span', () => {
  // The other blind spot: unioning uploads across the whole workflow passed a
  // pipeline whose upload lived in a job running *after* the consumer.
  const workflow = [
    'name: pipeline',
    'jobs:',
    '  produce:',
    '    steps:',
    '      - run: node scripts/produce-step.mjs',
    '  consume:',
    '    needs: produce',
    '    steps:',
    '      - run: node scripts/consume-step.mjs',
    '  archive:',
    '    needs: consume',
    '    steps:',
    `      - uses: actions/upload-artifact@${SHA}`,
    '        with:',
    '          name: state',
    '          path: .run/decisions.json',
    '',
  ].join('\n');
  const root = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': workflow,
  });
  const result = checkArtifactHandoff(root);
  assert.equal(result.ok, false, 'the upload is in a job the consumer does not depend on');
  assert.match(result.violations[0].rule, /no upload carries it/);
});

test('two steps in one job share a directory, so nothing has to be carried', () => {
  // The false positive this rules out: demanding an artifact for a handoff that
  // never crosses a boundary. A check that cries wolf gets disabled.
  const workflow = [
    'name: pipeline',
    'jobs:',
    '  both:',
    '    steps:',
    '      - run: node scripts/produce-step.mjs',
    '      - run: node scripts/consume-step.mjs',
    '',
  ].join('\n');
  const root = syntheticRoot({
    'scripts/produce-step.mjs': WRITES_DECISIONS,
    'scripts/consume-step.mjs': READS_DECISIONS,
    '.github/workflows/pipeline.yml': workflow,
  });
  const result = checkArtifactHandoff(root);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.equal(result.checked, 1, 'the read was still counted, so the pass is not vacuous');
});

test('the repository carries every cross-job file, and the check is not vacuous', () => {
  const result = checkArtifactHandoff(ROOT);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
  assert.ok(
    result.checked >= 6,
    `the pipeline has at least six cross-job handoffs; saw ${result.checked}, which suggests the scan found nothing`,
  );
});

/* ------------------------------------------------- I16 public renderer --- */

/**
 * A synthetic `scripts/render-site.mjs` with the shape the real one has: it reads
 * the projected summary by constant, and narrows the digest directory to the
 * shared prefix. Every case below is this file with exactly one thing changed,
 * so a violation can only be attributed to that change.
 */
const PUBLIC_RENDERER_SRC = [
  "import fs from 'node:fs';",
  "import { PUBLIC_DIGEST_PREFIX, PUBLIC_SUMMARY } from '../lib/public-surface.mjs';",
  'const summary = readJson(PUBLIC_SUMMARY);',
  "const files = fs.readdirSync('digest').filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX));",
  '',
].join('\n');

/** The surface the check reads `PUBLIC_SUMMARY`'s declaration out of. */
const PUBLIC_SURFACE_SRC = [
  "export const PUBLIC_SUMMARY = 'data/public-summary.json';",
  "export const PUBLIC_DIGEST_PREFIX = 'public-';",
  '',
].join('\n');

/** `surface: null` builds a root with no `lib/public-surface.mjs` at all. */
function rendererRoot(source, surface = PUBLIC_SURFACE_SRC) {
  const files = { 'scripts/render-site.mjs': source };
  if (surface !== null) files['lib/public-surface.mjs'] = surface;
  return syntheticRoot(files);
}

test('a renderer that reads the projected summary and narrows the prefix passes', () => {
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(PUBLIC_RENDERER_SRC));
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('a renderer reading the private summary is a violation, and the path is named', () => {
  const src = PUBLIC_RENDERER_SRC.replace('readJson(PUBLIC_SUMMARY)', "readJson('data/summary.json')");
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(
    result.violations.map((v) => v.rule).join('\n'),
    /I16: the public renderer reads data\/summary\.json/,
  );
});

test('a renderer reading the command log is a violation — its rows carry the author login', () => {
  const src = `${PUBLIC_RENDERER_SRC}const rows = readRows('history/commands.jsonl');\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(result.violations.map((v) => v.rule).join('\n'), /history\/commands\.jsonl/);
});

test('enumerating digest/ while merely importing the prefix is a violation, not a narrowing', () => {
  // The regression this pins: the prefix was searched for anywhere in the file,
  // so `import { PUBLIC_DIGEST_PREFIX }` sitting above `readdirSync('digest')`
  // read as a narrowed read. The private and public digests share a directory and
  // a date, so that version publishes whichever sorts last — which is the public
  // one only because 'p' > '2'.
  const src = PUBLIC_RENDERER_SRC.replace(
    "const files = fs.readdirSync('digest').filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX));",
    "const files = fs.readdirSync('digest');",
  );
  assert.match(src, /PUBLIC_DIGEST_PREFIX/, 'the import is still present, which is the whole point');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(result.violations.map((v) => v.rule).join('\n'), /enumerates digest\/ without narrowing/);
});

test('a renderer that names no public digest fails, so the check cannot pass vacuously', () => {
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot('const s = readJson(PUBLIC_SUMMARY);\n'));
  assert.equal(result.ok, false, 'a file that never names the prefix is not reading the projected surface');
  assert.match(result.violations.map((v) => v.rule).join('\n'), /cannot be reading the projected surface/);
});

test('re-pointing PUBLIC_SUMMARY at the private summary is caught in the source, not by import', () => {
  // Assertion 3 has to read the *declaration*: an import would have been a
  // tautology, and a branch a test can never make fire is not a check.
  const surface = [
    "export const PUBLIC_SUMMARY = 'data/summary.json';",
    "export const PUBLIC_DIGEST_PREFIX = 'public-';",
    '',
  ].join('\n');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(PUBLIC_RENDERER_SRC, surface));
  assert.equal(result.ok, false);
  assert.match(result.violations.map((v) => v.rule).join('\n'), /PUBLIC_SUMMARY names a private path/);
});

test('a surface that declares no summary path fails rather than passing unasserted', () => {
  const partial = "export const PUBLIC_DIGEST_PREFIX = 'public-';\n";
  for (const [label, surface] of [['a renamed constant', partial], ['a missing module', null]]) {
    const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(PUBLIC_RENDERER_SRC, surface));
    assert.equal(result.ok, false, label);
    assert.match(result.violations.map((v) => v.rule).join('\n'), /is not declared/, label);
  }
});

test('a private path named in a comment is documentation, not a read', () => {
  // This is the shape the check failed on when it was first written: the module
  // header names both private paths it forbids, and a scan that did not strip
  // comments reported the paragraph explaining the rule as a breach of it.
  const src = [
    '// `data/summary.json` is the private summary; `history/commands.jsonl` carries the login.',
    "import fs from 'node:fs';",
    "import { PUBLIC_DIGEST_PREFIX, PUBLIC_SUMMARY } from '../lib/public-surface.mjs';",
    'const summary = readJson(PUBLIC_SUMMARY);',
    "const files = fs.readdirSync('digest').filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX));",
    '',
  ].join('\n');
  assert.equal(
    checkPublicRendererReadsNoPrivatePath(rendererRoot(src)).ok,
    true,
    'a rule that fired on its own explanation could not be documented',
  );
});

test('a repository with no public renderer fails rather than passing', () => {
  const result = checkPublicRendererReadsNoPrivatePath(syntheticRoot({ 'README.md': 'x' }));
  assert.equal(result.ok, false);
  assert.match(result.violations[0].error, /missing/);
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
