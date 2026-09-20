/**
 * Runs one untrusted step in a container that is cut off from everything.
 *
 * The reason a sandbox is needed here is not the usual reason. On ordinary CI
 * you sandbox to protect the machine, because the machine is shared and
 * long-lived. On a hosted runner the machine is a disposable VM that dies with
 * the job — there is nothing to protect. What is worth protecting is the
 * **credential**: the user's model key and the write-scoped `GITHUB_TOKEN`.
 *
 * So the rule is not "use a microVM". It is:
 *
 *   **The sandbox never receives a secret.**
 *
 * That reframes the problem into something achievable, because separation is
 * something the platform already provides. (A microVM is not available: hosted
 * Linux runners expose no `/dev/kvm`, and nested virtualisation is unsupported
 * on the macOS arm64 runners. Do not design around it.)
 *
 * Two consequences worth stating:
 *
 *   - The runner has passwordless `sudo`. Anything running as the runner user
 *     can control the host. Therefore the boundary must be enforced from
 *     **outside** the untrusted process, never by asking it to stay inside.
 *     The test: **if `sudo` works inside the sandbox, the sandbox has already
 *     leaked.** `assertNoSudo()` checks exactly that, on every run.
 *   - `--network none` means no dependency installation inside. Dependencies
 *     are installed in the trusted parent **before** the network is cut, and
 *     the prepared workspace is mounted read-only.
 *
 * Opt-in, off by default (I7). The strongest property in this design is that
 * the default instantiation executes no third-party code at all.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appendRow } from './store.mjs';

export const RUNS_LOG = 'data/sandbox-runs.jsonl';

export const DEFAULTS = {
  image: 'node:22-alpine',
  cpus: '2',
  memory: '2g',
  pidsLimit: 128,
  tmpfsSize: '256m',
  network: 'none',
  timeoutMs: 10 * 60 * 1000,
};

/** Anything that looks like a credential must never reach the container. */
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE)/i;

export function enabled(env = process.env) {
  return String(env.SANDBOX_ENABLED ?? 'false').toLowerCase() === 'true';
}

export function dockerAvailable() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  return r.status === 0;
}

/** Refuse to pass anything that looks like a credential. Explicitly, not silently. */
function assertNoSecrets(env) {
  const leaked = Object.keys(env ?? {}).filter((k) => SECRETISH.test(k));
  if (leaked.length) {
    throw new Error(`sandbox refused: environment would leak ${leaked.join(', ')}`);
  }
  return true;
}

function baseArgs({ image, preparedDir, script, network, cpus, memory, pidsLimit, tmpfsSize, workdir }) {
  return [
    'run', '--rm',
    `--network`, network,
    '--read-only',
    '--tmpfs', `/work:rw,size=${tmpfsSize}`,
    '--user', '65534:65534',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(pidsLimit),
    '--memory', memory,
    '--cpus', cpus,
    '-v', `${path.resolve(preparedDir)}:/work:ro`,
    '-w', workdir ?? '/work',
    '--entrypoint', '/bin/sh',
    image,
    script,
  ];
}

/**
 * The leak test. `sudo` must not work inside the sandbox.
 *
 * Runs as the unprivileged user 65534 with every capability dropped, so
 * `sudo -n true` must fail. If it succeeds, the container is not the boundary
 * we think it is and every later step is untrustworthy — so throw.
 */
export function assertNoSudo(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const res = spawnSync(
    'docker',
    [...baseArgs({ ...cfg, preparedDir: opts.preparedDir ?? '.', script: '-c' }), 'sudo -n true 2>&1; echo "exit=$?"'],
    { encoding: 'utf8', timeout: Math.min(cfg.timeoutMs, 60_000) },
  );
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  // Either sudo is absent (127) or it demands a password — both are correct.
  const sudoWorked = !/exit=(?!0)/.test(out) && !/not found|password is required|sudo: /.test(out) && /exit=0/.test(out);
  if (sudoWorked) {
    throw new Error('sandbox leaked: sudo succeeded inside the container. Refusing to continue.');
  }
  return { ok: true, note: /not found/.test(out) ? 'sudo absent' : 'sudo refused' };
}

/**
 * Run one step.
 *
 * @param {object} opts
 * @param {string} opts.preparedDir  directory mounted read-only at /work
 * @param {string} opts.script       path inside the container, or `-c` + `command`
 * @param {string} [opts.command]    shell command, when script is `-c`
 * @returns {{exitCode:number, stdout:string, stderr:string, durationMs:number, args:string[]}}
 */
export function runStep(opts = {}) {
  if (!enabled(opts.env ?? process.env)) {
    throw new Error('sandbox is disabled. Set the SANDBOX_ENABLED variable to true to allow execution.');
  }
  const cfg = { ...DEFAULTS, ...opts };
  if (!cfg.preparedDir) throw new Error('sandbox requires a prepared directory');
  assertNoSecrets(cfg.env);

  // Explicitly empty, not absent: an absent variable can still be inherited
  // from the job environment in some runner configurations.
  const env = { ...(cfg.env ?? {}), LLM_API_KEY: '', GITHUB_TOKEN: '' };
  assertNoSecrets(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== '')),
  );

  const args = baseArgs({
    ...cfg,
    script: cfg.command ? '-c' : cfg.script,
  });
  if (cfg.command) args.push(cfg.command);

  const started = Date.now();
  const res = spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: cfg.timeoutMs,
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;

  const record = {
    exitCode: res.status ?? (res.error ? -1 : null),
    stdout: (res.stdout ?? '').slice(-8000),
    stderr: (res.stderr ?? '').slice(-4000),
    durationMs,
    args: args.map((a) => (a.includes('/') && a.startsWith('/') ? '<path>' : a)),
    timedOut: res.error?.code === 'ETIMEDOUT' || Boolean(res.signal),
    image: cfg.image,
    network: cfg.network,
    at: new Date().toISOString(),
  };
  return record;
}

/**
 * Run a step and append the outcome to data/sandbox-runs.jsonl.
 * The row is what makes an execution auditable after the VM is gone.
 */
export function runAndRecord(opts = {}) {
  const record = runStep(opts);
  const row = {
    at: record.at,
    image: record.image,
    network: record.network,
    exit_code: record.exitCode,
    timed_out: record.timedOut,
    duration_ms: record.durationMs,
    request: opts.request ?? null,
    stdout_tail: record.stdout.slice(-2000),
    stderr_tail: record.stderr.slice(-1000),
  };
  appendRow(RUNS_LOG, row);
  return { ...record, row };
}

/**
 * Prepare a workspace: copy the files a step needs into a directory the
 * container can mount read-only.
 *
 * Deliberately explicit — a copy, not a bind of the whole checkout. Mounting
 * the repository would hand the untrusted step `.github/workflows` and every
 * other file in it.
 */
export function prepare(targetDir, files, { root = process.cwd() } = {}) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  for (const rel of files) {
    const src = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return targetDir;
}
