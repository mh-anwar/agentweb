// Shared helpers for the readers: a block emitter with group ids, URL shortening, HTML stripping,
// truncation, and table rows in the one shape every reader uses.

import { parseDocument } from 'htmlparser2';
import { linkAct, mkBlock } from '../blocks.ts';
import { squash } from '../tree.ts';
import type { Act, Block, BlockKind, Inline } from '../types.ts';

/** Collects blocks in priority order. Group ids are unique within one emitter. */
export class Emitter {
  blocks: Block[] = [];
  notes: string[] = [];
  base: string;
  private nextG: number;
  constructor(base: string, firstGroup = 1) {
    this.base = base;
    this.nextG = firstGroup;
  }
  group(): number {
    return this.nextG++;
  }
  add(k: BlockKind, i: Inline[], extra?: Partial<Omit<Block, 'k' | 'i' | 'hx'>>): void {
    const clean = tidy(i);
    if (clean.every((x) => typeof x === 'string' && !x.trim())) return;
    this.blocks.push(mkBlock(k, clean, extra));
  }
  text(s: string, k: BlockKind = 'p', extra?: Partial<Omit<Block, 'k' | 'i' | 'hx'>>): void {
    if (k !== 'pre') s = squash(s);
    if (s) this.blocks.push(mkBlock(k, [s], extra));
  }
  h(s: string, lv: number): void {
    this.text(s, 'h', { lv: Math.max(1, Math.min(6, lv)) });
  }
  /** One table row: cells separated by ' | '. */
  row(cells: Inline[][], g: number, hd?: boolean): void {
    const i: Inline[] = [];
    cells.forEach((c, n) => {
      if (n) i.push(' | ');
      for (const x of c) i.push(typeof x === 'string' ? x.replace(/\|/g, '¦') : x);
    });
    const b = mkBlock('row', tidy(i), hd ? { g, hd: true } : { g });
    this.blocks.push(b);
  }
  /** Append blocks built by another emitter, giving their table groups fresh ids here. */
  adopt(bs: Block[]): void {
    const map = new Map<number, number>();
    for (const b of bs) {
      if (b.g !== undefined) {
        if (!map.has(b.g)) map.set(b.g, this.group());
        b.g = map.get(b.g);
      }
      this.blocks.push(b);
    }
  }
  /** The same block with new inline content (and a fresh hash). */
  remake(b: Block, i: Inline[], k: BlockKind = b.k): Block {
    const { k: _k, i: _i, hx: _h, ...rest } = b;
    return mkBlock(k, tidy(i), rest);
  }
  note(s: string): void {
    if (!this.notes.includes(s)) this.notes.push(s);
  }
}

/** Merge adjacent strings and drop empty ones. */
function tidy(i: Inline[]): Inline[] {
  const out: Inline[] = [];
  for (const x of i) {
    if (typeof x === 'string') {
      if (!x) continue;
      const last = out[out.length - 1];
      if (typeof last === 'string') out[out.length - 1] = last + x;
      else out.push(x);
    } else out.push(x);
  }
  return out;
}

// ───────────────────────────── strings ─────────────────────────────

/** Truncate to `max` characters, noting the full length. */
export function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.7) cut = cut.slice(0, sp);
  return cut.replace(/[\s,;:.]+$/, '') + `…(${s.length} chars)`;
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre',
  'section', 'article', 'header', 'footer', 'hr', 'dd', 'dt', 'figure', 'figcaption',
]);

/** Text of an HTML fragment. Block elements become newlines; scripts and styles are dropped. */
export function htmlText(html: string): string {
  if (!/[<&]/.test(html)) return html;
  const dom = parseDocument(html, { decodeEntities: true });
  let s = '';
  const walk = (nodes: any[]) => {
    for (const n of nodes) {
      if (n.type === 'text') s += n.data;
      else if (n.type === 'tag') {
        const t = n.name.toLowerCase();
        if (t === 'script' || t === 'style' || t === 'template') continue;
        if (t === 'img') {
          const alt = n.attribs?.alt;
          if (alt) s += alt;
          continue;
        }
        const blk = BLOCK_TAGS.has(t);
        if (blk) s += '\n';
        if (n.children) walk(n.children);
        if (blk) s += '\n';
      } else if (n.type === 'cdata' && n.children) walk(n.children);
    }
  };
  walk(dom.children);
  return s.replace(/[ \t ]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim();
}

/** One-line plain text of an HTML fragment. Block boundaries without punctuation become '; '. */
export const stripHtml = (html: string): string => squash(htmlText(html).replace(/([^\n])\n+(?=.)/g, (_m, c: string) => (/[.!?:;,]/.test(c) ? c + ' ' : c + '; ')));

export const looksHtml = (s: string) => /<\/?(p|div|br|span|a|ul|ol|li|b|i|em|strong|h[1-6]|img|table|code)\b[^>]*>/i.test(s);

// ───────────────────────────── URLs ─────────────────────────────

export const isUrl = (s: string) => s.length < 2048 && /^https?:\/\/[^\s/$.?#][^\s]*$/i.test(s);
/** URI templates (RFC 6570), as in GitHub's `issues_url`. Not navigable. */
export const isTemplate = (s: string) => /\{[^}\s]*\}/.test(s);

export function absUrl(href: string, base: string): string | undefined {
  const h = href.trim();
  if (!h || /^(javascript|data|vbscript):/i.test(h)) return undefined;
  try {
    const u = base ? new URL(h, base) : new URL(h);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:' || u.protocol === 'tel:') return u.href;
  } catch {}
  return undefined;
}

/** A compact label for a URL: no scheme or www, and only the path when it is on the page's own origin. */
export function shortUrl(href: string, base: string): string {
  let origin = '';
  try {
    origin = new URL(base).origin;
  } catch {}
  try {
    const u = new URL(href);
    if (u.protocol === 'mailto:' || u.protocol === 'tel:') return u.pathname;
    const tail = decodeSafe(u.pathname + u.search + u.hash);
    if (origin && u.origin === origin) return tail || '/';
    const host = u.host.replace(/^www\./, '');
    return tail === '/' ? host : host + tail;
  } catch {
    return href.replace(/^https?:\/\/(www\.)?/i, '');
  }
}

function decodeSafe(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

/** A link act if the string is a navigable URL, else the compact text form. */
export function urlInline(s: string, base: string, label?: string): Inline {
  if (isTemplate(s)) return label ?? shortUrl(s, base);
  const abs = absUrl(s, base);
  if (!abs) return s;
  return linkAct(label ?? shortUrl(abs, base), abs);
}

/** Longest common prefix of strings, cut back to the last '/'. */
export function commonPathPrefix(xs: string[]): string {
  if (xs.length < 2) return '';
  let p = xs[0];
  for (const x of xs) {
    let i = 0;
    while (i < p.length && i < x.length && p[i] === x[i]) i++;
    p = p.slice(0, i);
    if (!p) return '';
  }
  const slash = p.lastIndexOf('/');
  return slash > 0 ? p.slice(0, slash + 1) : '';
}

export function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
}

export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? decodeSafe(seg) : u.host;
  } catch {
    return url;
  }
}

export type { Act, Inline };
