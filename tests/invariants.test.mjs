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
import { pathToFileURL } from 'node:url';
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
import { CI_ALLOWLIST, COLLECTOR_ALLOWLIST } from '../lib/store.mjs';
import { PUBLIC_DIGEST_PREFIX } from '../lib/public-surface.mjs';

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

/**
 * A synthetic `scripts/commit-step.mjs` with the ordering I2's second clause
 * asserts. Every case below is this file with exactly one thing changed.
 *
 * The import lines are the reason the markers carry their `(`: `buildPublicSurface,`
 * appears in the import list above the gate, so a bare name would be found first
 * and the clause would pass on any ordering at all.
 */
const GATE_CALL_LINE = '  assertGrounded(narration, attachDecisions(payload, decisions), { derived });';
const PROJECTION_CALL_LINE =
  '  const publicSurface = buildPublicSurface({ payload, decisions, stack, heartbeat, commands });';
const PROJECTION_WRITE_LINES = [
  '  writeIfChanged(publicDigestPath(observed), publicSurface.digest);',
  '  writeIfChanged(PUBLIC_SUMMARY, publicSurface.summary);',
];

function commitStep({ gate = true, projection = true, writes = true, projectionFirst = false } = {}) {
  const lines = [
    "import { assertGrounded } from '../lib/gate.mjs';",
    "import { buildPublicSurface, publicDigestPath, PUBLIC_SUMMARY } from '../lib/public-surface.mjs';",
  ];
  if (projectionFirst && gate && projection) {
    lines.push(PROJECTION_CALL_LINE, GATE_CALL_LINE);
  } else {
    if (gate) lines.push(GATE_CALL_LINE);
    if (projection) lines.push(PROJECTION_CALL_LINE);
  }
  if (writes && projection) lines.push(...PROJECTION_WRITE_LINES);
  return lines.join('\n') + '\n';
}

const commitStepRoot = (source) => syntheticRoot({ 'scripts/commit-step.mjs': source });

test('a commit step that gates, then projects, then writes passes', () => {
  const result = checkGatePlacement(commitStepRoot(commitStep()));
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('projecting before the gate is a violation — the gate would judge a narrower document', () => {
  // The gate's document is `attachDecisions(payload, decisions)`, which is what
  // the narrator read. Projecting first changes what the gate is judging, and
  // every fact about a withheld package becomes ungroundable. The import graph
  // cannot see statement order; that is the whole reason this clause exists.
  const result = checkGatePlacement(commitStepRoot(commitStep({ projectionFirst: true })));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /I2: the public surface is projected before the gate/);
});

test('building the projected surface and never writing it is a violation', () => {
  // The verifier's experiment: deleting both writes left 328 tests green while
  // the pipeline published only the private surface.
  const result = checkGatePlacement(commitStepRoot(commitStep({ writes: false })));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /built but never written/);
  assert.equal(
    result.violations.filter((v) => /built but never written/.test(v.rule)).length,
    2,
    'both artifacts, or a deletion of one of them reads as a pass',
  );
});

test('a commit step with no gate call, or no projection, fails rather than passing vacuously', () => {
  // Either marker missing would make the ordering comparison meaningless, and a
  // check whose subject is absent must not read as a satisfied check.
  const noGate = checkGatePlacement(commitStepRoot(commitStep({ gate: false })));
  assert.equal(noGate.ok, false);
  assert.match(rulesOf(noGate), /must call assertGrounded/);

  const noProjection = checkGatePlacement(commitStepRoot(commitStep({ projection: false })));
  assert.equal(noProjection.ok, false);
  assert.match(rulesOf(noProjection), /must build the public surface/);
});

test('a missing commit step fails rather than passing', () => {
  const result = checkGatePlacement(syntheticRoot({ 'scripts/other-step.mjs': 'export const x = 1;\n' }));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /missing/);
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
  assert.ok(
    result.violations.some((v) => v.target === 'data/summary.json'),
    rulesOf(result),
  );
});

test('a renderer reading the command log is a violation — its rows carry the author login', () => {
  const src = `${PUBLIC_RENDERER_SRC}const rows = readRows('history/commands.jsonl');\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.target === 'history/commands.jsonl'), rulesOf(result));
});

test('the verifier’s diff — reading data/stack.json — is a violation', () => {
  // The exact regression that made this check an allowlist. `data/stack.json` is
  // the watch list, and the previous denylist version of this check returned
  // `{ok: true, violations: []}` while the renderer wrote it to site/.
  const src = [
    PUBLIC_RENDERER_SRC,
    "const watchList = JSON.parse(fs.readFileSync('data/stack.json', 'utf8'));",
    "fs.writeFileSync('site/data/watch.json', JSON.stringify(watchList));",
    '',
  ].join('\n');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false, 'the watch list is not a projected artifact');
  assert.ok(result.violations.some((v) => v.target === 'data/stack.json'), rulesOf(result));
});

test('a read target bound to a const is still a read target', () => {
  // The first hiding spelling: a literal that never appears as a call argument.
  const src = `${PUBLIC_RENDERER_SRC}const STACK = 'data/stack.json';\nconst watchList = readJson(STACK);\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.target === 'data/stack.json'), rulesOf(result));
});

test('a read target assembled by a two-literal path.join is still a read target', () => {
  // The second hiding spelling, and the idiomatic one in this repository. The
  // check reports the literal that *resolves into a collector root* — `data` —
  // rather than a path synthesised from the two components. That is the inversion
  // showing through: detection is by content, so what is named is the literal
  // that was found, not a shape that was reconstructed.
  const src = `${PUBLIC_RENDERER_SRC}const watchList = readJson(path.join('data', 'stack.json'));\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.target === 'data'), rulesOf(result));
});

test('enumerating digest/ while merely importing the prefix is a violation, not a narrowing', () => {
  // The prefix was searched for anywhere in the file, so `import
  // { PUBLIC_DIGEST_PREFIX }` sitting above `readdirSync('digest')` read as a
  // narrowed read. The private and public digests share a directory and a date,
  // so that version publishes whichever sorts last — the public one only because
  // 'p' > '2'.
  const src = PUBLIC_RENDERER_SRC.replace(
    "const files = fs.readdirSync('digest').filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX));",
    "const files = fs.readdirSync('digest');",
  );
  assert.match(src, /PUBLIC_DIGEST_PREFIX/, 'the import is still present, which is the whole point');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /enumerates digest\/ without narrowing/);
});

test('mentioning the prefix elsewhere does not narrow the enumeration', () => {
  // The verifier's second diff: the `.filter` loses the prefix, and
  // `name.slice(PUBLIC_DIGEST_PREFIX.length)` keeps the name in the file. A check
  // that asked "does this file mention the prefix" said yes.
  const src = PUBLIC_RENDERER_SRC.replace(
    "const files = fs.readdirSync('digest').filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX));",
    [
      "const files = fs.readdirSync('digest').filter((f) => f.endsWith('.md'));",
      'const date = files[0].slice(PUBLIC_DIGEST_PREFIX.length);',
    ].join('\n'),
  );
  assert.match(src, /PUBLIC_DIGEST_PREFIX/, 'the prefix is still mentioned, which is the whole point');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /enumerates digest\/ without narrowing/);
});

test('a renderer that reads nothing fails, so an empty file cannot pass an allowlist', () => {
  // The floor. An allowlist is satisfied by a file with no reads at all, so
  // "every target is permitted" has to be paired with "and it reads the thing it
  // exists to read".
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot('export const nothing = 1;\n'));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /never reads PUBLIC_SUMMARY/);
});

test('importing PUBLIC_SUMMARY is not reading it', () => {
  const src = [
    "import { PUBLIC_DIGEST_PREFIX, PUBLIC_SUMMARY } from '../lib/public-surface.mjs';",
    "const files = fs.readdirSync('digest').filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX));",
    '',
  ].join('\n');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false, 'the import alone satisfied the floor before this was pinned');
  assert.match(rulesOf(result), /never reads PUBLIC_SUMMARY/);
});

/**
 * Assertion 2's guard is a **marker**, not a list.
 *
 * The guard exists because the permitted set in assertion 1 is derived from the
 * `PUBLIC_SUMMARY` declaration — re-point the constant and the permitted set
 * widens to match. The first version of the guard enumerated the private paths it
 * knew about, which is N20's error a second time: re-pointing the declaration at
 * `data/heartbeat.json`, `data/triage.jsonl` or `history/runs.jsonl` returned
 * `{ok: true}` while the surface would have published each of them. It is now a
 * presence rule — the declared basename must carry the marker the projection
 * itself uses.
 *
 * These cases pin the six refusals, the two permissions, and the control that the
 * refusals come from the marker clause rather than from somewhere else in the
 * check.
 */
const PRIVATE_DECLARATIONS = [
  // The three the old denylist enumerated, so the marker rule is shown to subsume
  // the list rather than quietly drop it.
  'data/summary.json',
  'data/stack.json',
  'history/commands.jsonl',
  // The three it had never heard of, each of which it passed.
  'data/heartbeat.json', // carries consecutive_failures
  'data/triage.jsonl', // committed, append-only, endpoint response bodies
  'history/runs.jsonl', // the private run chain
];
/** Carrying the marker is the declaration; these must stay permitted. */
const MARKED_DECLARATIONS = ['data/public-summary.json', 'data/public-anything.json'];

/** The surface fixture, tied to the real marker so the two cannot drift apart. */
function surfaceFor(declared) {
  return `export const PUBLIC_SUMMARY = '${declared}';\nexport const PUBLIC_DIGEST_PREFIX = '${PUBLIC_DIGEST_PREFIX}';\n`;
}

function declaredResult(declared) {
  return checkPublicRendererReadsNoPrivatePath(rendererRoot(PUBLIC_RENDERER_SRC, surfaceFor(declared)));
}

test('re-pointing PUBLIC_SUMMARY at any private path is refused, enumerated or not', () => {
  // Reading the *source* is load-bearing: an import would have been a tautology,
  // and a branch a test can never make fire is not a check.
  for (const declared of PRIVATE_DECLARATIONS) {
    const result = declaredResult(declared);
    assert.equal(result.ok, false, declared);
    assert.ok(
      result.violations.some((v) => v.rule.includes(declared)),
      `${declared} must be named in the violation: ${rulesOf(result)}`,
    );
    assert.ok(
      result.violations.some((v) => v.rule.includes(PUBLIC_DIGEST_PREFIX)),
      `${declared}: the missing marker must be named too: ${rulesOf(result)}`,
    );
  }
});

test('a declared summary that carries the marker is permitted', () => {
  for (const declared of MARKED_DECLARATIONS) {
    const result = declaredResult(declared);
    assert.equal(result.ok, true, `${declared}: carrying the marker is the declaration`);
  }
});

test('the marker is the discriminator: each refusal flips green when the same path carries it', () => {
  // The differential control, and the reason the cases above mean anything. Each
  // pair is the same directory and the same basename, differing only by the
  // marker. If a refusal were coming from assertion 1, from the floor, or from the
  // digest enumeration, the marked half of the pair would be red as well — and it
  // is not.
  for (const declared of PRIVATE_DECLARATIONS) {
    const marked = path.posix.join(
      path.posix.dirname(declared),
      `${PUBLIC_DIGEST_PREFIX}${path.posix.basename(declared)}`,
    );
    assert.equal(declaredResult(declared).ok, false, `${declared} must be refused`);
    assert.equal(declaredResult(marked).ok, true, `${marked} must be permitted`);
  }
});

test('the must-fail control: with the marker test forced to pass, every refusal turns green', async () => {
  // A refusal proves nothing about *which* clause refused. So the check is copied
  // into a scratch directory with the marker test replaced by `false` — the
  // "always pass" mutant — and every case above must flip. If one stays red, it was
  // never the marker that refused it, and the cases above are testing something
  // other than what they claim.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i16-marker-mutant-'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  const file = path.join(dir, 'lib/invariants.mjs');
  const src = fs.readFileSync(file, 'utf8');
  const patched = src.replace(
    '!path.posix.basename(declared[1]).startsWith(PUBLIC_DIGEST_PREFIX)',
    'false',
  );
  assert.notEqual(patched, src, 'the marker test must be present, or there is nothing to mutate');
  fs.writeFileSync(file, patched);

  const mutant = await import(pathToFileURL(file).href);
  for (const declared of PRIVATE_DECLARATIONS) {
    const result = mutant.checkPublicRendererReadsNoPrivatePath(
      rendererRoot(PUBLIC_RENDERER_SRC, surfaceFor(declared)),
    );
    assert.equal(
      result.ok,
      true,
      `${declared} stayed red with the marker test disabled, so the marker is not what refuses it`,
    );
  }
});

test('a surface that declares no summary path fails rather than passing unasserted', () => {
  const partial = "export const PUBLIC_DIGEST_PREFIX = 'public-';\n";
  for (const [label, surface] of [['a renamed constant', partial], ['a missing module', null]]) {
    const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(PUBLIC_RENDERER_SRC, surface));
    assert.equal(result.ok, false, label);
    assert.match(rulesOf(result), /is not declared/, label);
  }
});

test('a private path in a comment is documentation, not a read', () => {
  // The shape this check failed on when it was first written: the module header
  // names the private paths it forbids, and a scan that did not strip comments
  // reported the paragraph explaining the rule as a breach of it. The comment
  // carries a full read spelling on purpose, so stripping is load-bearing.
  const src = [
    "// Never do this: readJson('data/stack.json'), or readRows('history/commands.jsonl').",
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

test('a URL is a slash without being a repository path', () => {
  // The false positive that would make this check noisy: `https://…` has slashes
  // and is not a file. A check that cries wolf gets disabled.
  const src = `${PUBLIC_RENDERER_SRC}const url = 'https://github.com/' + REPO + '/issues/new';\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('a repository with no public renderer fails rather than passing', () => {
  const result = checkPublicRendererReadsNoPrivatePath(syntheticRoot({ 'README.md': 'x' }));
  assert.equal(result.ok, false);
  assert.match(result.violations[0].error, /missing/);
});

/* ------------------------------- I16 v2: detection by content, not shape --- */

/**
 * The second half of the inversion, and the half the first version missed.
 *
 * `400626e` made the *policy* an allowlist but left the *detection* shape-based:
 * eight read-function names, three spellings of a target. A shape list fails open
 * for the same reason a denylist does — it enumerates the thing it is trying to
 * cover. So the check now scans **literals**: any string that resolves into a
 * collector root is a private path, whatever it is passed to.
 *
 * These cases are the ones the shape list could not see. Each is a way to spell a
 * read of `data/stack.json` that the previous version returned `{ok: true}` on.
 */

test('the content scan is not the function list: an unenumerated reader is caught', () => {
  // `createReadStream` is in no function list. A shape-based check cannot see
  // this at all; a content-based one sees the literal, which is the point.
  const src = `${PUBLIC_RENDERER_SRC}const stream = fs.createReadStream('data/stack.json');\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false, 'the function is not the boundary; the path is');
  assert.ok(result.violations.some((v) => v.target === 'data/stack.json'), rulesOf(result));
});

test('a dynamic import of a private path is caught too', () => {
  const src = `${PUBLIC_RENDERER_SRC}const watch = await import('data/stack.json');\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.target === 'data/stack.json'), rulesOf(result));
});

test('./ and // are the same path spelled differently, and both are caught', () => {
  for (const spelling of ['./data/stack.json', 'data//stack.json', 'data/stack.json']) {
    const src = `${PUBLIC_RENDERER_SRC}const w = readJson('${spelling}');\n`;
    const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
    assert.equal(result.ok, false, spelling);
  }
});

test('the collector root itself is a private path, not only a file under it', () => {
  // `fs.readdirSync('data')` names no file and leaks every one of them.
  const src = `${PUBLIC_RENDERER_SRC}const entries = fs.readdirSync('data');\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.target === 'data'), rulesOf(result));
});

test('a sibling of a collector root is not a private path', () => {
  // The resolution test must be a *segment* test. A prefix test would report
  // `database.json` and `datastore/`, and a check that cries wolf gets disabled.
  //
  // These are not read targets, which is deliberate: a *read* of a non-projected
  // path is refused by the allowlist policy whatever it names, so `readJson(
  // 'database.json')` is red and rightly so. What is being asserted here is only
  // that the resolution predicate does not mistake a sibling for a root.
  const src = [
    PUBLIC_RENDERER_SRC,
    "const a = 'database.json';",
    "const b = 'datastore/index.json';",
    "const c = 'history.md';",
    '',
  ].join('\n');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('legitimate literals are not paths, and stay green', () => {
  // The false positives that would make this check noisy: HTML, MIME types, and a
  // path-shaped URL fragment. The charset guard rejects the first and the
  // resolution test rejects the other two.
  const src = [
    PUBLIC_RENDERER_SRC,
    "const tag = '</div>';",
    "const mime = 'text/html';",
    "const json = 'application/json';",
    "const issue = 'https://github.com/' + REPO + '/issues/new';",
    '',
  ].join('\n');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('a computed target to a known reader is refused, because no literal resolves', () => {
  // Rule 2's own reach: `A + '/' + B` contains no single literal that resolves, so
  // assertion 1 cannot see it. The form clause can.
  const src = [
    PUBLIC_RENDERER_SRC,
    "const A = 'da';",
    "const B = 'ta/stack.json';",
    "const w = readJson(A + '/' + B);",
    '',
  ].join('\n');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /computed target/);
});

test('an identifier that is not the declared constant is refused', () => {
  // The literal does not resolve, so assertion 1 is silent — this is the case
  // that makes rule 2 more than a restatement of assertion 1.
  const src = [
    PUBLIC_RENDERER_SRC,
    "const STACK = 'config/stack.json';",
    'const w = readJson(STACK);',
    '',
  ].join('\n');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /which is not the declared PUBLIC_SUMMARY/);
});

test('a join with a projected literal root is permitted, and one level of const folds', () => {
  // Both are the shape the real renderer uses for `digest/`.
  for (const src of [
    `${PUBLIC_RENDERER_SRC}const doc = fs.readFileSync(path.join('digest', name), 'utf8');\n`,
    `${PUBLIC_RENDERER_SRC}const DIGEST = 'digest';\nconst doc = fs.readFileSync(path.join(DIGEST, name), 'utf8');\n`,
  ]) {
    const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
    assert.equal(result.ok, true, JSON.stringify(result.violations));
  }
});

test('a join root that cannot be resolved is refused', () => {
  // The fold is one level, the way I15 folds one level. `path.join(SOME_DIR, …)`
  // names nothing this check can resolve, so it is refused rather than assumed.
  const src = `${PUBLIC_RENDERER_SRC}const w = readJson(path.join(SOME_DIR, 'stack.json'));\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /whose root is not a literal and cannot be resolved/);
});

test('a .. traversal is refused, and by resolution rather than by the form clause', () => {
  // This case was pinned the other way round while the candidate test excluded
  // `..` by spelling: the content clause was blind to it, so the form clause was
  // what refused it. The exclusion is gone — a literal is a candidate when it
  // *resolves* into a collector root — so the content clause sees it too, and the
  // form clause defers rather than reporting one defect twice. The refusal is the
  // same; what changed is which clause can see it, and that matters, because the
  // spelling-based exclusion was the only thing letting a `..` literal pass a
  // reader outside `READ_FUNCTIONS`, where no form clause exists to catch it.
  const src = `${PUBLIC_RENDERER_SRC}const w = readJson('data/../data/stack.json');\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /resolves into a collector root/);
  assert.equal(result.violations.length, 1, `one defect, one finding: ${rulesOf(result)}`);
});

test('the stated limit, asserted rather than left silent: an unenumerated reader with a computed target passes', () => {
  // Rule 2 closes *enumerated function + computed target*. It does not close
  // *unenumerated function + computed target*: there is no name to recognise and
  // no literal to resolve, so neither clause fires. This is a real gap, it is the
  // reason the pipeline canary exists, and it is pinned here so that closing it
  // later is a deliberate act rather than an accident.
  const src = [
    PUBLIC_RENDERER_SRC,
    "const A = 'da';",
    "const B = 'ta/stack.json';",
    "const stream = fs.createReadStream(A + '/' + B);",
    '',
  ].join('\n');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, true, 'the documented limit, not an oversight');
});

test('a .. literal to an unenumerated reader is caught, which it was not', () => {
  // This was pinned as a limit — "the same limit, one spelling over" — and it was
  // not the same limit. The concat case above has *no* resolvable component and
  // no enumerated name, so nothing in the check can see it; that one is
  // structural. This one has a literal, and a literal is exactly what the content
  // clause reads. It was invisible only because that clause excluded `..` by
  // spelling, while `createReadStream` is in no function list for the form clause
  // to reach: two clauses blind for two different reasons, and only one of them
  // was structural. Corrected rather than left pinned, because a limit that reads
  // as a design decision while actually being an oversight is the kind of thing
  // this repository keeps finding.
  const src = `${PUBLIC_RENDERER_SRC}const stream = fs.createReadStream('data/../data/stack.json');\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false, 'the function is not the boundary; the path is');
  assert.match(rulesOf(result), /resolves into a collector root/);
});

test('a literal that is the collector allowlist file is a collector path too', () => {
  // `README.md` is in `COLLECTOR_ALLOWLIST` as a single file rather than a
  // directory, so `s === root` is what matches it. It is committed and public, so
  // this is not a disclosure — it is the invariant's policy, which is that the
  // renderer reads the projected artifacts and nothing else. Asserted so the
  // behaviour is chosen rather than discovered.
  const src = `${PUBLIC_RENDERER_SRC}const readme = fs.readFileSync('README.md', 'utf8');\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.target === 'README.md'), rulesOf(result));
});

test('the collector roots are derived from the write allowlist, not restated', () => {
  // The inversion's whole claim: the private set and the checked set are the same
  // set. A root that is added to the write allowlist becomes a read target here
  // with no edit to the check — which is the property a denylist cannot have.
  // Asserted by the effect: every entry of the allowlist resolves, and a name
  // that is not an entry does not.
  const members = [...COLLECTOR_ALLOWLIST];
  assert.ok(members.includes('data') && members.includes('assets'), 'the allowlist is the source');
  const src = `${PUBLIC_RENDERER_SRC}const w = readJson('assets/logo.png');\n`;
  assert.equal(
    checkPublicRendererReadsNoPrivatePath(rendererRoot(src)).ok,
    false,
    'a root with no file named under it anywhere in the check is still caught',
  );
});

/* ------------- I16 v3: the verdict is the resolved path, not the spelling --- */

/**
 * The class, not the spellings.
 *
 * `bc737d0`'s commit title is *"Detect a private read by what it resolves to, not
 * by how it is spelled"*, and three clauses were still deciding by spelling:
 * `isProjected()` was a prefix test that never collapsed `..`, the candidate test
 * excluded any literal containing `..`, and the `path.join` branch folded only its
 * first argument. Each is the same error, and each made a traversal's verdict
 * depend on how it was written rather than where it landed. The tell was two
 * spellings of one resolved path with opposite verdicts:
 *
 *     path.join('digest', '..', 'data', 'stack.json')   RED
 *     path.join('digest', '../data/stack.json')         GREEN
 *
 * Every case below returned `{ok: true}` before, and the reader named in each is
 * deliberately varied — enumerated, unenumerated, a bare literal — because the
 * point is that the *path* is the boundary and the function never was.
 */
const TRAVERSALS_RESOLVED = [
  ['a literal', "const w = readJson('digest/../data/stack.json');"],
  ['a literal into history', "const r = readRows('digest/../history/commands.jsonl');"],
  ['a literal that is only `..`', "const e = fs.readdirSync('digest/..');"],
  ['a literal that escapes the repository', "const p = fs.readFileSync('digest/../../../etc/passwd');"],
  ['a literal with a leading `./`', "const q = readJson('./digest/../data/stack.json');"],
  ['a join, `..` inside one argument', "const j = readJson(path.join('digest', '../data/stack.json'));"],
  ['a join with a bare `..`', "const l = fs.readdirSync(path.join('digest', '..'));"],
  ['an unenumerated reader', "const c = fs.createReadStream('digest/../data/stack.json');"],
];

/**
 * Refused by a different clause, and worth separating for that reason: the join
 * cannot be resolved at all, so there is nothing to resolve the traversal
 * *against* — the components that did fold are checked instead. That clause is
 * what the first version of the join branch omitted entirely.
 */
const TRAVERSAL_BESIDE_A_VARIABLE =
  "const v = readJson(path.join('digest', name, '../data/stack.json'));";

/**
 * The one join spelling that was **already** refused before this fix, kept
 * separate so the control below stays honest. `path.join('digest', '..', 'data')`
 * resolves out of the projected set, but it is refused by the content clause
 * catching the bare `'data'` component — which is why the join branch defers
 * rather than reporting a second finding for the same defect. It is the other
 * half of the tell: red while its one-argument spelling was green.
 */
const TRAVERSAL_BY_BARE_COMPONENT = "const k = fs.existsSync(path.join('digest', '..', 'data'));";

test('every spelling of a traversal is refused, which none of them were', () => {
  const all = [
    ...TRAVERSALS_RESOLVED,
    ['a variable tail', TRAVERSAL_BESIDE_A_VARIABLE],
    ['a bare component', TRAVERSAL_BY_BARE_COMPONENT],
  ];
  for (const [label, line] of all) {
    const src = `${PUBLIC_RENDERER_SRC}${line}\n`;
    const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
    assert.equal(result.ok, false, `${label}: ${JSON.stringify(result.violations)}`);
  }
});

test('a bare component literal is named once, not twice', () => {
  // The join branch defers to the content clause when a component literal is
  // itself the finding, so one defect stays one finding. Asserted as a count,
  // because a duplicate is invisible in a boolean.
  const src = `${PUBLIC_RENDERER_SRC}${TRAVERSAL_BY_BARE_COMPONENT}\n`;
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.violations.length, 1, rulesOf(result));
  assert.ok(result.violations.some((v) => v.target === 'data'), rulesOf(result));
});

test('the tell: two spellings of one resolved path no longer disagree', () => {
  // The whole finding in one assertion — one path, two spellings, opposite
  // verdicts, decided entirely by whether the traversal was written as one
  // argument or three.
  const split = `${PUBLIC_RENDERER_SRC}const a = readJson(path.join('digest', '..', 'data', 'stack.json'));\n`;
  const joined = `${PUBLIC_RENDERER_SRC}const b = readJson(path.join('digest', '../data/stack.json'));\n`;
  assert.equal(checkPublicRendererReadsNoPrivatePath(rendererRoot(split)).ok, false, 'split');
  assert.equal(checkPublicRendererReadsNoPrivatePath(rendererRoot(joined)).ok, false, 'joined');
});

test('the resolution rule keeps legitimate code green, in both directions', () => {
  // The half that decides whether this check survives contact with real code, and
  // the reason the `..` exclusion existed at all. Resolution keeps every case it
  // was protecting: a `..` that lands back inside the projected set is projected,
  // a literal that starts with a collector root but resolves outside every root is
  // not a private path, and a path beside the repository is not a path into it.
  const cases = [
    ['a `..` that resolves back inside digest/', "const a = readJson('digest/../digest/public-x.md');"],
    ['a root-prefixed literal that resolves out of every root', "const b = fs.createReadStream('data/../lib/x.mjs');"],
    ['a relative import named but never read', "const c = '../lib/public-surface.mjs';"],
    ['a variable tail', "const d = fs.readFileSync(path.join('digest', name), 'utf8');"],
    ['a variable tail behind a folded const root', "const E = 'digest';\nconst f = fs.readFileSync(path.join(E, name), 'utf8');"],
    ['a path outside the repository', "const g = fs.createReadStream('../data/stack.json');"],
  ];
  for (const [label, line] of cases) {
    const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(`${PUBLIC_RENDERER_SRC}${line}\n`));
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.violations)}`);
  }
});

/**
 * N26: the name is not the binding.
 *
 * Rule 2 accepts any identifier spelled `PUBLIC_SUMMARY`, and `buildFacts()`'s
 * one-argument arity — the property §I2 treats as *the* enforcement — is exactly
 * what a shadowed constant defeats. With the import deleted and the constant
 * re-declared from two harmless fragments, `readJson(PUBLIC_SUMMARY)` reads the
 * renderer's own string while every other clause still reads as satisfied:
 * neither fragment resolves into a collector root, the target is the declared
 * name, and the floor is satisfied by the declaration itself.
 */
const SHADOWED_RENDERER = [
  "import fs from 'node:fs';",
  "import { PUBLIC_DIGEST_PREFIX } from '../lib/public-surface.mjs';",
  "const A = 'da', B = 'ta/stack.json', PUBLIC_SUMMARY = A + '/' + B;",
  "const files = fs.readdirSync('digest').filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX));",
  'const summary = readJson(PUBLIC_SUMMARY);',
  '',
].join('\n');

test('a renderer that binds PUBLIC_SUMMARY itself is refused', () => {
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(SHADOWED_RENDERER));
  assert.equal(result.ok, false, 'the name is not the binding');
  assert.match(rulesOf(result), /declares PUBLIC_SUMMARY locally/);
});

test('the declaration is refused even when nothing reads it', () => {
  // Otherwise the floor passes on the declaration alone: a file that binds the name
  // and reads nothing is the same defect as a file that reads nothing, which is
  // what the floor exists to catch. The value is deliberately harmless — a
  // projected path — so the only clause that can refuse this is the binding rule.
  const src = [
    "import fs from 'node:fs';",
    "import { PUBLIC_DIGEST_PREFIX } from '../lib/public-surface.mjs';",
    "const PUBLIC_SUMMARY = 'digest/public-x.md';",
    "const files = fs.readdirSync('digest').filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX));",
    '',
  ].join('\n');
  const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(src));
  assert.equal(result.ok, false);
  assert.match(rulesOf(result), /declares PUBLIC_SUMMARY locally/);
  assert.equal(result.violations.length, 1, `one defect, one finding: ${rulesOf(result)}`);
});

test('a destructured binding of the name is refused too', () => {
  // The names a destructuring binds are on the same side of the `=` as a plain
  // declarator's, so the same test covers them rather than a second pattern.
  const src = [
    "import fs from 'node:fs';",
    "import { PUBLIC_DIGEST_PREFIX } from '../lib/public-surface.mjs';",
    'const { PUBLIC_SUMMARY } = cfg;',
    "const files = fs.readdirSync('digest').filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX));",
    'const s = readJson(PUBLIC_SUMMARY);',
    '',
  ].join('\n');
  assert.equal(checkPublicRendererReadsNoPrivatePath(rendererRoot(src)).ok, false);
});

test('using the name, or a longer name, is not declaring it', () => {
  // The false positive that would have made this rule useless, and the reason the
  // test is applied to the binding half of each declarator: a pattern loose enough
  // to catch the shadow also catches `const summary = readJson(PUBLIC_SUMMARY)`,
  // which is how the fixture above — and any renderer written the natural way —
  // reads the projected surface. Reporting that is how a check gets turned off.
  //
  // Run rather than asserted-about: the loose pattern is exercised here, so the
  // justification for the declarator split cannot go stale without this failing.
  assert.match(
    PUBLIC_RENDERER_SRC,
    /const[^;]*PUBLIC_SUMMARY/,
    'the loose pattern must fire on the fixture, or the split has no reason to exist',
  );
  const cases = [
    ['a use, not a binding', 'const summary2 = readJson(PUBLIC_SUMMARY);'],
    ['a longer name bound locally', "const PUBLIC_SUMMARY_PATH = 'x';"],
  ];
  for (const [label, line] of cases) {
    const result = checkPublicRendererReadsNoPrivatePath(rendererRoot(`${PUBLIC_RENDERER_SRC}${line}\n`));
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result.violations)}`);
  }
});

/**
 * Load the check from a scratch copy of `lib/` with a replacement applied.
 *
 * A refusal proves nothing about *which* clause refused it. Disabling the clause
 * and requiring the case to flip is what attributes it — the same reason
 * assertion 2's marker carries a must-fail control.
 */
async function mutantCheck(replacements) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'i16-mutant-'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(dir, 'lib'), { recursive: true });
  const file = path.join(dir, 'lib/invariants.mjs');
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of replacements) {
    const patched = src.replace(from, to);
    assert.notEqual(patched, src, `the needle must be present, or there is nothing to mutate: ${from}`);
    src = patched;
  }
  fs.writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}

test('the must-fail control: resolution is what refuses the traversal spellings', async () => {
  // `..` is pushed as an ordinary segment instead of being collapsed — the
  // spelling-based behaviour the whole class came from. Every case must flip
  // green: if one stays red, resolution was not what refused it, and the cases
  // above are testing something other than what they claim.
  const mutant = await mutantCheck([
    [
      "    if (seg === '..') {\n      if (out.length === 0) return null;\n      out.pop();\n      continue;\n    }\n",
      '',
    ],
  ]);
  for (const [label, line] of TRAVERSALS_RESOLVED) {
    const result = mutant.checkPublicRendererReadsNoPrivatePath(rendererRoot(`${PUBLIC_RENDERER_SRC}${line}\n`));
    assert.equal(
      result.ok,
      true,
      `${label} stayed red with the traversal uncollapsed, so resolution is not what refuses it`,
    );
  }
});

test('the must-fail control: the join-tail check is what refuses a traversal beside a variable', async () => {
  const mutant = await mutantCheck([
    ['(f) => f !== null && f.split(\'/\').includes(\'..\') && !isCandidatePath(f),', '() => false,'],
  ]);
  const result = mutant.checkPublicRendererReadsNoPrivatePath(
    rendererRoot(`${PUBLIC_RENDERER_SRC}${TRAVERSAL_BESIDE_A_VARIABLE}\n`),
  );
  assert.equal(
    result.ok,
    true,
    'the case stayed red with the traversal test disabled, so that clause is not what refuses it',
  );
});

test('the must-fail control: the binding test is what refuses the shadowed name', async () => {
  const mutant = await mutantCheck([['if (declaresName(text, SUMMARY_CONST)) {', 'if (false) {']]);
  const result = mutant.checkPublicRendererReadsNoPrivatePath(rendererRoot(SHADOWED_RENDERER));
  assert.equal(
    result.ok,
    true,
    'the shadow stayed red with the binding test disabled, so the binding is not what refuses it',
  );
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
