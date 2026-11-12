// Verb pack: site maps and crawling.
//
//   map('docs.example.com')            URLs from robots.txt sitemaps (indexes, .gz), else a bounded walk of same-origin links
//   map()                              the same for the site of the current page
//       depth=2 max=200 match='/docs/' save=1
//   each('words', crawl=1)             the existing each/collect, over the saved map's URLs instead of this page's links;
//   collect(name='link', crawl=1)      both end with a coverage receipt (visited/total, skipped with reasons)
//
// The map is kept in the store under the session id (not in the session record), so it costs nothing
// until used and goes away with the session's other state.

import type { RunCtx, RuntimeImpl } from '../runtime.ts';
import { normalizeUrl } from '../runtime.ts';
import type { Step } from '../dsl.ts';
import { estimateTokens } from '../tokens.ts';
import { AwError } from '../types.ts';
import { collectCrawl, eachCrawl, isCrawl, MAP_NS, type SavedMap } from './crawl.ts';
import { mapSite, renderMap, type MapOptions } from './map.ts';

export { parseRobots, parseSitemap } from './parse.ts';
export { mapSite, renderMap } from './map.ts';

const str = (a: unknown) => (a === undefined || a === null ? '' : String(a));
const truthy = (v: unknown) => v !== undefined && v !== false && v !== 0 && !/^(0|false|no|off)$/i.test(String(v));

export function register(rt: RuntimeImpl): void {
  rt.register('map', mapVerb);
  // wrap the existing verbs: crawl=1 takes the new path, everything else is untouched
  const each = rt.verbHandler('each');
  const collect = rt.verbHandler('collect');
  if (each) rt.register('each', (rc, step) => (isCrawl(step) ? eachCrawl(rc, step) : each(rc, step)));
  if (collect) rt.register('collect', (rc, step) => (isCrawl(step) ? collectCrawl(rc, step, collect) : collect(rc, step)));
}

function options(step: Step): MapOptions {
  const o = step.opts;
  const int = (v: unknown, d: number, lo: number, hi: number, name: string) => {
    if (v === undefined) return d;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw new AwError('bad_request', `map ${name} must be a whole number from ${lo} to ${hi}`);
    return v;
  };
  return {
    depth: int(o.depth, 2, 0, 4, 'depth'),
    max: int(o.max, 200, 1, 5000, 'max'),
    match: o.match === undefined ? undefined : str(o.match),
    maxFetches: int(o.fetches, 100, 1, 300, 'fetches'),
    maxMs: 45_000,
  };
}

async function mapVerb(rc: RunCtx, step: Step): Promise<void> {
  const arg = step.args.length ? str(step.args[0]).trim() : '';
  const here = rc.rec.page && /^https?:/.test(rc.rec.page.url) ? rc.rec.page.url : undefined;
  if (!arg && !here) throw new AwError('bad_request', "map needs a site: map('docs.example.com'), or open a page first", 'map() with no argument maps the site of the current page');
  const start = arg ? new URL(normalizeUrl(arg, here)) : new URL(here!);
  rc.outflow(start.pathname + start.search, start.origin);
  const seeds = arg ? [start.href] : [start.origin + '/', start.href];
  const map = await mapSite(rc, start.origin, seeds, options(step));
  // everything refused by the guard is an answer in itself, not an empty map
  if (!map.total && !map.files.length && map.skipped.policy) throw new AwError('policy', `the guard refused every request to ${map.origin}`, 'the address is not allowed by this agentweb\'s policy (AGENTWEB_ALLOW / AGENTWEB_DENY / private addresses)');
  if (truthy(step.opts.save)) {
    const saved: SavedMap = { origin: map.origin, urls: map.urls, total: map.total, complete: map.complete, skipped: map.skipped, source: map.source, match: map.match, at: map.at, notes: map.notes };
    await rc.rt.deps.store.set(MAP_NS, rc.rec.id, saved, rc.rt.opts.sessionTtlSec);
    map.notes.push(`saved ${map.urls.length} URLs: each('words', crawl=1) and collect(..., crawl=1) visit them`);
  } else if (map.urls.length) map.notes.push('map(save=1) keeps this list for each/collect(..., crawl=1)');
  rc.emit(renderMap(map, rc.remaining, estimateTokens));
}
