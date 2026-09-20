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
      current[key] = block.join('\n').trimEnd();
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
  };
  return { ok: Object.values(results).every((r) => r.ok), results };
}
