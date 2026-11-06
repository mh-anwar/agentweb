// RSS 2.0, RSS 1.0 (RDF), Atom and JSON Feed → feed title, then one row per item:
// `date | [title](link) | summary`, with HTML stripped from summaries.

import { linkAct } from '../blocks.ts';
import { squash } from '../tree.ts';
import type { Inline, ReadInput, ReadOutput } from '../types.ts';
import { Emitter, absUrl, plural, shortUrl, stripHtml, titleFromUrl, trunc } from './util.ts';
import { type XEl, child, children, kids, local, parseXml, xtext } from './xmlutil.ts';

const SUMMARY_MAX = 180;
const MAX_ITEMS = 500;

export interface FeedItem {
  title: string;
  link?: string;
  date?: string;
  summary?: string;
  author?: string;
}
export interface Feed {
  title: string;
  link?: string;
  description?: string;
  items: FeedItem[];
  format: string;
}

// ───────────────────────────── parsing ─────────────────────────────

function textOf(el: XEl | undefined): string {
  if (!el) return '';
  const t = xtext(el);
  const type = (el.attribs.type ?? '').toLowerCase();
  // Atom text constructs: type="html" holds escaped markup, "xhtml" holds a div
  if (type === 'html' || type === 'xhtml' || type === 'text/html' || /<[a-z][^>]*>|&[a-z]+;/i.test(t)) return stripHtml(t);
  return squash(t);
}

function atomLink(el: XEl, base: string): string | undefined {
  const links = children(el, 'link');
  const pick = links.find((l) => (l.attribs.rel ?? 'alternate') === 'alternate' && (!l.attribs.type || /html/.test(l.attribs.type))) ?? links.find((l) => !l.attribs.rel) ?? links[0];
  const href = pick?.attribs.href;
  return href ? absUrl(href, el.attribs['xml:base'] ? absUrl(el.attribs['xml:base'], base) ?? base : base) : undefined;
}

function parseRss(root: XEl, base: string): Feed {
  const ch = child(root, 'channel') ?? root;
  const itemsParent = local(root) === 'rdf' ? root : ch;
  const items: FeedItem[] = children(itemsParent, 'item').map((it) => {
    let link = squash(xtext(child(it, 'link')));
    if (!link) {
      const guid = child(it, 'guid');
      if (guid && (guid.attribs.isPermaLink ?? guid.attribs.ispermalink) !== 'false') link = squash(xtext(guid));
    }
    if (!link) link = child(it, 'enclosure')?.attribs.url ?? '';
    if (!link) link = it.attribs['rdf:about'] ?? '';
    const summary = textOf(child(it, 'description')) || textOf(child(it, 'content:encoded')) || textOf(child(it, 'media:description'));
    return {
      title: textOf(child(it, 'title')),
      link: link ? absUrl(link, base) : undefined,
      date: squash(xtext(child(it, 'pubdate', 'dc:date', 'published', 'updated'))),
      summary,
      author: squash(xtext(child(it, 'dc:creator', 'author'))),
    };
  });
  const atomSelf = kids(ch).find((c) => c.name.toLowerCase() === 'atom:link' && c.attribs.rel === 'alternate');
  const link = squash(xtext(child(ch, 'link'))) || atomSelf?.attribs.href;
  return {
    title: textOf(child(ch, 'title')),
    link: link ? absUrl(link, base) : undefined,
    description: textOf(child(ch, 'description')),
    items,
    format: local(root) === 'rdf' ? 'RSS 1.0' : 'RSS ' + (root.attribs.version ?? '2.0'),
  };
}

function parseAtom(root: XEl, base: string): Feed {
  const items = children(root, 'entry').map((e) => ({
    title: textOf(child(e, 'title')),
    link: atomLink(e, base),
    date: squash(xtext(child(e, 'published', 'updated', 'issued', 'modified'))),
    summary: textOf(child(e, 'summary')) || textOf(child(e, 'content')),
    author: squash(xtext(child(child(e, 'author') ?? e, 'name'))),
  }));
  return { title: textOf(child(root, 'title')), link: atomLink(root, base), description: textOf(child(root, 'subtitle')), items, format: 'Atom' };
}

export function parseJsonFeed(v: any, base: string): Feed | undefined {
  if (!v || typeof v !== 'object' || !Array.isArray(v.items) || !/jsonfeed\.org/.test(String(v.version ?? ''))) return undefined;
  const items = v.items.map((it: any) => ({
    title: squash(String(it.title ?? '')),
    link: typeof it.url === 'string' ? absUrl(it.url, base) : typeof it.external_url === 'string' ? absUrl(it.external_url, base) : undefined,
    date: String(it.date_published ?? it.date_modified ?? ''),
    summary: it.summary ? squash(String(it.summary)) : it.content_text ? squash(String(it.content_text)) : it.content_html ? stripHtml(String(it.content_html)) : '',
    author: (it.authors?.[0]?.name ?? it.author?.name ?? '') as string,
  }));
  return { title: String(v.title ?? ''), link: v.home_page_url ? absUrl(String(v.home_page_url), base) : undefined, description: v.description ? squash(String(v.description)) : '', items, format: 'JSON' };
}

export function parseFeedXml(text: string, base: string): Feed | undefined {
  const root = parseXml(text)[0];
  if (!root) return undefined;
  const r = local(root);
  if (r === 'rss' || r === 'rdf') return parseRss(root, base);
  if (r === 'feed') return parseAtom(root, base);
  return undefined;
}

// ───────────────────────────── rendering ─────────────────────────────

function isoParts(s: string): { d: string; t: string } | undefined {
  if (!s) return undefined;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  return { d: iso.slice(0, 10), t: iso.slice(11, 16) };
}

export function feedInto(feed: Feed, em: Emitter): void {
  if (feed.title) em.h(feed.title, 1);
  const meta: Inline[] = [];
  if (feed.description && feed.description !== feed.title) meta.push(trunc(feed.description, 300));
  if (feed.link) meta.push(meta.length ? ' · ' : '', linkAct(shortUrl(feed.link, em.base), feed.link));
  if (meta.length) em.add('p', meta);
  const items = feed.items.slice(0, MAX_ITEMS);
  if (!items.length) {
    em.text('(no items)');
    return;
  }
  const dates = items.map((it) => isoParts(it.date ?? ''));
  const days = dates.filter(Boolean).map((d) => d!.d);
  const withTime = new Set(days).size < days.length; // several items share a day: show the time too
  const hasDate = items.some((it) => it.date);
  const hasSummary = items.some((it) => it.summary);
  const g = em.group();
  const head: Inline[][] = [];
  if (hasDate) head.push(['date']);
  head.push(['title']);
  if (hasSummary) head.push(['summary']);
  em.row(head, g, true);
  items.forEach((it, i) => {
    const cells: Inline[][] = [];
    if (hasDate) {
      const p = dates[i];
      cells.push([p ? (withTime ? `${p.d} ${p.t}` : p.d) : trunc(it.date ?? '', 40)]);
    }
    let summary = it.summary ?? '';
    let title = it.title;
    if (!title) {
      // untitled items (microblogs): the text is the title
      title = summary ? (summary.length > 90 ? summary.slice(0, summary.lastIndexOf(' ', 90)) + '…' : summary) : it.link ? shortUrl(it.link, em.base) : '(untitled)';
      if (summary.length <= 90) summary = '';
    }
    cells.push([it.link ? linkAct(title, it.link) : title]);
    if (hasSummary) {
      let s = summary;
      if (it.title && s.startsWith(it.title)) s = s.slice(it.title.length).replace(/^[\s:.\-–—|]+/, '');
      cells.push([trunc(s, SUMMARY_MAX)]);
    }
    em.row(cells, g);
  });
  if (feed.items.length > items.length) em.text(`… +${feed.items.length - items.length} more items`);
}

export function readFeed(input: ReadInput, em = new Emitter(input.url)): ReadOutput {
  const text = input.text ?? new TextDecoder().decode(input.bytes ?? new Uint8Array());
  let feed: Feed | undefined;
  const t = text.trimStart();
  if (t.startsWith('{')) {
    try {
      feed = parseJsonFeed(JSON.parse(t), input.url);
    } catch {}
  } else feed = parseFeedXml(text, input.url);
  if (!feed) return { title: titleFromUrl(input.url), kind: 'feed', blocks: [], notes: ['not a recognised feed (RSS, Atom or JSON Feed)'] };
  feedInto(feed, em);
  return { title: feed.title || titleFromUrl(input.url), kind: 'feed', blocks: em.blocks, notes: [`${feed.format === 'JSON' ? 'JSON Feed' : feed.format + ' feed'}, ${plural(feed.items.length, 'item')}`] };
}
