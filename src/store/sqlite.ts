// SQLite store on `node:sqlite`.
//
// One table, rowid-keyed (WITHOUT ROWID is a poor fit for 200 KB rows), with a unique
// index on (ns, k) and a partial index on the expiry column so TTL cleanup never scans
// records that do not expire. Values are BLOBs whose first byte is the codec tag from
// codec.ts (raw JSON or gzip).
//
// Several processes may open the same file: WAL lets readers run beside the writer,
// `busy_timeout` makes SQLite wait for the write lock, and every statement is retried with
// backoff if SQLite still reports SQLITE_BUSY / SQLITE_LOCKED. Expired rows are hidden
// immediately, deleted lazily on read (conditionally, so a fresh write by another process
// is never removed) and in bounded batches by a background timer.

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Store } from '../types.ts';
import { AwError } from '../types.ts';
import {
  type CodecOptions, Pending, checkLimit, checkNs, checkNsKey, checkPrefix, closedError,
  decodeBlob, encodeBlob, expiryFor, fromJson, toJson,
} from './codec.ts';

export interface SqliteStoreOptions extends CodecOptions {
  /** ms SQLite itself waits for a lock before reporting busy (default 5000) */
  busyTimeoutMs?: number;
  /** extra retries after SQLITE_BUSY (default 8, exponential backoff from 5 ms) */
  busyRetries?: number;
  /** PRAGMA synchronous (default NORMAL: survives process crashes; FULL also survives power loss) */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL';
  /** ms between background cleanup passes (default 30 s; 0 disables) */
  cleanupIntervalMs?: number;
  /** rows deleted per cleanup statement (default 500) */
  cleanupBatch?: number;
  /** clock, for tests */
  now?: () => number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS aw_kv (
  id  INTEGER PRIMARY KEY,
  ns  TEXT NOT NULL,
  k   TEXT NOT NULL,
  v   BLOB NOT NULL,
  exp INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS aw_kv_nsk ON aw_kv(ns, k);
CREATE INDEX IF NOT EXISTS aw_kv_exp ON aw_kv(exp) WHERE exp > 0;
`;

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function isBusy(e: unknown): boolean {
  const code = (e as { errcode?: number }).errcode;
  if (typeof code === 'number') {
    const primary = code & 0xff;
    return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
  }
  return /database is (locked|busy)/i.test(String((e as Error)?.message));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SqliteStore implements Store {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly opts: SqliteStoreOptions;
  private readonly now: () => number;
  private readonly pending = new Pending();
  private readonly q: {
    get: StatementSync; put: StatementSync; del: StatementSync; delIfExpired: StatementSync;
    keys: StatementSync; cleanup: StatementSync; count: StatementSync;
  };
  private timer: NodeJS.Timeout | null = null;
  private cleaning = false;
  private closed = false;
  private entries = 0;
  private bytes = 0;
  private c = { hits: 0, misses: 0, sets: 0, dels: 0, expired: 0, corrupt: 0, busyRetries: 0 };

  constructor(path: string, opts: SqliteStoreOptions = {}) {
    if (!path) throw new AwError('bad_request', 'sqlite store needs a file path (or ":memory:")');
    this.path = path;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: opts.busyTimeoutMs ?? 5000 });
    // Schema setup may race with another process doing the same; retry while busy.
    this.retrySync(() => {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec(`PRAGMA synchronous = ${opts.synchronous ?? 'NORMAL'}`);
      this.db.exec(SCHEMA);
    });
    this.q = {
      get: this.db.prepare('SELECT v, exp FROM aw_kv WHERE ns = ? AND k = ?'),
      put: this.db.prepare(
        'INSERT INTO aw_kv (ns, k, v, exp) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT (ns, k) DO UPDATE SET v = excluded.v, exp = excluded.exp',
      ),
      del: this.db.prepare('DELETE FROM aw_kv WHERE ns = ? AND k = ?'),
      delIfExpired: this.db.prepare('DELETE FROM aw_kv WHERE ns = ? AND k = ? AND exp > 0 AND exp <= ?'),
      keys: this.db.prepare('SELECT k, exp FROM aw_kv WHERE ns = ? AND k >= ? ORDER BY ns, k'),
      cleanup: this.db.prepare(
        'DELETE FROM aw_kv WHERE id IN (SELECT id FROM aw_kv WHERE exp > 0 AND exp <= ? LIMIT ?)',
      ),
      count: this.db.prepare('SELECT count(*) AS n, coalesce(sum(length(v)), 0) AS b FROM aw_kv'),
    };
    const every = opts.cleanupIntervalMs ?? 30_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.cleanup().catch(() => {}), every);
      this.timer.unref();
    }
  }

  async get<T = unknown>(ns: string, key: string): Promise<T | undefined> {
    this.live();
    checkNsKey(ns, key);
    return this.pending.run(async () => {
      const row = await this.retry(() => this.q.get.get(ns, key)) as { v: Uint8Array; exp: number } | undefined;
      if (!row) { this.c.misses++; return undefined; }
      const now = this.now();
      if (row.exp > 0 && row.exp <= now) {
        this.c.expired++;
        this.c.misses++;
        await this.retry(() => this.q.delIfExpired.run(ns, key, now));
        return undefined;
      }
      let json: string;
      try {
        json = await decodeBlob(row.v);
      } catch {
        this.c.corrupt++;
        this.c.misses++;
        return undefined;
      }
      this.c.hits++;
      return fromJson<T>(json);
    });
  }

  async set<T = unknown>(ns: string, key: string, value: T, ttlSec?: number): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    const exp = expiryFor(ttlSec, this.now());
    const json = toJson(value);
    if (json === undefined) return this.del(ns, key);
    return this.pending.run(async () => {
      const blob = await encodeBlob(json, this.opts);
      await this.retry(() => this.q.put.run(ns, key, blob, exp));
      this.c.sets++;
    });
  }

  async del(ns: string, key: string): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    return this.pending.run(async () => {
      const r = await this.retry(() => this.q.del.run(ns, key));
      if (r.changes) this.c.dels++;
    });
  }

  async keys(ns: string, prefix?: string, limit?: number): Promise<string[]> {
    this.live();
    checkNs(ns);
    const p = checkPrefix(prefix);
    const max = checkLimit(limit);
    if (max === 0) return [];
    return this.pending.run(() => this.retry(() => {
      // Keys sharing a prefix are contiguous in SQLite's byte order, so walk forward from the
      // prefix and stop at the first key that does not start with it.
      const out: string[] = [];
      const now = this.now();
      for (const row of this.q.keys.iterate(ns, p) as Iterable<{ k: string; exp: number }>) {
        if (!row.k.startsWith(p)) break;
        if (row.exp > 0 && row.exp <= now) continue;
        out.push(row.k);
        if (out.length >= max) break;
      }
      return out;
    }));
  }

  stats(): Record<string, number> {
    // entries/bytes are refreshed by each cleanup pass (bytes = stored blob bytes, after compression)
    return { entries: this.entries, bytes: this.bytes, evictions: 0, ...this.c };
  }

  /**
   * Deletes expired rows in batches of `cleanupBatch`, yielding to the event loop between
   * batches, then refreshes the entry/byte counters. Returns the number of rows deleted.
   */
  async cleanup(maxBatches = 100): Promise<number> {
    if (this.closed || this.cleaning) return 0;
    this.cleaning = true;
    try {
      return await this.pending.run(async () => {
        const batch = this.opts.cleanupBatch ?? 500;
        let total = 0;
        for (let i = 0; i < maxBatches && !this.closed; i++) {
          const r = await this.retry(() => this.q.cleanup.run(this.now(), batch));
          total += Number(r.changes);
          if (Number(r.changes) < batch) break;
          await new Promise((res) => setImmediate(res));
        }
        this.c.expired += total;
        if (!this.closed) {
          const row = await this.retry(() => this.q.count.get()) as { n: number; b: number };
          this.entries = row.n;
          this.bytes = row.b;
        }
        return total;
      });
    } finally {
      this.cleaning = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending.idle();
    try {
      this.db.exec('PRAGMA optimize');
    } catch {
      // best effort
    }
    this.db.close();
  }

  // ───────────── internals ─────────────

  private async retry<R>(fn: () => R): Promise<R> {
    const max = this.opts.busyRetries ?? 8;
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (e) {
        if (!isBusy(e) || attempt >= max) {
          if (isBusy(e)) throw new AwError('timeout', `sqlite store busy: ${(e as Error).message}`, 'another process holds the write lock; retry later');
          throw e;
        }
        this.c.busyRetries++;
        await sleep(Math.min(500, 5 * 2 ** attempt) * (0.5 + Math.random()));
      }
    }
  }

  private retrySync(fn: () => void): void {
    const max = this.opts.busyRetries ?? 8;
    for (let attempt = 0; ; attempt++) {
      try {
        return fn();
      } catch (e) {
        if (!isBusy(e) || attempt >= max) throw e;
        sleepSync(Math.min(500, 5 * 2 ** attempt) * (0.5 + Math.random()));
      }
    }
  }

  private live(): void {
    if (this.closed) throw closedError('sqlite');
  }
}
