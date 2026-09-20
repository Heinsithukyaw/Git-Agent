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
 *   - **Record what the endpoint does, never which endpoint it is.** The record
 *     reaches the world twice: `data/endpoint.json` is committed, and
 *     `.run/endpoint.json` travels as a workflow artifact, which is readable on
 *     a public repository. So it carries capabilities and timings and names
 *     neither the host nor the model — the endpoint is the user's own business
 *     (I8), and `lib/pubsafe.mjs` → `checkNoEndpointDisclosure()` re-checks the
 *     committed file to keep it that way.
 *
 * **What that costs, stated rather than discovered later.** A capability record
 * is only meaningful for the endpoint it was measured against, so a record that
 * cannot name its endpoint cannot be *validated*: nothing in it distinguishes a
 * stale record from a current one. `ARCHITECTURE-REVIEW.md` P1-6 proposes keying
 * the file by `(base_url, model)` — which is exactly the pair this rule forbids
 * publishing, so the two positions are not reconcilable and this one wins. A
 * private endpoint on a public repository is a one-way door; a stale capability
 * record is not. The invalidation rule is therefore the honest one: `probed_at`
 * is the only signal, and the record is re-probed when the operator changes the
 * configuration.
 *
 * **The response body is never recorded.** A probe failure is reduced to a kind
 * and a status, the same reduction `classifyFailure()` applies to a narration
 * failure, for the same reason: the body is the endpoint's text, not ours, and
 * this record is published.
 */

import { config } from './llm.mjs';

const TIMEOUT_MS = 20_000;

/**
 * The only fields `data/endpoint.json` may carry.
 *
 * An allowlist rather than a denylist, so a field added to the record later is
 * not published until it is named here. `checkNoEndpointDisclosure()` is the
 * second line — it re-checks the committed file, and a one-way door wants both.
 */
export const PUBLISHABLE_ENDPOINT_FIELDS = [
  'probed_at',
  'configured',
  'capabilities',
  'timings',
  'error',
  'note',
];

/** Reduce a probe record to the fields that may be committed. */
export function probeRecordForCommit(record) {
  const out = {};
  for (const field of PUBLISHABLE_ENDPOINT_FIELDS) {
    if (record?.[field] !== undefined) out[field] = record[field];
  }
  return out;
}

async function tryRequest(fn) {
  try {
    const res = await fn();
    return { ok: res.ok, status: res.status, body: await res.text().catch(() => '') };
  } catch (err) {
    return { ok: false, status: null, error: String(err.message ?? err) };
  }
}

/**
 * A failed probe, reduced to what may be published.
 *
 * The status is the diagnosis and the body is not ours to keep — the same
 * argument `classifyFailure()` makes for a narration failure.
 */
function classifyProbeFailure(result) {
  if (result.status) return { kind: 'http', status: result.status };
  return { kind: 'network', status: null };
}

/**
 * Probe the configured endpoint.
 *
 * @returns {Promise<object>} the record to store in `.run/endpoint.json`
 */
export async function probe(env = process.env) {
  const c = config(env);
  if (!c.baseUrl || !c.apiKey || !c.model) {
    return {
      probed_at: new Date().toISOString(),
      configured: false,
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
      capabilities,
      timings,
      error: classifyProbeFailure(minimal),
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
    capabilities,
    timings,
  };
}
