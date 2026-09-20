/**
 * The model client.
 *
 * This file exists because `lib/llm.mjs` had none. It was imported only by
 * `scripts/narrate-step.mjs` and `scripts/explain-step.mjs`, and the only test
 * that touched it scanned its *text* for vendor names and the config surface —
 * so `complete()`, `isConfigured()`, `narrationMessages()`, `unfence()` and
 * `classifyFailure()` were exercised by nothing at all.
 *
 * Three properties matter, and two of them are promises the file's own header
 * makes: no provider default, no credential in a log, and a failure reduced to
 * something safe to publish.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NotConfiguredError,
  BudgetExceededError,
  config,
  isConfigured,
  complete,
  narrationMessages,
  unfence,
  classifyFailure,
} from '../lib/llm.mjs';

const ENV = {
  LLM_BASE_URL: 'https://endpoint.invalid/v1',
  LLM_API_KEY: 'sk-test-not-a-real-key',
  LLM_MODEL: 'a-model',
};

/** Capture the request `complete()` sends, and answer with `respond`. */
async function capture(respond, { env = ENV, ...opts } = {}) {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return respond(seen.length);
  };
  try {
    const result = await complete({ messages: [{ role: 'user', content: 'hi' }], env, retries: 0, ...opts });
    return { seen, result };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) });

/* --------------------------------------------------------- configuration --- */

test('there is no default endpoint, no default model, and no fallback', () => {
  // I8: the client must not have an opinion about which endpoint you use, which
  // it can only guarantee by having no answer for an unconfigured one.
  assert.equal(config({}).baseUrl, '');
  assert.equal(config({}).model, '');
  assert.equal(config({ LLM_BASE_URL: 'https://x/v1' }).apiKey, '');
  assert.equal(isConfigured({}), false);
  assert.equal(isConfigured({ LLM_BASE_URL: 'https://x/v1' }), false, 'a URL alone is not configured');
  assert.equal(isConfigured({ LLM_BASE_URL: 'https://x/v1', LLM_API_KEY: 'k' }), false, 'nor a URL and a key');
  assert.equal(isConfigured(ENV), true);
});

test('an unconfigured client refuses rather than guessing an endpoint', async () => {
  await assert.rejects(complete({ messages: [], env: {} }), NotConfiguredError);
});

test('the language and the token budget are read, with defaults', () => {
  assert.equal(config({}).language, 'en');
  assert.equal(config({ AGENT_LANG: 'my' }).language, 'my');
  assert.equal(config({}).budget, 60_000);
  assert.equal(config({ LLM_TOKEN_BUDGET: '10' }).budget, 10);
});

/* ------------------------------------------------------------- the call --- */

test('the request is the one an OpenAI-compatible endpoint documents', async () => {
  // The shape is asserted, not assumed. A stubbed *response* cannot catch a
  // wrong *request* — the stub is wrong in the same direction as the code.
  const { seen } = await capture(() => ok({ choices: [{ message: { content: 'hi' } }] }));
  assert.equal(seen[0].url, 'https://endpoint.invalid/v1/chat/completions');
  assert.deepEqual(Object.keys(seen[0].body).sort(), ['max_tokens', 'messages', 'model', 'stream', 'temperature']);
  assert.equal(seen[0].body.model, 'a-model');
  assert.equal(seen[0].body.stream, false, 'the pipeline reads one response, not a stream');
  assert.equal(seen[0].body.max_tokens, 1200);
  assert.equal(seen[0].init.headers.authorization, `Bearer ${ENV.LLM_API_KEY}`);
});

test('a trailing slash on the base URL does not produce a doubled path', async () => {
  const { seen } = await capture(() => ok({ choices: [{ message: { content: 'hi' } }] }), {
    env: { ...ENV, LLM_BASE_URL: 'https://endpoint.invalid/v1///' },
  });
  assert.equal(seen[0].url, 'https://endpoint.invalid/v1/chat/completions');
});

test('the text, the usage, the resolved model and the status are returned', async () => {
  const { result } = await capture(() =>
    ok({ choices: [{ message: { content: 'the digest' } }], usage: { total_tokens: 42 }, model: 'a-model-2026-09-01' }),
  );
  assert.equal(result.text, 'the digest');
  assert.equal(result.usage.total_tokens, 42);
  assert.equal(result.model, 'a-model-2026-09-01', 'the resolved model is what the endpoint reports');
  assert.equal(result.status, 200);
});

test('an over-budget call is refused, and is not retried', async () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return ok({ choices: [{ message: { content: 'x' } }], usage: { total_tokens: 5_000 } });
  };
  try {
    await assert.rejects(
      complete({ messages: [], env: { ...ENV, LLM_TOKEN_BUDGET: '100' }, retries: 2 }),
      BudgetExceededError,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls, 1, 'a budget overrun is not transient');
});

/* ------------------------------------------------------------- the log --- */

test('a failed call never carries the credential into its message', async () => {
  // The header promise: "Never logs the credential." A workflow log on a public
  // repository is the reason this matters, and nothing tested it.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => '{"error":{"message":"unauthorized client detected"}}',
  });
  try {
    await assert.rejects(
      complete({ messages: [], env: ENV, retries: 0 }),
      (err) => {
        assert.doesNotMatch(err.message, /sk-test-not-a-real-key/, 'the key must not appear');
        assert.match(err.message, /HTTP 401/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* --------------------------------------------------- failure classification --- */

test('a failure is reduced to a status and a kind, so it is safe to publish', () => {
  // A real 401 from a live gateway read: "unauthorized client detected, contact
  // support for assistance at https://discord.gg/…". Fine in a workflow log.
  // Not fine in digest/, which is committed.
  const real = new Error(
    'model endpoint returned HTTP 401: {"error":{"message":"unauthorized client detected, contact support for assistance at https://discord.gg/HgekCyHJqB"}}',
  );
  assert.deepEqual(classifyFailure(real), { kind: 'http', status: 401 });

  assert.deepEqual(classifyFailure(new Error('model endpoint timed out after 60000ms')), {
    kind: 'timeout',
    status: null,
  });
  assert.deepEqual(classifyFailure(new BudgetExceededError(70_000, 60_000)), { kind: 'budget', status: null });
  assert.deepEqual(classifyFailure(new Error('fetch failed')), { kind: 'network', status: null });
  // Nothing copied from the message except a three-digit status.
  assert.equal(JSON.stringify(classifyFailure(real)).includes('discord'), false);
});

/* ---------------------------------------------------------------- prompt --- */

test('the narration prompt numbers the facts and caps how many it sends', () => {
  const facts = Array.from({ length: 50 }, (_, i) => `fact ${i}`);
  const [system, user] = narrationMessages({ facts, maxEntities: 3 });
  assert.match(user.content, /1\. fact 0\n2\. fact 1\n3\. fact 2/);
  assert.doesNotMatch(user.content, /fact 3/, 'the cap is real, so the context cannot grow without bound');
  assert.match(system.content, /Use ONLY the facts listed below/);
});

test('the prompt states the language without translating the identifiers', () => {
  const [system] = narrationMessages({ facts: ['x'], language: 'my' });
  assert.match(system.content, /Write in my\./);
  assert.match(system.content, /do not translate them/);
});

test('a fenced answer is unwrapped, and an unfenced one is left alone', () => {
  assert.equal(unfence('```markdown\n# hi\n```'), '# hi');
  assert.equal(unfence('```\n# hi\n```'), '# hi');
  assert.equal(unfence('# hi'), '# hi');
  // A fence in the middle is content, not a wrapper.
  assert.equal(unfence('text\n```\ncode\n```'), 'text\n```\ncode\n```');
});
