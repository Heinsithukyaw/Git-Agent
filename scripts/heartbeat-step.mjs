#!/usr/bin/env node
/**
 * Job: heartbeat — the run that produced nothing still has to say so.
 *
 * This exists for one specific failure. In `digest.yml`, the `commit` job is
 * skipped when `fetch` fails, which is correct — there is no payload to write a
 * digest from. But it means the heartbeat does not move either, and a repository
 * whose scheduled workflow commits nothing for 60 days has its schedule
 * disabled by GitHub. The failure then becomes permanent, and it becomes
 * permanent *silently*, which is the worst version of it.
 *
 * So a failed run still writes:
 *
 *   - the heartbeat, with `consecutive_failures` incremented, which is the
 *     liveness signal a human can actually see in the README;
 *   - a row in `history/runs.jsonl`, because a run that produced nothing is
 *     still a run, and an audit trail that only records successes is not an
 *     audit trail.
 *
 * It holds `contents: write` and no secret, like every other writing job (I1).
 * It writes nothing outside the collector allowlist (I3).
 */

import fs from 'node:fs';
import { writeIfChanged, appendRun, verifyChain, readJson } from '../lib/store.mjs';
import { MARKER_BEGIN, MARKER_END } from '../lib/render.mjs';

const HEARTBEAT = 'data/heartbeat.json';
const RUNS = 'history/runs.jsonl';
const README = 'README.md';

function bump(status) {
  const prev = readJson(HEARTBEAT, {}) ?? {};
  const now = new Date().toISOString();
  const consecutive = status === 'ok' ? 0 : Number(prev.consecutive_failures ?? 0) + 1;
  return {
    last_run_at: now,
    last_status: status,
    consecutive_failures: consecutive,
    last_success_at: status === 'ok' ? now : (prev.last_success_at ?? null),
  };
}

/**
 * A failed run has no digest to render, so the README region states the failure
 * in place of a summary. Silence in the region would read as "nothing to
 * report", which is a different and false claim.
 */
function noteFailure(heartbeat, reason) {
  if (!fs.existsSync(README)) return;
  const existing = fs.readFileSync(README, 'utf8');
  const begin = existing.indexOf(MARKER_BEGIN);
  const end = existing.indexOf(MARKER_END);
  if (begin === -1 || end === -1 || end < begin) return;

  const section = [
    `### As of ${heartbeat.last_run_at}`,
    '',
    `**The last run did not complete.** ${reason}`,
    '',
    `- consecutive failures: ${heartbeat.consecutive_failures}`,
    `- last successful run: ${heartbeat.last_success_at ?? 'never recorded'}`,
    '',
  ].join('\n');

  const next = `${existing.slice(0, begin)}${MARKER_BEGIN}\n${section}${MARKER_END}${existing.slice(end + MARKER_END.length)}`;
  writeIfChanged(README, next);
}

function main() {
  const status = (process.env.HEARTBEAT_STATUS ?? 'failed').toLowerCase();
  const reason = process.env.HEARTBEAT_REASON ?? 'The fetch step produced no payload.';

  const heartbeat = bump(status);
  writeIfChanged(HEARTBEAT, heartbeat);

  appendRun(RUNS, {
    run_id: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    observed_at: heartbeat.last_run_at,
    status,
    narration: false,
    counts: { decisions: 0, act: 0, uncertain: 0 },
    sources_failed: null,
    reason,
  });

  const chain = verifyChain(RUNS);
  if (!chain.ok) throw new Error(`hash chain broken at row ${chain.brokenAt}`);

  if (status !== 'ok') noteFailure(heartbeat, reason);

  console.log(`heartbeat: ${status} · consecutive_failures=${heartbeat.consecutive_failures} · chain intact`);
}

try {
  main();
} catch (err) {
  // Even this job can fail. If it does, say so loudly rather than leaving a
  // stale heartbeat that looks like health.
  console.error(`::error::${err.message ?? String(err)}`);
  process.exit(1);
}
