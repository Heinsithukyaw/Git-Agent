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
import { buildFacts } from '../lib/render.mjs';
import { complete, isConfigured, narrationMessages, unfence, config, classifyFailure } from '../lib/llm.mjs';
import { probe } from '../lib/probe.mjs';

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
    fs.writeFileSync(path.join(RUN_DIR, 'endpoint.json'), JSON.stringify(record, null, 2), 'utf8');
    console.log(`endpoint probe recorded for ${record.host ?? 'an unconfigured endpoint'}`);
  }

  // Narration. Optional, and its absence is not an error — but "not configured"
  // and "configured and broken" are different states, and telling them apart is
  // the whole point of the record written on every path below.
  if (!isConfigured(process.env)) {
    console.log('no model endpoint configured — deterministic digest only');
    recordNarration({ configured: false, ok: false, kind: 'not-configured', status: null });
    return;
  }

  const facts = buildFacts(payload, decisions);
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
    console.log(`narrated ${prose.length} chars (model ${model ?? 'unknown'}, ${usage?.total_tokens ?? '?'} tokens)`);
    recordNarration({
      configured: true,
      ok: true,
      kind: null,
      status: status ?? null,
      model: model ?? null,
      tokens: usage?.total_tokens ?? null,
    });
  } catch (err) {
    // A narration failure must not fail the run. The digest is the product;
    // the prose is a layer on top of it. But it must not vanish either: the
    // record below is what makes it visible in the digest the user reads.
    warn(`narration failed (${err.message}) — proceeding without it`);
    recordNarration({
      configured: true,
      ok: false,
      ...classifyFailure(err),
      model: config(process.env).model || null,
    });
  }
}

main().catch((err) => {
  console.error(`::error::${err.message ?? String(err)}`);
  process.exit(1);
});
