// each(..., crawl=1) and collect(..., crawl=1): the same verbs, run over the URLs of the session's
// saved map (map(save=1)) instead of the links on the current page, with a coverage receipt that
// says how much of the map was visited and why the rest was not.

import { compareCollection, type CollectionSnapshot } from '../extract/compare.ts';
import { bestLines } from '../extract/index.ts';
import type { CollectedRow, Selector } from '../extract/collect.ts';
import type { Step } from '../dsl.ts';
import { terms } from '../render.ts';
import { flagInjections, type RunCtx, type VerbHandler } from '../runtime.ts';
import { estimateTokens } from '../tokens.ts';
import { AwError, type Page } from '../types.ts';
import type { SiteMap } from './map.ts';

export const MAP_NS = 'map';

/** what map(save=1) keeps for the session */
export type SavedMap = Pick<SiteMap, 'origin' | 'urls' | 'total' | 'complete' | 'skipped' | 'source' | 'match' | 'at' | 'notes'>;

const str = (a: unknown) => (a === undefined || a === null ? '' : String(a));
const num = (a: unknown, d: number) => (typeof a === 'number' && Number.isFinite(a) ? a : d);
const truthy = (v: unknown) => v !== undefined && v !== false && v !== 0 && !/^(0|false|no|off)$/i.test(String(v));

export const isCrawl = (step: Step): boolean => truthy(step.opts.crawl) || str(step.opts.from).toLowerCase() === 'map';

export async function loadMap(rc: RunCtx): Promise<SavedMap> {
  const m = await rc.rt.deps.store.get<SavedMap>(MAP_NS, rc.rec.id);
  if (!m || !m.urls?.length) throw new AwError('bad_request', 'there is no saved map in this session' + (m ? ' (the saved one is empty)' : ''), "run map('site.example', save=1) first; then each/collect(..., crawl=1) visit its URLs");
  return m;
}

type Reasons = Record<string, number>;
const bump = (o: Reasons, k: string) => void (o[k] = (o[k] ?? 0) + 1);
const pathOf = (u: string) => {
  const x = new URL(u);
  return x.pathname + x.search;
};

/** One mapped URL read over plain HTTP. Mirrors each(): guard check, shared cache, injection flags. */
async function readUrl(rc: RunCtx, url: string): Promise<{ page?: Page; reason?: string; message?: string }> {
  try {
    const v = await rc.guard.checkStep({ verb: 'open', origin: new URL(url).origin, dest: url, method: 'GET' });
    if (!v.ok) return { reason: 'policy', message: v.reason ?? 'refused' };
    const loaded = await rc.engine('wire').open({ ...rc.ctx }, { url, read: true });
    rc.fetches++;
    const page = await rc.toPage(loaded, 'wire');
    flagInjections(page, rc.rt.deps.scoreInjection);
    if (page.shell || loaded.escalate) return { page, reason: 'javascript_required' };
    if (page.status >= 400) return { page, reason: 'http_error', message: `HTTP ${page.status}` };
    return { page };
  } catch (e) {
    if (rc.ctx.signal?.aborted) throw e;
    return { reason: e instanceof AwError && e.code === 'policy' ? 'policy' : 'error', message: (e as Error).message };
  }
}

// ───────────────────────────── each ─────────────────────────────

export async function eachCrawl(rc: RunCtx, step: Step): Promise<void> {
  const map = await loadMap(rc);
  const words = str(step.args[0]);
  const query = str(step.opts.find ?? step.args[1]);
  const n = Math.max(1, Math.min(40, num(step.opts.n, 8)));
  const q = [...new Set(terms(words))];
  const candidates = q.length ? map.urls.filter((u) => {
    const have = new Set(terms(decodeURIComponent(pathOf(u))));
    return q.every((w) => have.has(w));
  }) : map.urls;
  const visit = candidates.slice(0, n);
  const skipped: Reasons = {};
  if (candidates.length > visit.length) skipped.limit = candidates.length - visit.length;
  if (!visit.length) {
    rc.emit(`no mapped URL matches '${words}' (${map.urls.length} in the saved map)\n${JSON.stringify({ coverage: { complete: false, scope: 'saved map', visited: 0, total: 0, mapped: map.urls.length, skipped } })}`);
    return;
  }
  const per = Math.max(60, Math.floor((rc.remaining - 120) / visit.length));
  const results: string[] = new Array(visit.length);
  let visited = 0;
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= visit.length) return;
      const url = visit[i];
      const label = pathOf(url);
      const r = await readUrl(rc, url);
      if (r.reason) bump(skipped, r.reason);
      if (!r.page || r.reason === 'javascript_required') {
        results[i] = `## ${label}\n${r.reason === 'javascript_required' ? '(needs JavaScript; open it to read it in a browser)' : `✗ ${r.message}`}`;
        continue;
      }
      if (r.reason) {
        results[i] = `## ${label} ${r.page.title}\n✗ ${r.message}`;
        continue;
      }
      visited++;
      const title = r.page.title || label;
      const ls = bestLines(r.page, query, per - estimateTokens(title) - 8);
      results[i] = `## ${label} ${title}\n${ls.length ? ls.join('\n') : query ? `no match for '${query}'` : '(no text)'}`;
      rc.guard.observe(new URL(r.page.url).origin, ls.join('\n'), rc.jar.has(r.page.url));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, visit.length) }, worker));
  const coverage = {
    complete: visited === candidates.length && map.complete && Object.keys(skipped).length === 0,
    scope: 'saved map',
    visited,
    total: candidates.length,
    mapped: map.urls.length,
    mapComplete: map.complete,
    skipped,
  };
  rc.emit(`${visit.length} of ${candidates.length} mapped page${candidates.length === 1 ? '' : 's'}${query ? `, lines matching '${query}'` : ''}:\n${results.join('\n')}\n${JSON.stringify({ coverage })}`);
}

// ───────────────────────────── collect ─────────────────────────────

interface PageResult {
  schema: Record<string, Selector>;
  rows: CollectedRow[];
  coverage: { complete: boolean; stop: string; found: number; duplicates: number; invalid: number; omitted: number; truncated: boolean; sources: { url: string; records: number }[] };
}

const CRAWL_MS = 60_000;

/**
 * Run the ordinary collect() on each mapped URL in turn, take each page's result out of the output,
 * and report one merged result. Using collect itself keeps the field rules, evidence, money parsing
 * and redaction identical to the single-page form.
 */
export async function collectCrawl(rc: RunCtx, step: Step, collect: VerbHandler): Promise<void> {
  const map = await loadMap(rc);
  const cap = Math.max(1, Math.min(100, num(step.opts.max, 20)));
  const opts = { ...step.opts };
  for (const k of ['crawl', 'from', 'max']) delete opts[k];
  const diff = opts.diff;
  const key = opts.key;
  delete opts.diff;
  delete opts.key;
  const visit = map.urls.slice(0, cap);
  const skipped: Reasons = {};
  if (map.urls.length > visit.length) skipped.limit = map.urls.length - visit.length;

  const rows: CollectedRow[] = [];
  const seen = new Set<string>();
  const sources: { url: string; records: number }[] = [];
  let schema: Record<string, Selector> | undefined;
  let visited = 0;
  let found = 0;
  let duplicates = 0;
  let invalid = 0;
  let omitted = 0;
  let truncated = false;
  let pagesComplete = true;
  let stop = map.urls.length > visit.length ? 'url_limit' : 'end';
  const t0 = Date.now();
  let left = Math.max(0, rc.remaining - 700);

  for (const [at, url] of visit.entries()) {
    if (Date.now() - t0 > CRAWL_MS) {
      stop = 'time';
      skipped.time = visit.length - at;
      break;
    }
    try {
      await rc.navigate({ url });
    } catch (e) {
      if (rc.ctx.signal?.aborted) throw e;
      bump(skipped, e instanceof AwError && e.code === 'policy' ? 'policy' : 'error');
      continue;
    }
    const mark = rc.out.length;
    const used = rc.used;
    await collect(rc, { ...step, args: [], opts: { ...opts, pages: num(opts.pages, 1) } });
    const emitted = rc.out.splice(mark).join('');
    rc.used = used;
    let r: PageResult;
    try {
      r = JSON.parse(emitted.slice(emitted.indexOf('{"schema"')));
    } catch {
      bump(skipped, 'error');
      continue;
    }
    schema ??= r.schema;
    const why = r.coverage.stop;
    if (why === 'http_error' || why === 'javascript_required' || why === 'policy' || why === 'navigation_error') {
      bump(skipped, why);
      continue;
    }
    visited++;
    sources.push({ url, records: r.rows.length });
    truncated ||= r.coverage.truncated;
    // a page with no records is a normal page of a map (an About page): it is not a failure
    if (why !== 'no_records') pagesComplete &&= r.coverage.complete;
    found += r.coverage.found;
    invalid += r.coverage.invalid;
    for (const row of r.rows) {
      const id = JSON.stringify([row.values, row.evidence]);
      if (seen.has(id)) {
        duplicates++;
        continue;
      }
      seen.add(id);
      const cost = estimateTokens(JSON.stringify(row)) + 2;
      if (cost > left) {
        omitted++;
        continue;
      }
      left -= cost;
      rows.push(row);
    }
    omitted += r.coverage.omitted;
    if (omitted && stop === 'end') stop = 'budget';
  }

  const total = map.urls.length;
  const skippedCount = Object.entries(skipped).reduce((a, [k, v]) => a + (k === 'limit' || k === 'time' ? 0 : v), 0);
  const result: { schema: Record<string, Selector>; rows: CollectedRow[]; coverage: Record<string, unknown>; changes?: unknown } = {
    schema: schema ?? {},
    rows,
    coverage: {
      complete: stop === 'end' && visited === total && !skippedCount && pagesComplete && !truncated && !invalid && !omitted && map.complete,
      scope: 'saved map',
      stop,
      visited,
      total,
      mapComplete: map.complete,
      skipped,
      found,
      returned: rows.length,
      duplicates,
      invalid,
      omitted,
      truncated,
      next: null,
      sources: sources.slice(0, 10),
      ...(sources.length > 10 ? { sourcesOmitted: sources.length - 10 } : {}),
    },
  };
  while (estimateTokens(JSON.stringify(result)) > rc.remaining && rows.length) {
    rows.pop();
    (result.coverage.returned as number) = rows.length;
    (result.coverage.omitted as number)++;
    result.coverage.complete = false;
    result.coverage.stop = 'budget';
  }
  let snapshot: CollectionSnapshot | undefined;
  if (typeof diff === 'string' && typeof key === 'string') {
    if (!schema || !Object.hasOwn(schema, key)) throw new AwError('bad_request', "collection diff needs a name and a schema key, e.g. diff='catalog', key='href'");
    if (!result.coverage.complete) result.changes = { status: 'withheld', reason: 'incomplete collection' };
    else {
      const compared = compareCollection(rows, schema, key, `crawl:${map.origin}:${map.match ?? ''}`, rc.rec.collections?.find(([name]) => name === diff)?.[1]);
      result.changes = compared.changes;
      snapshot = compared.snapshot;
    }
  }
  const output = JSON.stringify(result, (_k, v) => (typeof v === 'string' ? rc.guard.redact(v) : v));
  if (estimateTokens(output) > rc.remaining) throw new AwError('bad_request', 'collection coverage exceeds the output budget; raise budget');
  rc.emit(output);
  if (snapshot && typeof diff === 'string') {
    rc.rec.collections = [...(rc.rec.collections ?? []).filter(([name]) => name !== diff), [diff, snapshot]].slice(-4) as [string, CollectionSnapshot][];
  }
}
