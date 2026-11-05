import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AwError } from '../src/types.ts';
import { MemoryStore, ENTRY_OVERHEAD } from '../src/store/index.ts';

describe('MemoryStore', () => {
  it('evicts in least-recently-used order', async () => {
    const s = new MemoryStore({ maxEntries: 3, sweepIntervalMs: 0 });
    await s.set('n', 'a', 1);
    await s.set('n', 'b', 2);
    await s.set('n', 'c', 3);
    await s.get('n', 'a'); // a is now most recent: order b, c, a
    await s.set('n', 'd', 4); // evicts b
    assert.equal(await s.get('n', 'b'), undefined);
    assert.deepEqual((await s.keys('n')).sort(), ['a', 'c', 'd']);
    await s.set('n', 'c', 33); // overwrite refreshes c: order a, d, c
    await s.set('n', 'e', 5); // evicts a
    assert.deepEqual((await s.keys('n')).sort(), ['c', 'd', 'e']);
    assert.equal(s.stats().evictions, 2);
    assert.equal(s.stats().entries, 3);
    await s.close();
  });

  it('evicts across namespaces in one global order', async () => {
    const s = new MemoryStore({ maxEntries: 2, sweepIntervalMs: 0 });
    await s.set('x', 'k', 1);
    await s.set('y', 'k', 2);
    await s.set('z', 'k', 3);
    assert.equal(await s.get('x', 'k'), undefined);
    assert.equal(await s.get('y', 'k'), 2);
    await s.close();
  });

  it('never exceeds its byte bound and accounts bytes exactly', async () => {
    const value = 'v'.repeat(2000);
    const per = 'k000'.length + JSON.stringify(value).length + ENTRY_OVERHEAD;
    const s = new MemoryStore({ maxBytes: per * 10, sweepIntervalMs: 0 });
    for (let i = 0; i < 100; i++) {
      await s.set('n', `k${String(i).padStart(3, '0')}`, value);
      assert.ok(s.stats().bytes <= s.maxBytes);
    }
    assert.equal(s.stats().entries, 10);
    assert.equal(s.stats().bytes, per * 10);
    assert.equal(s.stats().evictions, 90);
    // the ten most recent survive
    assert.deepEqual((await s.keys('n')).sort(), Array.from({ length: 10 }, (_, i) => `k0${90 + i}`));
    // overwriting with a smaller value adjusts the total, deleting brings it to zero
    await s.set('n', 'k099', 'small');
    assert.equal(s.stats().bytes, per * 9 + 4 + 7 + ENTRY_OVERHEAD);
    for (const k of await s.keys('n')) await s.del('n', k);
    assert.deepEqual([s.stats().bytes, s.stats().entries], [0, 0]);
    await s.close();
  });

  it('counts non-Latin-1 text at two bytes per char, as V8 stores it', async () => {
    const s = new MemoryStore({ sweepIntervalMs: 0 });
    await s.set('n', 'a', 'é'.repeat(100)); // Latin-1: one byte each
    const one = s.stats().bytes;
    await s.del('n', 'a');
    await s.set('n', 'a', '日'.repeat(100));
    assert.equal(one, 1 + 102 + ENTRY_OVERHEAD);
    assert.equal(s.stats().bytes, 1 + 2 * 102 + ENTRY_OVERHEAD);
    await s.close();
  });

  it('refuses or drops a single value larger than the bound', async () => {
    const strict = new MemoryStore({ maxBytes: 1000, sweepIntervalMs: 0 });
    await strict.set('n', 'k', 'old');
    await assert.rejects(strict.set('n', 'k', 'x'.repeat(2000)), (e: unknown) => e instanceof AwError && e.code === 'too_large');
    assert.equal(await strict.get('n', 'k'), undefined, 'a failed overwrite must not leave the old value');
    const lax = new MemoryStore({ maxBytes: 1000, oversize: 'drop', sweepIntervalMs: 0 });
    await lax.set('n', 'small', 1);
    await lax.set('n', 'k', 'x'.repeat(2000));
    assert.equal(await lax.get('n', 'k'), undefined);
    assert.equal(await lax.get('n', 'small'), 1, 'an oversize value must not flush the cache');
    assert.equal(lax.stats().dropped, 1);
    await strict.close();
    await lax.close();
  });

  it('expires lazily on read and in incremental background sweeps', async () => {
    let now = 1_000_000;
    const s = new MemoryStore({ sweepIntervalMs: 0, sweepBatch: 300, now: () => now });
    for (let i = 0; i < 1000; i++) await s.set('n', `t${i}`, i, i % 2 ? 10 : undefined);
    now += 11_000;
    assert.equal(await s.get('n', 't1'), undefined);
    assert.equal(s.stats().expired, 1);
    // sweep in batches of 300; delete the entry under the cursor in between
    let dropped = s.sweep();
    await s.del('n', 't300');
    await s.del('n', 't301');
    for (let i = 0; i < 5; i++) dropped += s.sweep(); // covers the rest of the list and wraps
    assert.equal(dropped, 498); // 500 expiring, minus t1 (read) and t301 (deleted)
    assert.equal(s.stats().entries, 499); // 500 permanent minus t300
    assert.equal((await s.keys('n', undefined, Infinity)).length, 499);
    await s.close();
  });

  it('counts hits, misses and sets', async () => {
    const s = new MemoryStore({ sweepIntervalMs: 0 });
    await s.set('n', 'k', 1);
    await s.get('n', 'k');
    await s.get('n', 'k');
    await s.get('n', 'nope');
    const st = s.stats();
    assert.deepEqual([st.hits, st.misses, st.sets], [2, 1, 1]);
    await s.close();
  });

  it('does constant work per operation (200k ops on a 100k-entry store)', async () => {
    const s = new MemoryStore({ maxEntries: 100_000, sweepIntervalMs: 0 });
    const t0 = performance.now();
    for (let i = 0; i < 150_000; i++) await s.set('n', `k${i}`, i);
    for (let i = 0; i < 50_000; i++) await s.get('n', `k${(i * 7919) % 150_000}`);
    const ms = performance.now() - t0;
    assert.equal(s.stats().entries, 100_000);
    assert.ok(ms < 3000, `took ${ms} ms`);
    await s.close();
  });
});
