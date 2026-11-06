// Shared plumbing for every farm site: request context, response helpers, sessions, form parsing,
// and the server-side state that tests and task checks inspect.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Truth } from './truth.ts';
import { hashHex } from './rng.ts';

// ---------------------------------------------------------------------------------------------
// Observable server state

export interface OrderLine { productId: number; qty: number; priceCents: number }
export interface Order {
  id: string;
  site: 'shop' | 'spa';
  lines: OrderLine[];
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
  shippingMethod: string;
  shipTo: { name: string; email: string; address: string; city: string; state: string; zip: string };
  cardLast4: string;
}
export interface CartEvent { site: string; op: 'add' | 'remove'; productId: number; qty: number }
export interface TransferRecord { from: string; to: string; amountCents: number; memo: string; ref: string }
export interface Submission { path: string; fields: Record<string, string[]>; files: { field: string; filename: string; type: string; size: number }[] }
export interface OtherRequest { method: string; path: string; query: string; headers: Record<string, string>; body: string }

export interface ServerState {
  orders: Order[];
  cartEvents: CartEvent[];
  logins: { site: string; user: string; ok: boolean }[];
  votes: { user: string; storyId: number }[];
  transfers: TransferRecord[];
  submissions: Submission[];
  /** Beacons from /hard pages (icon buttons, tabs…). */
  events: { name: string; detail: string }[];
  /** Every request the second origin received, whatever it was for. */
  other: OtherRequest[];
  misc: { etag200: number; etag304: number; challengeServed: number; challengePassed: number; requests: Record<string, number> };
  /** Exceptions thrown by handlers; always empty in a healthy run. */
  errors: string[];
}

export function blankState(): ServerState {
  return {
    orders: [], cartEvents: [], logins: [], votes: [], transfers: [], submissions: [], events: [], other: [],
    misc: { etag200: 0, etag304: 0, challengeServed: 0, challengePassed: 0, requests: {} },
    errors: [],
  };
}

export type Session = Record<string, any>;

/** Mutable data derived from Truth. Recreated by reset(). */
export interface Runtime {
  state: ServerState;
  sessions: Map<string, Session>;
  sidCounter: number;
  orderCounter: number;
  transferCounter: number;
  wizardCounter: number;
  newsPoints: Map<number, number>;
  newsVoted: Set<string>;
  balances: Map<string, number>;
  bankLedger: Map<string, { date: string; desc: string; cents: number }[]>;
}

export function makeRuntime(truth: Truth): Runtime {
  const balances = new Map<string, number>();
  const ledger = new Map<string, { date: string; desc: string; cents: number }[]>();
  for (const a of truth.bank.accounts) {
    balances.set(a.number, a.balanceCents);
    ledger.set(a.number, a.history.map((h) => ({ ...h })));
  }
  const pts = new Map<number, number>();
  for (const s of truth.news.stories) pts.set(s.id, s.points);
  return {
    state: blankState(), sessions: new Map(), sidCounter: 0, orderCounter: 0, transferCounter: 0, wizardCounter: 0,
    newsPoints: pts, newsVoted: new Set(), balances, bankLedger: ledger,
  };
}

// ---------------------------------------------------------------------------------------------
// Request context

export interface UploadedFile { field: string; filename: string; type: string; size: number; sha256: string }
export interface Form {
  fields: Record<string, string[]>;
  files: UploadedFile[];
  get(name: string): string;
  all(name: string): string[];
}

export interface CookieOpts { path?: string; httpOnly?: boolean; maxAge?: number; sameSite?: string }

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  path: string;
  q: URLSearchParams;
  cookies: Record<string, string>;
  origin: string;
  otherOrigin: string;
  truth: Truth;
  rt: Runtime;
  sent: boolean;
  setCookie(name: string, value: string, o?: CookieOpts): void;
  body(): Promise<Buffer>;
  form(): Promise<Form>;
  /** The session for a site, created (and its cookie set) on first use. */
  session(site: string, create?: boolean): Session | undefined;
  send(status: number, headers: Record<string, string | string[]>, body: string | Buffer): void;
  html(body: string, status?: number, headers?: Record<string, string>): void;
  json(obj: unknown, status?: number): void;
  text(body: string, status?: number, type?: string): void;
  redirect(location: string, status?: number): void;
  notFound(message?: string): void;
  header(name: string): string;
}

export type Handler = (c: Ctx, rest: string) => Promise<void> | void;

export function parseCookies(h: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function parseMultipart(buf: Buffer, boundary: string): Form {
  const fields: Record<string, string[]> = {};
  const files: UploadedFile[] = [];
  const delim = Buffer.from('--' + boundary);
  let pos = buf.indexOf(delim);
  while (pos >= 0) {
    const start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break;
    const next = buf.indexOf(delim, start);
    if (next < 0) break;
    const part = buf.slice(start + 2, next - 2); // strip CRLF after boundary and before the next one
    const sep = part.indexOf('\r\n\r\n');
    if (sep >= 0) {
      const head = part.slice(0, sep).toString('utf8');
      const data = part.slice(sep + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1] ?? '';
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      if (filename !== undefined) {
        if (filename !== '' || data.length > 0) {
          const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? 'application/octet-stream';
          files.push({ field: name, filename, type, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
        }
        (fields[name] ??= []).push(filename);
      } else (fields[name] ??= []).push(data.toString('utf8'));
    }
    pos = next;
  }
  return mkForm(fields, files);
}

function mkForm(fields: Record<string, string[]>, files: UploadedFile[]): Form {
  return { fields, files, get: (n) => fields[n]?.[0] ?? '', all: (n) => fields[n] ?? [] };
}

export function createCtx(req: IncomingMessage, res: ServerResponse, o: { origin: string; otherOrigin: string; truth: Truth; rt: Runtime }): Ctx {
  const url = new URL(req.url ?? '/', o.origin);
  const setCookies: string[] = [];
  let bodyP: Promise<Buffer> | undefined;
  const cookies = parseCookies(req.headers.cookie);
  const c: Ctx = {
    req, res, method: (req.method ?? 'GET').toUpperCase(), url,
    path: safeDecode(url.pathname), q: url.searchParams, cookies,
    origin: o.origin, otherOrigin: o.otherOrigin, truth: o.truth, rt: o.rt, sent: false,
    header: (n) => String(req.headers[n.toLowerCase()] ?? ''),
    setCookie(name, value, opt = {}) {
      let s = `${name}=${encodeURIComponent(value)}; Path=${opt.path ?? '/'}`;
      if (opt.httpOnly !== false) s += '; HttpOnly';
      s += `; SameSite=${opt.sameSite ?? 'Lax'}`;
      if (opt.maxAge !== undefined) s += `; Max-Age=${opt.maxAge}`;
      setCookies.push(s);
      cookies[name] = value;
    },
    body() {
      return (bodyP ??= new Promise<Buffer>((resolve, reject) => {
        const parts: Buffer[] = [];
        req.on('data', (d: Buffer) => parts.push(d));
        req.on('end', () => resolve(Buffer.concat(parts)));
        req.on('error', reject);
      }));
    },
    async form() {
      const buf = await c.body();
      const ct = c.header('content-type');
      if (/multipart\/form-data/i.test(ct)) {
        const b = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
        return parseMultipart(buf, (b?.[1] ?? b?.[2] ?? '').trim());
      }
      const fields: Record<string, string[]> = {};
      if (/application\/json/i.test(ct)) {
        try {
          const j = JSON.parse(buf.toString('utf8'));
          for (const [k, v] of Object.entries(j)) fields[k] = Array.isArray(v) ? v.map(String) : [String(v)];
        } catch { /* empty */ }
      } else {
        for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) (fields[k] ??= []).push(v);
      }
      return mkForm(fields, []);
    },
    session(site, create = true) {
      const name = `${site}_sid`;
      let sid = cookies[name];
      const key = sid ? `${site}:${sid}` : '';
      if (sid && o.rt.sessions.has(key)) return o.rt.sessions.get(key);
      if (!create) return undefined;
      sid = hashHex(o.truth.seed, 'sid', site, ++o.rt.sidCounter).slice(0, 24);
      c.setCookie(name, sid);
      const s: Session = { id: sid };
      o.rt.sessions.set(`${site}:${sid}`, s);
      return s;
    },
    send(status, headers, body) {
      if (c.sent) return;
      c.sent = true;
      const h: Record<string, string | string[]> = { ...headers };
      if (setCookies.length) h['Set-Cookie'] = setCookies;
      const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      if (h['Content-Length'] === undefined && !h['content-length']) h['Content-Length'] = String(buf.length);
      res.writeHead(status, h);
      res.end(c.method === 'HEAD' ? undefined : buf);
    },
    html(body, status = 200, headers = {}) {
      c.send(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers }, body);
    },
    json(obj, status = 200) {
      c.send(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, JSON.stringify(obj));
    },
    text(body, status = 200, type = 'text/plain; charset=utf-8') {
      c.send(status, { 'Content-Type': type, 'Cache-Control': 'no-store' }, body);
    },
    redirect(location, status = 303) {
      c.send(status, { Location: location, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, `Redirecting to ${location}`);
    },
    notFound(message = 'Not found') {
      c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>404 Not Found</title></head><body><h1>404 Not Found</h1><p>${message}</p><p><a href="/">Home</a></p></body></html>`, 404);
    },
  };
  return c;
}

function safeDecode(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function intParam(v: string | null, dflt: number, lo = 1, hi = 1_000_000): number {
  const n = Number.parseInt(v ?? '', 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
