// Providers that need configuration. Each is available only when its environment variable (or an
// explicit option) is present, and then ranks ahead of the keyless scrapers.

import type { SearchResult } from '../../types.ts';
import { AwError } from '../../types.ts';
import { collect, env, type Provider } from '../provider.ts';
import { bodyText, enc, getJson, RateLimited, stripTags } from '../util.ts';
import type { Fetcher, Loaded } from '../../types.ts';

function quota(l: Loaded, name: string): void {
  if (l.status === 429) throw new RateLimited(`${name}: rate-limited or out of quota (HTTP 429)`, Number(l.headers?.['retry-after']) || undefined);
  if (l.status === 401 || l.status === 403) throw new AwError('blocked', `${name}: API key rejected (HTTP ${l.status})`);
  if (l.status === 402 || l.status === 432) throw new RateLimited(`${name}: plan quota exhausted (HTTP ${l.status})`, 3600);
}

/** Wrap the fetcher so quota statuses become classified errors before generic status handling. */
const checked = (name: string) => (fetch: Fetcher): Fetcher => async (r) => {
  const l = await fetch(r);
  quota(l, name);
  return l;
};

// ───────────── Brave Search API (BRAVE_API_KEY) ─────────────

export function parseBraveApi(data: any, n: number): SearchResult[] {
  const rows = data?.web?.results;
  if (!Array.isArray(rows)) {
    if (data?.type === 'ErrorResponse' || data?.error) throw new AwError('internal', `brave-api: ${data?.error?.detail ?? data?.error?.code ?? 'error'}`);
    return [];
  }
  return collect('brave-api', n, rows.map((r: any): [string, string, string] => [stripTags(r.title), r.url, stripTags([r.description, ...(r.extra_snippets ?? []).slice(0, 1)].filter(Boolean).join(' … '))]));
}

export function braveApi(opts: { key?: string } = {}): Provider {
  const key = () => opts.key ?? env('BRAVE_API_KEY') ?? env('BRAVE_SEARCH_API_KEY');
  return {
    name: 'brave-api', kind: 'web', rank: 1, family: 'brave-api', siteOp: true,
    available: () => !!key(),
    async search(q, { n, fetch }) {
      const { data } = await getJson(checked('brave-api')(fetch), {
        url: `https://api.search.brave.com/res/v1/web/search?q=${enc(q)}&count=${Math.min(n, 20)}&text_decorations=false`,
        headers: { 'x-subscription-token': key()!, accept: 'application/json' },
      }, 'brave-api');
      return parseBraveApi(data, n);
    },
  };
}

// ───────────── SearXNG (SEARXNG_URL, instance must enable format=json) ─────────────

export function parseSearxng(data: any, n: number): SearchResult[] {
  const rows = data?.results;
  if (!Array.isArray(rows)) throw new AwError('internal', 'searxng: unexpected response shape');
  return collect('searxng', n, rows.map((r: any): [string, string, string] => [stripTags(r.title), r.url, stripTags(r.content)]));
}

export function searxng(opts: { url?: string } = {}): Provider {
  const base = () => (opts.url ?? env('SEARXNG_URL'))?.replace(/\/+$/, '').replace(/\/search$/, '');
  return {
    name: 'searxng', kind: 'web', rank: 2, family: 'searxng', siteOp: true,
    available: () => !!base(),
    async search(q, { n, fetch }) {
      const l = await fetch({ url: `${base()}/search?q=${enc(q)}&format=json&safesearch=0`, headers: { accept: 'application/json' } });
      if (l.status === 403) throw new AwError('blocked', 'searxng: JSON output is disabled on this instance (enable `json` in search.formats)');
      quota(l, 'searxng');
      const { data } = await getJson(async () => l, { url: l.url }, 'searxng');
      if (Array.isArray(data?.unresponsive_engines) && data.unresponsive_engines.length && !data.results?.length) {
        throw new AwError('net', 'searxng: all engines unresponsive (' + data.unresponsive_engines.map((e: any) => (Array.isArray(e) ? e.join(': ') : e)).slice(0, 3).join('; ') + ')');
      }
      return parseSearxng(data, n);
    },
  };
}

// ───────────── Tavily (TAVILY_API_KEY) ─────────────

export function parseTavily(data: any, n: number): SearchResult[] {
  const rows = data?.results;
  if (!Array.isArray(rows)) throw new AwError('internal', `tavily: ${data?.detail?.error ?? data?.error ?? 'unexpected response shape'}`);
  return collect('tavily', n, rows.map((r: any): [string, string, string] => [r.title, r.url, r.content]));
}

export function tavily(opts: { key?: string } = {}): Provider {
  const key = () => opts.key ?? env('TAVILY_API_KEY');
  return {
    name: 'tavily', kind: 'web', rank: 3, family: 'tavily', siteOp: false,
    available: () => !!key(),
    async search(q, { n, fetch }) {
      const { data } = await getJson(checked('tavily')(fetch), {
        url: 'https://api.tavily.com/search', method: 'POST', contentType: 'application/json',
        headers: { authorization: `Bearer ${key()}`, accept: 'application/json' },
        body: JSON.stringify({ query: q, max_results: Math.min(n, 20), search_depth: 'basic', include_answer: false }),
      }, 'tavily');
      return parseTavily(data, n);
    },
  };
}

// ───────────── Serper, Google results (SERPER_API_KEY) ─────────────

export function parseSerper(data: any, n: number): SearchResult[] {
  const rows = data?.organic;
  if (!Array.isArray(rows)) throw new AwError('internal', `serper: ${data?.message ?? 'unexpected response shape'}`);
  return collect('serper', n, rows.map((r: any): [string, string, string] => [r.title, r.link, r.snippet]));
}

export function serper(opts: { key?: string } = {}): Provider {
  const key = () => opts.key ?? env('SERPER_API_KEY');
  return {
    name: 'serper', kind: 'web', rank: 2, family: 'serper', siteOp: true,
    available: () => !!key(),
    async search(q, { n, fetch }) {
      const { data } = await getJson(checked('serper')(fetch), {
        url: 'https://google.serper.dev/search', method: 'POST', contentType: 'application/json',
        headers: { 'x-api-key': key()!, accept: 'application/json' },
        body: JSON.stringify({ q, num: Math.min(Math.max(n, 10), 100) }),
      }, 'serper');
      return parseSerper(data, n);
    },
  };
}

// ───────────── Google Programmable Search JSON API (AGENTWEB_GOOGLE_CSE_KEY + AGENTWEB_GOOGLE_CSE_CX) ─────────────

export function parseGoogleCse(data: any, n: number): SearchResult[] {
  const rows = data?.items;
  if (!Array.isArray(rows)) {
    if (data?.error) throw new AwError('internal', `google-cse: ${data.error.message ?? data.error.status ?? 'error'}`);
    return []; // a query with no hits has no `items`
  }
  return collect('google-cse', n, rows.map((r: any): [string, string, string] => [stripTags(r.title), r.link, stripTags(r.snippet)]));
}

export function googleCse(opts: { key?: string; cx?: string } = {}): Provider {
  const key = () => opts.key ?? env('AGENTWEB_GOOGLE_CSE_KEY');
  const cx = () => opts.cx ?? env('AGENTWEB_GOOGLE_CSE_CX');
  return {
    name: 'google-cse', kind: 'web', rank: 1, family: 'google-cse', siteOp: true,
    available: () => !!key() && !!cx(),
    async search(q, { n, fetch }) {
      const l = await fetch({ url: `https://www.googleapis.com/customsearch/v1?key=${enc(key()!)}&cx=${enc(cx()!)}&q=${enc(q)}&num=${Math.min(n, 10)}`, headers: { accept: 'application/json' } });
      // 403 is also how this API reports an exhausted daily quota
      if (l.status === 403 && /quota|limit/i.test(String(bodyText(l) ?? ''))) throw new RateLimited('google-cse: daily quota exhausted (HTTP 403)', 3600);
      quota(l, 'google-cse');
      const { data } = await getJson(async () => l, { url: l.url }, 'google-cse');
      return parseGoogleCse(data, n);
    },
  };
}
