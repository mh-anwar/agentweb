import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLimiter } from '../src/net/polite.ts';

const tick = () => new Promise((r) => setImmediate(r));

test('per-origin cap with FIFO order', async () => {
  const lim = createLimiter({ perOrigin: 2 });
  const order: number[] = [];
  const releases: (() => void)[] = [];
  const ps = Array.from({ length: 6 }, (_, i) => lim.acquire('https://a').then((rel) => { order.push(i); releases.push(rel); }));
  await tick();
  assert.deepEqual(order, [0, 1]);
  assert.equal(lim.active('https://a'), 2);
  assert.equal(lim.depth('https://a'), 4);
  releases[0]();
  releases[0](); // idempotent
  await tick();
  assert.deepEqual(order, [0, 1, 2]);
  assert.equal(lim.active('https://a'), 2);
  while (releases.length < 6) { releases[releases.length - 1](); await tick(); }
  await Promise.all(ps);
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5]);
  for (const r of releases) r();
  assert.equal(lim.active(), 0);
  assert.equal(lim.depth(), 0);
});

test('global cap is shared round-robin so a deep queue cannot starve another origin', async () => {
  const lim = createLimiter({ perOrigin: 10, global: 2 });
  const got: string[] = [];
  const held: (() => void)[] = [];
  const take = (o: string) => lim.acquire(o).then((r) => { got.push(o); held.push(r); });
  for (let i = 0; i < 6; i++) void take('A');
  for (let i = 0; i < 2; i++) void take('B');
  await tick();
  assert.deepEqual(got, ['A', 'A']);
  assert.equal(lim.active(), 2);
  for (let i = 0; i < 4; i++) { held.shift()!(); await tick(); }
  // after the first two A's, B gets every other freed slot instead of waiting behind four A's
  assert.deepEqual(got, ['A', 'A', 'A', 'B', 'A', 'B']);
  while (held.length) { held.shift()!(); await tick(); }
  assert.equal(lim.stats().granted, 8);
});

test('minimum interval between starts per origin', async () => {
  const lim = createLimiter({ perOrigin: 4, minIntervalMs: 40 });
  const t0 = Date.now();
  const times: number[] = [];
  await Promise.all([0, 1, 2].map(() => lim.acquire('https://slow').then((r) => { times.push(Date.now() - t0); r(); })));
  assert.ok(times[0] < 20, `first immediate (${times[0]})`);
  assert.ok(times[1] >= 35, `second waited (${times[1]})`);
  assert.ok(times[2] >= 75, `third waited (${times[2]})`);
  // another origin is unaffected
  const t1 = Date.now();
  (await lim.acquire('https://other'))();
  assert.ok(Date.now() - t1 < 20);
});

test('per-origin overrides', async () => {
  const lim = createLimiter({ perOrigin: 1, origins: { 'http://fast': { perOrigin: 3 } } });
  const rs = await Promise.all([lim.acquire('http://fast'), lim.acquire('http://fast'), lim.acquire('http://fast')]);
  assert.equal(lim.active('http://fast'), 3);
  rs.forEach((r) => r());
});

test('abort removes a waiter and rejects with a timeout AwError', async () => {
  const lim = createLimiter({ perOrigin: 1 });
  const r1 = await lim.acquire('o');
  const ac = new AbortController();
  const p = lim.acquire('o', ac.signal);
  const p3 = lim.acquire('o');
  assert.equal(lim.depth('o'), 2);
  ac.abort();
  await assert.rejects(p, (e: any) => e.code === 'timeout');
  assert.equal(lim.depth('o'), 1);
  r1();
  const r3 = await p3;
  r3();
  assert.equal(lim.stats().aborted, 1);
  await assert.rejects(lim.acquire('o', AbortSignal.abort()), (e: any) => e.code === 'timeout');
});

test('queue cap fails fast', async () => {
  const lim = createLimiter({ perOrigin: 1, maxQueue: 2 });
  const r = await lim.acquire('o');
  const a = lim.acquire('o');
  const b = lim.acquire('o');
  await assert.rejects(lim.acquire('o'), (e: any) => e.code === 'blocked');
  r();
  (await a)();
  (await b)();
  assert.equal(lim.stats().rejected, 1);
});

test('state for idle origins is dropped (bounded memory)', async () => {
  const lim = createLimiter();
  for (let i = 0; i < 1000; i++) (await lim.acquire(`https://o${i}`))();
  assert.equal(lim.stats().origins, 0);
});
