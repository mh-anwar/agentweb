// The wire engine: plain HTTP, no JavaScript. Serves most agent traffic without a browser.
//
//  open() = for each hop: guard.checkUrl → (shared cache | single-flight) → politeness slot →
//           undici request with cookies → bounded streaming decompression → Set-Cookie into the
//           jar → manual redirect. The final hop is decoded, sniffed and parsed.
//
// DNS-rebinding defence: `checkAddress` runs inside the socket's DNS lookup (and on IP-literal
// hosts before connecting), so the address that is checked is the address that is connected to.

import dns from 'node:dns';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
import zlib from 'node:zlib';
import { Agent, buildConnector } from 'undici';
import { parseHtml } from '../parse.ts';
import { hash } from '../tree.ts';
import type { Engine, Loaded, NavRequest, SessionCtx, Store } from '../types.ts';
import { AwError } from '../types.ts';
import { detectBotWall } from './botwall.ts';
import { createPageCache, type CacheOptions, type PageCache, type RawHop } from './cache.ts';
import { decodeBody, isHtml, isTextual, parseContentType, sniff } from './decode.ts';
import { createLimiter, type Limiter, type LimiterOptions } from './polite.ts';

export type Resolver = (host: string) => Promise<{ address: string; family: 4 | 6 }[]>;

export interface WireOptions {
  /** connect-time address policy (SSRF / DNS rebinding). Return false to refuse. */
  checkAddress?: (ip: string, host: string) => boolean;
  /** custom DNS (tests, DoH); default dns.lookup with all addresses */
  resolve?: Resolver;
  /** DNS cache lifetime (default 30 s; 0 disables) */
  dnsCacheMs?: number;
  /** max decoded body bytes (default 8 MB) */
  maxBodyBytes?: number;
  maxRedirects?: number;
  acceptLanguage?: string;
  /** shared page cache, or a Store to build one on */
  cache?: PageCache | Store;
  cacheOptions?: CacheOptions;
  /** politeness limiter or its options; false disables (default: per-origin 6) */
  polite?: Limiter | LimiterOptions | false;
  /** longest Retry-After the engine will wait for its one retry (default 3000 ms) */
  retryAfterCapMs?: number;
  connectTimeoutMs?: number;
  /** keep-alive idle time for pooled sockets (default 10 s) */
  keepAliveMs?: number;
  /** TLS options for the connector (tests: a private CA) */
  tls?: { ca?: string | Buffer; rejectUnauthorized?: boolean };
  /** default timeout when ctx.timeoutMs is 0 / missing (default 30 s) */
  defaultTimeoutMs?: number;
}

export const ACCEPT_READ = 'text/markdown, text/html;q=0.9, application/json;q=0.8, */*;q=0.5';
export const ACCEPT_HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCEPT_ENCODING = typeof zlib.createZstdDecompress === 'function' ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br';
const DEFAULT_UA = 'agentweb/0.1 (+https://github.com/agentweb)';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DROP_REQ = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect']);
const MB = 1024 * 1024;

interface NetStats {
  opens: number;
  hops: number;
  redirects: number;
  originRequests: number;
  bytesIn: number;
  errors: number;
  botWalls: number;
  retries: number;
  truncated: number;
  addressRefused: number;
  dnsHits: number;
  dnsMisses: number;
}

export interface WireEngine extends Engine {
  readonly cache?: PageCache;
  readonly limiter?: Limiter;
  stats(): Record<string, number>;
}

class AddressRefused extends Error {
  code = 'EAW_ADDRESS';
  host: string;
  ip: string;
  constructor(host: string, ip: string) {
    super(`address ${ip} not allowed for ${host}`);
    this.host = host;
    this.ip = ip;
  }
}

export function createWireEngine(opts: WireOptions = {}): WireEngine {
  const maxBody = opts.maxBodyBytes ?? 8 * MB;
  const maxRedirects = opts.maxRedirects ?? 10;
  const acceptLanguage = opts.acceptLanguage ?? 'en-US,en;q=0.9';
  const retryCap = opts.retryAfterCapMs ?? 3000;
  const dnsTtl = opts.dnsCacheMs ?? 30_000;
  const st: NetStats = { opens: 0, hops: 0, redirects: 0, originRequests: 0, bytesIn: 0, errors: 0, botWalls: 0, retries: 0, truncated: 0, addressRefused: 0, dnsHits: 0, dnsMisses: 0 };

  const cache: PageCache | undefined = !opts.cache ? undefined : 'fetch' in opts.cache && 'key' in opts.cache ? (opts.cache as PageCache) : createPageCache(opts.cache as Store, opts.cacheOptions);
  const limiter: Limiter | undefined = opts.polite === false ? undefined : opts.polite && 'acquire' in opts.polite ? (opts.polite as Limiter) : createLimiter((opts.polite as LimiterOptions) ?? {});

  // ── DNS with a small positive cache and in-flight dedupe ──
  const dnsCache = new Map<string, { at: number; addrs: { address: string; family: 4 | 6 }[] }>();
  const dnsFlight = new Map<string, Promise<{ address: string; family: 4 | 6 }[]>>();
  const sysResolve: Resolver = (host) =>
    new Promise((resolve, reject) =>
      dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))))),
    );
  const resolver = opts.resolve ?? sysResolve;
  function resolveHost(host: string): Promise<{ address: string; family: 4 | 6 }[]> {
    const c = dnsTtl > 0 ? dnsCache.get(host) : undefined;
    if (c && Date.now() - c.at < dnsTtl) { st.dnsHits++; return Promise.resolve(c.addrs); }
    let p = dnsFlight.get(host);
    if (p) return p;
    st.dnsMisses++;
    p = resolver(host).then(
      (addrs) => {
        dnsFlight.delete(host);
        if (!addrs.length) throw Object.assign(new Error(`no addresses for ${host}`), { code: 'ENOTFOUND' });
        if (dnsTtl > 0) {
          if (dnsCache.size > 10_000) dnsCache.delete(dnsCache.keys().next().value!);
          dnsCache.set(host, { at: Date.now(), addrs });
        }
        return addrs;
      },
      (e) => { dnsFlight.delete(host); throw e; },
    );
    dnsFlight.set(host, p);
    return p;
  }

  const lookup = (hostname: string, options: { all?: boolean; family?: number }, cb: (...a: any[]) => void) => {
    resolveHost(hostname).then(
      (addrs) => {
        let ok = opts.checkAddress ? addrs.filter((a) => opts.checkAddress!(a.address, hostname)) : addrs;
        if (!ok.length) { st.addressRefused++; return cb(new AddressRefused(hostname, addrs[0].address)); }
        if (options.family === 4 || options.family === 6) {
          const fam = ok.filter((a) => a.family === options.family);
          if (fam.length) ok = fam;
        }
        if (options.all) cb(null, ok);
        else cb(null, ok[0].address, ok[0].family);
      },
      (e) => cb(e),
    );
  };

  const baseConnect = buildConnector({ lookup, timeout: opts.connectTimeoutMs ?? 10_000, ...(opts.tls ?? {}) } as any);
  const connect = (o: any, cb: any) => {
    const h = String(o.hostname ?? '').replace(/^\[|\]$/g, '');
    if (net.isIP(h) && opts.checkAddress && !opts.checkAddress(h, h)) {
      st.addressRefused++;
      cb(new AddressRefused(h, h), null);
      return;
    }
    return baseConnect(o, cb);
  };
  const agent = new Agent({ connect, keepAliveTimeout: opts.keepAliveMs ?? 10_000, keepAliveMaxTimeout: 60_000, pipelining: 1 } as any);

  // ── one origin request (with the Retry-After retry) ──
  async function originRequest(ctx: SessionCtx, url: URL, method: string, headers: Record<string, string>, body: string | Uint8Array | undefined, signal: AbortSignal): Promise<RawHop> {
    let carried: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const release = limiter ? await limiter.acquire(url.origin, signal) : undefined;
      let hop: RawHop;
      try {
        st.originRequests++;
        hop = await request(url, method, headers, body, signal);
      } finally {
        release?.();
      }
      if (carried.length) hop.setCookie = [...carried, ...hop.setCookie];
      if (attempt === 0 && (hop.status === 429 || hop.status === 503) && method === 'GET') {
        const wait = retryAfterMs(hop.headers['retry-after']);
        if (wait !== undefined && wait <= retryCap) {
          st.retries++;
          // a challenge cookie set on the 429 must go out on the retry
          if (hop.setCookie.length) {
            ctx.jar.setFromHeaders(url.href, hop.setCookie);
            carried = hop.setCookie;
            const c = ctx.jar.header(url.href);
            if (c) headers = { ...headers, cookie: c };
          }
          await sleep(wait, signal);
          continue;
        }
      }
      return hop;
    }
  }

  async function request(url: URL, method: string, headers: Record<string, string>, body: string | Uint8Array | undefined, signal: AbortSignal): Promise<RawHop> {
    const res = await agent.request({
      origin: url.origin,
      path: url.pathname + url.search,
      method: method as any,
      headers,
      body,
      signal,
      headersTimeout: 0,
      bodyTimeout: 0,
    });
    const h: Record<string, string> = {};
    let setCookie: string[] = [];
    for (const [k, v] of Object.entries(res.headers)) {
      if (v === undefined) continue;
      const key = k.toLowerCase();
      if (key === 'set-cookie') { setCookie = Array.isArray(v) ? v : [v]; continue; }
      h[key] = Array.isArray(v) ? v.join(', ') : v;
    }
    const status = res.statusCode;
    const hop: RawHop = { url: url.href, status, headers: h, setCookie, body: new Uint8Array(0) };
    if (method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200)) {
      res.body.resume();
      return hop;
    }
    if (REDIRECTS.has(status) && h.location) {
      // redirect bodies are noise; read a little so the socket can be reused, then drop it
      const r = await readBody(res.body, [], 64 * 1024);
      hop.body = r.buf;
      return hop;
    }
    const declared = parseContentType(h['content-type']).mime;
    const len = Number(h['content-length']);
    if (Number.isFinite(len) && len > maxBody && declared && !isHtml(declared) && declared !== 'application/octet-stream' && !(h['content-encoding'] ?? '').trim()) {
      res.body.destroy();
      throw new AwError('too_large', `${declared} body is ${fmtBytes(len)} (limit ${fmtBytes(maxBody)})`);
    }
    const encs = (h['content-encoding'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && s !== 'identity');
    const r = await readBody(res.body, encs, maxBody);
    if (signal.aborted) throw signal.reason; // a timeout mid-body is a timeout, not a short page
    hop.body = r.buf;
    if (r.truncated) hop.truncated = true;
    if (r.error) hop.error = r.error;
    st.bytesIn += r.buf.length;
    return hop;
  }

  // ── open ──
  async function open(ctx: SessionCtx, req: NavRequest): Promise<Loaded> {
    const t0 = performance.now();
    st.opens++;
    const timeoutMs = ctx.timeoutMs > 0 ? ctx.timeoutMs : (opts.defaultTimeoutMs ?? 30_000);
    const timer = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timer]) : timer;
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      throw new AwError('bad_request', `invalid URL: ${req.url.slice(0, 200)}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AwError('unsupported', `the wire tier only loads http(s) URLs, not ${url.protocol}`);
    let method: 'GET' | 'POST' = req.method === 'POST' ? 'POST' : 'GET';
    let body = method === 'POST' ? req.body : undefined;
    let contentType = method === 'POST' ? req.contentType : undefined;
    let referer = req.referer;
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const key = k.toLowerCase();
      if (!DROP_REQ.has(key) && typeof v === 'string') extra[key] = v;
    }
    const events: string[] = [];
    const seen = new Set<string>();
    let cached = false;
    let auth: string | undefined;

    try {
      for (let hopNo = 0; ; hopNo++) {
        if (url.username || url.password) {
          auth = 'Basic ' + Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64');
          url.username = '';
          url.password = '';
        }
        const v = await ctx.guard.checkUrl(url.href, hopNo === 0 ? 'open' : 'redirect');
        if (!v.ok) throw new AwError('policy', v.reason);
        if (v.warn) events.push(v.warn);
        if (signal.aborted) throw signal.reason;
        st.hops++;

        const headers: Record<string, string> = {
          'user-agent': ctx.userAgent || DEFAULT_UA,
          accept: req.read ? ACCEPT_READ : ACCEPT_HTML,
          'accept-language': acceptLanguage,
          'accept-encoding': ACCEPT_ENCODING,
        };
        const ref = refererFor(referer, url);
        if (ref) headers.referer = ref;
        if (body !== undefined && contentType) headers['content-type'] = contentType;
        if (auth) headers.authorization = auth;
        Object.assign(headers, extra);
        const cookie = ctx.jar.header(url.href);
        if (cookie) headers.cookie = extra.cookie ? `${cookie}; ${extra.cookie}` : cookie;

        let hop: RawHop;
        const cacheable = cache && method === 'GET' && req.read && !headers.cookie && !headers.authorization && body === undefined;
        if (cacheable) {
          const variant = hash(`${headers.accept}\n${headers['accept-language']}\n${Object.entries(extra).filter(([k]) => k !== 'referer' && k !== 'user-agent').sort().join('\n')}`);
          const r = await cache.fetch(cache.key(url.href, variant), (cond) => originRequest(ctx, url, method, { ...headers, ...cond }, undefined, signal), signal);
          hop = r.hop;
          cached = r.via !== 'miss';
        } else {
          hop = await originRequest(ctx, url, method, headers, body, signal);
          cached = false;
        }
        if (hop.setCookie.length) ctx.jar.setFromHeaders(url.href, hop.setCookie);

        const loc = hop.headers.location;
        if (REDIRECTS.has(hop.status) && loc) {
          let next: URL;
          try {
            next = new URL(loc, url);
          } catch {
            events.push(`ignored bad redirect Location: ${loc.slice(0, 120)}`);
            return finish(hop, method, events, cached, t0);
          }
          if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new AwError('unsupported', `redirect to a ${next.protocol} URL`, 'open it with an app that handles that scheme');
          if (!next.hash && url.hash) next.hash = url.hash;
          if (hopNo + 1 > maxRedirects) throw new AwError('net', `too many redirects (more than ${maxRedirects})`);
          if (hop.status === 303 || ((hop.status === 301 || hop.status === 302) && method === 'POST')) {
            method = 'GET';
            body = undefined;
            contentType = undefined;
          }
          if (next.origin !== url.origin) {
            delete extra.authorization;
            delete extra.cookie;
            delete extra['proxy-authorization'];
            auth = undefined;
          }
          const loopKey = `${method} ${next.href} ${ctx.jar.header(next.href)}`;
          seen.add(`${method} ${url.href} ${cookie}`);
          if (seen.has(loopKey)) throw new AwError('net', `redirect loop at ${next.href.slice(0, 200)}`);
          st.redirects++;
          referer = url.href;
          url = next;
          continue;
        }
        return finish(hop, method, events, cached, t0);
      }
    } catch (e) {
      st.errors++;
      throw mapError(e, url, signal, ctx, timeoutMs);
    }
  }

  function finish(hop: RawHop, method: 'GET' | 'POST', events: string[], cached: boolean, t0: number): Loaded {
    const ct = parseContentType(hop.headers['content-type']);
    const mime = sniff(ct.mime, hop.body, hop.url);
    const html = isHtml(mime);
    if (hop.error && (!html || hop.body.length === 0)) throw hop.error;
    if (hop.error) events.push(`${hop.error.message}; showing the first ${fmtBytes(hop.body.length)}`);
    if (hop.truncated) {
      if (!html) throw new AwError('too_large', `${mime} body is larger than ${fmtBytes(maxBody)}`);
      st.truncated++;
      events.push(`page truncated at ${fmtBytes(maxBody)}`);
    }
    const out: Loaded = {
      url: hop.url,
      status: hop.status,
      method,
      contentType: mime,
      bytes: hop.body.length,
      ms: 0,
      headers: { ...hop.headers }, // coalesced waiters share one hop: never hand out the same object
    };
    if (cached) out.cached = true;
    let text: string | undefined;
    if (html) {
      text = decodeBody(hop.body, ct.charset, true).text;
      out.doc = parseHtml(text);
    } else if (isTextual(mime)) {
      text = decodeBody(hop.body, ct.charset, mime.includes('xml')).text;
      out.body = { text };
    } else {
      out.body = { bytes: hop.body };
    }
    const wall = detectBotWall({ status: hop.status, headers: hop.setCookie.length ? { ...hop.headers, 'set-cookie': hop.setCookie.join('\n') } : hop.headers, text: text ?? '', mime });
    if (wall) {
      st.botWalls++;
      out.escalate = `bot wall (${wall})`;
    }
    if (events.length) out.events = events;
    out.ms = Math.round(performance.now() - t0);
    return out;
  }

  function mapError(e: unknown, url: URL, signal: AbortSignal, ctx: SessionCtx, timeoutMs: number): AwError {
    if (signal.aborted) {
      if (ctx.signal?.aborted) {
        const r = ctx.signal.reason;
        return r instanceof AwError ? r : new AwError('timeout', `aborted while loading ${url.host}`);
      }
      return new AwError('timeout', `timed out after ${timeoutMs} ms loading ${url.host}`, 'retry, or raise the timeout');
    }
    if (e instanceof AwError) return e;
    return netError(e, url);
  }

  return {
    tier: 'wire',
    cache,
    limiter,
    async available() { return true; },
    open,
    async release() {},
    async close() {
      await agent.close().catch(() => agent.destroy());
    },
    stats(): Record<string, number> {
      const out: Record<string, number> = { ...st };
      if (cache) for (const [k, v] of Object.entries(cache.stats())) out[`cache_${k}`] = v;
      if (limiter) for (const [k, v] of Object.entries(limiter.stats())) out[`polite_${k}`] = v;
      return out;
    },
  };
}

// ───────────────────────────── body reading ─────────────────────────────

function decoder(enc: string): Transform {
  const lenient = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
  switch (enc) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip(lenient);
    case 'deflate':
      return autoInflate();
    case 'br':
      return zlib.createBrotliDecompress({ finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    case 'zstd':
      if (typeof zlib.createZstdDecompress === 'function') return zlib.createZstdDecompress() as unknown as Transform;
    // fall through
    default:
      throw new AwError('net', `unsupported content-encoding: ${enc}`);
  }
}

/** "deflate" is zlib-wrapped per the RFC, but many servers send raw deflate: decide on the first bytes. */
function autoInflate(): Transform {
  // zlib header: CM=8 and (CMF*256 + FLG) % 31 == 0
  let inner: zlib.Inflate | zlib.InflateRaw | undefined;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!inner) {
        const zl = chunk.length >= 2 && (chunk[0] & 0x0f) === 8 && ((chunk[0] << 8) | chunk[1]) % 31 === 0;
        inner = zl ? zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }) : zlib.createInflateRaw({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
        inner.on('data', (d: Buffer) => t.push(d));
        inner.on('error', (e: Error) => t.destroy(e));
      }
      inner.write(chunk, () => cb());
    },
    flush(cb) {
      if (!inner) return cb();
      inner.once('end', () => cb());
      inner.end();
    },
  });
  return t;
}

async function readBody(body: Readable, encs: string[], limit: number): Promise<{ buf: Uint8Array; truncated: boolean; error?: AwError }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  const sink = async function (source: AsyncIterable<Buffer>) {
    for await (const c of source) {
      if (size + c.length > limit) {
        chunks.push(c.subarray(0, limit - size));
        size = limit;
        truncated = true;
        return;
      }
      chunks.push(c);
      size += c.length;
    }
  };
  let error: AwError | undefined;
  try {
    if (!encs.length) await sink(body);
    else {
      const stages = encs.slice().reverse().map(decoder);
      await (pipeline as any)(body, ...stages, sink);
    }
  } catch (e) {
    if (!truncated) {
      const code = errCode(e);
      if (code.startsWith('Z_') || /incorrect header|invalid|unexpected end|decompress/i.test(String((e as Error)?.message))) {
        error = new AwError('net', `corrupt ${encs.join('+') || 'body'} encoding`);
      } else if (e instanceof AwError) {
        error = e;
      } else {
        error = netError(e, undefined, 'connection closed mid-body');
      }
    }
  } finally {
    if (truncated || error) body.destroy();
  }
  const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
  return { buf: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), truncated, error };
}

// ───────────────────────────── helpers ─────────────────────────────

function errCode(e: unknown): string {
  return String((e as { code?: string })?.code ?? '');
}

function allCodes(e: unknown, out: string[] = [], depth = 0): string[] {
  if (!e || typeof e !== 'object' || depth > 4) return out;
  const c = (e as { code?: unknown }).code;
  if (typeof c === 'string') out.push(c);
  const errs = (e as { errors?: unknown[] }).errors;
  if (Array.isArray(errs)) for (const x of errs) allCodes(x, out, depth + 1);
  allCodes((e as { cause?: unknown }).cause, out, depth + 1);
  return out;
}

/** Map a socket / undici error to a short agent-facing AwError. */
export function netError(e: unknown, url: URL | undefined, fallback = 'request failed'): AwError {
  const host = url?.host ?? 'the server';
  const codes = allCodes(e);
  const has = (...c: string[]) => codes.some((x) => c.includes(x));
  const msg = String((e as Error)?.message ?? e);
  if (has('EAW_ADDRESS')) {
    const ae = findAddr(e);
    return new AwError('policy', `blocked: ${ae?.host ?? host} resolves to a disallowed address (${ae?.ip ?? '?'})`);
  }
  if (has('ENOTFOUND', 'EAI_NONAME', 'EAI_NODATA', 'EAI_FAIL')) return new AwError('net', `DNS lookup failed for ${url?.hostname ?? host}`, 'check the domain name');
  if (has('EAI_AGAIN')) return new AwError('net', `DNS temporarily failing for ${url?.hostname ?? host}`, 'retry shortly');
  if (has('ECONNREFUSED')) return new AwError('net', `connection refused by ${host}`);
  if (has('UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT')) return new AwError('timeout', `connect to ${host} timed out`);
  if (has('UND_ERR_HEADERS_TIMEOUT')) return new AwError('timeout', `${host} sent no response headers in time`);
  if (has('UND_ERR_BODY_TIMEOUT')) return new AwError('timeout', `${host} stalled while sending the body`);
  if (has('EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL')) return new AwError('net', `${host} is unreachable`);
  const tls = codes.find((c) => /CERT|SSL|TLS|ERR_OSSL|SELF_SIGNED|UNABLE_TO_(?:VERIFY|GET)/.test(c));
  if (tls || /certificate|ssl|tls/i.test(msg)) return new AwError('net', `TLS error with ${host}: ${tlsReason(tls, msg)}`);
  if (has('ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ECONNABORTED')) return new AwError('net', `connection reset by ${host}${fallback === 'request failed' ? '' : ' (' + fallback + ')'}`);
  if (codes.some((c) => c.startsWith('HPE_')) || has('UND_ERR_INFO')) return new AwError('net', `${host} sent a malformed HTTP response`);
  if (has('UND_ERR_RES_CONTENT_LENGTH_MISMATCH', 'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH')) return new AwError('net', `${host} sent a body that does not match its Content-Length`);
  if (has('UND_ERR_INVALID_ARG')) return new AwError('bad_request', `invalid request: ${msg.slice(0, 120)}`);
  if (has('UND_ERR_ABORTED', 'ABORT_ERR') || (e as Error)?.name === 'AbortError') return new AwError('timeout', `request to ${host} aborted`);
  return new AwError('net', `${fallback}: ${msg.slice(0, 120)}`);
}

function findAddr(e: unknown, depth = 0): AddressRefused | undefined {
  if (!e || typeof e !== 'object' || depth > 4) return undefined;
  if (e instanceof AddressRefused) return e;
  const errs = (e as { errors?: unknown[] }).errors;
  if (Array.isArray(errs)) for (const x of errs) { const f = findAddr(x, depth + 1); if (f) return f; }
  return findAddr((e as { cause?: unknown }).cause, depth + 1);
}

function tlsReason(code: string | undefined, msg: string): string {
  if (!code) return msg.slice(0, 80);
  if (code === 'CERT_HAS_EXPIRED') return 'certificate expired';
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return 'self-signed certificate';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'certificate does not match the host name';
  if (code.startsWith('UNABLE_TO')) return 'untrusted certificate chain';
  return code.toLowerCase().replace(/_/g, ' ');
}

/** strict-origin-when-cross-origin, the browser default */
export function refererFor(from: string | undefined, to: URL): string | undefined {
  if (!from) return undefined;
  let f: URL;
  try { f = new URL(from); } catch { return undefined; }
  if (f.protocol !== 'http:' && f.protocol !== 'https:') return undefined;
  if (f.protocol === 'https:' && to.protocol === 'http:') return undefined;
  f.hash = '';
  f.username = '';
  f.password = '';
  if (f.origin === to.origin) return f.href;
  return f.origin + '/';
}

/** Retry-After as ms (delta-seconds or HTTP-date), undefined if absent/unparseable. */
export function retryAfterMs(v: string | undefined, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function fmtBytes(n: number): string {
  if (n >= MB) return `${+(n / MB).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
