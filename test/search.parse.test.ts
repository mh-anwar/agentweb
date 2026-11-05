// Parser tests against real responses saved from each provider (trimmed of scripts/styles).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml } from '../src/parse.ts';
import type { SearchResult } from '../src/types.ts';
import { bing, bingHtml, brave, ddg, ddgLite, github, hackerNews, mwmbl, seznam, stackExchange, wikipedia, yahoo } from '../src/search/index.ts';
import { botWall, parseBingHtml, parseBraveHtml, parseDdgHtml, parseDdgLite, parseRss, parseSeznam, parseYahoo } from '../src/search/providers/web.ts';
import { seSite } from '../src/search/providers/vertical.ts';
import { fixture, replay } from './search.helpers.ts';

const doc = (f: string) => parseHtml(fixture(f));

function wellFormed(rs: SearchResult[], source: string, min: number) {
  assert.ok(rs.length >= min, `${source}: expected ≥${min} results, got ${rs.length}`);
  const urls = new Set<string>();
  for (const r of rs) {
    assert.equal(r.source, source);
    assert.match(r.url, /^https?:\/\/[^/]+/, `${source}: bad url ${r.url}`);
    assert.doesNotMatch(r.url, /duckduckgo\.com\/l\/|bing\.com\/ck\/|r\.search\.yahoo\.com|[?&]utm_/, `${source}: wrapper or tracking left in ${r.url}`);
    assert.ok(r.title.length > 0 && r.title.length <= 201, `${source}: title "${r.title}"`);
    assert.doesNotMatch(r.title + r.snippet, /<\/?[a-z]+[ >]|&amp;|&#\d+;|&quot;/i, `${source}: markup left in "${r.title}" / "${r.snippet}"`);
    assert.ok(!urls.has(r.url), `${source}: duplicate ${r.url}`);
    urls.add(r.url);
  }
}

test('ddg html: results, real destinations, snippets', () => {
  const rs = parseDdgHtml(doc('ddg.html'), 20);
  wellFormed(rs, 'ddg', 10);
  assert.equal(rs[0].title, 'The Async Ecosystem - Asynchronous Programming in Rust');
  assert.equal(rs[0].url, 'https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html');
  assert.match(rs[0].snippet, /^Learn about async runtimes, libraries/);
  assert.equal(parseDdgHtml(doc('ddg.html'), 3).length, 3);
});

test('ddg html: wrapped links and ads', () => {
  const html = `<div class="results">
    <div class="result results_links result--ad"><h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x.com">Ad</a></h2></div>
    <div class="result results_links"><h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Futm_source%3Dddg&amp;rut=1">Example &amp; Co</a></h2>
      <a class="result__snippet" href="#">An <b>example</b> snippet.</a></div></div>`;
  const rs = parseDdgHtml(parseHtml(html), 10);
  assert.deepEqual(rs, [{ title: 'Example & Co', url: 'https://example.com/page', snippet: 'An example snippet.', source: 'ddg' }]);
});

test('ddg lite: rows pair links with their snippets', () => {
  const rs = parseDdgLite(doc('ddg-lite.html'), 20);
  wellFormed(rs, 'ddg-lite', 10);
  assert.equal(rs[1].url, 'https://doc.rust-lang.org/stable/book/ch17-00-async-await.html');
  assert.match(rs[1].snippet, /^Running async code in Rust usually happens concurrently/);
});

test('ddg: a 202 challenge is reported as a rate limit, not an empty result', async () => {
  assert.match(botWall(doc('ddg-challenge.html')) ?? '', /challenge/);
  for (const p of [ddg(), ddgLite()]) {
    await assert.rejects(p.search('x', { n: 10, fetch: replay('ddg-challenge.html', 'text/html', { status: 202 }) }), (e: any) => e.name === 'AwError' && e.code === 'blocked' && /bot challenge/.test(e.message));
    // even if an engine reports 200, the page itself gives the challenge away
    await assert.rejects(p.search('x', { n: 10, fetch: replay('ddg-challenge.html', 'text/html') }), /bot challenge/);
  }
});

test('ddg posts the form the endpoint expects', async () => {
  const f = replay('ddg.html', 'text/html');
  await ddg().search('rust async runtime', { n: 5, fetch: f });
  assert.equal(f.reqs[0].method, 'POST');
  assert.equal(f.reqs[0].contentType, 'application/x-www-form-urlencoded');
  assert.match(String(f.reqs[0].body), /^q=rust\+async\+runtime&/);
});

test('bing rss: clean URLs straight from <link>', async () => {
  const rs = parseRss(fixture('bing.rss'), 20, 'bing');
  wellFormed(rs, 'bing', 10);
  assert.equal(rs[1].url, 'https://github.com/smol-rs/smol');
  const f = replay('bing.rss', 'text/xml');
  const viaProvider = await bing().search('rust async runtime', { n: 4, fetch: f });
  assert.equal(viaProvider.length, 4);
  assert.match(f.reqs[0].url, /format=rss/);
  // CDATA and entity-encoded markup inside descriptions
  const cdata = '<rss version="2.0"><channel><item><title>A &amp; B</title><link>https://example.com/x?utm_source=bing</link><description><![CDATA[<b>bold</b> text]]></description></item></channel></rss>';
  assert.deepEqual(parseRss(cdata, 5, 'bing'), [{ title: 'A & B', url: 'https://example.com/x', snippet: 'bold text', source: 'bing' }]);
});

test('bing: HTML where RSS was expected is an error, a captcha a rate limit', async () => {
  await assert.rejects(bing().search('x', { n: 5, fetch: replay('ddg.html', 'text/html') }), /expected RSS/);
  await assert.rejects(bing().search('x', { n: 5, fetch: replay('mojeek-captcha.html', 'text/html') }), (e: any) => e.code === 'blocked');
});

test('bing html: ck/a wrappers decoded', async () => {
  const rs = parseBingHtml(doc('bing.html'), 20);
  wellFormed(rs, 'bing-html', 10);
  assert.equal(rs[0].url, 'https://rust.facepunch.com');
  assert.match(rs[0].snippet, /^The only aim in Rust is to survive/);
  assert.equal((await bingHtml().search('x', { n: 2, fetch: replay('bing.html', 'text/html') })).length, 2);
});

test('brave html: web snippets only, titles from the title node', async () => {
  const rs = parseBraveHtml(doc('brave.html'), 30);
  wellFormed(rs, 'brave', 15);
  assert.equal(rs[1].title, 'The State of Async Rust: Runtimes | corrode Rust Consulting');
  assert.equal(rs[1].url, 'https://corrode.dev/blog/async/');
  assert.ok(rs.every((r) => !/brave\.com/.test(r.url)));
  assert.ok(rs.filter((r) => r.snippet).length >= 15);
  assert.equal((await brave().search('x', { n: 5, fetch: replay('brave.html', 'text/html') })).length, 5);
});

test('yahoo: RU= wrappers decoded, breadcrumbs and dates kept out of titles and snippets', async () => {
  const rs = parseYahoo(doc('yahoo.html'), 20);
  wellFormed(rs, 'yahoo', 6);
  assert.equal(rs[0].title, 'The Async Ecosystem - Asynchronous Programming in Rust');
  assert.equal(rs[1].url, 'https://github.com/smol-rs/smol');
  assert.ok(rs.every((r) => !/›|^\w{3} \d{1,2}, \d{4}/.test(r.title + ' ' + r.snippet)), JSON.stringify(rs.map((r) => r.snippet.slice(0, 30))));
  assert.equal((await yahoo().search('x', { n: 3, fetch: replay('yahoo.html', 'text/html') })).length, 3);
});

test('seznam: structural parse (hashed class names), own links and spelling hints skipped', async () => {
  const rs = parseSeznam(doc('seznam.html'), 20);
  wellFormed(rs, 'seznam', 10);
  assert.equal(rs[0].title, 'Write-Ahead Logging');
  assert.equal(rs[0].url, 'https://www.sqlite.org/wal.html');
  assert.match(rs[0].snippet, /^The persistence of WAL mode/);
  assert.ok(rs.every((r) => !/seznam\.cz/.test(r.url) && !/^sqlite\.org\/wal/.test(r.snippet)));
  assert.equal((await seznam().search('x', { n: 4, fetch: replay('seznam.html', 'text/html') })).length, 4);
});

test('mwmbl: title/extract fragments joined', async () => {
  const rs = await mwmbl().search('x', { n: 10, fetch: replay('mwmbl.json', 'application/json') });
  wellFormed(rs, 'mwmbl', 10);
  assert.equal(rs[0].title, 'GitHub - notgull/unsend: Thread-unsafe async runtime');
});

test('wikipedia: article URLs and searchmatch markup stripped', async () => {
  const f = replay('wikipedia.json', 'application/json');
  const rs = await wikipedia().search('brothers karamazov', { n: 10, fetch: f });
  wellFormed(rs, 'wikipedia', 10);
  assert.equal(rs[0].url, 'https://en.wikipedia.org/wiki/The_Brothers_Karamazov');
  assert.equal(rs[1].url, 'https://en.wikipedia.org/wiki/The_Brothers_Karamazov_(1958_film)');
  assert.match(f.reqs[0].url, /^https:\/\/en\.wikipedia\.org\/w\/api\.php\?.*srsearch=brothers%20karamazov/);
  assert.equal((await wikipedia({ lang: 'de' }).search('x', { n: 1, fetch: f }))[0].url, 'https://de.wikipedia.org/wiki/The_Brothers_Karamazov');
});

test('hackernews: story URL, points and thread in the snippet', async () => {
  const rs = await hackerNews().search('sqlite', { n: 10, fetch: replay('hackernews.json', 'application/json') });
  wellFormed(rs, 'hackernews', 10);
  assert.equal(rs[0].url, 'https://phiresky.github.io/blog/2021/hosting-sqlite-databases-on-github-pages/');
  assert.match(rs[0].snippet, /^1812 points, 244 comments, 2021-05-02 · HN thread: item\?id=27016630$/);
  // Ask HN style story without URL → the discussion page
  const { parseHackerNews } = await import('../src/search/providers/vertical.ts');
  const ask = parseHackerNews({ hits: [{ objectID: '1', title: 'Ask HN: x?', url: null, story_text: '<p>Body &amp; more</p>', points: 3, num_comments: 1, created_at_i: 0 }] }, 5);
  assert.equal(ask[0].url, 'https://news.ycombinator.com/item?id=1');
  assert.match(ask[0].snippet, /^Body & more · 3 points, 1 comments, 1970-01-01$/);
});

test('github: repositories with stars, language, freshness', async () => {
  const f = replay('github.json', 'application/json');
  const rs = await github({ token: 'T' }).search('rust async runtime', { n: 10, fetch: f });
  wellFormed(rs, 'github', 10);
  assert.equal(rs[0].title, 'monoio-rs/monoio');
  assert.match(rs[0].snippet, /^Rust async runtime based on io-uring\. · ★5\.1k, Rust, updated 2026-10-16$/);
  assert.equal(f.reqs[0].headers?.authorization, 'Bearer T');
  // unauthenticated rate limit → RateLimited with a hint
  const limited = replay('github.json', 'application/json', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30) } });
  await assert.rejects(github({ token: '' }).search('x', { n: 5, fetch: limited }), (e: any) => e.code === 'blocked' && /GITHUB_TOKEN/.test(e.message) && e.retryAfterSec <= 31);
});

test('stackexchange: excerpts, question links, site: routing', async () => {
  const f = replay('stackexchange.json', 'application/json');
  const rs = await stackExchange().search('python dataclass default factory', { n: 10, fetch: f });
  wellFormed(rs, 'stackexchange', 10);
  assert.equal(rs[0].url, 'https://stackoverflow.com/q/61257658');
  assert.match(rs[0].snippet, /\(score 8, 1 answers, answered\) \[python, unit-testing, patch, python-dataclasses\]$/);
  assert.match(f.reqs[0].url, /site=stackoverflow&q=python%20dataclass%20default%20factory$/);
  await stackExchange().search('site:askubuntu.com wifi drops', { n: 3, fetch: f });
  assert.match(f.reqs[1].url, /site=askubuntu&q=wifi%20drops$/);
  assert.equal(seSite('unix.stackexchange.com'), 'unix');
  assert.equal(seSite('example.com'), undefined);
  // throttle errors come back as JSON with an error_id
  const { parseStackExchange } = await import('../src/search/providers/vertical.ts');
  assert.throws(() => parseStackExchange({ error_id: 502, error_message: 'too many requests from this IP' }, 5), (e: any) => e.code === 'blocked');
});

test('bot walls are recognised; normal result pages are not', () => {
  assert.equal(botWall(doc('mojeek-captcha.html')), 'Captcha');
  for (const f of ['ddg.html', 'ddg-lite.html', 'bing.html', 'brave.html', 'yahoo.html', 'seznam.html']) assert.equal(botWall(doc(f)), undefined, f);
});

test('HTTP statuses are classified', async () => {
  const p = brave();
  await assert.rejects(p.search('x', { n: 5, fetch: replay('brave.html', 'text/html', { status: 429, headers: { 'retry-after': '17' } }) }), (e: any) => e.code === 'blocked' && e.retryAfterSec === 17);
  await assert.rejects(p.search('x', { n: 5, fetch: replay('brave.html', 'text/html', { status: 403 }) }), (e: any) => e.code === 'blocked' && !('retryAfterSec' in e && e.retryAfterSec));
  await assert.rejects(p.search('x', { n: 5, fetch: replay('brave.html', 'text/html', { status: 503 }) }), (e: any) => e.code === 'net');
  await assert.rejects(wikipedia().search('x', { n: 5, fetch: replay('ddg.html', 'text/plain') }), /not JSON/);
});

test('a JSON body mislabelled text/html still parses (when it carries no markup)', async () => {
  const rs = await github().search('x', { n: 3, fetch: replay('github.json', 'text/html') });
  assert.equal(rs.length, 3);
});
