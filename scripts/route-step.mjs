#!/usr/bin/env node
/**
 * Job: route (ask.yml) — author gate, grammar, idempotency, and every lookup.
 *
 * contents: write and issues: write, and **no secret**. That combination is the
 * point: this job reads attacker-controlled text, so it must not be able to
 * spend a key. It also never passes the comment body to a model — the body is
 * parsed by regex, and only the parsed argument can ever leave this job.
 *
 * Write verbs (`bump`, `verify`) are deliberately not handled here. They belong
 * to act.yml, which has a different permission set. The two workflows fire on
 * the same comment and each ignores what the other owns.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  parse,
  validate,
  assertAuthor,
  alreadyHandled,
  recordIntent,
  recordOutcome,
  WRITE_VERBS,
  MODEL_VERBS,
  CommandError,
} from '../lib/commands.mjs';
import { renderReply, renderError } from '../lib/render.mjs';
import { readRows, appendRow } from '../lib/store.mjs';
import { postComment, setOutput } from '../lib/github.mjs';

const RUN_DIR = '.run';
const TRIAGE = 'data/triage.jsonl';
const EVENTS = 'history/events.jsonl';
const LABELS = 'data/labels.jsonl';
const SCHEDULE = 'data/schedule.json';

/** Decisions from the most recent observation, not all of history. */
function latestDecisions() {
  const rows = readRows(TRIAGE);
  if (!rows.length) return [];
  const latest = rows[rows.length - 1].observed_at;
  return rows.filter((r) => r.observed_at === latest);
}

function knownAdvisoryIds(decisions) {
  return [...new Set(decisions.map((d) => d.advisory_id).filter(Boolean))];
}

function outputs(map) {
  for (const [k, v] of Object.entries(map)) setOutput(k, v);
}

async function main() {
  const env = process.env;
  const body = env.COMMENT_BODY ?? '';
  const commentId = env.COMMENT_ID ?? null;
  const author = env.COMMENT_AUTHOR ?? 'unknown';
  const association = env.COMMENT_ASSOCIATION ?? 'NONE';
  const issueNumber = Number(env.ISSUE_NUMBER ?? 0);
  const token = env.GITHUB_TOKEN;

  outputs({ needs_model: 'false', verb: '', comment_id: commentId ?? '', issue_number: issueNumber || '' });

  // Rule 1. Not a warning, not a label — an exit, and no reply either. A
  // stranger gets no acknowledgement and no acknowledgement-shaped response.
  try {
    assertAuthor(association);
  } catch {
    console.log(`ignored: author association "${association}" is not OWNER, MEMBER or COLLABORATOR`);
    return;
  }

  // Rule 2. Grammar, not model.
  let parsed;
  try {
    parsed = parse(body);
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    // A comment that is not a command at all is not an error worth replying to.
    if (err.code === 'not-a-command' || err.code === 'empty') {
      console.log('ignored: not a command');
      return;
    }
    if (issueNumber && token) {
      await postComment(issueNumber, renderError(err), { token });
    }
    console.log(`rejected: ${err.code}`);
    return;
  }

  // Write verbs belong to act.yml.
  if (WRITE_VERBS.has(parsed.verb)) {
    console.log(`ignored: ${parsed.verb} is handled by act.yml`);
    return;
  }

  // Rule 4. Idempotency — checked before anything acts.
  if (alreadyHandled(commentId, { verb: parsed.verb })) {
    console.log(`ignored: comment ${commentId} / ${parsed.verb} already recorded`);
    return;
  }

  let validated;
  try {
    validated = validate(parsed, { knownIds: knownAdvisoryIds(latestDecisions()) });
  } catch (err) {
    if (!(err instanceof CommandError)) throw err;
    const row = recordIntent({ comment_id: commentId, author, verb: parsed.verb, arg: parsed.arg, issue: issueNumber });
    recordOutcome(row, `rejected:${err.code}`);
    if (issueNumber && token) await postComment(issueNumber, renderError(err), { token });
    console.log(`rejected: ${err.code} — ${err.message}`);
    return;
  }

  // The row is written before the action. A crash mid-action leaves a row saying
  // the command was seen, so a retry stops rather than repeating.
  const row = recordIntent({
    comment_id: commentId,
    author,
    verb: validated.verb,
    arg: validated.arg,
    issue: issueNumber,
  });

  // The one verb that needs a model. It produces no reply here — the answer is
  // generated in a job that holds the key and no write token, then gated here.
  if (MODEL_VERBS.has(validated.verb)) {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RUN_DIR, 'ask-context.json'),
      JSON.stringify(
        {
          comment_id: commentId,
          issue_number: issueNumber,
          author,
          verb: validated.verb,
          arg: validated.arg,
        },
        null,
        2,
      ),
      'utf8',
    );
    outputs({ needs_model: 'true', verb: validated.verb });
    console.log(`routed ${validated.verb} to the model job`);
    return;
  }

  // --- the lookups. No model is called for any of these. -------------------
  const decisions = latestDecisions();
  let result = 'answered';

  if (validated.verb === 'wrong') {
    // The calibration corpus. A label is a human disagreeing with a machine,
    // and it is the only signal that makes the system better over time.
    appendRow(LABELS, {
      at: new Date().toISOString(),
      package: validated.name,
      version: validated.version,
      author,
      comment_id: commentId,
      decision_at_the_time: decisions.find((d) => d.package === validated.name)?.decision ?? null,
    });
  } else if (validated.verb === 'pause' || validated.verb === 'resume') {
    // The schedule toggle is a state in the repository, not a flag in a job,
    // because a job has no memory between runs.
    fs.writeFileSync(
      SCHEDULE,
      JSON.stringify({ state: validated.verb === 'pause' ? 'paused' : 'active', updated_at: new Date().toISOString(), by: author }, null, 2) + '\n',
      'utf8',
    );
  }

  const reply = renderReply({
    verb: validated.verb,
    arg: validated.arg ?? validated,
    decisions,
    events: readRows(EVENTS).slice(-100),
    commands: readRows('history/commands.jsonl').slice(-10),
  });

  if (issueNumber && token) {
    await postComment(issueNumber, reply, { token });
  } else {
    console.log('--- reply ---\n' + reply + '\n-------------');
  }

  recordOutcome(row, result);
  console.log(`answered ${validated.verb}`);
}

main().catch((err) => {
  console.error(`::error::${err.message ?? String(err)}`);
  process.exit(1);
});
