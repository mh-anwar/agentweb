// The orchestrator: pick providers for a query, run them in parallel with per-provider timeouts,
// fall back when one fails or is rate-limited, fuse with reciprocal rank fusion, de-duplicate.

import type { Fetcher, SearchProvider, SearchResult } from '../types.ts';
import { AwError } from '../types.ts';
import type { Provider, Vertical } from './provider.ts';
import { hostOf, underDomain, urlKey } from './url.ts';
import { why } from './util.ts';
import { defaultProviders } from './defaults.ts';

export interface SearchOptions {
  /** results wanted (default 10, max 50) */
  n?: number;
  fetch: Fetcher;
  /** override the provider set (default `defaultProviders()`) */
  providers?: SearchProvider[];
  /** per-provider timeout (default 3500 ms) */
  timeoutMs?: number;
  /** hard cap for the whole search including fallbacks (default 7000 ms) */
  deadlineMs?: number;
  /** once one web provider has answered, wait at most this long for the rest (default 1200 ms) */
  graceMs?: number;
  /** web providers queried at once; a failure starts the next one (default 3) */
  width?: number;
  /** vertical providers: 'auto' (default) picks by intent, false disables, or name the verticals */
  verticals?: 'auto' | false | Vertical[];
  /** rate-limit memory; defaults to one shared per process */
  state?: SearchState;
}

export interface SearchOutput {
  results: SearchResult[];
  /** providers that contributed at least one result */
  used: string[];
  failed: { name: string; why: string }[];
}

/** Per-family cool-down after rate limits, shared across searches in a process. */
export class SearchState {
  cool = new Map<string, { until: number; strikes: number }>();
  /** seconds left on a family's cool-down, or 0 */
  coolingFor(family: string, now = Date.now()): number {
    const c = this.cool.get(family);
    return c && c.until > now ? Math.ceil((c.until - now) / 1000) : 0;
  }
  strike(family: string, retryAfterSec?: number, now = Date.now()): void {
    const prev = this.cool.get(family);
    const strikes = (prev?.strikes ?? 0) + 1;
    const backoff = Math.min(60 * 2 ** (strikes - 1), 1800);
    const sec = retryAfterSec && retryAfterSec > 0 ? Math.min(Math.max(retryAfterSec, 5), 3600) : backoff;
    this.cool.set(family, { until: now + sec * 1000, strikes });
  }
  ok(family: string): void {
    this.cool.delete(family);
  }
}
const SHARED = new SearchState();

// ───────────── query understanding ─────────────

export interface ParsedQuery {
  raw: string;
  /** the query with site:/-site: operators removed */
  text: string;
  sites: string[];
  notSites: string[];
}

export function parseQuery(q: string): ParsedQuery {
  const sites: string[] = [];
  const notSites: string[] = [];
  const text = q
    .replace(/(^|\s)(-?)site:("?)([^\s"]+)\3/gi, (_m, pre: string, neg: string, _qt: string, d: string) => {
      const dom = d.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
      if (dom) (neg ? notSites : sites).push(dom);
      return pre;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return { raw: q.replace(/\s+/g, ' ').trim(), text, sites, notSites };
}

const LANG = /\b(python|javascript|typescript|node(?:\.?js)?|deno|bun|rust|rustc|cargo|golang|go (?:module|lang)|java|kotlin|scala|swift|objective-c|c\+\+|c#|\.net|dotnet|php|laravel|ruby|rails|perl|haskell|elixir|erlang|clojure|lua|dart|flutter|julia|matlab|bash|zsh|shell script|powershell|sql|postgres(?:ql)?|mysql|sqlite|mongodb|redis|graphql|react|vue|svelte|angular|next\.?js|nuxt|django|flask|fastapi|spring|express|webpack|vite|esbuild|docker|kubernetes|k8s|terraform|ansible|nginx|git|linux|regex|css|html|json|yaml|toml|wasm|webassembly|llvm|gcc|cmake|numpy|pandas|pytorch|tensorflow|jupyter|vim|neovim|emacs|vscode|npm|pip|conda|maven|gradle|tokio|async|api|sdk|cli|compiler|kernel|syscall)\b/i;
const REPO = /\b(github|gitlab|repo(?:sitory|s)?|librar(?:y|ies)|framework|package|crate|module|plugin|extension|open[- ]source|alternatives? to|implementation of|sdk|boilerplate|starter|template|awesome)\b/i;
const QA = /\b(how (?:do|to|can|should) (?:i |you |we )?|why (?:does|is|do|am|are)|what(?:'s| is) the (?:difference|best way)|error|exception|traceback|stack ?trace|segfault|panic(?:ked)?|undefined|null pointer|not working|doesn'?t work|fails?|failed|warning|deprecated|cannot|can'?t|unable to|vs\.?|versus|stack ?overflow)\b/i;
const CODE_TOKEN = /\w+\(\)|\w::\w|\b\w+\.\w+\(|--[a-z][a-z-]+|\b[A-Z][a-z]+(?:Error|Exception)\b|\bE[0-9]{4}\b|\berrno\b|`[^`]+`|=>|\$\w+/;
const NEWS = /\b(hacker ?news|show hn|ask hn|launch(?:ed|es)?|announce[sd]?|announcement|released?|release notes|news|latest|this week|today|outage|breach|acquir(?:es|ed)|raises|funding|layoffs?)\b/i;
const TECH = /\b(ai|llm|gpt|openai|anthropic|claude|gemini|startup|y ?combinator|yc|silicon valley|apple|google|microsoft|meta|amazon|aws|nvidia|tesla|linux|open[- ]source|security|vulnerability|cve|exploit|crypto|bitcoin|programming|software|developer|chip|gpu|browser|chrome|firefox)\b/i;
const WIKI = /^(who|what|where|when) (is|was|were|are|did)\b|^who (wrote|invented|discovered|founded|painted|composed|directed|built|created)\b|\b(history of|biography|wikipedia|born|died|capital of|population of|definition of|meaning of|founder of|invented|inventor|discovered|treaty|dynasty|empire|battle of|war of|species|genus|planet|novel by|painting|philosopher|theorem)\b/i;

/** Which verticals a query looks like it wants. Cheap regexes only; false positives cost one API call. */
export function intents(text: string): Vertical[] {
  const t = text.trim();
  if (!t) return [];
  const out = new Set<Vertical>();
  const lang = LANG.test(t);
  const codeTok = CODE_TOKEN.test(t);
  if ((lang || codeTok) && (QA.test(t) || codeTok)) out.add('qa');
  if (REPO.test(t) && (lang || /\b(github|gitlab|repo|crate|npm|open[- ]source)\b/i.test(t))) out.add('code');
  if (/\b(hacker ?news|show hn|ask hn)\b/i.test(t) || (NEWS.test(t) && (TECH.test(t) || lang))) out.add('news');
  const words = t.split(/\s+/).length;
  if (!out.size && !lang && !codeTok && (WIKI.test(t) || (words <= 4 && /^[\p{L}\p{N}' .,&-]+$/u.test(t) && !/\b(buy|price|near me|cheap|best|review|download|login|sign in)\b/i.test(t)))) out.add('wiki');
  return [...out];
}

// ───────────── orchestration ─────────────

interface Run {
  p: Provider;
  weight: number;
  results: SearchResult[];
  ms: number;
}

function norm(list: SearchProvider[]): Provider[] {
  return list
    .map((p, i) => {
      const x = p as Provider;
      return { p: x, kind: x.kind ?? 'web', rank: x.rank ?? 100 + i, i };
    })
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map(({ p, kind, rank }) => Object.assign(Object.create(p), p, { kind, rank, family: p.family ?? p.name }) as Provider);
}

function timeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const to = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new AwError('timeout', `${name}: timed out after ${ms} ms`)), Math.max(1, ms));
  });
  return Promise.race([p, to]).finally(() => clearTimeout(t));
}

export async function search(q: string, opts: SearchOptions): Promise<SearchOutput> {
  const n = Math.min(Math.max(1, Math.floor(opts.n ?? 10)), 50);
  const pq = parseQuery(q);
  if (!pq.text && !pq.sites.length) throw new AwError('bad_request', 'search: empty query', 'pass the words to search for');
  const state = opts.state ?? SHARED;
  const timeoutMs = opts.timeoutMs ?? 3500;
  const deadlineMs = opts.deadlineMs ?? 7000;
  const graceMs = opts.graceMs ?? 1200;
  const width = Math.max(1, opts.width ?? 3);
  const providers = norm(opts.providers ?? defaultProviders()).filter((p) => {
    try {
      return p.available();
    } catch {
      return false;
    }
  });

  const failed: SearchOutput['failed'] = [];
  const t0 = Date.now();
  const coolSkip = (p: Provider) => {
    const s = state.coolingFor(p.family!, t0);
    if (s) failed.push({ name: p.name, why: `skipped: rate-limited recently, cooling down ${s}s` });
    return !!s;
  };

  // web providers, best first; verticals chosen by site: or intent
  const web = providers.filter((p) => p.kind === 'web');
  const vertical: { p: Provider; weight: number }[] = [];
  const wanted = opts.verticals === false ? [] : Array.isArray(opts.verticals) ? opts.verticals : intents(pq.text);
  for (const p of providers) {
    if (p.kind === 'web') continue;
    const siteHit = pq.sites.length > 0 && pq.sites.some((s) => p.domains?.some((d) => underDomain(s, d)));
    if (siteHit) vertical.push({ p, weight: p.weight ?? 1.5 });
    else if (!pq.sites.length && wanted.includes(p.kind as Vertical)) vertical.push({ p, weight: p.weight ?? 0.5 });
  }
  if (!web.length && !vertical.length) {
    return { results: [], used: [], failed: [{ name: 'search', why: providers.length ? 'no provider matches this query' : 'no search providers available' }] };
  }

  const queue = web.filter((p) => !coolSkip(p));
  const live = vertical.filter((v) => !coolSkip(v.p));
  const runs: Run[] = [];
  const perN = Math.max(n, 10);
  // backends that understand site: get the query as typed; the rest get it stripped (and we post-filter)
  const queryFor = (p: Provider) => (p.siteOp ? pq.raw : pq.text || pq.raw);

  await new Promise<void>((resolve) => {
    let done = false;
    const pending = new Map<string, number>();
    const usedFamilies = new Set<string>();
    let webOk = 0;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(graceTimer);
      clearTimeout(deadlineTimer);
      const now = Date.now();
      for (const [name, at] of pending) failed.push({ name, why: `timed out after ${now - at} ms (others answered first)` });
      resolve();
    };
    const deadlineTimer = setTimeout(finish, deadlineMs);

    const nextWeb = (): Provider | undefined => {
      // prefer a backend we have not tried yet; same-family fallbacks only when nothing else is left
      let i = queue.findIndex((p) => !usedFamilies.has(p.family!));
      if (i < 0) i = queue.findIndex((p) => state.coolingFor(p.family!) === 0);
      if (i < 0) return undefined;
      return queue.splice(i, 1)[0];
    };
    const fallback = () => {
      if (done || webOk >= width) return;
      const left = t0 + deadlineMs - Date.now();
      if (left < Math.min(300, deadlineMs / 5)) return; // not enough time left for another round trip
      let p = nextWeb();
      while (p && state.coolingFor(p.family!)) {
        failed.push({ name: p.name, why: `skipped: ${p.family} was just rate-limited` });
        p = nextWeb();
      }
      if (p) launch(p, p.weight ?? 1, true);
    };
    const launch = (p: Provider, weight: number, isWeb: boolean) => {
      const at = Date.now();
      const ms = Math.min(timeoutMs, t0 + deadlineMs - at);
      pending.set(p.name, at);
      usedFamilies.add(p.family!);
      const job = Promise.resolve().then(() => p.search(queryFor(p), { n: perN, fetch: opts.fetch }));
      timeout(job, ms, p.name).then(
        (res) => {
          if (done) return;
          pending.delete(p.name);
          state.ok(p.family!);
          if (Array.isArray(res) && res.length) {
            runs.push({ p, weight, results: res, ms: Date.now() - at });
            if (isWeb && ++webOk === 1 && graceMs >= 0) graceTimer = setTimeout(finish, graceMs);
          } else {
            failed.push({ name: p.name, why: 'no results' });
            if (isWeb) fallback();
          }
          if (!pending.size) finish();
        },
        (e) => {
          if (done) return;
          pending.delete(p.name);
          failed.push({ name: p.name, why: why(e) });
          // refusals and repeated server errors both mean "leave this backend alone for a while"
          if (e instanceof AwError && (e.code === 'blocked' || (e.code === 'net' && /HTTP 5\d\d/.test(e.message)))) state.strike(p.family!, (e as { retryAfterSec?: number }).retryAfterSec);
          if (isWeb) fallback();
          if (!pending.size) finish();
        },
      );
      job.catch(() => {}); // a late rejection after the timeout must not become unhandled
    };

    for (const v of live) launch(v.p, v.weight, false);
    for (let i = 0; i < width; i++) {
      const p = nextWeb();
      if (!p) break;
      launch(p, p.weight ?? 1, true);
    }
    if (!pending.size) finish();
  });

  let results = fuse(runs);
  if (pq.sites.length || pq.notSites.length) {
    const before = results.length;
    results = results.filter((r) => {
      const h = hostOf(r.url);
      return (!pq.sites.length || pq.sites.some((s) => underDomain(h, s))) && !pq.notSites.some((s) => underDomain(h, s));
    });
    if (before && !results.length) failed.push({ name: 'search', why: `all ${before} results were outside ${pq.sites.map((s) => 'site:' + s).join(' ')}` });
  }
  const used = providers.filter((p) => runs.some((r) => r.p.name === p.name)).map((p) => p.name);
  return { results: results.slice(0, n), used, failed };
}

// ───────────── fusion ─────────────

const RRF_K = 60;

/** Reciprocal rank fusion over provider lists, de-duplicating by canonical URL. */
export function fuse(runs: { p: { name: string }; weight: number; results: SearchResult[] }[]): SearchResult[] {
  interface Acc { score: number; best: number; r: SearchResult; snippets: string[]; sources: string[]; first: number; https: string | undefined }
  const acc = new Map<string, Acc>();
  let order = 0;
  for (const run of runs) {
    run.results.forEach((r, i) => {
      const key = urlKey(r.url);
      const s = run.weight / (RRF_K + i + 1);
      let a = acc.get(key);
      if (!a) {
        a = { score: 0, best: -1, r, snippets: [], sources: [], first: order++, https: undefined };
        acc.set(key, a);
      }
      a.score += s;
      if (!a.sources.includes(run.p.name)) a.sources.push(run.p.name);
      if (r.snippet) a.snippets.push(r.snippet);
      if (r.url.startsWith('https:')) a.https ??= r.url;
      if (s > a.best) {
        a.best = s;
        a.r = r;
      }
    });
  }
  return [...acc.values()]
    .sort((x, y) => y.score - x.score || y.sources.length - x.sources.length || x.first - y.first)
    .map((a) => {
      let snippet = a.r.snippet;
      // a terse snippet from the top-ranked source loses to a fuller one from another
      if (snippet.length < 80) for (const s of a.snippets) if (s.length > snippet.length) snippet = s;
      const url = a.r.url.startsWith('http:') && a.https ? a.https : a.r.url;
      return { title: a.r.title, url, snippet, source: a.sources.join('+') };
    });
}
