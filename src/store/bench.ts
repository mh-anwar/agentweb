// Storage benchmark: `node src/store/bench.ts [--dir /path/on/real/disk] [--quick]`
//
// For every store and for realistic 2 KB / 20 KB / 200 KB session records: set and get
// operations per second (one at a time, and 32 in flight), and bytes at rest per record.
// Also the resident memory of the memory store per 100 000 2 KB records (in a child
// process with --expose-gc). Redis runs against FakeRedis in a separate process, so its
// numbers measure this client plus a JS server, not a real redis-server.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { Store } from '../types.ts';
import { MemoryStore, ENTRY_OVERHEAD } from './memory.ts';
import { FileStore } from './file.ts';
import { SqliteStore } from './sqlite.ts';
import { RedisStore } from './redis.ts';
import { TieredStore } from './tiered.ts';
import { sampleRecord } from './sample.ts';
import { encodeBlobSync, toJson } from './codec.ts';

const SIZES = [2_000, 20_000, 200_000];
const here = fileURLToPath(new URL('.', import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const quick = process.argv.includes('--quick');

function opsFor(size: number): number {
  const n = size <= 2_000 ? 4000 : size <= 20_000 ? 1500 : 250;
  return quick ? Math.ceil(n / 5) : n;
}

async function timeOps(n: number, conc: number, op: (i: number) => Promise<unknown>): Promise<number> {
  const t0 = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next < n) await op(next++);
  }));
  return n / ((performance.now() - t0) / 1000);
}

function walkSize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const r = walkSize(p); files += r.files; bytes += r.bytes; }
    else { files++; bytes += statSync(p).size; }
  }
  return { files, bytes };
}

interface Row { store: string; size: number; json: number; setSerial: number; getSerial: number; set32: number; get32: number; atRest: number; note?: string }

async function startFakeRedis(): Promise<{ port: number; stop: () => void }> {
  const url = pathToFileURL(join(here, 'fake-redis.ts')).href;
  const p = spawn(process.execPath, ['--input-type=module', '-e',
    `import { FakeRedis } from ${JSON.stringify(url)}; const f = new FakeRedis(); process.stdout.write(String(await f.listen(0)) + '\\n');`],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise<number>((res) => p.stdout.once('data', (d) => res(Number(String(d).trim()))));
  return { port, stop: () => p.kill() };
}

async function benchStore(name: string, make: () => Promise<Store>, atRest: (s: Store, size: number, n: number) => Promise<number>): Promise<Row[]> {
  const rows: Row[] = [];
  for (const size of SIZES) {
    const recs = Array.from({ length: 50 }, (_, i) => sampleRecord(size, 1000 + i));
    const json = Math.round(recs.reduce((a, r) => a + JSON.stringify(r).length, 0) / recs.length);
    const n = opsFor(size);
    const s = await make();
    const ns = `b${size}`;
    // warm up
    for (let i = 0; i < 20; i++) { await s.set(ns, `w${i}`, recs[i % 50]); await s.get(ns, `w${i}`); }
    const setSerial = await timeOps(n, 1, (i) => s.set(ns, `k${i}`, recs[i % 50]));
    const getSerial = await timeOps(n, 1, (i) => s.get(ns, `k${(i * 7) % n}`));
    const set32 = await timeOps(n, 32, (i) => s.set(ns, `k${i}`, recs[(i + 1) % 50]));
    const get32 = await timeOps(n, 32, (i) => s.get(ns, `k${(i * 7) % n}`));
    const rest = await atRest(s, size, n + 20);
    await s.close();
    rows.push({ store: name, size, json, setSerial, getSerial, set32, get32, atRest: rest });
  }
  return rows;
}

async function memoryResident(): Promise<string> {
  // child with --expose-gc so the heap measurement is not noise
  const url = pathToFileURL(join(here, 'bench.ts')).href;
  const out = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(url), '--resident-child'], { encoding: 'utf8', maxBuffer: 1 << 20 });
  return out.trim();
}

async function residentChild(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc!;
  const recs = Array.from({ length: 200 }, (_, i) => sampleRecord(2_000, 5000 + i));
  const s = new MemoryStore({ maxBytes: 4 * 1024 ** 3, sweepIntervalMs: 0 });
  gc(); gc();
  const m0 = process.memoryUsage();
  const N = 100_000;
  for (let i = 0; i < N; i++) {
    // distinct strings, as real sessions would be (not 100k references to 200 strings)
    const r = recs[i % 200] as { id: string };
    await s.set('sess', `s_${i.toString(36).padStart(8, '0')}`, { ...r, id: `${r.id}${i}` });
  }
  gc(); gc();
  const m1 = process.memoryUsage();
  const heap = (m1.heapUsed + m1.external) - (m0.heapUsed + m0.external);
  const rss = m1.rss - m0.rss;
  const st = s.stats();
  process.stdout.write(JSON.stringify({ entries: st.entries, accounted: st.bytes, heap, rss, perRecordHeap: heap / N, perRecordAccounted: st.bytes / N, overhead: ENTRY_OVERHEAD }));
}

async function main(): Promise<void> {
  if (process.argv.includes('--resident-child')) return residentChild();
  const base = arg('--dir') ?? join(homedir(), '.cache', 'agentweb-store-bench');
  execFileSync('mkdir', ['-p', base]);
  const dir = mkdtempSync(join(base, 'run-'));
  const fs = execFileSync('df', ['-T', base], { encoding: 'utf8' }).trim().split('\n').pop()!.split(/\s+/)[1];
  console.log(`# node ${process.version}; file/sqlite data in ${dir} (${fs}); ${quick ? 'quick' : 'full'} run`);
  const redis = await startFakeRedis();
  const rows: Row[] = [];
  try {
    rows.push(...await benchStore('memory', async () => new MemoryStore({ maxBytes: 2 * 1024 ** 3, sweepIntervalMs: 0 }),
      async (s) => { const st = s.stats!(); return st.bytes / st.entries; }));
    let fi = 0;
    rows.push(...await benchStore('file', async () => new FileStore(join(dir, `file${fi++}`), { sweepIntervalMs: 0 }),
      async (s) => { const r = walkSize((s as FileStore).root); return r.bytes / r.files; }));
    let si = 0;
    rows.push(...await benchStore('sqlite', async () => new SqliteStore(join(dir, `sq${si++}.db`), { cleanupIntervalMs: 0 }),
      async (s, _size, n) => {
        const p = (s as SqliteStore).path;
        await (s as SqliteStore).cleanup();
        const db = new DatabaseSync(p);
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        const blob = (db.prepare('SELECT avg(length(v)) AS a FROM aw_kv').get() as { a: number }).a;
        db.close();
        const file = statSync(p).size / n;
        return Math.round(Math.max(blob, file));
      }));
    rows.push(...await benchStore('redis (fake)', async () => { const r = new RedisStore(`redis://127.0.0.1:${redis.port}`); await r.client.waitReady(); return r; },
      async (_s, size) => encodeBlobSync(toJson(sampleRecord(size, 1000))!).length));
    rows.push(...await benchStore('tiered(sqlite)', async () => new TieredStore(new SqliteStore(join(dir, `tq${si++}.db`), { cleanupIntervalMs: 0 }), { l1TtlMs: 2000 }),
      async (s) => { const st = s.stats!(); return st['l1.bytes'] / Math.max(1, st['l1.entries']); }));
  } finally {
    redis.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  const f = (x: number) => (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1));
  console.log('\n| store | record | JSON B | set/s | get/s | set/s ×32 | get/s ×32 | bytes at rest |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.store} | ${r.size / 1000} KB | ${f(r.json)} | ${f(r.setSerial)} | ${f(r.getSerial)} | ${f(r.set32)} | ${f(r.get32)} | ${f(r.atRest)} |`);
  }
  const res = JSON.parse(await memoryResident());
  console.log(`\nmemory store, 100,000 × 2 KB records: heap+external ${(res.heap / 1024 ** 2).toFixed(1)} MiB ` +
    `(${Math.round(res.perRecordHeap)} B/record), RSS +${(res.rss / 1024 ** 2).toFixed(1)} MiB, ` +
    `accounted ${(res.accounted / 1024 ** 2).toFixed(1)} MiB (${Math.round(res.perRecordAccounted)} B/record)`);
}

await main();
