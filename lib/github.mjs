/**
 * The small amount of GitHub API this agent needs.
 *
 * Everything here uses the job's own token, whose scope is exactly the job's
 * `permissions`. That is why a job may hold `issues: write` and no secret (I1):
 * the token is not a credential the user configured, it is the job's identity.
 *
 * No credential is ever read from the environment by name here. Callers pass it.
 */

const API_ROOT = 'https://api.github.com';

export function repoFromEnv(env = process.env) {
  const full = env.GITHUB_REPOSITORY ?? '';
  const [owner, repo] = full.split('/');
  if (!owner || !repo) throw new Error('GITHUB_REPOSITORY is not set');
  return { owner, repo };
}

async function request(pathname, { token, method = 'GET', body = null } = {}) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'git-agent',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${API_ROOT}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API ${method} ${pathname} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Leave a comment. This is the whole reply mechanism — no server involved. */
export function postComment(issueNumber, body, { token, repo } = {}) {
  const { owner, repo: r } = repo ?? repoFromEnv(process.env);
  return request(`/repos/${owner}/${r}/issues/${issueNumber}/comments`, {
    token,
    method: 'POST',
    body: { body },
  });
}

export function listComments(issueNumber, { token, repo } = {}) {
  const { owner, repo: r } = repo ?? repoFromEnv(process.env);
  return request(`/repos/${owner}/${r}/issues/${issueNumber}/comments?per_page=100`, { token });
}

export function createPullRequest({ title, head, base, body }, { token, repo } = {}) {
  const { owner, repo: r } = repo ?? repoFromEnv(process.env);
  return request(`/repos/${owner}/${r}/pulls`, {
    token,
    method: 'POST',
    body: { title, head, base, body, maintainer_can_modify: true },
  });
}

export function getDefaultBranch({ token, repo } = {}) {
  const { owner, repo: r } = repo ?? repoFromEnv(process.env);
  return request(`/repos/${owner}/${r}`, { token }).then((d) => d.default_branch ?? 'main');
}

/** Set a step output. Silently does nothing outside Actions. */
export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${name}=${String(value ?? '')}\n`, 'utf8');
}
