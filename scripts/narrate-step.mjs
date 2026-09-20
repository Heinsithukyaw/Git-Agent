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
import { complete, isConfigured, narrationMessages, unfence, config } from '../lib/llm.mjs';
import { probe } from '../lib/probe.mjs';

const RUN_DIR = '.run';

function warn(message) {
  console.warn(`::warning::${message}`);
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

  // Narration. Optional, and its absence is not an error.
  if (!isConfigured(process.env)) {
    console.log('no model endpoint configured — deterministic digest only');
    return;
  }

  const facts = buildFacts(payload, decisions);
  if (!facts.length) {
    console.log('nothing to narrate');
    return;
  }

  try {
    const { text, usage, model } = await complete({
      messages: narrationMessages({ facts, language: config(process.env).language }),
      env: process.env,
    });
    const prose = unfence(text).trim();
    fs.writeFileSync(path.join(RUN_DIR, 'prose.md'), prose + '\n', 'utf8');
    console.log(`narrated ${prose.length} chars (model ${model ?? 'unknown'}, ${usage?.total_tokens ?? '?'} tokens)`);
  } catch (err) {
    // A narration failure must not fail the run. The digest is the product;
    // the prose is a layer on top of it.
    warn(`narration failed (${err.message}) — proceeding without it`);
  }
}

main().catch((err) => {
  console.error(`::error::${err.message ?? String(err)}`);
  process.exit(1);
});
