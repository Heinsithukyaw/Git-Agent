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
import { verifyChain, CI_ALLOWLIST } from './store.mjs';

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
 * Strip the parts of a file that cannot be an opinion.
 *
 * Two exclusions, both narrow on purpose:
 *
 *   - the VENDOR_PATTERNS block itself. The vocabulary has to live somewhere,
 *     and it lives here as data. Exempting the whole file would let real
 *     provider-specific logic hide in it; exempting the array does not.
 *   - whole-line comments. Documentation may name a provider to explain what a
 *     request shape is; an executable line may not depend on one. This is a
 *     line-level filter, so a URL such as `https://…` is never truncated.
 */
function scanableText(text) {
  const withoutPatterns = text.replace(
    /const VENDOR_PATTERNS = \[[\s\S]*?\];/,
    '/* vocabulary omitted */',
  );
  return withoutPatterns
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*|\*\/)/.test(l))
    .join('\n');
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
 * I2 — the gate runs only in jobs that hold no model key.
 *
 * Enforced by import graph: only the commit and reply entry points may reach
 * lib/gate.mjs. A gate reachable from a narrating job is a gate the model's
 * input can influence.
 */
const GATE_CONSUMERS = new Set(['scripts/commit-step.mjs', 'scripts/reply-step.mjs']);

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
  if (res.ok) return { ok: true, rows: res.rows };
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
  return { ok: violations.length === 0, violations, pins: [...pins].sort() };
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
  return { ok: violations.length === 0, violations, allowed };
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

  return { ok: violations.length === 0, violations, checked };
}

/** I10 — the pages hold no credential and no model call. */
export function checkPagesHoldNoKey(root = process.cwd()) {
  const violations = [];
  const dir = path.join(root, 'site');
  if (!fs.existsSync(dir)) return { ok: true, skipped: true };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.html'))) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    if (/\b(LLM_API_KEY|JEV_API_KEY|GITHUB_TOKEN|api[_-]?key)\b/i.test(text)) {
      violations.push({ file, rule: 'I10: a page must never hold a credential' });
    }
    if (/\bfetch\(\s*['"`]https?:\/\/[^'"`]*\/(?:v1|v4)\/(?:chat|messages|completions)/i.test(text)) {
      violations.push({ file, rule: 'I10: a page must never call a model' });
    }
    if (/\b(workflow_dispatch|repository_dispatch)\b/.test(text)) {
      violations.push({ file, rule: 'I10: a page must never trigger a workflow' });
    }
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
  };
  return { ok: Object.values(results).every((r) => r.ok), results };
}
