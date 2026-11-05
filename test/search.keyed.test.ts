// Key-based providers: activation by environment and request/response shapes. No key is
// available on the build machine, so the responses here follow each API's documented shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Fetcher, NavRequest } from '../src/types.ts';
import { braveApi, defaultProviders, searxng, serper, tavily } from '../src/search/index.ts';
import { toLoaded } from './search.helpers.ts';

function jsonFetcher(body: unknown, status = 200): Fetcher & { reqs: NavRequest[] } {
  const reqs: NavRequest[] = [];
  const f = (async (req: NavRequest) => {
    reqs.push(req);
    return toLoaded(req, req.url, status, 'application/json', JSON.stringify(body), {}, 1);
  }) as Fetcher & { reqs: NavRequest[] };
  f.reqs = reqs;
  return f;
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const old: Record<string, string | undefined> = {};
  for (const k in vars) {
    old[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k in old) {
      if (old[k] === undefined) delete process.env[k];
      else process.env[k] = old[k];
    }
  }
}

test('keyed providers switch on with their environment variable only', () => {
  const vars = { BRAVE_API_KEY: undefined, BRAVE_SEARCH_API_KEY: undefined, SEARXNG_URL: undefined, TAVILY_API_KEY: undefined, SERPER_API_KEY: undefined };
  withEnv(vars, () => {
    const on = defaultProviders().filter((p) => p.available()).map((p) => p.name);
    assert.ok(!on.some((n) => ['brave-api', 'searxng', 'tavily', 'serper'].includes(n)), on.join());
    assert.ok(['bing', 'brave', 'ddg', 'yahoo', 'wikipedia', 'github'].every((n) => on.includes(n)));
  });
  withEnv({ ...vars, BRAVE_API_KEY: 'k', SEARXNG_URL: 'http://localhost:8888/', TAVILY_API_KEY: 't', SERPER_API_KEY: 's' }, () => {
    const on = defaultProviders().filter((p) => p.available() && p.kind === 'web').sort((a, b) => a.rank! - b.rank!).map((p) => p.name);
    assert.deepEqual(on.slice(0, 4).sort(), ['brave-api', 'searxng', 'serper', 'tavily']);
  });
  withEnv({ ...vars, BRAVE_API_KEY: '   ' }, () => assert.equal(braveApi().available(), false));
});

test('brave-api request and parse', async () => {
  const f = jsonFetcher({ type: 'search', web: { results: [{ title: 'Tokio <strong>runtime</strong>', url: 'https://tokio.rs/?utm_source=brave', description: 'An <strong>async</strong> runtime', extra_snippets: ['More text'] }] } });
  const rs = await braveApi({ key: 'K' }).search('tokio', { n: 5, fetch: f });
  assert.deepEqual(rs, [{ title: 'Tokio runtime', url: 'https://tokio.rs', snippet: 'An async runtime … More text', source: 'brave-api' }]);
  assert.match(f.reqs[0].url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=tokio&count=5/);
  assert.equal(f.reqs[0].headers?.['x-subscription-token'], 'K');
  await assert.rejects(braveApi({ key: 'K' }).search('x', { n: 5, fetch: jsonFetcher({}, 429) }), (e: any) => e.code === 'blocked' && /quota|rate/.test(e.message));
  await assert.rejects(braveApi({ key: 'K' }).search('x', { n: 5, fetch: jsonFetcher({}, 401) }), /API key rejected/);
});

test('searxng request and parse', async () => {
  const f = jsonFetcher({ query: 'x', results: [{ url: 'https://a.com/', title: 'A', content: 'about a', engine: 'google' }], unresponsive_engines: [] });
  const rs = await searxng({ url: 'https://sx.example/search/' }).search('x y', { n: 5, fetch: f });
  assert.deepEqual(rs, [{ title: 'A', url: 'https://a.com', snippet: 'about a', source: 'searxng' }]);
  assert.equal(f.reqs[0].url, 'https://sx.example/search?q=x%20y&format=json&safesearch=0');
  await assert.rejects(searxng({ url: 'https://sx.example' }).search('x', { n: 5, fetch: jsonFetcher('', 403) }), /JSON output is disabled/);
  await assert.rejects(searxng({ url: 'https://sx.example' }).search('x', { n: 5, fetch: jsonFetcher({ results: [], unresponsive_engines: [['google', 'CAPTCHA']] }) }), /all engines unresponsive \(google: CAPTCHA\)/);
});

test('tavily request and parse', async () => {
  const f = jsonFetcher({ query: 'x', results: [{ title: 'T', url: 'https://t.com/p', content: 'body', score: 0.9 }] });
  const rs = await tavily({ key: 'tv' }).search('x', { n: 3, fetch: f });
  assert.deepEqual(rs, [{ title: 'T', url: 'https://t.com/p', snippet: 'body', source: 'tavily' }]);
  assert.equal(f.reqs[0].method, 'POST');
  assert.equal(f.reqs[0].headers?.authorization, 'Bearer tv');
  assert.deepEqual(JSON.parse(String(f.reqs[0].body)), { query: 'x', max_results: 3, search_depth: 'basic', include_answer: false });
  await assert.rejects(tavily({ key: 'tv' }).search('x', { n: 3, fetch: jsonFetcher({ detail: { error: 'bad' } }, 432) }), /quota/);
});

test('serper request and parse', async () => {
  const f = jsonFetcher({ organic: [{ title: 'S', link: 'https://s.com/a?gclid=1', snippet: 'snip', position: 1 }] });
  const rs = await serper({ key: 'sp' }).search('x', { n: 3, fetch: f });
  assert.deepEqual(rs, [{ title: 'S', url: 'https://s.com/a', snippet: 'snip', source: 'serper' }]);
  assert.equal(f.reqs[0].url, 'https://google.serper.dev/search');
  assert.equal(f.reqs[0].headers?.['x-api-key'], 'sp');
  assert.deepEqual(JSON.parse(String(f.reqs[0].body)), { q: 'x', num: 10 });
});
