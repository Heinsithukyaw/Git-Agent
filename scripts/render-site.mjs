#!/usr/bin/env node
/**
 * Job: render-site — publish the two static surfaces.
 *
 * The page is a *view*, not a client. It holds no credential, calls no model,
 * and cannot trigger a workflow: it is built here, at render time, from files
 * that already exist in the repository. Whatever the digest said is what the
 * page shows — there is no second path by which content can reach it.
 *
 * Two structural choices worth stating:
 *
 *   - **Generated content lives in `site/api/*.json`, not inside the HTML.**
 *     Advisory summaries and feed titles are upstream text; keeping them out of
 *     the page source means a scanner over `site/*.html` stays meaningful, and
 *     the page itself is stable between runs.
 *
 *     The directory is `api/` and not `data/` because of I16. The private
 *     collector root is `data/`, and a literal that *resolves into a collector
 *     root* is what I16 treats as a read target. A page writing `site/data/…`
 *     therefore puts a `data/` literal in this file that resolves into a private
 *     root — indistinguishable, to a resolution test, from reading the watch
 *     list. The alternative was an exception list, and excepting `data` would
 *     have let `fs.readdirSync('data')` pass: an exception meant to remove a
 *     false positive would have opened the leak the check exists to close. The
 *     rename costs one directory name and needs no exception.
 *   - **`chat.html` composes, it does not call.** It builds a prefilled issue
 *     URL; the user's own GitHub session submits it. No token is ever in the
 *     browser, and no endpoint is contacted.
 *   - **It reads only the projected artifacts.** `data/public-summary.json` and
 *     `digest/public-*.md` are written by the commit job, the only component
 *     that holds the payload. This step never sees a payload, so it *cannot*
 *     project — `pages.yml` checks out committed files and downloads no
 *     artifact. It must not try: `data/summary.json` is the private summary and
 *     `history/commands.jsonl` carries the author login, and reading either here
 *     would put the private document on a world-readable page. The narrowing is
 *     asserted, not promised — see I16.
 */

import fs from 'node:fs';
import path from 'node:path';
import { markdownToHtml } from '../lib/render.mjs';
import { writeIfChanged, CI_ALLOWLIST } from '../lib/store.mjs';
import { PUBLIC_DIGEST_PREFIX, PUBLIC_SUMMARY } from '../lib/public-surface.mjs';

const SITE = 'site';
const SITE_DATA = path.join(SITE, 'api');

/**
 * The projected summary, and nothing else.
 *
 * This was `readJson(rel, fallback)` — a general reader taking a path. It is
 * specialised deliberately, and the reason is I16 rather than taste: a helper
 * whose argument is a path has a *variable* root inside it, so a check over read
 * targets can see the call but not what it reads, and the only way to keep the
 * helper would be to exempt it. Exempting the helper exempts every call through
 * it, which is the same as exempting the file. A single-purpose reader has a
 * literal root — the declared constant — and is checkable.
 *
 * There is nothing to generalise away either: this step reads exactly one JSON
 * file, and the absence of a fallback argument is the point rather than a loss.
 */
function readPublicSummary() {
  try {
    return JSON.parse(fs.readFileSync(PUBLIC_SUMMARY, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The most recent **public** digest, by filename.
 *
 * Narrowed to `public-` explicitly rather than by taking the last `.md`. The
 * private and public digests are written on the same date into the same
 * directory, so "the last file" picked the public one only because `'p' > '2'` —
 * a property of the filename sort, not a decision anyone made. I16 asserts the
 * narrowing survives.
 */
function latestDigest() {
  if (!fs.existsSync('digest')) return null;
  const files = fs
    .readdirSync('digest')
    .filter((f) => f.startsWith(PUBLIC_DIGEST_PREFIX) && f.endsWith('.md'))
    .sort();
  if (!files.length) return null;
  const name = files[files.length - 1];
  const date = name.slice(PUBLIC_DIGEST_PREFIX.length).replace(/\.md$/, '');
  return { name, date, markdown: fs.readFileSync(path.join('digest', name), 'utf8') };
}

function repoSlug() {
  const fromEnv = (process.env.GITHUB_REPOSITORY ?? '').trim();
  if (fromEnv && fromEnv.includes('/')) return fromEnv;
  return null;
}

/* ------------------------------------------------------------------ HTML --- */

function page({ title, body, active }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root {
    --bg: #ffffff; --fg: #14181f; --muted: #5b6675; --line: #e3e7ec;
    --card: #f7f9fb; --accent: #0b62d6; --warn-bg: #fff8e1; --warn-line: #e6c15a;
    --ok: #1a7f37; --bad: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117; --fg: #e6edf3; --muted: #9aa7b4; --line: #232a33;
      --card: #131a22; --accent: #58a6ff; --warn-bg: #2a2413; --warn-line: #7a6420;
      --ok: #3fb950; --bad: #f85149;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 16px calc(24px + env(safe-area-inset-bottom));
    background: var(--bg); color: var(--fg);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .wrap { max-width: 860px; margin: 0 auto; }
  header { padding: 20px 0 8px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0; }
  nav { display: flex; gap: 14px; padding: 10px 0 0; font-size: 14px; }
  nav a { color: var(--accent); text-decoration: none; }
  nav a[aria-current="page"] { color: var(--fg); font-weight: 600; }
  .stats { display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 0 0; }
  .stat {
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 12px; min-width: 92px;
  }
  .stat b { display: block; font-size: 20px; line-height: 1.2; }
  .stat span { color: var(--muted); font-size: 12px; }
  .live { font-size: 13px; color: var(--muted); padding: 10px 0 0; }
  .live b { color: var(--ok); }
  .live b.bad { color: var(--bad); }
  main { padding: 16px 0; }
  main h2 { font-size: 17px; margin: 22px 0 8px; }
  main h3 { font-size: 15px; margin: 18px 0 6px; }
  main table { width: 100%; border-collapse: collapse; font-size: 14px; margin: 8px 0; }
  main th, main td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  main th { color: var(--muted); font-weight: 600; }
  main code { background: var(--card); padding: 1px 4px; border-radius: 4px; font-size: 13px; }
  main blockquote {
    margin: 8px 0; padding: 8px 12px; border-left: 3px solid var(--warn-line);
    background: var(--warn-bg); color: var(--fg);
  }
  footer { border-top: 1px solid var(--line); padding-top: 12px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>${title}</h1>
  <p class="sub">A git-native agent: the repository is the state, and every turn is a fresh job.</p>
  <nav>
    <a href="./index.html"${active === 'index' ? ' aria-current="page"' : ''}>Digest</a>
    <a href="./chat.html"${active === 'chat' ? ' aria-current="page"' : ''}>Ask</a>
  </nav>
</header>
${body}
<footer>
  Generated from the repository by a scheduled job. Nothing on this page is generated in a browser:
  there is no key here, and no model is called.
</footer>
</div>
</body>
</html>
`;
}

function indexBody(summary, heartbeat) {
  const s = summary ?? {};
  const stat = (value, label) =>
    `<div class="stat"><b>${Number.isFinite(value) ? value : '—'}</b><span>${label}</span></div>`;

  const status = heartbeat?.last_status ?? null;
  const live = heartbeat?.last_run_at
    ? `<p class="live">Last run <b class="${status && status !== 'ok' ? 'bad' : ''}">${status ?? 'unknown'}</b> at ${heartbeat.last_run_at}${heartbeat.consecutive_failures ? ` · ${heartbeat.consecutive_failures} consecutive failure(s)` : ''}</p>`
    : '<p class="live">No run recorded yet.</p>';

  return `
<div class="stats">
  ${stat(s.actionable, 'to act on')}
  ${stat(s.uncertain, 'needing your call')}
  ${stat(s.clear, 'clear')}
  ${stat(s.advisories, 'advisories')}
  ${stat(s.packages, 'packages watched')}
  ${stat(s.sources_failed, 'sources failed')}
</div>
${live}
<main id="digest" aria-live="polite">
  <p><em>Loading the latest digest…</em></p>
  <noscript>
    <p>This page renders the digest with JavaScript. The same content is committed as Markdown
    under <code>digest/</code> in the repository.</p>
  </noscript>
</main>
<script>
  // Reads files this job wrote into site/api/. Nothing else is contacted.
  (async () => {
    const main = document.getElementById('digest');
    try {
      const res = await fetch('./api/digest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const doc = await res.json();
      main.innerHTML = doc.html || '<p>No digest has been published yet.</p>';
    } catch (err) {
      main.innerHTML = '<p>The digest could not be loaded. It is committed as Markdown under <code>digest/</code>.</p>';
    }
  })();
</script>
`;
}

function chatBody(slug) {
  const repo = slug ?? 'OWNER/REPO';
  const setup = slug
    ? ''
    : `<blockquote><strong>Set the repository first.</strong> This page was rendered without
       <code>GITHUB_REPOSITORY</code>, so the composer is pointing at a placeholder. Re-run the
       render step inside the job and it will use the real slug.</blockquote>`;

  const verbs = [
    ['why', 'why &lt;pkg&gt;', 'Look up the stored decision. No model.'],
    ['what-changed', 'what-changed', 'Everything that moved since the last run. No model.'],
    ['bump', 'bump &lt;pkg&gt;', 'Open a pull request; optionally run the suite in the sandbox.'],
    ['verify', 'verify &lt;pr&gt;', 'Run the suite against a patch in the sandbox.'],
    ['wrong', 'wrong &lt;pkg&gt;', 'Record that the decision was wrong. This is the calibration signal.'],
    ['pause', 'pause', 'Skip the schedule until resumed.'],
    ['resume', 'resume', 'Resume the schedule.'],
    ['explain', 'explain &lt;GHSA-…&gt;', 'The only verb that calls a model. Answer is marked unverified.'],
  ];

  const options = verbs
    .map(([v, usage, help]) => `<option value="${v}">${usage} — ${help}</option>`)
    .join('\n        ');

  return `
${setup}
<p>This page composes a command and hands it to GitHub. It does not run anything, hold a
credential, or call a model: you press the button, you are already signed in, and the reply
lands as a comment in the thread.</p>
<form id="composer">
  <p>
    <label for="verb">Command</label><br>
    <select id="verb" name="verb" style="width:100%;max-width:520px;padding:10px;font-size:16px;">
        ${options}
    </select>
  </p>
  <p>
    <label for="arg">Argument</label><br>
    <input id="arg" name="arg" type="text" placeholder="lodash" autocomplete="off"
           style="width:100%;max-width:520px;padding:10px;font-size:16px;">
  </p>
  <p id="preview" style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);
     border:1px solid var(--line);border-radius:6px;padding:10px;max-width:520px;">/agent why</p>
  <p>
    <button type="submit" style="padding:10px 16px;font-size:16px;">Open as a GitHub issue</button>
  </p>
</form>
<p style="color:var(--muted);font-size:13px;">
  The reply is asynchronous — a job has to start, and that takes a minute, not a second.
  That is the price of there being no server.
</p>
<script>
  const REPO = ${JSON.stringify(repo)};
  const verb = document.getElementById('verb');
  const arg = document.getElementById('arg');
  const preview = document.getElementById('preview');

  function command() {
    const a = arg.value.trim();
    return a ? '/agent ' + verb.value + ' ' + a : '/agent ' + verb.value;
  }
  function render() { preview.textContent = command(); }

  verb.addEventListener('change', render);
  arg.addEventListener('input', render);
  render();

  document.getElementById('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    // The title carries the command as well as the body, because the workflow
    // guard reads the title prefix and the parser reads the body. Both are
    // needed, and neither is trusted: the author gate and the grammar run
    // server-side regardless of what this page sends.
    const body = command() + '\\n\\n<!-- submitted from the composer -->';
    const url = 'https://github.com/' + REPO + '/issues/new'
      + '?title=' + encodeURIComponent(command())
      + '&body=' + encodeURIComponent(body);
    window.open(url, '_blank', 'noopener');
  });
</script>
`;
}

/* ------------------------------------------------------------------ main --- */

function main() {
  // The projected summary, and only that. See the module header: this step has
  // no payload and no policy, so it publishes what the commit job decided may be
  // published rather than deciding for itself.
  const summary = readPublicSummary();
  const heartbeat = summary?.heartbeat ?? null;
  const digest = latestDigest();
  const slug = repoSlug();

  // Every write goes through the bounded writer, even though this step only
  // ever runs in CI. `site/` is in the CI allowlist and deliberately not in the
  // collector's: who may write what is a separation, not a duplication. The
  // change gate applies too, so a re-run that changes nothing uploads nothing
  // new.
  const write = (rel, content) => writeIfChanged(rel, content, { allowlist: CI_ALLOWLIST });

  // Content, kept out of the page source.
  //
  // The digest keeps its own H1 in `digest/*.md`, where it is the only title the
  // reader sees. Here it is embedded under a page header that already carries
  // one, so the document's title is dropped rather than rendered twice: without
  // this the published page holds two identical `<h1>Dependency digest</h1>`.
  write(
    path.join(SITE_DATA, 'digest.json'),
    {
      date: digest?.date ?? null,
      observed_at: summary?.observed_at ?? null,
      markdown: digest?.markdown ?? null,
      html: digest ? markdownToHtml(digest.markdown, { skipLeadingH1: true }) : null,
    },
  );

  // `summary` arrives already projected: every count derived from the publishable
  // set and the commands reduced to `{ verb, arg, outcome }`. The drop record is
  // deliberately *not* here — it is a cardinality of the private stack and lives
  // in the private summary, which this step must never read. Nothing here
  // filters, and nothing here may: there is no payload to filter against, and a
  // second filter is a second rule that can disagree with the first.
  write(path.join(SITE_DATA, 'summary.json'), {
    ...(summary ?? {}),
    heartbeat: heartbeat ?? null,
  });

  write(path.join(SITE, '.nojekyll'), '');

  const index = write(
    path.join(SITE, 'index.html'),
    page({ title: 'Dependency digest', body: indexBody(summary, heartbeat), active: 'index' }),
  );
  const chat = write(
    path.join(SITE, 'chat.html'),
    page({ title: 'Ask the agent', body: chatBody(slug), active: 'chat' }),
  );

  const changed = [index, chat].filter((r) => r.changed).length;
  console.log(
    `site: ${changed ? `${changed} page(s) changed` : 'pages unchanged'} · digest ${digest?.date ?? 'none published yet'}`,
  );
  if (!slug) console.warn('::warning::GITHUB_REPOSITORY is unset — chat.html will use a placeholder slug');
}

main();
