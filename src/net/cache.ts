// Shared page cache over a Store (namespace "cache"). One origin fetch serves every agent that
// reads the same public page: fresh entries are served directly, stale ones are revalidated with
// If-None-Match / If-Modified-Since, and concurrent identical misses are coalesced into a single
// origin request (single-flight, per process).
//
// Only public responses are ever stored or shared: the engine only routes GETs that carried no
// cookies and no Authorization here, and this module refuses responses with Set-Cookie,
// Cache-Control private/no-store, Vary on anything but content negotiation, partial content and
// truncated or broken bodies.

import type { Store } from '../types.ts';
import { AwError } from '../types.ts';
import { isTextual, parseContentType, sniff } from './decode.ts';

/** One HTTP exchange as the wire engine sees it, before decoding. */
export interface RawHop {
  url: string;
  status: number;
  /** lower-case names; repeated headers joined with ', '; never contains set-cookie */
  headers: Record<string, string>;
  setCookie: string[];
  /** decompressed body bytes (possibly cut at the size limit) */
  body: Uint8Array;
  /** body was cut at the size limit */
  truncated?: boolean;
  /** the body ended in an error after `body.length` bytes */
  error?: AwError;
}

export interface CacheOptions {
  ns?: string;
  /** freshness when the origin gives no max-age / Expires (default 60 s) */
  heuristicTtlSec?: number;
  /** how long a stale entry with validators is kept for revalidation (default 1 h) */
  staleKeepSec?: number;
  /** larger bodies are not stored (default 4 MB) */
  maxEntryBytes?: number;
  /** clock in epoch ms (tests) */
  now?: () => number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  revalidated: number;
  coalesced: number;
  stored: number;
  uncacheable: number;
  bytesSaved: number;
  inflight: number;
}

export type Via = 'hit' | 'miss' | 'revalidated' | 'coalesced';

export interface PageCache {
  readonly store: Store;
  /** cache key for a URL and a request variant (Accept, Accept-Language, extra headers) */
  key(url: string, variant: string): string;
  /**
   * Serve one cacheable GET. `origin` performs the real request; it receives conditional headers
   * when a stale entry is being revalidated.
   */
  // revalidate forces an origin request, without coalescing navigation side effects.
  fetch(key: string, origin: (cond: Record<string, string>) => Promise<RawHop>, signal?: AbortSignal, revalidate?: boolean): Promise<{ hop: RawHop; via: Via }>;
  stats(): CacheStats;
}

interface Entry {
  /** url */
  u: string;
  /** status */
  s: number;
  h: Record<string, string>;
  /** body encoding: l = latin1 string (text), b = base64 (binary) */
  e: 'l' | 'b';
  d: string;
  /** stored at (ms) */
  at: number;
  /** fresh until (ms) */
  fu: number;
}

interface Flight {
  p: Promise<{ hop: RawHop; via: Via; share: boolean }>;
}

const HEURISTIC_STATUS = new Set([200, 203, 204, 300, 301, 308, 404, 405, 410, 414, 501]);
const OK_VARY = new Set(['accept', 'accept-encoding', 'accept-language', 'origin', 'user-agent']);

export function parseCacheControl(v: string | undefined): Map<string, string> {
  const m = new Map<string, string>();
  if (!v) return m;
  for (const part of v.split(',')) {
    const i = part.indexOf('=');
    const k = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    if (!k) continue;
    const val = i < 0 ? '' : part.slice(i + 1).trim().replace(/^"|"$/g, '');
    if (!m.has(k)) m.set(k, val);
  }
  return m;
}

const secs = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);

/** Can this response be shared with other agents at all (stored, or handed to coalesced waiters)? */
export function shareable(h: RawHop): boolean {
  if (h.setCookie.length) return false;
  if (h.error || h.status === 206) return false;
  const cc = parseCacheControl(h.headers['cache-control']);
  if (cc.has('private') || cc.has('no-store')) return false;
  const vary = h.headers.vary;
  if (vary) for (const f of vary.split(',')) if (!OK_VARY.has(f.trim().toLowerCase())) return false;
  if (h.headers['www-authenticate'] && h.status === 401) return false;
  return true;
}

/** Freshness lifetime in seconds for a response (undefined = must not be stored). */
export function lifetime(h: RawHop, heuristicSec: number, nowMs: number): number | undefined {
  const cc = parseCacheControl(h.headers['cache-control']);
  const validators = !!(h.headers.etag || h.headers['last-modified']);
  if (cc.has('no-cache')) return validators ? 0 : undefined;
  let life = secs(cc.get('s-maxage')) ?? secs(cc.get('max-age'));
  if (life === undefined && h.headers.expires !== undefined) {
    const exp = Date.parse(h.headers.expires);
    const date = h.headers.date ? Date.parse(h.headers.date) : nowMs;
    life = Number.isFinite(exp) ? Math.max(0, Math.floor((exp - (Number.isFinite(date) ? date : nowMs)) / 1000)) : 0; // invalid Expires = already expired
  }
  if (life === undefined) {
    if (!HEURISTIC_STATUS.has(h.status)) return undefined;
    life = heuristicSec;
  }
  if (cc.has('must-revalidate') || cc.has('proxy-revalidate')) { /* stale entries are always revalidated anyway */ }
  const age = secs(h.headers.age) ?? 0;
  const remaining = life - age;
  if (remaining <= 0 && !validators) return undefined;
  return Math.max(0, remaining);
}

export function createPageCache(store: Store, opts: CacheOptions = {}): PageCache {
  const ns = opts.ns ?? 'cache';
  const heuristic = opts.heuristicTtlSec ?? 60;
  const staleKeep = opts.staleKeepSec ?? 3600;
  const maxEntry = opts.maxEntryBytes ?? 4 * 1024 * 1024;
  const now = opts.now ?? Date.now;
  const flights = new Map<string, Flight>();
  const st = { hits: 0, misses: 0, revalidated: 0, coalesced: 0, stored: 0, uncacheable: 0, bytesSaved: 0 };

  const toHop = (e: Entry, t: number): RawHop => {
    const body = e.e === 'l' ? Buffer.from(e.d, 'latin1') : Buffer.from(e.d, 'base64');
    const headers = { ...e.h, age: String(Math.max(0, Math.floor((t - e.at) / 1000)) + (secs(e.h.age) ?? 0)) };
    return { url: e.u, status: e.s, headers, setCookie: [], body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) };
  };

  async function put(key: string, hop: RawHop, t: number): Promise<void> {
    const discard = async () => {
      st.uncacheable++;
      try { await store.del(ns, key); } catch { /* cache failures never fail a load */ }
    };
    if (!shareable(hop) || hop.truncated || hop.body.length > maxEntry) { await discard(); return; }
    const life = lifetime(hop, heuristic, t);
    if (life === undefined) { await discard(); return; }
    const validators = !!(hop.headers.etag || hop.headers['last-modified']);
    const ttl = Math.max(1, Math.ceil(life + (validators ? staleKeep : 0)));
    const text = isTextual(sniff(parseContentType(hop.headers['content-type']).mime, hop.body, hop.url));
    const buf = Buffer.from(hop.body.buffer, hop.body.byteOffset, hop.body.byteLength);
    const h = { ...hop.headers };
    delete h.age;
    const e: Entry = { u: hop.url, s: hop.status, h, e: text ? 'l' : 'b', d: buf.toString(text ? 'latin1' : 'base64'), at: t, fu: t + life * 1000 };
    // headers.age from the origin counts against freshness, already folded into `life`
    try {
      await store.set(ns, key, e, ttl);
      st.stored++;
    } catch {
      /* a failing cache store must never fail the page load */
    }
  }

  function race<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return p;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(
        (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }

  async function lead(key: string, entry: Entry | undefined, origin: (cond: Record<string, string>) => Promise<RawHop>) {
    const cond: Record<string, string> = {};
    if (entry?.h.etag) cond['if-none-match'] = entry.h.etag;
    if (entry?.h['last-modified']) cond['if-modified-since'] = entry.h['last-modified'];
    const hop = await origin(cond);
    const t = now();
    if (hop.status === 304 && entry) {
      // merge the 304's headers into the stored response and refresh its freshness
      const merged: RawHop = { ...toHop(entry, t), headers: { ...entry.h } };
      for (const [k, v] of Object.entries(hop.headers)) {
        if (k === 'content-length' || k === 'content-encoding' || k === 'transfer-encoding' || k === 'content-type') continue;
        merged.headers[k] = v;
      }
      merged.setCookie = hop.setCookie;
      st.revalidated++;
      st.bytesSaved += merged.body.length;
      await put(key, merged, t);
      return { hop: merged, via: 'revalidated' as Via, share: shareable(merged) };
    }
    st.misses++;
    await put(key, hop, t);
    return { hop, via: 'miss' as Via, share: shareable(hop) && !hop.truncated };
  }

  async function fetchCached(key: string, origin: (cond: Record<string, string>) => Promise<RawHop>, signal?: AbortSignal, revalidate = false, depth = 0): Promise<{ hop: RawHop; via: Via }> {
    let f = revalidate ? undefined : flights.get(key);
    let entry: Entry | undefined;
    if (!f) {
      try { entry = await store.get<Entry>(ns, key); } catch { entry = undefined; }
      const t = now();
      if (entry && entry.fu > t && !revalidate) {
        st.hits++;
        st.bytesSaved += entry.d.length * (entry.e === 'b' ? 0.75 : 1);
        return { hop: toHop(entry, t), via: 'hit' };
      }
      f = revalidate ? undefined : flights.get(key); // another caller may have become leader while we awaited the store
    }
    if (f) {
      let r: Awaited<Flight['p']>;
      try {
        r = await race(f.p, signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        // the leader was aborted by its own caller: try again ourselves
        if (depth < 2 && isAbort(e)) return fetchCached(key, origin, signal, revalidate, depth + 1);
        throw e;
      }
      if (r.share) {
        st.coalesced++;
        st.bytesSaved += r.hop.body.length;
        return { hop: r.hop, via: 'coalesced' };
      }
      // the leader's response was personal (Set-Cookie, private): fetch our own copy
      const hop = await origin({});
      st.misses++;
      return { hop, via: 'miss' };
    }
    // Navigations must each reach the origin, even when identical requests overlap.
    if (revalidate) {
      const r = await lead(key, entry, origin);
      return { hop: r.hop, via: r.via };
    }
    const flight: Flight = { p: lead(key, entry, origin) };
    flights.set(key, flight);
    try {
      const r = await flight.p;
      return { hop: r.hop, via: r.via };
    } finally {
      flights.delete(key);
    }
  }

  return {
    store,
    key(url: string, variant: string): string {
      const i = url.indexOf('#');
      return `${i < 0 ? url : url.slice(0, i)} ${variant}`;
    },
    fetch: (key, origin, signal, revalidate) => fetchCached(key, origin, signal, revalidate),
    stats(): CacheStats {
      return { ...st, bytesSaved: Math.round(st.bytesSaved), inflight: flights.size };
    },
  };
}

function isAbort(e: unknown): boolean {
  if (e instanceof AwError) return e.code === 'timeout';
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
}
