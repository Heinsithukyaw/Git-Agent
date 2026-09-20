/**
 * The write path. Four guarantees live here, and they are the reason an agent
 * with write access to someone's repository is defensible rather than alarming:
 *
 *   1. bounded writes, fail-closed          (I3)
 *   2. byte-comparison change gating        (I4)
 *   3. one deliberate exemption             (I4 — heartbeat.json)
 *   4. append-only history with a hash chain (I5)
 *
 * Everything that writes to this repository goes through this module, with three
 * exceptions — all deliberate, all inside the allowlist (I3), and all listed here
 * because a comment that claims more than the code does is worse than no comment:
 * it is the reason nobody looks.
 *
 *   - `lib/commands.mjs` → `recordIntent()` and `recordOutcome()` append to
 *     `history/commands.jsonl`. They append rather than write-if-changed because
 *     the command row is the record of an attempt, and two attempts are two rows
 *     (I5) — the change gate would collapse them.
 *   - `scripts/route-step.mjs` writes `data/schedule.json`, the pause/resume
 *     state. It is the repository's memory of a decision, so it is a state file
 *     rather than a derived one.
 *   - `scripts/route-step.mjs` also writes `.run/ask-context.json`, which is
 *     runtime scratch and never tracked.
 *
 * That these are constants rather than parameters — no path is derived for them
 * at runtime — is why this is a comment and not a check. `checkDirtyPaths()` is
 * what actually holds the line: whatever writes, the result has to be inside the
 * allowlist before anything is committed.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** What the running pipeline may write. */
export const COLLECTOR_ALLOWLIST = ['data', 'history', 'digest', 'assets', 'README.md'];

/** What CI may additionally write — rendering, not collection. */
export const CI_ALLOWLIST = [...COLLECTOR_ALLOWLIST, 'site'];

/** The single file exempt from the change gate. See I4. */
export const GATE_EXEMPT = ['data/heartbeat.json'];

const ROOT = process.cwd();

export function sha256(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Resolve and bound-check. Throws before any write happens (fail-closed), and
 * refuses absolute paths and traversal alike.
 */
export function assertWritable(rel, allowlist = COLLECTOR_ALLOWLIST) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error(`write denied: empty path`);
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`write denied: path must be relative, got ${rel}`);
  }
  const normalised = path.normalize(rel).split(path.sep).join('/');
  if (normalised.startsWith('..') || normalised.includes('/../')) {
    throw new Error(`write denied: traversal in ${rel}`);
  }
  const ok = allowlist.some(
    (a) => normalised === a || normalised.startsWith(a.endsWith('/') ? a : `${a}/`),
  );
  if (!ok) {
    throw new Error(
      `write denied: "${rel}" is outside the allowlist (${allowlist.join(', ')})`,
    );
  }
  return normalised;
}

export function isGateExempt(rel) {
  return GATE_EXEMPT.includes(path.normalize(rel).split(path.sep).join('/'));
}

/** Fields whose value changes on every run and must not trigger a commit. */
const VOLATILE_KEYS = new Set([
  'generated_at',
  'updated_at',
  'last_run_at',
  'observed_at',
  'run_id',
  'timestamp',
]);

/** Remove volatile scalars so two otherwise-identical runs compare equal. */
export function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

function stableSerialise(content, rel) {
  if (typeof content !== 'string') return JSON.stringify(stripVolatile(content), null, 2) + '\n';
  if (rel.endsWith('.json')) {
    try {
      return JSON.stringify(stripVolatile(JSON.parse(content)), null, 2) + '\n';
    } catch {
      return content; // not parseable — compare byte for byte
    }
  }
  return content;
}

/**
 * Write only if the content is meaningfully different.
 * Returns { changed, reason }.
 *
 * A file exempt from the gate (heartbeat.json) is always rewritten — that is
 * the point of the exemption, and it is what keeps a broken agent committing.
 */
export function writeIfChanged(rel, content, { allowlist } = {}) {
  const p = assertWritable(rel, allowlist ?? COLLECTOR_ALLOWLIST);
  const abs = path.join(ROOT, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  const next = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';

  if (!isGateExempt(p) && fs.existsSync(abs)) {
    const prev = fs.readFileSync(abs, 'utf8');
    if (stableSerialise(prev, p) === stableSerialise(next, p)) {
      return { changed: false, reason: 'identical' };
    }
  }
  fs.writeFileSync(abs, next, 'utf8');
  return { changed: true, reason: isGateExempt(p) ? 'exempt' : 'differs' };
}

/**
 * Append one JSON object as a line. Append-only by construction: this function
 * never truncates and never rewrites.
 */
export function appendRow(rel, row, { allowlist } = {}) {
  const p = assertWritable(rel, allowlist ?? COLLECTOR_ALLOWLIST);
  const abs = path.join(ROOT, p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.appendFileSync(abs, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

/**
 * Resolve a read path.
 *
 * Reads are unrestricted — there is no read allowlist, because the danger this
 * module guards against is writing. An absolute path is honoured rather than
 * re-joined with the root: `path.join(root, absolutePath)` silently produces
 * `root + absolutePath`, which is a path that never exists. That asymmetry cost
 * the command log its idempotency check: the intent row was written to the
 * right file and then looked for somewhere else, so every re-run saw "not
 * handled yet" and acted twice.
 */
function resolveRead(rel) {
  return path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
}

export function readRows(rel) {
  const abs = resolveRead(rel);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readFileSync(abs, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`corrupt row ${i} in ${rel}: ${l.slice(0, 80)}`);
      }
    });
}

/** The last line of a JSONL file, or null. */
export function lastRow(rel) {
  const rows = readRows(rel);
  return rows.length ? rows[rows.length - 1] : null;
}

/**
 * Hash chain over history/runs.jsonl.
 *
 * Each row's `hash` covers canonical(row minus hash) + prevHash, so editing any
 * past row breaks every row after it. Narration is never included: prose is
 * generated content, not a fact about the world, and hashing it would make the
 * chain churn on every phrasing tweak.
 */
export function chainHash(row, prevHash) {
  // Both `hash` and `prevHash` are excluded, because the same function is
  // called twice on the same row with different shapes: once at append time on
  // a row that has neither field, and once at verify time on the stored row
  // that has both. Hashing `prevHash` at verify time but not at append time
  // makes every chain fail at row 0.
  const { hash, prevHash: _chain, ...rest } = row;
  return sha256(JSON.stringify(rest) + '|' + (prevHash ?? 'genesis'));
}

export function appendRun(rel, row, { allowlist } = {}) {
  const prev = lastRow(rel);
  const prevHash = prev ? prev.hash ?? null : null;
  if (prev && !prev.hash) {
    throw new Error(`hash chain broken: last row in ${rel} has no hash`);
  }
  const withHash = { ...row, prevHash, hash: chainHash(row, prevHash) };
  return appendRow(rel, withHash, { allowlist });
}

/** Verify a whole chain. Returns { ok, brokenAt }. */
export function verifyChain(rel) {
  const rows = readRows(rel);
  let prev = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.prevHash !== prev) return { ok: false, brokenAt: i, expected: prev, found: r.prevHash };
    if (chainHash(r, prev) !== r.hash) return { ok: false, brokenAt: i, reason: 'hash mismatch' };
    prev = r.hash;
  }
  return { ok: true, rows: rows.length };
}

/** Read a JSON state file, tolerating absence. */
export function readJson(rel, fallback = null) {
  const abs = resolveRead(rel);
  if (!fs.existsSync(abs)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return fallback;
  }
}
