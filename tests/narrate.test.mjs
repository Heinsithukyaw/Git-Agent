/**
 * The narrate job.
 *
 * This is the job that holds the model key and writes no commit (I1), and until
 * now **nothing exercised it**: `complete()` and `narrationMessages()` are unit
 * tested, but the step that composes them, records the outcome and decides what
 * the artifact says had no coverage at all. That is the shape of hole that hid
 * the last three defects.
 *
 * The endpoint is a local HTTP server rather than a stub, so the assertions are
 * about the **request that goes on the wire**. That is the only place some of
 * this is observable: a `User-Agent` cannot be inferred from a response, because
 * the response is exactly what the request asked for. `tests/sources.test.mjs`
 * made the same move for the fetchers, after a wrong endpoint survived a suite
 * that only inspected parsed output.
 *
 * One trap worth naming, because it costs an hour: `spawnSync` **blocks this
 * process's event loop**, so the server below could never answer and the child
 * would hang until its own timeout. The child is spawned asynchronously and the
 * test awaits it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.cwd();
const SCRIPT = path.join(REPO, 'scripts/narrate-step.mjs');
const OBSERVED = '2026-09-20T19:29:40.852Z';

/** An OpenAI-compatible reply, in the shape a real endpoint returns. */
const reply = (content, { finishReason = 'stop' } = {}) => ({
  id: 'chatcmpl-test',
  object: 'chat.completion',
  model: 'a-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
  usage: { prompt_tokens: 900, completion_tokens: 400, total_tokens: 1300 },
});

/** A local endpoint that records what it was asked. */
async function endpoint(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      const { status = 200, payload = reply('Nothing needs a decision today.') } = handler(requests.length) ?? {};
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-agent-narrate-'));
  fs.mkdirSync(path.join(dir, '.run'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.run/payload.json'),
    JSON.stringify(
      {
        observed_at: OBSERVED,
        packages: [{ name: 'express', ecosystem: 'npm', pinned: '4.18.2' }],
        advisories: [],
        releases: [],
        feeds: [],
        errors: [],
        watch: { packages: ['express'] },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  return dir;
}

function run(dir, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: dir, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const read = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

test('the request carries the configured client identity, and the artifact records it', async () => {
  const server = await endpoint(() => ({}));
  try {
    const dir = sandbox();
    const result = await run(dir, {
      LLM_BASE_URL: server.baseUrl,
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_MODEL: 'a-model',
      LLM_USER_AGENT: 'some-tool/1.2.3',
    });
    assert.equal(result.status, 0, result.stderr);

    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions', 'the base URL is a root, not the whole path');
    assert.equal(req.headers['user-agent'], 'some-tool/1.2.3', 'the identity the user configured is the one sent');
    assert.equal(req.headers.authorization, 'Bearer sk-test-not-a-real-key');
    assert.equal(req.body.model, 'a-model');
    assert.ok(req.body.messages.length, 'and the facts went with it');

    // The artifact a human reads while debugging. `user_agent` is here and
    // deliberately nowhere that gets committed: a relay that gates on client
    // identity refuses a request *before* reading the credential, so "the key is
    // wrong" and "the identity is no longer accepted" are the same 401, and the
    // identity is the only fact that tells them apart.
    const record = read(dir, '.run/narration.json');
    assert.equal(record.configured, true);
    assert.equal(record.ok, true);
    assert.equal(record.model, 'a-model');
    assert.equal(record.user_agent, 'some-tool/1.2.3');
    assert.equal(record.tokens, 1300);
    assert.ok(fs.existsSync(path.join(dir, '.run/prose.md')));
    assert.ok(fs.existsSync(path.join(dir, '.run/decisions.json')), 'triage ran before the call');
  } finally {
    await server.close();
  }
});

test('an unset identity is not an absent header — the transport supplies its own', async () => {
  // Measured, not assumed, and it changes the advice. Node's `fetch` sends
  // `user-agent: node` when nothing sets one, so an endpoint that whitelists
  // client identities sees an *unrecognised* identity rather than none. For such
  // a relay the knob is not garnish; it is the difference between being
  // recognised and being refused before the credential is even read.
  const server = await endpoint(() => ({}));
  try {
    const dir = sandbox();
    const result = await run(dir, {
      LLM_BASE_URL: server.baseUrl,
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_MODEL: 'a-model',
      LLM_USER_AGENT: '',
    });
    assert.equal(result.status, 0, result.stderr);

    const sent = server.requests[0].headers['user-agent'];
    assert.notEqual(sent, 'some-tool/1.2.3');
    assert.equal(sent, 'node', 'the transport defaults it, so "unset" is still an identity on the wire');
    assert.equal(read(dir, '.run/narration.json').user_agent, null, 'and the artifact says we configured none');
  } finally {
    await server.close();
  }
});

test('an empty answer is recorded as a failure, and no prose is written', async () => {
  // The live defect this closes: a 200 whose content was empty was recorded as
  // `ok: true`, so a configured-and-broken narration was byte-identical to a
  // deliberately keyless instance. Asserted here through the step, not only
  // through `complete()`.
  const server = await endpoint(() => ({ payload: reply('', { finishReason: 'length' }) }));
  try {
    const dir = sandbox();
    const result = await run(dir, {
      LLM_BASE_URL: server.baseUrl,
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_MODEL: 'a-model',
    });
    assert.equal(result.status, 0, 'a narration failure must not fail the run');
    assert.match(result.stderr, /::warning::narration failed/);

    const record = read(dir, '.run/narration.json');
    assert.equal(record.configured, true);
    assert.equal(record.ok, false);
    assert.equal(record.kind, 'truncated', 'the ceiling was the cause, and the record says so');
    assert.equal(record.user_agent, null);
    assert.equal(fs.existsSync(path.join(dir, '.run/prose.md')), false, 'no prose artifact for a failed narration');
  } finally {
    await server.close();
  }
});

test('a refused call records the status and the identity, never the response body', async () => {
  const server = await endpoint(() => ({
    status: 401,
    payload: { error: { message: 'unauthorized client detected, contact support at https://example.invalid/secret' } },
  }));
  try {
    const dir = sandbox();
    const result = await run(dir, {
      LLM_BASE_URL: server.baseUrl,
      LLM_API_KEY: 'sk-test-not-a-real-key',
      LLM_MODEL: 'a-model',
      LLM_USER_AGENT: 'some-tool/1.2.3',
    });
    assert.equal(result.status, 0);

    const record = read(dir, '.run/narration.json');
    assert.equal(record.ok, false);
    assert.equal(record.kind, 'http');
    assert.equal(record.status, 401, 'the status is the diagnosis');
    assert.equal(record.user_agent, 'some-tool/1.2.3', 'and the identity is what separates the two causes');

    // The body is not ours, and both surfaces are public: the artifact travels as
    // a workflow artifact, and the log is readable on a public repository. Neither
    // carries it — the reduction is a status and a coarse kind, applied to the
    // record and to the warning line alike.
    assert.doesNotMatch(JSON.stringify(record), /unauthorized client detected/);
    assert.doesNotMatch(JSON.stringify(record), /example\.invalid/);
    assert.match(result.stderr, /narration failed \(HTTP 401\)/, 'the log says what happened');
    assert.doesNotMatch(result.stderr, /unauthorized client detected/, 'and not what the endpoint said');
    assert.doesNotMatch(result.stderr, /example\.invalid/);
  } finally {
    await server.close();
  }
});

test('a crash is recorded, not swallowed — the artifact is the only signal', () => {
  // `needs.narrate.result` is `success` under `continue-on-error: true`, so a
  // step that throws cannot be seen from the job graph. What can be seen is this
  // record, and it has to survive the throw: without it, a broken narrate job
  // would reach `commit-step` as "no record", which is the state a deliberately
  // keyless instance produces.
  const dir = sandbox();
  fs.writeFileSync(path.join(dir, '.run/payload.json'), '{ not json at all', 'utf8');

  return run(dir, {}).then((result) => {
    assert.equal(result.status, 1, 'the step fails loudly');
    const record = read(dir, '.run/narration.json');
    assert.equal(record.ok, false);
    assert.equal(record.kind, 'crashed');
    assert.equal(record.detail, 'SyntaxError', 'the error kind, never its message');
    assert.doesNotMatch(result.stderr, /not json at all/, 'and the log does not quote the input either');
  });
});

test('the record is written before anything that can throw', () => {
  // A structural assertion, and it is structural because it has to be. The case
  // it covers — the process being killed between the decision write and the
  // narration record — is one no local run can reach. What *is* observable is the
  // ordering in the source, and the ordering is the guarantee: `narration.json`
  // exists whenever this step ran at all, which is what lets `commit-step` read
  // its absence as "the step did not run" instead of as "no model configured".
  // Without it, "absent" would be ambiguous, and `narrationGap()` would resolve
  // that ambiguity in the direction I11 exists to prevent.
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const provisional = source.indexOf("recordNarration({ configured: null, ok: false, kind: 'started' })");
  const firstThrow = source.indexOf('= readPayload()');
  assert.ok(provisional > 0, 'the provisional record is present');
  assert.ok(firstThrow > 0, 'and the first thing that can throw is where we think it is');
  assert.ok(provisional < firstThrow, 'written before it, which is the whole of its value');
});
