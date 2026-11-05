// Orchestration with fake providers: fusion, de-duplication, fallback, timeouts, cool-downs,
// vertical routing. No network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Fetcher, SearchResult } from '../src/types.ts';
import { AwError } from '../src/types.ts';
import { fuse, intents, parseQuery, RateLimited, search, SearchState, type Provider } from '../src/search/index.ts';

const noFetch: Fetcher = async () => {
  throw new Error('fake providers must not fetch');
};
const r = (url: string, title = url, snippet = ''): SearchResult => ({ title, url, snippet, source: '' });

interface FakeOpts extends Partial<Provider> {
  results?: string[] | ((q: string) => string[]);
  delay?: number;
  fail?: Error;
}
function fake(name: string, o: FakeOpts = {}): Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name, kind: 'web', rank: 10, siteOp: true, ...o,
    calls,
    available: o.available ?? (() => true),
    async search(q, { n }) {
      calls.push(q);
      if (o.delay) await new Promise((res) => setTimeout(res, o.delay));
      if (o.fail) throw o.fail;
      const list = typeof o.results === 'function' ? o.results(q) : (o.results ?? []);
      return list.slice(0, n).map((u) => ({ ...r(u, 'T ' + u, 'snippet for ' + u), source: name }));
    },
  };
}
const run = (q: string, providers: Provider[], extra: Record<string, unknown> = {}) =>
  search(q, { fetch: noFetch, providers, state: new SearchState(), verticals: false, ...extra });

test('reciprocal rank fusion rewards agreement and rank', () => {
  const runs = [
    { p: { name: 'a' }, weight: 1, results: [r('https://x.com/1'), r('https://x.com/2'), r('https://x.com/3')] },
    { p: { name: 'b' }, weight: 1, results: [r('https://x.com/3'), r('https://x.com/1'), r('https://x.com/4')] },
  ];
  const out = fuse(runs);
  assert.deepEqual(out.map((x) => x.url), ['https://x.com/1', 'https://x.com/3', 'https://x.com/2', 'https://x.com/4']);
  assert.equal(out[0].source, 'a+b');
  assert.equal(out[2].source, 'a');
  // weight matters: a half-weight vertical's #1 sits below a web #1
  const w = fuse([
    { p: { name: 'web' }, weight: 1, results: [r('https://a.com')] },
    { p: { name: 'wiki' }, weight: 0.5, results: [r('https://b.com')] },
  ]);
  assert.deepEqual(w.map((x) => x.url), ['https://a.com', 'https://b.com']);
});

test('fusion de-duplicates cosmetic URL variants, keeps https and the fuller snippet', () => {
  const out = fuse([
    { p: { name: 'a' }, weight: 1, results: [r('http://www.example.com/docs/', 'Docs', 'short')] },
    { p: { name: 'b' }, weight: 1, results: [r('https://example.com/docs', 'Docs!', 'a considerably longer snippet that tells the agent much more about what the page actually contains')] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://example.com/docs');
  assert.equal(out[0].title, 'Docs');
  assert.match(out[0].snippet, /considerably longer/);
  assert.equal(out[0].source, 'a+b');
});

test('search merges parallel providers and reports who answered', async () => {
  const a = fake('a', { results: ['https://1.com', 'https://2.com'] });
  const b = fake('b', { results: ['https://2.com', 'https://3.com'] });
  const out = await run('rust', [a, b], { n: 10 });
  assert.deepEqual(out.results.map((x) => x.url), ['https://2.com', 'https://1.com', 'https://3.com']);
  assert.deepEqual(out.used, ['a', 'b']);
  assert.deepEqual(out.failed, []);
  assert.equal((await run('rust', [a, b], { n: 1 })).results.length, 1);
});

test('only `width` web providers start; a failure starts the next one', async () => {
  const a = fake('a', { rank: 1, fail: new AwError('net', 'a: connection reset') });
  const b = fake('b', { rank: 2, results: ['https://b.com'] });
  const c = fake('c', { rank: 3, results: ['https://c.com'] });
  const d = fake('d', { rank: 4, results: ['https://d.com'] });
  const out = await run('q', [d, c, b, a], { width: 2 });
  assert.deepEqual(out.used, ['b', 'c']);
  assert.equal(d.calls.length, 0, 'd never needed');
  assert.deepEqual(out.failed, [{ name: 'a', why: 'a: connection reset' }]);
});

test('a provider with no results also triggers the fallback', async () => {
  const a = fake('a', { rank: 1, results: [] });
  const b = fake('b', { rank: 2, results: ['https://b.com'] });
  const out = await run('q', [a, b], { width: 1 });
  assert.deepEqual(out.used, ['b']);
  assert.deepEqual(out.failed, [{ name: 'a', why: 'no results' }]);
});

test('per-provider timeout: slow providers are cut off and replaced', async () => {
  const slow = fake('slow', { rank: 1, delay: 400, results: ['https://slow.com'] });
  const fast = fake('fast', { rank: 2, results: ['https://fast.com'] });
  const t0 = Date.now();
  const out = await run('q', [slow, fast], { width: 1, timeoutMs: 80, graceMs: 50 });
  assert.ok(Date.now() - t0 < 300, 'did not wait for the slow provider');
  assert.deepEqual(out.used, ['fast']);
  assert.match(out.failed[0].why, /^slow: timed out after 80 ms$/);
});

test('grace period: once one provider answers, stragglers get a bounded wait', async () => {
  const quick = fake('quick', { results: ['https://q.com'] });
  const lagging = fake('lagging', { delay: 300, results: ['https://l.com'] });
  const t0 = Date.now();
  const out = await run('q', [quick, lagging], { graceMs: 40, timeoutMs: 2000 });
  assert.ok(Date.now() - t0 < 200);
  assert.deepEqual(out.used, ['quick']);
  assert.equal(out.failed[0].name, 'lagging');
  assert.match(out.failed[0].why, /timed out .*others answered first/);
});

test('the overall deadline bounds the whole fallback chain', async () => {
  const ps = [1, 2, 3, 4].map((i) => fake('p' + i, { rank: i, delay: 60, fail: new AwError('net', `p${i} down`) }));
  const t0 = Date.now();
  const out = await run('q', ps, { width: 1, deadlineMs: 150, timeoutMs: 1000 });
  const ms = Date.now() - t0;
  assert.ok(ms < 260, `took ${ms}`);
  assert.equal(out.results.length, 0);
  assert.ok(out.failed.length >= 2 && out.failed.length < 4, JSON.stringify(out.failed));
});

test('rate limits cool the whole family down across searches', async () => {
  const state = new SearchState();
  const html = fake('ddg', { rank: 1, family: 'ddg', fail: new RateLimited('ddg: bot challenge (HTTP 202)') });
  const lite = fake('ddg-lite', { rank: 2, family: 'ddg', results: ['https://lite.com'] });
  const other = fake('other', { rank: 3, results: ['https://o.com'] });
  const first = await search('q', { fetch: noFetch, providers: [html, lite, other], state, width: 1, verticals: false });
  // after ddg is rate-limited the fallback skips its sibling and goes to a different backend
  assert.deepEqual(first.used, ['other']);
  assert.equal(lite.calls.length, 0);
  assert.ok(first.failed.some((f) => f.name === 'ddg' && /bot challenge/.test(f.why)));
  assert.ok(state.coolingFor('ddg') > 0);
  const second = await search('q', { fetch: noFetch, providers: [html, lite, other], state, width: 1, verticals: false });
  assert.equal(html.calls.length, 1, 'not retried while cooling down');
  assert.deepEqual(second.used, ['other']);
  assert.ok(second.failed.some((f) => f.name === 'ddg' && /cooling down \d+s/.test(f.why)));
  // retry-after is honoured, and back-off grows with repeated strikes
  const s = new SearchState();
  s.strike('x', 7);
  assert.equal(s.coolingFor('x'), 7);
  s.strike('y');
  const one = s.coolingFor('y');
  s.strike('y');
  assert.ok(s.coolingFor('y') > one);
  s.ok('y');
  assert.equal(s.coolingFor('y'), 0);
});

test('never an empty list silently', async () => {
  const out = await run('q', [fake('a', { fail: new AwError('blocked', 'a: refused (HTTP 403)') }), fake('b', { results: [] })]);
  assert.deepEqual(out.results, []);
  assert.deepEqual(out.failed.map((f) => f.name).sort(), ['a', 'b']);
  const none = await run('q', [fake('k', { available: () => false })]);
  assert.deepEqual(none.failed, [{ name: 'search', why: 'no search providers available' }]);
  await assert.rejects(run('   ', [fake('a')]), (e: any) => e.code === 'bad_request');
});

test('a provider that throws synchronously or returns junk is contained', async () => {
  const sync: Provider = { name: 'sync', available: () => true, search: () => { throw new Error('boom'); } };
  const junk: Provider = { name: 'junk', available: () => true, search: async () => null as unknown as SearchResult[] };
  const throwsAvail: Provider = { name: 'avail', available: () => { throw new Error('x'); }, search: async () => [] };
  const ok = fake('ok', { rank: 200, results: ['https://ok.com'] });
  const out = await run('q', [sync, junk, throwsAvail, ok], { width: 3 });
  assert.deepEqual(out.used, ['ok']);
  assert.deepEqual(out.failed, [{ name: 'sync', why: 'boom' }, { name: 'junk', why: 'no results' }]);
});

test('plain SearchProviders keep the caller order', async () => {
  const mk = (name: string): Provider => ({ name, available: () => true, search: async () => [{ title: name, url: `https://${name}.com`, snippet: '', source: name }] });
  const out = await run('q', [mk('z'), mk('y'), mk('x')], { width: 2 });
  assert.deepEqual(out.used, ['z', 'y']);
});

test('site: goes to engines verbatim, is post-filtered, and routes to the matching vertical', async () => {
  const web = fake('web', { siteOp: true, results: ['https://github.com/a/b', 'https://other.com/x', 'https://gist.github.com/z'] });
  const noSite = fake('nosite', { siteOp: false, results: ['https://github.com/c/d', 'https://spam.com'] });
  const gh = fake('github', { kind: 'code', domains: ['github.com'], siteOp: false, results: ['https://github.com/tokio-rs/tokio'] });
  const wiki = fake('wikipedia', { kind: 'wiki', domains: ['wikipedia.org'], results: ['https://en.wikipedia.org/wiki/X'] });
  const out = await search('async runtime site:github.com', { fetch: noFetch, providers: [web, noSite, gh, wiki], state: new SearchState() });
  assert.deepEqual(web.calls, ['async runtime site:github.com']);
  assert.deepEqual(noSite.calls, ['async runtime']);
  assert.deepEqual(gh.calls, ['async runtime']);
  assert.equal(wiki.calls.length, 0, 'unrelated vertical not queried for a site: search');
  assert.ok(out.results.every((x) => /github\.com/.test(x.url)), JSON.stringify(out.results));
  // site:-routed vertical is boosted to the top
  assert.equal(out.results[0].url, 'https://github.com/tokio-rs/tokio');
  const ex = await search('x -site:other.com', { fetch: noFetch, providers: [web], state: new SearchState(), verticals: false });
  assert.ok(!ex.results.some((x) => x.url.includes('other.com')));
  const off = await search('x site:nowhere.org', { fetch: noFetch, providers: [web], state: new SearchState(), verticals: false });
  assert.equal(off.results.length, 0);
  assert.match(off.failed[0].why, /all 3 results were outside site:nowhere\.org/);
});

test('verticals join by intent with lower weight, and can be forced or disabled', async () => {
  const web = fake('web', { results: ['https://a.com', 'https://b.com'] });
  const so = fake('stackexchange', { kind: 'qa', results: ['https://stackoverflow.com/q/1'] });
  const wiki = fake('wikipedia', { kind: 'wiki', results: ['https://en.wikipedia.org/wiki/Tokio'] });
  const out = await search('python TypeError: unhashable type dict', { fetch: noFetch, providers: [web, so, wiki], state: new SearchState() });
  assert.deepEqual(out.used, ['web', 'stackexchange']);
  assert.equal(out.results[0].url, 'https://a.com');
  assert.equal(wiki.calls.length, 0);
  const forced = await search('anything', { fetch: noFetch, providers: [web, so, wiki], state: new SearchState(), verticals: ['wiki'] });
  assert.deepEqual(forced.used, ['web', 'wikipedia']);
  const off = await search('python TypeError', { fetch: noFetch, providers: [web, so], state: new SearchState(), verticals: false });
  assert.deepEqual(off.used, ['web']);
});

test('intent detection', () => {
  const cases: [string, string[]][] = [
    ['python TypeError: unhashable type dict', ['qa']],
    ['how to reverse a list in javascript', ['qa']],
    ['tokio::spawn vs std::thread', ['qa']],
    ['rust async runtime library', ['code']],
    ['open source alternative to notion github', ['code']],
    ['hacker news', ['news']],
    ['openai announces new model', ['news']],
    ['latest linux kernel release', ['news']],
    ['who was Ada Lovelace', ['wiki']],
    ['who wrote the brothers karamazov', ['wiki']],
    ['Brothers Karamazov', ['wiki']],
    ['photosynthesis', ['wiki']],
    ['history of the byzantine empire', ['wiki']],
    ['best pizza near me', []],
    ['cheap flights to lisbon in march from toronto', []],
    ['buy running shoes', []],
  ];
  for (const [q, want] of cases) assert.deepEqual(intents(q).sort(), want.sort(), q);
});

test('parseQuery pulls out site operators', () => {
  assert.deepEqual(parseQuery('  tokio  site:github.com -site:gist.github.com spawn '), { raw: 'tokio site:github.com -site:gist.github.com spawn', text: 'tokio spawn', sites: ['github.com'], notSites: ['gist.github.com'] });
  assert.deepEqual(parseQuery('site:https://docs.python.org/3/ asyncio').sites, ['docs.python.org']);
  assert.deepEqual(parseQuery('SITE:Example.COM x').sites, ['example.com']);
});

test('late results after a timeout do not leak or throw', async () => {
  const late = fake('late', { delay: 100, fail: new Error('after the fact') });
  const ok = fake('ok', { results: ['https://ok.com'] });
  const out = await run('q', [late, ok], { timeoutMs: 20, graceMs: 0 });
  assert.deepEqual(out.used, ['ok']);
  await new Promise((res) => setTimeout(res, 150)); // an unhandled rejection would fail the run
});
