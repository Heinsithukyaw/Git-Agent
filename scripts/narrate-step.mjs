#!/usr/bin/env node
/**
 * Job: narrate — the only job that holds the model key, and it holds no write
 * token. Its output is an artifact, not a commit.
 *
 * Two things happen here and they are independent:
 *
 *   1. **Triage.** Rules first; the optional typed layer only on what rules
 *      could not decide. This is the substance of the digest and it needs no
 *      model at all.
 *   2. **Narration.** Optional. If no endpoint is configured, this step writes
 *      no prose and the run proceeds with the deterministic digest. That is a
 *      complete product, not a degraded one.
 *
 * The narration is never committed here. It is an artifact that the `commit`
 * job validates against the payload before a single byte reaches git.
 */

import fs from 'node:fs';
import path from 'node:path';
import { triage } from '../lib/triage.mjs';
import { buildFacts, attachDecisions } from '../lib/render.mjs';
import { complete, isConfigured, narrationMessages, unfence, config, classifyFailure } from '../lib/llm.mjs';
import { probe, probeRecordForCommit } from '../lib/probe.mjs';

const RUN_DIR = '.run';
const NARRATION = path.join(RUN_DIR, 'narration.json');

function warn(message) {
  console.warn(`::warning::${message}`);
}

/**
 * Record what happened to the narration, on every exit path.
 *
 * This is the artifact that stops a broken narration from reading as a
 * deliberately keyless one. Without it, `commit-step` sees only "no prose.md"
 * and cannot tell the two apart — so a wrong key, a revoked key, a blocked
 * network or an exhausted budget all produce a digest that looks exactly like a
 * correctly configured instance that was never given a model. Silently, and
 * indefinitely, because nothing else in the run fails.
 *
 * An artifact, not a commit: this job holds the model key and no write token
 * (I1). `commit-step` decides what the reader is told.
 *
 * Only the status and a coarse kind are recorded — never the endpoint's response
 * body, which is not ours to publish. See `classifyFailure()`.
 *
 * **`user_agent` is recorded here and deliberately nowhere else.** A relay that
 * gates on client identity can refuse a request *before* reading the credential,
 * and its error names the client rather than the key — so "the key is wrong" and
 * "the identity you configured is no longer accepted" produce the same 401. The
 * identity is the one fact that separates them, and without it the artifact
 * cannot. It stays out of `history/runs.jsonl` and out of the digest because
 * those are committed: the identity names the infrastructure, and this
 * repository's rule is that the endpoint is the user's business, not the
 * template's.
 *
 * **Written before anything that can throw, and again on every path after it.**
 * The record's *presence* therefore means "this step ran", and its content means
 * what happened — so the provisional `kind: 'started'` below is not a
 * placeholder, it is the invariant. That matters across the job boundary:
 * `commit-step` reads this file, and it cannot use the platform's own signal
 * (`needs.narrate.result`) instead, because this job carries
 * `continue-on-error: true` and a job that died from an exception still reports
 * `success` to its consumers. Without the provisional write, a throw in
 * `readPayload()` or `triage()` leaves no record at all, and a broken narration
 * is byte-identical to a deliberately keyless instance — the one state this file
 * exists to separate.
 */
function recordNarration(record) {
  fs.writeFileSync(
    NARRATION,
    JSON.stringify({ recorded_at: new Date().toISOString(), model: null, ...record }, null, 2),
    'utf8',
  );
}

function readPayload() {
  const p = path.join(RUN_DIR, 'payload.json');
  if (!fs.existsSync(p)) throw new Error('payload artifact is missing — the fetch job did not produce one');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  // The provisional record, written before the first thing that can throw. Its
  // presence is what tells `commit-step` that this step ran at all; every path
  // below overwrites it. See `recordNarration()`.
  recordNarration({ configured: null, ok: false, kind: 'started' });

  const payload = readPayload();

  const typedEnabled = String(process.env.JEV_ENABLED ?? 'false').toLowerCase() === 'true';
  const typed = {
    enabled: typedEnabled,
    baseUrl: process.env.JEV_BASE_URL ?? '',
    apiKey: process.env.JEV_API_KEY ?? '',
    model: process.env.JEV_MODEL ?? '',
  };
  if (typedEnabled && (!typed.baseUrl || !typed.apiKey)) {
    warn('typed layer is enabled but not configured — falling back to rules only');
    typed.enabled = false;
  }

  const decisions = await triage(payload, { typed });
  fs.writeFileSync(path.join(RUN_DIR, 'decisions.json'), JSON.stringify(decisions, null, 2), 'utf8');
  console.log(
    `triaged ${decisions.length} advisory row(s): ` +
      `${decisions.filter((d) => d.decision === 'act').length} act, ` +
      `${decisions.filter((d) => d.decision === 'uncertain').length} uncertain`,
  );

  if (String(process.env.PROBE_ENDPOINT ?? 'false').toLowerCase() === 'true') {
    const record = await probe(process.env);
    // Projected before it is written: this file is uploaded as a workflow
    // artifact, and artifacts are readable on a public repository. See
    // `lib/probe.mjs`.
    fs.writeFileSync(
      path.join(RUN_DIR, 'endpoint.json'),
      JSON.stringify(probeRecordForCommit(record), null, 2),
      'utf8',
    );
    // The host is not printed and not recorded: this log is public on a public
    // repository, and the endpoint is the user's business (I8). What is worth
    // saying is whether anything was measured at all.
    console.log(
      record.configured
        ? `endpoint probe recorded: ${Object.values(record.capabilities ?? {}).filter(Boolean).length} of ` +
            `${Object.keys(record.capabilities ?? {}).length} capabilities confirmed`
        : 'endpoint probe recorded for an unconfigured endpoint',
    );
  }

  // Narration. Optional, and its absence is not an error — but "not configured"
  // and "configured and broken" are different states, and telling them apart is
  // the whole point of the record written on every path below.
  if (!isConfigured(process.env)) {
    console.log('no model endpoint configured — deterministic digest only');
    recordNarration({ configured: false, ok: false, kind: 'not-configured', status: null });
    return;
  }

  // The narrator's input is the payload with the decisions folded in — the same
  // document `commit-step` will gate the prose against, built by the same
  // function. This step does not write it: the gate's ground truth is assembled
  // in the job that holds no model key, not here.
  const facts = buildFacts(attachDecisions(payload, decisions));
  if (!facts.length) {
    console.log('nothing to narrate');
    recordNarration({ configured: true, ok: false, kind: 'nothing-to-narrate', status: null });
    return;
  }

  try {
    const { text, usage, model, status } = await complete({
      messages: narrationMessages({ facts, language: config(process.env).language }),
      env: process.env,
    });
    const prose = unfence(text).trim();
    fs.writeFileSync(path.join(RUN_DIR, 'prose.md'), prose + '\n', 'utf8');
    // The model name is recorded in the artifact, which is not committed, and
    // deliberately not printed here, which is. Same reason as the host above.
    console.log(`narrated ${prose.length} chars (${usage?.total_tokens ?? '?'} tokens)`);
    recordNarration({
      configured: true,
      ok: true,
      kind: null,
      status: status ?? null,
      model: model ?? null,
      user_agent: config(process.env).userAgent || null,
      tokens: usage?.total_tokens ?? null,
    });
  } catch (err) {
    // A narration failure must not fail the run. The digest is the product;
    // the prose is a layer on top of it. But it must not vanish either: the
    // record below is what makes it visible in the digest the user reads.
    //
    // The warning names the status, never the message. A gateway's 401 body
    // names the provider and can run to 400 characters, and this log is public
    // on a public repository — the same reduction the artifact carries, for the
    // same reason. See `classifyFailure()`.
    const classified = classifyFailure(err);
    warn(
      `narration failed (${classified.status ? `HTTP ${classified.status}` : classified.kind}) — ` +
        'proceeding without it',
    );
    recordNarration({
      configured: true,
      ok: false,
      ...classified,
      model: config(process.env).model || null,
      user_agent: config(process.env).userAgent || null,
    });
  }
}

main().catch((err) => {
  // The step threw, so nothing below the throw ran and no later record was
  // written. Record the crash here: this artifact is the only thing that crosses
  // the job boundary, and `needs.narrate.result` cannot stand in for it — the job
  // carries `continue-on-error: true`, which reports `success` for a job that
  // died. See `recordNarration()`.
  const classified = classifyFailure(err);
  try {
    recordNarration({
      configured: isConfigured(process.env),
      ok: false,
      kind: 'crashed',
      status: classified.status ?? null,
      // The error's *name*, never its message. A message can embed the
      // endpoint's response body — `triage.mjs` throws one that does — and this
      // artifact is committed.
      detail: err?.name ?? null,
    });
  } catch {
    // Best effort. If even the record cannot be written the run still fails
    // loudly below, which is the correct direction to fail in.
  }
  // The same reasoning applies to this line, which a public workflow log keeps
  // forever. An error carrying an HTTP status is an endpoint response and only
  // its status is printed; anything else is this repository's own error and its
  // message is the whole diagnosis.
  console.error(
    classified.status
      ? `::error::${err?.name ?? 'Error'}: the endpoint answered HTTP ${classified.status}`
      : `::error::${err?.message ?? String(err)}`,
  );
  process.exit(1);
});
