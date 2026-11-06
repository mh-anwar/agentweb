// Shared helpers for the ghost engine tests: a minimal CookieJar and Guard, a session context,
// a fixture server on port 0, and LNode queries.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CookieData, CookieJar, Guard, SessionCtx, Verdict } from '../src/types.ts';
import type { LNode } from '../src/tree.ts';

export class TestJar implements CookieJar {
  list: CookieData[] = [];
  header(url: string): string {
    const u = new URL(url);
    const now = Date.now() / 1000;
    return this.list
      .filter((c) => (c.expires === undefined || c.expires > now) && (c.hostOnly ? u.hostname === c.domain : u.hostname === c.domain || u.hostname.endsWith('.' + c.domain)) && (u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }
  setFromHeaders(url: string, setCookie: string[]): void {
    const u = new URL(url);
    for (const line of setCookie) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = (eq < 0 ? '' : pair.slice(0, eq)).trim();
      const value = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
      const c: CookieData = { name, value, domain: u.hostname, path: '/', hostOnly: true };
      for (const a of attrs) {
        const [k, v = ''] = a.split('=').map((s) => s.trim());
        const key = k.toLowerCase();
        if (key === 'path') c.path = v || '/';
        else if (key === 'domain' && v) {
          c.domain = v.replace(/^\./, '').toLowerCase();
          c.hostOnly = false;
        } else if (key === 'max-age') c.expires = Date.now() / 1000 + Number(v);
        else if (key === 'expires') c.expires = Date.parse(v) / 1000;
        else if (key === 'httponly') c.httpOnly = true;
        else if (key === 'secure') c.secure = true;
        else if (key === 'samesite') c.sameSite = (v[0].toUpperCase() + v.slice(1).toLowerCase()) as any;
      }
      this.set(c);
    }
  }
  all(): CookieData[] {
    const now = Date.now() / 1000;
    this.list = this.list.filter((c) => c.expires === undefined || c.expires > now);
    return this.list.slice();
  }
  set(c: CookieData): void {
    this.list = this.list.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
    if (c.expires === undefined || c.expires > Date.now() / 1000) this.list.push(c);
  }
  merge(cookies: CookieData[]): void {
    for (const c of cookies) this.set(c);
  }
  has(url: string): boolean {
    return this.header(url) !== '';
  }
  clear(): void {
    this.list = [];
  }
}

export class TestGuard implements Guard {
  deny: RegExp | null = null;
  seen: { url: string; why: string }[] = [];
  async checkUrl(url: string, why: 'open' | 'redirect' | 'sub' | 'submit'): Promise<Verdict> {
    this.seen.push({ url, why });
    if (this.deny && this.deny.test(url)) return { ok: false, reason: 'denied by test policy' };
    return { ok: true };
  }
  async checkStep(): Promise<Verdict> {
    return { ok: true };
  }
  reveal(t: string): string {
    return t;
  }
  redact(t: string): string {
    return t;
  }
  observe(): void {}
  checkOutflow(): Verdict {
    return { ok: true };
  }
  state(): unknown {
    return {};
  }
}

let n = 0;
export function makeCtx(over: Partial<SessionCtx> = {}): SessionCtx {
  return {
    id: 's' + ++n + '-' + Math.random().toString(36).slice(2, 6),
    jar: new TestJar(),
    storage: {},
    userAgent: 'agentweb-test/1.0',
    guard: new TestGuard(),
    timeoutMs: 20000,
    ...over,
  };
}

export type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void | Promise<void>;

export async function serve(routes: Record<string, Handler | string>): Promise<{ url: string; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const u = new URL(req.url || '/', 'http://x');
    hits.push(`${req.method} ${u.pathname}${u.search}`);
    const h = routes[`${req.method} ${u.pathname}`] ?? routes[u.pathname] ?? routes['*'];
    if (h === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    if (typeof h === 'string') {
      res.writeHead(200, { 'content-type': /^\s*</.test(h) ? 'text/html; charset=utf-8' : 'text/javascript' });
      res.end(h);
      return;
    }
    try {
      await h(req, res, body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export const html = (body: string, head = '') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

export function textOf(n: LNode | undefined): string {
  if (!n) return '';
  if (n.t === '#text') return n.x ?? '';
  if (n.h) return '';
  return (n.c || []).map(textOf).join('');
}

export function* nodes(n: LNode): Generator<LNode> {
  yield n;
  if (n.c) for (const c of n.c) yield* nodes(c);
}

export function findNode(root: LNode, pred: (n: LNode) => boolean): LNode | undefined {
  for (const x of nodes(root)) if (pred(x)) return x;
  return undefined;
}

export const byId = (root: LNode, id: string) => findNode(root, (n) => n.a?.id === id);
export const byTag = (root: LNode, t: string, text?: string) => findNode(root, (n) => n.t === t && (text === undefined || textOf(n).includes(text)));
export const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** bundle a fixture app with esbuild; returns output files by name ("main.js", chunks …) */
export async function bundle(entry: string, o: { format: 'iife' | 'esm'; splitting?: boolean; alias?: Record<string, string> }): Promise<Record<string, string>> {
  const esbuild = await import('esbuild');
  const r = await esbuild.build({
    entryPoints: { main: entry },
    bundle: true,
    write: false,
    format: o.format,
    splitting: !!o.splitting,
    outdir: '/out',
    minify: true,
    jsx: 'automatic',
    jsxImportSource: entry.includes('preact') ? 'preact' : 'react',
    alias: o.alias,
    logLevel: 'silent',
    define: {
      'process.env.NODE_ENV': '"production"',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
  });
  const out: Record<string, string> = {};
  for (const f of r.outputFiles) out[f.path.replace(/^.*\//, '')] = f.text;
  return out;
}

export const json = (data: unknown, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
};
