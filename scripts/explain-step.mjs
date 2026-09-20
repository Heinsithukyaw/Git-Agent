#!/usr/bin/env node
/**
 * Job: explain (ask.yml) — the only job in the whole design that calls a model
 * in response to a human.
 *
 * contents: read, and it holds the key. It holds **no write token**, so a
 * hijacked model output cannot become a comment, a commit or a pull request
 * from here. Its entire output is one artifact, which the `reply` job gates
 * before anything is published.
 *
 * What it may use as context is narrow on purpose: the stored decision record,
 * and nothing else. Seven of the eight verbs are lookups precisely so that this
 * job is rare.
 */

import fs from 'node:fs';
import path from 'node:path';
import { complete, isConfigured, unfence, config, classifyFailure } from '../lib/llm.mjs';
import { readRows } from '../lib/store.mjs';
import { explainFacts } from '../lib/render.mjs';

const RUN_DIR = '.run';
const TRIAGE = 'data/triage.jsonl';

function latestDecisions() {
  const rows = readRows(TRIAGE);
  if (!rows.length) return [];
  const latest = rows[rows.length - 1].observed_at;
  return rows.filter((r) => r.observed_at === latest);
}

async function main() {
  const ctxPath = path.join(RUN_DIR, 'ask-context.json');
  if (!fs.existsSync(ctxPath)) throw new Error('ask-context artifact is missing');
  const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));

  const decisions = latestDecisions();
  const record = decisions.find((d) => d.advisory_id === ctx.arg);
  if (!record) throw new Error(`no stored decision for ${ctx.arg}`);

  if (!isConfigured(process.env)) {
    // No endpoint configured: write nothing. The reply job renders the stored
    // record on its own, which is a complete and honest answer.
    console.log('no model endpoint configured — the reply will be the stored record only');
    return;
  }

  // Built in `lib/render.mjs` beside `buildFacts`, so the fact list and the
  // document the gate grounds it against live in one place and cannot drift.
  const facts = explainFacts(record);

  const { text } = await complete({
    messages: [
      {
        role: 'system',
        content:
          `You are explaining a stored dependency decision to the engineer who owns the repository.\n` +
          `Use ONLY the facts listed. Do not introduce an advisory id, a package name, a version ` +
          `number or a quantity that is not in the list. If something is not in the list, say it ` +
          `is not recorded.\n` +
          `Be concrete. No preamble. Write in ${config(process.env).language}. Keep identifiers ` +
          `and version strings exactly as written.`,
      },
      {
        role: 'user',
        content: `The stored record:\n${facts.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nExplain it.`,
      },
    ],
    env: process.env,
    maxTokens: 700,
  });

  fs.writeFileSync(path.join(RUN_DIR, 'answer.md'), unfence(text).trim() + '\n', 'utf8');
  console.log(`explained ${ctx.arg} in ${text.length} chars`);
}

main().catch((err) => {
  // The same reduction `narrate-step` applies, and for the same reason: a
  // `complete()` failure carries up to 400 characters of the endpoint's response
  // body in its message, and this log is public on a public repository. The
  // status is the diagnosis; the body is the endpoint's text, not ours.
  const classified = classifyFailure(err);
  console.error(
    classified.status
      ? `::error::${err?.name ?? 'Error'}: the endpoint answered HTTP ${classified.status}`
      : `::error::${err?.message ?? String(err)}`,
  );
  process.exit(1);
});
