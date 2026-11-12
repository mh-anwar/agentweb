// The renderer: a Page -> the text an agent reads.
//
// Three promises it keeps:
//   1. Bounded: the result never exceeds the token budget of the call.
//   2. Stable: an actionable keeps the same number for the whole session.
//   3. No repeats: a line the agent was shown recently is not shown again; an action on the same
//      page returns only what changed, and navigation boilerplate collapses after its first showing.
//
// Notation (documented to the model in the tool description):
//   [label]12            clickable (link or button); click(12)
//   {label="value"}13    fillable; fill(13, 'text')
//   {label: *A|B|C}14    select, * marks the current option; select(14, 'B')
//   {[x] label}15        checkbox ( (x) for radio ); check(15) / uncheck(15)
//   ! text               alert, error or dialog content

import { actText, blockText, words } from './blocks.ts';
import { clipToTokens, estimateTokens } from './tokens.ts';
import type { Act, Block, Page, Region } from './types.ts';

export interface Refs {
  /** the session-stable number for an actionable (allocates on first use) */
  of(a: Act): number;
}

export interface ViewState {
  /** call sequence number of the current call */
  seq: number;
  /** block hash -> seq at which it was last shown */
  seen: Record<string, number>;
  /** the last page view shown to the agent */
  last?: { url: string; seq: number };
  /** index of the first main-content block not yet shown (where `read()` continues) */
  cursor?: number;
}

export interface Rendered {
  text: string;
  tokens: number;
}

const RECENT = 8; // calls after which "seen" expires, so stubs never refer to content long gone from context
const DUMMY: Refs = { of: () => 88 };
const stripHash = (u: string) => u.split('#')[0];

// ───────────────────────────── lines ─────────────────────────────

export function renderAct(a: Act, refs: Refs | null): string {
  const n = refs ? String(refs.of(a)) : '';
  switch (a.k) {
    case 'link':
    case 'button':
    case 'click':
      return '[' + a.l + (a.on ? ' ✓' : '') + (a.dis ? ' (disabled)' : '') + ']' + n;
    case 'input':
    case 'textarea':
      return '{' + (a.type && a.type !== 'search' && a.type !== 'email' && a.type !== 'tel' && a.type !== 'url' ? a.type + ' ' : '') + a.l + (a.val ? '="' + a.val + '"' : '') + (a.dis ? ' (disabled)' : '') + '}' + n;
    case 'select': {
      const opts = a.opts ?? [];
      let cur = false;
      // a list that takes several: its value is "A, B", and each chosen option gets its star
      const several = a.val !== undefined && !opts.includes(a.val) && a.val.includes(', ') && a.val.split(', ').every((v) => opts.includes(v)) ? new Set(a.val.split(', ')) : undefined;
      const parts = opts.map((o) => {
        if (several ? several.has(o) : !cur && a.val !== undefined && o === a.val) {
          cur = true;
          return '*' + o;
        }
        return o;
      });
      if (!cur && a.val) parts.unshift('*' + a.val);
      return '{' + a.l + ': ' + parts.join('|') + (a.dis ? ' (disabled)' : '') + '}' + n;
    }
    case 'check':
      return '{[' + (a.on ? 'x' : ' ') + '] ' + a.l + (a.dis ? ' (disabled)' : '') + '}' + n;
    case 'radio':
      return '{(' + (a.on ? 'x' : ' ') + ') ' + a.l + (a.dis ? ' (disabled)' : '') + '}' + n;
    case 'file':
      return '{file ' + a.l + '}' + n;
  }
}

export interface LineOpts {
  /** render links as plain text (reading mode) */
  plainLinks?: boolean;
  /** clip paragraphs to this many words */
  maxWords?: number;
  /** clip preformatted blocks to this many lines */
  maxPreLines?: number;
}

function inlineStr(b: Block, refs: Refs | null, o?: LineOpts): string {
  let s = '';
  for (const x of b.i) {
    if (typeof x === 'string') s += x;
    else if (o?.plainLinks && x.k === 'link') s += x.l;
    else s += renderAct(x, refs);
  }
  return s;
}

export function renderLine(b: Block, refs: Refs | null, o?: LineOpts): string {
  if (b.k === 'pre') {
    let t = b.i[0] as string;
    if (o?.maxPreLines) {
      const lines = t.split('\n');
      if (lines.length > o.maxPreLines + 2) t = lines.slice(0, o.maxPreLines).join('\n') + `\n… (+${lines.length - o.maxPreLines} lines)`;
    }
    return '```\n' + t + '\n```';
  }
  let s = inlineStr(b, refs, o);
  if (b.sus) s = '⚠ ' + s;
  if (o?.maxWords && (b.k === 'p' || b.k === 'q' || b.k === 'li') && !b.g) {
    const w = words(s);
    if (w > o.maxWords + 12) {
      let cut = 0;
      let count = 0;
      let inWord = false;
      for (; cut < s.length; cut++) {
        const ws = s.charCodeAt(cut) <= 32;
        if (!ws && !inWord && ++count > o.maxWords) break;
        inWord = !ws;
      }
      // do not cut inside an actionable
      const open = Math.max(s.lastIndexOf('[', cut), s.lastIndexOf('{', cut));
      const close = Math.max(s.lastIndexOf(']', cut), s.lastIndexOf('}', cut));
      if (open > close) cut = open;
      s = s.slice(0, cut).trimEnd() + ` …(+${w - o.maxWords} words)`;
    }
  }
  switch (b.k) {
    case 'h':
      return '#'.repeat(Math.min(b.lv ?? 1, 3)) + ' ' + s;
    case 'li':
      return '  '.repeat(Math.max(0, (b.lv ?? 1) - 1)) + (b.ord !== undefined ? b.ord + '. ' : '- ') + s;
    case 'q':
      return '> ' + s;
    default:
      return b.r === 'dialog' ? '! ' + s : s;
  }
}

function header(page: Page): string {
  let title = page.title || '(untitled)';
  if (title.length > 90) title = title.slice(0, 89) + '…';
  let url = page.url;
  if (url.length > 220) url = url.slice(0, 219) + '…';
  let h = title + ' — ' + url;
  const tags: string[] = [];
  if (page.tier !== 'wire') tags.push(page.tier);
  if (page.status >= 400 || page.status === 0) tags.push('HTTP ' + page.status);
  if (page.kind !== 'html') tags.push(page.kind);
  if (tags.length) h += ' [' + tags.join(', ') + ']';
  return h;
}

const isContent = (r: Region) => r === 'main' || r === 'other' || r === 'dialog';
const REGION_ORDER: Region[] = ['header', 'nav', 'aside', 'footer'];
const REGION_CAP: Record<string, number> = { header: 70, nav: 110, aside: 90, footer: 45 };

function markSeen(st: ViewState, b: Block) {
  st.seen[b.hx] = st.seq;
}

/** Keep the seen-map bounded: drop entries that have expired anyway. */
export function pruneSeen(st: ViewState) {
  const keys = Object.keys(st.seen);
  if (keys.length < 4000) return;
  for (const k of keys) if (st.seq - st.seen[k] > RECENT) delete st.seen[k];
}

// ───────────────────────────── view ─────────────────────────────

export interface ViewOpts {
  budget: number;
  /** ignore what the agent has already seen */
  full?: boolean;
  /** the page this one replaced, for "what changed" */
  prev?: Page;
  /** restrict to one region (view('nav')) */
  region?: Region;
}

export function renderView(page: Page, st: ViewState, refs: Refs, o: ViewOpts): Rendered {
  const out: string[] = [];
  let used = 0;
  const budget = Math.max(120, o.budget);
  const push = (line: string, cost?: number) => {
    out.push(line);
    used += cost ?? estimateTokens(line) + 1;
  };

  push(header(page));
  const notes = [...page.notes];
  const blocks = page.blocks;
  if (blocks.some((b) => b.r === 'cookie')) notes.push('cookie banner hidden');
  if (notes.length) push('(' + notes.join('; ') + ')');

  if (o.region) {
    const idx: number[] = [];
    blocks.forEach((b, i) => {
      if (b.r === o.region) idx.push(i);
    });
    if (!idx.length) push(`(no ${o.region} region on this page)`);
    else sequential(idx, budget - used, false);
    return finish();
  }

  // ── same page as the last view: show only what changed ──
  const prev = o.prev;
  const samePage = !o.full && prev && st.last && stripHash(st.last.url) === stripHash(page.url) && st.seq - st.last.seq <= RECENT;
  if (samePage) {
    const before = new Set(prev!.blocks.map((b) => b.hx));
    const now = new Set(blocks.map((b) => b.hx));
    const changed: number[] = [];
    let visible = 0;
    blocks.forEach((b, i) => {
      if (b.r === 'cookie') return;
      visible++;
      if (!before.has(b.hx)) changed.push(i);
    });
    const removed = prev!.blocks.filter((b) => b.r !== 'cookie' && !now.has(b.hx));
    if (!changed.length && !removed.length) {
      push('(no visible change on the page)');
      for (const b of blocks) markSeen(st, b);
      return finish();
    }
    if (changed.length <= Math.max(12, visible * 0.6)) {
      push(`(same page; ${changed.length} new or changed ${changed.length === 1 ? 'line' : 'lines'}, ${removed.length} removed, ${visible - changed.length} unchanged)`);
      diffView(changed, removed);
      for (const b of blocks) markSeen(st, b);
      return finish();
    }
    // most of the page changed: treat it as a new page
  }

  // ── alerts and dialogs first ──
  const dialogIdx: number[] = [];
  const mainIdx: number[] = [];
  const byRegion: Partial<Record<Region, number[]>> = {};
  blocks.forEach((b, i) => {
    if (b.r === 'dialog') dialogIdx.push(i);
    else if (b.r === 'main' || b.r === 'other') mainIdx.push(i);
    else if (b.r !== 'cookie') (byRegion[b.r] ??= []).push(i);
  });
  for (const i of dialogIdx) {
    if (used > budget * 0.5) break;
    const line = renderLine(blocks[i], refs, { maxWords: 60 });
    push(line);
    markSeen(st, blocks[i]);
  }

  // ── navigation boilerplate: compact, and collapsed once seen ──
  const contentCost = mainIdx.reduce((s, i) => s + estimateTokens(renderLine(blocks[i], DUMMY)) + 1, 0);
  const roomy = contentCost + used < budget * 0.55;
  const tail: string[] = [];
  for (const r of REGION_ORDER) {
    const idx = byRegion[r];
    if (!idx || !idx.length) continue;
    const allSeen = !o.full && idx.every((i) => st.seen[blocks[i].hx] !== undefined && st.seq - st.seen[blocks[i].hx] <= RECENT);
    let line: string;
    if (allSeen) {
      line = `${r}: (as before, ${describe(idx)})`;
    } else {
      const cap = Math.min(roomy ? REGION_CAP[r] * 3 : REGION_CAP[r], Math.floor(budget * 0.2));
      line = r + ': ' + compactRegion(idx, cap, r);
    }
    for (const i of idx) markSeen(st, blocks[i]);
    if (r === 'aside' || r === 'footer') tail.push(line);
    else push(line);
  }

  // ── main content ──
  const reserve = tail.reduce((s, l) => s + estimateTokens(l) + 1, 0);
  mainContent(mainIdx, budget - used - reserve);
  for (const l of tail) if (used + estimateTokens(l) < budget + 40) push(l);
  return finish();

  // ── helpers (closures over out/used/st) ──

  function finish(): Rendered {
    st.last = { url: page.url, seq: st.seq };
    pruneSeen(st);
    const text = out.join('\n');
    return { text, tokens: estimateTokens(text) };
  }

  function describe(idx: number[]): string {
    let links = 0;
    const names: string[] = [];
    for (const i of idx) {
      for (const x of blocks[i].i) {
        if (typeof x !== 'string') {
          links++;
          if (names.length < 3 && x.l.length < 24) names.push(x.l);
        }
      }
    }
    return links ? `${links} links incl. ${names.join(', ')}` : `${idx.length} lines`;
  }

  /** A whole region on one line, cut at a token cap with a count of what was left out. */
  function compactRegion(idx: number[], cap: number, name: string): string {
    let s = '';
    let cost = 0;
    let leftActs = 0;
    let leftLines = 0;
    let full = false;
    for (const i of idx) {
      const b = blocks[i];
      if (full) {
        leftLines++;
        for (const x of b.i) if (typeof x !== 'string') leftActs++;
        continue;
      }
      const est = estimateTokens(renderLine(b, DUMMY, { maxWords: 20 }));
      if (cost + est <= cap) {
        s += (s ? ' / ' : '') + renderLine(b, refs, { maxWords: 20 }).replace(/^[#\- ]+/, '');
        cost += est + 1;
        continue;
      }
      // partial line: take inline items while they fit
      let part = '';
      for (const x of b.i) {
        const piece = typeof x === 'string' ? x : renderAct(x, DUMMY);
        const c = estimateTokens(piece);
        if (!full && cost + c <= cap) {
          part += typeof x === 'string' ? x : renderAct(x, refs);
          cost += c;
        } else {
          full = true;
          if (typeof x !== 'string') leftActs++;
        }
      }
      if (part.trim()) s += (s ? ' / ' : '') + part.trim();
      full = true;
    }
    if (leftActs || leftLines) s += ` … +${leftActs || leftLines} more (view('${name}'))`;
    return s;
  }

  /** Print blocks in order until the allowance runs out. Returns the index into idx where it stopped. */
  function sequential(idx: number[], allowance: number, plainLinks: boolean, lo?: LineOpts): number {
    let k = 0;
    let formShown = -1;
    for (; k < idx.length; k++) {
      const b = blocks[idx[k]];
      const est = estimateTokens(renderLine(b, DUMMY, { plainLinks, ...lo })) + 1;
      if (est > allowance && k > 0) break;
      let line = renderLine(b, refs, { plainLinks, ...lo });
      if (est > allowance) line = clipToTokens(line, Math.max(40, allowance)) + ' …';
      if (b.fm !== undefined && b.fm !== formShown) {
        formShown = b.fm;
        line = 'form: ' + line;
      }
      push(line, est);
      allowance -= est;
      markSeen(st, b);
    }
    return k;
  }

  function mainContent(idx: number[], allowance: number) {
    if (!idx.length) {
      if (!dialogIdx.length) push(page.shell ? '(no content: this page needs JavaScript)' : '(no main content)');
      return;
    }
    // full cost
    const cost = idx.map((i) => estimateTokens(renderLine(blocks[i], DUMMY)) + 1);
    const total = cost.reduce((a, b) => a + b, 0);
    if (total <= allowance) {
      sequential(idx, allowance + 50, false);
      st.cursor = undefined;
      return;
    }
    // overview: clip long text, then share the remaining room between row groups
    const lo: LineOpts = { maxWords: 36, maxPreLines: 8 };
    const oc = idx.map((i) => estimateTokens(renderLine(blocks[i], DUMMY, lo)) + 1);
    const groupCost = new Map<number, number>();
    let loose = 0;
    idx.forEach((i, k) => {
      const g = blocks[i].g;
      if (g === undefined) loose += oc[k];
      else groupCost.set(g, (groupCost.get(g) ?? 0) + oc[k]);
    });
    const footerReserve = 60;
    const room = allowance - footerReserve;
    let cap = Infinity;
    const groupsTotal = [...groupCost.values()].reduce((a, b) => a + b, 0);
    if (loose + groupsTotal > room) {
      // water-filling: the largest groups give up rows first
      const sizes = [...groupCost.values()].sort((a, b) => a - b);
      let remaining = room - loose;
      cap = 0;
      for (let k = 0; k < sizes.length; k++) {
        const share = remaining / (sizes.length - k);
        if (sizes[k] <= share) remaining -= sizes[k];
        else {
          cap = share;
          break;
        }
      }
    }
    if (cap >= 150 || loose <= room * 0.7) {
      // every group gets at least a few rows; elide the rest per group
      const perGroup = Math.max(cap, 120);
      const spent = new Map<number, number>();
      const cut = new Map<number, number>();
      let formShown = -1;
      let left = allowance - footerReserve;
      let k = 0;
      for (; k < idx.length; k++) {
        const b = blocks[idx[k]];
        if (b.g !== undefined) {
          const s = spent.get(b.g) ?? 0;
          if (s + oc[k] > perGroup && s > 0) {
            cut.set(b.g, (cut.get(b.g) ?? 0) + 1);
            const next = blocks[idx[k + 1]];
            if (!next || next.g !== b.g) push(`… +${cut.get(b.g)} more rows`);
            continue;
          }
          spent.set(b.g, s + oc[k]);
        }
        if (oc[k] > left) break;
        let line = renderLine(b, refs, lo);
        if (b.fm !== undefined && b.fm !== formShown) {
          formShown = b.fm;
          line = 'form: ' + line;
        }
        push(line, oc[k]);
        left -= oc[k];
        markSeen(st, b);
      }
      if (k >= idx.length) {
        const elided = [...cut.values()].reduce((a, b) => a + b, 0);
        push(`(overview: long text clipped${elided ? `, ${elided} rows elided` : ''}; read() = full text, find('words') = search this page)`);
        st.cursor = idx[0];
        return;
      }
      trailer(idx, k, total);
      return;
    }
    const k = sequential(idx, allowance - footerReserve, false, lo);
    trailer(idx, k, total);
  }

  function trailer(idx: number[], k: number, total: number) {
    st.cursor = idx[k];
    const rest = idx.slice(k);
    const heads: string[] = [];
    for (const i of rest) {
      const b = blocks[i];
      if (b.k === 'h' && (b.lv ?? 1) <= 3 && heads.length < 10) {
        const t = blockText(b);
        heads.push(t.length > 40 ? t.slice(0, 39) + '…' : t);
      }
    }
    const restCost = rest.reduce((s, i) => s + estimateTokens(renderLine(blocks[i], DUMMY)) + 1, 0);
    let line = `… ${rest.length} more lines (~${approx(restCost)} tokens): read() continues, find('words') searches`;
    if (heads.length) line += '. Sections below: ' + heads.join(' · ');
    push(line);
    void total;
  }

  function diffView(changed: number[], removed: Block[]) {
    let allowance = budget - used - 30;
    const shownHead = new Set<number>();
    let last = -2;
    let formShown = -1;
    let k = 0;
    for (; k < changed.length; k++) {
      const i = changed[k];
      const b = blocks[i];
      if (i !== last + 1) {
        // context: the nearest heading above, if it is not itself part of the change
        for (let j = i - 1; j >= 0 && j >= i - 25; j--) {
          if (blocks[j].k === 'h') {
            if (!shownHead.has(j) && !changed.includes(j)) {
              shownHead.add(j);
              push(renderLine(blocks[j], refs));
            }
            break;
          }
        }
      }
      const est = estimateTokens(renderLine(b, DUMMY)) + 1;
      if (est > allowance && k > 0) break;
      let line = renderLine(b, refs, est > allowance ? { maxWords: 40 } : undefined);
      if (b.fm !== undefined && b.fm !== formShown) {
        formShown = b.fm;
        line = 'form: ' + line;
      }
      push(line, est);
      allowance -= est;
      last = i;
    }
    if (k < changed.length) push(`… +${changed.length - k} more changed lines: view() shows the whole page`);
    let shownRemoved = 0;
    for (const b of removed) {
      if (shownRemoved >= 6 || allowance < 20) break;
      let t = blockText(b);
      if (t.length > 90) t = t.slice(0, 89) + '…';
      const line = 'removed: ' + t;
      push(line);
      allowance -= estimateTokens(line) + 1;
      shownRemoved++;
    }
    if (removed.length > shownRemoved) push(`… +${removed.length - shownRemoved} more removed lines`);
  }
}

function approx(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(Math.round(n / 10) * 10);
}

// ───────────────────────────── read ─────────────────────────────

export interface ReadOpts {
  budget: number;
  /** block index to start from */
  from?: number;
  /** stop before this block index */
  to?: number;
  /** keep link numbers in the text */
  links?: boolean;
}

/** Linear full text of the content regions, with no clipping, from a cursor. */
export function renderRead(page: Page, st: ViewState, refs: Refs, o: ReadOpts): Rendered {
  const blocks = page.blocks;
  const out: string[] = [];
  let left = Math.max(120, o.budget) - 30;
  let i = o.from ?? st.cursor ?? 0;
  const end = o.to ?? blocks.length;
  if (i === 0 || o.from !== undefined) out.push(header(page));
  let shown = 0;
  for (; i < end; i++) {
    const b = blocks[i];
    if (!isContent(b.r)) continue;
    const line = renderLine(b, refs, { plainLinks: !o.links });
    const est = estimateTokens(line) + 1;
    if (est > left) {
      if (shown === 0) {
        // one enormous block: give as much of it as fits
        out.push(clipToTokens(line, left) + ' …');
        i++;
      }
      break;
    }
    out.push(line);
    left -= est;
    shown++;
    markSeen(st, b);
  }
  let rest = 0;
  for (let j = i; j < end; j++) if (isContent(blocks[j].r)) rest++;
  if (rest) {
    st.cursor = i;
    out.push(`… ${rest} more lines: read() continues`);
  } else {
    st.cursor = undefined;
    out.push(o.to !== undefined ? '(end of section)' : '(end of page)');
  }
  const text = out.join('\n');
  return { text, tokens: estimateTokens(text) };
}

/** Block range [from, to) of the section whose heading best matches `name`. */
export function sectionRange(page: Page, name: string): { from: number; to: number } | undefined {
  const q = name.toLowerCase().trim();
  let best = -1;
  let bestScore = 0;
  page.blocks.forEach((b, i) => {
    if (b.k !== 'h') return;
    const t = blockText(b).toLowerCase();
    const score = t === q ? 3 : t.startsWith(q) ? 2 : t.includes(q) ? 1 : 0;
    if (score > bestScore) [best, bestScore] = [i, score];
  });
  if (best < 0) return undefined;
  const lv = page.blocks[best].lv ?? 1;
  let to = page.blocks.length;
  for (let j = best + 1; j < page.blocks.length; j++) {
    const b = page.blocks[j];
    if (b.k === 'h' && (b.lv ?? 1) <= lv) {
      to = j;
      break;
    }
  }
  return { from: best, to };
}

export function renderOutline(page: Page): Rendered {
  const out: string[] = [header(page)];
  let lines = 0;
  for (const b of page.blocks) {
    if (b.k !== 'h') {
      if (isContent(b.r)) lines++;
      continue;
    }
    out.push('  '.repeat(Math.max(0, (b.lv ?? 1) - 1)) + blockText(b));
  }
  if (out.length === 1) out.push(`(no headings; ${lines} lines of content)`);
  const text = out.join('\n');
  return { text, tokens: estimateTokens(text) };
}

// ───────────────────────────── find ─────────────────────────────

const STOP = new Set('a an and are as at be by for from has have in is it its of on or that the this to was were will with what which who how many much when where'.split(' '));

export function terms(s: string): string[] {
  const out: string[] = [];
  for (const raw of s.toLowerCase().split(/[^\p{L}\p{N}$€£%.]+/u)) {
    let w = raw.replace(/^[.]+|[.]+$/g, '');
    if (!w || STOP.has(w)) continue;
    if (w.length > 4) {
      if (w.endsWith('ies')) w = w.slice(0, -3) + 'y';
      else if (w.endsWith('ing')) w = w.slice(0, -3);
      else if (w.endsWith('ed')) w = w.slice(0, -2);
      else if (w.endsWith('es')) w = w.slice(0, -2);
      else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    } else if (w.length === 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

export interface Hit {
  index: number;
  score: number;
  /** the block has every word of the query */
  all?: boolean;
}

/** BM25 over the page's blocks, plus a bonus for the query appearing verbatim. No model involved. */
export function rank(page: Page, query: string): Hit[] {
  const q = [...new Set(terms(query))];
  if (!q.length) return [];
  const docs = page.blocks.map((b) => (b.r === 'cookie' ? [] : terms(blockText(b))));
  const N = docs.length || 1;
  let total = 0;
  const df = new Map<string, number>();
  for (const d of docs) {
    total += d.length;
    for (const t of new Set(d)) if (q.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avg = total / N || 1;
  const phrase = query.toLowerCase().trim();
  const hits: Hit[] = [];
  docs.forEach((d, index) => {
    if (!d.length) return;
    let score = 0;
    let matched = 0;
    for (const t of q) {
      let tf = 0;
      // find('$') means "prices": a bare currency or percent sign matches any amount; '359.99' matches '$359.99'
      const symbol = /^[$€£%]+$/.test(t);
      for (const w of d) if (w === t || (t.length >= 4 && w.startsWith(t)) || (symbol && w.includes(t)) || (w.length > t.length && /^[$€£]/.test(w) && w.replace(/^[$€£]+/, '') === t) || (w.length > t.length && w.includes('.') && w.split('.').includes(t))) tf++;
      if (!tf) continue;
      matched++;
      const n = df.get(t) ?? 1;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.length) / avg));
    }
    if (!matched) return;
    score *= 0.5 + (0.5 * matched) / q.length; // prefer blocks that cover more of the query
    const b = page.blocks[index];
    if (phrase.length > 3 && blockText(b).toLowerCase().includes(phrase)) score *= 1.8;
    if (b.k === 'h') score *= 1.15;
    if (!isContent(b.r)) score *= 0.6;
    hits.push({ index, score, all: matched === q.length });
  });
  hits.sort((a, b) => b.score - a.score);
  return hits;
}

const RANKED = /^\s*\d{1,4}\.(?:\s|$)/;

export function renderFind(page: Page, st: ViewState, refs: Refs, query: string, budget: number): Rendered & { partial?: boolean; miss?: boolean } {
  let hits = rank(page, query);
  const blocks = page.blocks;
  // Lines that hold the query word for word answer it; with any of those, lines that merely share words with it
  // (132 "timeout_ms" lines around one "dispatcher.audit.idle_timeout_ms") are left out and counted.
  let looser = 0;
  const phrase = query.toLowerCase().replace(/\s+/g, ' ').trim();
  if (phrase.length > 3 && terms(query).length >= 2) {
    const exact = hits.filter((h) => blockText(blocks[h.index]).toLowerCase().includes(phrase));
    if (exact.length && exact.length < hits.length) {
      looser = hits.length - exact.length;
      hits = exact;
    }
  }
  if (!hits.length) {
    const heads = blocks.filter((b) => b.k === 'h').slice(0, 8).map((b) => blockText(b));
    let text = `no match for '${query}' on this page` + (heads.length ? '. Sections: ' + heads.join(' · ') : '');
    // a miss should not waste the call: show where the page's content starts
    const start: string[] = [];
    let room = Math.min(350, Math.max(100, budget) - estimateTokens(text) - 20);
    for (const b of blocks) {
      if (!isContent(b.r) || b.r === 'dialog') continue;
      const line = renderLine(b, refs, { maxWords: 40, maxPreLines: 6 });
      const est = estimateTokens(line) + 1;
      if (est > room) break;
      room -= est;
      start.push(line);
    }
    if (start.length) text += '\nThe page starts:\n' + start.join('\n');
    return { text, tokens: estimateTokens(text), miss: true };
  }
  // take the best hits that fit, with the heading above each and the header row of its table
  let left = Math.max(100, budget) - 20;
  const chosen = new Set<number>();
  const context = new Set<number>();
  const top = hits[0].score;
  let taken = 0;
  for (const h of hits) {
    if (h.score < top * 0.22 && taken >= 3) break;
    const b = blocks[h.index];
    let est = estimateTokens(renderLine(b, DUMMY, { maxWords: 70 })) + 1;
    const ctx: number[] = [];
    for (let j = h.index - 1; j >= 0 && j >= h.index - 40; j--) {
      if (blocks[j].k === 'h') {
        if (!chosen.has(j) && !context.has(j)) ctx.push(j);
        break;
      }
    }
    // the detail row of a ranked item ("92 points by x | 32 comments") is read with its numbered title row
    if (b.g !== undefined && h.index > 0 && blocks[h.index - 1].g === b.g && !RANKED.test(blockText(b)) && RANKED.test(blockText(blocks[h.index - 1])) && !chosen.has(h.index - 1) && !context.has(h.index - 1)) ctx.push(h.index - 1);
    if (b.g !== undefined && !b.hd) {
      for (let j = h.index - 1; j >= 0 && blocks[j].g === b.g; j--) {
        if (blocks[j].hd) {
          if (!chosen.has(j) && !context.has(j)) ctx.push(j);
          break;
        }
      }
    }
    for (const j of ctx) est += estimateTokens(renderLine(blocks[j], DUMMY)) + 1;
    if (est > left) {
      if (taken === 0) {
        chosen.add(h.index);
        taken++;
      }
      break;
    }
    left -= est;
    chosen.add(h.index);
    for (const j of ctx) context.add(j);
    taken++;
    if (taken >= 40) break;
  }
  const order = [...new Set([...chosen, ...context])].sort((a, b) => a - b);
  // A short query that no line holds whole (a product name, say) is a miss, however close the closest lines look:
  // "1 match" over a different product has sent agents after the wrong thing.
  const nq = new Set(terms(query)).size;
  const partial = !looser && nq >= 2 && nq <= 4 && !hits.some((h) => h.all);
  const out: string[] = [
    partial
      ? `no line on this page has all of '${query}'; closest${taken < hits.length ? ` ${taken} of ${hits.length}` : ''}:`
      : `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} for '${query}'` + (taken < hits.length ? `, best ${taken} shown` : '') + (looser ? ` (word for word; ${looser} looser ${looser === 1 ? 'match' : 'matches'} left out)` : '') + ':',
  ];
  let lastI = -2;
  for (const i of order) {
    const b = blocks[i];
    if (lastI >= 0 && i !== lastI + 1 && !(context.has(lastI) && !chosen.has(lastI))) out.push('…');
    out.push(renderLine(b, refs, { maxWords: 70 }));
    markSeen(st, b);
    lastI = i;
  }
  const text = out.join('\n');
  return { text, tokens: estimateTokens(text), partial };
}

/** Links whose label or URL matches, with their URLs: the only place URLs are spelled out. */
export function renderLinks(page: Page, refs: Refs, query: string | undefined, budget: number): Rendered {
  const q = query ? terms(query) : [];
  const seen = new Set<string>();
  const out: string[] = [];
  let left = Math.max(100, budget) - 20;
  let more = 0;
  for (const b of page.blocks) {
    for (const x of b.i) {
      if (typeof x === 'string' || x.k !== 'link' || !x.href || seen.has(x.f)) continue;
      if (q.length) {
        const hay = (x.l + ' ' + x.href).toLowerCase();
        if (!q.every((t) => hay.includes(t))) continue;
      }
      seen.add(x.f);
      const line = `[${x.l}]${refs.of(x)} ${x.href}`;
      const est = estimateTokens(line) + 1;
      if (est > left) {
        more++;
        continue;
      }
      left -= est;
      out.push(line);
    }
  }
  if (!out.length && !more) out.push(query ? `no links match '${query}'` : 'no links on this page');
  if (more) out.push(`… +${more} more links`);
  const text = out.join('\n');
  return { text, tokens: estimateTokens(text) };
}

export { actText };
