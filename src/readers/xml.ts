// XML → blocks. Sitemaps and sitemap indexes become lists of links; feeds go to the feed reader;
// record-shaped XML (API responses) goes through the JSON writer so repeated elements become
// tables; document-shaped XML (mixed text and markup) becomes an indented outline.

import { linkAct } from '../blocks.ts';
import { squash } from '../tree.ts';
import type { ReadInput, ReadOutput } from '../types.ts';
import { feedInto, parseFeedXml } from './feed.ts';
import { JsonWriter, type J, type JObj } from './json.ts';
import { Emitter, absUrl, plural, shortUrl, titleFromUrl, trunc } from './util.ts';
import { type XEl, child, children, kids, local, ownText, parseXml, xtext } from './xmlutil.ts';

const MAX_LINKS = 2000;
const MAX_OUTLINE = 2000;

function sitemapInto(root: XEl, em: Emitter): number {
  const index = local(root) === 'sitemapindex';
  const entries = children(root, index ? 'sitemap' : 'url');
  em.h(index ? `Sitemap index (${plural(entries.length, 'sitemap')})` : `Sitemap (${plural(entries.length, 'URL')})`, 1);
  for (const e of entries.slice(0, MAX_LINKS)) {
    const loc = squash(xtext(child(e, 'loc')));
    const abs = loc && absUrl(loc, em.base);
    if (!abs) continue;
    const mod = squash(xtext(child(e, 'lastmod'))).slice(0, 10);
    em.add('li', mod ? [linkAct(shortUrl(abs, em.base), abs), ' ' + mod] : [linkAct(shortUrl(abs, em.base), abs)], { lv: 1 });
  }
  if (entries.length > MAX_LINKS) em.text(`… +${entries.length - MAX_LINKS} more`);
  return entries.length;
}

/** Element → JSON-like value: attributes as `@name`, repeated children as arrays, text as a string. */
export function xmlToValue(el: XEl): J {
  const o: JObj = {};
  for (const [k, v] of Object.entries(el.attribs)) {
    if (k === 'xmlns' || k.startsWith('xmlns:') || k.startsWith('xsi:')) continue;
    o['@' + k.slice(k.indexOf(':') + 1)] = v;
  }
  const ks = kids(el);
  const txt = squash(ownText(el));
  if (!ks.length) {
    if (!Object.keys(o).length) return txt;
    if (txt) o['#text'] = txt;
    return o;
  }
  for (const c of ks) {
    const name = c.name.slice(c.name.indexOf(':') + 1);
    const v = xmlToValue(c);
    if (name in o) {
      const cur = o[name];
      if (Array.isArray(cur) && (cur as any).__rep) cur.push(v);
      else {
        const arr: J[] = [cur, v];
        Object.defineProperty(arr, '__rep', { value: true });
        o[name] = arr;
      }
    } else o[name] = v;
  }
  if (txt) o['#text'] = txt;
  return o;
}

/** Share of text-bearing elements that mix text with child elements (prose-like markup). */
function mixedness(root: XEl): number {
  let mixed = 0;
  let texty = 0;
  const walk = (e: XEl) => {
    const t = ownText(e).trim();
    const ks = kids(e);
    if (t) {
      texty++;
      if (ks.length) mixed++;
    }
    for (const k of ks) walk(k);
  };
  walk(root);
  return texty ? mixed / texty : 0;
}

function outlineInto(root: XEl, em: Emitter): void {
  let n = 0;
  const walk = (e: XEl, depth: number) => {
    if (n >= MAX_OUTLINE) return;
    const name = local(e);
    if (name === 'script' || name === 'style') return;
    const ks = kids(e);
    const txt = squash(ks.length ? ownText(e) : xtext(e));
    const attrs = Object.entries(e.attribs).filter(([k]) => !k.startsWith('xmlns')).slice(0, 4).map(([k, v]) => `${k}=${trunc(v, 60)}`);
    const label = name + (attrs.length ? ` [${attrs.join(', ')}]` : '');
    if (txt || attrs.length || ks.length) {
      em.add('li', [txt ? `${label}: ${trunc(txt, 1000)}` : label], { lv: Math.min(depth + 1, 8) });
      n++;
    }
    for (const k of ks) walk(k, depth + 1);
  };
  walk(root, 0);
  if (n >= MAX_OUTLINE) em.text('… outline truncated');
}

export function readXml(input: ReadInput, em = new Emitter(input.url)): ReadOutput {
  const text = input.text ?? new TextDecoder().decode(input.bytes ?? new Uint8Array());
  const roots = parseXml(text);
  const root = roots[0];
  if (!root) return { title: titleFromUrl(input.url), kind: 'text', blocks: [], notes: ['empty or unparseable XML'] };
  const r = local(root);
  if (r === 'urlset' || r === 'sitemapindex') {
    const n = sitemapInto(root, em);
    return { title: r === 'urlset' ? 'Sitemap' : 'Sitemap index', kind: 'feed', blocks: em.blocks, notes: [`${r === 'urlset' ? 'sitemap' : 'sitemap index'}, ${n} entries`] };
  }
  if (r === 'rss' || r === 'rdf' || r === 'feed') {
    const feed = parseFeedXml(text, input.url);
    if (feed) {
      feedInto(feed, em);
      return { title: feed.title || titleFromUrl(input.url), kind: 'feed', blocks: em.blocks, notes: [`${feed.format} feed, ${plural(feed.items.length, 'item')}`] };
    }
  }
  const title = squash(xtext(child(root, 'title'))) || root.name;
  if (mixedness(root) > 0.15) {
    outlineInto(root, em);
    return { title, kind: 'text', blocks: em.blocks, notes: [`XML document <${root.name}>, outline`] };
  }
  em.h(root.name, 1);
  new JsonWriter(em).value(xmlToValue(root), '', 0, true);
  return { title, kind: 'text', blocks: em.blocks, notes: [`XML <${root.name}>`] };
}
