// Keyless vertical providers with public JSON APIs. The orchestrator adds them when a query looks
// like it wants them (or names their domain with `site:`).

import type { SearchResult } from '../../types.ts';
import { AwError } from '../../types.ts';
import { collect, env, type Provider } from '../provider.ts';
import { enc, getJson, RateLimited, stripTags } from '../util.ts';

const compact = (x: number) => (x >= 1e6 ? (x / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : x >= 1e4 ? Math.round(x / 1e3) + 'k' : x >= 1e3 ? (x / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(x));
const day = (s: string | number | undefined) => {
  if (s === undefined) return '';
  const d = typeof s === 'number' ? new Date(s * 1000) : new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
};

// ───────────── Wikipedia ─────────────

export function parseWikipedia(data: any, n: number, lang = 'en'): SearchResult[] {
  if (data?.error) throw new AwError('internal', `wikipedia: ${data.error.info ?? data.error.code}`);
  const rows = data?.query?.search;
  if (!Array.isArray(rows)) throw new AwError('internal', 'wikipedia: unexpected response shape');
  return collect('wikipedia', n, rows.map((r: any): [string, string, string] => [
    r.title,
    `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':').replace(/%2C/g, ',')}`,
    stripTags(r.snippet),
  ]));
}

export function wikipedia(opts: { lang?: string } = {}): Provider {
  const lang = (opts.lang ?? env('AGENTWEB_WIKI_LANG') ?? 'en').toLowerCase().replace(/[^a-z-]/g, '') || 'en';
  return {
    name: 'wikipedia', kind: 'wiki', family: 'wikipedia', domains: ['wikipedia.org'],
    available: () => true,
    async search(q, { n, fetch }) {
      const { data } = await getJson(fetch, {
        url: `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&utf8=1&srprop=snippet&srlimit=${Math.min(n, 50)}&srsearch=${enc(q)}`,
      }, 'wikipedia');
      return parseWikipedia(data, n, lang);
    },
  };
}

// ───────────── Hacker News (Algolia) ─────────────

export function parseHackerNews(data: any, n: number): SearchResult[] {
  const hits = data?.hits;
  if (!Array.isArray(hits)) throw new AwError('internal', 'hackernews: unexpected response shape');
  return collect('hackernews', n, hits.map((h: any): [string, string, string] => {
    const item = `https://news.ycombinator.com/item?id=${h.objectID}`;
    const bits = [`${h.points ?? 0} points`, `${h.num_comments ?? 0} comments`, day(h.created_at_i ?? h.created_at)].filter(Boolean);
    const text = h.story_text ? stripTags(h.story_text).slice(0, 300) + ' · ' : '';
    return [h.title ?? h.story_title, h.url || item, text + bits.join(', ') + (h.url ? ` · HN thread: item?id=${h.objectID}` : '')];
  }));
}

export function hackerNews(): Provider {
  return {
    name: 'hackernews', kind: 'news', family: 'hackernews', domains: ['news.ycombinator.com'],
    available: () => true,
    async search(q, { n, fetch }) {
      const recent = /\b(latest|today|this week|recent|new)\b/i.test(q);
      const { data } = await getJson(fetch, {
        url: `https://hn.algolia.com/api/v1/${recent ? 'search_by_date' : 'search'}?tags=story&hitsPerPage=${Math.min(n, 50)}&query=${enc(q)}${recent ? '&numericFilters=points%3E5' : ''}`,
      }, 'hackernews');
      return parseHackerNews(data, n);
    },
  };
}

// ───────────── GitHub repositories ─────────────

export function parseGitHub(data: any, n: number): SearchResult[] {
  const items = data?.items;
  if (!Array.isArray(items)) throw new AwError('internal', `github: ${data?.message ?? 'unexpected response shape'}`);
  return collect('github', n, items.map((r: any): [string, string, string] => {
    const bits = [`★${compact(r.stargazers_count ?? 0)}`, r.language, r.archived ? 'archived' : '', r.pushed_at ? 'updated ' + day(r.pushed_at) : ''].filter(Boolean);
    return [r.full_name, r.html_url, (r.description ? stripTags(r.description) + ' · ' : '') + bits.join(', ')];
  }));
}

export function github(opts: { token?: string } = {}): Provider {
  return {
    name: 'github', kind: 'code', family: 'github', domains: ['github.com'],
    available: () => true,
    async search(q, { n, fetch }) {
      const token = opts.token ?? env('GITHUB_TOKEN');
      const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
      if (token) headers.authorization = `Bearer ${token}`;
      const l = await fetch({ url: `https://api.github.com/search/repositories?per_page=${Math.min(n, 30)}&q=${enc(q)}`, headers });
      if ((l.status === 403 || l.status === 429) && (l.headers?.['x-ratelimit-remaining'] === '0' || l.status === 429)) {
        const reset = Number(l.headers?.['x-ratelimit-reset']);
        throw new RateLimited(`github: rate-limited (${token ? 'token' : 'unauthenticated: 10/min, set GITHUB_TOKEN'})`, Number.isFinite(reset) ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60);
      }
      const { data } = await getJson(async () => l, { url: l.url }, 'github');
      return parseGitHub(data, n);
    },
  };
}

// ───────────── Stack Exchange (Stack Overflow by default) ─────────────

/** Map a Stack Exchange network domain to the API `site` parameter. */
export function seSite(domain: string): string | undefined {
  const d = domain.toLowerCase().replace(/^www\./, '');
  if (d === 'stackoverflow.com') return 'stackoverflow';
  if (['superuser.com', 'serverfault.com', 'askubuntu.com', 'stackapps.com'].includes(d)) return d.replace(/\.com$/, '');
  if (d === 'mathoverflow.net') return 'mathoverflow.net';
  const m = /^([a-z0-9-]+)\.stackexchange\.com$/.exec(d);
  return m ? m[1] : undefined;
}

const SITE_HOST: Record<string, string> = { stackoverflow: 'stackoverflow.com', superuser: 'superuser.com', serverfault: 'serverfault.com', askubuntu: 'askubuntu.com', stackapps: 'stackapps.com', 'mathoverflow.net': 'mathoverflow.net' };

export function parseStackExchange(data: any, n: number, site = 'stackoverflow'): SearchResult[] {
  if (data?.error_id) {
    if (data.error_id === 502 || /throttle|quota/i.test(data.error_message ?? '')) throw new RateLimited(`stackexchange: ${data.error_message ?? 'throttled'}`, data.backoff);
    throw new AwError('internal', `stackexchange: ${data.error_message ?? data.error_name}`);
  }
  const items = data?.items;
  if (!Array.isArray(items)) throw new AwError('internal', 'stackexchange: unexpected response shape');
  const host = SITE_HOST[site] ?? `${site}.stackexchange.com`;
  return collect('stackexchange', n, items.map((r: any): [string, string, string] => {
    const isAnswer = r.item_type === 'answer' && r.answer_id;
    const url = isAnswer ? `https://${host}/a/${r.answer_id}` : `https://${host}/q/${r.question_id}`;
    const bits = isAnswer
      ? [`answer, score ${r.score ?? 0}`, r.is_accepted ? 'accepted' : '']
      : [`score ${r.score ?? 0}`, `${r.answer_count ?? 0} answers`, r.has_accepted_answer || r.is_answered ? 'answered' : 'unanswered'];
    const tags = Array.isArray(r.tags) && r.tags.length ? ' [' + r.tags.slice(0, 4).join(', ') + ']' : '';
    return [stripTags(r.title), url, stripTags(r.excerpt).slice(0, 320) + ' (' + bits.filter(Boolean).join(', ') + ')' + tags];
  }));
}

export function stackExchange(opts: { key?: string } = {}): Provider {
  return {
    name: 'stackexchange', kind: 'qa', family: 'stackexchange', siteOp: true,
    domains: ['stackoverflow.com', 'superuser.com', 'serverfault.com', 'askubuntu.com', 'mathoverflow.net', 'stackexchange.com'],
    available: () => true,
    async search(q, { n, fetch }) {
      // the orchestrator passes `site:` through to us: route it to the API's site parameter
      let site = 'stackoverflow';
      const m = /(?:^|\s)site:(\S+)/i.exec(q);
      if (m) {
        site = seSite(m[1]) ?? site;
        q = q.replace(/(?:^|\s)-?site:\S+/gi, ' ').trim();
      }
      const key = opts.key ?? env('STACKEXCHANGE_KEY');
      const { data } = await getJson(fetch, {
        url: `https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&pagesize=${Math.min(n, 30)}&site=${enc(site)}&q=${enc(q)}${key ? '&key=' + enc(key) : ''}`,
      }, 'stackexchange');
      return parseStackExchange(data, n, site);
    },
  };
}
