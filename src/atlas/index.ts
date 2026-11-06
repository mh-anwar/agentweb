// Atlas: what the fleet has learned about each origin.
//
// Only facts the runtime itself observed are stored (which tier worked, GET search forms, feed links,
// markdown support); never text an agent wrote. Learning is write-behind: observe() only touches memory,
// flush() merges per-origin deltas into the shared Store, so any number of workers can feed one atlas
// and a lost race only loses a few counts.

import type { Atlas, AtlasEvent, FormDef, SiteInfo, Store, Tier } from '../types.ts';

const NS = 'atlas';
const TIERS: Tier[] = ['wire', 'ghost', 'chrome'];
const SEARCH_NAMES = new Set(['q', 'query', 'search', 's', 'k', 'keyword', 'keywords', 'term', 'text', 'p', 'wd', 'search_query', 'searchterm']);
const FEED_TYPES = /^application\/(rss|atom|feed)\+xml$|^application\/(feed\+)?json$/i;
const TEXT_TYPES = new Set(['text', 'search', '']);

/** Per-tier outcome counts. Counts are decayed so a site that changes is re-learned. */
interface TierStat {
  ok: number;
  fail: number;
}

/** What is persisted per origin. */
export interface SiteRecord {
  origin: string;
  tiers: Partial<Record<Tier, TierStat>>;
  search?: string;
  md?: boolean;
  feeds?: string[];
  updated: number;
}

interface Pending {
  tiers: Partial<Record<Tier, TierStat>>;
  search?: string;
  md?: boolean;
  feeds?: string[];
}

export interface AtlasOptions {
  /** how long a cached site record is trusted before re-reading the store (ms) */
  readTtlMs?: number;
  /** origins kept in memory */
  maxOrigins?: number;
  /** flush automatically once this many origins are dirty */
  flushAt?: number;
  /** also flush on a timer (ms); 0 disables. The timer never keeps the process alive. */
  flushEveryMs?: number;
  /** store TTL for site records (s) */
  ttlSec?: number;
  /** counts are multiplied by this on each merge, once they pass `decayAbove` total */
  decay?: number;
  decayAbove?: number;
  now?: () => number;
}

export function createAtlas(store: Store, opts: AtlasOptions = {}): AtlasImpl {
  return new AtlasImpl(store, opts);
}

export class AtlasImpl implements Atlas {
  private cache = new Map<string, { rec: SiteRecord | undefined; at: number }>();
  private pending = new Map<string, Pending>();
  private timer?: ReturnType<typeof setInterval>;
  private flushing?: Promise<void>;
  private readonly o: Required<AtlasOptions>;
  private store: Store;

  constructor(store: Store, opts: AtlasOptions) {
    this.store = store;
    this.o = {
      readTtlMs: 30_000,
      maxOrigins: 10_000,
      flushAt: 64,
      flushEveryMs: 5_000,
      ttlSec: 30 * 24 * 3600,
      decay: 0.5,
      decayAbove: 40,
      now: Date.now,
      ...opts,
    };
    if (this.o.flushEveryMs > 0) {
      this.timer = setInterval(() => void this.flush().catch(() => {}), this.o.flushEveryMs);
      this.timer.unref?.();
    }
  }

  async site(origin: string): Promise<SiteInfo | undefined> {
    const key = normOrigin(origin);
    if (!key) return undefined;
    const now = this.o.now();
    const hit = this.cache.get(key);
    let rec: SiteRecord | undefined;
    if (hit && now - hit.at < this.o.readTtlMs) rec = hit.rec;
    else {
      rec = sane(await this.store.get<SiteRecord>(NS, key).catch(() => undefined));
      this.remember(key, rec);
    }
    // what this worker learned but has not written yet counts too
    const p = this.pending.get(key);
    if (p) rec = merge(rec, key, p, now, 1, Infinity);
    return rec ? toInfo(rec) : undefined;
  }

  observe(ev: AtlasEvent): void {
    try {
      const key = normOrigin(ev.origin);
      if (!key) return;
      const p = this.pend(key);
      switch (ev.type) {
        case 'load': {
          if (!TIERS.includes(ev.tier)) return;
          const s = (p.tiers[ev.tier] ??= { ok: 0, fail: 0 });
          if (ev.ok) s.ok++;
          else s.fail++;
          break;
        }
        case 'forms': {
          const t = searchTemplate(ev.forms, key);
          if (t) p.search = t;
          break;
        }
        case 'meta': {
          if (ev.markdown) p.md = true;
          const feeds = feedLinks(ev.links, ev.url, key);
          if (feeds.length) p.feeds = [...new Set([...(p.feeds ?? []), ...feeds])].slice(0, 5);
          break;
        }
      }
      if (this.pending.size >= this.o.flushAt) void this.flush().catch(() => {});
    } catch {
      // learning must never break a run
    }
  }

  /** Write every dirty origin. Concurrent calls share one pass. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => (this.pending.size ? this.flush() : undefined));
    if (!this.pending.size) return Promise.resolve();
    const batch = this.pending;
    this.pending = new Map();
    this.flushing = (async () => {
      const now = this.o.now();
      await Promise.all(
        [...batch].map(async ([key, p]) => {
          try {
            const cur = sane(await this.store.get<SiteRecord>(NS, key));
            const next = merge(cur, key, p, now, this.o.decay, this.o.decayAbove);
            await this.store.set(NS, key, next, this.o.ttlSec);
            this.remember(key, next);
          } catch {
            // store unavailable: drop this batch rather than grow without bound
          }
        }),
      );
    })().finally(() => {
      this.flushing = undefined;
    });
    return this.flushing;
  }

  /** Stop the timer and write what is left. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  private pend(key: string): Pending {
    let p = this.pending.get(key);
    if (!p) this.pending.set(key, (p = { tiers: {} }));
    return p;
  }

  private remember(key: string, rec: SiteRecord | undefined): void {
    this.cache.delete(key);
    this.cache.set(key, { rec, at: this.o.now() });
    if (this.cache.size > this.o.maxOrigins) this.cache.delete(this.cache.keys().next().value!);
  }
}

// ───────────────────────────── pure helpers (exported for tests) ─────────────────────────────

export function normOrigin(origin: string): string | undefined {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** Merge pending deltas into a stored record. */
export function merge(cur: SiteRecord | undefined, origin: string, p: Pending, now: number, decay: number, decayAbove: number): SiteRecord {
  const out: SiteRecord = { origin, tiers: {}, updated: now };
  for (const t of TIERS) {
    const a = cur?.tiers[t];
    const b = p.tiers[t];
    if (!a && !b) continue;
    let ok = (a?.ok ?? 0) + (b?.ok ?? 0);
    let fail = (a?.fail ?? 0) + (b?.fail ?? 0);
    if (ok + fail > decayAbove) {
      ok *= decay;
      fail *= decay;
    }
    out.tiers[t] = { ok: round(ok), fail: round(fail) };
  }
  const search = p.search ?? cur?.search;
  if (search) out.search = search;
  if (p.md || cur?.md) out.md = true;
  const feeds = [...new Set([...(p.feeds ?? []), ...(cur?.feeds ?? [])])].slice(0, 5);
  if (feeds.length) out.feeds = feeds;
  return out;
}

/** The cheapest tier that has reliably worked, with confidence = smoothed success rate. */
export function bestTier(tiers: SiteRecord['tiers']): { tier: Tier; conf: number } | undefined {
  for (const t of TIERS) {
    const s = tiers[t];
    if (!s) continue;
    const n = s.ok + s.fail;
    if (n === 0) continue;
    // Laplace smoothing with a prior of one failure: a single success gives 0.5, not certainty
    const conf = s.ok / (n + 1);
    if (conf >= 0.5) return { tier: t, conf: round(conf) };
  }
  return undefined;
}

export function toInfo(rec: SiteRecord): SiteInfo {
  const info: SiteInfo = { origin: rec.origin, updated: rec.updated };
  const b = bestTier(rec.tiers);
  if (b) {
    info.tier = b.tier;
    info.tierConf = b.conf;
  }
  if (rec.search) info.search = rec.search;
  if (rec.md) info.md = true;
  if (rec.feeds?.length) info.feeds = rec.feeds;
  return info;
}

/**
 * A site search URL template from a GET form on the page: one visible text field that looks like a
 * query box, any hidden fields kept, and an action on the same origin. Returns e.g.
 * "https://example.com/search?q={q}".
 */
export function searchTemplate(forms: FormDef[], origin: string): string | undefined {
  let best: { url: string; score: number } | undefined;
  for (const f of forms) {
    if (f.method !== 'GET' || f.js) continue;
    let action: URL;
    try {
      action = new URL(f.action);
    } catch {
      continue;
    }
    if (action.origin !== origin) continue;
    const live = f.fields.filter((x) => !x.disabled && x.name);
    const texts = live.filter((x) => TEXT_TYPES.has(x.type.toLowerCase()));
    if (texts.length !== 1) continue;
    // forms with passwords, choices or several inputs are not search boxes
    if (live.some((x) => /^(password|email|tel|file|textarea|select|radio|checkbox)$/i.test(x.type))) continue;
    const q = texts[0];
    let score = 0;
    if (q.type.toLowerCase() === 'search') score += 2;
    if (SEARCH_NAMES.has(q.name.toLowerCase())) score += 2;
    if (/search|find|query/i.test(`${q.label ?? ''} ${action.pathname}`)) score += 1;
    if (score < 2) continue;
    const params = new URLSearchParams();
    for (const x of live) {
      if (x === q) continue;
      if (x.type.toLowerCase() === 'hidden') params.append(x.name, x.value);
    }
    action.search = '';
    action.hash = '';
    const rest = params.toString();
    const url = `${action.href}?${rest ? `${rest}&` : ''}${encodeURIComponent(q.name)}={q}`;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url;
}

export function feedLinks(links: { rel: string; href: string; type?: string }[], base: string, origin: string): string[] {
  const out: string[] = [];
  for (const l of links ?? []) {
    if (!/\balternate\b/i.test(l.rel) || !l.type || !FEED_TYPES.test(l.type)) continue;
    try {
      const u = new URL(l.href, base);
      if (u.origin === origin) out.push(u.href);
    } catch {
      // ignore
    }
  }
  return out;
}

function sane(r: SiteRecord | undefined): SiteRecord | undefined {
  if (!r || typeof r !== 'object' || typeof r.origin !== 'string' || typeof r.tiers !== 'object' || !r.tiers) return undefined;
  return r;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
