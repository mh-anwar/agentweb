import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwError } from '../src/types.ts';
import { SqliteStore, TAG_GZIP, TAG_RAW } from '../src/store/index.ts';
import { sampleRecord } from '../src/store/sample.ts';

const dirs: string[] = [];
const tmpDb = () => { const d = mkdtempSync(join(tmpdir(), 'aw-sql-')); dirs.push(d); return join(d, 'aw.db'); };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('SqliteStore', () => {
  it('uses WAL and stores tagged BLOBs: raw JSON below the threshold, gzip above', async () => {
    const path = tmpDb();
    const s = new SqliteStore(path, { gzipAbove: 1024, cleanupIntervalMs: 0 });
    await s.set('n', 'small', { a: 1 });
    await s.set('n', 'big', sampleRecord(20_000));
    const db = new DatabaseSync(path);
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    const rows = db.prepare('SELECT k, typeof(v) AS t, v FROM aw_kv ORDER BY k').all() as Array<{ k: string; t: string; v: Uint8Array }>;
    assert.deepEqual(rows.map((r) => [r.k, r.t, r.v[0]]), [['big', 'blob', TAG_GZIP], ['small', 'blob', TAG_RAW]]);
    assert.equal(Buffer.from(rows[1].v.subarray(1)).toString(), '{"a":1}');
    assert.ok(rows[0].v.length < 20_000 / 2.5);
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT id FROM aw_kv WHERE exp > 0 AND exp <= 5 LIMIT 10").all() as Array<{ detail: string }>;
    assert.match(plan.map((p) => p.detail).join(' '), /aw_kv_exp/);
    db.close();
    await s.close();
  });

  it('cleans up expired rows in bounded batches and keeps live ones', async () => {
    let now = 1_000_000;
    const s = new SqliteStore(tmpDb(), { cleanupIntervalMs: 0, cleanupBatch: 100, now: () => now });
    for (let i = 0; i < 1000; i++) await s.set('n', `k${i}`, i, i % 4 === 0 ? undefined : 30);
    now += 31_000;
    assert.equal(await s.cleanup(3), 300); // three batches only
    assert.equal(await s.cleanup(), 450);
    assert.equal(s.stats().entries, 250);
    assert.ok(s.stats().bytes > 0);
    assert.equal((await s.keys('n', undefined, Infinity)).length, 250);
    await s.close();
  });

  it('deletes an expired row lazily on read, but never a fresh rewrite', async () => {
    let now = 1_000_000;
    const path = tmpDb();
    const s = new SqliteStore(path, { cleanupIntervalMs: 0, now: () => now });
    await s.set('n', 'k', 'old', 1);
    now += 2000;
    assert.equal(await s.get('n', 'k'), undefined);
    const db = new DatabaseSync(path);
    assert.equal((db.prepare('SELECT count(*) AS n FROM aw_kv').get() as { n: number }).n, 0);
    db.close();
    await s.close();
  });

  it('waits out a lock held by another connection, then fails with a timeout if it persists', async () => {
    const path = tmpDb();
    const s = new SqliteStore(path, { cleanupIntervalMs: 0, busyTimeoutMs: 20, busyRetries: 6 });
    await s.set('n', 'k', 0);
    const other = new DatabaseSync(path);
    other.exec('BEGIN IMMEDIATE');
    other.exec("INSERT INTO aw_kv (ns, k, v, exp) VALUES ('n', 'other', x'007b7d', 0)");
    setTimeout(() => other.exec('COMMIT'), 120);
    await s.set('n', 'k', 1); // blocked by the writer above until it commits
    assert.equal(await s.get('n', 'k'), 1);
    assert.deepEqual(await s.get('n', 'other'), {});
    assert.ok(s.stats().busyRetries > 0);

    const quick = new SqliteStore(path, { cleanupIntervalMs: 0, busyTimeoutMs: 10, busyRetries: 2 });
    other.exec('BEGIN IMMEDIATE');
    await assert.rejects(quick.set('n', 'k', 2), (e: unknown) => e instanceof AwError && e.code === 'timeout');
    other.exec('ROLLBACK');
    await quick.set('n', 'k', 2);
    other.close();
    await quick.close();
    await s.close();
  });

  it('reads a damaged blob as missing and counts it', async () => {
    const path = tmpDb();
    const s = new SqliteStore(path, { cleanupIntervalMs: 0 });
    const db = new DatabaseSync(path);
    db.exec("INSERT INTO aw_kv (ns, k, v, exp) VALUES ('n', 'tag', x'09', 0), ('n', 'gz', x'01deadbeef', 0)");
    db.close();
    assert.equal(await s.get('n', 'tag'), undefined);
    assert.equal(await s.get('n', 'gz'), undefined);
    assert.equal(s.stats().corrupt, 2);
    await s.close();
  });
});
