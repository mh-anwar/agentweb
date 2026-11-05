// The provider shape the orchestrator works with: the shared `SearchProvider` contract plus the
// routing metadata it needs. Plain `SearchProvider`s passed by callers are treated as web providers.

import type { SearchProvider, SearchResult } from '../types.ts';
import { cleanUrl } from './url.ts';
import { clip, decodeEntities } from './util.ts';
import { squash } from '../tree.ts';

export type Vertical = 'code' | 'qa' | 'wiki' | 'news';

export interface Provider extends SearchProvider {
  /** 'web' providers answer any query; verticals are added when the query suggests them */
  kind?: 'web' | Vertical;
  /** order among web providers (lower first). Keyed providers ~0, scrapers 10+, last resorts 50+. */
  rank?: number;
  /** providers sharing a backend or a rate limit (ddg + ddg-lite). A rate limit cools the whole family. */
  family?: string;
  /** domains a vertical covers natively, for `site:` routing */
  domains?: string[];
  /** reciprocal-rank-fusion weight (default 1 for web, 0.5 for verticals) */
  weight?: number;
  /** the backend understands `site:` itself; otherwise the orchestrator strips it and post-filters */
  siteOp?: boolean;
}

const MAX_SNIPPET = 480;

/** Normalise one raw hit into a `SearchResult`, or undefined if it is not a usable http(s) result. */
export function hit(source: string, title: string | undefined, url: string | undefined, snippet: string | undefined): SearchResult | undefined {
  if (!url) return undefined;
  const u = cleanUrl(decodeEntities(url));
  if (!/^https?:\/\//i.test(u)) return undefined;
  const t = squash(title ?? '');
  const s = squash(snippet ?? '');
  return { title: clip(t || u, 200), url: u, snippet: clip(s, MAX_SNIPPET), source };
}

/** Collect hits, dropping invalid ones and same-URL repeats within one provider's list. */
export function collect(source: string, n: number, raw: Iterable<[string | undefined, string | undefined, string | undefined]>): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const [t, u, s] of raw) {
    const r = hit(source, t, u, s);
    if (!r || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

export const env = (k: string): string | undefined => {
  const v = typeof process !== 'undefined' ? process.env[k] : undefined;
  return v && v.trim() ? v.trim() : undefined;
};
