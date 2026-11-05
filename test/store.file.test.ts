import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, truncateSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FileStore, encodeName, decodeName, TAG_GZIP, TAG_RAW } from '../src/store/index.ts';
import { sampleRecord } from '../src/store/sample.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'aw-file-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const STORE_URL = pathToFileURL(resolve('src/store/index.ts')).href;
const SAMPLE_URL = pathToFileURL(resolve('src/store/sample.ts')).href;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function child(code: string, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('FileStore names', () => {
  it('encodes keys into safe, case-insensitive-proof, reversible names', () => {
    for (const k of ['', 'abc', 'ABC', 'a/b', '..', '😀', 'é', '=^', 'x y\n', '\u0000']) {
      const e = encodeName(k);
      assert.match(e, /^[a-z0-9_\-^=]*$/);
      assert.equal(decodeName(e), k);
      assert.notEqual(e[0], '.');
    }
    assert.notEqual(encodeName('Key').toLowerCase(), encodeName('key').toLowerCase());
    // non-canonical names (written by someone else) are not mistaken for ours
    assert.equal(decodeName('=4'), undefined);
    assert.equal(decodeName('^A'), undefined);
    assert.equal(decodeName('=41'), undefined); // canonical form of "A" is "^a"
  });
});

describe('FileStore on disk', () => {
  it('shards records, gzips above the threshold and leaves no temp files', async () => {
    const dir = tmp();
    const s = new FileStore(dir, { gzipAbove: 1024, sweepIntervalMs: 0 });
    await s.set('sess', 'small', { a: 1 });
    await s.set('sess', 'big', sampleRecord(20_000));
    const files = walk(dir);
    assert.equal(files.length, 2);
    for (const f of files) {
      const rel = f.slice(dir.length + 1).split('/');
      assert.equal(rel.length, 3);
      assert.equal(rel[0], 'nsess');
      assert.match(rel[1], /^[0-9a-f]{2}$/);
    }
    const tagOf = (f: string) => { const b = readFileSync(f); return b[24 + b.readUInt32BE(12)]; };
    const small = files.find((f) => f.endsWith('ksmall'))!;
    const big = files.find((f) => f.endsWith('kbig'))!;
    assert.equal(tagOf(small), TAG_RAW);
    assert.equal(tagOf(big), TAG_GZIP);
    assert.ok(statSync(big).size < 20_000 / 2.5, `20 KB record took ${statSync(big).size} bytes`);
    await s.close();
  });

  it('treats torn and damaged records as missing, and counts them', async () => {
    const dir = tmp();
    const s = new FileStore(dir, { sweepIntervalMs: 0 });
    await s.set('n', 'a', sampleRecord(5000));
    await s.set('n', 'b', sampleRecord(5000, 2));
    const [fa, fb] = ['ka', 'kb'].map((n) => walk(dir).find((f) => f.endsWith('/' + n))!);
    truncateSync(fa, 1000);
    const buf = readFileSync(fb);
    buf[buf.length - 10] ^= 0xff;
    writeFileSync(fb, buf);
    assert.equal(await s.get('n', 'a'), undefined);
    assert.equal(await s.get('n', 'b'), undefined);
    assert.equal(s.stats().corrupt, 2);
    await s.set('n', 'a', 1); // a rewrite repairs it
    assert.equal(await s.get('n', 'a'), 1);
    await s.close();
  });

  it('ignores foreign files and recreates directories removed underneath it', async () => {
    const dir = tmp();
    const s = new FileStore(dir, { sweepIntervalMs: 0 });
    await s.set('n', 'k', 1);
    const shardDir = join(walk(dir)[0], '..');
    writeFileSync(join(shardDir, 'README'), 'hello');
    writeFileSync(join(shardDir, '.DS_Store'), 'x');
    writeFileSync(join(dir, 'stray.txt'), 'x');
    assert.deepEqual(await s.keys('n'), ['k']);
    await s.sweepAll();
    rmSync(join(dir, 'nn'), { recursive: true });
    await s.set('n', 'k2', 2);
    assert.equal(await s.get('n', 'k2'), 2);
    await s.close();
  });

  it('sweeps expired records and stale temp files, keeps live ones', async () => {
    const dir = tmp();
    let now = Date.now();
    const s = new FileStore(dir, { sweepIntervalMs: 0, tempMaxAgeMs: 60_000, now: () => now });
    for (let i = 0; i < 50; i++) await s.set('n', `k${i}`, i, i < 30 ? 5 : undefined);
    const shardDir = join(walk(dir)[0], '..');
    writeFileSync(join(shardDir, '.tdead-1'), 'partial temp file from a crashed writer');
    now += 10_000;
    await s.sweepAll();
    assert.equal(walk(dir).filter((f) => !f.includes('/.')).length, 20);
    assert.equal(s.stats().expired, 30);
    assert.equal(s.stats().entries, 20);
    assert.ok(walk(dir).some((f) => f.endsWith('.tdead-1')), 'a young temp file may belong to a live writer');
    now += 120_000;
    await s.sweepAll();
    assert.equal(walk(dir).length, 20);
    assert.equal(s.stats().tempsRemoved, 1);
    await s.close();
  });

  it('a sweeper never deletes a record that was rewritten after it expired', async () => {
    const dir = tmp();
    let now = Date.now();
    const a = new FileStore(dir, { sweepIntervalMs: 0, now: () => now });
    const b = new FileStore(dir, { sweepIntervalMs: 0, now: () => now });
    await a.set('n', 'k', 'old', 1);
    now += 5000;
    // b sees the expired record, and a rewrites it at the same moment
    await Promise.all([b.sweepAll(), a.set('n', 'k', 'fresh'), b.get('n', 'k')]);
    assert.equal(await a.get('n', 'k'), 'fresh');
    await a.close();
    await b.close();
  });
});

describe('FileStore crash safety', () => {
  it('never exposes a half-written record when the writer is SIGKILLed mid-write', { timeout: 120_000 }, async () => {
    const dir = tmp();
    const sizes = [300_000, 900_000, 2_000_000];
    const expected = sizes.map((n, i) => JSON.stringify(sampleRecord(n, i + 1)));
    const code = `
      import { FileStore } from ${JSON.stringify(STORE_URL)};
      import { sampleRecord } from ${JSON.stringify(SAMPLE_URL)};
      const sizes = ${JSON.stringify(sizes)};
      const pre = sizes.map((n, i) => sampleRecord(n, i + 1));
      const s = new FileStore(process.env.DIR, { sweepIntervalMs: 0, gzipAbove: Number(process.env.GZ), fsync: process.env.FSYNC === '1' });
      let seq = Number(process.env.SEED);
      let first = true;
      for (;;) {
        seq++;
        const kind = seq % 3;
        // several writes in flight at once, so a kill lands inside some of them
        await Promise.all([0, 1, 2, 3].map((j) => s.set('crash', 'k' + j, { seq, kind, body: pre[(kind + j) % 3], j })));
        if (first) { process.stdout.write('ready\\n'); first = false; }
      }`;
    let valid = 0;
    let tempsSeen = 0;
    for (let round = 0; round < 12; round++) {
      const p = child(code, { DIR: dir, SEED: String(round * 1_000_000), GZ: round % 2 ? 'Infinity' : '1024', FSYNC: round % 4 < 2 ? '1' : '0' });
      let err = '';
      p.stderr!.on('data', (d) => { err += d; });
      await new Promise<void>((res, rej) => {
        p.stdout!.on('data', (d) => { if (String(d).includes('ready')) res(); });
        p.on('exit', (c) => rej(new Error(`child exited early (${c}): ${err}`)));
      });
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 250));
      const exited = new Promise((r) => p.on('exit', r));
      p.kill('SIGKILL');
      await exited;
      tempsSeen += walk(dir).filter((f) => f.split('/').pop()!.startsWith('.t')).length;
      const s = new FileStore(dir, { sweepIntervalMs: 0 });
      for (let j = 0; j < 4; j++) {
        const v = await s.get<{ seq: number; kind: number; body: unknown; j: number }>('crash', 'k' + j);
        assert.ok(v, `record k${j} missing after round ${round}`);
        assert.equal(v.j, j);
        assert.equal(JSON.stringify(v.body), expected[(v.kind + j) % 3], `record k${j} damaged after round ${round}`);
        valid++;
      }
      assert.equal(s.stats().corrupt, 0);
      await s.close();
    }
    assert.equal(valid, 48);
    // crash leftovers are only ever temp files, and the sweep clears them
    const s = new FileStore(dir, { sweepIntervalMs: 0, tempMaxAgeMs: 0 });
    await s.sweepAll();
    assert.equal(walk(dir).filter((f) => f.split('/').pop()!.startsWith('.')).length, 0);
    assert.equal(walk(dir).length, 4);
    await s.close();
    // how often the kill landed between temp-file creation and rename (informational)
    console.log(`# crash test: temp files left behind by kills across 12 rounds: ${tempsSeen}`);
  });
});
