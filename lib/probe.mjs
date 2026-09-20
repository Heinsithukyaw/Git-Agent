/**
 * Measures what the configured endpoint actually supports, instead of assuming.
 *
 * "OpenAI-compatible" is a claim about request/response shape, not a guarantee
 * about any particular feature. Streaming, JSON mode, tool calling and even
 * `/models` are all optional in practice. Probing once and recording the answer
 * means the pipeline can degrade instead of failing on a 400 at 06:00.
 *
 * Two rules:
 *
 *   - **Only when explicitly invoked.** This is not run as part of the daily
 *     path. Probing an endpoint you do not own is a request you do not need to
 *     make, and it is the kind of thing that grows into fingerprinting. The
 *     daily run uses the recorded result, nothing else.
 *   - **Record the host, never the URL.** A base URL can carry a deployment id
 *     or a path segment that is not meant to be published, and
 *     `data/endpoint.json` is committed to a repository that may be public.
 */

import { config } from './llm.mjs';

const TIMEOUT_MS = 20_000;

async function tryRequest(fn) {
  try {
    const res = await fn();
    return { ok: res.ok, status: res.status, body: await res.text().catch(() => '') };
  } catch (err) {
    return { ok: false, status: null, error: String(err.message ?? err) };
  }
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).host;
  } catch {
    return null;
  }
}

/**
 * Probe the configured endpoint.
 *
 * @returns {Promise<object>} the record to store in data/endpoint.json
 */
export async function probe(env = process.env) {
  const c = config(env);
  if (!c.baseUrl || !c.apiKey || !c.model) {
    return {
      probed_at: new Date().toISOString(),
      configured: false,
      host: null,
      model: c.model || null,
      capabilities: {},
      note: 'no endpoint configured — the rules-only path produces the digest',
    };
  }

  const root = c.baseUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' };
  const capabilities = {};
  const timings = {};

  // 1. The call the pipeline actually depends on.
  const t0 = Date.now();
  const minimal = await tryRequest(() =>
    fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
  timings.chat_ms = Date.now() - t0;
  capabilities.chat_completions = minimal.ok;
  if (!minimal.ok) {
    return {
      probed_at: new Date().toISOString(),
      configured: true,
      host: hostOf(c.baseUrl),
      model: c.model,
      capabilities,
      timings,
      error: minimal.error ?? `HTTP ${minimal.status}: ${minimal.body.slice(0, 300)}`,
    };
  }

  // 2. Optional features. Each is one cheap call, and each failure is recorded
  //    rather than thrown — the point is to know, not to pass.
  const stream = await tryRequest(() =>
    fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: true }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
  capabilities.streaming = stream.ok;

  const jsonMode = await tryRequest(() =>
    fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: c.model,
        messages: [{ role: 'user', content: 'Return {"ok":true}' }],
        max_tokens: 20,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
  capabilities.response_format_json = jsonMode.ok;

  const tools = await tryRequest(() =>
    fetch(`${root}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: c.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        tools: [{ type: 'function', function: { name: 'noop', parameters: { type: 'object', properties: {} } } }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
  capabilities.tools = tools.ok;

  const models = await tryRequest(() =>
    fetch(`${root}/models`, { headers: { authorization: headers.authorization }, signal: AbortSignal.timeout(TIMEOUT_MS) }),
  );
  capabilities.list_models = models.ok;

  return {
    probed_at: new Date().toISOString(),
    configured: true,
    host: hostOf(c.baseUrl),
    model: c.model,
    capabilities,
    timings,
  };
}
