#!/usr/bin/env node
/**
 * Job: commit — the job that writes, and the job that holds no key.
 *
 * Both facts are load-bearing. The containment gate runs here, which means the
 * component that decides what gets written is the component no prompt injection
 * can reach: it never talks to a model, so no injected text can reach it.
 *
 * Order matters:
 *   1. gate the narration against the payload          (fail closed)
 *   2. append decision records and events              (append-only)
 *   3. render the digest, the README region, the summary
 *   4. always rewrite the heartbeat                    (the one exemption)
 *
 * If the gate fails, nothing is written except the heartbeat. The run fails
 * loudly, and the failure is visible in the log rather than in a bad commit.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  writeIfChanged,
  appendRow,
  appendRun,
  readRows,
  verifyChain,
  sha256,
  COLLECTOR_ALLOWLIST,
} from '../lib/store.mjs';
import { assertGrounded } from '../lib/gate.mjs';
import {
  renderDigest,
  renderReadmeSection,
  renderSummary,
  replaceBetweenMarkers,
  diffEvents,
  MARKER_BEGIN,
  MARKER_END,
} from '../lib/render.mjs';

const RUN_DIR = '.run';
const EVENTS = 'history/events.jsonl';
const RUNS = 'history/runs.jsonl';
const TRIAGE = 'data/triage.jsonl';
const HEARTBEAT = 'data/heartbeat.json';
const SUMMARY = 'data/summary.json';
const HASHES = 'data/state-hashes.json';
const README = 'README.md';

function readJsonIfExists(p) {
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function previousDecisionSet(currentObserved) {
  const rows = readRows(TRIAGE).filter((r) => r.observed_at && r.observed_at < currentObserved);
  if (!rows.length) return [];
  const latest = rows[rows.length - 1].observed_at;
  return rows.filter((r) => r.observed_at === latest);
}

function bumpHeartbeat(status) {
  const prev = readJsonIfExists(HEARTBEAT) ?? {};
  const now = new Date().toISOString();
  const consecutive = status === 'ok' ? 0 : (Number(prev.consecutive_failures ?? 0) + 1);
  return {
    last_run_at: now,
    last_status: status,
    consecutive_failures: consecutive,
    last_success_at: status === 'ok' ? now : (prev.last_success_at ?? null),
  };
}

async function main() {
  const payload = readJsonIfExists(path.join(RUN_DIR, 'payload.json'));
  if (!payload) throw new Error('payload artifact is missing');
  const decisions = readJsonIfExists(path.join(RUN_DIR, 'decisions.json')) ?? [];
  const prosePath = path.join(RUN_DIR, 'prose.md');
  const narration = fs.existsSync(prosePath) ? fs.readFileSync(prosePath, 'utf8') : null;

  // ---- 1. the gate -------------------------------------------------------
  const gated = { checked: null, narration: false };
  if (narration && narration.trim()) {
    // derived: the scalars the renderer computed itself. These are arithmetic
    // over the payload, not invention — but they must be passed, not assumed.
    const derived = [
      decisions.length,
      decisions.filter((d) => d.decision === 'act').length,
      decisions.filter((d) => d.decision === 'uncertain').length,
      (payload.packages ?? []).length,
      (payload.advisories ?? []).length,
      (payload.releases ?? []).length,
      (payload.errors ?? []).length,
    ];
    assertGrounded(narration, payload, { derived });
    gated.checked = true;
    gated.narration = true;
    console.log('containment gate: narration is grounded in the payload');
  } else {
    console.log('containment gate: no narration to check (deterministic digest)');
  }

  // ---- 2. append-only records -------------------------------------------
  const observed = payload.observed_at ?? new Date().toISOString();
  for (const d of decisions) appendRow(TRIAGE, d);

  const events = diffEvents(previousDecisionSet(observed), decisions, { observed_at: observed });
  for (const e of events) appendRow(EVENTS, e);
  console.log(`${decisions.length} decision row(s), ${events.length} transition(s)`);

  const narrateResult = process.env.NARRATE_RESULT ?? 'skipped';
  const status =
    narrateResult === 'failure' || (payload.errors ?? []).length > 0
      ? narrateResult === 'failure'
        ? 'failed'
        : 'degraded'
      : 'ok';

  appendRun(RUNS, {
    run_id: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    observed_at: observed,
    status,
    narration: gated.narration,
    counts: {
      decisions: decisions.length,
      act: decisions.filter((d) => d.decision === 'act').length,
      uncertain: decisions.filter((d) => d.decision === 'uncertain').length,
    },
    sources_failed: (payload.errors ?? []).length,
  });

  const chain = verifyChain(RUNS);
  if (!chain.ok) throw new Error(`hash chain broken at row ${chain.brokenAt}`);
  console.log(`hash chain intact (${chain.rows ?? 0} row(s))`);

  // ---- 3. surfaces -------------------------------------------------------
  const heartbeat = bumpHeartbeat(status);
  const commands = readRows('history/commands.jsonl').slice(-10);
  const digest = renderDigest({ payload, decisions, narration, commands });
  const digestPath = path.join('digest', `${observed.slice(0, 10)}.md`);
  writeIfChanged(digestPath, digest);

  const readmeBefore = fs.existsSync(README) ? fs.readFileSync(README, 'utf8') : `# Git Agent\n`;
  const section = renderReadmeSection({ payload, decisions, heartbeat });
  writeIfChanged(README, replaceBetweenMarkers(readmeBefore, section));

  writeIfChanged(SUMMARY, renderSummary({ payload, decisions, heartbeat }));

  const endpoint = readJsonIfExists(path.join(RUN_DIR, 'endpoint.json'));
  if (endpoint) writeIfChanged('data/endpoint.json', endpoint);

  // ---- 4. the heartbeat, always ------------------------------------------
  writeIfChanged(HEARTBEAT, heartbeat);

  // Per-item hashes make the change gate explicit and auditable. It hashes the
  // state files, not itself, so a run that changed nothing leaves it identical.
  const hashes = {};
  for (const rel of [SUMMARY, 'data/stack.json', 'data/endpoint.json', HEARTBEAT]) {
    if (fs.existsSync(rel)) hashes[rel] = sha256(fs.readFileSync(rel, 'utf8'));
  }
  writeIfChanged(HASHES, hashes);

  console.log(`status: ${status} · heartbeat consecutive_failures=${heartbeat.consecutive_failures}`);
  console.log(`write allowlist: ${COLLECTOR_ALLOWLIST.join(', ')}`);
}

main().catch((err) => {
  console.error(`::error::${err.message ?? String(err)}`);
  // The heartbeat is written even on failure. That is the whole point of the
  // exemption: a broken agent must keep committing, or a quiet repository
  // gets its schedule disabled after 60 days and the failure becomes permanent.
  try {
    writeIfChanged(HEARTBEAT, bumpHeartbeat('failed'));
    console.error('heartbeat written despite failure');
  } catch (inner) {
    console.error(`heartbeat could not be written: ${inner.message}`);
  }
  process.exit(1);
});

export { MARKER_BEGIN, MARKER_END };
