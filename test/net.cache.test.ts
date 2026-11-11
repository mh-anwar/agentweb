import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createPageCache, lifetime } from '../src/net/cache.ts';
import { createWireEngine, type WireEngine } from '../src/net/http.ts';
import type { Store } from '../src/types.ts';
import { makeCtx, memStore } from './fixtures/net/helpers.ts';
import { startFixture, type Fixture } from './fixtures/net/server.ts';

let fx: Fixture;
let eng: WireEngine;
let clock = Date.now();
const resolve = async () => [{ address: '127.0.0.1', family: 4 as const }];

before(async () => {
  fx = await startFixture();
});
beforeEach(() => {
  fx.reset();
  clock = Date.now();
  eng = createWireEngine({ resolve, cache: memStore(), cacheOptions: { now: () => clock } });
});
after(async () => {
  await eng.close();
  await fx.close();
});

const read = (path: string, ctx = makeCtx(), headers?: Record<string, string>) => eng.open(ctx, { url: fx.base + path, read: true, headers });

describe('freshness', () => {
  for (const p of ['/c/fresh', '/c/smaxage', '/c/expires', '/c/heuristic']) {
    test(`${p} is served from cache while fresh`, async () => {
      const a = await read(p);
      const b = await read(p);
      assert.equal(a.cached, undefined);
      assert.equal(b.cached, true);
      assert.equal(b.doc!.meta.title, a.doc!.meta.title);
      assert.equal(fx.hit(p), 1);
      assert.ok(Number(b.headers!.age) >= 0);
    });
  }

  test('heuristic TTL expires (default 60 s) and is configurable', async () => {
    await read('/c/heuristic');
    clock += 61_000;
    await read('/c/heuristic');
    assert.equal(fx.hit('/c/heuristic'), 2);
    const e2 = createWireEngine({ resolve, cache: memStore(), cacheOptions: { heuristicTtlSec: 0 } });
    try {
      await e2.open(makeCtx(), { url: fx.base + '/c/heuristic', read: true });
      await e2.open(makeCtx(), { url: fx.base + '/c/heuristic', read: true });
      assert.equal(fx.hit('/c/heuristic'), 4);
    } finally {
      await e2.close();
    }
  });

  test('max-age expiry refetches', async () => {
    await read('/c/fresh');
    clock += 30_000;
    assert.equal((await read('/c/fresh')).cached, true);
    clock += 31_000;
    assert.equal((await read('/c/fresh')).cached, undefined);
    assert.equal(fx.hit('/c/fresh'), 2);
  });

  test('lifetime() precedence: s-maxage > max-age > Expires, Age subtracts', () => {
    const hop = (h: Record<string, string>, status = 200) => ({ url: 'u', status, headers: h, setCookie: [], body: new Uint8Array() });
    assert.equal(lifetime(hop({ 'cache-control': 'max-age=10, s-maxage=99' }), 60, 0), 99);
    assert.equal(lifetime(hop({ 'cache-control': 'max-age=10', expires: 'Thu, 01 Jan 2099 00:00:00 GMT' }), 60, 0), 10);
    assert.equal(lifetime(hop({ 'cache-control': 'max-age=100', age: '30' }), 60, 0), 70);
    assert.equal(lifetime(hop({ expires: 'garbage' }), 60, 0), undefined);
    assert.equal(lifetime(hop({}, 302), 60, 0), undefined, '302 needs explicit freshness');
    assert.equal(lifetime(hop({}, 404), 60, 0), 60);
    assert.equal(lifetime(hop({ 'cache-control': 'no-cache', etag: '"x"' }), 60, 0), 0);
  });
});

describe('never cached', () => {
  for (const p of ['/c/private', '/c/nostore', '/c/setcookie', '/c/vary-cookie']) {
    test(p, async () => {
      await read(p);
      const b = await read(p);
      assert.equal(b.cached, undefined);
      assert.equal(fx.hit(p), 2);
    });
  }

  test('requests that carry cookies bypass the cache', async () => {
    const ctx = makeCtx();
    ctx.jar.setFromHeaders(fx.base + '/', ['sid=1']);
    await read('/c/fresh');
    const b = await read('/c/fresh', ctx);
    assert.equal(b.cached, undefined);
    assert.equal(fx.hit('/c/fresh'), 2);
    assert.equal(fx.last.get('/c/fresh')!.headers.cookie, 'sid=1');
  });

  test('navigations reach the origin even with a fresh cached response; POSTs bypass it', async () => {
    await read('/c/fresh');
    await eng.open(makeCtx(), { url: fx.base + '/c/fresh' });
    await eng.open(makeCtx(), { url: fx.base + '/c/fresh', method: 'POST', body: 'x', read: true });
    assert.equal(fx.hit('/c/fresh'), 3);
  });

  test('Set-Cookie on a response reaches the jar and nothing is shared', async () => {
    const ctx = makeCtx();
    await read('/c/setcookie', ctx);
    assert.equal(ctx.jar.header(fx.base + '/c/x'), 'track=1');
  });
});

describe('revalidation', () => {
  test('ordinary navigation revalidates and reports the 304 while retaining the document', async () => {
    const ctx = makeCtx();
    const a = await eng.open(ctx, { url: fx.base + '/c/etag' });
    const b = await eng.open(ctx, { url: fx.base + '/c/etag' });
    assert.equal(fx.hit('/c/etag'), 2);
    assert.ok(fx.last.get('/c/etag')!.headers['if-none-match']);
    assert.equal(b.doc!.meta.title, a.doc!.meta.title);
    assert.equal(b.status, 200);
    assert.match(b.events!.join(' '), /304 Not Modified/);
  });

  test('overlapping navigations each reach the origin instead of being coalesced', async () => {
    await Promise.all(Array.from({ length: 4 }, () => eng.open(makeCtx(), { url: fx.base + '/c/slow?delay=30' })));
    assert.equal(fx.hit('/c/slow'), 4);
  });

  test('ETag: stale entry is revalidated with If-None-Match and a 304 serves the stored body', async () => {
    const a = await read('/c/etag');
    const b = await read('/c/etag');
    assert.equal(fx.hit('/c/etag'), 2);
    assert.match(fx.last.get('/c/etag')!.headers['if-none-match'] as string, /^"v\d+"$/);
    assert.equal(b.cached, true);
    assert.equal(b.status, 200);
    assert.equal(b.doc!.meta.title, a.doc!.meta.title);
    assert.equal(eng.stats().cache_revalidated, 1);
  });

  test('Last-Modified + no-cache: If-Modified-Since', async () => {
    await read('/c/lastmod');
    const b = await read('/c/lastmod');
    assert.equal(fx.last.get('/c/lastmod')!.headers['if-modified-since'], 'Wed, 21 Oct 2015 07:28:00 GMT');
    assert.equal(b.cached, true);
    assert.equal(b.doc!.meta.title, 'lastmod v1');
  });

  test('changed ETag replaces the entry', async () => {
    await read('/c/etag');
    fx.reset(); // bumps the ETag version
    const b = await read('/c/etag');
    assert.equal(b.cached, undefined);
    assert.equal(fx.hit('/c/etag'), 1);
    assert.equal(fx.last.get('/c/etag')!.headers['if-none-match'] !== undefined, true, 'conditional request was sent');
  });
});

describe('redirects and variants', () => {
  test('a cacheable 301 hop is cached too', async () => {
    await read('/c/redirect');
    const b = await read('/c/redirect');
    assert.equal(b.url, fx.base + '/c/fresh');
    assert.equal(b.cached, true);
    assert.equal(fx.hit('/c/redirect'), 1);
    assert.equal(fx.hit('/c/fresh'), 1);
  });

  test('keyed on the Accept variant', async () => {
    const md = await read('/doc');
    const html = await read('/doc', makeCtx(), { accept: 'text/html' });
    const md2 = await read('/doc');
    assert.equal(md.contentType, 'text/markdown');
    assert.equal(html.contentType, 'text/html');
    assert.equal(md2.contentType, 'text/markdown');
    assert.equal(md2.cached, true);
    assert.equal(fx.hit('/doc'), 2);
  });
});

describe('single-flight', () => {
  test('50 concurrent identical cacheable GETs make one origin request', async () => {
    const rs = await Promise.all(Array.from({ length: 50 }, () => read('/c/slow?delay=100')));
    assert.equal(fx.hit('/c/slow'), 1);
    assert.ok(rs.every((r) => r.status === 200 && r.doc!.meta.title === 'slow v1'));
    const s = eng.stats();
    assert.equal(s.cache_coalesced, 49);
    assert.equal(s.cache_misses, 1);
    assert.ok(s.cache_bytesSaved > 0);
    assert.equal(rs.filter((r) => r.cached).length, 49);
  });

  test('a private leader response is not shared: every waiter fetches its own', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => read('/c/slow-private?delay=50')));
    assert.equal(fx.hit('/c/slow-private'), 10);
    assert.ok(rs.every((r) => !r.cached));
  });

  test('a waiter that aborts does not affect the others; a leader abort lets waiters retry', async () => {
    const ac = new AbortController();
    const leader = eng.open(makeCtx({ signal: ac.signal }), { url: fx.base + '/c/slow?delay=150', read: true });
    await new Promise((r) => setTimeout(r, 20));
    const waiters = Array.from({ length: 5 }, () => read('/c/slow?delay=150'));
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(leader, (e: any) => e.code === 'timeout');
    const rs = await Promise.all(waiters);
    assert.ok(rs.every((r) => r.status === 200));
    assert.equal(fx.hit('/c/slow'), 2, 'the aborted leader plus one retry leader');
  });
});

describe('robustness', () => {
  test('a response becoming private invalidates the old public body, including on 304', async () => {
    for (const status of [200, 304]) {
      const cache = createPageCache(memStore());
      const base = { url: 'http://example.test/', status: 200, headers: { etag: '"v1"', 'cache-control': 'max-age=60' }, setCookie: [], body: new TextEncoder().encode('public') };
      await cache.fetch('key', async () => base);
      await cache.fetch('key', async () => ({ ...base, status, headers: { ...base.headers, 'cache-control': 'private' } }), undefined, true);
      let fetched = false;
      const r = await cache.fetch('key', async () => { fetched = true; return { ...base, body: new TextEncoder().encode('new public') }; });
      assert.ok(fetched, 'old public entry must no longer be reusable');
      assert.equal(new TextDecoder().decode(r.hop.body), 'new public');
    }
  });

  test('a failing store never fails the load', async () => {
    const broken: Store = {
      async get() { throw new Error('down'); },
      async set() { throw new Error('down'); },
      async del() {},
      async keys() { return []; },
      async close() {},
    };
    const e = createWireEngine({ resolve, cache: createPageCache(broken) });
    try {
      const r = await e.open(makeCtx(), { url: fx.base + '/c/fresh', read: true });
      assert.equal(r.status, 200);
    } finally {
      await e.close();
    }
  });

  test('binary bodies round-trip through the store', async () => {
    const a = await read('/sniff/png');
    const store = memStore();
    const e = createWireEngine({ resolve, cache: store, cacheOptions: { heuristicTtlSec: 60 } });
    try {
      const x = await e.open(makeCtx(), { url: fx.base + '/sniff/png', read: true });
      const y = await e.open(makeCtx(), { url: fx.base + '/sniff/png', read: true });
      assert.equal(y.cached, true);
      assert.deepEqual([...y.body!.bytes!], [...x.body!.bytes!]);
      assert.deepEqual([...y.body!.bytes!], [...a.body!.bytes!]);
      const [entry] = [...store.map.values()];
      assert.equal((entry.v as { e: string }).e, 'b');
    } finally {
      await e.close();
    }
  });
});
