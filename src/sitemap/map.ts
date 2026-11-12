// Mapping a site: its sitemaps if it has them, else a bounded breadth-first walk of same-origin links.
// Everything here fetches through the wire engine (the guard checks every URL and redirect hop), asks
// the guard before each fetch, respects robots.txt, and stops at a per-run cap on fetches and time.

import type { RunCtx } from '../runtime.ts';
import { AwError, type Act, type Loaded } from '../types.ts';
import { inflateSitemap, parseRobots, parseSitemap, type Robots } from './parse.ts';

export interface MapOptions {
  /** link hops the walk follows from its start page */
  depth: number;
  /** URLs kept in the result */
  max: number;
  /** only URLs whose path+query contain this text ('*' is a wildcard) */
  match?: string;
  /** most pages fetched by one walk, and most sitemap files read */
  maxFetches: number;
  /** wall-clock limit for the whole map, ms */
  maxMs: number;
}

export interface SiteMap {
  origin: string;
  /** kept URLs, at most `max` */
  urls: string[];
  /** how many matching URLs were found (>= urls.length) */
  total: number;
  source: 'sitemap' | 'walk' | 'none';
  /** sitemap files read, or pages fetched by the walk */
  files: string[];
  /** everything reachable was seen: no cap, depth limit, time limit or error cut the map short */
  complete: boolean;
  /** why URLs or pages were left out: robots, policy, other_origin, error, ... -> count */
  skipped: Record<string, number>;
  notes: string[];
  match?: string;
  /** directory prefixes with counts: '/docs/' and '/docs/api/' (not saved with the session) */
  tree: [string, number][];
  at: number;
}

export const SITEMAP_FILE_CAP = 30;
/** URLs counted for the tree and total; beyond it the map says so instead of growing without bound */
const TOTAL_CAP = 100_000;
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|svg|ico|avif|bmp|css|js|mjs|map|json|xml|woff2?|ttf|eot|mp[34]|webm|mov|avi|zip|gz|tgz|tar|rar|7z|dmg|exe|pdf|docx?|xlsx?|pptx?)(?:\?|$)/i;

const bump = (o: Record<string, number>, k: string, by = 1) => void (o[k] = (o[k] ?? 0) + by);

function matcher(match?: string): (u: URL) => boolean {
  if (!match) return () => true;
  const m = match.toLowerCase();
  if (m.includes('*')) {
    const re = new RegExp(m.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
    return (u) => re.test((u.pathname + u.search).toLowerCase());
  }
  return (u) => (u.pathname + u.search).toLowerCase().includes(m);
}

/** '/docs/api/x?y=1' -> ['/docs/', '/docs/api/']: the directories above the page */
export function prefixes(u: URL): string[] {
  const segs = u.pathname.split('/').filter(Boolean);
  if (!u.pathname.endsWith('/')) segs.pop();
  const out = ['/'];
  let acc = '/';
  for (const s of segs.slice(0, 2)) out.push((acc += s + '/'));
  return out;
}

export function cleanUrl(href: string, base: string): URL | undefined {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    u.hash = '';
    return u;
  } catch {
    return undefined;
  }
}

interface Fetched {
  loaded: Loaded;
  text?: string;
}

export async function mapSite(rc: RunCtx, origin: string, seeds: string[], o: MapOptions): Promise<SiteMap> {
  const t0 = Date.now();
  const skipped: Record<string, number> = {};
  const notes: string[] = [];
  const state = { fetches: 0, cutShort: false };
  const wire = rc.engine('wire');
  const anon = () => ({ ...rc.ctx, jar: rc.rt.deps.createJar([]) });
  const timeUp = () => Date.now() - t0 > o.maxMs || !!rc.ctx.signal?.aborted;
  const accept = matcher(o.match);

  const map: SiteMap = { origin, urls: [], total: 0, source: 'none', files: [], complete: false, skipped, notes, match: o.match, tree: [], at: Date.now() };
  const kept = new Set<string>();
  /** every same-origin, robots-allowed URL seen (matching or not) */
  const known = new Set<string>();
  const treeCount = new Map<string, number>();
  let robots: Robots = parseRobots('');

  /** guarded fetch of one URL; undefined (and a reason counted) when it cannot be had */
  async function fetchOne(url: string, jar: 'anon' | 'session'): Promise<Fetched | undefined> {
    if (state.fetches >= o.maxFetches) {
      state.cutShort = true;
      bump(skipped, 'fetch_cap');
      return undefined;
    }
    try {
      const v = await rc.guard.checkStep({ verb: 'open', origin, dest: url, method: 'GET' });
      if (!v.ok) {
        bump(skipped, 'policy');
        return undefined;
      }
      state.fetches++;
      rc.fetches++;
      const loaded = await wire.open(jar === 'anon' ? anon() : { ...rc.ctx }, { url, read: true });
      return { loaded, text: loaded.body?.text };
    } catch (e) {
      if (rc.ctx.signal?.aborted) throw e;
      bump(skipped, e instanceof AwError && e.code === 'policy' ? 'policy' : 'error');
      return undefined;
    }
  }

  /** put a discovered URL in the result if it is ours, allowed and matching */
  function admit(href: string, base: string): URL | undefined {
    const u = cleanUrl(href, base);
    if (!u) return undefined;
    if (u.origin !== map.origin) {
      bump(skipped, 'other_origin');
      return undefined;
    }
    if (!robots.allows(u.pathname + u.search)) {
      bump(skipped, 'robots');
      return undefined;
    }
    const key = u.href;
    if (known.has(key)) return u;
    known.add(key);
    if (!accept(u)) return u;
    if (map.total >= TOTAL_CAP) {
      state.cutShort = true;
      return u;
    }
    map.total++;
    for (const p of prefixes(u)) treeCount.set(p, (treeCount.get(p) ?? 0) + 1);
    if (map.urls.length < o.max) {
      map.urls.push(key);
      kept.add(key);
    }
    return u;
  }

  /** a page that turned out to be an error is not part of the site's map */
  function drop(u: URL): void {
    const key = u.href;
    const at = map.urls.indexOf(key);
    if (at >= 0) map.urls.splice(at, 1);
    if (kept.delete(key)) {
      map.total--;
      for (const p of prefixes(u)) treeCount.set(p, (treeCount.get(p) ?? 1) - 1);
    } else if (known.has(key) && accept(u)) {
      map.total--;
      for (const p of prefixes(u)) treeCount.set(p, (treeCount.get(p) ?? 1) - 1);
    }
  }

  // ── robots.txt ──
  const robotsRes = await fetchOne(origin + '/robots.txt', 'anon');
  if (robotsRes) {
    const finalOrigin = new URL(robotsRes.loaded.url).origin;
    if (finalOrigin !== origin) {
      notes.push(`${origin} redirects to ${finalOrigin}; mapped that`);
      map.origin = origin = finalOrigin;
    }
    if (robotsRes.loaded.status === 200 && robotsRes.text && !/^\s*</.test(robotsRes.text)) robots = parseRobots(robotsRes.text);
  }

  // ── sitemaps ──
  const queue = robots.sitemaps.length ? [...robots.sitemaps] : [origin + '/sitemap.xml'];
  const declared = robots.sitemaps.length > 0;
  const seenFiles = new Set<string>();
  let sitemapErrors = 0;
  while (queue.length && !timeUp()) {
    const url = queue.shift()!;
    if (seenFiles.has(url)) continue;
    seenFiles.add(url);
    if (map.files.length >= SITEMAP_FILE_CAP) {
      state.cutShort = true;
      notes.push(`stopped after ${SITEMAP_FILE_CAP} sitemap files`);
      break;
    }
    const f = await fetchOne(url, 'anon');
    if (!f || f.loaded.status !== 200) {
      // a missing /sitemap.xml that nothing declared is normal; a declared one that fails is not
      if (declared) sitemapErrors++;
      continue;
    }
    const text = f.text ?? (f.loaded.body?.bytes ? inflateSitemap(f.loaded.body.bytes) : undefined);
    const doc = text ? parseSitemap(text) : undefined;
    if (!doc) {
      if (declared) sitemapErrors++;
      continue;
    }
    map.files.push(url);
    if (doc.kind === 'index') {
      for (const loc of doc.locs) {
        const u = cleanUrl(loc, url);
        if (u && u.origin === origin) queue.push(u.href);
        else bump(skipped, 'other_origin');
      }
    } else for (const loc of doc.locs) admit(loc, url);
  }
  if (map.files.length) {
    map.source = 'sitemap';
    map.complete = !state.cutShort && !sitemapErrors && !timeUp() && map.total <= map.urls.length && !queue.length;
    if (timeUp() && queue.length) notes.push('stopped at the time limit');
  }

  // ── no sitemap: walk ──
  if (!map.files.length) {
    map.source = 'walk';
    await walk();
  }
  if (map.total > map.urls.length) notes.push(`${map.total} URLs found, the first ${map.urls.length} kept (raise max to keep more)`);
  if (map.total >= TOTAL_CAP) notes.push(`counting stopped at ${TOTAL_CAP} URLs`);
  map.tree = [...treeCount.entries()];
  if (map.source === 'walk' && !map.total) map.source = 'none';
  return map;

  async function walk(): Promise<void> {
    const fetched = new Set<string>();
    let level = seeds.map((s) => cleanUrl(s, origin + '/')).filter((u): u is URL => !!u && u.origin === origin);
    for (const u of level) if (!robots.allows(u.pathname + u.search)) bump(skipped, 'robots');
    level = level.filter((u) => robots.allows(u.pathname + u.search));
    let cutShort = false;
    for (let hop = 0; hop <= o.depth && level.length; hop++) {
      const next: URL[] = [];
      const todo = level.filter((u) => !fetched.has(u.href) && !BINARY_EXT.test(u.pathname));
      let at = 0;
      const worker = async () => {
        for (;;) {
          if (timeUp() || map.urls.length >= o.max) {
            cutShort = true;
            return;
          }
          const u = todo[at++];
          if (!u) return;
          fetched.add(u.href);
          const f = await fetchOne(u.href, 'session');
          if (!f) continue;
          if (f.loaded.status >= 400) {
            bump(skipped, 'http_error');
            drop(u);
            continue;
          }
          map.files.push(u.href);
          admit(u.href, origin); // a seed counts once it has answered
          if (!f.loaded.doc) continue;
          let page;
          try {
            page = await rc.toPage(f.loaded, 'wire');
          } catch {
            bump(skipped, 'error');
            continue;
          }
          if (page.shell) bump(skipped, 'javascript_required');
          for (const b of page.blocks) {
            for (const x of b.i) {
              if (typeof x === 'string' || (x as Act).k !== 'link' || !(x as Act).href) continue;
              const nu = admit((x as Act).href!, page.url);
              if (nu && !fetched.has(nu.href) && nu.origin === origin) {
                if (!next.some((n) => n.href === nu.href)) next.push(nu);
              }
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, Math.max(1, todo.length)) }, worker));
      if (cutShort || state.cutShort) break;
      level = next.filter((u) => !fetched.has(u.href));
    }
    // complete only when every discovered page that could be fetched was
    const unfetched = [...known].filter((u) => !fetched.has(u) && !BINARY_EXT.test(new URL(u).pathname));
    map.complete = !cutShort && !state.cutShort && !timeUp() && !unfetched.length && map.total <= map.urls.length && !skipped.error && !skipped.javascript_required;
    if (!map.complete) {
      if (state.cutShort) notes.push(`stopped at ${o.maxFetches} fetches`);
      else if (timeUp()) notes.push('stopped at the time limit');
      else if (unfetched.length) notes.push(`${unfetched.length} found URLs were not opened (depth ${o.depth}; raise depth)`);
    }
    if (skipped.javascript_required) notes.push('some pages need JavaScript, so their links are not in this map');
  }
}

// ───────────────────────────── rendering ─────────────────────────────

/** A compact tree by path prefix with counts, then as many URLs as fit. Paths are relative to the origin. */
export function renderMap(map: SiteMap, budgetTokens: number, estimate: (s: string) => number, listMax = 30): string {
  const src = map.source === 'sitemap' ? `sitemap (${map.files.length} file${map.files.length === 1 ? '' : 's'})` : map.source === 'walk' ? `links (${map.files.length} page${map.files.length === 1 ? '' : 's'} read)` : 'nothing found';
  const out: string[] = [`map of ${map.origin}: ${map.total} URL${map.total === 1 ? '' : 's'} from ${src}${map.match ? `, matching '${map.match}'` : ''}${map.complete ? '' : ' (not everything: see notes)'}`];
  const dirs = new Map(map.tree);
  const l1 = [...dirs.keys()].filter((k) => k !== '/' && k.split('/').length === 3).sort((a, b) => dirs.get(b)! - dirs.get(a)! || a.localeCompare(b));
  if (map.total) {
    const files = map.total - l1.reduce((n, k) => n + dirs.get(k)!, 0);
    if (files > 0) out.push(`/ ${files}`);
    for (const k of l1.slice(0, 12)) {
      out.push(`${k} ${dirs.get(k)}`);
      if (dirs.get(k)! >= 5) {
        const kids = [...dirs.keys()].filter((c) => c.startsWith(k) && c.split('/').length === 4).sort((a, b) => dirs.get(b)! - dirs.get(a)! || a.localeCompare(b));
        for (const c of kids.slice(0, 4)) out.push(`  ${c} ${dirs.get(c)}`);
        const rest = kids.slice(4).reduce((n, c) => n + dirs.get(c)!, 0);
        if (rest) out.push(`  … ${rest} more in ${kids.length - 4} other folders`);
      }
    }
    if (l1.length > 12) out.push(`… ${l1.slice(12).reduce((n, k) => n + dirs.get(k)!, 0)} more in ${l1.length - 12} other folders`);
  }
  let left = budgetTokens - estimate(out.join('\n')) - 60;
  const list: string[] = [];
  for (const u of map.urls.slice(0, listMax)) {
    const x = new URL(u);
    const line = x.pathname + x.search;
    const cost = estimate(line) + 1;
    if (cost > left) break;
    left -= cost;
    list.push(line);
  }
  if (list.length) out.push(`first ${list.length}:`, ...list);
  const hidden = map.urls.length - list.length;
  if (hidden > 0) out.push(`… ${hidden} more kept; map(match='/folder/') narrows, map(save=1) keeps the list for each/collect(crawl=1)`);
  const sk = Object.entries(map.skipped).map(([k, v]) => `${k} ${v}`).join(', ');
  if (sk) out.push(`left out: ${sk}`);
  for (const n of map.notes) out.push(`note: ${n}`);
  return out.join('\n');
}
