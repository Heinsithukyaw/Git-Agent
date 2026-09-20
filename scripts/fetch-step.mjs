#!/usr/bin/env node
/**
 * Job: fetch — the read step.
 *
 * contents: read, no secrets. It talks to the world and writes nothing to the
 * repository. Its only output is the payload artifact, which is the input to
 * both the narration job and the containment gate.
 *
 * A source that fails is recorded in `payload.errors` rather than thrown. A
 * partial digest with a visible gap beats no digest, and the gap is rendered in
 * the digest rather than hidden.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gather } from '../lib/sources.mjs';

const RUN_DIR = '.run';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function main() {
  const stackPath = path.join('data', 'stack.json');
  if (!fs.existsSync(stackPath)) {
    fail(`${stackPath} is missing. Add the packages you want watched, then re-run.`);
  }

  let stack;
  try {
    stack = JSON.parse(fs.readFileSync(stackPath, 'utf8'));
  } catch (err) {
    fail(`${stackPath} is not valid JSON: ${err.message}`);
  }

  if (!Array.isArray(stack.packages) || stack.packages.length === 0) {
    fail(`${stackPath} lists no packages. Nothing to watch.`);
  }

  console.log(`watching ${stack.packages.length} package(s), ${(stack.watch?.upstreams ?? []).length} upstream(s)`);

  const payload = await gather(stack, { token: process.env.GITHUB_TOKEN });

  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUN_DIR, 'payload.json'), JSON.stringify(payload, null, 2), 'utf8');

  const parts = [
    `${payload.packages.length} package(s)`,
    `${payload.advisories.length} advisory row(s)`,
    `${payload.releases.length} release(s)`,
  ];
  if (payload.errors.length) parts.push(`${payload.errors.length} source failure(s)`);
  console.log(`payload: ${parts.join(', ')}`);
  for (const e of payload.errors) console.warn(`::warning::${e.source}${e.name ? ` (${e.name})` : ''}: ${e.error}`);

  // A run with zero packages resolved is a broken run, not a quiet day.
  const resolved = payload.packages.filter((p) => p.upstream).length;
  if (resolved === 0 && payload.errors.length > 0) {
    fail('no package resolved and every source failed — refusing to produce an empty digest');
  }
}

main().catch((err) => fail(err.message ?? String(err)));
