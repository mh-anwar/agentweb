// Bot walls and search: the Google Programmable Search provider, the 15-minute cool-down of a
// walled provider, and what open() does when a search engine walls the address.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../src/runtime.ts';
import { createJar, encodeForm } from '../src/net/index.ts';
import { createGuard, defaultPolicy } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';
import { readBody, mineEmbedded } from '../src/readers/index.ts';
import { parseHtml } from '../src/parse.ts';
import { defaultProviders, googleCse, search, SearchState, toBlocks, type Provider } from '../src/search/index.ts';
import { ddg } from '../src/search/providers/web.ts';
import { searchEngineQuery } from '../src/runtime.ts';
import { AwError, type Engine, type Fetcher, type Loaded, type NavRequest, type SearchResult, type SessionCtx } from '../src/types.ts';
import { toLoaded } from './search.helpers.ts';

const json = (body: unknown, status = 200): Fetcher & { reqs: NavRequest[] } => {
  const reqs: NavRequest[] = [];
  const f = (async (req: NavRequest) => (reqs.push(req), toLoaded(req, req.url, status, 'application/json', JSON.stringify(body), {}, 1))) as Fetcher & { reqs: NavRequest[] };
  f.reqs = reqs;
  return f;
};

describe('google-cse provider', () => {
  it('needs both the key and the engine id', () => {
    const old = { k: process.env.AGENTWEB_GOOGLE_CSE_KEY, c: process.env.AGENTWEB_GOOGLE_CSE_CX };
    try {
      delete process.env.AGENTWEB_GOOGLE_CSE_KEY;
      delete process.env.AGENTWEB_GOOGLE_CSE_CX;
      const on = () => defaultProviders().some((p) => p.name === 'google-cse' && p.available());
      assert.equal(on(), false);
      process.env.AGENTWEB_GOOGLE_CSE_KEY = 'k';
      assert.equal(on(), false);
      process.env.AGENTWEB_GOOGLE_CSE_CX = 'cx';
      assert.equal(on(), true);
    } finally {
      for (const [k, v] of [['AGENTWEB_GOOGLE_CSE_KEY', old.k], ['AGENTWEB_GOOGLE_CSE_CX', old.c]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('request and parse', async () => {
    const f = json({ items: [{ title: 'Tokio <b>runtime</b>', link: 'https://tokio.rs/', snippet: 'An async runtime' }] });
    const rs = await googleCse({ key: 'K', cx: 'C' }).search('tokio', { n: 25, fetch: f });
    assert.deepEqual(rs, [{ title: 'Tokio runtime', url: 'https://tokio.rs', snippet: 'An async runtime', source: 'google-cse' }]);
    assert.match(f.reqs[0].url, /^https:\/\/www\.googleapis\.com\/customsearch\/v1\?key=K&cx=C&q=tokio&num=10$/);
    assert.deepEqual(await googleCse({ key: 'K', cx: 'C' }).search('x', { n: 5, fetch: json({ searchInformation: {} }) }), []);
  });

  it('quota and key errors are classified', async () => {
    const p = googleCse({ key: 'K', cx: 'C' });
    await assert.rejects(p.search('x', { n: 5, fetch: json({}, 429) }), (e: any) => e.code === 'blocked' && /quota|rate/.test(e.message));
    await assert.rejects(p.search('x', { n: 5, fetch: json({ error: { errors: [{ reason: 'dailyLimitExceeded' }], message: 'Quota exceeded' } }, 403) }), (e: any) => e.code === 'blocked' && /quota/.test(e.message) && e.retryAfterSec === 3600);
    await assert.rejects(p.search('x', { n: 5, fetch: json({ error: { message: 'API key not valid' } }, 403) }), /API key rejected/);
  });
});

describe('walled providers are skipped for about 15 minutes', () => {
  const html = (title: string, body = '') => (req: NavRequest) => toLoaded(req, req.url, 200, 'text/html', `<html><head><title>${title}</title></head><body>${body}</body></html>`, {}, 1);

  it('a 202 anomaly page from ddg cools it down', async () => {
    const state = new SearchState();
    const f: Fetcher = async (req) => ({ ...toLoaded(req, req.url, 202, 'text/html', '<html><body><form action="//duckduckgo.com/anomaly.js"></form></body></html>', {}, 1) });
    const other: Provider = { name: 'other', kind: 'web', rank: 20, available: () => true, search: async () => [{ title: 't', url: 'https://o.com', snippet: '', source: 'other' }] };
    const out = await search('walls', { fetch: f, providers: [ddg(), other], state, width: 1, verticals: false });
    assert.deepEqual(out.used, ['other']);
    const left = state.coolingFor('ddg');
    assert.ok(left > 14 * 60 && left <= 15 * 60, `cooling ${left}s`);
    const again = await search('walls', { fetch: f, providers: [ddg(), other], state, width: 1, verticals: false });
    assert.ok(again.failed.some((x) => x.name === 'ddg' && /cooling down/.test(x.why)));
  });

  it('a captcha page and a bare 429 do too', async () => {
    const mk = (fetch: Fetcher) => search('walls', { fetch, providers: [ddg()], state: (s = new SearchState()), width: 1, verticals: false }).then(() => s.coolingFor('ddg'));
    let s = new SearchState();
    assert.ok((await mk(async (req) => html('Please solve this CAPTCHA')(req))) > 14 * 60);
    s = new SearchState();
    assert.ok((await mk(async (req) => toLoaded(req, req.url, 429, 'text/html', '<html><body>slow down</body></html>', {}, 1))) > 14 * 60);
  });
});

describe('open() on a walled search engine', () => {
  it('recognises search URLs', () => {
    assert.deepEqual(searchEngineQuery(new URL('https://www.google.com/search?q=hello+world&hl=en')), { engine: 'google', q: 'hello world' });
    assert.deepEqual(searchEngineQuery(new URL('https://www.bing.com/search?q=x')), { engine: 'bing', q: 'x' });
    assert.deepEqual(searchEngineQuery(new URL('https://duckduckgo.com/?q=x&ia=web')), { engine: 'duckduckgo', q: 'x' });
    assert.equal(searchEngineQuery(new URL('https://example.com/search?q=x')), undefined);
    assert.equal(searchEngineQuery(new URL('https://www.google.com/maps?q=x')), undefined);
  });

  const wire = (): Engine => ({
    tier: 'wire',
    async available() {
      return true;
    },
    async open(_ctx: SessionCtx, req: NavRequest): Promise<Loaded> {
      const walled = /google\.com\/search/.test(req.url);
      const html = walled
        ? '<html><head><title>Sorry</title></head><body><p>Our systems have detected unusual traffic from your computer network.</p></body></html>'
        : '<html><head><title>Fine</title></head><body><h1>Fine page</h1></body></html>';
      return { url: req.url, status: walled ? 429 : 200, method: 'GET', contentType: 'text/html', doc: parseHtml(html), bytes: html.length, ms: 1 };
    },
    async release() {},
    async close() {},
  });
  const runtime = (results: SearchResult[] | Error) =>
    createRuntime({
      store: new MemoryStore(),
      engines: { wire: wire() },
      createJar, createGuard: (state: unknown) => createGuard(defaultPolicy('local'), state), encodeForm, readBody, mineEmbedded,
      search: async () => {
        if (results instanceof Error) throw results;
        return { results, used: ['bing'], failed: [] };
      },
      searchBlocks: (rs, q) => toBlocks(rs, q),
    });

  it('answers with search() results and says so', async () => {
    const rt = runtime([{ title: 'Hello world program', url: 'https://example.org/hello', snippet: 'The classic', source: 'bing' }]);
    const r = await rt.run('w1', "open('https://www.google.com/search?q=hello+world')");
    assert.equal(r.ok, true, r.text);
    assert.match(r.text, /google is walling this address/);
    assert.match(r.text, /Hello world program/);
    assert.equal(r.stats.url, 'search:hello world');
    // back() does not return to the wall
    await rt.run('w1', "open('https://example.com/')");
    const back = await rt.run('w1', 'back()');
    assert.equal(back.stats.url, 'search:hello world');
    await rt.close();
  });

  it('says plainly what happened when search() has nothing either', async () => {
    const rt = runtime(new AwError('internal', 'no providers'));
    const r = await rt.run('w2', "open('https://www.google.com/search?q=hello')");
    assert.equal(r.ok, false);
    assert.match(r.text, /google is walling this address/);
    assert.match(r.text, /search\('hello'\)/);
    await rt.close();
  });

  it('leaves ordinary pages alone', async () => {
    const rt = runtime([]);
    const r = await rt.run('w3', "open('https://example.com/')");
    assert.equal(r.ok, true);
    assert.match(r.text, /Fine page/);
    await rt.close();
  });
});
