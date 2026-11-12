// map(), and each/collect(..., crawl=1): sitemaps, the link walk, robots.txt, the guard, the coverage receipt.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createAgentweb, type Runtime } from '../src/index.ts';
import { parseRobots, parseSitemap } from '../src/sitemap/parse.ts';

const hits: string[] = [];
let docs: Server;
let walk: Server;
let docsUrl = '';
let walkUrl = '';
let rt: Runtime;
let strict: Runtime;
let docsPhase = 1;

const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><nav><a href="/">Home</a></nav><main><h1>${title}</h1>${body}</main></body></html>`;
const items = (n: number, extra = 0) => `<ul><li><a href="/p/${n}a">Item ${n}a</a> Price: $${n + extra}0.00</li><li><a href="/p/${n}b">Item ${n}b</a> Price: $${n + extra}5.50</li></ul>`;

before(async () => {
  docs = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push('docs ' + u.pathname);
    const send = (body: string | Buffer, type = 'text/html', status = 200) => res.writeHead(status, { 'content-type': type }).end(body);
    const base = `http://${req.headers.host}`;
    if (u.pathname === '/robots.txt') return send(`User-agent: *\nDisallow: /private/\n\nSitemap: ${base}/sitemap.xml\n`, 'text/plain');
    if (u.pathname === '/sitemap.xml') return send(`<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${base}/sitemap-1.xml</loc></sitemap><sitemap><loc>${base}/sitemap-2.xml.gz</loc></sitemap></sitemapindex>`, 'application/xml');
    if (u.pathname === '/sitemap-1.xml') {
      const g = [1, 2, 3, 4].map((n) => `<url><loc>${base}/docs/guide/${n}</loc></url>`).join('');
      return send(`<?xml version="1.0"?><urlset xmlns="x">${g}<url><loc>${base}/docs/api/1?a=1&amp;b=2</loc></url><url><loc>${base}/private/secret</loc></url><url><loc>http://other.example/x</loc></url><url><loc>${base}/docs/guide/1</loc></url></urlset>`, 'application/xml');
    }
    if (u.pathname === '/sitemap-2.xml.gz') {
      const g = [5, 6].map((n) => `<url><loc>${base}/docs/guide/${n}</loc></url>`).join('');
      return send(gzipSync(`<?xml version="1.0"?><urlset>${g}<url><loc>${base}/docs/api/2</loc></url><url><loc>${base}/docs/api/3</loc></url><url><loc>${base}/blog/x</loc></url></urlset>`), 'application/gzip');
    }
    const m = /^\/docs\/guide\/(\d)$/.exec(u.pathname);
    if (m) return send(page(`Guide ${m[1]}`, items(Number(m[1]), docsPhase === 2 && m[1] === '2' ? 1 : 0)));
    if (u.pathname === '/docs/api/3') return send('gone', 'text/plain', 404);
    if (u.pathname.startsWith('/docs/api/')) return send(page('API ' + u.pathname.slice(10), `<p>The api page. Price: none</p>`));
    if (u.pathname === '/blog/x') return send(page('A post', '<p>words about prices</p>'));
    if (u.pathname === '/') return send(page('Docs home', '<p>welcome</p>'));
    return send(page('Other', '<p>x</p>'));
  });
  walk = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push('walk ' + u.pathname);
    const send = (body: string, type = 'text/html', status = 200) => res.writeHead(status, { 'content-type': type }).end(body);
    if (u.pathname === '/robots.txt') return send('User-agent: *\nDisallow: /private/\nDisallow: /*.pdf$\n', 'text/plain');
    if (u.pathname === '/sitemap.xml') return send('nope', 'text/plain', 404);
    const links: Record<string, string[]> = {
      '/': ['/a', '/b', '/private/x', 'http://elsewhere.example/', '/file.pdf', '/a#frag'],
      '/a': ['/a/1', '/a/2', '/'],
      '/b': ['/', '/b/1'],
      '/a/1': ['/a/1/deep', '/a'],
      '/a/2': [],
      '/b/1': [],
      '/a/1/deep': ['/a/1/deeper'],
    };
    const l = links[u.pathname];
    if (!l) return send('missing', 'text/plain', 404);
    send(page('W ' + u.pathname, `<p>${l.map((h) => `<a href="${h}">link ${h}</a>`).join(' ')}</p>`));
  });
  for (const [s, set] of [[docs, (u: string) => (docsUrl = u)], [walk, (u: string) => (walkUrl = u)]] as const) {
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    set(`http://127.0.0.1:${(s.address() as AddressInfo).port}`);
  }
  const env = { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_USAGE_LOG: '' };
  rt = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, cache: false, env });
  strict = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, cache: false, env: { ...env, AGENTWEB_ALLOW_PRIVATE: '0' } });
});

after(async () => {
  await rt.close();
  await strict.close();
  for (const s of [docs, walk]) await new Promise<void>((r) => s.close(() => r()));
});

let n = 0;
const sid = () => `m${++n}`;
const json = (text: string, key = '{"schema"') => JSON.parse(text.slice(text.indexOf(key)));

describe('robots.txt and sitemap parsing', () => {
  it('robots: the group for us, longest rule wins, wildcards and $, sitemaps', () => {
    const r = parseRobots(`User-agent: *\nDisallow: /a/\nAllow: /a/ok/\nDisallow: /*.pdf$\nDisallow: /tmp*x\n\nUser-agent: otherbot\nDisallow: /\n\nSitemap: https://e.example/s.xml # trailing\n`);
    assert.deepEqual(r.sitemaps, ['https://e.example/s.xml']);
    assert.ok(!r.allows('/a/x'));
    assert.ok(r.allows('/a/ok/x')); // longer Allow beats shorter Disallow
    assert.ok(r.allows('/b'));
    assert.ok(!r.allows('/doc/file.pdf'));
    assert.ok(r.allows('/doc/file.pdfx'));
    assert.ok(!r.allows('/tmpfoox'));
    const mine = parseRobots('User-agent: agentweb\nDisallow: /me/\nUser-agent: *\nDisallow: /\n');
    assert.ok(mine.allows('/other') && !mine.allows('/me/x')); // a group that names us replaces *
    assert.ok(parseRobots('User-agent: *\nDisallow:\n').allows('/anything')); // empty Disallow allows all
    assert.ok(parseRobots('').allows('/x'));
  });

  it('sitemaps: index, urlset, entities, CDATA, plain lists; nothing else', () => {
    assert.deepEqual(parseSitemap('<sitemapindex><sitemap><loc>https://a.example/1.xml</loc></sitemap></sitemapindex>'), { kind: 'index', locs: ['https://a.example/1.xml'] });
    assert.deepEqual(parseSitemap('<urlset><url><loc> https://a.example/x?a=1&amp;b=2 </loc></url><url><loc><![CDATA[https://a.example/y]]></loc></url><url><loc>ftp://nope</loc></url></urlset>'), { kind: 'urls', locs: ['https://a.example/x?a=1&b=2', 'https://a.example/y'] });
    assert.deepEqual(parseSitemap('https://a.example/1\nhttps://a.example/2\n'), { kind: 'urls', locs: ['https://a.example/1', 'https://a.example/2'] });
    assert.equal(parseSitemap('<html><body>not a sitemap</body></html>'), undefined);
  });
});

describe('map()', () => {
  it('reads robots.txt sitemaps through an index and a .gz file; counts, tree, URLs; drops robots-disallowed and other-origin URLs', async () => {
    const r = await rt.run(sid(), `map('${docsUrl}')`, { budget: 3000 });
    assert.ok(r.ok, r.text);
    assert.match(r.text, new RegExp(`^map of ${docsUrl.replace(/[.:/]/g, '\\$&')}: 10 URLs from sitemap \\(3 files\\)\\n`));
    assert.match(r.text, /\n\/docs\/ 9\n/);
    assert.match(r.text, /\n {2}\/docs\/guide\/ 6\n/);
    assert.match(r.text, /\n {2}\/docs\/api\/ 3\n/);
    assert.match(r.text, /\n\/blog\/ 1\n/);
    assert.match(r.text, /\/docs\/api\/1\?a=1&b=2/);
    assert.doesNotMatch(r.text, /private\/secret|other\.example/);
    assert.match(r.text, /left out: robots 1, other_origin 1/);
    assert.doesNotMatch(r.text, /not everything/);
  });

  it('match filters; max keeps the first N and says how many were found', async () => {
    const m = await rt.run(sid(), `map('${docsUrl}', match='/docs/api/')`);
    assert.match(m.text, /: 3 URLs from sitemap .*, matching '\/docs\/api\/'/);
    assert.doesNotMatch(m.text, /guide/);
    const wild = await rt.run(sid(), `map('${docsUrl}', match='/guide/*')`);
    assert.match(wild.text, /: 6 URLs/);
    const cap = await rt.run(sid(), `map('${docsUrl}', max=3)`);
    assert.match(cap.text, /: 10 URLs from sitemap/);
    assert.match(cap.text, /not everything/);
    assert.match(cap.text, /note: 10 URLs found, the first 3 kept \(raise max to keep more\)/);
    assert.match(cap.text, /first 3:\n\/docs\/guide\/1\n\/docs\/guide\/2\n\/docs\/guide\/3\n/);
  });

  it('map() with no argument maps the current site', async () => {
    const s = sid();
    const r = await rt.run(s, `open('${docsUrl}/docs/guide/1'); map()`);
    assert.ok(r.ok, r.text);
    assert.match(r.text, /: 10 URLs from sitemap/);
    const none = await rt.run(sid(), 'map()');
    assert.equal(none.ok, false);
    assert.match(none.text, /map needs a site/);
  });

  it('with no sitemap it walks same-origin links breadth-first: depth, cycles, robots, fragments, other origins', async () => {
    hits.length = 0;
    const d1 = await rt.run(sid(), `map('${walkUrl}', depth=1)`, { budget: 3000 });
    assert.ok(d1.ok, d1.text);
    assert.match(d1.text, /from links \(3 pages read\)/); // '/', '/a', '/b'
    assert.match(d1.text, /: 6 URLs /); // / /a /b and their links /a/1 /a/2 /b/1; the pdf and /private/ are robots-disallowed
    assert.ok(!hits.includes('walk /private/x'), 'a robots-disallowed page is never fetched');
    assert.ok(!hits.includes('walk /file.pdf'));
    assert.match(d1.text, /left out: .*robots 2.*other_origin 1/);
    assert.match(d1.text, /not everything/);
    assert.match(d1.text, /note: \d+ found URLs were not opened \(depth 1; raise depth\)/);
    const d3 = await rt.run(sid(), `map('${walkUrl}', depth=4)`, { budget: 3000 });
    assert.match(d3.text, /: 7 URLs /); // + /a/1/deep; its link /a/1/deeper is a 404 and is dropped
    assert.match(d3.text, /left out: .*http_error 1/);
    assert.doesNotMatch(d3.text, /not everything/);
    // the cycle / <-> /a did not refetch pages
    assert.equal(hits.filter((h) => h === 'walk /a').length, 2); // once per map call
  });

  it('a fetch cap stops the walk and says so', async () => {
    const r = await rt.run(sid(), `map('${walkUrl}', depth=4, fetches=3)`);
    assert.match(r.text, /not everything/);
    assert.match(r.text, /note: stopped at 3 fetches/);
    assert.match(r.text, /left out: .*fetch_cap/);
  });

  it('the guard decides: a refused address is an error, not an empty map', async () => {
    const r = await strict.run(sid(), `map('${docsUrl}')`);
    assert.equal(r.ok, false);
    assert.match(r.text, /guard refused every request/);
  });
});

describe('each(..., crawl=1)', () => {
  it('visits the saved map instead of the links on the page, with a coverage receipt', async () => {
    const s = sid();
    const noMap = await rt.run(s, "each('guide', crawl=1)");
    assert.equal(noMap.ok, false);
    assert.match(noMap.text, /no saved map in this session/);
    assert.match(noMap.text, /map\('site\.example', save=1\)/);

    const saved = await rt.run(s, `map('${docsUrl}', save=1)`);
    assert.match(saved.text, /note: saved 10 URLs: each\('words', crawl=1\)/);
    const r = await rt.run(s, "each('guide', find='Item 3a', crawl=1, n=4)", { budget: 3000 });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /^4 of 6 mapped pages, lines matching 'Item 3a':/);
    assert.match(r.text, /## \/docs\/guide\/3 Guide 3\n.*Item 3a/);
    const cov = json(r.text, '{"coverage"').coverage;
    assert.deepEqual({ ...cov, mapComplete: undefined }, { complete: false, scope: 'saved map', visited: 4, total: 6, mapped: 10, mapComplete: undefined, skipped: { limit: 2 } });
    assert.equal(cov.mapComplete, true);

    const all = await rt.run(s, "each('guide', crawl=1, n=10)", { budget: 4000 });
    const c2 = json(all.text, '{"coverage"').coverage;
    assert.equal(c2.complete, true);
    assert.equal(c2.visited, 6);
    assert.equal(c2.total, 6);
    assert.deepEqual(c2.skipped, {});

    // a page that is an error is a skipped URL with a reason, and the receipt is not complete
    const withApi = await rt.run(s, "each('api', crawl=1)", { budget: 3000 });
    const c3 = json(withApi.text, '{"coverage"').coverage;
    assert.deepEqual({ visited: c3.visited, total: c3.total, skipped: c3.skipped, complete: c3.complete }, { visited: 2, total: 3, skipped: { http_error: 1 }, complete: false });
    assert.match(withApi.text, /✗ HTTP 404/);

    const none = await rt.run(s, "each('zzz', crawl=1)");
    assert.match(none.text, /no mapped URL matches 'zzz' \(10 in the saved map\)/);
  });

  it('from=\'map\' is the same as crawl=1; without it each() still reads the current page', async () => {
    const s = sid();
    await rt.run(s, `map('${docsUrl}', save=1, match='/guide/')`);
    const r = await rt.run(s, "each('', from='map', n=2)");
    assert.match(r.text, /^2 of 6 mapped pages/);
    const plain = await rt.run(s, `open('${docsUrl}/'); each('Home')`);
    assert.ok(plain.ok, plain.text);
    assert.doesNotMatch(plain.text, /mapped pages/);
  });
});

describe('collect(..., crawl=1)', () => {
  it('collects over the saved map; one merged result with a receipt', async () => {
    const s = sid();
    await rt.run(s, `map('${docsUrl}', save=1, match='/guide/')`);
    const r = await rt.run(s, "collect(name='link', price='money', crawl=1)", { budget: 8000 });
    assert.ok(r.ok, r.text);
    const d = json(r.text);
    assert.equal(d.rows.length, 12); // 6 pages x 2 items
    assert.deepEqual(d.rows.slice(0, 2).map((x: any) => x.values.price), [10, 15.5]);
    assert.equal(d.rows[0].source.url, `${docsUrl}/docs/guide/1`);
    assert.equal(d.coverage.scope, 'saved map');
    assert.equal(d.coverage.visited, 6);
    assert.equal(d.coverage.total, 6);
    assert.deepEqual(d.coverage.skipped, {});
    assert.equal(d.coverage.complete, true);
    assert.equal(d.coverage.stop, 'end');
  });

  it('max caps the visits: not complete, the rest counted as skipped (limit)', async () => {
    const s = sid();
    await rt.run(s, `map('${docsUrl}', save=1, match='/guide/')`);
    const d = json((await rt.run(s, "collect(name='link', price='money', crawl=1, max=2)", { budget: 8000 })).text);
    assert.equal(d.rows.length, 4);
    assert.equal(d.coverage.visited, 2);
    assert.equal(d.coverage.total, 6);
    assert.deepEqual(d.coverage.skipped, { limit: 4 });
    assert.equal(d.coverage.complete, false);
    assert.equal(d.coverage.stop, 'url_limit');
  });

  it('error pages are skipped with a reason; other pages still count; pages without records are not failures', async () => {
    const s = sid();
    await rt.run(s, `map('${docsUrl}', save=1, match='/docs/')`);
    const d = json((await rt.run(s, "collect(name='link', price='money', crawl=1, max=20)", { budget: 9000 })).text);
    assert.equal(d.coverage.total, 9);
    assert.equal(d.coverage.visited, 8); // api/3 is a 404
    assert.deepEqual(d.coverage.skipped, { http_error: 1 });
    assert.equal(d.coverage.complete, false);
    assert.equal(d.rows.length, 12);
  });

  it('diff works over the whole crawl: created, then compared', async () => {
    const s = sid();
    docsPhase = 1;
    await rt.run(s, `map('${docsUrl}', save=1, match='/guide/')`);
    const q = "collect(name='link', price='money', href='url', crawl=1, diff='cat', key='href')";
    const first = json((await rt.run(s, q, { budget: 9000 })).text);
    assert.equal(first.changes.status, 'created');
    docsPhase = 2;
    const second = json((await rt.run(s, q, { budget: 9000 })).text);
    docsPhase = 1;
    assert.equal(second.changes.status, 'compared');
    assert.equal(second.changes.updated.length, 2); // guide 2's two prices changed
  });

  it('a field error is the ordinary collect error', async () => {
    const s = sid();
    await rt.run(s, `map('${docsUrl}', save=1, match='/guide/')`);
    const r = await rt.run(s, "collect(price='dollars', crawl=1)");
    assert.equal(r.ok, false);
    assert.match(r.text, /invalid collection field 'price'/);
  });
});
