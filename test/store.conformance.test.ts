// One conformance suite run against every Store implementation.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '../src/types.ts';
import { AwError } from '../src/types.ts';
import { MemoryStore, FileStore, SqliteStore, RedisStore, TieredStore, openStore } from '../src/store/index.ts';
import { FakeRedis } from '../src/store/fake-redis.ts';
import { sampleRecord } from '../src/store/sample.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Impl {
  name: string;
  make(): Promise<Store>;
  cleanup?(): Promise<void>;
}

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'aw-store-')); dirs.push(d); return d; };
let redis: FakeRedis;

const impls: Impl[] = [
  { name: 'memory', make: async () => new MemoryStore() },
  { name: 'file', make: async () => new FileStore(tmp(), { gzipAbove: 512 }) },
  { name: 'sqlite', make: async () => new SqliteStore(join(tmp(), 'aw.db'), { gzipAbove: 512 }) },
  { name: 'sqlite :memory:', make: async () => new SqliteStore(':memory:') },
  {
    name: 'redis (fake server)',
    make: async () => {
      const s = new RedisStore(redis.url, { prefix: `t${Math.random().toString(36).slice(2)}:`, gzipAbove: 512 });
      await s.client.waitReady();
      return s;
    },
  },
  { name: 'tiered over sqlite', make: async () => new TieredStore(new SqliteStore(join(tmp(), 't.db')), { l1TtlMs: 30 }) },
  { name: 'tiered over file (via openStore)', make: async () => openStore(`tiered+file:${tmp()}?l1TtlMs=30`) },
];

before(async () => {
  redis = new FakeRedis();
  await redis.listen(0);
});

after(async () => {
  await redis.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const AWKWARD_KEYS = [
  '', ' ', '.', '..', '../../etc/passwd', '/', 'a/b\\c', 'a\u0000b', 'CON', 'nul.txt', 'Key', 'key', 'KEY',
  'ÆØÅ', '日本語のキー', '😀🎉', 'é', 'é', '%2F', '=41', '^a', '*?[]\\', 'line\nbreak', '\t', 'x'.repeat(2048),
  'https://example.com/a?b=c&d=e#f', 'k'.repeat(150) + '😀'.repeat(40),
];

for (const impl of impls) {
  describe(`Store conformance: ${impl.name}`, () => {
    let s: Store;
    before(async () => { s = await impl.make(); });
    after(async () => { await s.close(); });

    it('get of a missing key is undefined', async () => {
      assert.equal(await s.get('ns', 'nope'), undefined);
    });

    it('round-trips every JSON value type', async () => {
      const values: unknown[] = [{ a: 1, b: [true, null, 'x'] }, [1, 2, 3], 'text', '', 0, -1.5, 1e300, false, true, null,
        { deep: { er: { est: ['ünïcødé', '😀', ' '] } } }];
      for (let i = 0; i < values.length; i++) await s.set('types', `k${i}`, values[i]);
      for (let i = 0; i < values.length; i++) assert.deepEqual(await s.get('types', `k${i}`), values[i], `value ${i}`);
    });

    it('overwrites and deletes', async () => {
      await s.set('ow', 'k', { v: 1 });
      await s.set('ow', 'k', { v: 2 });
      assert.deepEqual(await s.get('ow', 'k'), { v: 2 });
      await s.del('ow', 'k');
      assert.equal(await s.get('ow', 'k'), undefined);
      await s.del('ow', 'k'); // deleting a missing key is fine
      await s.del('never-used-ns', 'k');
    });

    it('keeps namespaces apart', async () => {
      await s.set('a:b', 'c', 1);
      await s.set('a', 'b:c', 2);
      await s.set('a', 'b', 3);
      await s.set('A', 'b', 4);
      await s.set('', '', 5);
      await s.set('a1', ':b', 6);
      await s.set('a', '1:b', 7);
      assert.equal(await s.get('a:b', 'c'), 1);
      assert.equal(await s.get('a', 'b:c'), 2);
      assert.equal(await s.get('a', 'b'), 3);
      assert.equal(await s.get('A', 'b'), 4);
      assert.equal(await s.get('', ''), 5);
      assert.equal(await s.get('a1', ':b'), 6);
      assert.equal(await s.get('a', '1:b'), 7);
      assert.deepEqual((await s.keys('a')).sort(), ['1:b', 'b', 'b:c']);
      assert.deepEqual(await s.keys('A'), ['b']);
    });

    it('expires values after their TTL', async () => {
      await s.set('ttl', 'short', 'x', 0.05);
      await s.set('ttl', 'long', 'y', 60);
      await s.set('ttl', 'cleared', 'z', 0.05);
      await s.set('ttl', 'cleared', 'z2'); // an overwrite without ttl removes the expiry
      assert.equal(await s.get('ttl', 'short'), 'x');
      await sleep(120);
      assert.equal(await s.get('ttl', 'short'), undefined);
      assert.equal(await s.get('ttl', 'long'), 'y');
      assert.equal(await s.get('ttl', 'cleared'), 'z2');
      await s.set('ttl', 'short2', 'x', 0.05);
      await sleep(120);
      assert.deepEqual((await s.keys('ttl')).sort(), ['cleared', 'long']);
    });

    it('stores large realistic values (2 MB) and incompressible ones', async () => {
      const big = sampleRecord(2_000_000, 7);
      await s.set('big', 'rec', big);
      assert.deepEqual(await s.get('big', 'rec'), big);
      let noise = '';
      for (let i = 0; i < 300_000; i++) noise += String.fromCharCode(33 + Math.floor(Math.random() * 90));
      await s.set('big', 'noise', { noise });
      assert.equal((await s.get<{ noise: string }>('big', 'noise'))!.noise, noise);
    });

    it('handles unicode and awkward keys without collisions', async () => {
      for (let i = 0; i < AWKWARD_KEYS.length; i++) await s.set('awk', AWKWARD_KEYS[i], i);
      for (let i = 0; i < AWKWARD_KEYS.length; i++) assert.equal(await s.get('awk', AWKWARD_KEYS[i]), i, JSON.stringify(AWKWARD_KEYS[i]).slice(0, 40));
      assert.deepEqual((await s.keys('awk', undefined, Infinity)).sort(), [...AWKWARD_KEYS].sort());
      // awkward namespaces too
      for (const ns of ['..', '/', 'ns/with/slashes', '日本', '*']) {
        await s.set(ns, 'k', ns);
        assert.equal(await s.get(ns, 'k'), ns);
      }
    });

    it('lists keys by prefix with a limit', async () => {
      for (const k of ['user:1', 'user:2', 'user:10', 'username', 'other', 'use', 'u*er:x', 'user:日本']) await s.set('ks', k, k);
      await s.set('ks2', 'user:99', 1);
      assert.deepEqual((await s.keys('ks', 'user:')).sort(), ['user:1', 'user:10', 'user:2', 'user:日本']);
      assert.deepEqual((await s.keys('ks', 'user')).sort(), ['user:1', 'user:10', 'user:2', 'user:日本', 'username']);
      assert.deepEqual((await s.keys('ks', 'u*')).sort(), ['u*er:x']); // glob characters are literal
      assert.deepEqual((await s.keys('ks')).length, 8);
      const two = await s.keys('ks', 'user:', 2);
      assert.equal(two.length, 2);
      for (const k of two) assert.ok(k.startsWith('user:'));
      assert.deepEqual(await s.keys('ks', 'user:', 0), []);
      assert.deepEqual(await s.keys('ks', 'zzz'), []);
      assert.deepEqual(await s.keys('no-such-ns'), []);
    });

    it('defines behaviour for non-JSON input', async () => {
      await s.set('nj', 'k', 'present');
      await s.set('nj', 'k', undefined); // undefined deletes
      assert.equal(await s.get('nj', 'k'), undefined);
      await s.set('nj', 'shape', { a: undefined, b: NaN, c: new Date(0), d: [undefined] });
      assert.deepEqual(await s.get('nj', 'shape'), { b: null, c: '1970-01-01T00:00:00.000Z', d: [null] });
      const cyc: Record<string, unknown> = {};
      cyc.self = cyc;
      for (const bad of [10n, () => 1, Symbol('x'), cyc, { n: 1n }]) {
        await assert.rejects(s.set('nj', 'bad', bad), (e: unknown) => e instanceof AwError && e.code === 'bad_request');
      }
      await assert.rejects(s.set('nj', 'k', 1, -1), (e: unknown) => e instanceof AwError && e.code === 'bad_request');
      await assert.rejects(s.set('nj', '\ud800', 1), (e: unknown) => e instanceof AwError && e.code === 'bad_request');
      await assert.rejects(s.get('nj', 'x'.repeat(5000)), (e: unknown) => e instanceof AwError && e.code === 'too_large');
    });

    it('returns copies: callers can mutate freely', async () => {
      const v = { list: [1, 2], o: { x: 1 } };
      await s.set('copy', 'k', v);
      v.list.push(3);
      const a = await s.get<typeof v>('copy', 'k');
      assert.deepEqual(a, { list: [1, 2], o: { x: 1 } });
      a!.o.x = 99;
      assert.deepEqual(await s.get('copy', 'k'), { list: [1, 2], o: { x: 1 } });
    });

    it('survives many concurrent operations', async () => {
      const N = 300;
      await Promise.all(Array.from({ length: N }, (_, i) => s.set('conc', `k${i}`, { i, pad: 'x'.repeat(i * 7) })));
      const got = await Promise.all(Array.from({ length: N }, (_, i) => s.get<{ i: number }>('conc', `k${i}`)));
      got.forEach((g, i) => assert.equal(g!.i, i));
      // racing writes to one key end with one of the written values, intact
      await Promise.all(Array.from({ length: 50 }, (_, i) => s.set('conc', 'race', { i, body: sampleRecord(5000, i) })));
      const last = await s.get<{ i: number; body: unknown }>('conc', 'race');
      assert.deepEqual(last!.body, sampleRecord(5000, last!.i));
    });

    it('reports numeric stats', () => {
      const st = s.stats!();
      for (const k of ['hits', 'misses', 'sets']) assert.equal(typeof st[k], 'number', k);
      assert.ok(st.hits > 0 && st.sets > 0);
      for (const v of Object.values(st)) assert.equal(typeof v, 'number');
    });

    it('rejects every operation after close, and close is idempotent', async () => {
      const t = await impl.make();
      await t.set('c', 'k', 1);
      await t.close();
      await t.close();
      const closed = (e: unknown) => e instanceof AwError && /closed/.test(e.message);
      await assert.rejects(t.get('c', 'k'), closed);
      await assert.rejects(t.set('c', 'k', 1), closed);
      await assert.rejects(t.del('c', 'k'), closed);
      await assert.rejects(t.keys('c'), closed);
    });
  });
}
