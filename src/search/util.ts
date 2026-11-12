// Shared plumbing for providers: tree queries over the parsed document, HTTP status
// classification, entity decoding and small text helpers.

import { squash, walk, type LNode } from '../tree.ts';
import { AwError, type Fetcher, type Loaded, type NavRequest } from '../types.ts';

export const UA_SUFFIX = 'agentweb/0.1';

// ───────────── tree helpers ─────────────

export function hasClass(n: LNode, c: string): boolean {
  const v = n.a?.class;
  return !!v && v.includes(c) && v.split(/\s+/).includes(c);
}

/** All descendants (including `n`) matching `pred`, not descending into matches. */
export function all(n: LNode, pred: (x: LNode) => boolean, out: LNode[] = []): LNode[] {
  if (pred(n)) {
    out.push(n);
    return out;
  }
  if (n.c) for (const c of n.c) all(c, pred, out);
  return out;
}

export function first(n: LNode, pred: (x: LNode) => boolean): LNode | undefined {
  for (const x of walk(n)) if (pred(x)) return x;
  return undefined;
}

export const tagCls = (t: string, c?: string) => (x: LNode) => x.t === t && (c === undefined || hasClass(x, c));
export const cls = (c: string) => (x: LNode) => hasClass(x, c);

/** Visible text of a subtree, whitespace squashed. Statically hidden nodes are skipped. */
export function txt(n: LNode | undefined): string {
  if (!n) return '';
  let s = '';
  const rec = (x: LNode) => {
    if (x.t === '#text') {
      s += x.x ?? '';
      return;
    }
    if (x.h) return;
    if (BLOCKISH.has(x.t)) s += ' ';
    if (x.c) for (const c of x.c) rec(c);
    if (BLOCKISH.has(x.t)) s += ' ';
  };
  rec(n);
  return squash(s);
}
const BLOCKISH = new Set(['div', 'p', 'br', 'li', 'td', 'th', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'cite', 'section', 'article']);

// ───────────── text helpers ─────────────

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’',
  lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Strip tags from an HTML fragment (API snippets with <span class=highlight> etc.) and decode entities. */
export function stripTags(s: string | undefined | null): string {
  if (!s) return '';
  return squash(decodeEntities(s.replace(/<[^>]*>/g, ' ').replace(/\s+([.,;:!?)])/g, '$1')));
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + '…';
}

export const enc = (s: string) => encodeURIComponent(s);
export const form = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => enc(k) + '=' + enc(v).replace(/%20/g, '+'))
    .join('&');

// ───────────── fetching ─────────────

/** How long a provider that walled us (429, anomaly page, captcha) is left alone, when it names no time of its own. */
export const WALL_COOLDOWN_SEC = 15 * 60;

/** A provider that is temporarily refusing us (429, captcha, quota): the orchestrator cools it down. */
export class RateLimited extends AwError {
  retryAfterSec?: number;
  constructor(message: string, retryAfterSec?: number) {
    super('blocked', message, 'try again later or use another provider');
    this.retryAfterSec = retryAfterSec;
  }
}

function retryAfter(l: Loaded): number | undefined {
  const v = l.headers?.['retry-after'];
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.round((t - Date.now()) / 1000)) : undefined;
}

/** Throw a classified error for non-success statuses. */
export function checkStatus(l: Loaded, name: string): void {
  const s = l.status;
  if (s >= 200 && s < 300) return;
  if (s === 429) throw new RateLimited(`${name}: rate-limited (HTTP 429)`, retryAfter(l) ?? WALL_COOLDOWN_SEC);
  if (s === 401 || s === 403) throw new AwError('blocked', `${name}: refused (HTTP ${s})`);
  if (s >= 500) throw new AwError('net', `${name}: server error (HTTP ${s})`);
  throw new AwError('net', `${name}: unexpected HTTP ${s}`);
}

export async function getDoc(fetch: Fetcher, req: NavRequest, name: string): Promise<Loaded & { doc: NonNullable<Loaded['doc']> }> {
  const l = await fetch(req);
  checkStatus(l, name);
  if (!l.doc) throw new AwError('internal', `${name}: expected HTML, got ${l.contentType || 'nothing'}`);
  return l as Loaded & { doc: NonNullable<Loaded['doc']> };
}

/** Body text of a non-HTML response. Tolerates an engine that parsed it as HTML anyway. */
export function bodyText(l: Loaded): string | undefined {
  if (l.body?.text !== undefined) return l.body.text;
  if (l.body?.bytes) return new TextDecoder().decode(l.body.bytes);
  if (l.doc) {
    // a JSON payload served as text/html arrives as a single text run under <body>
    let s = '';
    for (const x of walk(l.doc.root)) if (x.t === '#text') s += x.x ?? '';
    return s;
  }
  return undefined;
}

export async function getJson<T = any>(fetch: Fetcher, req: NavRequest, name: string): Promise<{ data: T; loaded: Loaded }> {
  const l = await fetch({ ...req, headers: { accept: 'application/json', ...req.headers } });
  checkStatus(l, name);
  const t = bodyText(l);
  if (t === undefined) throw new AwError('internal', `${name}: empty response`);
  try {
    return { data: JSON.parse(t) as T, loaded: l };
  } catch {
    throw new AwError('internal', `${name}: response was not JSON (${l.contentType})`);
  }
}

/** Short, model-facing reason for a failure. */
export function why(e: unknown): string {
  if (e instanceof AwError) return e.message;
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}
