/**
 * Sources. Every one of them is keyless or already authenticated.
 *
 *   npm registry      https://registry.npmjs.org/<name>           keyless
 *   PyPI JSON API     https://pypi.org/pypi/<name>/json           keyless
 *   crates.io         https://crates.io/api/v1/crates/<name>      keyless
 *   Go module proxy   https://proxy.golang.org/<mod>/@v/list      keyless
 *   OSV.dev           https://api.osv.dev/v1/querybatch           keyless
 *   GitHub releases   api.github.com, rides GITHUB_TOKEN          already authenticated
 *   RSS / Atom        whatever the user lists                     keyless, unbounded
 *
 * No source here may require a secret of the user's. A source that needs one
 * needs its own job, because a job may hold a secret or a write token, never
 * both (I1).
 *
 * Every fetch is bounded: a timeout, a size cap, and a bounded retry. A hung
 * upstream must not hold a runner for six hours.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BYTES = 4 * 1024 * 1024;
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export class SourceError extends Error {
  constructor(source, message) {
    super(`[${source}] ${message}`);
    this.name = 'SourceError';
    this.source = source;
  }
}

async function getText(url, { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'git-agent', accept: 'application/json,text/*', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const body = await res.text();
      if (body.length > MAX_BYTES) throw new Error(`response too large (${body.length} bytes)`);
      return body;
    } catch (err) {
      lastErr = err;
      if (err.name === 'TimeoutError') continue;
      if (attempt === retries) break;
    }
  }
  throw lastErr ?? new Error('fetch failed');
}

async function getJson(url, opts = {}) {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response from ${url}`);
  }
}

/* ------------------------------------------------------------------ npm ---- */

export async function npm(name) {
  // The full packument is large; the dist-tags + a trimmed version list is all
  // the agent needs.
  const doc = await getJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
  });
  const versions = Object.keys(doc.versions ?? {});
  return {
    ecosystem: 'npm',
    name,
    latest: doc['dist-tags']?.latest ?? null,
    versions: versions.slice(-40),
  };
}

/* ----------------------------------------------------------------- PyPI ---- */

export async function pypi(name) {
  const doc = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  return {
    ecosystem: 'PyPI',
    name,
    latest: doc.info?.version ?? null,
    versions: Object.keys(doc.releases ?? {}).slice(-40),
  };
}

/* ------------------------------------------------------------- crates.io --- */

export async function crates(name) {
  const doc = await getJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, {
    headers: { 'user-agent': 'git-agent (dependency watcher)' },
  });
  return {
    ecosystem: 'crates.io',
    name,
    latest: doc.crate?.max_stable_version ?? doc.crate?.newest_version ?? null,
    versions: (doc.versions ?? []).map((v) => v.num).slice(-40),
  };
}

/* ------------------------------------------------------- Go module proxy --- */

export async function goModule(mod) {
  // @v/list is newline-separated. It is cached by the proxy, so it is cheap —
  // but treat it as a hint, not as truth: the proxy only knows versions that
  // have been requested before.
  const text = await getText(`https://proxy.golang.org/${mod}/@v/list`);
  const versions = text.split('\n').map((s) => s.trim()).filter(Boolean);
  return { ecosystem: 'Go', name: mod, latest: versions.at(-1) ?? null, versions: versions.slice(-40) };
}

/* ------------------------------------------------------------------ OSV ---- */

/**
 * Batch advisory query. OSV accepts up to 1,000 queries per call, no key, no
 * published rate limit — so one call per run, not one per package.
 */
export async function osv(packages) {
  const queries = packages.map((p) => ({
    package: { name: p.name, ecosystem: p.ecosystem },
    ...(p.pinned ? { version: p.pinned } : {}),
  }));
  if (!queries.length) return { results: [] };

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'git-agent' },
        body: JSON.stringify({ queries }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new SourceError('osv', lastErr?.message ?? 'querybatch failed');
}

/* --------------------------------------------------------------- GitHub ---- */

/** Latest release for a repo. Uses GITHUB_TOKEN, which the job already has. */
export async function githubRelease(slug, { token } = {}) {
  const headers = { accept: 'application/vnd.github+json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const doc = await getJson(`https://api.github.com/repos/${slug}/releases/latest`, { headers });
  return {
    kind: 'release',
    slug,
    tag: doc.tag_name ?? null,
    name: doc.name ?? null,
    published_at: doc.published_at ?? null,
    url: doc.html_url ?? null,
  };
}

/* ------------------------------------------------------------------ RSS ---- */

/** Minimal RSS 2.0 / Atom reader. No XML dependency; good enough for titles. */
export function parseFeed(xml, { limit = 10 } = {}) {
  const items = [];
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)].map((m) => m[0]);
  for (const block of blocks.slice(0, limit)) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!m) return null;
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
        .trim();
    };
    const title = pick('title');
    if (!title) continue;
    items.push({ title, link: pick('link') ?? pick('id'), published: pick('pubDate') ?? pick('updated') });
  }
  return items;
}

export async function feed(url) {
  const xml = await getText(url, { headers: { accept: 'application/rss+xml,application/atom+xml,text/xml' } });
  return { kind: 'feed', url, items: parseFeed(xml) };
}

/* --------------------------------------------------------------- gather ---- */

const ECOSYSTEM_FETCHERS = {
  npm: (p) => npm(p.name),
  PyPI: (p) => pypi(p.name),
  'crates.io': (p) => crates(p.name),
  Go: (p) => goModule(p.name),
};

/**
 * Build the payload. This object is the input to the containment gate, so it is
 * deliberately the *whole* evidence set: anything the digest is allowed to say
 * must be in here.
 *
 * Returns { observed_at, packages, advisories, releases, feeds, errors }.
 * A source failure is recorded in `errors` and downgrades the run — it never
 * aborts it, because a partial digest with a visible gap beats no digest.
 */
export async function gather(stack, { token } = {}) {
  const observed_at = new Date().toISOString();
  const errors = [];

  const packages = [];
  for (const p of stack.packages ?? []) {
    const fetcher = ECOSYSTEM_FETCHERS[p.ecosystem];
    if (!fetcher) {
      errors.push({ source: p.ecosystem, name: p.name, error: 'unsupported ecosystem' });
      continue;
    }
    try {
      packages.push({ ...p, upstream: await fetcher(p), fetched_at: observed_at });
    } catch (err) {
      errors.push({ source: p.ecosystem, name: p.name, error: String(err.message ?? err) });
      packages.push({ ...p, upstream: null, fetched_at: observed_at });
    }
  }

  let advisories = [];
  try {
    const res = await osv(
      (stack.packages ?? []).map((p) => ({ name: p.name, ecosystem: p.ecosystem, pinned: p.pinned })),
    );
    (res.results ?? []).forEach((r, i) => {
      const owner = stack.packages?.[i];
      for (const v of r.vulns ?? []) {
        advisories.push({
          id: v.id,
          aliases: v.aliases ?? [],
          summary: v.summary ?? null,
          details: (v.details ?? '').slice(0, 4000),
          modified: v.modified ?? null,
          published: v.published ?? null,
          severity: v.severity ?? v.database_specific?.severity ?? null,
          affected: (v.affected ?? []).flatMap((a) => (a.ranges ?? []).map((r) => ({
            type: r.type,
            introduced: r.events?.find((e) => e.introduced)?.introduced ?? '0',
            fixed: r.events?.find((e) => e.fixed)?.fixed ?? null,
            last_affected: r.events?.find((e) => e.last_affected)?.last_affected ?? null,
          }))),
          package: owner?.name ?? null,
          ecosystem: owner?.ecosystem ?? null,
        });
      }
    });
  } catch (err) {
    errors.push({ source: 'osv', error: String(err.message ?? err) });
  }

  const releases = [];
  for (const slug of stack.watch?.upstreams ?? []) {
    try {
      releases.push(await githubRelease(slug, { token }));
    } catch (err) {
      errors.push({ source: 'github', name: slug, error: String(err.message ?? err) });
    }
  }

  const feeds = [];
  for (const url of stack.watch?.feeds ?? []) {
    try {
      feeds.push(await feed(url));
    } catch (err) {
      errors.push({ source: 'feed', name: url, error: String(err.message ?? err) });
    }
  }

  return { observed_at, packages, advisories, releases, feeds, errors, watch: stack.watch ?? {} };
}
