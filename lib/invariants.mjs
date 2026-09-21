/**
 * The invariants, as checks.
 *
 * AGENTS.md states the rules; this file is how they stay true. Every rule in
 * that file is either enforced here or it is a preference, and the rules that
 * erode silently are exactly the ones worth automating:
 *
 *   - **one privilege per job** — a job may hold a secret or a write token,
 *     never both. This is the rule that dies first, because merging two jobs
 *     "for latency" looks like an optimisation and is a downgrade.
 *   - **the sandbox never receives a secret**
 *   - **no provider names in the code**
 *   - **the gate runs only in jobs that hold no model key**
 *   - **writes stay inside the allowlist**
 *   - **the hash chain is intact**
 *
 * The YAML reader below is deliberately minimal — it handles the subset of YAML
 * this repository actually writes (block mappings, block sequences, inline `{}`,
 * block scalars) and throws on anything else. It is not a general parser, and
 * it should not become one. If a workflow needs a YAML feature this cannot
 * read, that is a signal the workflow is doing something unusual.
 */

import fs from 'node:fs';
import path from 'node:path';
import { verifyChain, CI_ALLOWLIST, COLLECTOR_ALLOWLIST } from './store.mjs';
import { PUBLIC_DIGEST_PREFIX } from './public-surface.mjs';

/* --------------------------------------------------------- minimal YAML ---- */

function indentOf(line) {
  const m = line.match(/^( *)/);
  return m ? m[1].length : 0;
}

function scalar(raw) {
  const s = raw.replace(/\s+#.*$/, '').trim();
  if (!s) return null;
  if (s === '{}') return {};
  if (s === '[]') return [];
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return {};
    return Object.fromEntries(
      inner.split(',').map((kv) => {
        const i = kv.indexOf(':');
        return [kv.slice(0, i).trim().replace(/^['"]|['"]$/g, ''), scalar(kv.slice(i + 1))];
      }),
    );
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => scalar(x)) : [];
  }
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s.replace(/^['"]|['"]$/g, '');
}

function isBlockScalar(value) {
  return value === '|' || value === '>' || value === '|-' || value === '>-';
}

/**
 * Fold a `>` block scalar the way YAML does: a single newline becomes a space, a
 * blank line becomes a newline. Indentation is already stripped by the caller.
 */
function foldBlock(lines) {
  const paragraphs = [];
  let run = [];
  for (const line of lines) {
    if (line.trim()) {
      run.push(line.trim());
    } else if (run.length) {
      paragraphs.push(run.join(' '));
      run = [];
    }
  }
  if (run.length) paragraphs.push(run.join(' '));
  return paragraphs.join('\n');
}

/**
 * Parse the YAML subset used by this repository's workflows.
 * @returns {object}
 */
export function parseYaml(text) {
  const lines = text.split('\n');
  const root = {};
  const stack = [{ indent: -1, container: root }];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const indent = indentOf(line);
    const body = line.slice(indent);

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const current = stack[stack.length - 1].container;

    if (body.startsWith('- ')) {
      const itemBody = body.slice(2);
      if (!Array.isArray(current)) {
        throw new Error(`unexpected sequence at line ${i + 1}`);
      }
      if (itemBody.includes(':')) {
        const obj = {};
        current.push(obj);
        // The frame is pushed at the *dash* indent, not the key indent. The
        // rewritten line below sits at `indent + 2`, and the pop condition is
        // `indent <= frame.indent`, so a frame pushed at `indent + 2` is popped
        // by the very line it was created for. The result was that a step's
        // keys were attached to the enclosing array instead of to the step,
        // which made `secrets:` references inside steps invisible — so the
        // one-privilege-per-job check silently passed on workflows that broke it.
        stack.push({ indent, container: obj });
        // Re-handle this line as a mapping key at the deeper indent.
        lines[i] = ' '.repeat(indent + 2) + itemBody;
        continue;
      }
      current.push(scalar(itemBody));
      i++;
      continue;
    }

    const colon = body.indexOf(':');
    if (colon === -1) throw new Error(`expected "key: value" at line ${i + 1}: ${line}`);
    const key = body.slice(0, colon).trim();
    let value = body.slice(colon + 1).trim();

    if (isBlockScalar(value)) {
      const block = [];
      const blockIndent = indent + 2;
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() && indentOf(l) < blockIndent && !/^\s*#/.test(l)) break;
        block.push(l.slice(Math.min(blockIndent, indentOf(l))));
        i++;
      }
      // `>` folds and `|` does not. The reader used to treat the two alike, which
      // means a workflow whose folded scalar is load-bearing was read here as
      // something GitHub would never produce — and both consumers of a block
      // scalar in this repository (an upload's path list, a `run:` script) are
      // sensitive to exactly the difference.
      current[key] = value.startsWith('>') ? foldBlock(block) : block.join('\n').trimEnd();
      continue;
    }

    if (!value) {
      // Could be a mapping or a sequence; decide by looking ahead.
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || /^\s*#/.test(lines[j]))) j++;
      const next = lines[j] ?? '';
      const nextIndent = indentOf(next);
      if (next.trim().startsWith('- ')) {
        const arr = [];
        current[key] = arr;
        stack.push({ indent, container: arr });
        i++;
        continue;
      }
      if (next.trim() && nextIndent > indent) {
        const obj = {};
        current[key] = obj;
        stack.push({ indent, container: obj });
        i++;
        continue;
      }
      current[key] = null;
      i++;
      continue;
    }

    current[key] = scalar(value);
    i++;
  }
  return root;
}

/* ------------------------------------------------------------- helpers ---- */

export const WRITE_PERMISSIONS = new Set([
  'contents',
  'issues',
  'pull-requests',
  'actions',
  'pages',
  'deployments',
  'packages',
  'discussions',
  'repository-projects',
  'security-events',
  'statuses',
  'checks',
]);

function jobsOf(workflow) {
  return Object.entries(workflow?.jobs ?? {}).map(([name, job]) => ({ name, job: job ?? {} }));
}

function writeScopesOf(job) {
  const perms = job?.permissions ?? {};
  if (typeof perms === 'string') {
    return perms === 'write-all' ? ['*'] : [];
  }
  return Object.entries(perms)
    .filter(([, v]) => v === 'write')
    .map(([k]) => k);
}

function secretRefsOf(job) {
  const found = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const m of node.matchAll(/secrets\.(?:[A-Za-z0-9_.-]+|\[[^\]]+\])/g)) found.add(m[0]);
      return;
    }
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object') return Object.values(node).forEach(walk);
  };
  // Job-level `secrets:` (workflow_call) and inherited secrets both count.
  if (job.secrets && typeof job.secrets === 'object' && job.secrets.inherit === true) {
    found.add('secrets.inherit');
  }
  if (job.secrets && typeof job.secrets === 'string' && job.secrets === 'inherit') {
    found.add('secrets.inherit');
  }
  const { permissions, ...rest } = job;
  walk(rest);

  // The platform token is not a credential the user configured, and it cannot
  // be: `GITHUB_TOKEN` is reserved. Its scope *is* this job's `permissions`,
  // which is exactly the thing I1 is about — so counting it as a secret would
  // flag every job that pushes, and a check that flags everything is a check
  // that gets disabled. A PAT (`GH_TOKEN`, or any other name) is still counted.
  found.delete('secrets.GITHUB_TOKEN');
  return [...found];
}

/* --------------------------------------------------------------- checks ---- */

/**
 * I1 — one privilege per job.
 * A job may hold a secret, or a write token. Never both.
 */
export function checkOnePrivilegePerJob(root = process.cwd()) {
  const dir = path.join(root, '.github/workflows');
  const violations = [];
  if (!fs.existsSync(dir)) return { ok: false, violations: [{ file: dir, error: 'no workflows directory' }] };

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    let wf;
    try {
      wf = parseYaml(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      violations.push({ file, error: `unparseable: ${err.message}` });
      continue;
    }
    const workflowPerms = wf?.permissions ?? {};
    // A `jobs` block that is not a mapping cannot be checked, and an unchecked
    // workflow must not read as a passing one. Without this, `jobs:` written as
    // a sequence produced index-keyed "jobs" and the privilege check found
    // nothing to look at.
    if (wf.jobs !== undefined && (wf.jobs === null || typeof wf.jobs !== 'object' || Array.isArray(wf.jobs))) {
      violations.push({ file, error: 'jobs is not a mapping' });
      continue;
    }
    for (const { name, job } of jobsOf(wf)) {
      const secrets = secretRefsOf(job);
      const scopes = writeScopesOf(job);
      const inherited =
        (typeof workflowPerms === 'string' && workflowPerms === 'write-all') ||
        (typeof workflowPerms === 'object' && Object.values(workflowPerms).includes('write'));
      if (secrets.length && (scopes.length || inherited)) {
        violations.push({
          file,
          job: name,
          secrets,
          writeScopes: inherited ? [...scopes, '(inherited from workflow)'] : scopes,
          rule: 'I1: no component holds both a secret and a write token',
        });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/** I7 — the sandbox workflow holds nothing. */
export function checkSandboxIsolated(root = process.cwd()) {
  const p = path.join(root, '.github/workflows/sandbox.yml');
  if (!fs.existsSync(p)) return { ok: false, violations: [{ file: p, error: 'missing' }] };
  const wf = parseYaml(fs.readFileSync(p, 'utf8'));
  const violations = [];
  if (!(wf.permissions && typeof wf.permissions === 'object' && Object.keys(wf.permissions).length === 0)) {
    violations.push({ file: p, error: 'workflow permissions are not {}' });
  }
  for (const { name, job } of jobsOf(wf)) {
    const secrets = secretRefsOf(job);
    if (secrets.length) violations.push({ file: p, job: name, error: `sandbox job references ${secrets.join(', ')}` });
    const scopes = writeScopesOf(job);
    if (scopes.length) violations.push({ file: p, job: name, error: `sandbox job requests write: ${scopes.join(', ')}` });
    if (job.permissions && Object.keys(job.permissions).length) {
      violations.push({ file: p, job: name, error: 'sandbox job overrides permissions' });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * I8 — no provider names in the code.
 *
 * Scans executable code only. Documentation may name things; code may not have
 * an opinion about which endpoint the user points it at.
 */
const VENDOR_PATTERNS = [
  /\bopenai\b/i, /\bchatgpt\b/i, /\bgpt-?[45]\b/i, /\banthropic\b/i, /\bclaude\b/i,
  /\bgemini\b/i, /\bvertex\b/i, /\bmistral/i, /\bcohere\b/i, /\bgroq\b/i, /\bdeepseek\b/i,
  /\btogether\.ai\b/i, /\bfireworks\.ai\b/i, /\bperplexity\b/i, /\bollama\b/i,
  /\bazure[./-]?openai\b/i, /\bbedrock\b/i, /\bxai\b/i, /\bgrok\b/i,
];

/**
 * Drop whole-line comments.
 *
 * Documentation may name a thing the code must not depend on — I8's vendor
 * vocabulary is the original case, and I16's own header names the private paths
 * it forbids. Both checks scan executable text for that reason: a rule that
 * fired on the paragraph explaining it would be a check nobody could document,
 * and a check nobody can document is a check that gets deleted.
 *
 * A line-level filter, so a path or a URL on an executable line is never
 * truncated.
 */
function stripCommentLines(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*|\*\/)/.test(l))
    .join('\n');
}

/**
 * Strip the parts of a file that cannot be an opinion.
 *
 * Two exclusions, both narrow on purpose:
 *
 *   - the VENDOR_PATTERNS block itself. The vocabulary has to live somewhere,
 *     and it lives here as data. Exempting the whole file would let real
 *     provider-specific logic hide in it; exempting the array does not.
 *   - whole-line comments, via `stripCommentLines()`.
 */
function scanableText(text) {
  const withoutPatterns = text.replace(
    /const VENDOR_PATTERNS = \[[\s\S]*?\];/,
    '/* vocabulary omitted */',
  );
  return stripCommentLines(withoutPatterns);
}

export function checkNoVendorNames(root = process.cwd()) {
  const violations = [];
  const dirs = ['lib', 'scripts', 'tools'];
  for (const dir of dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of fs.readdirSync(abs).filter((f) => f.endsWith('.mjs'))) {
      const text = scanableText(fs.readFileSync(path.join(abs, file), 'utf8'));
      for (const re of VENDOR_PATTERNS) {
        const m = text.match(re);
        if (m) violations.push({ file: path.join(dir, file), token: m[0], rule: 'I8: no provider names in code' });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * I2 — the gate decides, and the gate cannot be hijacked.
 *
 * **First clause — placement.** Enforced by import graph: only the commit and
 * reply entry points may reach `lib/gate.mjs`. A gate reachable from a narrating
 * job is a gate the model's input can influence.
 *
 * **Second clause — ordering.** In `scripts/commit-step.mjs`, the first
 * `assertGrounded(` must precede the first `buildPublicSurface(`, and the
 * projection must actually be written.
 *
 * The import graph says nothing about statement order, and that gap was real: the
 * projection block could be moved above the gate — or both `writeIfChanged` calls
 * deleted outright — and the whole suite stayed green. "The shipped pipeline
 * publishes the projected surface" was true by reading only.
 *
 * Why the order is load-bearing, in both directions. The gate's document is
 * `attachDecisions(payload, decisions)` — the payload *with the decisions folded
 * in*, which is the document the narrator read. Projecting first would hand the
 * gate a narrower document than the narrator saw, and every fact about a withheld
 * package would become ungroundable. That is a hijack of the gate: it changes
 * what the gate is judging. `attachDecisions()` was itself introduced to close
 * this class of defect in the other direction, and this clause is the same rule
 * applied to the projection.
 *
 * The markers carry their `(`, which is not cosmetic: `buildPublicSurface,`
 * appears in the import list above the gate, so a bare name would always be found
 * first and the clause would pass on any ordering at all.
 *
 * Textual and deterministic, like the first clause, and in the same file — which
 * is why it is a second clause here rather than an I17.
 */
const GATE_CONSUMERS = new Set(['scripts/commit-step.mjs', 'scripts/reply-step.mjs']);

/** The markers, with the paren: the name alone also appears in an import. */
const GATE_CALL = 'assertGrounded(';
const PROJECTION_CALL = 'buildPublicSurface(';

/**
 * The projection's two writes.
 *
 * Deleting them leaves the projection computed and discarded — the private
 * surface published as before, with nothing to say the public one was ever
 * meant to exist. It was a green suite before this was pinned.
 */
const PROJECTION_WRITES = ['writeIfChanged(publicDigestPath(', 'writeIfChanged(PUBLIC_SUMMARY'];

/** I2's second clause. Returns violations rather than a result, for `runAll`. */
function checkProjectionFollowsGate(root) {
  const abs = path.join(root, 'scripts/commit-step.mjs');
  if (!fs.existsSync(abs)) return [{ file: 'scripts/commit-step.mjs', error: 'missing' }];
  const text = stripCommentLines(fs.readFileSync(abs, 'utf8'));
  const violations = [];

  const gate = text.indexOf(GATE_CALL);
  const projection = text.indexOf(PROJECTION_CALL);
  if (gate === -1) {
    violations.push({
      file: 'scripts/commit-step.mjs',
      rule: 'I2: the commit step must call assertGrounded(...), or the gate is not running',
    });
  }
  if (projection === -1) {
    violations.push({
      file: 'scripts/commit-step.mjs',
      rule: 'I2: the commit step must build the public surface',
    });
  }
  if (gate !== -1 && projection !== -1 && projection < gate) {
    violations.push({
      file: 'scripts/commit-step.mjs',
      rule:
        'I2: the public surface is projected before the gate — the gate must be handed ' +
        'the document the narrator saw, not a narrower one',
    });
  }
  for (const write of PROJECTION_WRITES) {
    if (!text.includes(write)) {
      violations.push({
        file: 'scripts/commit-step.mjs',
        rule: `I2: the projected surface is built but never written (${write}…)`,
      });
    }
  }
  return violations;
}

export function checkGatePlacement(root = process.cwd()) {
  const violations = [];
  for (const dir of ['scripts', 'lib', 'tools']) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of fs.readdirSync(abs).filter((f) => f.endsWith('.mjs'))) {
      const rel = path.join(dir, file);
      if (GATE_CONSUMERS.has(rel)) continue;
      const text = fs.readFileSync(path.join(abs, file), 'utf8');
      if (/'\.\.\/lib\/gate\.mjs'|"\.\.\/lib\/gate\.mjs"|'\.\/gate\.mjs'|"\.\/gate\.mjs"/.test(text)) {
        violations.push({ file: rel, rule: 'I2: only the keyless commit/reply steps may run the gate' });
      }
    }
  }
  violations.push(...checkProjectionFollowsGate(root));
  return { ok: violations.length === 0, violations };
}

/** I3 — every dirty path is inside the CI allowlist. */
export function checkDirtyPaths(porcelainOutput, allowlist = CI_ALLOWLIST) {
  const violations = [];
  for (const line of porcelainOutput.split('\n')) {
    if (!line.trim()) continue;
    const rel = line.slice(3).trim().replace(/^"|"$/g, '');
    if (!rel) continue;
    const norm = path.normalize(rel).split(path.sep).join('/');
    const ok = allowlist.some((a) => norm === a || norm.startsWith(a.endsWith('/') ? a : `${a}/`));
    if (!ok) violations.push({ path: norm, rule: 'I3: write outside the allowlist' });
  }
  return { ok: violations.length === 0, violations };
}

/** I4 — exactly one file is outside the change gate, and it is the heartbeat. */
export function checkHeartbeatExempt(root = process.cwd()) {
  const src = fs.readFileSync(path.join(root, 'lib/store.mjs'), 'utf8');
  const m = src.match(/export const GATE_EXEMPT = \[([^\]]*)\]/);
  const list = m ? m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean) : [];
  const ok = list.length === 1 && list[0] === 'data/heartbeat.json';
  return { ok, violations: ok ? [] : [{ list, rule: 'I4: exactly one exemption, and it is data/heartbeat.json' }] };
}

/** I5 — the run log chains. */
export function checkHashChain(root = process.cwd()) {
  const rel = 'history/runs.jsonl';
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return { ok: true, skipped: true };
  const res = verifyChain(rel);
  if (res.ok) return { ok: true, rows: res.rows, detail: `${res.rows} row(s), chain intact` };
  return { ok: false, violations: [{ file: rel, ...res, rule: 'I5: hash chain broken' }] };
}

/**
 * I12 — third-party actions are pinned to a commit, not a tag.
 *
 * A tag is a mutable pointer. `actions/checkout@v4` is resolved by GitHub at run
 * time, so whoever can move that tag controls code that executes inside a job
 * holding the user's write token. Pinning to a 40-hex commit turns an upgrade
 * into an explicit, reviewable diff — the only version of this rule that
 * survives a busy month.
 *
 * A local reusable workflow (`./.github/workflows/…`) is exempt: it is this
 * repository, at the commit being run, not a third party.
 */
const USES_RE = /^[ \t]*(?:-[ \t]*)?uses:[ \t]*(\S+)/gm;
const COMMIT_PIN_RE =
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.\/-]*)?@[0-9a-f]{40}$/;
const DIGEST_PIN_RE = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;

export function checkActionsPinned(root = process.cwd()) {
  const dir = path.join(root, '.github/workflows');
  const violations = [];
  const pins = new Set();
  if (!fs.existsSync(dir)) return { ok: false, violations: [{ file: dir, error: 'no workflows directory' }] };

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(USES_RE)) {
      const ref = m[1];
      if (ref.startsWith('./')) continue;
      if (ref.startsWith('docker://')) {
        if (DIGEST_PIN_RE.test(ref)) pins.add(ref);
        else violations.push({ file, ref, rule: 'I12: a container action must be pinned by digest' });
        continue;
      }
      if (COMMIT_PIN_RE.test(ref)) pins.add(ref);
      else violations.push({ file, ref, rule: 'I12: a third-party action must be pinned to a 40-hex commit' });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    pins: [...pins].sort(),
    detail: `${pins.size} action(s) pinned to a commit`,
  };
}

/**
 * I13 — the cheap guard and the real gate cannot drift.
 *
 * Two copies of one allowlist exist by necessity. `lib/commands.mjs` decides,
 * and the workflow `if:` pre-filters, so that a stranger's comment does not
 * start a runner at all. Two copies of a rule drift — so this reads the
 * allowlist out of the script and asserts the workflow names exactly it.
 *
 * The `if:` is a pre-filter and never the gate: the script still exits. This
 * check exists so the pre-filter can never be *looser* than the gate it fronts,
 * which is the direction that matters. A pre-filter that is stricter would be a
 * bug of its own — the guard would silently drop a legitimate command — so the
 * assertion is equality, not containment.
 *
 * The title prefix is asserted with its trailing space. `startsWith(title,
 * '/agent')` also matches `/agentfoo`, which is not a command, and the point of
 * a pre-filter is to not start a runner for things that are not commands.
 *
 * Trigger detection is textual and anchored rather than parsed, because a
 * workflow that declares `on: issue_comment` in a shape the minimal YAML reader
 * cannot see would otherwise read as a workflow that does not need a guard. A
 * commented-out trigger is flagged; that is the loud direction to fail in.
 */
const ISSUE_COMMENT_TRIGGER_RES = [
  /^[ \t]*issue_comment:[ \t]*$/m,
  /^[ \t]*on:[ \t]*\[[^\]]*issue_comment/m,
  /^[ \t]*on:[ \t]*issue_comment[ \t]*$/m,
];

export function checkAuthorGateMirrorsScript(root = process.cwd()) {
  const cmdRel = 'lib/commands.mjs';
  const cmdPath = path.join(root, cmdRel);
  if (!fs.existsSync(cmdPath)) return { ok: false, violations: [{ file: cmdRel, error: 'missing' }] };

  const m = fs
    .readFileSync(cmdPath, 'utf8')
    .match(/ALLOWED_ASSOCIATIONS\s*=\s*new Set\(\[([^\]]*)\]\)/);
  if (!m) {
    return {
      ok: false,
      violations: [
        {
          file: cmdRel,
          error: 'ALLOWED_ASSOCIATIONS not found — the author gate has no declared allowlist',
        },
      ],
    };
  }
  const allowed = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  const expected = `fromJSON('${JSON.stringify(allowed)}')`;

  const dir = path.join(root, '.github/workflows');
  if (!fs.existsSync(dir)) return { ok: false, violations: [{ file: dir, error: 'no workflows directory' }] };

  const violations = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    if (!ISSUE_COMMENT_TRIGGER_RES.some((re) => re.test(text))) continue;

    if (!text.includes(expected)) {
      violations.push({ file, rule: `I13: an issue_comment workflow must guard with ${expected}` });
    }
    if (!/startsWith\([ \t]*github\.event\.issue\.title,[ \t]*'\/agent '[ \t]*\)/.test(text)) {
      violations.push({
        file,
        rule: "I13: an opened issue is admitted only by the '/agent ' title prefix, delimiter included",
      });
    }
  }
  return {
    ok: violations.length === 0,
    violations,
    allowed,
    detail: `allowlist ${allowed.join(' / ')}`,
  };
}

/* -------------------------------------------------------------- I14 ------ */

/**
 * I14 — the configuration surface agrees with its documentation, both ways.
 *
 * AGENTS.md claims a configuration surface "and nothing more". That claim has
 * two directions, and both had already drifted by the time this check was
 * written:
 *
 *   workflow → table   `vars.JEV_BASE_URL` was read by `digest.yml` and absent
 *                      from the table. Someone reading the table could not have
 *                      known to set it.
 *   code → workflow    `JEV_MODEL` was read by `scripts/narrate-step.mjs` and
 *                      passed by no workflow. The table documented a knob that
 *                      did not exist at runtime.
 *
 * Neither is visible by reading either file alone, which is why this is a check
 * and not another paragraph.
 *
 * The second direction is deliberately family-scoped: only `LLM_*` and `JEV_*`
 * names are required to be delivered by a workflow. Everything else a step
 * reads — `COMMENT_ID`, `NARRATE_RESULT`, `PROBE_ENDPOINT` — is plumbing the
 * workflow composes out of `needs.*` and `github.*`, and demanding a table row
 * for each would be noise, and a noisy check is a disabled check.
 *
 * `secrets.GITHUB_TOKEN` is excluded for the reason I1 excludes it: the platform
 * supplies it, the user cannot configure it, and it is not a row.
 */
const CONFIG_TABLE_ANCHOR = 'Configuration surface, and nothing more:';
const CONFIG_FAMILY_RE = /^(?:LLM|JEV)_/;
const CONFIG_READ_RES = [
  /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)/g,
  /\b(?:process\.env|env)\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g,
];
const CONFIG_REF_RE = /\b(?:vars|secrets)\.([A-Za-z0-9_]+)/g;
const CONFIG_TABLE_ROW_RE = /^\|[ \t]*`([A-Z][A-Z0-9_]*)`[ \t]*\|/gm;

/** Every `env:` mapping in a workflow, wherever in the tree it sits. */
function envKeysOf(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) envKeysOf(item, found);
    return found;
  }
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'env' && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const name of Object.keys(value)) found.add(name);
    }
    envKeysOf(value, found);
  }
  return found;
}

export function checkConfigSurface(root = process.cwd()) {
  const agentsRel = 'AGENTS.md';
  const agentsPath = path.join(root, agentsRel);
  if (!fs.existsSync(agentsPath)) return { ok: false, violations: [{ file: agentsRel, error: 'missing' }] };
  const agents = fs.readFileSync(agentsPath, 'utf8');

  // The table is read from its anchor rather than from the whole file: other
  // tables in AGENTS.md have a backticked first column, and a check that quietly
  // collected their rows would pass while the real table was wrong.
  const anchor = agents.indexOf(CONFIG_TABLE_ANCHOR);
  if (anchor === -1) {
    return {
      ok: false,
      violations: [{ file: agentsRel, error: `the I8 table anchor is missing: "${CONFIG_TABLE_ANCHOR}"` }],
    };
  }
  const fromAnchor = agents.slice(anchor);
  const nextHeading = fromAnchor.search(/^#{2,3}[ \t]/m);
  const section = nextHeading === -1 ? fromAnchor : fromAnchor.slice(0, nextHeading);
  const documented = new Set([...section.matchAll(CONFIG_TABLE_ROW_RE)].map((m) => m[1]));

  if (documented.size === 0) {
    return {
      ok: false,
      violations: [
        { file: agentsRel, error: 'the I8 table declares no names, so this check would pass vacuously' },
      ],
    };
  }

  const dir = path.join(root, '.github/workflows');
  if (!fs.existsSync(dir)) return { ok: false, violations: [{ file: dir, error: 'no workflows directory' }] };

  const violations = [];
  const passed = new Set();
  const workflowFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  for (const file of workflowFiles) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');

    for (const m of text.matchAll(CONFIG_REF_RE)) {
      const name = m[1];
      if (name === 'GITHUB_TOKEN') continue;
      passed.add(name);
      if (!documented.has(name)) {
        violations.push({ file, name, rule: `I14: ${m[0]} is not in the I8 configuration table` });
      }
    }

    try {
      for (const name of envKeysOf(parseYaml(text))) passed.add(name);
    } catch (err) {
      violations.push({ file, error: `unparseable: ${err.message}` });
    }
  }

  const readByCode = new Map();
  for (const d of ['lib', 'scripts']) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    for (const file of fs.readdirSync(abs).filter((f) => f.endsWith('.mjs'))) {
      const text = fs.readFileSync(path.join(abs, file), 'utf8');
      for (const re of CONFIG_READ_RES) {
        for (const m of text.matchAll(re)) {
          if (!CONFIG_FAMILY_RE.test(m[1])) continue;
          const rel = `${d}/${file}`;
          if (!readByCode.has(m[1])) readByCode.set(m[1], new Set());
          readByCode.get(m[1]).add(rel);
        }
      }
    }
  }

  for (const [name, files] of [...readByCode].sort(([a], [b]) => a.localeCompare(b))) {
    const where = [...files].sort().join(', ');
    if (!documented.has(name)) {
      violations.push({
        file: where,
        name,
        rule: `I14: ${name} is read by code but absent from the I8 configuration table`,
      });
    }
    if (!passed.has(name)) {
      violations.push({
        file: where,
        name,
        rule: `I14: ${name} is read by code but passed by no workflow`,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    documented: [...documented].sort(),
    read: [...readByCode.keys()].sort(),
    detail: `${documented.size} name(s) documented, ${readByCode.size} read by code`,
  };
}

/* -------------------------------------------------------------- I15 ------ */

/**
 * I15 — the artifact handoff is complete.
 *
 * A job boundary is a filesystem boundary. Each job gets a fresh runner, so a
 * file one job wrote is *absent* in the next unless an artifact carries it.
 *
 * The local suite cannot see this, and that is the whole reason this check
 * exists. Run by hand, the four `digest.yml` jobs share one `.run/` directory, so
 * a file "narrate" wrote is still there for "commit" — which is precisely the
 * thing GitHub replaces with an explicit upload and download. A sequential local
 * run is structurally incapable of catching an artifact-boundary defect; it
 * proves the code, not the wiring between jobs.
 *
 * That is how this repository shipped a green pipeline that published
 * *"0 to act on"*. `narrate-step` writes `.run/decisions.json` and
 * `.run/narration.json`; `commit-step` reads both (`:78`, `:84`); neither was
 * uploaded. 238 tests passed and a full local end-to-end run passed, because
 * `tests/commit.test.mjs` fabricates those files into its sandbox and no test
 * referenced `upload-artifact` at all.
 *
 * Three assertions, all static:
 *
 *   1. **A `.run/` file read by one step and written by a different one must be
 *      carried by an upload.** Scoped **per job**, because a file crossing a job
 *      boundary only matters where the two jobs coexist: two steps in one job
 *      share a working directory, so the file is simply there. An earlier version
 *      unioned uploads across the whole workflow, which passed a workflow whose
 *      upload lived in a third job that ran *after* the consumer.
 *   2. **It must land where the reader looks.** Carried is not delivered: a
 *      download into `state/` moves `.run/decisions.json` somewhere `commit-step`
 *      never looks, and comparing only the artifact *name* saw nothing. Re-pointing
 *      a download path is the same defect one layer over, and it was invisible.
 *   3. **Every downloaded artifact name must be uploaded in the same workflow.**
 *      The cheap half, and the one that catches a rename applied to only one side.
 *
 * Read/write classification is textual and resolves one level of `const`
 * indirection, because `narrate-step` binds `NARRATION = path.join(RUN_DIR,
 * 'narration.json')` and then writes through the name. A scan that read that as a
 * read would demand `narration.json` be delivered *to* the job that produces it —
 * a false positive, and a check that cries wolf is a check that gets disabled.
 *
 * The narrowness is deliberate: `RUN_DIR` is matched by name. If it is ever
 * renamed the check finds nothing, so `checked` is reported and the test asserts
 * it is non-zero — a check that can pass vacuously is not a check.
 *
 * **What the vocabulary covers, and what it still does not.** Four spellings of a
 * write are recognised — `writeFileSync`, `appendFileSync`, `writeFile` and
 * `appendFile`, the last two covering `fs.promises.*`. A producer is found in a
 * `run:` step directly, through `npm run <name>`, and through `npm test`; the
 * last two resolve against this repository's `package.json`, and only when the
 * name resolves. An upload path carries a file when it matches it exactly, names
 * its directory, or names it with a trailing `/*`.
 *
 * What remains narrow, named rather than discovered: a `.run/` path built by any
 * other expression — `path.join(dir, name)` with a variable `dir` — is not seen
 * at all, and a write performed by a module under `lib/` is attributed to no step
 * script.
 */
const RUN_JOIN_RE = /path\.join\(\s*RUN_DIR\s*,\s*'([^']+)'\s*\)/g;
const RUN_ALIAS_RE = /const\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*RUN_DIR\s*,\s*'([^']+)'\s*\)/g;
// Four spellings, and the last two are what `fs.promises.writeFile` matches — the
// prefix sits before the method name, so the regex still anchors on it. Leaving
// them out meant an async writer's file was invisible to this check: a producer
// that "wrote nothing", so nothing had to carry it.
const RUN_WRITE_RE =
  /(?:writeFileSync|appendFileSync|writeFile|appendFile)\s*\(\s*(?:path\.join\(\s*RUN_DIR\s*,\s*'([^']+)'\s*\)|([A-Za-z_$][\w$]*))/g;
const RUN_SCRIPT_RE = /scripts\/([A-Za-z0-9_.-]+\.mjs)/g;
const NPM_RUN_RE = /\bnpm\s+run\s+([A-Za-z0-9_:.-]+)/g;
const NPM_TEST_RE = /\bnpm\s+test\b/;

/** This repository's npm scripts, so `npm run <name>` can be resolved to a file. */
function npmScripts(root) {
  const p = path.join(root, 'package.json');
  if (!fs.existsSync(p)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(p, 'utf8')).scripts ?? {}));
  } catch {
    return new Map();
  }
}

/**
 * Does this upload path carry `file`?
 *
 * Exact match is the common case. A **directory** (`.run`) and a **glob**
 * (`.run/*`) carry everything under them too, and neither used to be recognised —
 * so a workflow that uploaded the whole directory was reported as carrying
 * nothing. That is a false positive in a check whose findings people act on, and
 * a check that cries wolf is a check that gets disabled.
 */
function uploadCarries(paths, file) {
  for (const p of paths) {
    if (p === file) return true;
    const prefix = p.endsWith('/*') ? p.slice(0, -1) : `${p.replace(/\/+$/, '')}/`;
    if (file.startsWith(prefix)) return true;
  }
  return false;
}

/** The `.run/` paths a step script reads, and the ones it writes. */
function runFilesOfScript(root, rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return null;
  const text = fs.readFileSync(abs, 'utf8');

  const aliases = new Map();
  for (const m of text.matchAll(RUN_ALIAS_RE)) aliases.set(m[1], m[2]);

  const writes = new Set();
  for (const m of text.matchAll(RUN_WRITE_RE)) {
    const file = m[1] ?? aliases.get(m[2]);
    if (file) writes.add(`.run/${file}`);
  }

  const reads = new Set();
  for (const m of text.matchAll(RUN_JOIN_RE)) {
    const file = `.run/${m[1]}`;
    if (!writes.has(file)) reads.add(file);
  }
  return { reads, writes };
}

export function checkArtifactHandoff(root = process.cwd()) {
  const dir = path.join(root, '.github/workflows');
  if (!fs.existsSync(dir)) return { ok: false, violations: [{ file: dir, error: 'no workflows directory' }] };

  const violations = [];
  let checked = 0;
  const npm = npmScripts(root);

  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))) {
    let wf;
    try {
      wf = parseYaml(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      violations.push({ file, error: `unparseable: ${err.message}` });
      continue;
    }

    // Per job, because a file crossing a job boundary only matters where the two
    // jobs coexist. Two steps in one job share a working directory, so the file
    // is simply there; the boundary is between jobs and nowhere else.
    const perJob = [];
    const uploadedNames = new Set();

    for (const { name: jobName, job } of jobsOf(wf)) {
      const scripts = new Set();
      const uploads = new Map(); // artifact name -> the paths it carries
      const downloads = new Map(); // artifact name -> where it lands

      for (const step of Array.isArray(job.steps) ? job.steps : []) {
        if (typeof step.run === 'string') {
          for (const m of step.run.matchAll(RUN_SCRIPT_RE)) scripts.add(`scripts/${m[1]}`);
          // `npm run <name>` is a producer too, and so is `npm test` — the same
          // thing by its other spelling. Only names that resolve to a script in
          // this repository are added: an unresolved name is not evidence of a
          // missing upload, and inventing a violation out of it is how a check
          // earns the reputation that gets it switched off.
          const bodies = [...step.run.matchAll(NPM_RUN_RE)].map((m) => npm.get(m[1]));
          if (NPM_TEST_RE.test(step.run)) bodies.push(npm.get('test'));
          for (const body of bodies) {
            if (!body) continue;
            for (const m of body.matchAll(RUN_SCRIPT_RE)) scripts.add(`scripts/${m[1]}`);
          }
        }
        const uses = typeof step.uses === 'string' ? step.uses : '';
        const actionRef = uses.split('@')[0];
        const inputs = step.with && typeof step.with === 'object' ? step.with : {};

        if (actionRef === 'actions/upload-artifact') {
          const name = inputs.name ? String(inputs.name) : null;
          if (!name) continue;
          uploadedNames.add(name);
          const paths = new Set();
          for (const line of String(inputs.path ?? '').split('\n')) {
            const t = line.trim();
            if (t) paths.add(t);
          }
          uploads.set(name, paths);
        }

        if (actionRef === 'actions/download-artifact') {
          const name = inputs.name ? String(inputs.name) : null;
          if (!name) continue;
          // The destination is where the consumer will look, and ignoring it was
          // a real blind spot: re-pointing a download at `state/` moves the file
          // somewhere the reader never looks, and comparing only the *name* saw
          // nothing. Same defect class, one layer over.
          downloads.set(name, String(inputs.path ?? '').trim() || '.');
        }
      }

      const perScript = new Map();
      for (const rel of scripts) perScript.set(rel, runFilesOfScript(root, rel));
      perJob.push({ jobName, perScript, uploads, downloads });
    }

    for (const { jobName, perScript, uploads, downloads } of perJob) {
      for (const [rel, own] of perScript) {
        if (!own) continue;
        for (const f of own.reads) {
          // The producer, and the job it runs in.
          let producer = null;
          let producerJob = null;
          for (const candidate of perJob) {
            for (const [other, o] of candidate.perScript) {
              if (other === rel || !o || !o.writes.has(f)) continue;
              producer = other;
              producerJob = candidate;
            }
          }
          if (!producer) continue;
          checked++;

          if (producerJob.jobName === jobName) continue; // one working directory

          const carriedBy = [...producerJob.uploads]
            .filter(([, paths]) => uploadCarries(paths, f))
            .map(([n]) => n);
          if (!carriedBy.length) {
            violations.push({
              file,
              job: jobName,
              path: f,
              script: rel,
              producer,
              rule: `I15: ${rel} reads ${f}, which ${producer} wrote in job "${producerJob.jobName}", but no upload carries it`,
            });
            continue;
          }

          // Carried is not the same as delivered: it must land where the reader
          // looks. `.run/decisions.json` is only delivered by a download into
          // `.run/`.
          const wanted = path.posix.dirname(f);
          const delivered = carriedBy.some(
            (n) => (downloads.get(n) ?? '').replace(/\/+$/, '') === wanted,
          );
          if (!delivered) {
            violations.push({
              file,
              job: jobName,
              path: f,
              script: rel,
              producer,
              rule:
                `I15: ${rel} reads ${f}, uploaded as ${carriedBy.map((n) => `"${n}"`).join('/')}, ` +
                `but job "${jobName}" never downloads it into ${wanted}/`,
            });
          }
        }
      }
    }

    // The cheap half: a download whose name nothing uploads.
    const downloadedNames = new Set();
    for (const { downloads } of perJob) for (const n of downloads.keys()) downloadedNames.add(n);
    for (const name of downloadedNames) {
      if (!uploadedNames.has(name)) {
        violations.push({
          file,
          name,
          rule: `I15: downloads artifact "${name}", which no step in this workflow uploads`,
        });
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checked,
    detail: `${checked} cross-job file(s) carried by an upload`,
  };
}

/**
 * I10 — the published surface holds no credential and calls no model.
 *
 * **It has to run on pages that were just rendered, and that ordering is the
 * check.** `site/*.html` are generated, so "the pages" means the renderer's
 * output — not whatever happens to be committed. `pages.yml` re-renders at
 * deploy time, so a committed page and the page Pages serves are different files
 * the moment the renderer changes. This function used to scan the committed copy
 * while `pages.yml` rendered and uploaded a different one, which meant a
 * credential introduced by a change to the template appeared in no committed
 * page, passed here, and shipped.
 *
 * Measured on a tree with a credential injected into the page template: without a
 * render this reported `holds`, exit 0; rendered first, two violations, exit 1.
 * The only difference was whether a human had run the renderer by hand. So
 * `ci.yml` renders before the invariants and `pages.yml` renders, checks, and
 * only then uploads.
 *
 * **The surface is `site/`, not `site/*.html`, and that distinction is the second
 * half of the same defect.** The HTML files are a *shell*: `index.html` holds
 * `<p>Loading the latest digest…</p>` inside `<section id="digest">` and fetches
 * `./api/digest.json` at runtime, assigning the result with `innerHTML`. Every
 * byte of content on the served page therefore arrives through `site/api/`, and
 * the three patterns below were only ever tested against the file that carries
 * none of it. Measured on one tree with the same text in both places: three
 * violations in `site/index.html`, none in `site/api/digest.json`.
 *
 * The digest is templated rather than narrated — `buildPublicSurface` passes
 * `narration: null`, so the public digest is a function of the projected payload
 * and not of a model's answer. This is therefore not a route for model prose. It
 * is a route for the *renderer's* output, and the renderer is code: the whole
 * point of reading the published bytes rather than the committed ones is that a
 * change to the generator is what this check exists to catch.
 *
 * The three patterns are applied to both halves rather than tiered. A predicate
 * for the data files that differed from the predicate for the pages would be a
 * second rule, and two rules drift — `lib/public-surface.mjs` makes the same
 * argument about a second filter. Over-strict is also the safe direction here:
 * the templated digest contains none of the three, so uniformity costs nothing
 * today and closes the surface the moment a fourth pattern is added.
 *
 * An empty half of the surface therefore **fails closed**. `site/` is committed
 * and the render step precedes this in both workflows, so no pages — or no data —
 * means the check could not look, which is not the same as having looked and
 * found nothing. Returning ok here would let the rule stop being enforced,
 * silently, the moment `site/` left the tree or the render step was dropped from
 * a workflow.
 */
export function checkPagesHoldNoKey(root = process.cwd()) {
  const dir = path.join(root, 'site');
  const apiDir = path.join(dir, 'api');
  const list = (where, ext) =>
    fs.existsSync(where) ? fs.readdirSync(where).filter((f) => f.endsWith(ext)) : [];
  const pages = list(dir, '.html');
  const data = list(apiDir, '.json');

  const missing = [];
  if (!pages.length) {
    missing.push({
      file: 'site',
      rule: 'I10: no page to check — render the site before running this',
    });
  }
  if (!data.length) {
    missing.push({
      file: 'site/api',
      rule: 'I10: no published data to check — render the site before running this',
    });
  }
  if (missing.length) return { ok: false, violations: missing };

  // One predicate over the whole surface. See the header: a predicate for the
  // data files that differed from this one would be a second rule that can
  // disagree with it.
  const PATTERNS = [
    [/\b(LLM_API_KEY|JEV_API_KEY|GITHUB_TOKEN|api[_-]?key)\b/i, 'a page must never hold a credential'],
    [
      /\bfetch\(\s*['"`]https?:\/\/[^'"`]*\/(?:v1|v4)\/(?:chat|messages|completions)/i,
      'a page must never call a model',
    ],
    [/\b(workflow_dispatch|repository_dispatch)\b/, 'a page must never trigger a workflow'],
  ];

  const violations = [];
  for (const [where, files] of [
    [dir, pages],
    [apiDir, data],
  ]) {
    for (const file of files) {
      const text = fs.readFileSync(path.join(where, file), 'utf8');
      for (const [pattern, rule] of PATTERNS) {
        if (pattern.test(text)) {
          violations.push({
            file: path.relative(root, path.join(where, file)),
            rule: `I10: ${rule}`,
          });
        }
      }
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checked: pages.length + data.length,
    detail: `${pages.length} page(s) checked, ${data.length} data file(s) checked`,
  };
}

/* -------------------------------------------------------------- I16 ------ */

/**
 * I16 — the public renderer reads only the projected surface.
 *
 * `scripts/render-site.mjs` runs in `pages.yml`, which checks out committed files
 * and downloads no artifact. It therefore never sees `.run/payload.json`, and it
 * **cannot** project a payload — the projection runs in the commit job, the only
 * component that holds the payload, the decisions and a write token, and the
 * keyless job (I1/I2). The renderer's whole job is to read what was already
 * projected.
 *
 * That makes its **read set** the security boundary. `data/stack.json` is the
 * watch list itself, `data/summary.json` is the private summary, and
 * `history/commands.jsonl` rows carry a GitHub login (`lib/commands.mjs:24`);
 * everything this script reads is written to a world-readable Pages artifact. A
 * regression here is silent — the page renders, the run is green, and the only
 * symptom is a name that should not be public.
 *
 * **It is an allowlist, and it used to be a denylist.** The first version of this
 * check banned two literals — `data/summary.json` and `history/commands.jsonl`.
 * A renderer that read `data/stack.json` and wrote it to `site/data/watch.json`
 * passed with `{ok: true, violations: []}` and published the entire private watch
 * list. That is the P2-1 error committed inside the check written to enforce
 * P2-1's decision: publication is irreversible, so the boundary must fail
 * **closed**, and a denylist fails open in exactly the direction with no remedy.
 * A private file added tomorrow must fail by default, not pass because nobody
 * thought to name it.
 *
 * **Inverting the policy was half of it; the *detection* was the other half.**
 * The second version kept an allowlist of readable paths but still went looking
 * for reads **by shape** — a list of eight read functions, and three spellings of
 * a target. That fails open for the same reason the denylist did: the shapes are
 * the thing being enumerated, so a read spelled any other way is not seen at all.
 * A verifier demonstrated it — the private watch list reached the published
 * directory through spellings the shape list did not cover, and the check
 * returned `{ok: true, violations: []}`.
 *
 * So detection is by **content**, not by shape. Any string literal in the file
 * that *resolves into a collector root* is a private path, whatever function it
 * is passed to and however it was assembled. The roots are derived from
 * `COLLECTOR_ALLOWLIST` in `lib/store.mjs` rather than restated, so a directory
 * added to the write allowlist tomorrow is a read target here without anyone
 * editing this file — which is precisely the property a denylist cannot have.
 *
 * Five assertions:
 *
 *   1. **No literal resolves into a collector root** unless it is a projected
 *      artifact. The renderer may name the declared `PUBLIC_SUMMARY` and
 *      `digest/`, and nothing else. A literal is a candidate when every one of
 *      its characters is a path character, it carries no `..`, and it resolves
 *      into a collector root — a **resolution** test, not a slash test. The
 *      charset is a guard and not the discriminator: `text/html` and
 *      `application/json` are made only of path characters and are not paths,
 *      `/issues/new` is path-shaped and is not a collector path, and the root
 *      test rejects all three. That is also why the page's own `'</div>'` and
 *      MIME strings are not reported — a check that cries wolf gets disabled.
 *   2. **`PUBLIC_SUMMARY` is declared as a public path**, read out of
 *      `lib/public-surface.mjs` — the way I4 reads `GATE_EXEMPT` out of
 *      `lib/store.mjs` and I13 reads the author allowlist out of the script.
 *      Importing the value would make this branch impossible to see fail. The
 *      permitted set in assertion 1 is *derived* from this declaration, so it
 *      needs its own guard: re-pointing the constant would otherwise widen the
 *      set to match. That guard is a **marker**, not a list — the declared
 *      basename must carry `PUBLIC_DIGEST_PREFIX`, the same opt-in the projection
 *      itself uses. A list of forbidden paths fails open on the path it has not
 *      heard of, which is how `data/heartbeat.json`, `data/triage.jsonl` and
 *      `history/runs.jsonl` all passed the first version of this guard.
 *   3. **A read target is one of three forms.** For the functions named in
 *      `READ_FUNCTIONS`, the first argument must be an allowlisted literal, the
 *      declared constant identifier, or `path.join(<literal>, <expr>)` with the
 *      root folded one level through `const`. Anything else — a concatenation, an
 *      identifier that is not the declared constant, a `path.join` whose root is
 *      a variable — is refused. This is the clause that closes what assertion 1
 *      cannot see, because a computed target contains no literal to resolve. It
 *      is also why the renderer's `readJson(rel)` had to be **specialised rather
 *      than exempted**: a helper taking a path argument has a variable root
 *      inside it, and exempting the helper exempts every call through it.
 *   4. **The digest directory, if enumerated, is narrowed to the shared
 *      `PUBLIC_DIGEST_PREFIX`.** The private and public digests share a directory
 *      and a date, so an unnarrowed read takes whichever sorts last — which is
 *      the public one only because `'p' > '2'`, a property of the sort rather
 *      than a decision.
 *   5. **The narrowing is applied, not merely mentioned.** The prefix must appear
 *      in the statement that enumerates `digest/`. It was previously searched for
 *      anywhere in the file, so an unused `import` satisfied it — and so did
 *      `name.slice(PUBLIC_DIGEST_PREFIX.length)` sitting beside an unnarrowed
 *      `.filter((f) => f.endsWith('.md'))`. Both are pinned by synthetic cases.
 *
 * The prefix is read out of `lib/public-surface.mjs` rather than restated, for
 * the reason I13 reads the author allowlist out of the script: two copies of a
 * marker drift, and the copy that drifts is the one nobody re-reads.
 *
 * **Non-vacuous by construction.** A renderer that never reads `PUBLIC_SUMMARY`
 * in executable code fails the floor below, and a surface that declares no
 * summary path fails assertion 2 — so an empty or unreadable renderer cannot pass
 * this check by having nothing to find.
 *
 * **Which clause owns which spelling.** Two clauses overlap, and the one that
 * reports is not always the one that noticed. Written down because the ownership
 * is invisible in the code and obvious once stated, and because a future editor
 * "tidying" it will double every finding rather than break a test. Grouped by
 * owner:
 *
 *   - **The content clause alone.** A literal that resolves, passed to anything:
 *     `readJson('data/stack.json')`, `fs.createReadStream('data/stack.json')`,
 *     `fs.openSync('data/stack.json')` + `readSync`, `fs.promises.open(…)`,
 *     `await import('data/stack.json')`, a template literal, the `./` and `//`
 *     spellings, and the root itself (`fs.readdirSync('data')`). The *function* is
 *     never what makes these visible — the literal is. That is the inversion, and
 *     it is why `READ_FUNCTIONS` is not load-bearing for this clause.
 *   - **Rule 2 alone.** A target with no literal to resolve: `readJson(A + '/' + B)`
 *     where neither piece resolves, `path.join(SOME_DIR, 'stack.json')` whose root
 *     is not a literal, `readJson(P)` where `P` is not the declared constant, an
 *     interpolated template, a backslash-escaped slash.
 *   - **Rule 2 alone, by construction.** A `..` literal read target. The content
 *     clause excludes `..` from candidates so that no relative import can produce
 *     a false positive, which leaves the form clause as the only clause that can
 *     catch `readJson('data/../data/stack.json')`. It is excluded from one clause
 *     and owned by the other deliberately: a gap here would be the same failure
 *     this check was rewritten to close.
 *   - **Both, and not a duplicate.** `String('data/stack.json')`,
 *     `new URL('data/stack.json', …)`, `['data','stack.json'].join('/')`, and a
 *     const-bound concat. The literal is one defect and the uncheckable form is
 *     another; each would still be a defect if the other were absent.
 *   - **The content clause, with rule 2 deferring.** `path.join('data','stack.json')`
 *     and a join whose root folds to a private literal. Rule 2's join branch hands
 *     the finding back rather than naming the same thing twice, which is why these
 *     report the literal (`data`) and not the join expression.
 *
 * **The deferral rule, stated because removing it breaks nothing and hides
 * everything.** Rule 2's *literal* branch and its *join* branch both defer to the
 * content clause whenever the literal involved is a candidate — that is, whenever
 * the content clause will report it. The *identifier* and *computed* branches
 * never defer, because there is no candidate literal for the content clause to
 * own. Delete the deferral and no test fails that asserts a path is refused: you
 * simply get two findings for one defect, which is how a check becomes noise and
 * then gets switched off.
 *
 * **Two mechanisms that are easy to mis-state, both mis-stated in review.** The
 * const-bound concat —
 * `const A = 'data'; const B = 'stack.json'; readJson(A + '/' + B)` — is red
 * because the literal `'data'` is in the file and the content clause scans every
 * literal, *and* because `A + '/' + B` is a computed target for rule 2. It is
 * **not** red because of const-folding: `constLiterals()` and `literalValue()`
 * are applied only to the root of `path.join(…)`, and folding never touches `+`.
 * And const-folding's load-bearing role is the opposite of closing an attack — it
 * keeps **permitted** variable roots resolvable. `const DIGEST = 'digest';
 * fs.readFileSync(path.join(DIGEST, name))` is the shape the real renderer uses,
 * and without folding its root is unresolvable and rule 2 refuses correct code. It
 * closes `path.join(VARIABLE, 'stack.json')` only as a side effect, and only
 * because the literal `'data'` is elsewhere in the file for the content clause to
 * find.
 *
 * **What it cannot see, named rather than discovered.** Assertion 3 closes
 * *enumerated function + computed target*; it does not close *unenumerated
 * function + computed target*. `fs.createReadStream(A + '/' + B)` is neither a
 * name in `READ_FUNCTIONS` nor a literal that resolves, so it passes — and so
 * does a path split across two literals (`'da' + 'ta/stack.json'`), which leaves
 * no single literal to resolve, and a `..` literal handed to an unenumerated
 * function, which the content clause excludes by design and the form clause never
 * sees. The limit has two conditions and both are required: a concat passes only
 * when no component is a resolvable literal **and** the function is not
 * enumerated. These are real gaps, and they are **asserted as gaps** in
 * `tests/invariants.test.mjs` rather than left for someone to find. The
 * completeness half is not static at all: the pipeline canary runs the real commit
 * step and the real renderer over a sentinel private package and sweeps every
 * published byte, which is what catches a filter that runs and is given the wrong
 * content. This check guards the regressions that are easy to make; it is not a
 * proof that the read set is closed.
 */
const PUBLIC_RENDERER = 'scripts/render-site.mjs';
const PUBLIC_SURFACE = 'lib/public-surface.mjs';
const DECLARED_SUMMARY_RE = /export const PUBLIC_SUMMARY\s*=\s*['"]([^'"]+)['"]/;

/**
 * The collector's roots, taken from the write allowlist rather than restated.
 *
 * This is the whole inversion in one line. A denylist names the private paths it
 * knows about and passes every path it has never heard of; deriving the roots
 * from `COLLECTOR_ALLOWLIST` means the private set and the checked set cannot
 * drift apart, because they are the same set. `README.md` is in that allowlist as
 * a single file rather than a directory, so `s === root` is what matches it — and
 * `README.md/anything` is refused as well, which is not a real path and costs
 * nothing to refuse.
 */
const COLLECTOR_ROOTS = COLLECTOR_ALLOWLIST;

/** Every character a repository path is made of, and nothing else. */
const PATH_CHARSET_RE = /^[A-Za-z0-9._/-]+$/;

/** A quoted run on one line. Escapes are not modelled; a path literal has none. */
const LITERAL_RE = /(['"`])([^'"`\n]*)\1/g;

/**
 * The functions whose first argument assertion 3 inspects.
 *
 * Assertion 1 does not depend on this list — it scans literals, so a private
 * literal is caught whatever it is passed to. The list bounds assertion 3 only,
 * which is the weaker half: it exists for *computed* targets, where there is no
 * literal to resolve. Its reach is therefore exactly its contents, and the header
 * names the consequence rather than leaving it to be discovered.
 */
const READ_FUNCTIONS = [
  'existsSync',
  'readdirSync',
  'readFileSync',
  'readFile',
  'statSync',
  'readJson',
  'readJsonIfExists',
  'readRows',
];
const READ_CALL_RE = new RegExp(`\\b(${READ_FUNCTIONS.join('|')})\\s*\\(`, 'g');

/** `const NAME = <literal>` — one level of folding, the way I15 folds one level. */
const CONST_LITERAL_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]*)\2/g;

/** The export the renderer must import rather than restating the path. */
const SUMMARY_CONST = 'PUBLIC_SUMMARY';

/** The statement that enumerates the digest directory, up to its `;`. */
const DIGEST_ENUM_RE = /readdirSync\(\s*['"`]digest['"`]\s*\)[\s\S]*?;/;

/** `./x` and `a//b` are the same path spelled two ways. */
function normalisePath(literal) {
  return literal.replace(/^\.\//, '').replace(/\/{2,}/g, '/');
}

/**
 * Collapse `.` and `..` segments and return the resolved path, or `null` if
 * the traversal escapes the root.
 *
 * The single primitive the whole check decides by. Three clauses used to decide
 * by spelling instead — `isProjected()` was a prefix test, the candidate test
 * excluded any literal containing `..`, and the `path.join` branch folded only
 * its first argument — and each one made a traversal's verdict depend on how it
 * was written rather than where it landed. They now all call this.
 */
function resolveSegments(literal) {
  const segs = normalisePath(literal).split('/');
  const out = [];
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/**
 * Does this literal name something under a collector root?
 *
 * `data` and `data/stack.json` both resolve; `database` does not, because the
 * root has to be the whole first segment — otherwise the check would report
 * `database.json` and get turned off.
 */
function resolvesIntoCollectorRoot(literal) {
  const s = normalisePath(literal);
  return COLLECTOR_ROOTS.some((root) => s === root || s.startsWith(`${root}/`));
}

/**
 * A literal that could name a private path at all.
 *
 * Decided by **resolution**, not spelling. `data/../lib/x.mjs` starts with a
 * collector root and does not resolve under one; `data/../data/stack.json` is a
 * collector path that a prefix test cannot see. Both directions matter, and both
 * were wrong while this was a prefix test: the first is the false positive that
 * gets a check turned off, the second is a hole — a `..` literal passed to a
 * reader outside `READ_FUNCTIONS` is invisible to this clause *and* to the form
 * clause, so `fs.createReadStream('data/../data/stack.json')` was seen by
 * neither. The `!literal.includes('..')` guard this replaces was itself a
 * spelling test, which is why a traversal could be refused by one clause and
 * excused by another depending only on how it was written.
 *
 * A literal whose `..` escapes the repository root entirely resolves to nothing
 * and is not a candidate *here*: `../data/stack.json` names a directory beside
 * the repository rather than the private one, so treating it as one would be a
 * false positive. The form clause refuses it when it is a read target, which is
 * the policy — the renderer reads the projected artifacts and nothing else.
 */
function isCandidatePath(literal) {
  if (!PATH_CHARSET_RE.test(literal)) return false;
  const s = resolveSegments(literal);
  if (s === null) return false;
  return resolvesIntoCollectorRoot(s);
}

/** Every quoted run in the executable text. */
function literalsIn(text) {
  return [...text.matchAll(LITERAL_RE)].map((m) => m[2]);
}

/** `const` names bound to a literal, for one level of folding. */
function constLiterals(text) {
  const out = {};
  for (const m of text.matchAll(CONST_LITERAL_RE)) out[m[1]] = m[3];
  return out;
}

/**
 * Arguments of a `path.join(…)` call as source text strings.
 *
 * The target already starts with `path.join(`; everything inside its matching
 * parentheses is split on commas at depth zero. This is enough to fold every
 * argument when they are all literals or const-bound names.
 */
function pathJoinArgs(target) {
  const innerStart = target.indexOf('(') + 1;
  let depth = 0;
  const args = [];
  let current = '';
  for (let i = innerStart; i < target.length; i += 1) {
    const ch = target[i];
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      current += ch;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) {
        args.push(current.trim());
        break;
      }
      depth -= 1;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  return args;
}

/**
 * The first argument of every read call, as source text.
 *
 * Scanned rather than parsed: a comma or a closing bracket at depth zero ends the
 * argument, which is enough to recognise the three forms assertion 3 admits and
 * to refuse everything else.
 */
function readCallTargets(text) {
  const out = [];
  for (const m of text.matchAll(READ_CALL_RE)) {
    const start = m.index + m[0].length;
    let depth = 0;
    let i = start;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === ',' && depth === 0) break;
    }
    out.push({ fn: m[1], target: text.slice(start, i).trim() });
  }
  return out;
}

/**
 * Split at depth-zero commas — a declarator list, or an argument list.
 */
function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s !== '');
}

/**
 * Does this source **bind** the name locally, rather than importing it?
 *
 * A single pattern loose enough to catch `const PUBLIC_SUMMARY = …` also catches
 * `const summary = readJson(PUBLIC_SUMMARY)` — a declaration that merely *uses*
 * the name, and the shape a renderer naturally has. Reporting that would be a
 * false positive on correct code, which is how a check gets turned off. So
 * declarations are split into their declarators and only the **binding** half of
 * each is tested, which is the half before the `=`. Destructuring falls out of the
 * same test, because the names it binds are on that side too.
 */
function declaresName(text, name) {
  const binding = new RegExp(`\\b${name}\\b`);
  for (const m of text.matchAll(/\b(?:const|let|var)\b([^;]*)/g)) {
    for (const declarator of splitTopLevel(m[1])) {
      if (binding.test(declarator.split('=')[0])) return true;
    }
  }
  return false;
}

/** A literal, or a name bound to one — the fold that closes `path.join(DIR, …)`. */
function literalValue(expr, consts) {
  const asLiteral = expr.match(/^(['"`])([^'"`\n]*)\1$/);
  if (asLiteral) return asLiteral[2];
  if (/^[A-Za-z_$][\w$]*$/.test(expr) && Object.hasOwn(consts, expr)) return consts[expr];
  return null;
}

export function checkPublicRendererReadsNoPrivatePath(root = process.cwd()) {
  const abs = path.join(root, PUBLIC_RENDERER);
  if (!fs.existsSync(abs)) {
    return { ok: false, violations: [{ file: PUBLIC_RENDERER, error: 'missing' }] };
  }
  // Executable text only. The module header names the paths it forbids, and a
  // rule that fired on the paragraph explaining it could not be documented — the
  // same reason I8 scans code and not comments.
  const text = stripCommentLines(fs.readFileSync(abs, 'utf8'));
  // An import is not a use: `import { PUBLIC_SUMMARY }` must not satisfy the
  // floor below, or a file that reads nothing at all would pass.
  const used = text
    .split('\n')
    .filter((l) => !/^\s*import\b/.test(l))
    .join('\n');
  const violations = [];

  /**
   * The guard is a **marker**, not a list.
   *
   * The first version of this guard enumerated the private paths it knew about —
   * `data/summary.json`, `data/stack.json`, `history/commands.jsonl` — and passed
   * every path it had never heard of. Measured by re-pointing `PUBLIC_SUMMARY`:
   * `data/heartbeat.json` (which carries `consecutive_failures`, the very field the
   * public heartbeat reduction removed), `data/triage.jsonl` (committed,
   * append-only, holding endpoint response bodies) and `history/runs.jsonl` (the
   * private run chain) all passed. That is N20's error a second time — a denylist
   * inside the check written to enforce an allowlist decision — and it failed open
   * in the one direction with no remedy, because a published surface cannot be
   * un-published and a fork cannot be recalled.
   *
   * The projection already carries the answer, so the guard needs no list: it
   * writes into a *public namespace* marked by `PUBLIC_DIGEST_PREFIX`. A projected
   * artifact is **marked**, not listed. Asking whether the declared basename
   * carries that marker is one rule derived from a declared constant, and it closes
   * all three holes at once while going on closing the ones nobody has thought of
   * yet.
   *
   * A file named `public-*` that is not in fact publishable stays green, and that is
   * intended rather than a hole: carrying the marker **is** the declaration that a
   * file is publishable, so a private file wearing it would be a deliberate act
   * rather than an accident. Do not tighten this by reflex.
   */
  // ---- assertion 2: the declaration the permitted set is derived from ------
  const surfacePath = path.join(root, PUBLIC_SURFACE);
  const declared = fs.existsSync(surfacePath)
    ? fs.readFileSync(surfacePath, 'utf8').match(DECLARED_SUMMARY_RE)
    : null;
  if (!declared) {
    violations.push({
      file: PUBLIC_SURFACE,
      rule: 'I16: PUBLIC_SUMMARY is not declared, so the readable set is unasserted',
    });
  } else if (!path.posix.basename(declared[1]).startsWith(PUBLIC_DIGEST_PREFIX)) {
    violations.push({
      file: PUBLIC_SURFACE,
      rule:
        `I16: PUBLIC_SUMMARY names ${declared[1]}, whose basename does not carry the ` +
        `${PUBLIC_DIGEST_PREFIX} marker — a projected artifact is marked, not listed`,
    });
  }

  /** The only paths this file may name: the declared summary, and digest/. */
  const isProjected = (literal) => {
    const s = resolveSegments(literal);
    if (s === null) return false;
    return s === declared?.[1] || s === 'digest' || s.startsWith('digest/');
  };

  // ---- assertion 1: no literal resolves into a collector root --------------
  for (const literal of literalsIn(text)) {
    if (isCandidatePath(literal) && !isProjected(literal)) {
      violations.push({
        file: PUBLIC_RENDERER,
        target: literal,
        rule: `I16: the public renderer names ${literal}, which resolves into a collector root`,
      });
    }
  }

  // ---- assertion 3: a read target is one of three forms -------------------
  const consts = constLiterals(text);
  for (const { fn, target } of readCallTargets(text)) {
    const asLiteral = target.match(/^(['"`])([^'"`\n]*)\1$/);
    if (asLiteral) {
      if (isProjected(asLiteral[2])) continue;
      // A literal that assertion 1 *would* treat as a candidate is already
      // reported there, and reporting it twice would be noise. This clause exists
      // for the literals assertion 1 deliberately does not treat as candidates —
      // a `..` segment, or characters outside the path charset — which are read
      // targets all the same and must not slip through both clauses.
      if (isCandidatePath(asLiteral[2])) continue;
      violations.push({
        file: PUBLIC_RENDERER,
        target: asLiteral[2],
        rule: `I16: ${fn} reads ${target}, which is not a projected artifact`,
      });
      continue;
    }

    if (/^[A-Za-z_$][\w$]*$/.test(target)) {
      if (target === SUMMARY_CONST) continue;
      violations.push({
        file: PUBLIC_RENDERER,
        target,
        rule: `I16: ${fn} is given the name ${target}, which is not the declared ${SUMMARY_CONST}`,
      });
      continue;
    }

    const join = target.match(/^path\.join\(\s*/);
    if (join) {
      const args = pathJoinArgs(target);
      const folded = args.map((a) => literalValue(a, consts));
      // If every argument folds to a literal, resolve the whole join and test
      // the resolved path. This closes traversal-by-join when the components are
      // statically knowable.
      if (folded.every((f) => f !== null)) {
        const joined = folded.join('/');
        const resolved = resolveSegments(joined);
        if (resolved !== null && isProjected(resolved)) continue;
        // If assertion 1 would catch a bare component literal, defer to it so
        // one defect produces one finding. (A literal like 'data' is a candidate
        // and not projected, so assertion 1 reports it.)
        if (resolved !== null && isCandidatePath(resolved)) {
          const wouldBeCaughtByA1 = folded.some(
            (f) => f !== null && isCandidatePath(f) && !isProjected(f)
          );
          if (wouldBeCaughtByA1) continue;
        }
        violations.push({
          file: PUBLIC_RENDERER,
          target: resolved ?? joined,
          rule:
            resolved === null
              ? `I16: ${fn} is given ${target}, whose resolved path escapes the repository root`
              : `I16: ${fn} is given ${target}, whose resolved path ${resolved} is not a projected artifact`,
        });
        continue;
      }
      // The join cannot be resolved because at least one component is not
      // statically known — the shape the real renderer uses, `path.join('digest',
      // name)`. Two things are still checkable, and the first is the half this
      // branch omitted: a `..` in **any** argument that did fold. A traversal
      // beside a variable component lands somewhere this check cannot compute,
      // and `path.join('digest', name, '../data/stack.json')` returned
      // `{ok: true}` while `path.join('digest', '../data/stack.json')` was
      // refused — the same predicate, one argument over.
      //
      // The asymmetry with the branch above is deliberate and is the same rule
      // read two ways: when every component is known the **resolved** path
      // decides, so a `..` that lands back inside the projected set is still
      // projected; when a component is unknown the path cannot be resolved, and
      // a traversal among the parts that *are* known fails closed.
      const traversal = folded.find(
        (f) => f !== null && f.split('/').includes('..') && !isCandidatePath(f),
      );
      if (traversal !== undefined) {
        violations.push({
          file: PUBLIC_RENDERER,
          target: traversal,
          rule:
            `I16: ${fn} is given ${target}, whose argument ${traversal} traverses out of the ` +
            'root it is joined to',
        });
        continue;
      }
      // The root, which is what keeps a legitimate variable tail green.
      const rootExpr = args[0] ?? '';
      const rootFolded = literalValue(rootExpr, consts);
      if (rootFolded !== null && isProjected(rootFolded)) continue;
      if (rootFolded !== null && isCandidatePath(rootFolded)) continue;
      violations.push({
        file: PUBLIC_RENDERER,
        target: rootFolded ?? target,
        rule:
          rootFolded === null
            ? `I16: ${fn} is given ${target}, whose root is not a literal and cannot be resolved`
            : `I16: ${fn} is given ${target}, whose root ${rootFolded} is not a projected artifact`,
      });
      continue;
    }

    violations.push({
      file: PUBLIC_RENDERER,
      target,
      rule:
        target === ''
          ? `I16: ${fn} is called with no target, which reads whatever the working directory holds`
          : `I16: ${fn} is given a computed target (${target}), which no allowlist can check`,
    });
  }

  /**
   * Rule 2 accepts any identifier spelled `PUBLIC_SUMMARY`, and the property §I2
   * treats as *the* enforcement — `buildFacts()` taking one argument — is exactly
   * what a shadowed constant defeats. With the import deleted and
   * `const A = 'da', B = 'ta/stack.json', PUBLIC_SUMMARY = A + '/' + B;`,
   * `readJson(PUBLIC_SUMMARY)` is a read of the renderer's own string while every
   * clause above still reads as satisfied: neither `'da'` nor `'ta/stack.json'`
   * resolves into a collector root, the target is the declared name, and the floor
   * below is satisfied by the declaration itself.
   *
   * So the name is not the binding. The renderer may use the declaration it
   * imports; it may not bind one of its own. The test is applied to the **binding
   * half** of each declarator, because a pattern loose enough to catch
   * `const PUBLIC_SUMMARY = …` also catches `const summary = readJson(PUBLIC_SUMMARY)`
   * — correct code — and a false positive on correct code is how a check gets
   * turned off.
   */
  if (declaresName(text, SUMMARY_CONST)) {
    violations.push({
      file: PUBLIC_RENDERER,
      rule:
        `I16: the public renderer declares ${SUMMARY_CONST} locally, so a read of it is a ` +
        "read of the renderer's own binding rather than the projected surface",
    });
  }

  if (!used.includes(SUMMARY_CONST)) {
    violations.push({
      file: PUBLIC_RENDERER,
      rule: `I16: the public renderer never reads ${SUMMARY_CONST}, so it is not reading the projected surface`,
    });
  }

  // ---- assertions 4 and 5: the digest narrowing is applied -----------------
  const enumeration = text.match(DIGEST_ENUM_RE);
  if (enumeration && !enumeration[0].includes('PUBLIC_DIGEST_PREFIX')) {
    violations.push({
      file: PUBLIC_RENDERER,
      rule: `I16: the public renderer enumerates digest/ without narrowing to ${PUBLIC_DIGEST_PREFIX}`,
    });
  }

  return { ok: violations.length === 0, violations };
}

/** Run every check. */
export function runAll(root = process.cwd()) {
  const results = {
    'I1 one privilege per job': checkOnePrivilegePerJob(root),
    'I2 gate placement': checkGatePlacement(root),
    'I3 write allowlist source': checkDirtyPaths('', CI_ALLOWLIST),
    'I4 heartbeat exemption': checkHeartbeatExempt(root),
    'I5 hash chain': checkHashChain(root),
    'I7 sandbox isolation': checkSandboxIsolated(root),
    'I8 no vendor names': checkNoVendorNames(root),
    'I10 pages hold no key': checkPagesHoldNoKey(root),
    'I12 actions pinned': checkActionsPinned(root),
    'I13 author gate mirrors script': checkAuthorGateMirrorsScript(root),
    'I14 config surface': checkConfigSurface(root),
    'I15 artifact handoff': checkArtifactHandoff(root),
    'I16 public renderer reads no private path': checkPublicRendererReadsNoPrivatePath(root),
  };
  return { ok: Object.values(results).every((r) => r.ok), results };
}
