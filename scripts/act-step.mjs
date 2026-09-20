#!/usr/bin/env node
/**
 * Job: plan (act.yml) — validate a write verb and compute the change.
 *
 * contents: write, pull-requests: write, and no secret. It must not hold a key:
 * it reads a comment body and it can open a pull request.
 *
 * Non-write verbs are ignored here; ask.yml owns those. Both workflows fire on
 * the same comment and each skips what the other handles.
 *
 * Scope, stated plainly: `bump` edits a manifest **in this repository**, whose
 * path is declared per package in `data/stack.json`. The agent cannot bump a
 * repository it does not contain — it says so instead of pretending.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parse,
  validate,
  assertAuthor,
  alreadyHandled,
  recordIntent,
  recordOutcome,
  WRITE_VERBS,
  CommandError,
} from '../lib/commands.mjs';
import { renderError } from '../lib/render.mjs';
import { postComment, setOutput } from '../lib/github.mjs';
import { enabled as sandboxEnabled } from '../lib/sandbox.mjs';
import * as v from '../lib/version.mjs';

const RUN_DIR = '.run';

function setInPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  return obj;
}

function getInPath(obj, dotted) {
  return dotted.split('.').reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

/** Unified diff via `diff -u`. Arguments only — never a shell string. */
function unifiedDiff(beforePath, afterPath, label) {
  const res = spawnSync(
    'diff',
    ['-u', '--label', `a/${label}`, '--label', `b/${label}`, beforePath, afterPath],
    { encoding: 'utf8' },
  );
  // diff exits 1 when files differ, which is the case we want.
  if (res.error) throw new Error(`diff unavailable: ${res.error.message}`);
  return res.stdout ?? '';
}

function blank() {
  setOutput('verb', '');
  setOutput('package', '');
  setOutput('version', '');
  setOutput('branch', '');
  setOutput('patch_b64', '');
  setOutput('command_b64', '');
  setOutput('sandbox', 'false');
  setOutput('network', 'none');
}

async function main() {
  const env = process.env;
  const body = env.COMMENT_BODY ?? '';
  const commentId = env.COMMENT_ID ?? null;
  const author = env.COMMENT_AUTHOR ?? 'unknown';
  const association = env.COMMENT_ASSOCIATION ?? 'NONE';
  const issueNumber = Number(env.ISSUE_NUMBER ?? 0);
  const token = env.GITHUB_TOKEN;

  blank();

  try {
    assertAuthor(association);
  } catch {
    console.log(`ignored: author association "${association}" is not OWNER, MEMBER or COLLABORATOR`);
    return;
  }

  let parsed;
  try {
    parsed = parse(body);
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    if (err.code === 'not-a-command' || err.code === 'empty') return;
    console.log(`rejected: ${err.code}`);
    return;
  }

  if (!WRITE_VERBS.has(parsed.verb)) {
    console.log(`ignored: ${parsed.verb} is handled by ask.yml`);
    return;
  }

  if (alreadyHandled(commentId, { verb: parsed.verb })) {
    console.log(`ignored: comment ${commentId} / ${parsed.verb} already recorded`);
    return;
  }

  let validated;
  try {
    validated = validate(parsed, {});
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    const row = recordIntent({ comment_id: commentId, author, verb: parsed.verb, arg: parsed.arg, issue: issueNumber });
    recordOutcome(row, `rejected:${err.code}`);
    if (issueNumber && token) await postComment(issueNumber, renderError(err), { token });
    return;
  }

  const row = recordIntent({
    comment_id: commentId,
    author,
    verb: validated.verb,
    arg: validated.arg,
    issue: issueNumber,
  });

  const stack = JSON.parse(fs.readFileSync(path.join('data', 'stack.json'), 'utf8'));
  const pkg = (stack.packages ?? []).find((p) => p.name === validated.name);
  const sandboxConf = stack.sandbox ?? {};
  const command = pkg?.verify_command ?? sandboxConf.command ?? 'npm test --if-present';

  let patch = '';
  let version = validated.version ?? null;

  if (validated.verb === 'bump') {
    if (!pkg?.manifest || !pkg?.decl) {
      await postComment(
        issueNumber,
        `\`${validated.name}\` has no \`manifest\` or \`decl\` in \`data/stack.json\`, so there is ` +
          `nothing in this repository for me to bump. I watch it; I do not contain it.`,
        { token },
      );
      recordOutcome(row, 'rejected:not-in-this-repository');
      return;
    }
    const manifestPath = pkg.manifest;
    if (!fs.existsSync(manifestPath)) {
      recordOutcome(row, 'rejected:manifest-missing');
      throw new Error(`manifest ${manifestPath} does not exist`);
    }
    const original = fs.readFileSync(manifestPath, 'utf8');
    const doc = JSON.parse(original);
    const current = getInPath(doc, pkg.decl);

    // No version given: take the smallest fixed version greater than the pin.
    if (!version) {
      const upgrade = pkg.upgrade_to ?? null;
      if (!upgrade) {
        await postComment(
          issueNumber,
          `No target version given and \`${validated.name}\` has no \`upgrade_to\` in ` +
            `\`data/stack.json\`. Try \`/agent bump ${validated.name}@<version>\`.`,
          { token },
        );
        recordOutcome(row, 'rejected:no-target-version');
        return;
      }
      version = upgrade;
    }
    if (current && !v.gt(version, String(current))) {
      await postComment(
        issueNumber,
        `\`${version}\` is not newer than the pinned \`${current}\`. Nothing to do.`,
        { token },
      );
      recordOutcome(row, 'rejected:not-an-upgrade');
      return;
    }

    setInPath(doc, pkg.decl, version);
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const before = path.join(RUN_DIR, 'before.json');
    const after = path.join(RUN_DIR, 'after.json');
    fs.writeFileSync(before, original, 'utf8');
    fs.writeFileSync(after, JSON.stringify(doc, null, detectIndent(original)) + '\n', 'utf8');
    patch = unifiedDiff(before, after, manifestPath);
    if (!patch) {
      recordOutcome(row, 'no-op');
      console.log('the manifest did not change');
      return;
    }
  }

  const branch = `agent/${validated.verb}-${String(validated.name).replace(/[^a-z0-9-_]/gi, '-')}` +
    (version ? `-${String(version).replace(/[^a-z0-9.-]/gi, '')}` : '');

  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(RUN_DIR, 'act.json'),
    JSON.stringify({ verb: validated.verb, package: validated.name, version, branch, patch, command }, null, 2),
    'utf8',
  );

  setOutput('verb', validated.verb);
  setOutput('package', validated.name);
  setOutput('version', version ?? '');
  setOutput('branch', branch);
  setOutput('patch_b64', Buffer.from(patch, 'utf8').toString('base64'));
  setOutput('command_b64', Buffer.from(command, 'utf8').toString('base64'));
  setOutput('sandbox', sandboxEnabled(env) ? 'true' : 'false');
  setOutput('network', sandboxConf.network === 'bridge' ? 'bridge' : 'none');

  recordOutcome(row, 'planned');
  console.log(`planned ${validated.verb} ${validated.name}${version ? `@${version}` : ''} on ${branch}`);
}

function detectIndent(text) {
  const m = text.match(/^(\s+)"[^"]+":/m);
  return m ? m[1].length : 2;
}

main().catch((err) => {
  console.error(`::error::${err.message ?? String(err)}`);
  process.exit(1);
});
