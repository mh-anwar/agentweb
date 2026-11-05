// Keyless general web providers: HTML result pages parsed from the LNode tree, plus Bing's RSS
// output and mwmbl's JSON API. Every request goes through the injected Fetcher.

import { walk, type Doc, type LNode } from '../../tree.ts';
import type { Loaded, SearchResult } from '../../types.ts';
import { AwError } from '../../types.ts';
import { collect, type Provider } from '../provider.ts';
import { all, bodyText, checkStatus, cls, decodeEntities, enc, first, form, getDoc, getJson, hasClass, RateLimited, tagCls, txt } from '../util.ts';

const HTML_HEADERS = { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' };

/** Bot walls look alike everywhere: a captcha title, an anomaly form, a proof-of-work page. */
export function botWall(doc: Doc): string | undefined {
  const title = doc.meta.title.toLowerCase();
  if (/captcha|verify(ing)? (you|your browser)|are you a (human|robot)|just a moment|attention required|access denied|unusual traffic|bot (check|protection)/.test(title)) return doc.meta.title;
  for (const x of walk(doc.root)) {
    if (x.t === 'form' && /anomaly|captcha|challenge/i.test((x.a?.action ?? '') + ' ' + (x.a?.id ?? '') + ' ' + (x.a?.class ?? ''))) return 'challenge form';
    if (x.t === '#text' && x.x && x.x.length < 400 && /bots use duckduckgo too|complete the following challenge|unusual traffic from your computer|please solve this captcha/i.test(x.x)) return 'challenge page';
  }
  return undefined;
}

function guard(l: Loaded & { doc: Doc }, name: string): Doc {
  const w = botWall(l.doc);
  if (w) throw new RateLimited(`${name}: bot challenge (${w.slice(0, 60)})`);
  return l.doc;
}

// ───────────── DuckDuckGo (html endpoint, POST) ─────────────

export function parseDdgHtml(doc: Doc, n: number, source = 'ddg'): SearchResult[] {
  const rows = all(doc.root, (x) => x.t === 'div' && hasClass(x, 'result') && !hasClass(x, 'result--ad'));
  return collect(source, n, rows.flatMap((r): [string, string, string][] => {
    const a = first(r, tagCls('a', 'result__a'));
    const href = a?.a?.href;
    if (!a || !href || /duckduckgo\.com\/y\.js/.test(href)) return [];
    return [[txt(a), href, txt(first(r, cls('result__snippet')))]];
  }));
}

export function ddg(): Provider {
  return {
    name: 'ddg', kind: 'web', rank: 12, family: 'ddg', siteOp: true,
    available: () => true,
    async search(q, { n, fetch }) {
      const l = await getDoc(fetch, {
        url: 'https://html.duckduckgo.com/html/', method: 'POST', body: form({ q, b: '', kl: 'wt-wt' }),
        contentType: 'application/x-www-form-urlencoded', referer: 'https://html.duckduckgo.com/', headers: HTML_HEADERS,
      }, 'ddg');
      if (l.status === 202) throw new RateLimited('ddg: bot challenge (HTTP 202)');
      const doc = guard(l, 'ddg');
      return parseDdgHtml(doc, n);
    },
  };
}

// ───────────── DuckDuckGo lite ─────────────

export function parseDdgLite(doc: Doc, n: number, source = 'ddg-lite'): SearchResult[] {
  const raw: [string, string, string][] = [];
  let cur: [string, string, string] | undefined;
  for (const tr of all(doc.root, (x) => x.t === 'tr')) {
    if (hasClass(tr, 'result-sponsored')) {
      cur = undefined;
      continue;
    }
    const a = first(tr, tagCls('a', 'result-link'));
    if (a) {
      const href = a.a?.href;
      cur = href && !/duckduckgo\.com\/y\.js/.test(href) ? [txt(a), href, ''] : undefined;
      if (cur) raw.push(cur);
      continue;
    }
    const sn = first(tr, tagCls('td', 'result-snippet'));
    if (sn && cur) cur[2] = txt(sn);
  }
  return collect(source, n, raw);
}

export function ddgLite(): Provider {
  return {
    name: 'ddg-lite', kind: 'web', rank: 30, family: 'ddg', siteOp: true,
    available: () => true,
    async search(q, { n, fetch }) {
      const l = await getDoc(fetch, {
        url: 'https://lite.duckduckgo.com/lite/', method: 'POST', body: form({ q, kl: 'wt-wt' }),
        contentType: 'application/x-www-form-urlencoded', referer: 'https://lite.duckduckgo.com/', headers: HTML_HEADERS,
      }, 'ddg-lite');
      if (l.status === 202) throw new RateLimited('ddg-lite: bot challenge (HTTP 202)');
      return parseDdgLite(guard(l, 'ddg-lite'), n);
    },
  };
}

// ───────────── Bing (RSS output: no redirect wrapper, ~5 kB) ─────────────

export function parseRss(xml: string, n: number, source: string): SearchResult[] {
  const raw: [string, string, string][] = [];
  const field = (item: string, tag: string) => {
    const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(item);
    if (!m) return '';
    let v = m[1].trim();
    const cd = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
    v = cd ? cd[1] : decodeEntities(v);
    return v.replace(/<[^>]*>/g, ' ');
  };
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const it = m[1];
    raw.push([decodeEntities(field(it, 'title')), field(it, 'link').trim(), decodeEntities(field(it, 'description'))]);
  }
  return collect(source, n, raw);
}

export function bing(): Provider {
  return {
    name: 'bing', kind: 'web', rank: 10, family: 'bing', siteOp: true,
    available: () => true,
    async search(q, { n, fetch }) {
      const l = await fetch({ url: `https://www.bing.com/search?format=rss&q=${enc(q)}&count=${Math.min(Math.max(n, 10), 30)}`, headers: { accept: 'application/rss+xml,text/xml;q=0.9,*/*;q=0.5', 'accept-language': 'en-US,en;q=0.9' } });
      checkStatus(l, 'bing');
      if (l.doc && !l.body) {
        const w = botWall(l.doc);
        if (w) throw new RateLimited(`bing: bot challenge (${w.slice(0, 60)})`);
      }
      const xml = bodyText(l);
      if (!xml || !/<rss[\s>]/i.test(xml.slice(0, 500))) throw new AwError('internal', `bing: expected RSS, got ${l.contentType}`);
      return parseRss(xml, n, 'bing');
    },
  };
}

// ───────────── Bing HTML ─────────────

export function parseBingHtml(doc: Doc, n: number, source = 'bing-html'): SearchResult[] {
  const items = all(doc.root, tagCls('li', 'b_algo'));
  return collect(source, n, items.flatMap((li): [string, string, string][] => {
    const h2 = first(li, (x) => x.t === 'h2');
    const a = h2 && first(h2, (x) => x.t === 'a' && !!x.a?.href);
    if (!a) return [];
    const cap = first(li, cls('b_caption')) ?? li;
    const p = first(cap, (x) => x.t === 'p' || hasClass(x, 'b_lineclamp2') || hasClass(x, 'b_algoSlug')) ?? first(li, cls('b_snippet'));
    return [[txt(a), a.a!.href, txt(p).replace(/^(?:Web|\d{1,2} \w{3,9} \d{4})\s*·\s*/, '')]];
  }));
}

export function bingHtml(): Provider {
  return {
    name: 'bing-html', kind: 'web', rank: 35, family: 'bing', siteOp: true,
    available: () => true,
    async search(q, { n, fetch }) {
      const l = await getDoc(fetch, { url: `https://www.bing.com/search?q=${enc(q)}&setlang=en-US`, headers: HTML_HEADERS }, 'bing-html');
      return parseBingHtml(guard(l, 'bing-html'), n);
    },
  };
}

// ───────────── Brave Search HTML ─────────────

export function parseBraveHtml(doc: Doc, n: number, source = 'brave'): SearchResult[] {
  const main = first(doc.root, (x) => x.a?.id === 'results' || x.a?.id === 'mixed-main') ?? doc.root;
  const snips = all(main, (x) => x.t === 'div' && hasClass(x, 'snippet') && !!first(x, cls('search-snippet-title')));
  return collect(source, n, snips.flatMap((s): [string, string, string][] => {
    const t = first(s, cls('search-snippet-title'));
    const a = first(s, (x) => x.t === 'a' && /^https?:\/\//.test(x.a?.href ?? '') && !/^https?:\/\/(search\.)?brave\.com\//.test(x.a!.href));
    if (!a || !t) return [];
    const body = first(s, cls('generic-snippet')) ?? first(s, cls('snippet-description')) ?? first(s, cls('snippet-content'));
    const content = body ? (first(body, cls('content')) ?? body) : undefined;
    return [[t.a?.title || txt(t), a.a!.href, txt(content).replace(/^\w{3,9} \d{1,2}, \d{4}\s*-\s*/, '')]];
  }));
}

export function brave(): Provider {
  return {
    name: 'brave', kind: 'web', rank: 11, family: 'brave', siteOp: true,
    available: () => true,
    async search(q, { n, fetch }) {
      const l = await getDoc(fetch, { url: `https://search.brave.com/search?q=${enc(q)}&source=web`, headers: HTML_HEADERS }, 'brave');
      const doc = guard(l, 'brave');
      if (/\/captcha|\/pow/.test(new URL(l.url).pathname)) throw new RateLimited('brave: bot challenge');
      return parseBraveHtml(doc, n);
    },
  };
}

// ───────────── Yahoo (Bing-backed, different ranking; links wrapped in r.search.yahoo.com) ─────────────

export function parseYahoo(doc: Doc, n: number, source = 'yahoo'): SearchResult[] {
  const main = first(doc.root, (x) => x.t === 'ol' && hasClass(x, 'searchCenterMiddle')) ?? first(doc.root, (x) => x.a?.id === 'web') ?? doc.root;
  const items = all(main, (x) => x.t === 'div' && hasClass(x, 'algo') && !hasClass(x, 'ads'));
  return collect(source, n, items.flatMap((d): [string, string, string][] => {
    const ct = first(d, cls('compTitle')) ?? d;
    const a = first(ct, (x) => x.t === 'a' && !!x.a?.href);
    if (!a) return [];
    const h = first(ct, (x) => x.t === 'h3' || x.t === 'h2' || hasClass(x, 'title'));
    let title = h ? txt(h) : txt(a);
    // some layouts put the breadcrumb ("site.com › path") inside the title node
    title = title.replace(/^\S+\s+https?:\/\/\S+(?:\s›\s\S+)*\s*/, '');
    const sn = first(d, cls('compText'));
    return [[title, a.a!.href, txt(sn).replace(/^\w{3,9} \d{1,2}, \d{4}\s*·\s*/, '')]];
  }));
}

export function yahoo(): Provider {
  return {
    name: 'yahoo', kind: 'web', rank: 20, family: 'yahoo', siteOp: true,
    available: () => true,
    async search(q, { n, fetch }) {
      const l = await getDoc(fetch, { url: `https://search.yahoo.com/search?p=${enc(q)}&ei=UTF-8`, headers: HTML_HEADERS }, 'yahoo');
      return parseYahoo(guard(l, 'yahoo'), n);
    },
  };
}

// ───────────── Seznam (independent Czech index; good English coverage, hashed class names) ─────────────

const SEZNAM_OWN = /(^|\.)(seznam\.cz|sklik\.cz|szn\.cz|mapy\.cz|firmy\.cz|sdn\.cz)$/;

/** Class names on Seznam are build hashes, so this parser keys on structure: an <h3> holding an
 *  external link is a result; the first later sibling that does not repeat the link is its snippet. */
export function parseSeznam(doc: Doc, n: number, source = 'seznam'): SearchResult[] {
  const raw: [string, string, string][] = [];
  const visit = (node: LNode) => {
    const kids = node.c ?? [];
    for (let i = 0; i < kids.length; i++) {
      const h = kids[i];
      if (h.t !== 'h3') continue;
      const a = first(h, (x) => x.t === 'a' && /^https?:\/\//.test(x.a?.href ?? ''));
      if (!a) continue;
      let host = '';
      try {
        host = new URL(a.a!.href).hostname;
      } catch {}
      if (!host || SEZNAM_OWN.test(host)) continue;
      let snippet = '';
      for (let j = i + 1; j < kids.length && !snippet; j++) {
        const sib = kids[j];
        if (sib.t === 'h3') break;
        if (first(sib, (x) => x.t === 'a' && x.a?.href === a.a!.href)) continue; // breadcrumb / sitelinks
        const t = txt(sib);
        if (t.length > 20) snippet = t;
      }
      raw.push([txt(a), a.a!.href, snippet]);
    }
    for (const k of kids) if (k.c && k.t !== 'h3') visit(k);
  };
  visit(doc.root);
  return collect(source, n, raw);
}

export function seznam(): Provider {
  return {
    name: 'seznam', kind: 'web', rank: 25, family: 'seznam', siteOp: true,
    available: () => true,
    async search(q, { n, fetch }) {
      const l = await getDoc(fetch, { url: `https://search.seznam.cz/?q=${enc(q)}`, headers: HTML_HEADERS }, 'seznam');
      return parseSeznam(guard(l, 'seznam'), n);
    },
  };
}

// ───────────── mwmbl (open, non-profit index: small, a last resort) ─────────────

interface MwmblHit { url: string; title: { value: string }[]; extract: { value: string }[] }

export function parseMwmbl(data: unknown, n: number, source = 'mwmbl'): SearchResult[] {
  if (!Array.isArray(data)) throw new AwError('internal', 'mwmbl: unexpected response shape');
  const join = (xs: unknown) => (Array.isArray(xs) ? xs.map((x: any) => (typeof x?.value === 'string' ? x.value : '')).join('') : '');
  return collect(source, n, (data as MwmblHit[]).map((h): [string, string, string] => [join(h.title), h.url, join(h.extract)]));
}

export function mwmbl(): Provider {
  return {
    name: 'mwmbl', kind: 'web', rank: 60, family: 'mwmbl', siteOp: false, weight: 0.5,
    available: () => true,
    async search(q, { n, fetch }) {
      const { data } = await getJson(fetch, { url: `https://api.mwmbl.org/search/?s=${enc(q)}` }, 'mwmbl');
      return parseMwmbl(data, n);
    },
  };
}
