// A browser session, as data. Everything a worker needs to continue a session is in this record:
// cookies, the current page model, the ref table, what the agent has already been shown.
// No process, no socket, no profile directory.

import { blockHash, blockText } from './blocks.ts';
import type { Arg } from './dsl.ts';
import type { Refs, ViewState } from './render.ts';
import { AwError, type Act, type ActKind, type Block, type CookieData, type Page, type Store, type Tier } from './types.ts';

export interface RefEntry {
  f: string;
  k: ActKind;
  l: string;
  /** links keep their target, so a ref from an earlier page can still be followed */
  href?: string;
}

export interface SessionRecord {
  id: string;
  v: 1;
  created: number;
  touched: number;
  page?: Page;
  cookies: CookieData[];
  storage: Record<string, Record<string, string>>;
  refs: RefEntry[];
  view: ViewState;
  /** URLs to return to with back() (GET pages only) */
  history: string[];
  guard?: unknown;
  /** engine pinned by the agent with engine('…'); absent = automatic */
  engine?: Tier;
  /** origins where this session already needed a script engine, and which one */
  tiers?: Record<string, Tier>;
  /** fingerprint of the last field filled (default target for submit() and press('Enter')) */
  lastField?: string;
  /** values filled on the current wire-tier page: fingerprint -> value, replayed if the page moves to a script engine */
  dirty?: Record<string, string>;
  /** At most four bounded semantic collection baselines, private to this session. */
  collections?: [string, import('./extract/compare.ts').CollectionSnapshot][];
}

export const SESSION_NS = 'session';

export function newSession(id: string): SessionRecord {
  const now = Date.now();
  return { id, v: 1, created: now, touched: now, cookies: [], storage: {}, refs: [], view: { seq: 0, seen: {} }, history: [] };
}

export async function loadSession(store: Store, id: string, forkFrom?: string): Promise<SessionRecord> {
  const rec = await store.get<SessionRecord>(SESSION_NS, id);
  if (rec && rec.v === 1) return rec;
  if (forkFrom) {
    const src = await store.get<SessionRecord>(SESSION_NS, forkFrom);
    if (!src) throw new AwError('bad_request', `cannot fork: no session '${forkFrom}'`);
    // a fork is a copy of the record; a live script-engine page is not copied, it re-opens from cookies
    const copy: SessionRecord = structuredClone(src);
    copy.id = id;
    copy.created = copy.touched = Date.now();
    return copy;
  }
  return newSession(id);
}

export async function saveSession(store: Store, rec: SessionRecord, ttlSec: number): Promise<void> {
  rec.touched = Date.now();
  await store.set(SESSION_NS, rec.id, rec, ttlSec);
}

/** The session's ref table: fingerprint <-> small stable integer. */
export class SessionRefs implements Refs {
  entries: RefEntry[];
  private ix = new Map<string, number>();
  constructor(entries: RefEntry[]) {
    this.entries = entries;
    entries.forEach((e, i) => this.ix.set(e.f, i + 1));
  }
  of(a: Act): number {
    let n = this.ix.get(a.f);
    if (n === undefined) {
      const e: RefEntry = { f: a.f, k: a.k, l: a.l };
      if (a.k === 'link' && a.href) e.href = a.href;
      this.entries.push(e);
      n = this.entries.length;
      this.ix.set(a.f, n);
    }
    return n;
  }
  get(n: number): RefEntry | undefined {
    return this.entries[n - 1];
  }
  numberOf(fp: string): number | undefined {
    return this.ix.get(fp);
  }
}

export interface Resolved {
  act: Act;
  block: Block;
  index: number;
}

/** Characters between the end of `near` in a block and an act in it (acts before the text cost extra). */
function inlineDistance(block: Block, act: Act, near: string): number {
  let text = '';
  let at = -1;
  for (const x of block.i) {
    if (x === act) at = text.length;
    text += typeof x === 'string' ? x : ` ${x.l} `;
  }
  const lower = text.toLowerCase();
  let best = Infinity;
  for (let i = lower.indexOf(near); i >= 0; i = lower.indexOf(near, i + 1)) {
    const end = i + near.length;
    const d = at >= end ? at - end : (i - at) + 5000;
    best = Math.min(best, d);
  }
  return best;
}

export function allActs(page: Page): Resolved[] {
  const out: Resolved[] = [];
  page.blocks.forEach((block, index) => {
    for (const x of block.i) if (typeof x !== 'string') out.push({ act: x, block, index });
  });
  return out;
}

export function actByFp(page: Page, fp: string): Resolved | undefined {
  for (let index = 0; index < page.blocks.length; index++) {
    const block = page.blocks[index];
    for (const x of block.i) if (typeof x !== 'string' && x.f === fp) return { act: x, block, index };
  }
  return undefined;
}

/** After changing an actionable's state in place, its line has a new identity. */
export function rehash(block: Block) {
  block.hx = blockHash(block);
}

const CLICKABLE = new Set<ActKind>(['link', 'button', 'click', 'check', 'radio']);
const FILLABLE = new Set<ActKind>(['input', 'textarea', 'select', 'file']);
const TOGGLE = new Set<ActKind>(['check', 'radio']);

export function kindsFor(verb: string): Set<ActKind> | undefined {
  switch (verb) {
    case 'click':
    case 'hover':
      return CLICKABLE;
    case 'fill':
      return new Set<ActKind>(['input', 'textarea']);
    case 'select':
      return new Set<ActKind>(['select', 'radio']);
    case 'check':
    case 'uncheck':
      return TOGGLE;
    case 'upload':
      return new Set<ActKind>(['file']);
    default:
      return undefined;
  }
}

function fieldName(page: Page, a: Act): string {
  if (a.form === undefined || a.fi === undefined) return '';
  return page.forms[a.form]?.fields[a.fi]?.name ?? '';
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, ' ').trim();

function context(r: Resolved, a: Act): string {
  let t = blockText({ i: r.block.i.filter((x) => x !== a) }).replace(/^[\s|]+|[\s|]+$/g, '');
  if (t.length > 70) t = t.slice(0, 69) + '…';
  return t;
}

export interface ResolveOpts {
  verb: string;
  near?: string;
  nth?: number;
}

/**
 * Turn what the agent wrote (a number, or visible text) into one actionable on the current page.
 * Never guesses between distinct candidates: ambiguity is an error that lists them.
 */
export function resolveTarget(page: Page, refs: SessionRefs, target: Arg, o: ResolveOpts): Resolved | { portable: RefEntry; n: number } {
  const kinds = kindsFor(o.verb);
  if (typeof target === 'number') {
    const e = refs.get(target);
    if (!e) throw new AwError('bad_request', `there is no ${target}: numbers come from the page view`, 'view() shows the current page');
    const r = actByFp(page, e.f);
    if (r) return r;
    if (e.href && (o.verb === 'click' || o.verb === 'open')) return { portable: e, n: target };
    throw new AwError('bad_request', `${target} ([${e.l}]) is not on this page any more`, "use the visible text, or view() for the current numbers");
  }
  const want = norm(String(target));
  if (!want) throw new AwError('bad_request', `${o.verb} needs a target: a number from the page or the visible text`);
  const pool = allActs(page).filter((r) => !kinds || kinds.has(r.act.k) || (o.verb === 'fill' && FILLABLE.has(r.act.k)));
  let best = 0;
  const scored: { r: Resolved; s: number }[] = [];
  for (const r of pool) {
    const l = norm(r.act.l);
    let s = l === want ? 100 : l.startsWith(want) ? 70 : l.includes(want) ? 50 : want.split(' ').every((w) => l.includes(w)) ? 35 : 0;
    const fname = norm(fieldName(page, r.act));
    if (fname && fname === want) s = Math.max(s, 90);
    if (r.act.href && want.length > 5 && r.act.href.toLowerCase().includes(String(target).toLowerCase().trim())) s = Math.max(s, 60);
    if (!s) continue;
    if (r.act.dis) s -= 20;
    scored.push({ r, s });
    if (s > best) best = s;
  }
  if (!scored.length) {
    const sugg = suggestions(pool, want, refs);
    throw new AwError('bad_request', `nothing ${o.verb === 'fill' ? 'fillable' : 'clickable'} matches '${target}'` + (sugg ? `. Closest: ${sugg}` : ''), "find('words') searches the page; view() shows all of it");
  }
  // distinct candidates at the best score
  const top: Resolved[] = [];
  const seen = new Set<string>();
  for (const x of scored) {
    if (x.s !== best) continue;
    const key = x.r.act.k === 'link' && x.r.act.href ? 'L' + x.r.act.href : x.r.act.f;
    if (seen.has(key)) continue;
    seen.add(key);
    top.push(x.r);
  }
  if (top.length === 1) return top[0];
  if (o.nth && o.nth >= 1 && o.nth <= top.length) return top[o.nth - 1];
  if (o.near) {
    const near = o.near.toLowerCase();
    const hits: number[] = [];
    page.blocks.forEach((b, i) => {
      if (blockText(b).toLowerCase().includes(near)) hits.push(i);
    });
    if (hits.length) {
      // distance in lines, then (same line: several cards flattened together) in characters:
      // a control usually follows its item's name, so one after the text wins over one before it
      const cost = (r: Resolved): number => {
        let d = Infinity;
        for (const h of hits) {
          if (h === r.index) {
            d = Math.min(d, inlineDistance(r.block, r.act, near));
            continue;
          }
          const lo = Math.min(h, r.index);
          const hi = Math.max(h, r.index);
          // a heading in between means the control belongs to another item
          let headings = 0;
          for (let i = lo + 1; i <= hi; i++) if (page.blocks[i].k === 'h' && i !== h) headings++;
          d = Math.min(d, (hi - lo) * 100000 + (r.index < h ? 250000 : 0) + headings * 1000000);
        }
        return d;
      };
      const ranked = top.map((r) => ({ r, d: cost(r) })).sort((a, b) => a.d - b.d);
      if (ranked[0].d <= 8 * 100000 + 250000 && (ranked.length === 1 || ranked[1].d > ranked[0].d)) return ranked[0].r;
    }
    throw new AwError('bad_request', `'${target}' matches ${top.length} things and none is near '${o.near}'`, listCandidates(top, refs));
  }
  const main = primaryControl(page, top);
  if (main) return main;
  throw new AwError('bad_request', `'${target}' matches ${top.length} things; use the number, or near='text on the same line'`, listCandidates(top, refs));
}

/**
 * A detail page (one product, one article) has its own control under the page title and the same
 * control repeated on related-item cards further down. The page's own one wins when it is the only
 * candidate in the title's section and is not itself one of a repeated group of items.
 */
function primaryControl(page: Page, top: Resolved[]): Resolved | undefined {
  const bs = page.blocks;
  const isH1 = (b: Block) => b.k === 'h' && (b.lv ?? 9) === 1;
  let h = bs.findIndex((b) => isH1(b) && b.r === 'main');
  if (h < 0) h = bs.findIndex(isH1);
  if (h < 0 || bs.filter(isH1).length > 1) return undefined;
  let end = bs.length;
  for (let i = h + 1; i < bs.length; i++) {
    if (bs[i].k === 'h' && (bs[i].lv ?? 9) <= 2) {
      end = i;
      break;
    }
  }
  const inside = top.filter((r) => r.index > h && r.index < end && r.block.r !== 'nav' && r.block.r !== 'header' && r.block.r !== 'footer');
  if (inside.length !== 1 || inside[0].block.g !== undefined) return undefined;
  // the others must sit after the section (related items), not before it (a site-wide bar)
  if (top.some((r) => r !== inside[0] && r.index < h && r.block.r === 'main')) return undefined;
  return inside[0];
}

function listCandidates(top: Resolved[], refs: SessionRefs): string {
  const lines = top.slice(0, 8).map((r) => `[${r.act.l}]${refs.of(r.act)}` + (context(r, r.act) ? ` in "${context(r, r.act)}"` : ''));
  if (top.length > 8) lines.push(`… +${top.length - 8} more`);
  return lines.join('\n');
}

function suggestions(pool: Resolved[], want: string, refs: SessionRefs): string {
  const ws = want.split(' ').filter((w) => w.length > 2);
  if (!ws.length) return '';
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of pool) {
    const l = norm(r.act.l);
    if (!ws.some((w) => l.includes(w) || (w.length > 4 && l.includes(w.slice(0, 4))))) continue;
    if (seen.has(r.act.f)) continue;
    seen.add(r.act.f);
    out.push(`[${r.act.l}]${refs.of(r.act)}`);
    if (out.length >= 5) break;
  }
  return out.join(' ');
}
