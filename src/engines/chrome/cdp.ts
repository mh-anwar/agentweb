// Chrome DevTools Protocol client with no dependencies.
//
// Two transports:
//   pipe       for browsers we launch with --remote-debugging-pipe: we write to the child's fd 3 and
//              read from its fd 4; messages are JSON separated by a NUL byte.
//   WebSocket  for a browser somebody else runs, given as ws://… or as http://host:port (the
//              browser-level socket is discovered through /json/version).
//
// Sessions are "flattened": every message for a target carries a `sessionId`, so one connection
// serves the browser and all of its pages. Events are routed by (sessionId, method).

import type { Readable, Writable } from 'node:stream';
import { AwError, type ErrCode } from '../../types.ts';

/** A CDP call that the browser answered with an error, or that could not be delivered. */
export class CdpError extends AwError {
  method: string;
  /** JSON-RPC error code from the browser, when there was one */
  cdpCode?: number;
  /** the execution context / document the call was aimed at is gone (the page navigated) */
  contextLost: boolean;
  constructor(code: ErrCode, message: string, method: string, cdpCode?: number, contextLost = false) {
    super(code, message);
    this.name = 'CdpError';
    this.method = method;
    this.cdpCode = cdpCode;
    this.contextLost = contextLost;
  }
}

const CONTEXT_LOST = /Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed|Cannot find default execution context|uniqueContextId not found|Frame with the given id was not found|Internal error: Frame/i;
const TARGET_GONE = /Session with given id not found|Target closed|No target with given id|Not attached to an active page|No session with given id|Target crashed|Failed to find browser context|No browser context with the given id/i;
const NODE_GONE = /Could not find node with given id|No node with given id|Node is detached|Could not find object with given id|Node does not have a layout object|Invalid remote object id/i;

/** Map a protocol error message to the error an agent (or the pool) can act on. */
export function mapCdpError(method: string, message: string, cdpCode?: number): CdpError {
  if (CONTEXT_LOST.test(message)) return new CdpError('internal', `${method}: page context changed (${message})`, method, cdpCode, true);
  if (TARGET_GONE.test(message)) return new CdpError('gone', `${method}: the page is gone (${message})`, method, cdpCode);
  if (NODE_GONE.test(message)) return new CdpError('stale', `${method}: the element no longer exists`, method, cdpCode);
  return new CdpError('internal', `${method}: ${message}`, method, cdpCode);
}

export function isContextLost(e: unknown): boolean {
  return e instanceof CdpError && e.contextLost;
}

export interface Transport {
  send(text: string): void;
  close(): void;
  onMessage: (text: string) => void;
  onClose: (reason: string) => void;
}

type Handler = (params: any, sessionId: string) => void;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  method: string;
  sessionId: string;
  timer: NodeJS.Timeout | undefined;
}

export interface SendOptions {
  sessionId?: string;
  /** reject with AwError('timeout') when the browser has not answered in this many ms (0 = wait forever) */
  timeoutMs?: number;
}

export class Cdp {
  /** used when a call does not give its own timeout */
  defaultTimeoutMs = 30_000;
  closed = false;
  closeReason = '';
  /** messages sent / received, for stats */
  sent = 0;
  received = 0;

  private transport: Transport;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<Handler>>();
  private closeHandlers = new Set<(reason: string) => void>();

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onMessage = (text) => this.dispatch(text);
    transport.onClose = (reason) => this.shutdown(reason);
  }

  send<T = any>(method: string, params?: Record<string, unknown>, opts?: SendOptions): Promise<T> {
    const sessionId = opts?.sessionId ?? '';
    if (this.closed) return Promise.reject(new CdpError('gone', `${method}: browser connection closed (${this.closeReason})`, method));
    const id = this.nextId++;
    const msg: Record<string, unknown> = { id, method };
    if (params) msg.params = params;
    if (sessionId) msg.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      const ms = opts?.timeoutMs ?? this.defaultTimeoutMs;
      const timer = ms > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new CdpError('timeout', `${method}: no answer from the browser in ${Math.round(ms)} ms`, method));
          }, ms)
        : undefined;
      this.pending.set(id, { resolve, reject, method, sessionId, timer });
      try {
        this.transport.send(JSON.stringify(msg));
        this.sent++;
      } catch (e) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new CdpError('gone', `${method}: could not write to the browser (${(e as Error).message})`, method));
      }
    });
  }

  /** Subscribe to an event. `sessionId` '' is the browser session. Returns an unsubscribe function. */
  on(event: string, fn: Handler, sessionId = ''): () => void {
    const key = sessionId + '\n' + event;
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(fn);
    return () => {
      const s = this.handlers.get(key);
      if (!s) return;
      s.delete(fn);
      if (!s.size) this.handlers.delete(key);
    };
  }

  /** Resolve with the next matching event; reject with AwError('timeout') after `timeoutMs`. */
  once<T = any>(event: string, opts?: { sessionId?: string; timeoutMs?: number; where?: (params: T) => boolean }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const off = this.on(event, (p) => {
        if (opts?.where && !opts.where(p)) return;
        off();
        offClose();
        if (timer) clearTimeout(timer);
        resolve(p);
      }, opts?.sessionId ?? '');
      const offClose = this.onClose((reason) => {
        off();
        if (timer) clearTimeout(timer);
        reject(new CdpError('gone', `browser connection closed while waiting for ${event} (${reason})`, event));
      });
      if (opts?.timeoutMs) {
        timer = setTimeout(() => {
          off();
          offClose();
          reject(new CdpError('timeout', `${event} did not arrive in ${opts.timeoutMs} ms`, event));
        }, opts.timeoutMs);
      }
    });
  }

  /** A view of this connection bound to one target session. */
  session(sessionId: string): CdpSession {
    return new CdpSession(this, sessionId);
  }

  /** Forget a detached session: drop its listeners and fail its in-flight calls. */
  dropSession(sessionId: string, reason = 'target detached'): void {
    if (!sessionId) return;
    const prefix = sessionId + '\n';
    for (const key of [...this.handlers.keys()]) if (key.startsWith(prefix)) this.handlers.delete(key);
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new CdpError('gone', `${p.method}: the page is gone (${reason})`, p.method));
    }
  }

  onClose(fn: (reason: string) => void): () => void {
    if (this.closed) {
      queueMicrotask(() => fn(this.closeReason));
      return () => {};
    }
    this.closeHandlers.add(fn);
    return () => this.closeHandlers.delete(fn);
  }

  close(reason = 'closed by client'): void {
    if (this.closed) return;
    try {
      this.transport.close();
    } catch {}
    this.shutdown(reason);
  }

  get inFlight(): number {
    return this.pending.size;
  }

  private dispatch(text: string): void {
    let m: any;
    try {
      m = JSON.parse(text);
    } catch {
      return; // a torn message can only mean the browser is dying; the close handler deals with it
    }
    this.received++;
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return; // answered after its timeout
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(mapCdpError(p.method, String(m.error.message ?? 'unknown error') + (m.error.data ? ` ${m.error.data}` : ''), m.error.code));
      else p.resolve(m.result);
      return;
    }
    if (typeof m.method !== 'string') return;
    const sid: string = m.sessionId ?? '';
    const set = this.handlers.get(sid + '\n' + m.method);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(m.params ?? {}, sid);
      } catch {
        // a listener must never take the connection down
      }
    }
  }

  private shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    const pending = [...this.pending.values()];
    this.pending.clear();
    this.handlers.clear();
    for (const p of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new CdpError('gone', `${p.method}: browser connection closed (${reason})`, p.method));
    }
    const hs = [...this.closeHandlers];
    this.closeHandlers.clear();
    for (const h of hs) {
      try {
        h(reason);
      } catch {}
    }
  }
}

export class CdpSession {
  readonly cdp: Cdp;
  readonly id: string;
  constructor(cdp: Cdp, id: string) {
    this.cdp = cdp;
    this.id = id;
  }
  send<T = any>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    return this.cdp.send<T>(method, params, { sessionId: this.id, timeoutMs });
  }
  on(event: string, fn: (params: any) => void): () => void {
    return this.cdp.on(event, fn, this.id);
  }
  once<T = any>(event: string, opts?: { timeoutMs?: number; where?: (params: T) => boolean }): Promise<T> {
    return this.cdp.once<T>(event, { ...opts, sessionId: this.id });
  }
}

// ───────────────────────────── transports ─────────────────────────────

/** NUL-delimited JSON over the two extra pipes of a browser started with --remote-debugging-pipe. */
export function pipeTransport(toBrowser: Writable, fromBrowser: Readable): Transport {
  let parts: Buffer[] = [];
  let closed = false;
  const t: Transport = {
    onMessage: () => {},
    onClose: () => {},
    send(text) {
      if (closed) throw new Error('pipe closed');
      toBrowser.write(text + '\0');
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        toBrowser.end();
      } catch {}
      try {
        fromBrowser.destroy();
      } catch {}
    },
  };
  const end = (reason: string) => {
    if (closed) return;
    closed = true;
    t.onClose(reason);
  };
  fromBrowser.on('data', (chunk: Buffer) => {
    let start = 0;
    for (;;) {
      const nul = chunk.indexOf(0, start);
      if (nul === -1) {
        if (start < chunk.length) parts.push(start ? chunk.subarray(start) : chunk);
        return;
      }
      const piece = chunk.subarray(start, nul);
      const text = parts.length ? Buffer.concat([...parts, piece]).toString('utf8') : piece.toString('utf8');
      parts = [];
      start = nul + 1;
      if (text) t.onMessage(text);
    }
  });
  fromBrowser.on('end', () => end('browser closed the pipe'));
  fromBrowser.on('close', () => end('browser closed the pipe'));
  fromBrowser.on('error', (e) => end(`pipe read error: ${e.message}`));
  toBrowser.on('error', (e) => end(`pipe write error: ${e.message}`));
  return t;
}

/** Resolve `ws://…` (used as is) or `http://host:port` (asks /json/version) to the browser socket URL. */
export async function resolveEndpoint(endpoint: string, timeoutMs = 10_000): Promise<string> {
  if (/^wss?:\/\//i.test(endpoint)) return endpoint;
  if (!/^https?:\/\//i.test(endpoint)) throw new AwError('bad_request', `browser endpoint must be ws:// or http://, got ${endpoint}`);
  const base = new URL(endpoint);
  let info: any;
  try {
    const res = await fetch(new URL('/json/version', base), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    info = await res.json();
  } catch (e) {
    throw new AwError('net', `no browser answered at ${base.origin}/json/version (${(e as Error).message})`, 'start Chrome with --remote-debugging-port, or give the ws:// URL');
  }
  const raw = info && typeof info.webSocketDebuggerUrl === 'string' ? info.webSocketDebuggerUrl : '';
  if (!raw) throw new AwError('net', `${base.origin}/json/version has no webSocketDebuggerUrl`);
  // The browser reports the address it thinks it has (often localhost); keep the one that reached it.
  const ws = new URL(raw);
  ws.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.host = base.host;
  return ws.toString();
}

export async function wsTransport(url: string, timeoutMs = 10_000): Promise<Transport> {
  const WS = (globalThis as any).WebSocket;
  if (typeof WS !== 'function') throw new AwError('unsupported', 'this Node has no global WebSocket (need Node 22+)');
  const ws = new WS(url);
  let closed = false;
  const t: Transport = {
    onMessage: () => {},
    onClose: () => {},
    send(text) {
      if (closed || ws.readyState !== 1) throw new Error('socket closed');
      ws.send(text);
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        ws.close();
      } catch {}
    },
  };
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new AwError('timeout', `browser socket ${url} did not open in ${timeoutMs} ms`));
    }, timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', (ev: any) => {
      clearTimeout(timer);
      reject(new AwError('net', `could not connect to the browser at ${url}${ev?.message ? ` (${ev.message})` : ''}`));
    }, { once: true });
  });
  const end = (reason: string) => {
    if (closed) return;
    closed = true;
    t.onClose(reason);
  };
  ws.addEventListener('message', (ev: any) => {
    const d = ev.data;
    if (typeof d === 'string') t.onMessage(d);
    else if (d instanceof ArrayBuffer) t.onMessage(Buffer.from(d).toString('utf8'));
  });
  ws.addEventListener('close', () => end('browser socket closed'));
  ws.addEventListener('error', () => end('browser socket error'));
  return t;
}

/** Connect to a browser that is already running. */
export async function connect(endpoint: string, timeoutMs = 10_000): Promise<Cdp> {
  const url = await resolveEndpoint(endpoint, timeoutMs);
  return new Cdp(await wsTransport(url, timeoutMs));
}
