import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../src/types.ts';
import { AwError } from '../src/types.ts';
import { MemoryStore, SqliteStore, TieredStore, FileStore, RedisStore, openStore } from '../src/store/index.ts';
import { FakeRedis } from '../src/store/fake-redis.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'aw-tier-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** An L2 wrapper that counts calls and can delay or fail them. */
class Spy implements Store {
  inner = new MemoryStore({ sweepIntervalMs: 0 });
  gets = 0;
  getDelay = 0;
  failSets = false;
  async get<T>(ns: string, key: string) {
    this.gets++;
    const v = await this.inner.get<T>(ns, key);
    if (this.getDelay) await sleep(this.getDelay);
    return v;
  }
  async set<T>(ns: string, key: string, value: T, ttl?: number) {
    if (this.failSets) throw new AwError('net', 'L2 down');
    return this.inner.set(ns, key, value, ttl);
  }
  del(ns: string, key: string) { return this.inner.del(ns, key); }
  keys(ns: string, p?: string, l?: number) { return this.inner.keys(ns, p, l); }
  close() { return this.inner.close(); }
  stats() { return this.inner.stats(); }
}

describe('TieredStore', () => {
  it('reads through: an L2 hit fills L1, the next read never touches L2', async () => {
    const l2 = new Spy();
    await l2.inner.set('n', 'k', { v: 1 });
    const t = new TieredStore(l2, { l1TtlMs: 1000 });
    assert.deepEqual(await t.get('n', 'k'), { v: 1 });
    assert.deepEqual(await t.get('n', 'k'), { v: 1 });
    assert.deepEqual(await t.get('n', 'k'), { v: 1 });
    assert.equal(l2.gets, 1);
    const st = t.stats();
    assert.deepEqual([st.l1Hits, st.l2Hits, st.hits], [2, 1, 3]);
    await t.close();
  });

  it('writes through to L2 and does not keep a value L2 refused', async () => {
    const l2 = new Spy();
    const t = new TieredStore(l2, { l1TtlMs: 10_000 });
    await t.set('n', 'k', 'a');
    assert.equal(await l2.inner.get('n', 'k'), 'a');
    l2.failSets = true;
    await assert.rejects(t.set('n', 'k', 'b'), AwError);
    assert.equal(await t.get('n', 'k'), 'a');
    await t.del('n', 'k');
    assert.equal(await l2.inner.get('n', 'k'), undefined);
    assert.equal(await t.get('n', 'k'), undefined);
    await t.close();
  });

  it('sees another worker’s write within the L1 TTL', async () => {
    const dir = tmp();
    const w1 = new TieredStore(new SqliteStore(join(dir, 'shared.db')), { l1TtlMs: 80 });
    const w2 = new TieredStore(new SqliteStore(join(dir, 'shared.db')), { l1TtlMs: 80 });
    await w1.set('s', 'session', { step: 1 });
    assert.deepEqual(await w2.get('s', 'session'), { step: 1 });
    await w2.set('s', 'session', { step: 2 });
    // w1 may serve its L1 copy briefly, but never longer than l1TtlMs
    await sleep(100);
    assert.deepEqual(await w1.get('s', 'session'), { step: 2 });
    await w1.close();
    await w2.close();
  });

  it('a slow read racing a local write never caches the older value', async () => {
    const l2 = new Spy();
    await l2.inner.set('n', 'k', 'old');
    l2.getDelay = 50;
    const t = new TieredStore(l2, { l1TtlMs: 10_000 });
    const slow = t.get('n', 'k'); // reads "old" from L2, then waits
    await sleep(10);
    await t.set('n', 'k', 'new');
    assert.equal(await slow, 'old');
    l2.getDelay = 0;
    assert.equal(await t.get('n', 'k'), 'new');
    await t.close();
  });

  it('bounds L1 by the value TTL as well as l1TtlMs', async () => {
    const t = new TieredStore(new MemoryStore(), { l1TtlMs: 10_000 });
    await t.set('n', 'k', 1, 0.05);
    await sleep(80);
    assert.equal(await t.get('n', 'k'), undefined);
    await t.close();
  });

  it('caches misses only when asked to', async () => {
    const l2 = new Spy();
    const t = new TieredStore(l2, { negativeTtlMs: 1000 });
    assert.equal(await t.get('n', 'k'), undefined);
    assert.equal(await t.get('n', 'k'), undefined);
    assert.equal(l2.gets, 1);
    await t.set('n', 'k', 1); // a local write replaces the cached miss
    assert.equal(await t.get('n', 'k'), 1);
    await t.close();
  });

  it('skips values too big for L1 but still serves them from L2', async () => {
    const t = new TieredStore(new MemoryStore(), { l1: { maxBytes: 10_000 } });
    await t.set('n', 'big', 'x'.repeat(50_000));
    assert.equal((await t.get<string>('n', 'big'))!.length, 50_000);
    assert.equal(t.stats()['l1.entries'], 0);
    await t.close();
  });
});

describe('openStore', () => {
  it('opens every scheme', async () => {
    const dir = tmp();
    const f = new FakeRedis();
    await f.listen(0);
    const cases: Array<[string, new (...a: never[]) => Store]> = [
      ['memory:', MemoryStore],
      ['memory:?maxBytes=1000&maxEntries=5', MemoryStore],
      [`file:${dir}/f`, FileStore],
      [`file://${dir}/f2`, FileStore],
      [`file:${encodeURI(dir)}/with%20space`, FileStore],
      [`sqlite:${dir}/a.db`, SqliteStore],
      ['sqlite::memory:', SqliteStore],
      [`redis://127.0.0.1:${f.port}/2?prefix=x:`, RedisStore],
      ['tiered+memory:', TieredStore],
      [`tiered+sqlite:${dir}/b.db?l1TtlMs=10`, TieredStore],
    ];
    for (const [url, cls] of cases) {
      const s = await openStore(url);
      assert.ok(s instanceof cls, url);
      await s.set('n', 'k', url);
      assert.equal(await s.get('n', 'k'), url);
      await s.close();
    }
    assert.ok([...f.db(2).keys()].every((k) => k.startsWith('x:')));
    await f.close();
  });

  it('applies URL options and lets explicit options win', async () => {
    const m = await openStore('memory:?maxEntries=2') as MemoryStore;
    assert.equal(m.maxEntries, 2);
    await m.close();
    const n = await openStore('memory:?maxEntries=2', { maxEntries: 9 }) as MemoryStore;
    assert.equal(n.maxEntries, 9);
    await n.close();
  });

  it('rejects unknown or incomplete URLs', async () => {
    for (const url of ['', 'nope:', 'postgres://x', 'file:', 'file://remotehost/x', 'sqlite:']) {
      await assert.rejects(openStore(url), (e: unknown) => e instanceof AwError && e.code === 'bad_request', url);
    }
  });
});
