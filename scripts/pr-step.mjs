#!/usr/bin/env node
/**
 * Job: pull-request (act.yml) — the only place in the design that opens a PR.
 *
 * contents: write, pull-requests: write, and no secret.
 *
 * Reporting goes to `main`; execution goes to an `agent/*` branch and then a
 * pull request. That split is what gives the execution path a revert unit: a bad
 * bump is one closed pull request rather than a commit in the middle of an
 * append-only history.
 *
 * When the sandbox ran, its outcome goes in the PR body. When it did not, the
 * PR says so — an untested bump must not read like a tested one.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPullRequest, postComment, getDefaultBranch } from '../lib/github.mjs';
import { appendRow, readRows } from '../lib/store.mjs';
import { findCommand, recordOutcome } from '../lib/commands.mjs';

const RUN_DIR = '.run';

function git(args, { allowFail = false } = {}) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr ?? res.stdout ?? ''}`);
  }
  return (res.stdout ?? '').trim();
}

function sandboxSection(env) {
  const result = env.SANDBOX_RESULT ?? 'skipped';
  if (result !== 'success') {
    return [
      '## Verification',
      '',
      '_Not run._ The sandbox is off, so this change was not executed before being proposed.',
      '',
      'Turn on `SANDBOX_ENABLED` to have the suite run in a container with no network, ' +
        'no credential and no write access before the PR is opened.',
    ].join('\n');
  }
  const exit = env.SANDBOX_EXIT ?? '';
  const log = (env.SANDBOX_LOG ?? '').slice(-1500);
  const passed = exit === '0';
  return [
    '## Verification',
    '',
    `Sandbox: **${passed ? 'passed' : `failed (exit ${exit})`}**`,
    '',
    'Executed in a container with no network, no credential and no write access.',
    '',
    '```',
    log || '(no output)',
    '```',
  ].join('\n');
}

async function main() {
  const env = process.env;
  const token = env.GITHUB_TOKEN;
  const verb = env.VERB ?? '';
  const packageName = env.PACKAGE ?? '';
  const version = env.VERSION ?? '';
  const branch = env.BRANCH ?? '';
  const issueNumber = Number(env.ISSUE_NUMBER ?? 0);
  const commentId = env.COMMENT_ID ?? null;

  const planPath = path.join(RUN_DIR, 'act.json');
  const plan = fs.existsSync(planPath) ? JSON.parse(fs.readFileSync(planPath, 'utf8')) : null;
  const patch = plan?.patch ?? '';
  const command = plan?.command ?? 'npm test --if-present';

  if (verb === 'verify') {
    // verify proposes nothing; it reports.
    const body = [sandboxSection(env), '', `Command: \`${command}\``].join('\n');
    if (issueNumber && token) await postComment(issueNumber, body, { token });
    const row = findCommand(commentId);
    if (row) recordOutcome(row, `verified:${env.SANDBOX_EXIT ?? 'skipped'}`);
    console.log('reported the verification outcome');
    return;
  }

  if (!patch) {
    console.log('nothing to propose');
    return;
  }

  git(['config', 'user.name', 'git-agent[bot]']);
  git(['config', 'user.email', 'git-agent[bot]@users.noreply.github.com']);

  // Start from the current HEAD, on a fresh branch.
  git(['switch', '-c', branch]);

  fs.mkdirSync(RUN_DIR, { recursive: true });
  const patchFile = path.join(RUN_DIR, 'change.patch');
  fs.writeFileSync(patchFile, patch.endsWith('\n') ? patch : patch + '\n', 'utf8');
  const applied = spawnSync('git', ['apply', '--verbose', patchFile], { encoding: 'utf8' });
  if (applied.status !== 0) {
    throw new Error(`the computed patch did not apply: ${applied.stderr ?? ''}`);
  }

  git(['add', '-A']);
  git(['commit', '-m', `bump ${packageName} to ${version}`]);
  git(['push', '-u', 'origin', branch]);

  const base = await getDefaultBranch({ token });
  const title = `bump ${packageName} to ${version}`;
  const body = [
    `Proposed by \`/agent ${verb} ${packageName}${version ? `@${version}` : ''}\`.`,
    '',
    sandboxSection(env),
    '',
    '---',
    '',
    'This branch is the revert unit: closing this pull request undoes the change.',
  ].join('\n');

  const pr = await createPullRequest({ title, head: branch, base, body }, { token });

  appendRow('history/events.jsonl', {
    at: new Date().toISOString(),
    kind: 'proposed',
    package: packageName,
    version,
    pull_request: pr.number ?? null,
    branch,
  });

  if (issueNumber && token) {
    await postComment(issueNumber, `Opened #${pr.number} — \`${branch}\`.`, { token });
  }

  const row = findCommand(commentId);
  if (row) recordOutcome(row, `proposed:${pr.number}`);

  console.log(`opened pull request #${pr.number}`);
}

main().catch((err) => {
  console.error(`::error::${err.message ?? String(err)}`);
  process.exit(1);
});
