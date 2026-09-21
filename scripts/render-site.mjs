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
 * The tab icon, emitted rather than committed as a binary.
 *
 * Two reasons. The obvious one is that a page with no icon makes every visit
 * log a 404 for `/favicon.ico` — measured, it was the *only* console error the
 * site produced, which is the worst kind of noise to leave in place because it
 * hides the next one. The structural one is that a hand-kept `site/favicon.*`
 * would be the single file in `site/` that no render step writes, and the whole
 * point of this directory is that it is generated. An SVG is text, so it can be
 * emitted through the same bounded writer as the pages.
 *
 * The mark is the containment gate: the one component that decides, and the one
 * the README's diagram draws. A shield reads at 16px, which a drawn gate with a
 * label would not.
 */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Dependency digest">
<rect width="32" height="32" rx="7" fill="#08090C"/>
<defs>
<linearGradient id="f" gradientUnits="userSpaceOnUse" x1="6" y1="26" x2="26" y2="6">
<stop offset="0" stop-color="#E3B778"/><stop offset="1" stop-color="#B99BE8"/>
</linearGradient>
</defs>
<path d="M5 16h7M20 16h7" stroke="url(#f)" stroke-width="2.4" stroke-linecap="round" opacity=".85"/>
<rect x="12.6" y="8" width="2.2" height="16" rx="1.1" fill="url(#f)"/>
<rect x="17.2" y="8" width="2.2" height="16" rx="1.1" fill="url(#f)"/>
</svg>
`;

/**
 * The daily run, drawn — the one picture on the page.
 *
 * It is a description of the *system*, not of this run, which is why it renders
 * on every instance including one that has never executed: an empty page that
 * still explains what would happen is more useful than an empty page.
 *
 * The graph is read off `.github/workflows/digest.yml` rather than remembered:
 * `fetch` -> `narrate` -> `commit`, with `heartbeat` reached only from the
 * failure branch (`needs: [fetch, narrate, commit]`, guarded by
 * `always() && (fetch != success || commit != success)`). Four jobs and not one
 * is the consequence of I1 — a job may hold a secret or a write token, never
 * both — so the gate has to sit in `commit`, the job that holds no model key.
 *
 * That placement is the whole reason the gate is drawn on the wire between
 * `narrate` and `commit` instead of inside a box: the picture is making the
 * claim that the deciding step is not the step holding the key.
 *
 * `role="img"` with a label, not bare SVG: the text inside is part of the
 * drawing, and a screen reader handed nine unlabelled `<text>` nodes reads
 * fragments in document order. One sentence is the honest alternative.
 */
const RUNSTRIP = `<div class="runstrip">
<svg viewBox="0 0 1000 164" role="img" aria-label="The daily run. Four jobs: fetch, which is read only; narrate, which holds the model key; commit, which holds the gate and the write token; and heartbeat, which runs only when fetch or commit fails. The containment gate sits on the wire between narrate and commit, in the job that holds no model key.">
<defs>
<marker id="pipeArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
<path d="M0 0L10 5L0 10z" fill="rgba(255,255,255,.30)"/>
</marker>
</defs>
<path class="pipe-line" d="M110 52H870"/>
<path class="pipe-flow" d="M110 52H870"/>
<path class="pipe-line" d="M870 76V108" stroke-dasharray="4 5" marker-end="url(#pipeArrow)"/>
<rect class="pipe-node" x="20" y="28" width="180" height="48" rx="11"/>
<rect class="pipe-node" x="310" y="28" width="180" height="48" rx="11"/>
<rect class="pipe-node" x="770" y="28" width="200" height="48" rx="11"/>
<rect class="pipe-node" x="770" y="110" width="200" height="42" rx="11"/>
<path class="pipe-gate" d="M621 30V74M639 30V74" stroke-linecap="round"/>
<text class="pipe-big" x="110" y="48">FETCH</text>
<text class="pipe-sub" x="110" y="63">read only</text>
<text class="pipe-big" x="400" y="48">NARRATE</text>
<text class="pipe-sub" x="400" y="63">model key</text>
<text class="pipe-big" x="870" y="48">COMMIT</text>
<text class="pipe-sub" x="870" y="63">gate + write</text>
<text class="pipe-big" x="870" y="128">HEARTBEAT</text>
<text class="pipe-sub" x="870" y="143">only on failure</text>
<text class="pipe-mid" x="630" y="20">GATE</text>
<text class="pipe-sub" x="630" y="90">no model key</text>
<text class="pipe-sub" x="852" y="96" style="text-anchor:end">on failure</text>
</svg>
</div>`;


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

/**
 * Escape text for an HTML text node or attribute.
 *
 * Needed because a verb's usage is written the way a human reads it — `why
 * <pkg>` — and `<pkg>` inside an `<option>` is a tag, not a placeholder: the
 * browser drops it and the control renders `why `. Escaping at the point of
 * emission keeps the table readable in the source and correct in the page.
 */
const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page({ title, body, active, status = null }) {
  // Everything below this line is one template literal, stylesheet included.
  // Do not use a backtick anywhere inside it — not in CSS, not in a comment
  // about CSS. A backtick closes the string and the module stops parsing, so
  // the failure surfaces as a SyntaxError pointing at whatever word followed
  // it rather than at the comment that caused it. This has cost a round trip
  // six times; write quotes instead.
  //
  // The status pill is rendered only where a status exists. The composer page
  // has no heartbeat to show, and a pill reading "NO RUN YET" beside a form
  // would be inventing a state rather than reporting one.
  const pill = status
    ? `<span class="live${status !== 'ok' ? ' bad' : ''}"><b></b>${esc(String(status).toUpperCase())}</span>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="./favicon.svg" type="image/svg+xml">
<!-- One theme-color, not two: the page is dark by design, so there is no second
     value to switch to. This paints the mobile browser chrome to match the ground. -->
<meta name="theme-color" content="#08090C">
<style>
  :root {
    /* Dark only, and deliberately so: a near-black ground with a warm gold
       accent, not a light theme with the colours inverted, so there is no twin
       to keep in step. "color-scheme: dark" is the part that is not decoration
       — it is what makes the select's popup, the caret, the scrollbars and the
       default focus ring follow the page instead of rendering as light native
       widgets on a near-black surface. */
    color-scheme: dark;
    --bg: #08090C;
    --surface: rgba(255,255,255,.028);
    --surface-2: rgba(255,255,255,.055);
    --line: rgba(255,255,255,.075);
    --line-2: rgba(255,255,255,.16);
    /* The text ramp. Every step is measured against the worst surface it can
       land on — a .055 white wash over the ground — and not against the ground
       alone: auditing a token against --bg when it renders on glass is
       auditing the wrong pair. The luminance steps are 1.66x / 1.60x / 1.46x,
       so the four levels stay separable instead of collapsing into one grey. */
    --title: #F5F2EA;
    --fg: #C6C1B7;
    --muted: #A29C90;
    --dim: #8A8377;
    --gold: #E3B778;
    --gold-deep: #C98A4B;
    --violet: #B99BE8;
    --ok: #5FD39A;
    --bad: #FB7185;
    --warn: #E8C67A;
    --radius: 15px;
    /* Exponential ease-out: natural deceleration, never bounce or elastic. */
    --ease: cubic-bezier(.16,1,.3,1);
    --ease-soft: cubic-bezier(.25,1,.5,1);
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  /* overflow-x is declared on the root as well as on body, and the reason is
     measurement rather than layout.
     "body { overflow-x: hidden }" with a "visible" root propagates to the
     viewport, and body then *computes* to visible — so the page is correctly
     unscrollable, but "documentElement.scrollWidth" keeps reporting the width
     of the content that was clipped away. Measured on the digest page at a
     390px viewport: scrollWidth 395, clientWidth 390, "window.scrollX" pinned
     at 0 and no unclipped element past the edge. The number is a false positive
     for the only test anyone writes against it (scrollWidth > clientWidth), and
     a check that reports a defect where there is none is how a real one gets
     ignored. Declaring it on the root makes the number agree with the
     behaviour: 390. */
  html { background: var(--bg); scroll-behavior: smooth; overflow-x: hidden; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.62 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh; position: relative; overflow-x: hidden;
  }
  /* Atmosphere, in three fixed layers that never take a pointer event. None of
     it carries meaning: delete all three and the page is still complete and
     still readable. That is the test of decoration. */
  body::before { /* aurora wash */
    content: ""; position: fixed; inset: -20% -10%; z-index: 0; pointer-events: none;
    background:
      radial-gradient(760px 520px at 14% -6%, rgba(185,155,232,.16), transparent 62%),
      radial-gradient(680px 440px at 86% 2%, rgba(227,183,120,.13), transparent 64%),
      radial-gradient(900px 620px at 52% 112%, rgba(95,211,154,.055), transparent 62%);
    animation: drift 26s var(--ease) infinite alternate;
  }
  body::after { /* hairline grid, faded out downward */
    content: ""; position: fixed; inset: 0; z-index: 0; pointer-events: none; opacity: .5;
    background-image:
      linear-gradient(rgba(255,255,255,.026) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.026) 1px, transparent 1px);
    background-size: 58px 58px;
    -webkit-mask-image: radial-gradient(ellipse 95% 62% at 50% 0%, #000 35%, transparent 100%);
    mask-image: radial-gradient(ellipse 95% 62% at 50% 0%, #000 35%, transparent 100%);
  }
  .grain { /* film grain — static, painted once */
    position: fixed; inset: 0; z-index: 0; pointer-events: none; opacity: .05;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
  }
  @keyframes drift {
    from { transform: translate3d(0,0,0) scale(1) }
    to { transform: translate3d(-2%,1.5%,0) scale(1.06) }
  }
  ::selection { background: rgba(227,183,120,.28); color: #fff; }
  .wrap {
    position: relative; z-index: 1; max-width: 1080px; margin: 0 auto;
    --gutter: 26px; padding: 42px var(--gutter) 80px;
  }
  /* Notched phones in landscape: the page has to start inside the safe area, and
     body already hides horizontal overflow, so without this the left edge is
     simply gone rather than scrollable. */
  @supports (padding: max(0px)) {
    .wrap {
      padding-left: max(var(--gutter), env(safe-area-inset-left));
      padding-right: max(var(--gutter), env(safe-area-inset-right));
      padding-bottom: max(80px, env(safe-area-inset-bottom));
    }
  }

  /* ---------- hero ---------- */
  .brand { display: flex; align-items: center; gap: 13px; flex-wrap: wrap; }
  .mark { width: 40px; height: 40px; flex: none; overflow: visible; }
  .mark * { vector-effect: non-scaling-stroke; }
  /* The pulse is a base style, not an animation-only style: with motion off the
     animation is neutered and the dot simply rests at the gate's mouth, which is
     still the right drawing. An animation that carries the only copy of a visual
     state erases it for anyone who has asked for less motion. */
  .markdot { animation: gate 3.8s var(--ease) infinite; }
  @keyframes gate {
    0% { transform: translateX(0); opacity: 0 }
    10% { opacity: 1 }
    50% { transform: translateX(30px); opacity: 1 }
    62% { opacity: 0 }
    100% { transform: translateX(30px); opacity: 0 }
  }
  h1 {
    font-size: clamp(24px, 3.1vw, 31px); font-weight: 600; color: var(--title);
    margin: 0; letter-spacing: -.028em; line-height: 1.12;
    background: linear-gradient(96deg, #FFF8EC 6%, #E3B778 58%, #B99BE8 100%);
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
  }
  /* The status pill. The beacon is the one animation on the page that carries
     meaning, so it is the one that must not be the only carrier: the word beside
     it says the same thing. */
  .live {
    display: inline-flex; align-items: center; gap: 7px; padding: 4px 11px 4px 9px;
    border: 1px solid rgba(227,183,120,.30); border-radius: 999px;
    font: 600 10.5px/1 var(--mono); letter-spacing: .13em; color: var(--gold);
    background: rgba(227,183,120,.07);
  }
  .live b {
    width: 6px; height: 6px; border-radius: 50%; background: var(--gold);
    box-shadow: 0 0 0 0 rgba(227,183,120,.55); animation: beacon 2.4s var(--ease) infinite;
  }
  .live.bad { color: var(--bad); border-color: rgba(251,113,133,.32); background: rgba(251,113,133,.08); }
  .live.bad b { background: var(--bad); box-shadow: 0 0 0 0 rgba(251,113,133,.55); }
  @keyframes beacon {
    0% { box-shadow: 0 0 0 0 rgba(227,183,120,.5) }
    70% { box-shadow: 0 0 0 9px rgba(227,183,120,0) }
    100% { box-shadow: 0 0 0 0 rgba(227,183,120,0) }
  }
  .lede { margin: 14px 0 0; max-width: 68ch; color: var(--muted); font-size: 14.5px; }
  .lede b { color: var(--fg); font-weight: 500; }
  nav { display: flex; gap: 7px; margin: 18px 0 0; font-size: 13.5px; }
  nav a {
    color: var(--muted); text-decoration: none; padding: 7px 14px; border-radius: 999px;
    border: 1px solid transparent; transition: color .16s, border-color .16s, background .16s;
  }
  nav a:hover { color: var(--title); border-color: var(--line); background: var(--surface); }
  nav a[aria-current="page"] {
    color: var(--title); border-color: var(--line); background: var(--surface-2); font-weight: 600;
  }

  /* One focus treatment for every interactive thing on the page, including the
     form controls, which otherwise keep the UA ring — invisible on a near-black
     page and inconsistent with the links beside it. */
  a:focus-visible, button:focus-visible, select:focus-visible, input:focus-visible {
    outline: 2px solid var(--gold); outline-offset: 2px; border-radius: 6px;
  }

  /* ---------- stats: one band, not six cards ----------
     The counts are one reading. Six boxes with six borders read as six unrelated
     facts and cost twelve edges to say what six dividers say. The band is glass
     rather than a flat fill so the aurora passes behind it. */
  .stats {
    display: flex; flex-wrap: wrap; margin: 26px 0 0;
    border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden;
    background: linear-gradient(180deg, rgba(255,255,255,.045), rgba(255,255,255,.014));
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  }
  .stat { flex: 1 1 128px; padding: 15px 19px; border-right: 1px solid var(--line); min-width: 0; }
  .stat:last-child { border-right: 0; }
  .stat b {
    display: block; font: 600 21px/1.2 var(--mono); color: var(--title);
    font-variant-numeric: tabular-nums; letter-spacing: -.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .stat b.acc { color: var(--gold); }
  .stat b.bad { color: var(--bad); }
  .stat span {
    display: block; margin-top: 5px; font-size: 10px; color: var(--dim);
    text-transform: uppercase; letter-spacing: .11em;
  }

  /* ---------- the run strip ----------
     The daily run, drawn: three stages and the conditional heartbeat. It is a
     static description of the system, not of this run, which is why it renders
     even when nothing has been published.

     It scrolls sideways on a narrow screen rather than shrinking, and the
     min-width is the whole point of that. Measured at a 390px viewport: the SVG
     laid out at 358px wide, which scales a 9px mono label to 3.9px — present,
     and unreadable, which is the same as absent while looking like a decision
     someone made. The strip carries real structure (four jobs, and where the
     gate sits relative to the key), so it is worth a horizontal scroll; the
     digest table below it already behaves this way, and the two now share one
     scroll affordance rather than two copies of it. */
  .runstrip {
    margin: 18px 0 0; padding: 16px 20px 12px; border: 1px solid var(--line);
    border-radius: var(--radius); background-color: rgba(255,255,255,.018);
    overflow-x: auto;
  }
  .runstrip svg { display: block; width: 100%; min-width: 900px; height: auto; overflow: visible; }
  /* One scroll affordance for the two boxes that scroll sideways — the digest
     table and the run strip. It lives here rather than on each because a
     four-layer background copied into a second rule is a background that will
     drift.

     A scroll box with no cue hides its right-hand content with nothing to say
     it is there, and on the digest table that content is the Why column — the
     most informative one. Two layers per side: a cover in the page background
     that travels with the content (local) masks a shadow pinned to the box edge
     (scroll). At scroll 0 the left shadow is covered and the right one shows;
     at the far end they swap. Only the edge with more content is ever lit.

     The shadow is mixed from currentColor rather than given a token of its own,
     so it follows the theme by construction: a black shadow is invisible on the
     dark page, and a fixed light one would glare on a light page. Where
     color-mix is unsupported the declaration drops and the box simply has no
     shadow — the fallback is the plain scroll box, not a broken one. */
  main table, .runstrip {
    background-image:
      linear-gradient(to right, var(--bg) 40%, transparent),
      linear-gradient(to left, var(--bg) 40%, transparent),
      radial-gradient(farthest-side at 0 50%, color-mix(in srgb, currentColor 20%, transparent), transparent),
      radial-gradient(farthest-side at 100% 50%, color-mix(in srgb, currentColor 20%, transparent), transparent);
    background-position: 0 0, 100% 0, 0 0, 100% 0;
    background-size: 26px 100%, 26px 100%, 13px 100%, 13px 100%;
    background-repeat: no-repeat;
    background-attachment: local, local, scroll, scroll;
  }
  /* The diagram's geometry is its content — which stage feeds which, and where
     the gate sits on the wire — so the lines and outlines are graphical objects
     under WCAG 1.4.11 and owe 3:1 against what they sit on, not the 1.45:1 and
     1.80:1 that .14 and .20 measured. .34 is the first step that clears it
     (measured 3.06:1 against the strip's own background, composited over --bg).
     The labels inside the boxes were never the problem: 10.81:1 for the stage
     names, 5.16:1 for the sub-labels. */
  .pipe-line { stroke: rgba(255,255,255,.34); stroke-width: 1.25; fill: none; }
  .pipe-flow { stroke: var(--gold); stroke-width: 1.6; fill: none; stroke-dasharray: 26 240;
    animation: flow 5.5s linear infinite; opacity: .8; }
  @keyframes flow { to { stroke-dashoffset: -798 } }
  .pipe-node { fill: #0B0C10; stroke: rgba(255,255,255,.34); stroke-width: 1.1; }
  .pipe-gate { stroke: var(--gold); stroke-width: 1.3; }
  .pipe-big { fill: #C6C1B7; font: 600 11px var(--mono); text-anchor: middle; }
  .pipe-sub { fill: #8A8377; font: 9px var(--mono); text-anchor: middle; }
  .pipe-mid { fill: #8A8377; font: 9px var(--mono); text-anchor: middle; letter-spacing: .08em; }

  /* The liveness line, as a ledger attached under the strip.
     max-width is reset because this is a <p> inside <main> and the prose
     measure applies to it: at 72ch the bar stopped short of the strip it is
     meant to be attached to, which reads as a broken box rather than a line of
     text. The ledger is a table row, not a paragraph. */
  .ledger {
    margin: 0 0 30px; padding: 10px 15px; border: 1px solid var(--line); border-top: 0;
    border-radius: 0 0 var(--radius) var(--radius); background: rgba(255,255,255,.01);
    font: 11px/1.6 var(--mono); color: var(--muted); letter-spacing: .04em;
    max-width: none;
  }
  .ledger time { color: var(--dim); }
  /* The one word in the ledger that is a verdict rather than a record. Colour
     alone must not carry it — the word "ok" or "failure" is right there — so
     this is emphasis on a statement that already reads correctly in plain ink. */
  .ledger b { color: var(--ok); font-weight: 600; }
  .ledger b.bad { color: var(--bad); }
  main { padding: 0 0 8px; }
  main h2 { font-size: 17px; color: var(--title); margin: 30px 0 10px; letter-spacing: -.012em; }
  main h3 { font-size: 14px; color: var(--fg); margin: 22px 0 8px; }
  main h4, main h5, main h6 { font-size: 13px; color: var(--muted); margin: 18px 0 6px; }
  /* Prose is set to a measure; tables are not.
     Measured on the digest page at a 1440px viewport, a body paragraph ran the
     full 1028px of the content column — 112ch, against the 45-75ch a reader can
     track without losing the line. The heading, the tables and the diagram stay
     full width because they are not read line by line; the paragraphs are, and
     that is the difference. The step between the two is the normal shape of an
     editorial page, and it is the reason the digest is legible rather than just
     tidy. */
  main p { margin: 11px 0; max-width: 72ch; }
  main ul, main ol { margin: 11px 0; padding-left: 22px; max-width: 72ch; }
  main li { margin: 5px 0; }
  main li::marker { color: var(--dim); }
  main hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
  main strong { color: var(--title); font-weight: 600; }
  /* display:block + overflow-x:auto is what keeps a wide table from
     widening the *page* on a phone: measured at a 390px viewport the document
     was 544px wide, so the last column was clipped and the whole page scrolled
     sideways. The rows keep their table layout inside the scroll box. */
  main table {
    display: block; width: max-content; min-width: 100%; max-width: 100%;
    overflow-x: auto; border-collapse: collapse; font-size: 14px; margin: 8px 0;
  }
  main th, main td { text-align: left; padding: 8px 9px; border-bottom: 1px solid var(--line); vertical-align: top; }
  /* The header row gets a surface of its own: a 1.2:1 rule alone does not carry
     a column header across a wide table. Mono, uppercase and letterspaced, so
     the header reads as a label rather than as a first data row. */
  main th {
    font: 600 10px var(--mono); text-transform: uppercase; letter-spacing: .1em;
    color: var(--dim); background: rgba(255,255,255,.028); white-space: nowrap;
  }
  /* An identifier inside a code element is one token and never breaks. Without
     this the max-width clamp above squeezes the column and the browser breaks
     the advisory id at every hyphen — measured on a 390px viewport: one id
     stacked four lines deep, which is less readable than the overflow it
     replaced. nowrap lifts the inner table's min-content width above the
     clamp, so the scroll box scrolls instead of the cells wrapping. Prose
     cells (the Why column) are untouched and still wrap. */
  main td code { white-space: nowrap; }
  /* The digest's last column is always Why — lib/render.mjs writes the header
     as a fixed literal. It is the only prose column, so it is the only one that
     can absorb the clamp, and without a floor it takes whatever is left after
     the five identifier columns and wraps to four lines per row: measured, rows
     150px tall against 30 characters of text. The floor costs scroll distance
     and buys back the reading. */
  main td:last-child, main th:last-child { min-width: 220px; }
  main code {
    font-family: var(--mono); font-size: 12.5px; color: var(--fg);
    background: rgba(255,255,255,.055); border: 1px solid var(--line);
    padding: 1px 5px; border-radius: 5px;
  }
  /* The withheld banner, and the only warn surface on the page. */
  main blockquote {
    margin: 14px 0; padding: 14px 18px; border-radius: var(--radius);
    border: 1px solid rgba(232,198,122,.26); border-left: 2px solid var(--warn);
    background: rgba(232,198,122,.06); color: var(--fg);
  }
  /* A banner that carries several blocks should not open and close with the
     body-prose margin: the padding already sets the inset, and a leading margin
     pushes the first line away from the rule it is meant to sit against. */
  main blockquote > :first-child { margin-top: 0; }
  main blockquote > :last-child { margin-bottom: 0; }
  main a { color: var(--gold); text-decoration: none; border-bottom: 1px solid rgba(227,183,120,.32); }
  main a:hover { border-bottom-color: var(--gold); }

  /* Composer. The controls are styled rather than left to the UA, so the page
     looks the same in every browser and the native widgets cannot disagree with
     the ground. */
  .field { display: block; margin: 16px 0; max-width: 520px; }
  .field > label {
    display: block; font: 600 10px var(--mono); letter-spacing: .12em;
    text-transform: uppercase; color: var(--dim); margin-bottom: 7px;
  }
  select, input[type="text"] {
    width: 100%; padding: 11px 13px; font: inherit; font-size: 14px; color: var(--title);
    background: rgba(255,255,255,.032); border: 1px solid var(--line); border-radius: 11px;
    outline: none; transition: border-color .18s, box-shadow .18s, background .18s;
  }
  select:hover { border-color: var(--line-2); }
  select:focus, input[type="text"]:focus {
    border-color: rgba(227,183,120,.45); background: rgba(255,255,255,.05);
    box-shadow: 0 0 0 4px rgba(227,183,120,.09);
  }
  select:disabled, input[type="text"]:disabled { opacity: .5; cursor: not-allowed; }
  .hint { display: block; color: var(--muted); font-size: 12.5px; margin: 7px 0 0; max-width: 520px; }
  .preview {
    font-family: var(--mono); font-size: 13px; color: var(--fg);
    background: rgba(255,255,255,.028); border: 1px solid var(--line); border-radius: 11px;
    padding: 12px 14px; max-width: 520px; margin: 18px 0;
  }
  .btn {
    display: inline-block; padding: 11px 18px; font: inherit; font-weight: 600; font-size: 14px;
    color: #0B0C10; background: linear-gradient(180deg, #F0CD96, var(--gold));
    border: 1px solid var(--gold-deep); border-radius: 11px; cursor: pointer;
    transition: filter .18s, transform .18s var(--ease);
  }
  .btn:hover:not(:disabled) { filter: brightness(1.06); transform: translateY(-1px); }
  .btn:active:not(:disabled) { transform: translateY(0) scale(.99); }
  /* Disabled is a token swap, not an opacity fade. Fading the whole element
     fades its label with it: at .45 the composited button text measured 2.9:1
     against 5.5:1 for these two tokens. WCAG exempts an inactive control from
     the contrast requirement, so this was never a violation — but the label
     still has to be *read* to know what the button would do, and a flat surface
     reads as inactive without dimming the words. */
  .btn:disabled {
    color: var(--muted); background: rgba(255,255,255,.032); border-color: var(--line);
    cursor: not-allowed;
  }
  footer {
    margin-top: 46px; padding-top: 22px; border-top: 1px solid var(--line);
    font-size: 12px; color: var(--dim); line-height: 1.7;
  }
  footer code { font-family: var(--mono); color: var(--muted); }

  /* ---------- touch and small screens ----------
     Three separate costs, all of which a phone pays and a desktop does not
     notice, so all three stand down here rather than being tuned down: the
     full-screen animated wash, the per-card flow animation, and the backdrop
     blur behind the stats. What is left is the same design, held still. */
  @media (max-width: 900px), (hover: none) {
    body::before { animation: none; }
    .stats { backdrop-filter: none; -webkit-backdrop-filter: none; }
    .pipe-flow { animation: none; }
  }
  @media (max-width: 900px) {
    /* 16px, not 13.5px: iOS Safari zooms the whole page when a focused field is
       set below 16px, and it does not zoom back out. Readers experience that as
       the layout breaking. */
    select, input[type="text"] { font-size: 16px; }
  }
  @media (max-width: 640px) {
    .wrap { --gutter: 16px; padding-top: 30px; padding-bottom: max(60px, env(safe-area-inset-bottom)); }
    h1 { font-size: 23px; }
    /* Two per row, and the dividers have to follow the new grid: the band's
       right border would otherwise sit in the middle of a row. */
    .stat { flex: 1 1 50%; border-bottom: 1px solid var(--line); }
    .stat:nth-child(2n) { border-right: 0; }
    .stat:nth-last-child(-n+2) { border-bottom: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: .001ms !important; animation-iteration-count: 1 !important;
      transition-duration: .001ms !important;
    }
    html { scroll-behavior: auto; }
  }
</style>
</head>
<body>
<div class="grain" aria-hidden="true"></div>
<div class="wrap">
<header>
  <div class="brand">
    <svg class="mark" viewBox="0 0 44 44" aria-hidden="true">
      <defs>
        <linearGradient id="markGrad" gradientUnits="userSpaceOnUse" x1="6" y1="38" x2="38" y2="6">
          <stop offset="0" stop-color="#E3B778"/><stop offset="1" stop-color="#B99BE8"/>
        </linearGradient>
      </defs>
      <!-- The containment gate: flow arrives, is decided, and leaves. -->
      <path d="M3 22h13M28 22h13" stroke="url(#markGrad)" stroke-width="2.2" stroke-linecap="round" opacity=".85"/>
      <rect x="16.6" y="11" width="2.4" height="22" rx="1.2" fill="url(#markGrad)"/>
      <rect x="25" y="11" width="2.4" height="22" rx="1.2" fill="url(#markGrad)"/>
      <circle class="markdot" cx="7" cy="22" r="2.2" fill="#E3B778"/>
    </svg>
    <h1>${title}</h1>
    ${pill}
  </div>
  <p class="lede">A git-native agent: <b>the repository is the state</b>, and every turn is a fresh
  job. No server, no database, and no dependency to install.</p>
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

/**
 * What the header pill is allowed to claim.
 *
 * `heartbeat.last_status` comes from `publicHeartbeat()`, which re-derives it
 * from the **published** error list rather than copying the private one. On a
 * withheld run that list is empty — nothing was published, so nothing failed —
 * and the status reads `ok`. Put that beside a banner saying the digest is being
 * withheld and the page contradicts itself in its first two lines, with the
 * reassuring half winning because it is higher up.
 *
 * This does not fix `publicHeartbeat()`, and deliberately so: whether the
 * producer should record a withheld run as a failure is a question about the
 * private run, and changing it here would put a second opinion about status on
 * the public surface. What it does is stop the *page* from making a claim it
 * cannot support. The banner already reads `withheld_reason`, and this reads the
 * same field, so the two cannot disagree.
 */
function headerStatus(summary, heartbeat) {
  if (summary?.withheld_reason) return 'withheld';
  return heartbeat?.last_status ?? null;
}

function indexBody(summary, heartbeat) {
  const s = summary ?? {};
  // `tone` is information, not decoration: a non-zero "sources failed" is the one
  // number on this page that says the run was incomplete, and in plain ink it
  // reads exactly like "packages watched". `acc` marks the count that asks for a
  // human. Both are the page's own tokens — the README artwork keeps a separate
  // palette and neither borrows from the other.
  const stat = (value, label, tone = '') => {
    const shown = Number.isFinite(value) ? value : '—';
    const cls = tone && Number.isFinite(value) && value > 0 ? ` class="${tone}"` : '';
    return `<div class="stat"><b${cls}>${shown}</b><span>${label}</span></div>`;
  };

  // The liveness line is a ledger under the run strip, not a `.live` pill: the
  // pill class is the status beacon in the header, and reusing it here would
  // restyle this paragraph as a badge and its <b> as a 6px dot.
  //
  // It reads the *resolved* status, not `heartbeat.last_status` directly, for
  // the reason given at `headerStatus()`: on a withheld run the raw status is
  // `ok`, and printing it here put "Last run ok" one line under a header pill
  // reading WITHHELD. The contradiction the pill was fixed for reappeared a line
  // lower, which is what happens when a decision is applied at the place it was
  // noticed rather than at the place it is made.
  const status = headerStatus(summary, heartbeat);
  const live = heartbeat?.last_run_at
    ? `<p class="ledger">Last run <b${status && status !== 'ok' ? ' class="bad"' : ''}>${status ?? 'unknown'}</b> at <time datetime="${heartbeat.last_run_at}">${heartbeat.last_run_at}</time>${heartbeat.consecutive_failures ? ` · ${heartbeat.consecutive_failures} consecutive failure(s)` : ''}</p>`
    : '<p class="ledger">No run recorded yet.</p>';

  // A withheld digest has to be visible, and this page dropped it.
  //
  // `buildPublicSurface()` keeps a broken marker loud (`withheld_reason:
  // 'invalid-marker'`, plus the count) and a deny-all silent, because "everything
  // was withheld" is itself a statement about the private stack and must stay
  // indistinguishable from a quiet day. The page honoured neither half: measured,
  // a summary carrying `withheld_reason` rendered **byte-identical** to a healthy
  // instance with nothing to report. So an operator whose marker was never read —
  // a typo, a missing key — saw a clean empty page and had no signal at all.
  //
  // The banner fires on the reason alone, never on a zero count: a deny-all has
  // no `withheld_reason` and must keep rendering as a quiet day. The count is
  // printed but the violations are not, matching the producer, which keeps the
  // entries off the public surface because a mistyped entry can be a private name.
  //
  // The copy is addressed to whoever clicked "Use this template", not to us. It
  // names the file, says which three lists to check, gives the three ways the
  // lists can be wrong, and says where the detail actually is. The first draft
  // said "fix the marker", which is not guidance: a reader who has just been told
  // something is wrong learns nothing from being told to fix it. Built as its own
  // statement rather than a nested template literal — see the warning at `page()`.
  const problems = Number.isFinite(s.invalid_marker) ? s.invalid_marker : null;
  const problemLine = problems === null
    ? ''
    : `<p><strong>This run found ${problems} problem${problems === 1 ? '' : 's'}.</strong>
<em>Which</em> entries they are is in the run log — the <code>commit</code> job of the failing
workflow — and deliberately not on this page, because a mistyped entry can itself be a name you
meant to keep private.</p>`;
  const withheld = s.withheld_reason
    ? `<blockquote>
<p><strong>The digest is being withheld.</strong> The publication lists in
<code>data/stack.json</code> — the ones saying which parts of your stack may be published —
could not be read, so this run published nothing. That is deliberate: publishing nothing is
safer than publishing part of a private watch list by accident.</p>
<p><strong>Your stack is not empty and nothing has been lost.</strong> The watch list is intact;
only the published copy was held back, and it publishes again as soon as the lists read cleanly.</p>
<p><strong>To fix it,</strong> check all three lists in <code>data/stack.json</code>:</p>
<ul>
<li>They must all be present — <code>public_packages</code>, <code>public_upstreams</code> and
<code>public_feeds</code>. To publish nothing <em>on purpose</em>, set them to <code>[]</code>:
an empty list is a valid choice and will not show this message, but a <em>missing</em> key is
not an empty one.</li>
<li>Every entry must name something already in your watch list — <code>packages</code>,
<code>watch.upstreams</code> or <code>watch.feeds</code>.</li>
<li>An entry that could mean more than one package needs both fields, as in
<code>{"name": "requests", "ecosystem": "PyPI"}</code>.</li>
</ul>
${problemLine}
<p>Fix the file and the next run will publish.</p>
<p class="hint">Reason code: ${esc(s.withheld_reason)}</p>
</blockquote>`
    : '';

  // A withheld run publishes nothing, so the projection yields zeros — and six
  // zeros under a banner that says "your stack is not empty" contradict it.
  // "0 packages watched" is not true; it is "0 published", which is a different
  // claim about a document this run refused to write. The counts are replaced by
  // a line that says so rather than printed: an absence that is explained is not
  // a rendering bug, and an unexplained zero is worse than no number at all.
  const stats = s.withheld_reason
    ? '<p class="hint">Counts are not shown: they describe the published copy, which this run withheld.</p>'
    : `<div class="stats">
  ${stat(s.actionable, 'to act on', 'acc')}
  ${stat(s.uncertain, 'needing your call')}
  ${stat(s.clear, 'clear')}
  ${stat(s.advisories, 'advisories')}
  ${stat(s.packages, 'packages watched')}
  ${stat(s.sources_failed, 'sources failed', 'bad')}
</div>`;

  // One `<main>` around the whole reading column, and the digest is a
  // `<section>` inside it rather than the `<main>` itself.
  //
  // The banner, the stats band and the strip used to be siblings of
  // `<main id="digest">`, because the script below assigns `innerHTML` on that
  // element and anything inside it would be wiped when the digest arrived. That
  // is a real constraint, but it is a constraint on *where the digest goes*, not
  // on where the rest of the page goes — and satisfying it by moving the rest
  // out of `<main>` silently detached it from every `main …` rule in the
  // stylesheet. Measured on the withheld page: the banner rendered as plain
  // text, with no border, no tint and no measure, because `main blockquote`
  // matched nothing. The same defect the chat page had, in the same shape.
  return `
<main>
${withheld}${stats}
${RUNSTRIP}
${live}
<section id="digest" aria-busy="true">
  <p role="status"><em>Loading the latest digest…</em></p>
  <noscript>
    <p>This page renders the digest with JavaScript. The same content is committed as Markdown
    under <code>digest/</code> in the repository.</p>
  </noscript>
</section>
</main>
<script>
  // Reads files this job wrote into site/api/. Nothing else is contacted.
  //
  // aria-busy rather than aria-live on the container: the digest is a whole
  // document, and a live region would make a screen reader read all of it the
  // moment it arrives. The busy flag says "still loading, then done" without
  // that; the content itself is reached by ordinary navigation.
  (async () => {
    const main = document.getElementById('digest');
    try {
      const res = await fetch('./api/digest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const doc = await res.json();
      main.innerHTML = doc.html || '<p>No digest has been published yet.</p>';
    } catch (err) {
      main.innerHTML = '<p>The digest could not be loaded. It is committed as Markdown under <code>digest/</code>.</p>';
    } finally {
      main.setAttribute('aria-busy', 'false');
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

  /**
   * The verb table, mirroring `lib/commands.mjs` — and mirroring it only in
   * *presence*, never in *shape*.
   *
   * `arg` has exactly three values, and the first cut of this table had four
   * (`package` beside `required` for the same requirement), which is how a
   * command with a missing package name stayed submittable: the gate tested for
   * one spelling and the table used the other.
   *
   *   none      the server refuses any argument (pause, resume)
   *   optional  valid with or without one (what-changed)
   *   required  refused without one (everything else)
   *
   * What it does *not* say is what a valid argument looks like. A composer that
   * re-implemented the grammar would be a second, weaker copy of a rule that
   * already exists, and the two would disagree the first time one changed —
   * `verify` accepts `#128` *or* a pull-request URL, and a client-side `/^\d+$/`
   * would refuse the second. The page gates on presence and leaves shape to the
   * parser, which is the component that is actually trusted.
   */
  const verbs = [
    { verb: 'why', usage: 'why <pkg>', arg: 'required',
      hint: 'A package name from your watch list.',
      help: 'Look up the stored decision. No model.' },
    { verb: 'what-changed', usage: 'what-changed', arg: 'optional',
      argLabel: 'Since date', placeholder: 'since 2026-09-01',
      hint: 'Leave blank for everything, or narrow it to a date.',
      help: 'Everything that moved since the last run. No model.' },
    { verb: 'bump', usage: 'bump <pkg>', arg: 'required',
      hint: 'A package name from your watch list.',
      help: 'Open a pull request; optionally run the suite in the sandbox.' },
    { verb: 'verify', usage: 'verify <pr>', arg: 'required',
      argLabel: 'Pull request', placeholder: '128',
      hint: 'A pull request number, or the pull request URL.',
      help: 'Run the suite against a patch in the sandbox.' },
    { verb: 'wrong', usage: 'wrong <pkg>', arg: 'required',
      hint: 'A package name from your watch list.',
      help: 'Record that the decision was wrong. This is the calibration signal.' },
    { verb: 'pause', usage: 'pause', arg: 'none',
      hint: 'This verb takes no argument.',
      help: 'Skip the schedule until resumed.' },
    { verb: 'resume', usage: 'resume', arg: 'none',
      hint: 'This verb takes no argument.',
      help: 'Resume the schedule.' },
    { verb: 'explain', usage: 'explain <GHSA-…>', arg: 'required',
      argLabel: 'Advisory id', placeholder: 'GHSA-…',
      hint: 'A GHSA-… or CVE-… identifier, as it appears in the digest.',
      help: 'The only verb that calls a model. Answer is marked unverified.' },
  ];

  const options = verbs
    .map((v) => `<option value="${v.verb}">${esc(v.usage)}</option>`)
    .join('\n        ');

  // The composer's own copy of the table, as data. It is `JSON.stringify`d
  // rather than interpolated into statements, so nothing here can become an
  // expression in the page.
  const model = Object.fromEntries(
    verbs.map((v) => [
      v.verb,
      {
        arg: v.arg,
        argLabel: v.argLabel ?? 'Package',
        placeholder: v.placeholder ?? 'lodash',
        hint: v.hint,
        help: v.help,
      },
    ]),
  );

  return `
<main>
${setup}
<p>This page composes a command and hands it to GitHub. It does not run anything, hold a
credential, or call a model: you press the button, you are already signed in, and the reply
lands as a comment in the thread.</p>
<form id="composer">
  <p class="field">
    <label for="verb">Command</label>
    <select id="verb" name="verb">
        ${options}
    </select>
    <span class="hint" id="help"></span>
  </p>
  <p class="field">
    <label for="arg" id="argLabel">Package</label>
    <input id="arg" name="arg" type="text" placeholder="lodash" autocomplete="off"
           aria-describedby="argHint">
    <span class="hint" id="argHint"></span>
  </p>
  <p class="preview" id="preview" aria-live="polite">/agent why</p>
  <p>
    <button type="submit" class="btn" id="submit">Open as a GitHub issue</button>
  </p>
</form>
<p class="hint">
  The reply is asynchronous — a job has to start, and that takes a minute, not a second.
  That is the price of there being no server.
</p>
</main>
<script>
  const VERBS = ${JSON.stringify(model)};
  const REPO = ${JSON.stringify(repo)};
  const verb = document.getElementById('verb');
  const arg = document.getElementById('arg');
  const argLabel = document.getElementById('argLabel');
  const argHint = document.getElementById('argHint');
  const help = document.getElementById('help');
  const preview = document.getElementById('preview');
  const submit = document.getElementById('submit');

  function spec() { return VERBS[verb.value]; }

  function command() {
    const a = spec().arg === 'none' ? '' : arg.value.trim();
    return a ? '/agent ' + verb.value + ' ' + a : '/agent ' + verb.value;
  }

  // One place that decides what the form currently means: the labels, whether
  // the argument field applies, whether the command is complete, and the
  // preview. Anything that changes the form calls this.
  function sync() {
    const s = spec();
    const takesArg = s.arg !== 'none';
    help.textContent = s.help;
    argLabel.textContent = s.argLabel;
    arg.placeholder = s.placeholder;
    argHint.textContent = s.hint;
    arg.disabled = !takesArg;
    if (!takesArg) arg.value = '';
    // Disabled rather than rejected: a command missing its required argument is
    // one the parser would refuse anyway, so the page does not offer to send it.
    submit.disabled = s.arg === 'required' && !arg.value.trim();
    preview.textContent = command();
  }

  verb.addEventListener('change', sync);
  arg.addEventListener('input', sync);
  sync();

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
  write(path.join(SITE, 'favicon.svg'), FAVICON);

  const status = headerStatus(summary, heartbeat);

  const index = write(
    path.join(SITE, 'index.html'),
    page({ title: 'Dependency digest', body: indexBody(summary, heartbeat), active: 'index', status }),
  );
  const chat = write(
    path.join(SITE, 'chat.html'),
    page({ title: 'Ask the agent', body: chatBody(slug), active: 'chat', status }),
  );

  const changed = [index, chat].filter((r) => r.changed).length;
  console.log(
    `site: ${changed ? `${changed} page(s) changed` : 'pages unchanged'} · digest ${digest?.date ?? 'none published yet'}`,
  );
  if (!slug) console.warn('::warning::GITHUB_REPOSITORY is unset — chat.html will use a placeholder slug');
}

main();
