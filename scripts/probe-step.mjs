#!/usr/bin/env node
/**
 * Job: probe — measure the endpoint, once, when asked.
 *
 * Deliberately not part of the daily path. Probing an endpoint you do not own
 * is a request you do not need to make, and doing it every run is the kind of
 * habit that grows into fingerprinting. The daily run reads the recorded
 * result; only this step produces it.
 *
 * Three rules it exists to enforce:
 *
 *   1. **Only on request.** `PROBE_ENDPOINT=true` (the dispatch input) or an
 *      explicit `--force`.
 *   2. **The credential is masked before it is used.** A third-party key is not
 *      on the platform's auto-redaction list, so it is registered here.
 *   3. **Record what the endpoint does, never which endpoint it is.** The record
 *      is committed as `data/endpoint.json` and also travels as a workflow
 *      artifact, and both are readable on a public repository. Neither the host
 *      nor the model is stored or printed — the endpoint is the user's own
 *      business (I8). See `lib/probe.mjs` for what that costs and why it wins.
 *
 * A probe failure is not a run failure. It writes a record saying what failed
 * and exits 0, because the point is to know, not to pass.
 */

import fs from 'node:fs';
import path from 'node:path';
import { probe } from '../lib/probe.mjs';

const RUN_DIR = '.run';

function requested(env) {
  if (process.argv.includes('--force')) return true;
  return String(env.PROBE_ENDPOINT ?? 'false').toLowerCase() === 'true';
}

async function main() {
  const env = process.env;

  if (!requested(env)) {
    console.log('probe not requested — set PROBE_ENDPOINT=true or pass --force');
    return;
  }

  // Rule 2. Registered before the first call, not after the first log line.
  for (const name of ['LLM_API_KEY', 'JEV_API_KEY']) {
    if (env[name]) console.log(`::add-mask::${env[name]}`);
  }

  const record = await probe(env);

  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, 'endpoint.json'), JSON.stringify(record, null, 2), 'utf8');

  if (!record.configured) {
    console.log('no endpoint configured — the rules-only path produces the digest');
    console.log(`recorded: ${path.join(RUN_DIR, 'endpoint.json')}`);
    return;
  }

  for (const [name, supported] of Object.entries(record.capabilities ?? {})) {
    console.log(`  ${supported ? 'yes' : 'no '}  ${name}`);
  }
  if (record.timings?.chat_ms !== undefined) console.log(`chat round-trip: ${record.timings.chat_ms} ms`);
  // The kind and the status, never the endpoint's own text — this log is public
  // on a public repository. See `lib/probe.mjs`.
  if (record.error) {
    console.warn(
      `::warning::endpoint probe failed (${record.error.kind}` +
        `${record.error.status ? ` HTTP ${record.error.status}` : ''})`,
    );
  }
  console.log(`recorded: ${path.join(RUN_DIR, 'endpoint.json')} (capabilities only — no host, no model)`);
}

main().catch((err) => {
  console.error(`::error::${err.message ?? String(err)}`);
  process.exit(1);
});
