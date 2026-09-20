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
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${c.apiKey}`,
        },
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
