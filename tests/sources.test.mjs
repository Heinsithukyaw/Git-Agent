/**
 * Sources.
 *
 * The parsing is tested without the network: a suite that needs the network
 * fails for reasons that have nothing to do with the code.
 *
 * What matters about `parseFeed` is that it is *tolerant*: feeds are the most
 * irregular input in the pipeline, and a feed that fails to parse must degrade
 * one section of the digest rather than fail the run.
 *
 * `osv()` is tested by stubbing `fetch` and asserting the **request**. That
 * looks like it violates the rule above, and it is the exception that proves it:
 * the fetcher is where the defect was. It called `/v1/querybatch`, whose response
 * carries `{id, modified}` and nothing else, while the mapping downstream read
 * `summary`, `severity` and `affected` off it. Every advisory arrived hollow, an
 * empty `affected` read as "not affected", and the digest reported 11 clear /
 * 0 to act on for a stack whose eleven advisories all affected the pinned version.
 *
 * No test could have caught that by inspecting a response — the response was
 * fine. It was simply not the response the code was written for. What catches it
 * is capturing the request and asserting the endpoint and the call count. That
 * needs a stub, not the network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed, osv } from '../lib/sources.mjs';

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Changelog</title>
  <item><title>First &amp; foremost</title><link>https://example.invalid/1</link><pubDate>Mon, 05 Jan 2026 00:00:00 GMT</pubDate></item>
  <item><title><![CDATA[A <b>bold</b> release]]></title><link>https://example.invalid/2</link></item>
  <item><description>no title here</description><link>https://example.invalid/3</link></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>Atom entry</title><id>https://example.invalid/atom-1</id><updated>2026-01-05T00:00:00Z</updated></entry>
</feed>`;

test('reads RSS items, decoding entities and stripping markup', () => {
  const items = parseFeed(RSS);
  assert.equal(items.length, 2, 'an item with no title is skipped, not guessed at');
  assert.equal(items[0].title, 'First & foremost');
  assert.equal(items[0].link, 'https://example.invalid/1');
  assert.equal(items[0].published, 'Mon, 05 Jan 2026 00:00:00 GMT');
  assert.equal(items[1].title, 'A bold release', 'CDATA and inner tags are unwrapped');
});

test('reads Atom entries, falling back from link to id', () => {
  const items = parseFeed(ATOM);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Atom entry');
  assert.equal(items[0].link, 'https://example.invalid/atom-1');
  assert.equal(items[0].published, '2026-01-05T00:00:00Z');
});

test('the limit is honoured', () => {
  const many = `<rss><channel>${Array.from({ length: 40 }, (_, i) => `<item><title>t${i}</title></item>`).join('')}</channel></rss>`;
  assert.equal(parseFeed(many, { limit: 3 }).length, 3);
  assert.equal(parseFeed(many).length, 10, 'the default limit is 10');
});

test('a feed that is not a feed returns nothing rather than throwing', () => {
  assert.deepEqual(parseFeed(''), []);
  assert.deepEqual(parseFeed('<html><body>a page, not a feed</body></html>'), []);
  assert.deepEqual(parseFeed('not xml at all'), []);
});

/* ------------------------------------------------------------------ osv --- */

/** Capture every request `osv()` makes, and answer from `respond(entry)`. */
async function stubFetch(respond, fn) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const entry = { url, init, body: init?.body ? JSON.parse(init.body) : null };
    seen.push(entry);
    return respond(entry);
  };
  try {
    return { seen, result: await fn() };
  } finally {
    globalThis.fetch = real;
  }
}

const okJson = (json) => ({ ok: true, status: 200, json: async () => json });

test('the advisory lookup is one /v1/query call per package, not a batch', async () => {
  const { seen } = await stubFetch(() => okJson({ vulns: [] }), () =>
    osv([
      { name: 'express', ecosystem: 'npm', pinned: '4.18.2' },
      { name: 'requests', ecosystem: 'PyPI', pinned: '2.31.0' },
    ]),
  );

  assert.equal(seen.length, 2, 'one call per package — the batch endpoint returns ids only');
  for (const s of seen) {
    assert.equal(s.url, 'https://api.osv.dev/v1/query', '/v1/querybatch carries no range data');
    assert.equal(s.init.method, 'POST');
  }
  assert.deepEqual(seen[0].body, {
    package: { name: 'express', ecosystem: 'npm' },
    version: '4.18.2',
  });
});

test('the full record survives the lookup, ranges included', async () => {
  // The fields the mapping downstream reads. If the endpoint changes again and
  // returns a stub object, this is the test that notices.
  const record = {
    vulns: [
      {
        id: 'GHSA-qw6h-vgh9-j6wx',
        summary: 'express vulnerable to XSS via response.redirect()',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:L' }],
        affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.20.0' }] }] }],
      },
    ],
  };

  const { result } = await stubFetch(() => okJson(record), () =>
    osv([{ name: 'express', ecosystem: 'npm', pinned: '4.18.2' }]),
  );

  const v = result.results[0].vulns[0];
  assert.equal(v.summary, record.vulns[0].summary, 'the summary is what makes the digest readable');
  assert.equal(v.affected[0].ranges[0].type, 'SEMVER', 'the range type is what triage filters on');
  assert.deepEqual(result.failures, []);
});

test('a package whose lookup fails is a gap, not a quiet package', async () => {
  // "We could not ask" and "there is nothing to report" must not look the same:
  // the second reads as a clean bill of health.
  const { result } = await stubFetch(
    (entry) =>
      entry.body.package.name === 'requests'
        ? { ok: false, status: 503, json: async () => ({}) }
        : okJson({ vulns: [{ id: 'GHSA-x', affected: [] }] }),
    () =>
      osv([
        { name: 'express', ecosystem: 'npm', pinned: '4.18.2' },
        { name: 'requests', ecosystem: 'PyPI', pinned: '2.31.0' },
      ]),
  );

  assert.equal(result.failures.length, 1, 'the failure is reported');
  assert.equal(result.failures[0].name, 'requests');
  assert.match(result.failures[0].error, /503/);
  assert.equal(result.results.length, 2, 'the shape stays index-aligned with the query list');
  assert.deepEqual(result.results[1].vulns, [], 'the failed slot is empty, never absent');
});

test('an empty stack makes no call at all', async () => {
  const { seen, result } = await stubFetch(() => okJson({ vulns: [] }), () => osv([]));
  assert.equal(seen.length, 0);
  assert.deepEqual(result, { results: [], failures: [] });
});
