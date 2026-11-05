// HTTP surfaces: MCP Streamable HTTP (/mcp), REST (/v1/*), health, metrics, run-event SSE.
//
// Stateless by design: an MCP session id is a signed token (see token.ts), so any worker that
// shares the secret can serve any request. Tenancy comes from bearer keys; every runtime session
// id is `${tenant}/${scope}/${name}` where scope is the MCP session's random id or `rest`.

import http from 'node:http';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import cluster from 'node:cluster';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { AwError } from '../types.ts';
import type { RunEvent, RunOptions, RunResult, Runtime, Store, ToolSpec } from '../types.ts';
import { McpCore, ServerError, SUPPORTED_PROTOCOL_VERSIONS, negotiateVersion, parseToolArgs, raceAbort } from './mcp.ts';
import type { CallContext, JsonRpcResponse, McpOptions } from './mcp.ts';
import { SessionTokens, secretBytes } from './token.ts';
import type { SessionClaims } from './token.ts';
import { Limiter } from './limits.ts';
import { Registry, sumMaps } from './metrics.ts';
import type { Snapshot } from './metrics.ts';
import { startPrimary } from './cluster.ts';

export interface HttpOptions extends McpOptions {
  /** HMAC secret for session ids (≥16 bytes). Instances sharing it accept each other's sessions. */
  secret?: string | Uint8Array;
  /** bearer API key -> tenant. Absent: one anonymous tenant, loopback-only unless allowPublicAnonymous. */
  keys?: Record<string, string>;
  /** fork this many workers with node:cluster ('auto' = one per core). Absent: serve in-process. */
  workers?: number | 'auto';
  /** script each worker runs (default: process.argv[1]); it must call createHttpServer().listen() too */
  workerScript?: string;
  workerArgs?: string[];
  workerEnv?: Record<string, string>;
  /** request body cap (default 1 MiB) */
  maxBodyBytes?: number;
  /** per-request run timeout, delivered to the runtime as an AbortSignal (default 120 s) */
  timeoutMs?: number;
  /** per-tenant token bucket on run starts (default: unlimited) */
  rateLimit?: { perSec: number; burst?: number };
  /** per-tenant concurrent runs (default 32; 0 = unlimited) */
  maxConcurrent?: number;
  /** MCP session lifetime (default 7 days) */
  sessionTtlSec?: number;
  /** browser origins allowed to call (exact match, e.g. "https://app.example.com") */
  allowedOrigins?: string[];
  /** extra Host header values accepted when bound to loopback */
  allowedHosts?: string[];
  /** permit binding a non-loopback address without API keys */
  allowPublicAnonymous?: boolean;
  /** if set, /metrics requires `Authorization: Bearer <metricsToken>` */
  metricsToken?: string;
  /** concurrent SSE streams per tenant (default 16) */
  maxStreams?: number;
  /** how long close() waits for in-flight runs before aborting them (default 30 s) */
  drainMs?: number;
  /** shared store for cross-host session revocation (DELETE /mcp); same-cluster revocation needs none */
  store?: Store;
  /** HTTP keep-alive timeout; keep it above your load balancer's idle timeout (default 65 s) */
  keepAliveMs?: number;
}

export interface HttpServer {
  listen(port: number, host?: string): Promise<{ url: string }>;
  close(): Promise<void>;
}

const ANON = 'anon';
const TENANT_RE = /^[A-Za-z0-9._:@+~-]{1,64}$/;
const REVOKED_NS = 'aw:mcp-revoked';
const ROUTES = new Set(['/', '/mcp', '/v1/run', '/v1/tool', '/v1/events', '/healthz', '/metrics']);

export function createHttpServer(runtime: Runtime, opts: HttpOptions = {}): HttpServer {
  const n = opts.workers === 'auto' ? os.availableParallelism() : opts.workers;
  if (n !== undefined && n >= 1 && cluster.isPrimary) return startPrimary(opts, Math.floor(n));
  return createServer(runtime, opts);
}

const isLoopbackHost = (h: string) => h === 'localhost' || h === '[::1]' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);

function hostOnly(h: string): string {
  if (h.startsWith('[')) {
    const i = h.indexOf(']');
    return (i < 0 ? h : h.slice(0, i + 1)).toLowerCase();
  }
  const i = h.indexOf(':');
  return (i < 0 ? h : h.slice(0, i)).toLowerCase();
}

const AW_STATUS: Record<string, number> = {
  bad_request: 400,
  policy: 403,
  too_large: 413,
  unsupported: 422,
  stale: 409,
  gone: 409,
  blocked: 502,
  net: 502,
  timeout: 504,
  internal: 500,
};

interface Stream {
  res: ServerResponse;
  tenant: string;
  kind: 'mcp' | 'events';
  sid?: string;
}

function createServer(runtime: Runtime, opts: HttpOptions): HttpServer {
  const ourWorker = cluster.isWorker && process.env.AGENTWEB_WORKER === '1';
  const nWorkers = ourWorker ? Math.max(1, Number(process.env.AGENTWEB_WORKERS) || 1) : 1;
  const log = opts.log ?? ((l: string) => void process.stderr.write(l + '\n'));

  // ── secret and keys
  let secret: Uint8Array;
  if (ourWorker && process.env.AGENTWEB_SECRET) secret = Buffer.from(process.env.AGENTWEB_SECRET, 'hex');
  else if (opts.secret !== undefined) secret = secretBytes(opts.secret);
  else {
    secret = randomBytes(32);
    if (opts.keys) log('agentweb http: no secret configured; MCP sessions will not survive a restart or be shared between instances');
  }
  const tokens = new SessionTokens(secret, opts.sessionTtlSec ?? 7 * 86400);
  let keyMap: Map<string, string> | undefined;
  if (opts.keys) {
    keyMap = new Map();
    for (const [k, t] of Object.entries(opts.keys)) {
      if (!k) throw new Error('agentweb http: empty API key');
      if (!TENANT_RE.test(t)) throw new Error(`agentweb http: invalid tenant name ${JSON.stringify(t)} (1-64 of A-Z a-z 0-9 . _ : @ + ~ -)`);
      keyMap.set(sha256(k), t);
    }
  }
  const metricsHash = opts.metricsToken ? sha256(opts.metricsToken) : undefined;
  const allowedOrigins = opts.allowedOrigins ? new Set(opts.allowedOrigins) : undefined;
  const allowedHosts = new Set((opts.allowedHosts ?? []).map((h) => h.toLowerCase()));

  // ── limits (split across workers of one cluster; see report for cross-host limits)
  const rl = opts.rateLimit;
  const limiter = new Limiter({
    perSec: rl?.perSec ? rl.perSec / nWorkers : 0,
    burst: rl?.perSec ? Math.max(1, Math.ceil((rl.burst ?? 2 * rl.perSec) / nWorkers)) : undefined,
    concurrent: (opts.maxConcurrent ?? 32) > 0 ? Math.max(1, Math.ceil((opts.maxConcurrent ?? 32) / nWorkers)) : 0,
  });
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const drainMs = opts.drainMs ?? 30_000;
  const maxStreams = opts.maxStreams ?? 16;

  const core = new McpCore(runtime, { ...opts, log });
  const reg = new Registry()
    .define('agentweb_http_requests_total', 'counter', 'HTTP requests by route and status')
    .define('agentweb_http_request_duration_seconds', 'histogram', 'HTTP request latency by route')
    .define('agentweb_runs_total', 'counter', 'runtime.run calls by surface and outcome (ok, fail, error)')
    .define('agentweb_run_duration_seconds', 'histogram', 'runtime.run latency')
    .define('agentweb_runs_rejected_total', 'counter', 'runs refused by admission control')
    .define('agentweb_runs_aborted_total', 'counter', 'runs aborted by timeout, disconnect or shutdown')
    .define('agentweb_runs_inflight', 'gauge', 'runs currently executing')
    .define('agentweb_auth_failures_total', 'counter', 'requests with a missing or wrong API key')
    .define('agentweb_mcp_sessions_issued_total', 'counter', 'MCP sessions created')
    .define('agentweb_mcp_sessions_rejected_total', 'counter', 'requests with an invalid, expired or ended session id')
    .define('agentweb_sse_streams', 'gauge', 'open SSE streams')
    .define('agentweb_workers', 'gauge', 'worker processes reporting')
    .define('agentweb_process_resident_memory_bytes', 'gauge', 'resident set size, summed over workers')
    .define('agentweb_draining', 'gauge', 'workers draining for shutdown');

  // ── state
  const revoked = new Map<string, number>(); // session rid -> expiry (ms)
  const streams = new Set<Stream>();
  const streamsPerTenant = new Map<string, number>();
  const runs = new Set<Promise<unknown>>();
  const controllers = new Set<AbortController>();
  let inflightRuns = 0;
  let draining = false;
  let loopback = true;
  let server: http.Server | undefined;
  let keepalive: NodeJS.Timeout | undefined;
  let clusterInterest = 0; // event-stream clients across the cluster
  let eventClients = 0; // local
  let metricsReq = 0;
  const metricsWaiters = new Map<number, (m: { snaps: Snapshot[]; rts: Record<string, number>[] }) => void>();

  // ── runtime events → SSE (and to sibling workers when someone there is listening)
  const unsubscribe = runtime.subscribe((e) => {
    deliver(e);
    if (ourWorker && clusterInterest - eventClients > 0) sendIpc({ aw: 'ev', e });
  });

  function deliver(e: RunEvent) {
    if (!eventClients) return;
    let data: string | undefined;
    for (const s of streams) {
      if (s.kind !== 'events' || !visible(s.tenant, e)) continue;
      data ??= `event: run\ndata: ${JSON.stringify(e)}\n\n`;
      writeStream(s, data);
    }
  }
  const visible = (tenant: string, e: RunEvent) =>
    !keyMap || e.tenant === tenant || (e.tenant === undefined && typeof e.session === 'string' && e.session.startsWith(tenant + '/'));

  function writeStream(s: Stream, data: string) {
    if (s.res.destroyed) return;
    // Slow consumer: drop it rather than buffer without bound.
    if (s.res.writableLength > 1024 * 1024) {
      s.res.destroy();
      return;
    }
    s.res.write(data);
  }

  // ── cluster IPC (worker side)
  function sendIpc(m: unknown) {
    if (ourWorker && process.send && process.connected) {
      try {
        process.send(m);
      } catch {
        /* channel closing */
      }
    }
  }
  const onIpc = (m: unknown) => {
    if (!m || typeof m !== 'object') return;
    const msg = m as Record<string, unknown>;
    switch (msg.aw) {
      case 'ev':
        deliver(msg.e as RunEvent);
        break;
      case 'interest':
        clusterInterest = Number(msg.total) || 0;
        break;
      case 'revoke':
        revokeLocal(String(msg.id), Number(msg.exp));
        break;
      case 'metrics!':
        sendIpc({ aw: 'metrics=', req: msg.req, snap: localSnapshot(), rt: safeMetrics() });
        break;
      case 'metrics+': {
        const w = metricsWaiters.get(Number(msg.req));
        if (w) {
          metricsWaiters.delete(Number(msg.req));
          w({ snaps: msg.snaps as Snapshot[], rts: msg.rts as Record<string, number>[] });
        }
        break;
      }
      case 'shutdown':
        close()
          .then(() => runtime.close())
          .catch((e) => log(`agentweb worker: shutdown error: ${e instanceof Error ? e.message : e}`))
          .finally(() => process.exit(0));
        break;
    }
  };
  if (ourWorker) process.on('message', onIpc);

  function setEventClients(delta: number) {
    eventClients += delta;
    if (ourWorker) sendIpc({ aw: 'interest', n: eventClients });
  }

  // ── sessions
  function revokeLocal(id: string, exp: number) {
    revoked.set(id, exp);
    if (revoked.size % 1024 === 0) {
      const now = Date.now();
      for (const [k, v] of revoked) if (v <= now) revoked.delete(k);
    }
    for (const s of streams) if (s.sid === id) s.res.end();
  }

  async function validSession(token: string | undefined, tenant: string): Promise<SessionClaims | undefined> {
    const c = tokens.verify(token);
    if (!c || c.tenant !== tenant) return undefined;
    const exp = revoked.get(c.id);
    if (exp !== undefined && exp > Date.now()) return undefined;
    if (opts.store) {
      try {
        if (await opts.store.get(REVOKED_NS, c.id)) return undefined;
      } catch (e) {
        log(`agentweb http: revocation lookup failed (allowing): ${e instanceof Error ? e.message : e}`);
      }
    }
    return c;
  }

  // ── auth / origin
  function authenticate(req: IncomingMessage): string | undefined {
    if (!keyMap) return ANON;
    const key = bearer(req) ?? headerStr(req, 'x-api-key');
    return key ? keyMap.get(sha256(key)) : undefined;
  }

  function originOk(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (origin !== undefined && allowedOrigins?.has(origin)) return true;
    if (loopback) {
      const host = req.headers.host;
      if (host !== undefined) {
        const h = hostOnly(host);
        if (!isLoopbackHost(h) && !allowedHosts.has(h)) return false;
      }
      if (origin !== undefined) {
        try {
          const u = new URL(origin);
          return isLoopbackHost(u.hostname.toLowerCase()) || allowedHosts.has(u.hostname.toLowerCase());
        } catch {
          return false; // "null" and other opaque origins
        }
      }
      return true;
    }
    return origin === undefined || !allowedOrigins;
  }

  // ── responses
  interface Rq {
    route: string;
    t0: number;
  }
  function finish(rq: Rq, status: number) {
    reg.inc('agentweb_http_requests_total', { route: rq.route, code: String(status) });
    reg.observe('agentweb_http_request_duration_seconds', { route: rq.route }, (performance.now() - rq.t0) / 1000);
  }
  function send(rq: Rq, res: ServerResponse, status: number, body: string, type = 'application/json', extra?: OutgoingHttpHeaders) {
    finish(rq, status);
    if (res.headersSent || res.destroyed) return;
    const headers: OutgoingHttpHeaders = { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extra };
    if (draining) headers.connection = 'close';
    res.writeHead(status, headers);
    res.end(body);
  }
  const json = (rq: Rq, res: ServerResponse, status: number, v: unknown, extra?: OutgoingHttpHeaders) => send(rq, res, status, JSON.stringify(v), 'application/json', extra);
  /** REST error body */
  const restErr = (rq: Rq, res: ServerResponse, status: number, code: string, message: string, extra?: OutgoingHttpHeaders, hint?: string) =>
    json(rq, res, status, { ok: false, error: hint ? { code, message, hint } : { code, message } }, extra);
  /** MCP transport-level error body (JSON-RPC error with null id) */
  const rpcErr = (rq: Rq, res: ServerResponse, status: number, message: string, extra?: OutgoingHttpHeaders, code = -32000) =>
    json(rq, res, status, { jsonrpc: '2.0', id: null, error: { code, message } }, extra);

  const UNAUTH = { 'www-authenticate': 'Bearer realm="agentweb"' };

  function readBody(rq: Rq, req: IncomingMessage, res: ServerResponse, mcp: boolean): Promise<string | undefined> {
    const tooLarge = () => {
      const m = `request body larger than ${maxBody} bytes`;
      const extra = { connection: 'close' };
      if (mcp) rpcErr(rq, res, 413, m, extra);
      else restErr(rq, res, 413, 'too_large', m, extra);
    };
    const cl = req.headers['content-length'];
    if (cl !== undefined && Number(cl) > maxBody) {
      tooLarge();
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on('data', (c: Buffer) => {
        if (done) return;
        size += c.length;
        if (size > maxBody) {
          done = true;
          req.pause();
          tooLarge();
          resolve(undefined);
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        resolve(chunks.length === 1 ? chunks[0].toString('utf8') : Buffer.concat(chunks, size).toString('utf8'));
      });
      req.on('error', () => {
        if (!done) {
          done = true;
          resolve(undefined);
        }
      });
    });
  }

  // ── runs
  function gated(tenant: string, surface: 'mcp' | 'rest', session: string, program: string, ro: RunOptions): Promise<RunResult> {
    try {
      limiter.admit(tenant);
    } catch (e) {
      reg.inc('agentweb_runs_rejected_total', { reason: e instanceof ServerError ? e.code : 'other' });
      return Promise.reject(e);
    }
    if (draining) {
      limiter.release(tenant);
      return Promise.reject(new ServerError('unavailable', 503, 'the server is shutting down', 'retry; another worker will take the call'));
    }
    inflightRuns++;
    const t = performance.now();
    let p: Promise<RunResult>;
    try {
      p = Promise.resolve(runtime.run(session, program, ro));
    } catch (e) {
      p = Promise.reject(e);
    }
    const outcome = (o: string) => {
      reg.inc('agentweb_runs_total', { surface, outcome: o });
      reg.observe('agentweb_run_duration_seconds', undefined, (performance.now() - t) / 1000);
    };
    const tracked: Promise<RunResult> = p
      .then(
        (r) => {
          outcome(r && r.ok ? 'ok' : 'fail');
          return r;
        },
        (e) => {
          outcome('error');
          throw e;
        },
      )
      .finally(() => {
        limiter.release(tenant);
        inflightRuns--;
        runs.delete(tracked);
      });
    runs.add(tracked);
    return tracked;
  }

  function requestSignal(res: ServerResponse) {
    const ac = new AbortController();
    controllers.add(ac);
    const timer = setTimeout(() => {
      reg.inc('agentweb_runs_aborted_total', { reason: 'timeout' });
      ac.abort(new AwError('timeout', `the call ran longer than ${Math.round(timeoutMs / 100) / 10}s and was stopped`, 'split the work into smaller programs'));
    }, timeoutMs);
    const onClose = () => {
      if (!res.writableFinished && !ac.signal.aborted) {
        reg.inc('agentweb_runs_aborted_total', { reason: 'disconnect' });
        ac.abort(new ServerError('cancelled', 499, 'the client disconnected'));
      }
    };
    res.on('close', onClose);
    return {
      signal: ac.signal,
      cleanup() {
        clearTimeout(timer);
        res.off('close', onClose);
        controllers.delete(ac);
      },
    };
  }

  const forkRef = (tenant: string, scope: string, ref: string) => (ref.includes('/') ? `${tenant}/${ref}` : `${tenant}/${scope}/${ref}`);

  // ── handlers
  async function restRun(rq: Rq, req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') return send(rq, res, 405, '', 'text/plain', { allow: 'POST' });
    const tenant = authenticate(req);
    if (!tenant) {
      reg.inc('agentweb_auth_failures_total');
      return restErr(rq, res, 401, 'unauthorized', 'missing or invalid API key: send Authorization: Bearer <key>', UNAUTH);
    }
    if (!isJson(req)) return restErr(rq, res, 415, 'bad_request', 'Content-Type must be application/json');
    const body = await readBody(rq, req, res, false);
    if (body === undefined) return;
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return restErr(rq, res, 400, 'bad_request', 'body is not valid JSON; send {"run": "<program>", "session": "<name>"}');
    }
    const parsed = parseToolArgs(input, core.tool());
    if (!parsed.ok) return restErr(rq, res, 400, 'bad_request', parsed.message);
    const { run, session, budget, fork } = parsed.args;
    const sig = requestSignal(res);
    try {
      const ro: RunOptions = { tenant, signal: sig.signal };
      if (budget !== undefined) ro.budget = budget;
      if (fork !== undefined) ro.fork = forkRef(tenant, 'rest', fork);
      const r = await raceAbort(() => gated(tenant, 'rest', `${tenant}/rest/${session}`, run, ro), sig.signal);
      const out: Record<string, unknown> = { ok: !!r.ok, text: r.text, stats: r.stats, session };
      if (r.images?.length) out.images = r.images;
      json(rq, res, 200, out);
    } catch (e) {
      sendRunError(rq, res, e);
    } finally {
      sig.cleanup();
    }
  }

  function sendRunError(rq: Rq, res: ServerResponse, e: unknown) {
    if (e instanceof ServerError) {
      const extra = e.retryAfterSec ? { 'retry-after': String(e.retryAfterSec) } : undefined;
      return restErr(rq, res, e.status, e.code, e.message, extra, e.hint);
    }
    if (e instanceof AwError) return restErr(rq, res, AW_STATUS[e.code] ?? 500, e.code, e.message, undefined, e.hint);
    log(`agentweb http: run failed: ${e instanceof Error ? e.stack || e.message : String(e)}`);
    return restErr(rq, res, 500, 'internal', 'the server failed while running this program');
  }

  async function mcpPost(rq: Rq, req: IncomingMessage, res: ServerResponse, tenant: string) {
    if (!isJson(req)) return rpcErr(rq, res, 415, 'Unsupported Media Type: Content-Type must be application/json');
    const body = await readBody(rq, req, res, true);
    if (body === undefined) return;
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return rpcErr(rq, res, 400, 'Parse error: body is not valid JSON', undefined, -32700);
    }
    const msgs = Array.isArray(payload) ? payload : [payload];
    const init = msgs.find((m) => m && typeof m === 'object' && (m as { method?: unknown }).method === 'initialize' && 'id' in m) as
      | { id: unknown; params?: { protocolVersion?: unknown } }
      | undefined;
    let claims: SessionClaims;
    let newToken: string | undefined;
    if (init) {
      const issued = tokens.issue(tenant, negotiateVersion(init.params?.protocolVersion));
      newToken = issued.token;
      claims = issued.claims;
    } else {
      const sid = headerStr(req, 'mcp-session-id');
      if (!sid) return rpcErr(rq, res, 400, 'Bad Request: Mcp-Session-Id header is required; send initialize first');
      const c = await validSession(sid, tenant);
      if (!c) {
        reg.inc('agentweb_mcp_sessions_rejected_total');
        return rpcErr(rq, res, 404, 'Session not found: it expired or was ended; send initialize to start a new one', undefined, -32001);
      }
      claims = c;
      const pv = headerStr(req, 'mcp-protocol-version');
      if (pv !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) {
        return rpcErr(rq, res, 400, `Bad Request: unsupported MCP-Protocol-Version ${JSON.stringify(pv)}; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`);
      }
    }
    const sig = McpCore.countCalls(payload) ? requestSignal(res) : undefined;
    const id = claims.id;
    const ctx: CallContext = {
      conn: id,
      tenant,
      sessionId: (name) => `${tenant}/${id}/${name}`,
      forkId: (ref) => forkRef(tenant, id, ref),
      signal: sig?.signal,
      run: (s, p, o) => gated(tenant, 'mcp', s, p, o),
    };
    let out: JsonRpcResponse | JsonRpcResponse[] | undefined;
    try {
      out = await core.handle(payload, ctx);
    } finally {
      sig?.cleanup();
    }
    const extra: OutgoingHttpHeaders = {};
    if (newToken && initSucceeded(out, init!.id)) {
      extra['mcp-session-id'] = newToken;
      reg.inc('agentweb_mcp_sessions_issued_total');
    }
    if (out === undefined) return send(rq, res, 202, '', 'text/plain', extra);
    const accept = headerStr(req, 'accept') ?? '';
    if (accept.includes('text/event-stream') && !accept.includes('application/json') && !accept.includes('*/*')) {
      return send(rq, res, 200, `event: message\ndata: ${JSON.stringify(out)}\n\n`, 'text/event-stream', extra);
    }
    json(rq, res, 200, out, extra);
  }

  async function mcpSession(rq: Rq, req: IncomingMessage, res: ServerResponse, tenant: string): Promise<SessionClaims | undefined> {
    const sid = headerStr(req, 'mcp-session-id');
    if (!sid) {
      rpcErr(rq, res, 400, 'Bad Request: Mcp-Session-Id header is required');
      return undefined;
    }
    const c = await validSession(sid, tenant);
    if (!c) {
      reg.inc('agentweb_mcp_sessions_rejected_total');
      rpcErr(rq, res, 404, 'Session not found', undefined, -32001);
    }
    return c;
  }

  async function mcp(rq: Rq, req: IncomingMessage, res: ServerResponse) {
    const m = req.method;
    if (m !== 'POST' && m !== 'GET' && m !== 'DELETE') return send(rq, res, 405, '', 'text/plain', { allow: 'POST, GET, DELETE' });
    const tenant = authenticate(req);
    if (!tenant) {
      reg.inc('agentweb_auth_failures_total');
      return rpcErr(rq, res, 401, 'Unauthorized: missing or invalid API key', UNAUTH);
    }
    if (m === 'POST') return mcpPost(rq, req, res, tenant);
    if (m === 'GET') {
      if (!(headerStr(req, 'accept') ?? '').includes('text/event-stream')) return send(rq, res, 405, '', 'text/plain', { allow: 'POST, DELETE' });
      const c = await mcpSession(rq, req, res, tenant);
      if (!c) return;
      return openStream(rq, res, { tenant, kind: 'mcp', sid: c.id });
    }
    const c = await mcpSession(rq, req, res, tenant);
    if (!c) return;
    const expMs = Date.now() + tokens.remaining(c.iat) * 1000;
    revokeLocal(c.id, expMs);
    sendIpc({ aw: 'revoke', id: c.id, exp: expMs });
    if (opts.store) {
      try {
        await opts.store.set(REVOKED_NS, c.id, 1, Math.max(1, tokens.remaining(c.iat)));
      } catch (e) {
        log(`agentweb http: revocation store write failed: ${e instanceof Error ? e.message : e}`);
      }
    }
    send(rq, res, 204, '', 'text/plain');
  }

  function openStream(rq: Rq, res: ServerResponse, s: Omit<Stream, 'res'>) {
    const n = streamsPerTenant.get(s.tenant) ?? 0;
    if (n >= maxStreams) return json(rq, res, 429, { ok: false, error: { code: 'busy', message: `too many open streams (limit ${maxStreams})` } }, { 'retry-after': '5' });
    finish(rq, 200);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': agentweb\n\n');
    const st: Stream = { ...s, res };
    streams.add(st);
    streamsPerTenant.set(s.tenant, n + 1);
    if (s.kind === 'events') setEventClients(1);
    keepalive ??= setInterval(() => {
      for (const x of streams) writeStream(x, ': ping\n\n');
    }, 20_000).unref();
    res.on('close', () => {
      if (!streams.delete(st)) return;
      streamsPerTenant.set(s.tenant, (streamsPerTenant.get(s.tenant) ?? 1) - 1);
      if (s.kind === 'events') setEventClients(-1);
      if (!streams.size && keepalive) {
        clearInterval(keepalive);
        keepalive = undefined;
      }
    });
  }

  function toolDoc(rq: Rq, res: ServerResponse, query: string) {
    const format = new URLSearchParams(query).get('format') ?? 'mcp';
    const t = core.tool();
    const doc = toolFormats(t)[format];
    if (!doc) return restErr(rq, res, 400, 'bad_request', `unknown format ${JSON.stringify(format)}; use one of ${Object.keys(toolFormats(t)).join(', ')}`);
    json(rq, res, 200, doc);
  }

  function localSnapshot(): Snapshot {
    reg.set('agentweb_runs_inflight', undefined, inflightRuns);
    reg.set('agentweb_sse_streams', undefined, streams.size);
    reg.set('agentweb_workers', undefined, 1);
    reg.set('agentweb_process_resident_memory_bytes', undefined, process.memoryUsage.rss());
    reg.set('agentweb_draining', undefined, draining ? 1 : 0);
    return reg.snapshot();
  }
  function safeMetrics(): Record<string, number> {
    try {
      return runtime.metrics() ?? {};
    } catch {
      return {};
    }
  }

  async function metrics(rq: Rq, req: IncomingMessage, res: ServerResponse) {
    if (metricsHash) {
      const k = bearer(req);
      if (!k || sha256(k) !== metricsHash) {
        reg.inc('agentweb_auth_failures_total');
        return send(rq, res, 401, 'unauthorized\n', 'text/plain', UNAUTH);
      }
    } else if (keyMap && !authenticate(req)) {
      reg.inc('agentweb_auth_failures_total');
      return send(rq, res, 401, 'unauthorized\n', 'text/plain', UNAUTH);
    }
    let snaps = [localSnapshot()];
    let rts = [safeMetrics()];
    if (ourWorker && nWorkers > 1) {
      const req = ++metricsReq;
      const got = await new Promise<{ snaps: Snapshot[]; rts: Record<string, number>[] } | undefined>((resolve) => {
        const timer = setTimeout(() => {
          metricsWaiters.delete(req);
          resolve(undefined);
        }, 2000);
        metricsWaiters.set(req, (v) => {
          clearTimeout(timer);
          resolve(v);
        });
        sendIpc({ aw: 'metrics?', req });
      });
      if (got && got.snaps.length) {
        snaps = got.snaps;
        rts = got.rts;
      }
    }
    send(rq, res, 200, reg.render(Registry.merge(snaps), sumMaps(rts)), 'text/plain; version=0.0.4; charset=utf-8');
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const path = q < 0 ? url : url.slice(0, q);
    const query = q < 0 ? '' : url.slice(q + 1);
    const rq: Rq = { route: ROUTES.has(path) ? path : 'other', t0: performance.now() };
    if (!originOk(req)) return restErr(rq, res, 403, 'forbidden', 'origin not allowed');
    if (draining && path !== '/healthz' && path !== '/metrics') {
      return restErr(rq, res, 503, 'unavailable', 'the server is shutting down', { 'retry-after': '1' });
    }
    switch (path) {
      case '/mcp':
        return mcp(rq, req, res);
      case '/v1/run':
        return restRun(rq, req, res);
      case '/v1/tool':
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(rq, res, 405, '', 'text/plain', { allow: 'GET' });
        return toolDoc(rq, res, query);
      case '/v1/events': {
        if (req.method !== 'GET') return send(rq, res, 405, '', 'text/plain', { allow: 'GET' });
        const tenant = authenticate(req);
        if (!tenant) {
          reg.inc('agentweb_auth_failures_total');
          return restErr(rq, res, 401, 'unauthorized', 'missing or invalid API key', UNAUTH);
        }
        return openStream(rq, res, { tenant, kind: 'events' });
      }
      case '/healthz':
        return json(rq, res, draining ? 503 : 200, { ok: !draining, draining, inflight: inflightRuns, pid: process.pid });
      case '/metrics':
        return metrics(rq, req, res);
      case '/':
        if (req.method !== 'GET') return send(rq, res, 405, '', 'text/plain', { allow: 'GET' });
        return json(rq, res, 200, {
          name: opts.serverName ?? 'agentweb',
          tool: core.tool().name,
          mcp: '/mcp',
          rest: { run: 'POST /v1/run {"run": "<program>", "session": "<name>"}', tool: 'GET /v1/tool?format=mcp|openai|anthropic|gemini' },
          auth: keyMap ? 'Authorization: Bearer <key>' : 'none (loopback)',
        });
      default:
        return restErr(rq, res, 404, 'not_found', `no route ${path}`);
    }
  }

  // ── lifecycle
  let closing: Promise<void> | undefined;
  async function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      draining = true;
      if (ourWorker) process.off('message', onIpc);
      const closed = server ? new Promise<void>((r) => server!.close(() => r())) : Promise.resolve();
      server?.closeIdleConnections();
      for (const s of streams) s.res.end();
      if (runs.size) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.allSettled([...runs]), new Promise((r) => (timer = setTimeout(r, drainMs)))]);
        clearTimeout(timer);
      }
      if (runs.size || controllers.size) {
        for (const ac of controllers) {
          reg.inc('agentweb_runs_aborted_total', { reason: 'shutdown' });
          ac.abort(new ServerError('unavailable', 503, 'the server shut down before the call finished', 'retry the call'));
        }
        // let the aborted responses flush, and give the runtime a moment to honour the signal
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([Promise.allSettled([...runs]), new Promise((r) => (timer = setTimeout(r, 1000)))]);
        clearTimeout(timer);
        await new Promise((r) => setImmediate(r));
      }
      server?.closeAllConnections();
      await closed;
      if (keepalive) clearInterval(keepalive);
      unsubscribe();
    })();
    return closing;
  }

  return {
    async listen(port: number, host?: string) {
      if (ourWorker && process.env.AGENTWEB_PORT) {
        port = Number(process.env.AGENTWEB_PORT);
        host = process.env.AGENTWEB_HOST || host;
      }
      host ??= '127.0.0.1';
      loopback = isLoopbackHost(host.toLowerCase());
      if (!loopback && !keyMap && !opts.allowPublicAnonymous) {
        throw new Error(`agentweb http: refusing to bind ${host} without API keys; pass keys, bind 127.0.0.1, or set allowPublicAnonymous`);
      }
      const srv = http.createServer({ keepAliveTimeout: opts.keepAliveMs ?? 65_000, headersTimeout: 20_000, requestTimeout: 60_000 }, (req, res) => {
        onRequest(req, res).catch((e) => {
          log(`agentweb http: ${e instanceof Error ? e.stack || e.message : String(e)}`);
          if (!res.headersSent) send({ route: 'other', t0: performance.now() }, res, 500, '{"ok":false,"error":{"code":"internal","message":"internal error"}}');
          else res.destroy();
        });
      });
      server = srv;
      await new Promise<void>((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, host, () => {
          srv.off('error', reject);
          resolve();
        });
      });
      const a = srv.address();
      const p = typeof a === 'object' && a ? a.port : port;
      const h = host.includes(':') ? `[${host}]` : host === '0.0.0.0' ? '127.0.0.1' : host;
      return { url: `http://${h}:${p}` };
    },
    close,
  };
}

// ───────────────────────────── helpers ─────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function headerStr(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  if (!h) return undefined;
  const m = /^Bearer[ \t]+(\S+)\s*$/i.exec(h);
  return m ? m[1] : undefined;
}

function isJson(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'];
  return !!ct && /^\s*application\/([\w.+-]+\+)?json\s*(;|$)/i.test(ct);
}

function initSucceeded(out: JsonRpcResponse | JsonRpcResponse[] | undefined, id: unknown): boolean {
  if (!out) return false;
  const list = Array.isArray(out) ? out : [out];
  return list.some((r) => r.id === id && 'result' in r);
}

/** The one tool, in each vendor's function-calling shape. */
export function toolFormats(t: ToolSpec): Record<string, unknown> {
  return {
    mcp: { name: t.name, description: t.description, inputSchema: t.inputSchema },
    openai: { type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } },
    'openai-responses': { type: 'function', name: t.name, description: t.description, parameters: t.inputSchema },
    anthropic: { name: t.name, description: t.description, input_schema: t.inputSchema },
    gemini: { name: t.name, description: t.description, parameters: t.inputSchema },
  };
}

