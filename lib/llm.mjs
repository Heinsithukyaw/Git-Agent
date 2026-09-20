/**
 * Provider-neutral model client: base URL in, prose out.
 *
 * Three properties matter more than the HTTP call:
 *
 *   - **No opinion about the provider.** No default endpoint, no fallback, no
 *     vendor name anywhere in this file. If no base URL is configured, this
 *     module refuses and the rules-only path produces the digest instead.
 *   - **No opinion about price.** It measures tokens, which are
 *     provider-independent, and enforces a budget. The user supplies the rate.
 *   - **Never logs the credential.** Errors carry status codes and bodies with
 *     the authorization header absent, because a workflow log is public on a
 *     public repository.
 *
 * A model call is only ever made from a job that holds no write token (I1), and
 * its output is only ever committed after the containment gate has run in a job
 * that holds no model key (I2).
 *
 * `LLM_USER_AGENT` exists because a credential is not always the thing a gateway
 * checks. Some relays sit behind a whitelist of known client identities and
 * answer a request from an unrecognised one with `401 unauthorized client
 * detected` — *before* the key is examined, so a perfectly valid key is refused
 * and the error names the client, not the credential. Without this knob such a
 * provider is simply unusable, and no amount of rotating the key changes it.
 * The header is sent only when the variable is set, so the request stays
 * byte-identical for every endpoint that does not care.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TOKENS_DEFAULT = 1200;
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class NotConfiguredError extends Error {
  constructor() {
    super(
      'no model endpoint configured. Set the LLM_BASE_URL repository variable, or ' +
        'leave it unset and run the rules-only path — the digest is complete either way.',
    );
    this.name = 'NotConfiguredError';
  }
}

export class BudgetExceededError extends Error {
  constructor(used, budget) {
    super(`token budget exceeded: ${used} > ${budget}`);
    this.name = 'BudgetExceededError';
  }
}

/** Read configuration from the environment. No defaults for host or model. */
export function config(env = process.env) {
  return {
    baseUrl: (env.LLM_BASE_URL ?? '').trim(),
    apiKey: (env.LLM_API_KEY ?? '').trim(),
    model: (env.LLM_MODEL ?? '').trim(),
    userAgent: (env.LLM_USER_AGENT ?? '').trim(),
    language: (env.AGENT_LANG ?? 'en').trim(),
    budget: Number(env.LLM_TOKEN_BUDGET ?? 60_000),
  };
}

export function isConfigured(env = process.env) {
  const c = config(env);
  return Boolean(c.baseUrl && c.apiKey && c.model);
}

function endpoint(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * The request headers, as a pure function so a test can assert the request
 * rather than infer it from a response. A wrong or missing header cannot be
 * caught from the reply, because the reply is exactly what the wrong request
 * asked for.
 *
 * `user-agent` appears only when configured. An endpoint that does not care
 * never sees the header, so adding the knob changed nothing for them.
 */
export function requestHeaders(c) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${c.apiKey}`,
  };
  if (c.userAgent) headers['user-agent'] = c.userAgent;
  return headers;
}

/**
 * One completion.
 *
 * @param {object} args
 * @param {Array<{role:string,content:string}>} args.messages
 * @param {object} [args.env]
 * @param {number} [args.maxTokens]
 * @param {number} [args.temperature]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{text:string, usage:object|null, model:string|null}>}
 */
export async function complete({
  messages,
  env = process.env,
  maxTokens = MAX_TOKENS_DEFAULT,
  temperature = 0.2,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = 2,
  signal,
}) {
  const c = config(env);
  if (!c.baseUrl || !c.apiKey || !c.model) throw new NotConfiguredError();

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(endpoint(c.baseUrl), {
        method: 'POST',
        headers: requestHeaders(c),
        body: JSON.stringify({
          model: c.model,
          messages,
          max_tokens: maxTokens,
          temperature,
          stream: false,
        }),
        signal: signal ?? AbortSignal.timeout(timeoutMs),
      });

      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 400);
        throw new Error(`model endpoint returned HTTP ${res.status}: ${body}`);
      }

      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content ?? '';
      const usage = json?.usage ?? null;
      if (usage?.total_tokens && usage.total_tokens > c.budget) {
        throw new BudgetExceededError(usage.total_tokens, c.budget);
      }
      return {
        text: typeof text === 'string' ? text : JSON.stringify(text),
        usage,
        model: json?.model ?? c.model,
        status: res.status,
      };
    } catch (err) {
      lastErr = err;
      if (err instanceof BudgetExceededError) throw err;
      if (err.name === 'TimeoutError') {
        lastErr = new Error(`model endpoint timed out after ${timeoutMs}ms`);
      }
    }
  }
  throw lastErr ?? new Error('model call failed');
}

/**
 * The narration prompt.
 *
 * The instruction is deliberately narrow: paraphrase the supplied facts, never
 * introduce them. The gate catches a violation; the prompt is what makes a
 * violation rare. Both are needed — the prompt is not a control.
 */
export function narrationMessages({ facts, language = 'en', maxEntities = 40 }) {
  const lines = facts.map((f, i) => `${i + 1}. ${f}`).slice(0, maxEntities).join('\n');
  return [
    {
      role: 'system',
      content:
        `You are writing a dependency digest for a software engineer.\n` +
        `Rules, in order of importance:\n` +
        `1. Use ONLY the facts listed below. Do not add an advisory id, a package name, ` +
        `a version number, or a quantity that is not in the list.\n` +
        `2. If a fact is missing, say it is unknown. Never fill a gap.\n` +
        `3. Be concrete and short. No preamble, no sign-off, no hedging.\n` +
        `4. Write in ${language}. Keep advisory ids, package names and version ` +
        `strings exactly as written — do not translate them.\n` +
        `5. Do not invent urgency. Order by what the facts say, not by tone.`,
    },
    {
      role: 'user',
      content: `Facts (observed ${new Date().toISOString()}):\n${lines}\n\nWrite the digest.`,
    },
  ];
}

/** Strip a markdown code fence if the model wrapped its answer in one. */
export function unfence(text) {
  const m = text.match(/^\s*```(?:[a-z]*)\n([\s\S]*?)\n```\s*$/i);
  return m ? m[1] : text;
}

/**
 * Reduce a failed call to something safe to publish.
 *
 * The message thrown above embeds the endpoint's response body, and that body is
 * not ours: a real 401 from a gateway read
 * `unauthorized client detected, contact support … at https://discord.gg/…`.
 * That is fine in a workflow log, which a human reads while debugging, and it is
 * not fine in `digest/`, which is committed to a repository that may be public.
 *
 * So only two things travel with the failure: the HTTP status, which is the
 * diagnosis, and a coarse kind. The body stays behind. Nothing here can carry a
 * credential, because nothing here is copied from the message except a status
 * code and a fixed vocabulary.
 *
 * @returns {{kind: 'budget'|'http'|'timeout'|'network', status: number|null}}
 */
export function classifyFailure(err) {
  if (err?.name === 'BudgetExceededError') return { kind: 'budget', status: null };
  const message = String(err?.message ?? err);
  const http = message.match(/\bHTTP (\d{3})\b/);
  if (http) return { kind: 'http', status: Number(http[1]) };
  if (/timed out/i.test(message)) return { kind: 'timeout', status: null };
  return { kind: 'network', status: null };
}
