import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBody, readFeed, readXml } from '../src/readers/index.ts';
import { acts, fixture, lines } from './fixtures/readers/helpers.ts';

test('RSS 2.0: title, description, one row per item with HTML stripped from summaries', async () => {
  const out = await readBody({ url: 'https://blog.example.com/feed.xml', contentType: 'application/rss+xml', text: fixture('rss.xml') });
  assert.equal(out.kind, 'feed');
  assert.equal(out.title, 'The Example Engineering Blog');
  assert.deepEqual(out.notes, ['RSS 2.0 feed, 3 items']);
  const ls = lines(out);
  assert.equal(ls[0], 'The Example Engineering Blog');
  assert.equal(ls[1], 'Notes on building & running distributed systems · /');
  assert.equal(ls[2], 'date | title | summary');
  assert.equal(ls[3], '2026-11-04 | How we cut p99 latency by 40% | Our checkout service had a long tail problem. Here is how connection pooling, request hedging and a smaller GC heap fixed it.');
  assert.equal(ls[5], '2026-09-17 | Why we moved off cron | scheduled jobs now run as durable workflows with retries.', 'summary repeating the title is trimmed');
  const as = acts(out);
  assert.ok(as.some((a) => a.l === 'How we cut p99 latency by 40%' && a.href === 'https://blog.example.com/2026/11/p99-latency'));
  assert.ok(as.some((a) => a.l === 'Why we moved off cron' && a.href === 'https://blog.example.com/2026/09/cron'), 'permalink guid used when there is no <link>');
  assert.ok(out.blocks.slice(2).every((b) => b.k === 'row' && b.g === out.blocks[2].g));
});

test('Atom: html titles and content, relative links against xml:base', () => {
  const out = readFeed({ url: 'https://releases.example.org/atom.xml', contentType: 'application/atom+xml', text: fixture('atom.xml') });
  const ls = lines(out);
  assert.equal(out.title, 'widget releases');
  assert.equal(ls[3], '2026-11-01 | v2.4.0 stable | New --watch flag; Faster startup');
  assert.equal(ls[4], '2026-10-02 | v2.3.1 | Fixes a crash when the config file is empty.');
  assert.ok(acts(out).some((a) => a.href === 'https://releases.example.org/v2.4.0'));
});

test('JSON Feed: detected from the body, times shown when items share a day, untitled items use their text', async () => {
  const out = await readBody({ url: 'https://links.example.net/feed.json', contentType: 'application/json', text: fixture('feed.json') });
  assert.equal(out.kind, 'feed');
  assert.deepEqual(out.notes, ['JSON Feed, 3 items']);
  const ls = lines(out);
  assert.equal(ls[3], '2026-11-05 07:00 | A field guide to HTTP caching | Everything about Cache-Control, ETags and stale-while-revalidate.');
  assert.equal(ls[5], '2026-11-04 21:00 | A short note without a title about the new CSS anchor positioning spec. |');
});

test('RSS 1.0 (RDF) and a feed with no items', () => {
  const rdf = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://x.example/"><title>RDF news</title><link>https://x.example/</link><description>d</description></channel>
  <item rdf:about="https://x.example/a"><title>First</title><link>https://x.example/a</link><dc:date>2026-01-02T03:04:05Z</dc:date><description>Hello &lt;b&gt;world&lt;/b&gt;</description></item></rdf:RDF>`;
  const out = readFeed({ url: 'https://x.example/rss', contentType: 'application/rdf+xml', text: rdf });
  assert.deepEqual(lines(out).slice(-1), ['2026-01-02 | First | Hello world']);
  const empty = readFeed({ url: 'https://x.example/rss', contentType: 'application/rss+xml', text: '<rss version="2.0"><channel><title>Quiet</title></channel></rss>' });
  assert.deepEqual(lines(empty), ['Quiet', '(no items)']);
});

test('sitemap and sitemap index become lists of links', async () => {
  const out = await readBody({ url: 'https://shop.example.com/sitemap.xml', contentType: 'application/xml', text: fixture('sitemap.xml') });
  assert.deepEqual(lines(out), ['Sitemap (4 URLs)', '/ 2026-11-01', '/products/trail-runner-3 2026-10-28', '/products/rain-shell 2026-10-20', '/about?ref=footer&lang=en']);
  assert.equal(acts(out)[3].href, 'https://shop.example.com/about?ref=footer&lang=en');
  const idx = await readBody({ url: 'https://shop.example.com/sitemap.xml', contentType: 'text/xml', text: fixture('sitemap-index.xml') });
  assert.deepEqual(lines(idx), ['Sitemap index (2 sitemaps)', '/sitemap-products-1.xml 2026-11-01', '/sitemap-pages.xml']);
});

test('record-shaped XML goes through the JSON writer: repeated elements become a table', () => {
  const xml = `<?xml version="1.0"?><catalog xmlns:x="urn:x"><name>Spring</name><book id="bk101"><author>Gambardella, Matthew</author><title>XML Developer's Guide</title><price>44.95</price></book><book id="bk102"><author>Ralls, Kim</author><title>Midnight Rain</title><price>5.95</price></book><book id="bk103"><author>Corets, Eva</author><title>Maeve Ascendant</title><price>5.95</price></book></catalog>`;
  const out = readXml({ url: 'https://x.example/books.xml', contentType: 'application/xml', text: xml });
  const ls = lines(out);
  assert.equal(ls[0], 'catalog');
  assert.ok(ls.includes('name: Spring'));
  assert.ok(ls.includes('@id | author | title | price'));
  assert.ok(ls.includes("bk101 | Gambardella, Matthew | XML Developer's Guide | 44.95"));
});

test('document-shaped XML becomes an indented outline with text', () => {
  const xml = `<article><title>On XML</title><para>Text with <emphasis>inline</emphasis> markup and <link href="https://x.example">a link</link>.</para><section><title>Part two</title><para>More <b>mixed</b> content here.</para></section></article>`;
  const out = readXml({ url: 'https://x.example/doc.xml', contentType: 'application/xml', text: xml });
  const ls = lines(out);
  assert.equal(out.title, 'On XML');
  assert.ok(ls.includes('para: Text with markup and .'));
  assert.ok(ls.includes('link [href=https://x.example]: a link'));
  const sec = out.blocks.find((b) => b.i[0] === 'title: Part two')!;
  assert.equal(sec.lv, 3);
});
