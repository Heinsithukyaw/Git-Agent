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
 *   3. **Record the host, never the URL.** `data/endpoint.json` is committed to
 *      a repository that may be public, and a base URL can carry a deployment
 *      id or a path segment that was never meant to be published.
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

  console.log(`host: ${record.host ?? '(could not parse)'}`);
  console.log(`model: ${record.model ?? '(unset)'}`);
  for (const [name, supported] of Object.entries(record.capabilities ?? {})) {
    console.log(`  ${supported ? 'yes' : 'no '}  ${name}`);
  }
  if (record.timings?.chat_ms !== undefined) console.log(`chat round-trip: ${record.timings.chat_ms} ms`);
  if (record.error) console.warn(`::warning::endpoint probe failed: ${record.error}`);
  console.log(`recorded: ${path.join(RUN_DIR, 'endpoint.json')} (host only — the URL is never stored)`);
}

main().catch((err) => {
  console.error(`::error::${err.message ?? String(err)}`);
  process.exit(1);
});
