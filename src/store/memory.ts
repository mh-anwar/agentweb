// In-process store: an LRU bounded by total bytes and by entry count, with TTL.
//
// Values are kept as their JSON text, never as live objects: every `get` returns a fresh
// copy (callers may mutate it freely), byte accounting is exact for the payload, and the
// semantics match the persistent stores (Date → string, nested undefined dropped, …).
//
// All operations are O(1): one Map per namespace for lookup plus one intrusive doubly
// linked list across all entries for recency. Expired entries are dropped lazily on
// access and by an incremental background sweep that visits a bounded number of entries
// per tick.

import type { Store } from '../types.ts';
import { AwError } from '../types.ts';
import { checkLimit, checkNs, checkNsKey, checkPrefix, closedError, expiryFor, fromJson, toJson } from './codec.ts';

export interface MemoryStoreOptions {
  /** upper bound on accounted bytes (default 256 MiB) */
  maxBytes?: number;
  /** upper bound on entries (default unlimited) */
  maxEntries?: number;
  /** what to do with a single value larger than maxBytes: throw `too_large` (default) or drop it */
  oversize?: 'throw' | 'drop';
  /** ms between incremental TTL sweeps (default 30 s; 0 disables the timer) */
  sweepIntervalMs?: number;
  /** entries visited per sweep tick (default 10 000) */
  sweepBatch?: number;
  /** clock, for tests */
  now?: () => number;
}

/**
 * Fixed per-entry cost in bytes on top of the key and value strings: the entry object
 * (7 fields), its slot in the namespace Map and the two string headers. Calibrated against
 * `process.memoryUsage()` on Node 24 / x64; see bench.ts.
 */
export const ENTRY_OVERHEAD = 136;

interface Entry {
  ns: string;
  key: string;
  json: string;
  size: number;
  /** epoch ms, 0 = never */
  exp: number;
  prev: Entry | null;
  next: Entry | null;
}

const TWO_BYTE = /[^\u0000-ÿ]/;

/** V8 stores a string as one byte per char if every char is Latin-1, else two. */
function strBytes(s: string): number {
  return s.length * (TWO_BYTE.test(s) ? 2 : 1);
}

export class MemoryStore implements Store {
  readonly maxBytes: number;
  readonly maxEntries: number;
  private readonly oversize: 'throw' | 'drop';
  private readonly sweepBatch: number;
  private readonly now: () => number;
  private readonly spaces = new Map<string, Map<string, Entry>>();
  /** least recently used */
  private head: Entry | null = null;
  /** most recently used */
  private tail: Entry | null = null;
  /** next entry the sweeper visits */
  private cursor: Entry | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;

  private count = 0;
  private bytes = 0;
  private c = { hits: 0, misses: 0, sets: 0, dels: 0, evictions: 0, expired: 0, dropped: 0 };

  constructor(opts: MemoryStoreOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 256 * 1024 * 1024;
    this.maxEntries = opts.maxEntries ?? Infinity;
    if (!(this.maxBytes > 0) || !(this.maxEntries > 0)) throw new AwError('bad_request', 'maxBytes and maxEntries must be positive');
    this.oversize = opts.oversize ?? 'throw';
    this.sweepBatch = opts.sweepBatch ?? 10_000;
    this.now = opts.now ?? Date.now;
    const every = opts.sweepIntervalMs ?? 30_000;
    if (every > 0) {
      this.timer = setInterval(() => this.sweep(), every);
      this.timer.unref();
    }
  }

  async get<T = unknown>(ns: string, key: string): Promise<T | undefined> {
    const json = this.getJson(ns, key);
    return json === undefined ? undefined : fromJson<T>(json);
  }

  async set<T = unknown>(ns: string, key: string, value: T, ttlSec?: number): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    const exp = expiryFor(ttlSec, this.now());
    const json = toJson(value);
    if (json === undefined) return this.delSync(ns, key);
    this.setJson(ns, key, json, exp);
  }

  async del(ns: string, key: string): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    this.delSync(ns, key);
  }

  async keys(ns: string, prefix?: string, limit?: number): Promise<string[]> {
    this.live();
    checkNs(ns);
    const p = checkPrefix(prefix);
    const max = checkLimit(limit);
    const out: string[] = [];
    const space = this.spaces.get(ns);
    if (!space || max === 0) return out;
    const now = this.now();
    for (const [k, e] of space) {
      if (e.exp !== 0 && e.exp <= now) continue;
      if (p && !k.startsWith(p)) continue;
      out.push(k);
      if (out.length >= max) break;
    }
    return out;
  }

  stats(): Record<string, number> {
    return { entries: this.count, bytes: this.bytes, maxBytes: this.maxBytes, ...this.c };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.spaces.clear();
    this.head = this.tail = this.cursor = null;
    this.count = 0;
    this.bytes = 0;
  }

  // ───────────── synchronous core, also used by TieredStore ─────────────

  /** Returns the stored JSON text, or undefined; counts a hit or miss and refreshes recency. */
  getJson(ns: string, key: string): string | undefined {
    this.live();
    checkNsKey(ns, key);
    const e = this.spaces.get(ns)?.get(key);
    if (!e) {
      this.c.misses++;
      return undefined;
    }
    if (e.exp !== 0 && e.exp <= this.now()) {
      this.remove(e);
      this.c.expired++;
      this.c.misses++;
      return undefined;
    }
    this.c.hits++;
    if (e !== this.tail) {
      this.unlink(e);
      this.append(e);
    }
    return e.json;
  }

  /** Stores already-serialised JSON with an absolute expiry (0 = never). */
  setJson(ns: string, key: string, json: string, exp: number): void {
    this.live();
    const size = strBytes(key) + strBytes(json) + ENTRY_OVERHEAD;
    let space = this.spaces.get(ns);
    const old = space?.get(key);
    if (size > this.maxBytes) {
      if (old) this.remove(old);
      if (this.oversize === 'throw') {
        throw new AwError('too_large', `value of ${size} bytes exceeds the memory store bound of ${this.maxBytes}`);
      }
      this.c.dropped++;
      return;
    }
    this.c.sets++;
    if (old) {
      this.bytes += size - old.size;
      old.json = json;
      old.size = size;
      old.exp = exp;
      if (old !== this.tail) {
        this.unlink(old);
        this.append(old);
      }
    } else {
      if (!space) {
        space = new Map();
        this.spaces.set(ns, space);
      }
      const e: Entry = { ns, key, json, size, exp, prev: null, next: null };
      space.set(key, e);
      this.append(e);
      this.count++;
      this.bytes += size;
    }
    this.evict();
  }

  delSync(ns: string, key: string): void {
    const e = this.spaces.get(ns)?.get(key);
    if (e) {
      this.remove(e);
      this.c.dels++;
    }
  }

  /** Visits up to `sweepBatch` entries, dropping the expired ones. Returns how many were dropped. */
  sweep(): number {
    if (this.closed) return 0;
    const now = this.now();
    let e = this.cursor ?? this.head;
    let dropped = 0;
    for (let i = 0; e && i < this.sweepBatch; i++) {
      const next = e.next;
      if (e.exp !== 0 && e.exp <= now) {
        this.remove(e);
        this.c.expired++;
        dropped++;
      }
      e = next;
    }
    this.cursor = e;
    return dropped;
  }

  // ───────────── list plumbing ─────────────

  private evict(): void {
    while ((this.bytes > this.maxBytes || this.count > this.maxEntries) && this.head) {
      const victim = this.head;
      this.remove(victim);
      if (victim.exp !== 0 && victim.exp <= this.now()) this.c.expired++;
      else this.c.evictions++;
    }
  }

  private remove(e: Entry): void {
    const space = this.spaces.get(e.ns);
    if (space) {
      space.delete(e.key);
      if (space.size === 0) this.spaces.delete(e.ns);
    }
    this.unlink(e);
    this.count--;
    this.bytes -= e.size;
  }

  private append(e: Entry): void {
    e.prev = this.tail;
    e.next = null;
    if (this.tail) this.tail.next = e;
    else this.head = e;
    this.tail = e;
  }

  private unlink(e: Entry): void {
    if (this.cursor === e) this.cursor = e.next;
    if (e.prev) e.prev.next = e.next;
    else this.head = e.next;
    if (e.next) e.next.prev = e.prev;
    else this.tail = e.prev;
    e.prev = e.next = null;
  }

  private live(): void {
    if (this.closed) throw closedError('memory');
  }
}
