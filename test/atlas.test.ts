import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/index.ts';
import { createAtlas, searchTemplate, feedLinks, bestTier, merge } from '../src/atlas/index.ts';
import type { FormDef } from '../src/types.ts';

const O = 'https://shop.example';
const load = (tier: 'wire' | 'ghost' | 'chrome', ok: boolean) => ({ type: 'load' as const, origin: O, url: `${O}/`, tier, ok, shell: !ok, ms: 5 });

test('unknown origin has no hint', async () => {
  const a = createAtlas(new MemoryStore(), { flushEveryMs: 0 });
  assert.equal(await a.site(O), undefined);
  assert.equal(await a.site('file:///etc/passwd'), undefined);
});

test('learns that a site needs scripts after wire shells, and shares it through the store', async () => {
  const store = new MemoryStore();
  const a = createAtlas(store, { flushEveryMs: 0 });
  for (let i = 0; i < 3; i++) {
    a.observe(load('wire', false));
    a.observe(load('ghost', true));
  }
  // visible to the same worker before flushing
  assert.equal((await a.site(O))?.tier, 'ghost');
  await a.flush();
  const b = createAtlas(store, { flushEveryMs: 0 });
  const info = await b.site(`${O}/some/path?x=1`);
  assert.equal(info?.tier, 'ghost');
  assert.ok((info?.tierConf ?? 0) >= 0.6, `conf ${info?.tierConf}`);
});

test('one success is not enough confidence to skip the cheap tier', async () => {
  const a = createAtlas(new MemoryStore(), { flushEveryMs: 0 });
  a.observe(load('wire', false));
  a.observe(load('ghost', true));
  const info = await a.site(O);
  assert.equal(info?.tier, 'ghost');
  assert.ok((info?.tierConf ?? 1) < 0.6);
});

test('cheapest working tier wins', () => {
  assert.equal(bestTier({ wire: { ok: 5, fail: 0 }, chrome: { ok: 9, fail: 0 } })?.tier, 'wire');
  assert.equal(bestTier({ wire: { ok: 1, fail: 4 }, chrome: { ok: 9, fail: 0 } })?.tier, 'chrome');
  assert.equal(bestTier({ wire: { ok: 0, fail: 4 } }), undefined);
});

test('counts decay so a changed site is re-learned', () => {
  let rec = merge(undefined, O, { tiers: { wire: { ok: 0, fail: 40 } } }, 1, 0.5, 40);
  rec = merge(rec, O, { tiers: { wire: { ok: 10, fail: 0 } } }, 2, 0.5, 40);
  assert.deepEqual(rec.tiers.wire, { ok: 5, fail: 20 });
});

test('merges concurrent workers through the store', async () => {
  const store = new MemoryStore();
  const a = createAtlas(store, { flushEveryMs: 0, readTtlMs: 0 });
  const b = createAtlas(store, { flushEveryMs: 0, readTtlMs: 0 });
  a.observe(load('wire', true));
  await a.flush();
  b.observe(load('wire', true));
  b.observe(load('wire', true));
  await b.flush();
  const rec = await store.get<{ tiers: { wire: { ok: number } } }>('atlas', O);
  assert.equal(rec?.tiers.wire.ok, 3);
});

const form = (action: string, fields: FormDef['fields'], method: 'GET' | 'POST' = 'GET'): FormDef => ({ key: 'k', action, method, enctype: '', fields });

test('search template from a GET query form, hidden fields kept', () => {
  const t = searchTemplate(
    [
      form(`${O}/login`, [{ name: 'user', type: 'text', value: '' }, { name: 'pw', type: 'password', value: '' }], 'POST'),
      form(`${O}/search?old=1`, [{ name: 'cat', type: 'hidden', value: 'all' }, { name: 'q', type: 'search', value: '' }, { name: '', type: 'submit', value: 'Go' }]),
    ],
    O,
  );
  assert.equal(t, `${O}/search?cat=all&q={q}`);
});

test('no search template from logins, other origins, or ambiguous forms', () => {
  assert.equal(searchTemplate([form(`${O}/login`, [{ name: 'user', type: 'text', value: '' }, { name: 'pw', type: 'password', value: '' }])], O), undefined);
  assert.equal(searchTemplate([form('https://evil.example/s', [{ name: 'q', type: 'search', value: '' }])], O), undefined);
  assert.equal(searchTemplate([form(`${O}/x`, [{ name: 'a', type: 'text', value: '' }, { name: 'b', type: 'text', value: '' }])], O), undefined);
  assert.equal(searchTemplate([form(`${O}/subscribe`, [{ name: 'name', type: 'text', value: '' }])], O), undefined);
});

test('feeds: same-origin alternate links only', () => {
  const f = feedLinks(
    [
      { rel: 'alternate', href: '/feed.xml', type: 'application/rss+xml' },
      { rel: 'alternate', href: 'https://other.example/a.xml', type: 'application/atom+xml' },
      { rel: 'alternate', href: '/fr', type: 'text/html' },
      { rel: 'stylesheet', href: '/s.css', type: 'text/css' },
    ],
    `${O}/blog/`,
    O,
  );
  assert.deepEqual(f, [`${O}/feed.xml`]);
});

test('observe never throws and close flushes', async () => {
  const store = new MemoryStore();
  const a = createAtlas(store, { flushEveryMs: 10 });
  a.observe({ type: 'forms', origin: 'not a url', url: '', forms: [] });
  a.observe(null as never);
  a.observe({ type: 'meta', origin: O, url: `${O}/`, links: [], markdown: true });
  await a.close();
  assert.equal((await createAtlas(store, { flushEveryMs: 0 }).site(O))?.md, true);
});
