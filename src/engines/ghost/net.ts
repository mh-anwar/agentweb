// Host-side networking for the ghost engine. Pages never touch a socket: the page process asks,
// and the engine decides here what the request is allowed to carry (cookies, SameSite, CORS)
// before handing it to `fetch` (the default below, or one supplied by the caller).

import { AwError } from '../../types.ts';
import type { CookieData, CookieJar, NavRequest, SessionCtx } from '../../types.ts';

export type FetchKind = 'document' | 'script' | 'xhr' | 'style';

export interface GhostRequest extends NavRequest {
  kind: FetchKind;
  /** attach and store cookies (default true) */
  credentials?: boolean;
  /**
   * which SameSite cookies may go along: 'same' all of them (same-site, or the agent itself
   * opening a URL), 'lax' a cross-site top-level GET, 'none' any other cross-site request
   */
  site?: 'same' | 'lax' | 'none';
  /** follow redirects (default true) */
  follow?: boolean;
  /** largest body accepted */
  maxBytes?: number;
}

export interface GhostResponse {
  /** final URL after redirects */
  url: string;
  status: number;
  /** lower-case names; repeated headers joined with ", " (set-cookie never included) */
  headers: Record<string, string>;
  bytes: Uint8Array;
  redirected?: boolean;
}

export type GhostFetch = (ctx: SessionCtx, req: GhostRequest) => Promise<GhostResponse>;

const ACCEPT: Record<FetchKind, string> = {
  document: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  script: '*/*',
  style: 'text/css,*/*;q=0.1',
  xhr: '*/*',
};

/** request headers page code may not set */
const FORBIDDEN = /^(accept-charset|accept-encoding|access-control-request-.*|connection|content-length|cookie2?|date|dnt|expect|host|keep-alive|origin|referer|te|trailer|transfer-encoding|upgrade|via|user-agent|proxy-.*|sec-.*)$/;

export function cleanHeaders(h: Record<string, string> | [string, string][] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  const pairs = Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of pairs) {
    const name = String(k).toLowerCase().trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name) || FORBIDDEN.test(name)) continue;
    const val = String(v).replace(/[\r\n]+/g, ' ');
    out[name] = out[name] !== undefined ? out[name] + ', ' + val : val;
  }
  return out;
}

// ───────────── sites and cookies ─────────────

/** a cheap registrable-domain guess (no public suffix list): last two labels, three for co.uk-style */
export function siteOf(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const host = u.hostname.replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return u.protocol + '//' + host;
  const parts = host.split('.');
  let n = 2;
  if (parts.length > 2 && parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3) n = 3;
  return u.protocol + '//' + parts.slice(-n).join('.');
}

export const sameSite = (a: string, b: string): boolean => siteOf(a) === siteOf(b);

const secureUrl = (u: URL) => u.protocol === 'https:' || u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';

export function cookieMatches(c: CookieData, u: URL, nowSec: number): boolean {
  if (c.expires !== undefined && c.expires > 0 && c.expires <= nowSec) return false;
  const host = u.hostname.toLowerCase();
  const domain = String(c.domain || '').toLowerCase().replace(/^\./, '');
  if (c.hostOnly ? host !== domain : !(host === domain || host.endsWith('.' + domain))) return false;
  const cp = c.path || '/';
  const p = u.pathname || '/';
  if (!(p === cp || p.startsWith(cp.endsWith('/') ? cp : cp + '/'))) return false;
  if (c.secure && !secureUrl(u)) return false;
  return true;
}

/** Cookie header for a request, honouring SameSite for cross-site requests */
export function cookieHeader(jar: CookieJar, url: string, site: 'same' | 'lax' | 'none' = 'same'): string {
  if (site === 'same') return jar.header(url);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  const now = Date.now() / 1000;
  return jar
    .all()
    .filter((c) => cookieMatches(c, u, now))
    .filter((c) => {
      const ss = c.sameSite ?? 'Lax'; // browsers treat an unspecified SameSite as Lax
      return ss === 'None' || (ss === 'Lax' && site === 'lax');
    })
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

/** what `document.cookie` shows: matching cookies that are not HttpOnly */
export function documentCookie(jar: CookieJar, url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return '';
  }
  if (!/^https?:$/.test(u.protocol)) return '';
  const now = Date.now() / 1000;
  return jar
    .all()
    .filter((c) => !c.httpOnly && cookieMatches(c, u, now))
    .sort((a, b) => (b.path || '/').length - (a.path || '/').length)
    .map((c) => (c.name ? `${c.name}=${c.value}` : c.value))
    .join('; ');
}

/** a `document.cookie = v` write, applied to the jar with the rules a browser applies */
export function applyScriptCookie(jar: CookieJar, url: string, value: string): void {
  if (/;\s*httponly\s*(;|$)/i.test(value)) return;
  const name = (/^\s*([^=;]*)=/.exec(value)?.[1] ?? '').trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  // a script may not overwrite an HttpOnly cookie
  const now = Date.now() / 1000;
  if (name && jar.all().some((c) => c.name === name && c.httpOnly && cookieMatches(c, u, now))) return;
  jar.setFromHeaders(url, [value]);
}

// ───────────── the default fetch ─────────────

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) {
    await res.body?.cancel().catch(() => {});
    throw new AwError('too_large', `the response is ${Math.round(len / 1048576)} MB, over the ${Math.round(max / 1048576)} MB limit`);
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      throw new AwError('too_large', `the response is over the ${Math.round(max / 1048576)} MB limit`);
    }
    parts.push(value);
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export interface DefaultFetchOptions {
  /** per-request timeout (ms); the session's timeout also applies */
  timeoutMs?: number;
  maxRedirects?: number;
  /**
   * an undici dispatcher to send requests through (pass the wire engine's, so its connect-time
   * address check also covers ghost pages); the global fetch is used otherwise
   */
  dispatcher?: unknown;
}

/** `fetch` over the global fetch: cookies from ctx.jar, Set-Cookie stored back, ctx.guard asked for every hop */
export function defaultFetch(o: DefaultFetchOptions = {}): GhostFetch {
  const maxRedirects = o.maxRedirects ?? 10;
  return async (ctx, req) => {
    let url = req.url;
    let method = (req.method || 'GET').toUpperCase();
    let body = req.body;
    let ctype = req.contentType;
    const creds = req.credentials !== false;
    const max = req.maxBytes ?? 16 << 20;
    const first = req.kind === 'document' ? (method === 'POST' ? 'submit' : 'open') : 'sub';
    const signals = [AbortSignal.timeout(Math.max(1000, Math.min(o.timeoutMs ?? 30000, ctx.timeoutMs || 30000)))];
    if (ctx.signal) signals.push(ctx.signal);
    const signal = AbortSignal.any(signals);
    for (let hop = 0; ; hop++) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw new AwError('bad_request', `not a URL: ${url}`);
      }
      if (!/^https?:$/.test(target.protocol)) throw new AwError('bad_request', `cannot fetch ${target.protocol} URLs`);
      const v = await ctx.guard.checkUrl(url, hop === 0 ? first : 'redirect');
      if (!v.ok) throw new AwError('policy', v.reason);
      const h: Record<string, string> = {
        accept: ACCEPT[req.kind] || '*/*',
        'accept-language': 'en-US,en;q=0.9',
        ...cleanHeaders(req.headers),
        'user-agent': ctx.userAgent,
      };
      if (req.headers) for (const [k, val] of Object.entries(req.headers)) if (k.toLowerCase() === 'origin') h.origin = String(val);
      if (req.referer) h.referer = req.referer;
      if (body !== undefined && body !== null && ctype) h['content-type'] = ctype;
      if (creds) {
        const c = cookieHeader(ctx.jar, url, req.site);
        if (c) h.cookie = c;
      }
      let res: Response;
      try {
        const init = { method, headers: h, body: method === 'GET' || method === 'HEAD' ? undefined : (body as any), redirect: 'manual' as const, signal };
        res = o.dispatcher ? ((await (await import('undici')).fetch(url, { ...init, dispatcher: o.dispatcher as any })) as unknown as Response) : await fetch(url, init);
      } catch (e: any) {
        if (signal.aborted) throw new AwError('timeout', `${target.host} did not answer in time`);
        const cause = e?.cause?.code || e?.cause?.message || e?.message || String(e);
        throw new AwError('net', `could not reach ${target.host}: ${cause}`);
      }
      if (creds) {
        const sc = res.headers.getSetCookie();
        if (sc.length) ctx.jar.setFromHeaders(url, sc);
      }
      const loc = res.headers.get('location');
      if (req.follow !== false && loc && [301, 302, 303, 307, 308].includes(res.status)) {
        await res.body?.cancel().catch(() => {});
        if (hop >= maxRedirects) throw new AwError('net', `too many redirects from ${req.url}`);
        url = new URL(loc, url).href;
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
          if (method !== 'HEAD') method = 'GET';
          body = undefined;
          ctype = undefined;
        }
        continue;
      }
      const bytes = method === 'HEAD' ? new Uint8Array(0) : await readCapped(res, max);
      const headers: Record<string, string> = {};
      res.headers.forEach((val, k) => {
        if (k === 'set-cookie') return;
        headers[k] = headers[k] !== undefined ? headers[k] + ', ' + val : val;
      });
      // the body is already decoded
      delete headers['content-encoding'];
      delete headers['content-length'];
      return { url, status: res.status, headers, bytes, redirected: hop > 0 };
    }
  };
}

// ───────────── CORS for page fetch() / XHR ─────────────

const SAFE_TYPES = /^(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)$/i;
const SAFE_REQ = new Set(['accept', 'accept-language', 'content-language', 'content-type']);
const SAFE_RES = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);

export function isSimple(method: string, headers: Record<string, string>): boolean {
  if (!['GET', 'HEAD', 'POST'].includes(method)) return false;
  for (const [k, v] of Object.entries(headers)) {
    if (!SAFE_REQ.has(k)) return false;
    if (k === 'content-type' && !SAFE_TYPES.test(v.split(';')[0].trim())) return false;
  }
  return true;
}

/** does a cross-origin response let `origin` read it? */
export function corsAllows(headers: Record<string, string>, origin: string, creds: boolean): boolean {
  const acao = (headers['access-control-allow-origin'] || '').trim();
  if (!acao) return false;
  if (acao === '*') return !creds;
  if (acao !== origin) return false;
  return !creds || (headers['access-control-allow-credentials'] || '').trim().toLowerCase() === 'true';
}

export function preflightAllows(headers: Record<string, string>, origin: string, creds: boolean, method: string, reqHeaders: string[]): boolean {
  if (!corsAllows(headers, origin, creds)) return false;
  const list = (s: string | undefined) => (s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const methods = list(headers['access-control-allow-methods']);
  if (!['GET', 'HEAD', 'POST'].includes(method) && !methods.includes(method.toLowerCase()) && !(methods.includes('*') && !creds)) return false;
  const allowed = list(headers['access-control-allow-headers']);
  for (const h of reqHeaders) if (!SAFE_REQ.has(h) && !allowed.includes(h) && !(allowed.includes('*') && !creds)) return false;
  return true;
}

/** response headers a cross-origin page may read */
export function exposed(headers: Record<string, string>): Record<string, string> {
  const extra = new Set((headers['access-control-expose-headers'] || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (SAFE_RES.has(k) || extra.has(k) || extra.has('*')) out[k] = v;
  return out;
}
