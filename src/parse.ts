// HTTP tier: HTML text -> LNode tree. No JavaScript is executed, no CSS is evaluated,
// so "hidden" here is a static guess from attributes, inline styles and well-known
// utility classes. The browser tier replaces the guess with computed style.

import { parseDocument } from 'htmlparser2';
import { ATTRS, type Doc, type DocMeta, type LNode } from './tree.ts';

const DROP = new Set(['style', 'template', 'object', 'embed', 'param', 'source', 'track', 'map', 'area', 'colgroup', 'col']);
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?:\.0+)?\s*(?:;|$|!)|font-size\s*:\s*0(?:px|em|rem|pt|%)?\s*(?:;|$|!)|(?:left|top|text-indent)\s*:\s*-\d{4,}px|(?:max-)?(?:height|width)\s*:\s*0(?:px)?\s*;[^]*overflow\s*:\s*hidden|clip\s*:\s*rect\(\s*0)/i;
const HIDDEN_CLASS = /(?:^|\s)(?:d-none|hidden|is-hidden|u-hidden|hide|invisible|display-none|js-hidden)(?:\s|$)/;
const SHOWN_AT_BREAKPOINT = /(?:^|\s)(?:(?:sm|md|lg|xl|2xl|max-\w+):(?:block|flex|grid|inline|inline-block|inline-flex|table|contents|visible)|d-(?:sm|md|lg|xl|xxl)-(?:block|flex|inline|inline-block|grid|table))(?:\s|$)/;
const SR_CLASS = /(?:^|\s)(?:sr-only|visually-hidden|visuallyhidden|screen-reader-text|screen-reader-only|a11y-hidden|assistive-text|u-visually-hidden|show-for-sr|offscreen)(?:\s|$)/i;

function staticallyHidden(a: Record<string, string>): boolean {
  if ('hidden' in a && a.hidden !== 'until-found') return true;
  if (a['aria-hidden'] === 'true') return true;
  if (a.style && HIDDEN_STYLE.test(a.style)) return true;
  const c = a.class;
  if (c && HIDDEN_CLASS.test(c) && !SHOWN_AT_BREAKPOINT.test(c)) return true;
  return false;
}

export function parseHtml(html: string): Doc {
  const dom = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  const meta: DocMeta = { title: '', scripts: 0, json: [], links: [], noscript: '' };
  const root: LNode = { t: 'html', c: [] };
  let ogTitle = '';

  const rawText = (el: any): string => {
    let s = '';
    for (const c of el.children ?? []) s += c.type === 'text' ? c.data : rawText(c);
    return s;
  };

  const conv = (nodes: any[], out: LNode[], depth: number, inNoscript: boolean) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        if (n.data) out.push({ t: '#text', x: n.data });
        continue;
      }
      if (n.type === 'script') {
        const type = (n.attribs?.type ?? '').toLowerCase();
        const id = n.attribs?.id ?? '';
        if (type.includes('json') || id === '__NEXT_DATA__') {
          const t = rawText(n);
          if (t.length > 1 && t.length < 4_000_000) meta.json.push({ id, type, text: t });
        } else if (!type || type.includes('javascript') || type === 'module') meta.scripts++;
        continue;
      }
      if (n.type !== 'tag') continue; // comments, directives, style
      const tag: string = n.name;
      if (DROP.has(tag)) continue;
      const at: Record<string, string> = n.attribs ?? {};
      if (tag === 'title' && !meta.title && depth < 4) { meta.title = rawText(n).replace(/\s+/g, ' ').trim(); continue; }
      if (tag === 'base') { if (at.href && !meta.base) meta.base = at.href; continue; }
      if (tag === 'meta') {
        const key = (at.name ?? at.property ?? at['http-equiv'] ?? '').toLowerCase();
        if (key === 'description' || key === 'og:description') meta.description ??= at.content;
        else if (key === 'og:title') ogTitle = at.content ?? '';
        else if (key === 'refresh') {
          const m = /url\s*=\s*['"]?([^'";]+)/i.exec(at.content ?? '');
          if (m && !inNoscript) meta.refresh = m[1].trim();
        }
        continue;
      }
      if (tag === 'link') {
        const rel = (at.rel ?? '').toLowerCase();
        if (at.href && (rel === 'search' || rel === 'alternate' || rel === 'canonical')) {
          meta.links.push({ rel, href: at.href, type: at.type, title: at.title });
        }
        continue;
      }
      if (tag === 'html' && at.lang) meta.lang = at.lang;

      const node: LNode = { t: tag };
      let a: Record<string, string> | undefined;
      for (const k in at) {
        if (ATTRS.has(k)) (a ??= {})[k] = at[k];
      }
      if (a) node.a = a;
      if (staticallyHidden(at)) node.h = 1;
      else if (at.class && SR_CLASS.test(at.class)) node.sr = 1;
      if (tag === 'input' && (at.type ?? '').toLowerCase() === 'hidden') node.h = 1;

      if (tag === 'noscript') {
        // htmlparser2 parses <noscript> children as markup, which is what a no-JS client should see.
        meta.noscript += ' ' + rawText(n).slice(0, 2000);
      }
      if (tag === 'svg') {
        // keep only an accessible name for the icon
        const title = findTitle(n);
        if (title) node.c = [{ t: '#text', x: title }];
        out.push(node);
        continue;
      }
      if (n.children?.length && depth < 600) {
        const kids: LNode[] = [];
        conv(n.children, kids, depth + 1, inNoscript || tag === 'noscript');
        if (kids.length) node.c = kids;
      }
      out.push(node);
    }
  };

  const findTitle = (svg: any): string => {
    for (const c of svg.children ?? []) {
      if (c.type === 'tag' && c.name === 'title') return rawText(c).trim();
    }
    return '';
  };

  conv(dom.children as any[], root.c!, 0, false);
  if (!meta.title) meta.title = ogTitle;
  return { root, meta };
}
