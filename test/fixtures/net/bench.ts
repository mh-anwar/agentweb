// Wire-engine benchmark: throughput and latency of open() against a local origin that runs in a
// child process (so the origin does not share our event loop), plus memory per cached page.
//
//   node --expose-gc test/fixtures/net/bench.ts            (from the repo root)

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWireEngine } from '../../../src/net/http.ts';
import { makeCtx, memStore } from './helpers.ts';

if (process.argv[2] === 'serve') {
  const { startFixture } = await import('./server.ts');
  const fx = await startFixture();
  process.send!({ port: fx.port });
  process.on('disconnect', () => fx.close().then(() => process.exit(0)));
} else {
  const child = fork(fileURLToPath(import.meta.url), ['serve'], { stdio: 'inherit' });
  const port: number = await new Promise((r) => child.once('message', (m: any) => r(m.port)));
  const base = `http://127.0.0.1:${port}`;
  const resolve = async () => [{ address: '127.0.0.1', family: 4 as const }];

  async function run(label: string, conc: number, total: number, cache: boolean, perOrigin: number) {
    const eng = createWireEngine({ resolve, cache: cache ? memStore() : undefined, polite: { perOrigin, global: 4096 } });
    const ctx = () => makeCtx({ timeoutMs: 30_000 });
    // warm up sockets
    await Promise.all(Array.from({ length: Math.min(conc, 64) }, () => eng.open(ctx(), { url: `${base}/bench${cache ? '?cache' : ''}`, read: cache })));
    const lat: number[] = [];
    let next = 0;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: conc }, async () => {
        while (next < total) {
          next++;
          const s = performance.now();
          const r = await eng.open(ctx(), { url: `${base}/bench${cache ? '?cache' : ''}`, read: cache });
          if (r.status !== 200) throw new Error('bad status');
          lat.push(performance.now() - s);
        }
      }),
    );
    const dt = (performance.now() - t0) / 1000;
    lat.sort((a, b) => a - b);
    const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(2);
    const st = eng.stats();
    console.log(`${label.padEnd(34)} c=${String(conc).padEnd(4)} ${String(Math.round(total / dt)).padStart(6)} req/s  p50 ${q(0.5).padStart(7)} ms  p95 ${q(0.95).padStart(7)} ms  origin=${st.originRequests}`);
    await eng.close();
  }

  const memOnly = process.argv.includes('--mem');
  for (const cache of memOnly ? [] : [false, true]) {
    for (const [conc, total] of [[1, 2000], [64, 20000], [512, 30000]] as const) {
      await run(`cache ${cache ? 'on ' : 'off'} polite 6/origin`, conc, total, cache, 6);
      if (!cache && conc > 1) await run(`cache off polite ${conc}/origin`, conc, total, cache, conc);
    }
  }

  // memory per 10,000 distinct cached pages (run with --mem in a fresh process for clean numbers)
  const gc = (globalThis as { gc?: () => void }).gc;
  for (const rep of [40, 400]) {
    const store = memStore();
    const eng = createWireEngine({ resolve, cache: store, polite: { perOrigin: 64 } });
    await eng.open(makeCtx(), { url: `${base}/bench?cache&rep=${rep}&i=warm`, read: true });
    gc?.(); gc?.();
    const m0 = process.memoryUsage();
    let i = 0;
    const N = 10_000;
    await Promise.all(Array.from({ length: 64 }, async () => {
      while (i < N) await eng.open(makeCtx(), { url: `${base}/bench?cache&rep=${rep}&i=${i++}`, read: true });
    }));
    for (let k = 0; k < 3; k++) { gc?.(); await new Promise((r) => setTimeout(r, 50)); }
    const m1 = process.memoryUsage();
    const page = (await eng.open(makeCtx(), { url: `${base}/bench?cache&rep=${rep}&i=0`, read: true })).bytes;
    const mb = (x: number) => (x / 1048576).toFixed(1);
    const heap = m1.heapUsed - m0.heapUsed;
    console.log(`${N} distinct cached pages of ${page} B: entries=${store.map.size} rss +${mb(m1.rss - m0.rss)} MB, heap +${mb(heap)} MB, external +${mb(m1.external - m0.external)} MB => ${Math.round(heap / N)} B/page (payload ${page} B, overhead ${Math.round(heap / N - page)} B)${gc ? '' : ' [run with --expose-gc]'}`);
    await eng.close();
  }
  child.disconnect();
}
