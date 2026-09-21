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
 *   3b. project the public surface — strictly after the gate, never before it
 *   4. always rewrite the heartbeat                    (the one exemption)
 *
 * If the gate fails, nothing is written except the heartbeat. The run fails
 * loudly, and the failure is visible in the log rather than in a bad commit.
 *
 * Step 3b's position is load-bearing in both directions. It must run after the
 * gate, because the gate's document is the payload *with the decisions folded
 * in* — the document the narrator read (I2) — and projecting first would hand
 * the gate a narrower document than the narrator saw. And it must run here
 * rather than in the renderer, because `pages.yml` downloads no artifact and so
 * `render-site.mjs` never has a payload to project.
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
import { probeRecordForCommit } from '../lib/probe.mjs';
import { buildPublicSurface, publicDigestPath, PUBLIC_SUMMARY } from '../lib/public-surface.mjs';
import {
  renderDigest,
  renderReadmeSection,
  renderSummary,
  replaceBetweenMarkers,
  diffEvents,
  attachDecisions,
  narrationGap,
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

  // Present is not the same as empty, and the difference is a whole failure
  // route. `decisions.json` is written by the triage stage in the narrate job
  // and reaches this job as an artifact, so its absence means the stage did not
  // deliver — not that it found nothing. Reading absence as `[]` is how a broken
  // pipeline published "0 to act on" and still reported `ok`.
  const decisionsPath = path.join(RUN_DIR, 'decisions.json');
  const decisionsDelivered = fs.existsSync(decisionsPath);
  const decisions = decisionsDelivered ? JSON.parse(fs.readFileSync(decisionsPath, 'utf8')) : [];

  const prosePath = path.join(RUN_DIR, 'prose.md');
  const narration = fs.existsSync(prosePath) ? fs.readFileSync(prosePath, 'utf8') : null;
  // What the narrate job recorded about the attempt, which is not derivable from
  // the absence of `prose.md`: not configured, configured and broken, and
  // nothing to narrate all look the same from here.
  //
  // Read from the artifact, never from `needs.narrate.result`. That job carries
  // `continue-on-error: true`, so the platform reports `success` for a job that
  // died from an exception — a signal that reads as authoritative and is not.
  // `narrate-step` writes this file on every path, including a top-level
  // `catch`, which is what makes its presence trustworthy. See
  // `narrate-step.mjs` → `recordNarration()`.
  const narrationStatus = readJsonIfExists(path.join(RUN_DIR, 'narration.json'));

  // The narrate stage's output is the substance of the digest, and every count
  // in it is arithmetic over the decision set. With no set, the digest would
  // publish "0 to act on" for a question nobody answered — in a security
  // product, the worst available failure mode, and one this repository has
  // already shipped once. So this takes the same route as a failed gate:
  // nothing is written except the heartbeat, which is the one file that must
  // always move (I4), or a broken agent goes silent and GitHub disables the
  // schedule after 60 days. The `heartbeat` job in `digest.yml` commits it.
  if (!decisionsDelivered || narrationStatus === null) {
    const missing = [
      decisionsDelivered ? null : '.run/decisions.json',
      narrationStatus === null ? '.run/narration.json' : null,
    ].filter(Boolean);
    throw new Error(
      `the narrate stage did not deliver its output (missing: ${missing.join(', ')}) — ` +
        'nothing was published except the heartbeat',
    );
  }

  // ---- 1. the gate -------------------------------------------------------
  const gated = { checked: null, narration: false };
  if (narration && narration.trim()) {
    // The prose is gated against the document the narrator was given — the
    // payload with the decisions folded in — assembled here, in the job that
    // holds no model key, by the same function `narrate-step` used. The narrator
    // and the gate read one document; they cannot drift apart.
    //
    // `derived` stays for the scalars the *renderer* computes and the narrator is
    // never shown (the counts in the digest header). Anything the narrator can
    // say is in the document already.
    const derived = [
      decisions.length,
      decisions.filter((d) => d.decision === 'act').length,
      decisions.filter((d) => d.decision === 'uncertain').length,
    ];
    assertGrounded(narration, attachDecisions(payload, decisions), { derived });
    gated.checked = true;
    gated.narration = true;
    console.log('containment gate: narration is grounded in the narrator\'s input');
  } else {
    console.log('containment gate: no narration to check (deterministic digest)');
  }

  // ---- 2. append-only records -------------------------------------------
  const observed = payload.observed_at ?? new Date().toISOString();
  for (const d of decisions) appendRow(TRIAGE, d);

  const events = diffEvents(previousDecisionSet(observed), decisions, { observed_at: observed });
  for (const e of events) appendRow(EVENTS, e);
  console.log(`${decisions.length} decision row(s), ${events.length} transition(s)`);

  // A narration that was configured and failed is a degradation, not a success.
  // It is not a *failure* either: the digest is correct and complete without it.
  // The judgement is `narrationGap()` in the renderer, not a local one, because
  // the digest prints the same verdict. A narration that answered 200 and
  // produced nothing but a title is a gap, and if this job disagreed, the digest
  // would carry a gap section while the heartbeat and the published page said
  // `ok`. The run record and the document must not contradict each other.
  //
  // The job result is deliberately not consulted. It was, once:
  // `NARRATE_RESULT === 'failure'` was the only route to `failed` and it was
  // unreachable, because the narrate job carries `continue-on-error: true`. The
  // signal is now the artifact, and the one case that *is* a failure — the stage
  // delivering nothing at all — is handled above, before anything is written.
  const narrationIsGap = narrationGap({ narration, narrationStatus });
  const status = narrationIsGap.gap || (payload.errors ?? []).length > 0 ? 'degraded' : 'ok';

  appendRun(RUNS, {
    run_id: process.env.GITHUB_RUN_ID ?? null,
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    observed_at: observed,
    status,
    narration: gated.narration,
    // Additive: `narration` above stays the boolean "was prose committed", which
    // is what the chain already records. This is the *why*.
    narration_status: narrationStatus
      ? {
          configured: Boolean(narrationStatus.configured),
          ok: Boolean(narrationStatus.ok),
          kind: narrationStatus.kind ?? null,
          status: narrationStatus.status ?? null,
        }
      : null,
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
  const digest = renderDigest({ payload, decisions, narration, narrationStatus, commands });
  const digestPath = path.join('digest', `${observed.slice(0, 10)}.md`);
  writeIfChanged(digestPath, digest);

  const readmeBefore = fs.existsSync(README) ? fs.readFileSync(README, 'utf8') : `# Git Agent\n`;
  const section = renderReadmeSection({ payload, decisions, heartbeat });
  writeIfChanged(README, replaceBetweenMarkers(readmeBefore, section));

  writeIfChanged(SUMMARY, renderSummary({ payload, decisions, heartbeat }));

  // ---- 3b. the public surface --------------------------------------------
  // Strictly after the gate. The gate read `attachDecisions(payload, decisions)`
  // above; this reads the same two documents and narrows them. Projecting before
  // the gate would hand it a document the narrator never saw, and every fact
  // about a withheld package would become ungroundable — I2's failure, mirrored.
  //
  // The marker lives in `data/stack.json`, which is committed, so the commit job
  // reads it from the checkout. An invalid marker fails closed: the public
  // surface is withheld and the private run is unaffected. A redaction control
  // must never be able to fail the product it protects.
  const stack = readJsonIfExists('data/stack.json');
  const publicSurface = buildPublicSurface({ payload, decisions, stack, heartbeat, commands });
  if (publicSurface.ok) {
    console.log(
      `public surface: ${publicSurface.summary.packages} package(s), ` +
        `${publicSurface.summary.drop.dropped} record(s) withheld`,
    );
  } else {
    // The entries are logged here and deliberately not written to the public
    // surface: a violation names a policy entry, and a mistyped entry can be a
    // private name.
    for (const v of publicSurface.violations) {
      console.warn(
        `::warning::publication marker: ${v.list}${v.entry !== undefined ? ` entry ${JSON.stringify(v.entry)}` : ''} — ${v.error}`,
      );
    }
    console.warn(
      `::warning::${publicSurface.violations.length} marker violation(s) — the public surface is withheld, ` +
        'the private run is unaffected',
    );
  }
  writeIfChanged(publicDigestPath(observed), publicSurface.digest);
  writeIfChanged(PUBLIC_SUMMARY, publicSurface.summary);

  // Projected, not copied. `data/endpoint.json` is committed and this repository
  // may be public, so what lands here is an allowlist rather than whatever the
  // probe returned — the same shape as the write allowlist (I3), and the half
  // that is actually load-bearing. `checkNoEndpointDisclosure()` re-checks the
  // committed file, which is what catches a regression in *this* projection
  // (a field wrongly added to the allowlist) rather than in the probe.
  const endpoint = readJsonIfExists(path.join(RUN_DIR, 'endpoint.json'));
  if (endpoint) writeIfChanged('data/endpoint.json', probeRecordForCommit(endpoint));

  // ---- 4. the heartbeat, always ------------------------------------------
  writeIfChanged(HEARTBEAT, heartbeat);

  // Per-item hashes make the change gate explicit and auditable. It hashes the
  // state files, not itself, so a run that changed nothing leaves it identical.
  const hashes = {};
  for (const rel of [SUMMARY, PUBLIC_SUMMARY, 'data/stack.json', 'data/endpoint.json', HEARTBEAT]) {
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
