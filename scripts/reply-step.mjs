#!/usr/bin/env node
/**
 * Job: reply (ask.yml) — gate, then publish.
 *
 * contents: write, issues: write, and **no secret**. The gate runs here for the
 * same reason it runs in the digest's `commit` job: the component that decides
 * what gets published is the component a hijacked model output cannot reach.
 *
 * If the gate fails, nothing is posted. The run fails loudly instead, which is
 * the correct outcome for an answer that would have invented a fact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { assertGrounded } from '../lib/gate.mjs';
import { renderReply } from '../lib/render.mjs';
import { readRows, appendRow } from '../lib/store.mjs';
import { findCommand, recordOutcome } from '../lib/commands.mjs';
import { postComment } from '../lib/github.mjs';

const RUN_DIR = '.run';
const TRIAGE = 'data/triage.jsonl';
const LABELS = 'data/labels.jsonl';

function latestDecisions() {
  const rows = readRows(TRIAGE);
  if (!rows.length) return [];
  const latest = rows[rows.length - 1].observed_at;
  return rows.filter((r) => r.observed_at === latest);
}

async function main() {
  const ctxPath = path.join(RUN_DIR, 'ask-context.json');
  const ctx = fs.existsSync(ctxPath) ? JSON.parse(fs.readFileSync(ctxPath, 'utf8')) : null;
  const answerPath = path.join(RUN_DIR, 'answer.md');
  const modelAnswer = fs.existsSync(answerPath) ? fs.readFileSync(answerPath, 'utf8') : null;

  const issueNumber = Number(ctx?.issue_number ?? process.env.ISSUE_NUMBER ?? 0);
  const token = process.env.GITHUB_TOKEN;
  const commentId = ctx?.comment_id ?? process.env.COMMENT_ID ?? null;
  const arg = ctx?.arg ?? null;
  const decisions = latestDecisions();

  // The gate. Grounded against the stored decision record, because `explain`
  // argues from a record rather than from a freshly fetched payload.
  if (modelAnswer && modelAnswer.trim()) {
    const record = decisions.find((d) => d.advisory_id === arg) ?? null;
    const ground = record
      ? { record, stack: JSON.parse(fs.existsSync('data/stack.json') ? fs.readFileSync('data/stack.json', 'utf8') : '{}') }
      : { record: {}, stack: {} };
    assertGrounded(modelAnswer, ground, { derived: [] });
    console.log('containment gate: the answer is grounded in the stored record');
  }

  const reply = renderReply({ verb: 'explain', arg, decisions, modelAnswer });

  if (issueNumber && token) {
    await postComment(issueNumber, reply, { token });
  } else {
    console.log('--- reply ---\n' + reply + '\n-------------');
  }

  // Labels: the calibration corpus accrues one row per explained-and-corrected
  // advisory, which is what the threshold is eventually tuned against.
  appendRow(LABELS, {
    at: new Date().toISOString(),
    advisory_id: arg,
    explained: Boolean(modelAnswer),
    grounded: Boolean(modelAnswer),
    comment_id: commentId,
  });

  const row = findCommand(commentId);
  if (row) recordOutcome(row, 'answered:explain');

  console.log('posted the answer');
}

main().catch((err) => {
  console.error(`::error::${err.message ?? String(err)}`);
  process.exit(1);
});
