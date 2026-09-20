/**
 * Sources.
 *
 * Only the parsing is tested here — the fetchers are network calls, and a test
 * suite that needs the network is a test suite that fails for reasons that have
 * nothing to do with the code.
 *
 * What matters about `parseFeed` is that it is *tolerant*: feeds are the most
 * irregular input in the pipeline, and a feed that fails to parse must degrade
 * one section of the digest rather than fail the run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFeed } from '../lib/sources.mjs';

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
