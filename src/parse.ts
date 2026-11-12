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

const OPACITY_ZERO = /(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:;|$|!)/i;
const REALLY_HIDDEN = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|pointer-events\s*:\s*none|position\s*:\s*(?:absolute|fixed)|(?:max-)?(?:height|width)\s*:\s*0(?:px)?\s*(?:;|$))/i;

/**
 * `opacity:0` in server-rendered HTML is, far more often than a way to hide something, the first frame
 * of an entrance animation (framer-motion's initial state, usually with a transform) that the page's
 * script plays as soon as it runs. Without scripts that frame is all we get, and the content under it is
 * the page. Content that is also out of the flow, unclickable or collapsed stays hidden (honeypot fields).
 */
function fadeInStart(style: string): boolean {
  if (!OPACITY_ZERO.test(style) || REALLY_HIDDEN.test(style)) return false;
  // nothing else in the style hides it: only the opacity does
  return !HIDDEN_STYLE.test(style.replace(/opacity\s*:\s*0(?:\.0+)?\s*(?:!important)?\s*;?/gi, ''));
}

function staticallyHidden(a: Record<string, string>): boolean {
  if ('hidden' in a && a.hidden !== 'until-found') return true;
  if (a['aria-hidden'] === 'true') return true;
  if (a.style && HIDDEN_STYLE.test(a.style) && !fadeInStart(a.style)) return true;
  const c = a.class;
  if (c && HIDDEN_CLASS.test(c) && !SHOWN_AT_BREAKPOINT.test(c)) return true;
  return false;
}

const STATE_ASSIGN = /(?:^|[;\s,])(?:window\.|self\.|globalThis\.|var\s+|let\s+|const\s+)?([A-Za-z_$][\w$.]*)\s*=\s*(?=[\[{])/g;
const STATE_NAME = /state|data|props|payload|initial|preload|apollo|redux|nuxt|store|config|items|results|products|quotes|entries|bootstrap/i;

/**
 * Pages that render in the browser often ship their data as a JSON literal assigned in an inline
 * script (`window.__INITIAL_STATE__ = {...}`, `var data = [...]`). Capture literals that are valid
 * JSON so the content can be recovered without executing anything.
 */
function inlineState(js: string, meta: DocMeta) {
  if (js.length < 40 || js.length > 3_000_000) return;
  STATE_ASSIGN.lastIndex = 0;
  let m: RegExpExecArray | null;
  let tries = 0;
  while ((m = STATE_ASSIGN.exec(js)) && tries < 8) {
    const name = m[1];
    if (!STATE_NAME.test(name)) continue;
    tries++;
    const start = STATE_ASSIGN.lastIndex;
    const end = balancedEnd(js, start);
    if (end < 0 || end - start < 30) continue;
    const text = js.slice(start, end);
    try {
      JSON.parse(text);
    } catch {
      continue;
    }
    meta.json.push({ id: name, type: 'js-assign', text });
    STATE_ASSIGN.lastIndex = end;
  }
}

/** Index just past the bracket that closes the one at `start`, respecting strings; -1 if unbalanced. */
function balancedEnd(s: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) depth++;
    else if (c === 125 || c === 93) {
      if (--depth === 0) return i + 1;
    } else if (c === 39 || c === 96) return -1; // single quotes or templates: not JSON
  }
  return -1;
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
        } else if (!type || type.includes('javascript') || type === 'module') {
          meta.scripts++;
          if (!n.attribs?.src && meta.json.length < 12) inlineState(rawText(n), meta);
        }
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
          // a redirect, not a "this page reloads every minute": only short delays count
          if (m && !inNoscript && !(parseFloat(at.content ?? '') > 10)) meta.refresh = m[1].trim();
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
