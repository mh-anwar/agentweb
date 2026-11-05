// Two OS processes sharing one file store / one sqlite file: each reads the other's writes,
// and concurrent writers to one key never produce a corrupt or half-written record.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openStore } from '../src/store/index.ts';
import { sampleRecord } from '../src/store/sample.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'aw-mp-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const STORE_URL = pathToFileURL(resolve('src/store/index.ts')).href;
const SAMPLE_URL = pathToFileURL(resolve('src/store/sample.ts')).href;
const SIZES = [2_000, 20_000, 200_000];
const N = 150;

const CHILD = `
  import { openStore } from ${JSON.stringify(STORE_URL)};
  import { sampleRecord } from ${JSON.stringify(SAMPLE_URL)};
  const sizes = ${JSON.stringify(SIZES)};
  const pre = sizes.map((n, i) => sampleRecord(n, 100 + i));
  const preJson = pre.map((p) => JSON.stringify(p));
  const s = await openStore(process.env.URL);
  const me = process.env.ME, other = process.env.OTHER, N = ${N};
  let corrupt = 0, sharedReads = 0, sharedWrites = 0, sharedFromOther = 0;
  const check = (v) => {
    if (JSON.stringify(v.body) !== preJson[v.kind]) corrupt++;
  };
  for (let i = 0; i < N; i++) {
    await s.set('mp', me + ':' + i, { w: me, i, kind: i % 3, body: pre[i % 3] });
    // both processes hammer one shared key with records of different sizes
    await Promise.all([
      s.set('mp', 'shared', { w: me, i, kind: (i + 1) % 3, body: pre[(i + 1) % 3] }).then(() => sharedWrites++),
      s.get('mp', 'shared').then((v) => { if (v) { sharedReads++; check(v); if (v.w === other) sharedFromOther++; } }),
    ]);
  }
  const seen = new Set();
  const deadline = Date.now() + 30000;
  while (seen.size < N && Date.now() < deadline) {
    for (let i = 0; i < N; i++) {
      if (seen.has(i)) continue;
      const v = await s.get('mp', other + ':' + i);
      if (v) { check(v); if (v.w === other && v.i === i) seen.add(i); }
    }
    if (seen.size < N) await new Promise((r) => setTimeout(r, 20));
  }
  for (let i = 0; i < 20; i++) {
    const v = await s.get('mp', 'shared');
    if (v) { sharedReads++; check(v); if (v.w === other) sharedFromOther++; }
  }
  const otherKeys = (await s.keys('mp', other + ':', Infinity)).length;
  const stats = s.stats();
  await s.close();
  process.stdout.write(JSON.stringify({ seenOther: seen.size, otherKeys, corrupt, sharedReads, sharedWrites, sharedFromOther, busyRetries: stats.busyRetries ?? 0 }));
`;

function run(url: string, me: string, other: string): Promise<Record<string, number>> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', CHILD], {
      env: { ...process.env, URL: url, ME: me, OTHER: other },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), 90_000);
    p.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) return rej(new Error(`child ${me} exited ${code}: ${err}`));
      try { res(JSON.parse(out)); } catch { rej(new Error(`bad child output: ${out} ${err}`)); }
    });
  });
}

for (const kind of ['file', 'sqlite'] as const) {
  describe(`two processes sharing a ${kind} store`, () => {
    it('each reads the other’s writes; concurrent writers never corrupt a record', { timeout: 120_000 }, async () => {
      const dir = tmp();
      const url = kind === 'file' ? `file:${dir}` : `sqlite:${join(dir, 'shared.db')}`;
      const [a, b] = await Promise.all([run(url, 'A', 'B'), run(url, 'B', 'A')]);
      for (const r of [a, b]) {
        assert.equal(r.seenOther, N);
        assert.equal(r.otherKeys, N);
        assert.equal(r.corrupt, 0);
        assert.equal(r.sharedWrites, N);
        assert.ok(r.sharedReads > 0);
      }
      assert.ok(a.sharedFromOther + b.sharedFromOther > 0, 'the shared key should have been read from the other writer at least once');
      const s = await openStore(url);
      const v = await s.get<{ w: string; kind: number; body: unknown }>('mp', 'shared');
      assert.ok(v && (v.w === 'A' || v.w === 'B'));
      assert.deepEqual(v.body, sampleRecord(SIZES[v.kind], 100 + v.kind));
      assert.equal((await s.keys('mp', undefined, Infinity)).length, 2 * N + 1);
      await s.close();
      console.log(`# ${kind}: shared-key reads A=${a.sharedReads} (from B: ${a.sharedFromOther}), B=${b.sharedReads} (from A: ${b.sharedFromOther}); busy retries ${a.busyRetries + b.busyRetries}`);
    });
  });
}
