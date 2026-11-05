// A small in-process L1 (MemoryStore) in front of any L2 store.
//
// Reads go to L1, then L2 (read-through: an L2 hit fills L1). Writes and deletes go to L2
// first and then update L1 (write-through), so L1 never holds a value L2 refused. L1
// entries live for at most `l1TtlMs` (default 2 s), which bounds how long this worker can
// serve a value after another worker overwrote it in L2.
//
// A read that raced with a local write never fills L1 with the older value: every write
// invalidates the fill token of in-flight reads of the same key.

import type { Store } from '../types.ts';
import { checkLimit, checkNs, checkNsKey, closedError, expiryFor, toJson } from './codec.ts';
import { MemoryStore, type MemoryStoreOptions } from './memory.ts';

export interface TieredStoreOptions {
  /** L1 freshness bound in ms (default 2000) */
  l1TtlMs?: number;
  /** cache misses in L1 for this long (default 0 = never; a miss cached here hides other workers' new writes) */
  negativeTtlMs?: number;
  /** L1 bounds (defaults: 32 MiB, 10 000 entries) */
  l1?: Pick<MemoryStoreOptions, 'maxBytes' | 'maxEntries'>;
  /** close L2 when this store closes (default true) */
  ownsL2?: boolean;
}

const NEG = '\u0000miss';

export class TieredStore implements Store {
  readonly l1: MemoryStore;
  readonly l2: Store;
  private readonly l1TtlMs: number;
  private readonly negTtlMs: number;
  private readonly ownsL2: boolean;
  private readonly fills = new Map<string, object>();
  private closed = false;
  private c = { l1Hits: 0, l2Hits: 0, misses: 0 };

  constructor(l2: Store, opts: TieredStoreOptions = {}) {
    this.l2 = l2;
    this.l1TtlMs = opts.l1TtlMs ?? 2000;
    this.negTtlMs = opts.negativeTtlMs ?? 0;
    this.ownsL2 = opts.ownsL2 ?? true;
    this.l1 = new MemoryStore({
      maxBytes: opts.l1?.maxBytes ?? 32 * 1024 * 1024,
      maxEntries: opts.l1?.maxEntries ?? 10_000,
      oversize: 'drop',
      sweepIntervalMs: Math.max(1000, this.l1TtlMs * 5),
    });
  }

  async get<T = unknown>(ns: string, key: string): Promise<T | undefined> {
    this.live();
    checkNsKey(ns, key);
    const cached = this.l1.getJson(ns, key);
    if (cached !== undefined) {
      if (cached === NEG) { this.c.misses++; return undefined; }
      this.c.l1Hits++;
      return JSON.parse(cached) as T;
    }
    const id = fillId(ns, key);
    const token = {};
    this.fills.set(id, token);
    try {
      const v = await this.l2.get<T>(ns, key);
      if (this.fills.get(id) === token && !this.closed) {
        if (v === undefined) {
          if (this.negTtlMs > 0) this.l1.setJson(ns, key, NEG, Date.now() + this.negTtlMs);
        } else {
          this.l1.setJson(ns, key, toJson(v)!, Date.now() + this.l1TtlMs);
        }
      }
      if (v === undefined) this.c.misses++;
      else this.c.l2Hits++;
      return v;
    } finally {
      if (this.fills.get(id) === token) this.fills.delete(id);
    }
  }

  async set<T = unknown>(ns: string, key: string, value: T, ttlSec?: number): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    const exp = expiryFor(ttlSec);
    const json = toJson(value);
    this.fills.delete(fillId(ns, key));
    // drop L1 first so a failed L2 write cannot leave a stale L1 value behind
    this.l1.delSync(ns, key);
    await this.l2.set(ns, key, value, ttlSec);
    this.fills.delete(fillId(ns, key));
    if (json !== undefined && !this.closed) {
      const l1Exp = Date.now() + this.l1TtlMs;
      this.l1.setJson(ns, key, json, exp ? Math.min(exp, l1Exp) : l1Exp);
    }
  }

  async del(ns: string, key: string): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    this.fills.delete(fillId(ns, key));
    this.l1.delSync(ns, key);
    await this.l2.del(ns, key);
    this.fills.delete(fillId(ns, key));
    this.l1.delSync(ns, key);
  }

  async keys(ns: string, prefix?: string, limit?: number): Promise<string[]> {
    this.live();
    checkNs(ns);
    checkLimit(limit);
    return this.l2.keys(ns, prefix, limit);
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = { ...this.c, hits: this.c.l1Hits + this.c.l2Hits };
    const l2 = this.l2.stats?.() ?? {};
    for (const [k, v] of Object.entries(l2)) out[k === 'hits' || k === 'misses' ? `l2.${k}` : k] = v;
    out.misses = this.c.misses;
    for (const [k, v] of Object.entries(this.l1.stats())) out[`l1.${k}`] = v;
    return out;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.l1.close();
    if (this.ownsL2) await this.l2.close();
  }

  private live(): void {
    if (this.closed) throw closedError('tiered');
  }
}

function fillId(ns: string, key: string): string {
  return `${ns.length}:${ns}${key}`;
}
