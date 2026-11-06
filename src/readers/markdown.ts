// Markdown → blocks. Used when a site honours `Accept: text/markdown`, for llms.txt, and for
// markdown strings found inside JSON (READMEs). Block structure follows CommonMark closely enough
// for real documentation: ATX/setext headings, nested lists with continuation, fenced and indented
// code, block quotes (with GitHub alerts), GFM tables, HTML blocks, reference links, front matter.
// Inline: links become link Acts resolved against the page URL, images become their alt text,
// emphasis markers are dropped, code spans keep their backticks.

import { linkAct, mkBlock } from '../blocks.ts';
import type { Block, Inline, ReadInput, ReadOutput } from '../types.ts';
import { Emitter, absUrl, htmlText, shortUrl, titleFromUrl } from './util.ts';

export interface MdOpts {
  /** added to every heading level (markdown nested in another document) */
  headingOffset?: number;
}

interface Ctx {
  em: Emitter;
  base: string;
  refs: Map<string, string>;
  off: number;
  title?: string;
}

const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const BULLET = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const HTMLSTART = /^ {0,3}<(\/?(address|article|aside|blockquote|body|center|details|dialog|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hr|html|iframe|legend|li|main|menu|nav|ol|p|picture|pre|section|summary|table|tbody|td|tfoot|th|thead|tr|ul|video|audio|script|style|img|br|[A-Z][\w.]*)(?=[\s/>]|$)|!--|\?|![A-Z])/;
const TABLE_DELIM = /^ *\|? *:?-{1,}:? *(\| *:?-{1,}:? *)*\|? *$/;
const REFDEF = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

export function markdownInto(src: string, em: Emitter, opts: MdOpts = {}): { title?: string; description?: string } {
  let text = src.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const meta: { title?: string; description?: string } = {};
  // front matter
  const fm = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^(title|description):\s*(.+)$/.exec(line);
      if (m) (meta as any)[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
    text = text.slice(fm[0].length);
  }
  const lines = text.split('\n').map(expandTabs);
  const refs = new Map<string, string>();
  // reference definitions (outside code fences)
  let fence: string | null = null;
  const kept: string[] = [];
  for (const l of lines) {
    const f = FENCE.exec(l);
    if (fence) {
      if (f && f[2][0] === fence[0] && f[2].length >= fence.length && !f[3]) fence = null;
      kept.push(l);
      continue;
    }
    if (f) {
      fence = f[2];
      kept.push(l);
      continue;
    }
    const r = REFDEF.exec(l);
    if (r) {
      const key = normRef(r[1]);
      if (!refs.has(key)) refs.set(key, r[2]);
      continue;
    }
    kept.push(l);
  }
  const ctx: Ctx = { em, base: em.base, refs, off: opts.headingOffset ?? 0 };
  const firstBlock = em.blocks.length;
  if (meta.title) {
    const hasH1 = kept.slice(0, 40).some((l) => /^# /.test(l));
    if (!hasH1) em.h(meta.title, 1 + ctx.off);
  }
  blocks(kept, ctx, 0);
  if (meta.description) {
    // after the document's first top heading, if it has one near the start
    const at = em.blocks.findIndex((b, i) => i >= firstBlock && b.k === 'h' && b.lv === 1 + ctx.off);
    const desc = mkBlock('p', [meta.description]);
    if (at >= 0 && at - firstBlock < 3) em.blocks.splice(at + 1, 0, desc);
    else em.blocks.splice(firstBlock, 0, desc);
  }
  meta.title ??= em.blocks.slice(firstBlock).find((b) => b.k === 'h' && b.lv === 1 + ctx.off)?.i.map((x) => (typeof x === 'string' ? x : x.l)).join('').trim();
  return meta;
}

function expandTabs(l: string): string {
  if (!l.includes('\t')) return l;
  // only leading tabs matter for structure
  const m = /^[ \t]*/.exec(l)![0];
  let col = 0;
  for (const ch of m) col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
  return ' '.repeat(col) + l.slice(m.length);
}

const indentOf = (l: string) => /^ */.exec(l)![0].length;
const blank = (l: string) => !l.trim();
const normRef = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function isTableStart(lines: string[], i: number): boolean {
  const a = lines[i];
  const b = lines[i + 1];
  if (b === undefined || !a.includes('|') || !TABLE_DELIM.test(b) || !b.includes('-')) return false;
  if (!b.includes('|') && !a.trim().startsWith('|')) return false;
  return splitCells(a).length === splitCells(b).length || b.includes('|');
}

/** Does this line start a block that interrupts a paragraph? */
function interrupts(l: string, inList: boolean): boolean {
  if (ATX.test(l) || FENCE.test(l) || HR.test(l) || QUOTE.test(l)) return true;
  if (HTMLSTART.test(l) && /^ {0,3}<(\/?(div|details|summary|table|p|section|pre|ul|ol|h[1-6]|blockquote|figure|hr|br|img|picture|video|iframe)\b|!--)/i.test(l)) return true;
  const b = BULLET.exec(l);
  if (b && b[4].trim() && (inList || /^[-*+]$|^1[.)]$/.test(b[2])) && indentOf(l) < 4) return true;
  return false;
}

/** Parse a run of lines at one container level. `lv` is the list nesting depth. */
function blocks(lines: string[], ctx: Ctx, lv: number, firstAsItem?: { ord?: number; task?: string }): void {
  const em = ctx.em;
  let para: string[] = [];
  let item = firstAsItem;
  const flush = () => {
    if (!para.length) return;
    const inl = inline(para.join('\n'), ctx);
    if (item) {
      em.add('li', inl, item.ord !== undefined ? { lv, ord: item.ord } : { lv });
      item = undefined;
    } else em.add('p', inl);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) {
      flush();
      i++;
      continue;
    }
    // fenced code
    const f = FENCE.exec(l);
    if (f) {
      flush();
      const ind = f[1].length;
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const c = FENCE.exec(lines[i]);
        if (c && c[2][0] === f[2][0] && c[2].length >= f[2].length && !c[3] && !/[^`~\s]/.test(lines[i].trim().replace(/^[`~]+/, ''))) {
          i++;
          break;
        }
        code.push(lines[i].slice(Math.min(ind, indentOf(lines[i]))));
        i++;
      }
      pre(code, ctx, item);
      item = undefined;
      continue;
    }
    // indented code (not inside a paragraph)
    if (!para.length && indentOf(l) >= 4) {
      const code: string[] = [];
      while (i < lines.length && (indentOf(lines[i]) >= 4 || blank(lines[i]))) code.push(lines[i++].slice(4));
      while (code.length && blank(code[code.length - 1])) code.pop();
      pre(code, ctx, item);
      item = undefined;
      continue;
    }
    // ATX heading
    const h = ATX.exec(l);
    if (h) {
      flush();
      em.add('h', inline(h[2] ?? '', ctx), { lv: Math.min(6, h[1].length + ctx.off) });
      i++;
      continue;
    }
    // setext heading
    if (para.length && /^ {0,3}(=+|-+)[ \t]*$/.test(l) && !item) {
      const lvl = l.trim()[0] === '=' ? 1 : 2;
      em.add('h', inline(para.join('\n'), ctx), { lv: Math.min(6, lvl + ctx.off) });
      para = [];
      i++;
      continue;
    }
    if (HR.test(l)) {
      flush();
      i++;
      continue;
    }
    // block quote
    if (QUOTE.test(l)) {
      flush();
      const inner: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]);
        if (q) inner.push(q[1]);
        else if (!blank(lines[i]) && inner.length && !blank(inner[inner.length - 1]) && !interrupts(lines[i], false)) inner.push(lines[i]);
        else break;
        i++;
      }
      quote(inner, ctx);
      continue;
    }
    // table
    if (isTableStart(lines, i)) {
      flush();
      const g = em.group();
      em.row(splitCells(lines[i]).map((c) => inline(c, ctx)), g, true);
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i].includes('|') && !interrupts(lines[i], false)) {
        em.row(splitCells(lines[i]).map((c) => inline(c, ctx)), g);
        i++;
      }
      continue;
    }
    // list
    const b = BULLET.exec(l);
    if (b && indentOf(l) < 4 && (!para.length || interrupts(l, lv > 0))) {
      flush();
      i = list(lines, i, ctx, lv);
      continue;
    }
    // HTML block
    if (!para.length && HTMLSTART.test(l)) {
      const html: string[] = [];
      if (/^ {0,3}<!--/.test(l)) {
        while (i < lines.length) {
          const done = lines[i].includes('-->');
          i++;
          if (done) break;
        }
        continue;
      }
      while (i < lines.length && !blank(lines[i])) html.push(lines[i++]);
      const txt = htmlText(html.join('\n'));
      for (const t of txt.split('\n')) if (t.trim()) {
        if (item) {
          em.add('li', inline(t, ctx), item.ord !== undefined ? { lv, ord: item.ord } : { lv });
          item = undefined;
        } else em.add('p', inline(t, ctx));
      }
      continue;
    }
    para.push(l.trim());
    i++;
  }
  flush();
  if (item) em.add('li', [item.task ?? ''], item.ord !== undefined ? { lv, ord: item.ord } : { lv });
}

function pre(code: string[], ctx: Ctx, _item?: { ord?: number }) {
  // trim common indentation and trailing blank lines
  while (code.length && blank(code[0])) code.shift();
  while (code.length && blank(code[code.length - 1])) code.pop();
  if (!code.length) return;
  const ind = Math.min(...code.filter((c) => !blank(c)).map(indentOf));
  const body = code.map((c) => c.slice(ind).trimEnd()).join('\n');
  ctx.em.text(body, 'pre');
}

function quote(inner: string[], ctx: Ctx) {
  let alert = '';
  const m = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(inner[0] ?? '');
  if (m) {
    alert = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + ': ';
    inner = inner.slice(1);
  }
  const sub = new Emitter(ctx.base, 0);
  blocks(inner, { ...ctx, em: sub }, 0);
  const out: Block[] = [];
  for (const b of sub.blocks) {
    if (b.k === 'p' || b.k === 'h') {
      const i = alert ? [alert, ...b.i] : b.i;
      alert = '';
      const { lv: _lv, ...rest } = b;
      out.push(sub.remake(rest as Block, i, 'q'));
    } else out.push(b);
  }
  ctx.em.adopt(out);
}

/** Parse a list starting at line i; returns the index after it. */
function list(lines: string[], i: number, ctx: Ctx, lv: number): number {
  const first = BULLET.exec(lines[i])!;
  const ordered = /\d/.test(first[2]);
  const delim = first[2].slice(-1);
  let n = ordered ? parseInt(first[2], 10) : 0;
  const baseIndent = indentOf(lines[i]);
  while (i < lines.length) {
    const m = BULLET.exec(lines[i]);
    if (!m || indentOf(lines[i]) < baseIndent - 0 || indentOf(lines[i]) > baseIndent + 3) break;
    if (/\d/.test(m[2]) !== ordered || m[2].slice(-1) !== delim) break;
    const pad = m[3].length > 4 || m[4] === '' ? 1 : m[3].length;
    const w = m[1].length + m[2].length + pad;
    const content: string[] = [m[4] === '' ? '' : ' '.repeat(Math.max(0, m[3].length - pad)) + m[4]];
    i++;
    let sawBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (blank(l)) {
        sawBlank = true;
        content.push('');
        i++;
        continue;
      }
      if (indentOf(l) >= w) {
        content.push(l.slice(w));
        sawBlank = false;
        i++;
        continue;
      }
      // lazy continuation of the item's paragraph
      if (!sawBlank && !interrupts(l, true) && !BULLET.test(l) && !isTableStart(lines, i)) {
        content.push(l.trim());
        i++;
        continue;
      }
      break;
    }
    while (content.length && blank(content[content.length - 1])) content.pop();
    let task: string | undefined;
    const t = /^\[([ xX])\]\s+/.exec(content[0] ?? '');
    if (t) {
      task = t[1] === ' ' ? '[ ] ' : '[x] ';
      content[0] = content[0].slice(t[0].length);
    }
    const before = ctx.em.blocks.length;
    blocks(content, ctx, lv + 1, { ord: ordered ? n : undefined, task });
    if (task) {
      const b = ctx.em.blocks[before];
      if (b && b.k === 'li') ctx.em.blocks[before] = ctx.em.remake(b, [task, ...b.i]);
    }
    n++;
    // a blank line followed by something that is not another item of this list ends it
    if (i < lines.length && !BULLET.test(lines[i])) break;
  }
  return i;
}

function splitCells(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  let code = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      code = code === run ? 0 : code || run;
      cur += s.slice(i, i + run);
      i += run - 1;
    } else if (c === '|' && !code) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

// ───────────────────────────── inline ─────────────────────────────

const ENT: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', rarr: '→', larr: '←', middot: '·', bull: '•',
};
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const PUNCT = /[!-/:-@[-`{-~]/;
const WS = /\s/;

/** Inline markdown → Inline[]: text plus link Acts. */
export function inline(src: string, ctx: Ctx | { base: string; refs: Map<string, string> }): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const push = (x: Inline) => {
    if (typeof x === 'string') buf += x;
    else {
      if (buf) out.push(buf);
      buf = '';
      out.push(x);
    }
  };
  const s = src;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      push(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      push(' ');
      i += 2;
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (s[i + run] === '`') run++;
      const tick = '`'.repeat(run);
      let j = i + run;
      let end = -1;
      while ((j = s.indexOf(tick, j)) !== -1) {
        if (s[j + run] !== '`' && s[j - 1] !== '`') {
          end = j;
          break;
        }
        j += run;
      }
      if (end !== -1) {
        let code = s.slice(i + run, end).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
        push('`' + code + '`');
        i = end + run;
        continue;
      }
      push(tick);
      i += run;
      continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      const l = link(s, i + 1, ctx);
      if (l) {
        push(plain(l.label, ctx));
        i = l.end;
        continue;
      }
    }
    if (c === '[') {
      const l = link(s, i, ctx);
      if (l) {
        const label = plain(l.label, ctx) || shortUrl(l.href, ctx.base);
        const abs = absUrl(l.href, ctx.base);
        push(abs ? linkAct(label, abs) : label);
        i = l.end;
        continue;
      }
    }
    if (c === '<') {
      const auto = /^<((?:https?|mailto|ftp):[^\s<>]+|[\w.+-]+@[\w-]+\.[\w.-]+)>/.exec(s.slice(i));
      if (auto) {
        const href = auto[1].includes(':') ? auto[1] : 'mailto:' + auto[1];
        const abs = absUrl(href, ctx.base);
        push(abs ? linkAct(href.startsWith('mailto:') ? auto[1].replace(/^mailto:/, '') : shortUrl(abs, ctx.base), abs) : auto[1]);
        i += auto[0].length;
        continue;
      }
      const a = /^<a\s[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/i.exec(s.slice(i));
      if (a) {
        const label = plain(a[2], ctx);
        const abs = absUrl(decodeEntities(a[1]), ctx.base);
        push(abs && label ? linkAct(label, abs) : label);
        i += a[0].length;
        continue;
      }
      const img = /^<img\s[^>]*?alt\s*=\s*["']([^"']*)["'][^>]*>/i.exec(s.slice(i));
      if (img) {
        push(decodeEntities(img[1]));
        i += img[0].length;
        continue;
      }
      const tag = /^<\/?[A-Za-z][\w.-]*(?:\s[^<>]*)?\/?>|^<!--[\s\S]*?-->/.exec(s.slice(i));
      if (tag) {
        if (/^<br/i.test(tag[0])) push(' ');
        i += tag[0].length;
        continue;
      }
    }
    if (c === 'h' && (s.startsWith('http://', i) || s.startsWith('https://', i)) && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      const m = /^https?:\/\/[^\s<>]*[^\s<>.,:;"')\]*_~]/.exec(s.slice(i));
      if (m) {
        push(linkAct(shortUrl(m[0], ctx.base), m[0]));
        i += m[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (s[i + run] === c) run++;
      const prev = i > 0 ? s[i - 1] : ' ';
      const next = i + run < s.length ? s[i + run] : ' ';
      const leftFlank = !WS.test(next) && (!PUNCT.test(next) || WS.test(prev) || PUNCT.test(prev));
      const rightFlank = !WS.test(prev) && (!PUNCT.test(prev) || WS.test(next) || PUNCT.test(next));
      let delim = leftFlank || rightFlank;
      if (c === '_' && /\w/.test(prev) && /\w/.test(next)) delim = false; // snake_case
      if (c === '~' && run === 1) delim = false;
      if (delim) {
        i += run;
        continue;
      }
      push(s.slice(i, i + run));
      i += run;
      continue;
    }
    if (c === '&') {
      const m = /^&(#x[0-9a-f]+|#\d+|[a-z]+);/i.exec(s.slice(i));
      if (m) {
        push(decodeEntities(m[0]));
        i += m[0].length;
        continue;
      }
    }
    push(c === '\n' ? ' ' : c);
    i++;
  }
  if (buf) out.push(buf);
  // whitespace: collapse runs, trim the ends
  const res: Inline[] = [];
  for (const x of out) res.push(typeof x === 'string' ? x.replace(/\s+/g, ' ') : x);
  if (typeof res[0] === 'string') res[0] = (res[0] as string).trimStart();
  const last = res.length - 1;
  if (typeof res[last] === 'string') res[last] = (res[last] as string).trimEnd();
  return res.filter((x) => x !== '');
}

/** Plain text of inline markdown (link labels, alt text). */
function plain(src: string, ctx: { base: string; refs: Map<string, string> }): string {
  return inline(src, ctx).map((x) => (typeof x === 'string' ? x : x.l)).join('').replace(/\s+/g, ' ').trim();
}

/** `[label](dest "title")`, `[label][ref]`, `[label][]`, `[label]` starting at s[i] === '['. */
function link(s: string, i: number, ctx: { refs: Map<string, string> }): { label: string; href: string; end: number } | undefined {
  // matching bracket, skipping code spans and escapes
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') {
      j++;
      continue;
    }
    if (c === '`') {
      let run = 1;
      while (s[j + run] === '`') run++;
      const close = s.indexOf('`'.repeat(run), j + run);
      if (close !== -1) {
        j = close + run - 1;
        continue;
      }
    }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
  }
  if (j >= s.length) return undefined;
  const label = s.slice(i + 1, j);
  let k = j + 1;
  if (s[k] === '(') {
    k++;
    while (s[k] === ' ' || s[k] === '\n') k++;
    let dest = '';
    if (s[k] === '<') {
      const close = s.indexOf('>', k);
      if (close === -1) return undefined;
      dest = s.slice(k + 1, close);
      k = close + 1;
    } else {
      let par = 0;
      while (k < s.length && !/\s/.test(s[k])) {
        if (s[k] === '\\' && k + 1 < s.length) {
          dest += s[k + 1];
          k += 2;
          continue;
        }
        if (s[k] === '(') par++;
        else if (s[k] === ')') {
          if (par === 0) break;
          par--;
        }
        dest += s[k++];
      }
    }
    while (s[k] === ' ' || s[k] === '\n') k++;
    if (s[k] === '"' || s[k] === "'" || s[k] === '(') {
      const close = s.indexOf(s[k] === '(' ? ')' : s[k], k + 1);
      if (close === -1) return undefined;
      k = close + 1;
      while (s[k] === ' ' || s[k] === '\n') k++;
    }
    if (s[k] !== ')') return undefined;
    return { label, href: decodeEntities(dest), end: k + 1 };
  }
  if (s[k] === '[') {
    const close = s.indexOf(']', k);
    if (close !== -1) {
      const ref = s.slice(k + 1, close) || label;
      const href = ctx.refs.get(normRef(ref));
      if (href) return { label, href, end: close + 1 };
    }
  }
  const href = ctx.refs.get(normRef(label));
  if (href) return { label, href, end: j + 1 };
  return undefined;
}

export function readMarkdown(input: ReadInput, em = new Emitter(input.url)): ReadOutput {
  const text = input.text ?? new TextDecoder().decode(input.bytes ?? new Uint8Array());
  const meta = markdownInto(text, em);
  return { title: meta.title || titleFromUrl(input.url), kind: 'markdown', blocks: em.blocks, notes: em.notes.length ? em.notes : undefined };
}
