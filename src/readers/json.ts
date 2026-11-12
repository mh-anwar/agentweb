// JSON → blocks. Raw JSON spends most of its tokens on quotes, braces and keys repeated once per
// record; this reader prints each key once. Arrays of records become tables (constant columns pulled
// out, duplicate and noise columns dropped, a column cap with the dropped keys listed), objects
// become `key: value` lines, and big side subtrees are summarised by shape with their first rows.

import { squash } from '../tree.ts';
import type { Inline, ReadInput, ReadOutput } from '../types.ts';
import { Emitter, commonPathPrefix, hostOf, isTemplate, isUrl, looksHtml, plural, shortUrl, stripHtml, titleFromUrl, trunc, urlInline } from './util.ts';
import { markdownInto } from './markdown.ts';
import { textInto } from './text.ts';

export type J = null | boolean | number | string | J[] | { [k: string]: J };
export type JObj = { [k: string]: J };

// Limits. Everything is emitted in priority order; the renderer applies the token budget.
const MAX_COLS = 10;
const CELL_MAX = 90;
const PROSE_CELL_MAX = 240;
const KV_MAX = 300;
const LONG_MAX = 1500;
const INLINE_MAX = 200;
const MAIN_ROWS = 500;
const SIDE_ROWS = 5;
const SIDE_FULL = 10;
const LIST_MAX = 40;

export const MD_SIGNAL = /(^|\n)(#{1,6} |```|\s*[-*] |\|.*\|)|\]\(/;
export const isObj = (v: unknown): v is JObj => v !== null && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: J): v is null | boolean | number | string => v === null || typeof v !== 'object';
export function isEmpty(v: J | undefined): boolean {
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    for (const k in v) if (!isEmpty(v[k])) return false;
    return true;
  }
  return typeof v === 'string' && !v.trim();
}

// ───────────────────────────── parsing ─────────────────────────────

export interface Parsed {
  value: J;
  /** set when the body was JSON Lines / JSON text sequences */
  lines?: number;
  /** what was stripped before parsing (anti-hijacking prefix, JSONP wrapper) */
  stripped?: string;
}

const PREFIXES: [RegExp, string][] = [
  [/^\)\]\}'?,?[ \t]*\r?\n?/, ")]}'"],
  [/^while\s*\(\s*1\s*\)\s*;/, 'while(1);'],
  [/^for\s*\(\s*;\s*;\s*\)\s*;/, 'for(;;);'],
  [/^\{\s*\}\s*&&/, '{}&&'],
];

const bigSafe = (_k: string, v: unknown, ctx?: { source?: string }) =>
  typeof v === 'number' && Number.isInteger(v) && !Number.isSafeInteger(v) && ctx?.source && /^-?\d+$/.test(ctx.source) ? ctx.source : v;

function parseOne(s: string): J {
  // Integers past 2^53 (tweet ids, snowflakes) would silently lose digits; keep them as source text.
  return /\d{16,}/.test(s) ? JSON.parse(s, bigSafe as any) : JSON.parse(s);
}

/** Parse JSON leniently: BOM, anti-hijacking prefixes, JSONP, JSON Lines. Throws the original SyntaxError. */
export function parseJson(text: string): Parsed {
  let s = text.replace(/^\uFEFF/, '').trimStart();
  let stripped: string | undefined;
  for (const [re, name] of PREFIXES) {
    if (re.test(s)) {
      s = s.replace(re, '').trimStart();
      stripped = name;
      break;
    }
  }
  if (s.startsWith('/**/')) s = s.slice(4).trimStart();
  const jsonp = /^[A-Za-z_$][\w$.]*\s*\(([\s\S]*)\)\s*;?\s*$/.exec(s);
  if (jsonp && !/^(true|false|null)\b/.test(s)) {
    s = jsonp[1];
    stripped = 'JSONP wrapper';
  }
  try {
    return { value: parseOne(s), stripped };
  } catch (e) {
    const lines = s.split(/\r?\n|\u001e/).map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) {
      const out: J[] = [];
      let ok = true;
      for (const l of lines) {
        try {
          out.push(parseOne(l));
        } catch {
          ok = false;
          break;
        }
      }
      if (ok) return { value: out, lines: out.length, stripped };
    }
    throw e;
  }
}

// ───────────────────────────── sizes and shapes ─────────────────────────────

const sizes = new WeakMap<object, number>();
/** Approximate serialised size in characters (cached). */
export function size(v: J): number {
  if (v === null) return 4;
  if (typeof v === 'string') return v.length + 2;
  if (typeof v !== 'object') return String(v).length;
  const c = sizes.get(v);
  if (c !== undefined) return c;
  let n = 2;
  if (Array.isArray(v)) for (const x of v) n += size(x) + 1;
  else for (const k in v) n += k.length + 4 + size(v[k]);
  sizes.set(v, n);
  return n;
}

/** `[{node: {...}}, {node: {...}}]` (GraphQL edges and similar single-key wrappers) → the inner values. */
function unwrap(arr: J[]): J[] {
  if (arr.length < 2 || !arr.every(isObj)) return arr;
  // GraphQL connections: edges [{cursor, node: {...}}] → the nodes
  if (arr.every((x) => isObj((x as JObj).node) && Object.keys(x as JObj).every((k) => k === 'node' || k === 'cursor'))) return arr.map((x) => (x as JObj).node);
  const keys = Object.keys(arr[0] as JObj);
  if (keys.length !== 1) return arr;
  const k = keys[0];
  if (!arr.every((x) => { const ks = Object.keys(x as JObj); return ks.length === 1 && ks[0] === k && isObj((x as JObj)[k]); })) return arr;
  return arr.map((x) => (x as JObj)[k]);
}

const DYNAMIC_KEY = /^(\d[\w.:+-]*|v\d[\w.-]*|[A-Za-z]+:[\w-]+|[0-9a-f]{8,}|[\w.-]+@[\w.-]+|\/.*|https?:.*)$/;

/** Keys present in at least half the objects, by frequency. */
function topKeys(objs: JObj[], n = 99): string[] {
  const freq = new Map<string, number>();
  for (const o of objs) for (const k in o) if (!isEmpty(o[k])) freq.set(k, (freq.get(k) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
}

function similarShapes(objs: JObj[]): boolean {
  if (objs.length < 2) return false;
  const union = new Set<string>();
  for (const o of objs.slice(0, 50)) for (const k in o) union.add(k);
  if (!union.size) return false;
  let fill = 0;
  const sample = objs.slice(0, 50);
  for (const o of sample) fill += Object.keys(o).length / union.size;
  return fill / sample.length >= 0.4;
}

type Shape = 'mapObj' | 'mapScalar' | 'obj';
function shapeOf(o: JObj): Shape {
  const keys = Object.keys(o);
  if (keys.length < 4) return 'obj';
  const dyn = keys.filter((k) => DYNAMIC_KEY.test(k)).length / keys.length >= 0.6;
  const vals = Object.values(o);
  const objs = vals.filter(isObj) as JObj[];
  if (objs.length >= vals.length * 0.8 && (dyn || keys.length >= 8) && similarShapes(objs)) return 'mapObj';
  if (vals.every(isScalar) && ((dyn && keys.length >= 8) || keys.length >= 30)) return 'mapScalar';
  return 'obj';
}

/** `{id, name, price, …}` */
function shapeText(objs: JObj[]): string {
  const ks = topKeys(objs, 7);
  return '{' + ks.slice(0, 6).join(', ') + (ks.length > 6 ? ', …' : '') + '}';
}

// ───────────────────────────── values → inline ─────────────────────────────

const OPAQUE = /^(?=.*\d)(?=.*[A-Za-z])[A-Za-z0-9+/=_-]{16,}$/;
const DATEISH = /^\d{4}-\d\d-\d\d([T ]\d\d:\d\d(:\d\d(\.\d+)?)?(Z|[+-]\d\d:?\d\d)?)?$/;
const NAMEISH = /^(name|title|full_?name|display_?name|login|username|label|headline|subject|summary|description|text|body|message|caption|slug|key)$/i;

function strText(s: string, max: number): string {
  let t = looksHtml(s) ? stripHtml(s) : squash(s);
  return trunc(t, max);
}

function scalarInl(v: J, base: string, max = KV_MAX): Inline {
  if (typeof v === 'string') return isUrl(v) || (isTemplate(v) && /^https?:/i.test(v)) ? urlInline(v, base) : strText(v, max);
  return String(v);
}

function scalarList(arr: J[], base: string, max = LIST_MAX): Inline[] {
  const out: Inline[] = [];
  const shown = arr.slice(0, max);
  shown.forEach((x, i) => {
    if (i) out.push(', ');
    out.push(scalarInl(x, base, 120));
  });
  if (arr.length > max) out.push(` … +${arr.length - max} more`);
  return out;
}

/** Compact one-line rendering of any value, bounded by roughly `max` characters. */
function inlineVal(v: J, base: string, max: number, depth = 0): Inline[] {
  if (isScalar(v)) return [scalarInl(v, base, max)];
  if (Array.isArray(v)) {
    const arr = v.filter((x) => !isEmpty(x));
    if (arr.every(isScalar)) return scalarList(arr, base, Math.max(3, Math.floor(max / 20)));
    const names = nameList(arr as J[]);
    if (names) return [names];
    return [plural(arr.length, 'item') + (arr.every(isObj) ? ' ' + shapeText(arr as JObj[]) : '')];
  }
  if (depth >= 2) return [Object.keys(v).slice(0, 4).join(', ') + (Object.keys(v).length > 4 ? ', …' : '')];
  const out: Inline[] = [];
  let used = 0;
  let n = 0;
  const ents = Object.entries(v).filter(([, x]) => !isEmpty(x));
  for (const [k, x] of ents) {
    if (used > max) {
      out.push(`, … +${ents.length - n} keys`);
      break;
    }
    if (n) out.push(', ');
    out.push(k + '=');
    const inner = isObj(x) ? ['{', ...inlineVal(x, base, max / 2, depth + 1), '}'] : inlineVal(x, base, Math.min(120, max), depth + 1);
    out.push(...inner);
    used += k.length + inner.reduce((a, y) => a + (typeof y === 'string' ? y.length : y.l.length), 0);
    n++;
  }
  return out;
}

/** For arrays of records with a name-like field: their names, comma separated. */
function nameList(arr: J[], max = 6): string | undefined {
  if (!arr.length || !arr.every(isObj)) return undefined;
  const k = Object.keys(arr[0] as JObj).find((x) => NAMEISH.test(x) && typeof (arr[0] as JObj)[x] === 'string');
  if (!k) return undefined;
  const names = arr.map((o) => (o as JObj)[k]).filter((x) => typeof x === 'string') as string[];
  if (names.length < arr.length * 0.8) return undefined;
  return names.slice(0, max).map((s) => trunc(squash(s), 40)).join(', ') + (names.length > max ? ` +${names.length - max}` : '');
}

const kvInl = (k: string, val: Inline[]): Inline[] => [k + ': ', ...val];

function isSmall(o: JObj): boolean {
  const ents = Object.entries(o).filter(([, x]) => !isEmpty(x));
  if (ents.length > 6) return false;
  let len = 0;
  for (const [k, v] of ents) {
    if (isObj(v)) return false;
    if (Array.isArray(v) && (v.length > 5 || !v.every(isScalar))) return false;
    len += k.length + size(v);
  }
  return len <= INLINE_MAX;
}

// ───────────────────────────── scoring fields ─────────────────────────────

interface Col {
  key: string;
  count: number;
  first: number;
  url: number;
  tmpl: number;
  api: number;
  opaque: number;
  num: number;
  bool: number;
  date: number;
  prose: number;
  uri: number;
  img: number;
  distinct: number;
  vals: J[];
}

const WEBURL = /^(html_?url|url|link|href|permalink|web_?url|homepage|website|canonical_?url|share_?url)$/i;
const IMAGEISH = /(^|_)(avatar|icon|logo|thumbnail|thumb|banner|gravatar)(_?url|_?id)?$/i;
const IMAGEKEY = /(^|_)(image|img|picture|photo)s?(_?url)?$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif|ico)(\?|$)/i;
/** Other URI-like strings: git://, git@host:path, ssh://, s3://, urn: */
const URIISH = /^([a-z][\w+.-]*:\/\/\S+|[\w.-]+@[\w.-]+:\S+|urn:\S+)$/i;
const BOOST = /(^|_)(stars?|stargazers?_count|price|amount|rating|votes?|downloads?|likes|views|followers|points|score)$/i;

function colScore(c: Col, rows: number): number {
  const leaf = c.key.split('.').pop()!;
  let s = 1;
  if (c.img >= c.count / 2 || IMAGEISH.test(leaf) || (IMAGEKEY.test(leaf) && c.url >= c.count / 2)) s = 0.03; // images are of no use to a text agent
  else if (c.url + c.tmpl >= c.count) {
    s = WEBURL.test(leaf) ? 0.9 : 0.35;
    if (c.api >= c.count / 2) s *= 0.4;
    if (c.tmpl) s = 0.02;
  } else if (c.uri >= c.count / 2) s = 0.3;
  else if (c.opaque >= c.count / 2) s = 0.15;
  else if (c.date >= c.count) s = 0.85;
  else if (c.bool >= c.count) s = 0.45;
  else if (c.num >= c.count) s = /(^|_)id$/i.test(leaf) ? 0.8 : 0.9;
  else if (NAMEISH.test(leaf)) s = 1.6;
  else if (c.prose >= c.count / 2) s = 1.3;
  if (BOOST.test(leaf) && c.num >= c.count / 2) s *= 1.3;
  if (rows >= 8 && c.distinct <= 2 && c.bool < c.count) s *= 0.6;
  if (c.key.includes('.')) s *= 0.75;
  if (leaf.startsWith('_')) s *= leaf === '__typename' ? 0.2 : 0.5;
  return (s * c.count) / rows;
}

const LINKKEY = /^(href|url|link|path|permalink|canonical|uri)$|(_url|Url|_href|Href|_link|Link|_path|Path)$/;
/** Relative paths under link-like keys (`href: "/p/socks"`) become absolute URLs. */
function relLink(k: string, v: J, base: string): J {
  if (typeof v !== 'string' || !base || !LINKKEY.test(k) || !/^\/(?!\/)[^\s]*$/.test(v) || v.length > 2000) return v;
  try {
    return new URL(v, base).href;
  } catch {
    return v;
  }
}

/** In ≥90% of rows (with both values), b's value is a part of a's: its prefix or suffix at a word
 * boundary (vercel/next.js ⊃ next.js), or anywhere when `loose` (URLs embedding a name). */
function contains(a: J[], b: J[], loose = false): boolean {
  let both = 0;
  let hit = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (typeof x !== 'string' || typeof y !== 'string' || !y) continue;
    both++;
    if (x.length <= y.length) continue;
    if (loose ? x.includes(y) : (x.startsWith(y) && /^[^A-Za-z0-9]/.test(x.slice(y.length))) || (x.endsWith(y) && /[^A-Za-z0-9]$/.test(x.slice(0, -y.length)))) hit++;
  }
  return both >= 2 && hit >= both * 0.9 && both >= a.filter((v) => v !== null).length * 0.8;
}

function apiish(u: string): boolean {
  const h = hostOf(u);
  return /^api\./.test(h) || /\/api\/|\/v\d+\//.test(u);
}

function statCols(rows: Map<string, J>[]): Col[] {
  const cols = new Map<string, Col>();
  let order = 0;
  for (const r of rows) {
    for (const [k, v] of r) {
      let c = cols.get(k);
      if (!c) cols.set(k, (c = { key: k, count: 0, first: order++, url: 0, tmpl: 0, api: 0, opaque: 0, num: 0, bool: 0, date: 0, prose: 0, uri: 0, img: 0, distinct: 0, vals: [] }));
      c.count++;
      if (typeof v === 'string') {
        if (isTemplate(v) && /^https?:/i.test(v)) c.tmpl++;
        else if (isUrl(v)) {
          c.url++;
          if (apiish(v)) c.api++;
          if (IMAGE_EXT.test(v)) c.img++;
        } else if (URIISH.test(v)) c.uri++;
        else if (DATEISH.test(v)) c.date++;
        else if (OPAQUE.test(v)) c.opaque++;
        else if (v.length > 25 && v.includes(' ')) c.prose++;
      } else if (typeof v === 'number') c.num++;
      else if (typeof v === 'boolean') c.bool++;
    }
  }
  for (const c of cols.values()) {
    c.vals = rows.map((r) => r.get(c.key) ?? null);
    c.distinct = new Set(c.vals.filter((v) => v !== null).map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v)))).size;
  }
  return [...cols.values()];
}

// ───────────────────────────── the emitter ─────────────────────────────

export interface JsonOpts {
  /** row cap for the main table */
  mainRows?: number;
  /** order side sections: by size ascending (default: small ones first so truncation spares them),
   * or by a caller's score, highest first (embedded data: the main entity first) */
  rank?: (key: string, v: J) => number;
}

export class JsonWriter {
  em: Emitter;
  base: string;
  mainRows: number;
  rank?: (key: string, v: J) => number;
  constructor(em: Emitter, opts: JsonOpts = {}) {
    this.em = em;
    this.base = em.base;
    this.mainRows = opts.mainRows ?? MAIN_ROWS;
    this.rank = opts.rank;
  }

  /** Emit any value. `main` = this subtree is the substance of the document. */
  value(v: J, path: string, depth: number, main: boolean): void {
    if (isEmpty(v)) return;
    if (isScalar(v)) {
      if (typeof v === 'string' && v.length > LONG_MAX && /\n/.test(v)) return this.longText(v);
      this.em.add('p', path ? kvInl(path, [scalarInl(v, this.base, LONG_MAX)]) : [scalarInl(v, this.base, LONG_MAX)]);
      return;
    }
    if (Array.isArray(v)) return this.array(v, path, depth, main);
    const shape = shapeOf(v);
    if (shape === 'mapObj') return this.mapObj(v, path, depth, main);
    if (shape === 'mapScalar') return this.mapScalar(v, path, depth, main);
    this.object(v, path, depth, main);
  }

  private heading(s: string, depth: number) {
    if (s) this.em.h(s, depth + 1);
  }

  object(o: JObj, path: string, depth: number, main: boolean): void {
    const em = this.em;
    const head: Inline[][] = [];
    const longs: Inline[][] = [];
    const urls: [string, string][] = [];
    const bools: [string, boolean][] = [];
    type Sec = { key: string; v: J; size: number; coll: boolean };
    const secs: Sec[] = [];
    for (const [k0, v0] of Object.entries(o)) {
      let k = k0;
      let v = relLink(k0, v0, this.base);
      if (isEmpty(v)) continue;
      // collapse single-key wrapper chains: {data: {repository: {...}}} → data.repository
      while (isObj(v)) {
        const ks = Object.keys(v).filter((x) => !isEmpty((v as JObj)[x]));
        if (ks.length !== 1 || isScalar((v as JObj)[ks[0]])) break;
        k = k + '.' + ks[0];
        v = (v as JObj)[ks[0]];
      }
      if (typeof v === 'string') {
        if (isUrl(v) || (isTemplate(v) && /^https?:/i.test(v))) urls.push([k, v]);
        else if ((v.length > LONG_MAX && /\n.*\n/.test(v)) || (v.length > 300 && MD_SIGNAL.test(v))) secs.push({ key: k, v, size: v.length, coll: false });
        else if (v.length > 200) longs.push(kvInl(k, [strText(v, LONG_MAX)]));
        else head.push(kvInl(k, [strText(v, KV_MAX)]));
      } else if (typeof v === 'boolean') bools.push([k, v]);
      else if (isScalar(v)) head.push(kvInl(k, [String(v)]));
      else if (Array.isArray(v)) {
        const arr = unwrap(v.filter((x) => !isEmpty(x)));
        if (arr.every(isScalar)) head.push(kvInl(k, scalarList(arr, this.base)));
        else if (arr.length === 1 && isObj(arr[0]) && isSmall(arr[0])) head.push(kvInl(k, inlineVal(arr[0], this.base, INLINE_MAX)));
        else secs.push({ key: k, v: arr, size: size(arr), coll: true });
      } else if (isSmall(v)) head.push(kvInl(k, inlineVal(v, this.base, INLINE_MAX)));
      else secs.push({ key: k, v, size: size(v), coll: shapeOf(v) !== 'obj' });
    }

    if (bools.length >= 4) {
      // many flags: one line instead of one per flag
      const t = bools.filter((b) => b[1]).map((b) => b[0]);
      const f = bools.filter((b) => !b[1]).map((b) => b[0]);
      head.push([[t.length && 'true: ' + t.join(', '), f.length && 'false: ' + f.join(', ')].filter(Boolean).join(' · ')]);
    } else for (const [k, b] of bools) head.splice(head.length, 0, kvInl(k, [String(b)]));
    for (const i of head) em.add('p', i);
    this.urlLines(urls);
    for (const i of longs) em.add('p', i);

    // The dominant subtree carries `main`; side subtrees are summarised.
    const total = size(o);
    let dom: Sec | undefined;
    for (const s of secs) if (!dom || s.size > dom.size) dom = s;
    if (dom && dom.size < total * (dom.coll ? 0.4 : 0.6) && secs.length > 1) dom = undefined;
    const rank = this.rank;
    const sorted = rank && depth === 0
      ? secs.slice().sort((a, b) => rank(b.key, b.v) - rank(a.key, a.v))
      : secs.slice().sort((a, b) => (a === dom ? 1 : b === dom ? -1 : a.size - b.size));
    for (const s of sorted) {
      const p = path ? path + '.' + s.key : s.key;
      const isMain = main && s === dom;
      if (typeof s.v === 'string') {
        this.heading(p, depth + 1);
        this.longText(s.v);
      } else if (s.coll) this.value(s.v, p, depth + 1, isMain);
      else if (isObj(s.v) && (isMain || (depth < 4 && Object.keys(s.v).length <= 30))) {
        this.heading(p, depth + 1);
        this.object(s.v, p, depth + 1, isMain);
      } else if (isObj(s.v)) em.add('p', kvInl(p, this.brief(s.v)));
    }
  }

  /** A side object in one line: its most telling fields, then how many were left out. */
  brief(o: JObj): Inline[] {
    const rows = [new Map(Object.entries(o).filter(([, v]) => !isEmpty(v) && (isScalar(v) || (Array.isArray(v) && v.every(isScalar)))))];
    const cols = statCols(rows).filter((c) => !c.tmpl).map((c) => ({ c, s: colScore(c, 1) })).sort((a, b) => b.s - a.s || a.c.first - b.c.first).slice(0, 6).sort((a, b) => a.c.first - b.c.first);
    const out: Inline[] = [];
    cols.forEach(({ c }, i) => {
      if (i) out.push(', ');
      out.push(c.key + '=', ...inlineVal(c.vals[0], this.base, 80));
    });
    let colls = 0;
    for (const [k, v] of Object.entries(o)) {
      if (colls >= 2 || !Array.isArray(v) || v.every(isScalar) || isEmpty(v)) continue;
      out.push(out.length ? ', ' : '', k + '=', ...inlineVal(v, this.base, 80, 1));
      colls++;
    }
    const rest = Object.keys(o).filter((k) => !isEmpty(o[k])).length - cols.length - colls;
    if (rest > 0) out.push(` (+${rest} keys)`);
    return out;
  }

  /** URL-valued fields: one line per field when few, else grouped by host under their common prefix. */
  private urlLines(urls: [string, string][]): void {
    if (!urls.length) return;
    if (urls.length <= 3) {
      for (const [k, u] of urls) this.em.add('p', kvInl(k, [urlInline(u, this.base)]));
      return;
    }
    const byHost = new Map<string, [string, string][]>();
    for (const e of urls) {
      const h = hostOf(e[1].replace(/\{[^}]*\}/g, ''));
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h)!.push(e);
    }
    // web links before API links
    const groups = [...byHost.values()].sort((a, b) => Number(apiish(a[0][1])) - Number(apiish(b[0][1])));
    for (const g of groups) {
      if (g.length < 3) {
        for (const [k, u] of g) this.em.add('p', kvInl(k, [urlInline(u, this.base)]));
        continue;
      }
      const shorts = g.map(([, u]) => shortUrl(u, this.base));
      const pre = commonPathPrefix(shorts.map((s) => s + '/'));
      const out: Inline[] = [pre ? `links under ${pre.replace(/\/$/, '')}: ` : 'links: '];
      g.forEach(([k, u], i) => {
        if (i) out.push(', ');
        const key = k.replace(/_?url$/i, '') || k;
        let rel = pre ? shorts[i].slice(pre.length - 1) : shorts[i];
        if (rel === '' || rel === '/') rel = '/';
        // `forks /forks` says the same thing twice: show the path alone
        const same = rel.replace(/^\//, '').replace(/\{.*$/, '').replace(/[/-]/g, '_').toLowerCase() === key.toLowerCase();
        if (!same) out.push(key + ' ');
        out.push(urlInline(u, this.base, rel));
      });
      this.em.add('p', out);
    }
  }

  private longText(s: string): void {
    const sub = new Emitter(this.base, 0);
    const md = /^#{1,6} |\n#{1,6} |\n```|\n\s*[-*] |\]\(/.test(s);
    if (md) markdownInto(s, sub, { headingOffset: 2 });
    else textInto(s, sub);
    const cap = 80;
    this.em.adopt(sub.blocks.slice(0, cap));
    if (sub.blocks.length > cap) this.em.text(`… +${sub.blocks.length - cap} more blocks`);
  }

  array(arr0: J[], path: string, depth: number, main: boolean): void {
    const arr = unwrap(arr0.filter((x) => !isEmpty(x)));
    if (!arr.length) return;
    const em = this.em;
    if (arr.every(isScalar)) {
      const allUrls = arr.every((x) => typeof x === 'string' && isUrl(x));
      if (arr.length > 8 || allUrls) {
        if (path) this.heading(`${path} (${arr.length})`, depth);
        const cap = main ? this.mainRows : SIDE_FULL * 2;
        for (const x of arr.slice(0, cap)) em.add('li', [scalarInl(x, this.base, LONG_MAX)], { lv: 1 });
        if (arr.length > cap) em.text(`… +${arr.length - cap} more`);
      } else em.add('p', path ? kvInl(path, scalarList(arr, this.base)) : scalarList(arr, this.base));
      return;
    }
    const objs = arr.filter(isObj) as JObj[];
    if (arr.length === 1 && objs.length === 1) {
      if (path) this.heading(path, depth);
      return this.object(objs[0], path, depth, main);
    }
    if (objs.length >= arr.length * 0.8) {
      const full = main || arr.length <= SIDE_FULL;
      const cap = main ? this.mainRows : full ? SIDE_FULL : SIDE_ROWS;
      if (path) this.heading(full ? `${path} (${arr.length})` : `${path}: ${arr.length} objects ${shapeText(objs)}`, depth);
      this.table(objs, cap);
      return;
    }
    const arrs = arr.filter(Array.isArray) as J[][];
    if (arrs.length === arr.length && arrs.every((r) => r.every(isScalar))) {
      if (path) this.heading(`${path} (${arr.length})`, depth);
      this.gridTable(arrs, main ? this.mainRows : SIDE_FULL);
      return;
    }
    // heterogeneous list
    if (path) this.heading(`${path} (${arr.length})`, depth);
    const cap = main ? this.mainRows : SIDE_FULL;
    for (const x of arr.slice(0, cap)) em.add('li', inlineVal(x, this.base, 300), { lv: 1 });
    if (arr.length > cap) em.text(`… +${arr.length - cap} more`);
  }

  private mapObj(o: JObj, path: string, depth: number, main: boolean): void {
    const keys = Object.keys(o).filter((k) => isObj(o[k]));
    const full = main || keys.length <= SIDE_FULL;
    const cap = main ? this.mainRows : full ? SIDE_FULL : SIDE_ROWS;
    const leaf = path.split('.').pop() ?? '';
    const keyName = /[^s]s$/.test(leaf) ? leaf.slice(0, -1) : 'key';
    const objs = keys.map((k) => o[k] as JObj);
    if (path) {
      const sample = keys.length > 6 ? [...keys.slice(0, 3), '…', ...keys.slice(-2)] : keys;
      this.heading(full ? `${path} (${keys.length})` : `${path}: ${keys.length} entries (${sample.join(', ')}) each ${shapeText(objs)}`, depth);
    }
    this.table(objs, cap, { name: keyName, keys });
  }

  private mapScalar(o: JObj, path: string, depth: number, main: boolean): void {
    const ents = Object.entries(o).filter(([, v]) => !isEmpty(v));
    const v0 = ents[0]?.[1];
    if (ents.length >= 4 && ents.every(([, v]) => v === v0)) {
      // {alice: true, bob: true, …}: the keys are the content
      const keys = ents.map((e) => e[0]);
      const cap = main ? this.mainRows : LIST_MAX;
      this.em.add('p', [`${path || 'keys'} (${ents.length}, all ${String(v0)}): ${keys.slice(0, cap).join(', ')}${keys.length > cap ? ` … +${keys.length - cap} more` : ''}`]);
      return;
    }
    const full = main || ents.length <= SIDE_FULL * 2;
    if (path) this.heading(full ? `${path} (${ents.length})` : `${path}: ${ents.length} entries`, depth);
    const show = full ? ents.slice(0, this.mainRows) : [...ents.slice(0, SIDE_ROWS), ...ents.slice(-2)];
    show.forEach(([k, v], i) => {
      if (!full && i === SIDE_ROWS) this.em.text(`… ${ents.length - SIDE_ROWS - 2} more`);
      this.em.add('p', kvInl(k, [scalarInl(v, this.base)]));
    });
    if (full && ents.length > show.length) this.em.text(`… +${ents.length - show.length} more`);
  }

  /** Array of arrays: a grid. A first row of strings over rows with numbers is a header. */
  private gridTable(rows: J[][], cap: number): void {
    const g = this.em.group();
    const first = rows[0];
    const hd = rows.length > 1 && first.every((x) => typeof x === 'string') && rows.slice(1).some((r) => r.some((x) => typeof x === 'number'));
    rows.slice(0, cap + (hd ? 1 : 0)).forEach((r, i) => this.em.row(r.map((x) => [isEmpty(x) ? '' : scalarInl(x, this.base, CELL_MAX)]), g, hd && i === 0));
    if (rows.length > cap + (hd ? 1 : 0)) this.em.text(`… +${rows.length - cap - (hd ? 1 : 0)} more rows`);
  }

  /** Records → table: header row, one row per record. `keepOrder` keeps the first `maxCols` columns as given (CSV). */
  table(objs: JObj[], cap: number, keyCol?: { name: string; keys: string[] }, opt: { maxCols?: number; keepOrder?: boolean } = {}): void {
    const maxCols = opt.maxCols ?? MAX_COLS;
    const em = this.em;
    const n = objs.length;
    // Which nested objects to flatten into dotted columns: those with a small, stable set of keys.
    const sub = new Map<string, Set<string>>();
    for (const o of objs) for (const k in o) if (isObj(o[k])) {
      let s = sub.get(k);
      if (!s) sub.set(k, (s = new Set()));
      for (const kk in o[k] as JObj) s.add(kk);
    }
    // explode when the nested keys are few, or stable across rows (not a map with dynamic keys)
    const explode = new Set(
      [...sub.entries()]
        .filter(([k, s]) => {
          if (s.size <= 12) return true;
          const withK = objs.filter((o) => isObj(o[k])).map((o) => Object.keys(o[k] as JObj).length);
          const avg = withK.reduce((a, b) => a + b, 0) / Math.max(1, withK.length);
          return avg >= s.size * 0.8 && s.size <= 40;
        })
        .map(([k]) => k),
    );
    const rows: Map<string, J>[] = objs.map((o, i) => {
      const m = new Map<string, J>();
      if (keyCol) m.set('\u0000key', keyCol.keys[i]);
      for (const [k, v0] of Object.entries(o)) {
        if (isEmpty(v0)) continue;
        let v = relLink(k, v0, this.base);
        if (isObj(v)) {
          const ks = Object.keys(v).filter((x) => !isEmpty((v as JObj)[x]));
          if (ks.length === 1 && Array.isArray((v as JObj)[ks[0]])) v = (v as JObj)[ks[0]];
        }
        if (Array.isArray(v)) v = unwrap(v.filter((x) => !isEmpty(x)));
        if (isObj(v) && explode.has(k)) {
          for (const [kk, vv] of Object.entries(v)) if (!isEmpty(vv)) m.set(k + '.' + kk, relLink(kk, vv, this.base));
        } else m.set(k, v);
      }
      return m;
    });
    let cols = statCols(rows);

    // Constant columns (≥3 rows) are said once above the table.
    const consts: Col[] = [];
    const dropped: string[] = [];
    if (n >= 3) {
      cols = cols.filter((c) => {
        if (c.key === '\u0000key' || c.count !== n) return true;
        const s0 = JSON.stringify(c.vals[0]);
        if (!c.vals.every((v) => JSON.stringify(v) === s0)) return true;
        if (c.tmpl) dropped.push(c.key);
        else if (!/(^|\.)__typename$/.test(c.key)) consts.push(c);
        return false;
      });
    }
    // Duplicate columns (identical values in every row) are dropped in favour of the first.
    const seen = new Map<string, string>();
    if (n >= 3) {
      cols = cols.filter((c) => {
        const sig = JSON.stringify(c.vals);
        const prev = seen.get(sig);
        if (prev !== undefined) {
          if (prev !== '\u0000key') dropped.push(`${c.key}(=${prev})`);
          return false;
        }
        seen.set(sig, c.key);
        return true;
      });
    }
    // Pick the columns worth showing, then show them by frequency and original order.
    const scored = cols.map((c) => ({ c, s: c.key === '\u0000key' ? 99 : opt.keepOrder ? 1 : colScore(c, n) })).sort((a, b) => b.s - a.s || a.c.first - b.c.first);
    let chosen: Col[] = [];
    let urlCols = 0;
    for (const { c, s } of scored) {
      const isU = c.url + c.tmpl >= c.count && c.key !== '\u0000key';
      if (chosen.length >= maxCols || s < 0.05 || (isU && urlCols >= 2 && !opt.keepOrder)) {
        dropped.push(c.key);
        continue;
      }
      if (!opt.keepOrder && !(isU && WEBURL.test(c.key.split('.').pop()!))) {
        // a column whose values are parts of a shown column's values says nothing new;
        // a plain column that contains a shown one (full_name ⊃ name) replaces it
        const d = chosen.find((d) => d.key !== '\u0000key' && contains(d.vals, c.vals, d.url + d.uri >= d.count / 2));
        if (d) {
          dropped.push(`${c.key}(⊂${d.key})`);
          continue;
        }
        const e = chosen.find((e) => e.key !== '\u0000key' && contains(c.vals, e.vals, c.url + c.uri >= c.count / 2) && !(e.url + e.tmpl >= e.count));
        if (e) {
          if (c.url + c.uri + c.tmpl >= c.count / 2) {
            dropped.push(`${c.key}(⊃${e.key})`);
            continue;
          }
          chosen = chosen.filter((x) => x !== e);
          dropped.push(`${e.key}(⊂${c.key})`);
        }
      }
      if (isU) urlCols++;
      chosen.push(c);
    }
    chosen.sort((a, b) => (a.key === '\u0000key' ? -1 : b.key === '\u0000key' ? 1 : opt.keepOrder ? a.first - b.first : b.count - a.count || a.first - b.first));

    // Records too sparse for a table read better as one line each.
    const fill = chosen.reduce((a, c) => a + c.count, 0) / Math.max(1, chosen.length * n);
    if (fill < 0.45 && n >= 2 && !keyCol && !opt.keepOrder) {
      const shown = objs.slice(0, cap);
      for (const o of shown) em.add('li', inlineVal(o, this.base, 300), { lv: 1 });
      if (n > shown.length) em.text(`… +${n - shown.length} more`);
      return;
    }

    if (consts.length) {
      const out: Inline[] = [`all ${n}: `];
      consts.slice(0, 20).forEach((c, i) => {
        if (i) out.push(', ');
        out.push(c.key + '=', ...inlineVal(c.vals[0], this.base, 80));
      });
      if (consts.length > 20) out.push(` +${consts.length - 20} more`);
      em.add('p', out);
    }
    if (dropped.length) em.text(`not shown: ${dropped.slice(0, 25).join(', ')}${dropped.length > 25 ? ` +${dropped.length - 25} more` : ''}`);

    // URL columns show paths relative to their common prefix, named once in the header.
    const prefixes = new Map<string, string>();
    for (const c of chosen) {
      if (c.url < c.count || c.count < 3) continue;
      const shorts = c.vals.filter((v) => typeof v === 'string').map((v) => shortUrl(v as string, this.base));
      const pre = commonPathPrefix(shorts);
      if (pre.length >= 8 && shorts.every((s) => s.length > pre.length)) prefixes.set(c.key, pre);
    }
    const g = em.group();
    em.row(chosen.map((c) => [c.key === '\u0000key' ? keyCol!.name : prefixes.has(c.key) ? `${c.key} (${prefixes.get(c.key)}…)` : c.key]), g, true);
    const shown = Math.min(cap, n);
    for (let i = 0; i < shown; i++) {
      em.row(chosen.map((c) => {
        const v = c.vals[i];
        if (isEmpty(v)) return [''];
        const pre = prefixes.get(c.key);
        if (pre && typeof v === 'string') return [urlInline(v, this.base, shortUrl(v, this.base).slice(pre.length))];
        return inlineVal(v, this.base, c.prose >= c.count / 2 ? PROSE_CELL_MAX : CELL_MAX, 1);
      }), g);
    }
    if (n > shown) {
      em.text(`… +${n - shown} more rows`);
      // The rows that do not fit are still counted: a column with a few distinct values gets how often each occurs,
      // a numeric column its range, over ALL rows. "How many are active?" is then answered without a script.
      const facts: string[] = [];
      for (const c of chosen) {
        if (c.key === '\u0000key' || facts.length >= 6) continue;
        const tally = new Map<string, number>();
        let nums = 0;
        let lo = Infinity;
        let hi = -Infinity;
        let plain = true;
        for (let i = 0; i < n && plain; i++) {
          const v = c.vals[i];
          if (isEmpty(v)) continue;
          if (typeof v === 'number') {
            nums++;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          } else if (typeof v === 'string' || typeof v === 'boolean') {
            const k = String(v);
            tally.set(k, (tally.get(k) ?? 0) + 1);
            if (tally.size > 8 || k.length > 40) plain = false;
          } else plain = false;
        }
        if (!plain) continue;
        if (tally.size >= 2 && !nums) facts.push(`${c.key}: ` + [...tally].sort((a, b) => b[1] - a[1]).map(([k, m]) => `${k} ${m}`).join(' · '));
        else if (nums >= n / 2 && !tally.size && lo < hi) facts.push(`${c.key}: ${lo} to ${hi}`);
      }
      if (facts.length) em.text(`over all ${n} rows — ` + facts.join('; '));
    }
  }
}

// ───────────────────────────── reader ─────────────────────────────

function pickTitle(v: J, url: string): string {
  if (isObj(v)) {
    for (const k of ['full_name', 'name', 'title', 'headline', 'login', 'id']) {
      const x = v[k];
      if (typeof x === 'string' && x.length < 200) return x;
    }
  }
  return titleFromUrl(url);
}

function describe(p: Parsed): string {
  const v = p.value;
  const what = p.lines
    ? `JSON Lines, ${plural(p.lines, 'record')}`
    : Array.isArray(v)
      ? `JSON array of ${v.length}${v.length && v.every(isObj) ? ' objects' : ' items'}`
      : isObj(v)
        ? `JSON object, ${plural(Object.keys(v).length, 'key')}`
        : 'JSON scalar';
  return p.stripped ? `${what} (stripped ${p.stripped})` : what;
}

export function readJson(input: ReadInput, em = new Emitter(input.url)): ReadOutput {
  const text = input.text ?? new TextDecoder().decode(input.bytes ?? new Uint8Array());
  let parsed: Parsed;
  try {
    parsed = parseJson(text);
  } catch (e) {
    textInto(text.slice(0, 200_000), em);
    const msg = (e as Error).message.replace(/^Unexpected token/, 'unexpected token');
    return { title: titleFromUrl(input.url), kind: 'text', blocks: em.blocks, notes: [`invalid JSON (${trunc(msg, 120)}); shown as text`] };
  }
  new JsonWriter(em).value(parsed.value, '', 0, true);
  return { title: pickTitle(parsed.value, input.url), kind: 'json', blocks: em.blocks, notes: [describe(parsed), ...em.notes] };
}
