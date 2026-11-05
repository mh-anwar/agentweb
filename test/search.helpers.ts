// Test-only Fetchers for the search module: a live one on global fetch + parseHtml (no src/net),
// and a replay one that serves saved responses from test/fixtures/search/.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHtml } from '../src/parse.ts';
import type { Fetcher, Loaded, NavRequest } from '../src/types.ts';

export const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 agentweb/0.1';
export const FIXTURES = fileURLToPath(new URL('./fixtures/search/', import.meta.url));

export function toLoaded(req: NavRequest, url: string, status: number, contentType: string, text: string, headers: Record<string, string>, ms: number): Loaded {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  const l: Loaded = { url, status, method: req.method ?? 'GET', contentType: ct, bytes: Buffer.byteLength(text), ms, headers };
  if (ct === 'text/html' || ct === 'application/xhtml+xml') l.doc = parseHtml(text);
  else l.body = { text };
  return l;
}

/** A plain Fetcher on global fetch. Records every request it made in `log`. */
export function liveFetcher(log: { url: string; status: number; ms: number }[] = []): Fetcher {
  return async (req) => {
    const t0 = Date.now();
    const headers: Record<string, string> = { 'user-agent': UA, 'accept-encoding': 'gzip, deflate, br', ...req.headers };
    if (req.referer) headers.referer = req.referer;
    if (req.contentType) headers['content-type'] = req.contentType;
    const res = await fetch(req.url, { method: req.method ?? 'GET', headers, body: req.body as BodyInit | undefined, redirect: 'follow', signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => (h[k] = v));
    const ms = Date.now() - t0;
    log.push({ url: req.url, status: res.status, ms });
    return toLoaded(req, res.url, res.status, res.headers.get('content-type') ?? '', text, h, ms);
  };
}

export const fixture = (name: string) => readFileSync(FIXTURES + name, 'utf8');

/** Serve one fixture for any request; records the requests made. */
export function replay(name: string, contentType: string, opts: { status?: number; headers?: Record<string, string> } = {}): Fetcher & { reqs: NavRequest[] } {
  const reqs: NavRequest[] = [];
  const f = (async (req: NavRequest) => {
    reqs.push(req);
    return toLoaded(req, req.url, opts.status ?? 200, contentType, fixture(name), opts.headers ?? {}, 1);
  }) as Fetcher & { reqs: NavRequest[] };
  f.reqs = reqs;
  return f;
}
