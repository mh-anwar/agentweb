// The ghost engine: JavaScript and a DOM, no layout, no paint, virtual time.
//
// Every live page is its own child process (child.ts) with a heap cap, a wall-clock deadline
// enforced from here (a page that never yields is killed), and no network of its own: each
// request it makes arrives here as a message and is performed by `opts.fetch`, after this side
// has decided which cookies it may carry and whether the page may read the answer (CORS).
// A dead page becomes an AwError for its own session only.

import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AwError } from '../../types.ts';
import type { Action, Doc, Engine, ErrCode, Loaded, NavRequest, SessionCtx } from '../../types.ts';
import type { DocMeta, LNode } from '../../tree.ts';
import { DEFAULT_LIMITS } from './protocol.ts';
import type { FromChild, Limits, NavIntent, NetReply, NetReq, PageResult, ToChild } from './protocol.ts';
import { applyScriptCookie, cleanHeaders, corsAllows, defaultFetch, documentCookie, exposed, isSimple, preflightAllows, sameSite } from './net.ts';
import type { GhostFetch, GhostRequest, GhostResponse } from './net.ts';

export interface GhostOptions {
  /** performs every request (documents and everything a page loads); default: defaultFetch() */
  fetch?: GhostFetch;
  /** most live pages (child processes) at once; the least recently used is evicted (default 16) */
  maxPages?: number;
  /** a page idle this long is evicted (default 10 min) */
  idleMs?: number;
  /** V8 heap cap of one page process in MB (default 256) */
  memoryMb?: number;
  /** settle limits (virtual time, CPU budget per script, …) */
  limits?: Partial<Limits>;
  /** page processes kept started and waiting, so an open does not pay for process start (default 1) */
  spare?: number;
  /** fetch stylesheets, so CSS-hidden content is recognised (default true) */
  styles?: boolean;
  /** largest HTML document accepted (default 10 MB) */
  maxDocBytes?: number;
  /** extra V8/Node flags for page processes */
  execArgv?: string[];
  /** page process entry file (default: child.ts beside this module, or ghost-child.mjs beside a bundle) */
  childPath?: string;
}

export const REOPENED = 'page re-opened from cookies; in-page state was reset';

/**
 * The page process entry: src/engines/ghost/child.ts when running from source, or
 * ghost-child.mjs next to a bundle (build it as a second esbuild entry with jsdom external).
 */
function findChild(override?: string): string | null {
  const candidates = override ? [override] : [fileURLToPath(new URL('./child.ts', import.meta.url)), fileURLToPath(new URL('./ghost-child.mjs', import.meta.url))];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** what a page process may read: its own code, the DOM library, the package.json that types it */
function readable(child: string, nodeModules: string): string[] {
  const dir = path.dirname(child);
  const own = child.endsWith('.ts') ? path.resolve(dir, '../..') + path.sep : dir + path.sep;
  const out = [own, nodeModules];
  for (let d = path.resolve(own); ; d = path.dirname(d)) {
    if (existsSync(path.join(d, 'package.json'))) {
      out.push(path.join(d, 'package.json'));
      break;
    }
    if (path.dirname(d) === d) break;
  }
  return out;
}
const MAX_HOPS = 8;
const GRACE_MS = 5000;
const ERR_CODES = new Set<ErrCode>(['stale', 'timeout', 'net', 'blocked', 'policy', 'unsupported', 'gone', 'bad_request', 'too_large', 'internal']);

function jsdomDir(): string | null {
  try {
    const req = createRequire(import.meta.url);
    // <node_modules>/jsdom/lib/api.js -> <node_modules>
    return path.dirname(path.dirname(path.dirname(req.resolve('jsdom'))));
  } catch {
    return null;
  }
}

// ───────────── one page process ─────────────

interface Call {
  resolve: (r: PageResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

class Proc {
  child: ChildProcess;
  ready: Promise<void>;
  dead = false;
  pid = 0;
  rssMb = 0;
  private calls = new Map<number, Call>();
  private seq = 0;
  private stderr = '';
  onNet: ((m: NetReq) => void) | null = null;
  onNetCancel: ((rid: number) => void) | null = null;
  onCookie: ((v: string) => void) | null = null;
  onExit: (() => void) | null = null;
  exited: Promise<void>;
  memoryMb: number;

  constructor(child: string, memoryMb: number, nodeModules: string, extra: string[] = []) {
    this.memoryMb = memoryMb;
    const execArgv = [
      `--max-old-space-size=${memoryMb}`,
      // a small young generation: ~16 MB less resident memory per page, no measurable cost here
      '--max-semi-space-size=1',
      ...extra,
      '--experimental-vm-modules',
      '--disable-warning=ExperimentalWarning',
      // Node's permission model: no fs writes, no child processes, no workers, no addons
      '--permission',
      ...readable(child, nodeModules).map((p) => `--allow-fs-read=${p}`),
    ];
    this.child = fork(child, [], {
      execArgv,
      serialization: 'advanced',
      // AGENTWEB_GHOST_DEBUG=1 shows page-process stderr (crash traces) instead of keeping a tail
      stdio: ['ignore', 'ignore', process.env.AGENTWEB_GHOST_DEBUG ? 'inherit' : 'pipe', 'ipc'],
      env: { NODE_ENV: 'production' },
    });
    this.child.stderr?.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-4000);
    });
    let ready!: () => void;
    let failed!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => {
      ready = res;
      failed = rej;
    });
    this.ready.catch(() => {});
    this.exited = new Promise<void>((res) => this.child.once('exit', () => res()));
    this.child.on('message', (m: FromChild) => this.message(m, ready));
    this.child.on('error', () => {});
    this.child.once('exit', (code, signal) => {
      this.dead = true;
      const err = this.crashError(code, signal);
      failed(err);
      for (const c of this.calls.values()) {
        clearTimeout(c.timer);
        c.reject(err);
      }
      this.calls.clear();
      this.onExit?.();
    });
  }

  private crashError(code: number | null, signal: string | null): AwError {
    if (/heap limit|out of memory|allocation failed/i.test(this.stderr))
      return new AwError('too_large', `the page used more than ${this.memoryMb} MB of memory and was stopped`, "try engine('chrome')");
    return new AwError('internal', `the page process exited (${signal || 'code ' + code})`, 'open the page again');
  }

  private message(m: FromChild, ready: () => void): void {
    if (!m || typeof m !== 'object' || typeof (m as any).t !== 'string') return;
    switch (m.t) {
      case 'ready':
        this.pid = +m.pid || 0;
        ready();
        return;
      case 'pong':
        this.rssMb = +m.rssMb || 0;
        return;
      case 'net':
        this.onNet?.(m);
        return;
      case 'netc':
        this.onNetCancel?.(+m.rid);
        return;
      case 'cookie':
        if (typeof m.value === 'string') this.onCookie?.(m.value.slice(0, 8192));
        return;
      case 'res': {
        const c = this.calls.get(m.id);
        if (!c) return;
        this.calls.delete(m.id);
        clearTimeout(c.timer);
        if (m.ok) {
          if (m.stats && typeof m.stats.rssMb === 'number') this.rssMb = m.stats.rssMb;
          c.resolve(m);
        } else {
          const code = ERR_CODES.has(m.code as ErrCode) ? (m.code as ErrCode) : 'internal';
          c.reject(new AwError(code, String(m.message || 'page error').slice(0, 400), m.hint ? String(m.hint).slice(0, 200) : undefined));
        }
        return;
      }
    }
  }

  send(m: ToChild): void {
    if (this.dead || !this.child.connected) return;
    try {
      this.child.send(m);
    } catch {}
  }

  /** one operation; a page that has not answered by `deadlineMs` is killed */
  call(m: Omit<ToChild & { id: number }, 'id'>, deadlineMs: number): Promise<PageResult> {
    if (this.dead) return Promise.reject(new AwError('gone', 'the page process is gone'));
    const id = ++this.seq;
    return new Promise<PageResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new AwError('timeout', `the page did not finish within ${Math.round(deadlineMs / 1000)} s; its scripts were stopped`, "the page may never stop running scripts; try engine('chrome')"));
        this.kill();
      }, deadlineMs);
      this.calls.set(id, { resolve, reject, timer });
      this.send({ ...(m as any), id });
    });
  }

  kill(): void {
    if (this.dead) return;
    try {
      this.child.kill('SIGKILL');
    } catch {}
  }
}

// ───────────── sessions ─────────────

interface Entry {
  url: string;
  method: 'GET' | 'POST';
  /** POST results are kept, so `back` never re-submits a form */
  html?: Uint8Array;
  contentType?: string;
  status?: number;
}

interface Live {
  id: string;
  proc: Proc;
  ctx: SessionCtx;
  /** URL of the document (origin for CORS and cookies) and the page's current location */
  docUrl: string;
  url: string;
  status: number;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  history: Entry[];
  index: number;
  /** sessionStorage, per origin, for the life of the live page ("the tab") */
  session: Record<string, Record<string, string>>;
  lastUsed: number;
  queue: Promise<unknown>;
  netBytes: number;
  net: Map<number, AbortController>;
  notes: string[];
  hasPage: boolean;
  /** operations queued or running: a busy page is never evicted */
  busy: number;
}

interface OpState {
  t0: number;
  deadline: number;
  events: string[];
  bytes: number;
}

export function createGhostEngine(opts: GhostOptions = {}): Engine {
  return new GhostEngine(opts);
}

export class GhostEngine implements Engine {
  readonly tier = 'ghost' as const;
  private opts: GhostOptions;
  private fetchFn: GhostFetch;
  private limits: Limits;
  private sessions = new Map<string, Live>();
  private ids = new Map<string, number>();
  private spares: Proc[] = [];
  private procs = new Set<Proc>();
  private sweeper: NodeJS.Timeout | null = null;
  private closed = false;
  private nodeModules: string | null;
  private child: string | null;
  private counters = { opens: 0, acts: 0, snapshots: 0, reopens: 0, crashes: 0, kills: 0, evictions: 0, requests: 0, blocked: 0, virtualMs: 0 };
  /** the last page operation: virtual ms skipped, tasks run, settle wall ms, page process RSS */
  private last = { lastSkippedMs: 0, lastTasks: 0, lastSettleMs: 0, lastRssMb: 0 };

  constructor(opts: GhostOptions) {
    this.opts = opts;
    this.fetchFn = opts.fetch ?? defaultFetch();
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits || {}) };
    this.nodeModules = jsdomDir();
    this.child = findChild(opts.childPath);
  }

  async available(): Promise<boolean> {
    if (!this.nodeModules || !this.child) return false;
    try {
      createRequire(import.meta.url).resolve('jsdom');
      return true;
    } catch {
      return false;
    }
  }

  live(sessionId: string): boolean {
    const l = this.sessions.get(sessionId);
    return !!l && !l.proc.dead && l.hasPage;
  }

  stats(): Record<string, number> {
    let rss = 0;
    for (const p of this.procs) rss += p.rssMb;
    return { live: this.sessions.size, processes: this.procs.size, spare: this.spares.length, rssMb: rss, ...this.counters, ...this.last };
  }

  /** pids of the page processes (tests and diagnostics) */
  pids(): number[] {
    return [...this.procs].map((p) => p.pid).filter(Boolean);
  }

  async release(sessionId: string): Promise<void> {
    const l = this.sessions.get(sessionId);
    if (!l) return;
    this.sessions.delete(sessionId);
    this.drop(l);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    const all = [...this.procs];
    for (const l of this.sessions.values()) for (const a of l.net.values()) a.abort();
    this.sessions.clear();
    this.spares = [];
    for (const p of all) p.kill();
    await Promise.race([Promise.all(all.map((p) => p.exited)), new Promise((r) => setTimeout(r, 3000).unref())]);
  }

  // ───────────── Engine API ─────────────

  async open(ctx: SessionCtx, req: NavRequest): Promise<Loaded> {
    this.counters.opens++;
    const op = this.op(ctx);
    const live = await this.lease(ctx);
    const run = this.serial(live, () => this.navigate(live, ctx, op, { url: req.url, method: req.method ?? 'GET', body: req.body, contentType: req.contentType, referer: req.referer, headers: req.headers }, 'agent', true));
    live.busy--; // the reservation taken by lease(); serial() holds its own
    return run;
  }

  async act(ctx: SessionCtx, action: Action): Promise<Loaded> {
    if (action.do === 'shot') throw new AwError('unsupported', 'the ghost engine has no pixels to screenshot', "use engine('chrome')");
    if (action.do === 'upload') throw new AwError('unsupported', 'the ghost engine cannot upload files', "use engine('chrome')");
    this.counters.acts++;
    let live = this.sessions.get(ctx.id);
    const extra: string[] = [];
    if (!live || live.proc.dead || !live.hasPage) {
      const re = await this.reopen(ctx);
      if ('n' in action && typeof (action as any).n === 'number') throw new AwError('stale', `the page was re-opened and element ${(action as any).n} is gone`, 're-read the page and pick the element again');
      extra.push(...(re.events || []));
      live = this.sessions.get(ctx.id);
      if (!live) return re;
    }
    const l = live;
    const op = this.op(ctx);
    op.events.push(...extra);
    return this.serial(l, async () => {
      this.touch(l, ctx);
      const res = await this.callPage(l, { t: 'act', action, limits: this.limits, budgetMs: this.budget(op) } as any, op);
      if (res.noHistory) return this.historyGo(l, ctx, op, -1, res);
      return this.after(l, ctx, op, res);
    });
  }

  async snapshot(ctx: SessionCtx): Promise<Loaded> {
    this.counters.snapshots++;
    const live = this.sessions.get(ctx.id);
    if (!live || live.proc.dead || !live.hasPage) return this.reopen(ctx);
    const op = this.op(ctx);
    return this.serial(live, async () => {
      this.touch(live, ctx);
      const res = await this.callPage(live, { t: 'snap', limits: this.limits, budgetMs: this.budget(op) } as any, op);
      return this.after(live, ctx, op, res);
    });
  }

  // ───────────── internals ─────────────

  private op(ctx: SessionCtx): OpState {
    const t0 = performance.now();
    return { t0, deadline: t0 + Math.max(1000, ctx.timeoutMs || 30000), events: [], bytes: 0 };
  }

  private budget(op: OpState): number {
    const left = op.deadline - performance.now();
    if (left <= 200) throw new AwError('timeout', 'the time budget for this step ran out');
    return Math.round(left);
  }

  private async reopen(ctx: SessionCtx): Promise<Loaded> {
    if (!ctx.url) throw new AwError('gone', 'no live page for this session', 'open a page first');
    this.counters.reopens++;
    const loaded = await this.open(ctx, { url: ctx.url });
    loaded.events = [REOPENED, ...(loaded.events || [])];
    return loaded;
  }

  private serial<T>(live: Live, fn: () => Promise<T>): Promise<T> {
    live.busy++;
    const run = live.queue.then(fn, fn).finally(() => {
      live.busy--;
      live.lastUsed = Date.now();
      // the cap is soft while every page is busy: trim once operations finish
      this.evictFor(0);
    });
    live.queue = run.catch(() => {});
    return run;
  }

  private touch(live: Live, ctx: SessionCtx): void {
    live.ctx = ctx;
    live.lastUsed = Date.now();
    live.notes = [];
    live.netBytes = 0;
  }

  private spawn(): Proc {
    if (!this.nodeModules || !this.child) throw new AwError('unsupported', 'the ghost engine is not available here (jsdom or its page process is missing)');
    const p = new Proc(this.child, this.opts.memoryMb ?? 256, this.nodeModules, this.opts.execArgv);
    this.procs.add(p);
    p.exited.then(() => {
      this.procs.delete(p);
      const i = this.spares.indexOf(p);
      if (i >= 0) this.spares.splice(i, 1);
    });
    return p;
  }

  private topUpSpares(): void {
    const want = this.opts.spare ?? 1;
    if (this.closed) return;
    while (this.spares.filter((p) => !p.dead).length < want) this.spares.push(this.spawn());
  }

  private async takeProc(): Promise<Proc> {
    let p: Proc | undefined;
    while ((p = this.spares.shift())) if (!p.dead) break;
    if (!p) p = this.spawn();
    setImmediate(() => this.topUpSpares());
    try {
      await p.ready;
    } catch {
      this.counters.crashes++;
      throw new AwError('internal', 'could not start a page process', 'is jsdom installed? Node >= 22.6 with --experimental-vm-modules support is needed');
    }
    return p;
  }

  private async lease(ctx: SessionCtx): Promise<Live> {
    if (this.closed) throw new AwError('gone', 'the ghost engine is closed');
    const have = this.sessions.get(ctx.id);
    if (have && !have.proc.dead) {
      have.ctx = ctx;
      have.lastUsed = Date.now();
      have.busy++;
      return have;
    }
    if (have) this.sessions.delete(ctx.id);
    this.evictFor(1);
    this.startSweeper();
    const proc = await this.takeProc();
    const live: Live = {
      id: ctx.id, proc, ctx, docUrl: '', url: '', status: 0, method: 'GET', headers: {}, history: [], index: -1, session: {},
      lastUsed: Date.now(), queue: Promise.resolve(), netBytes: 0, net: new Map(), notes: [], hasPage: false, busy: 1,
    };
    this.wire(live);
    const raced = this.sessions.get(ctx.id);
    if (raced && !raced.proc.dead) {
      // two opens for one session raced: keep the first, recycle this process as a spare
      proc.onExit = null;
      this.spares.push(proc);
      raced.busy++;
      return raced;
    }
    this.sessions.set(ctx.id, live);
    this.evictFor(0, live);
    return live;
  }

  private wire(live: Live): void {
    const p = live.proc;
    p.onNet = (m) => void this.subrequest(live, m);
    p.onNetCancel = (rid) => {
      live.net.get(rid)?.abort();
      live.net.delete(rid);
    };
    p.onCookie = (v) => {
      if (live.docUrl) applyScriptCookie(live.ctx.jar, live.docUrl, v);
    };
    p.onExit = () => {
      for (const a of live.net.values()) a.abort();
      live.net.clear();
      if (this.sessions.get(live.id) === live) {
        this.sessions.delete(live.id);
        this.counters.crashes++;
      }
    };
  }

  private drop(live: Live): void {
    for (const a of live.net.values()) a.abort();
    live.net.clear();
    live.proc.onExit = null;
    live.proc.kill();
  }

  private evictFor(n: number, keep?: Live): void {
    const cap = Math.max(1, this.opts.maxPages ?? 16);
    while (this.sessions.size + n > cap) {
      let oldest: Live | undefined;
      for (const l of this.sessions.values()) if (l !== keep && !l.busy && (!oldest || l.lastUsed < oldest.lastUsed)) oldest = l;
      if (!oldest) break;
      this.sessions.delete(oldest.id);
      this.counters.evictions++;
      this.drop(oldest);
    }
  }

  private startSweeper(): void {
    if (this.sweeper) return;
    const idle = this.opts.idleMs ?? 10 * 60_000;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const l of [...this.sessions.values()])
        if (!l.busy && now - l.lastUsed > idle) {
          this.sessions.delete(l.id);
          this.counters.evictions++;
          this.drop(l);
        }
      for (const p of this.procs) p.send({ t: 'ping', id: 0 });
    }, Math.max(250, Math.min(30_000, idle / 4)));
    this.sweeper.unref();
  }

  /** run one page operation; a crash or kill becomes an AwError and the session's page is gone */
  private async callPage(live: Live, msg: any, op: OpState): Promise<PageResult> {
    try {
      const budget = this.budget(op);
      msg.budgetMs = Math.min(budget, this.limits.maxWallMs + 4000);
      // the page settles within budgetMs by itself; past that plus a grace for extraction it is hung
      const call = live.proc.call(msg, msg.budgetMs + Math.min(GRACE_MS, Math.max(1000, msg.budgetMs / 2)));
      const signal = live.ctx.signal;
      if (!signal) return await call;
      if (signal.aborted) throw new AwError('timeout', 'the step was cancelled');
      let onAbort!: () => void;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => {
          // the page is mid-settle: its state can no longer be trusted
          live.proc.kill();
          reject(new AwError('timeout', 'the step was cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([call, aborted]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    } catch (e) {
      if (live.proc.dead || (e instanceof AwError && e.code === 'timeout')) {
        if (e instanceof AwError && e.code === 'timeout') this.counters.kills++;
        live.hasPage = false;
        if (this.sessions.get(live.id) === live) this.sessions.delete(live.id);
        this.drop(live);
      }
      throw e;
    }
  }

  /** load a document into the session's page process, following page-initiated navigations */
  private async navigate(live: Live, ctx: SessionCtx, op: OpState, nav: NavRequest, initiator: 'agent' | 'page', push: boolean, hops = 0, entry?: Entry): Promise<Loaded> {
    this.touch(live, ctx);
    const method = (nav.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
    let site: GhostRequest['site'] = 'same';
    if (initiator === 'page' && live.docUrl && !sameSite(live.docUrl, nav.url)) site = method === 'GET' ? 'lax' : 'none';
    let doc: GhostResponse;
    if (entry && entry.html) doc = { url: entry.url, status: entry.status ?? 200, headers: { 'content-type': entry.contentType || 'text/html' }, bytes: entry.html };
    else {
      const headers = { ...(nav.headers || {}) };
      doc = await this.fetchFn(ctx, { ...nav, method, kind: 'document', site, maxBytes: this.opts.maxDocBytes ?? 10 << 20, headers });
    }
    op.bytes += doc.bytes.byteLength;
    const ctype = (doc.headers['content-type'] || '').split(';')[0].trim().toLowerCase() || sniff(doc.bytes);
    // a POST answered with a redirect ends on a GET (303, and 302/301 in practice)
    const loadedMethod: 'GET' | 'POST' = method === 'POST' && doc.redirected ? 'GET' : method;
    if (ctype !== 'text/html' && ctype !== 'application/xhtml+xml') {
      // not a page: hand the bytes back; the session no longer has a live document
      live.hasPage = false;
      return {
        url: doc.url, status: doc.status, method: loadedMethod, contentType: ctype || 'application/octet-stream',
        body: { bytes: doc.bytes, text: /^(text\/|application\/(json|xml|[\w.+-]+\+(json|xml)|javascript))/.test(ctype) ? new TextDecoder().decode(doc.bytes) : undefined },
        bytes: op.bytes, ms: Math.round(performance.now() - op.t0), events: op.events.length ? op.events : undefined, headers: doc.headers,
      };
    }
    const origin = originOf(doc.url);
    live.docUrl = doc.url;
    live.url = doc.url;
    live.status = doc.status;
    live.method = loadedMethod;
    live.headers = pickHeaders(doc.headers);
    const res = await this.callPage(
      live,
      {
        t: 'load', url: doc.url, status: doc.status, contentType: doc.headers['content-type'] || 'text/html', referrer: nav.referer || '',
        html: doc.bytes, userAgent: ctx.userAgent, cookie: documentCookie(ctx.jar, doc.url),
        local: { ...(ctx.storage[origin] || {}) }, session: { ...(live.session[origin] || {}) },
        idBase: this.ids.get(ctx.id) ?? 1, styles: this.opts.styles !== false, limits: this.limits, budgetMs: 0,
      },
      op,
    );
    live.hasPage = true;
    // history: a new entry unless this load replaces the current one
    const e: Entry = { url: doc.url, method: loadedMethod };
    if (loadedMethod === 'POST' && doc.bytes.byteLength <= 2 << 20) Object.assign(e, { html: doc.bytes, contentType: doc.headers['content-type'], status: doc.status });
    if (entry) live.history[live.index] = { ...entry, url: doc.url };
    else if (push || live.index < 0) {
      live.history.splice(live.index + 1);
      live.history.push(e);
      live.index = live.history.length - 1;
      if (live.history.length > 50) {
        live.history.shift();
        live.index--;
      }
    } else live.history[live.index] = e;
    return this.after(live, ctx, op, res, hops);
  }

  /** apply a page result: state back into the session, follow navigations, build Loaded */
  private async after(live: Live, ctx: SessionCtx, op: OpState, res: PageResult, hops = 0): Promise<Loaded> {
    const origin = originOf(live.docUrl);
    const st = res.stats;
    if (st && typeof st === 'object') {
      this.last = { lastSkippedMs: +st.skippedMs || 0, lastTasks: +st.tasks || 0, lastSettleMs: +st.wallMs || 0, lastRssMb: +st.rssMb || 0 };
      this.counters.virtualMs += this.last.lastSkippedMs;
    }
    if (origin) {
      ctx.storage[origin] = cleanStore(res.local);
      live.session[origin] = cleanStore(res.session);
    }
    if (Number.isSafeInteger(res.idNext) && res.idNext > (this.ids.get(ctx.id) ?? 0)) {
      this.ids.set(ctx.id, res.idNext);
      if (this.ids.size > 100_000) this.ids.delete(this.ids.keys().next().value!);
    }
    for (const ev of res.events || []) if (typeof ev === 'string') op.events.push(ev.slice(0, 300));
    op.events.push(...live.notes);
    live.notes = [];
    op.bytes += live.netBytes;
    live.netBytes = 0;
    if (typeof res.url === 'string' && res.url.startsWith('http') && originOf(res.url) === origin) live.url = res.url;
    const nav = res.nav;
    if (nav) {
      if (hops >= MAX_HOPS) op.events.push('stopped following navigations after ' + MAX_HOPS + ' hops');
      else if (nav.why === 'history' && typeof nav.delta === 'number') return this.historyGo(live, ctx, op, Math.max(-50, Math.min(-1, Math.trunc(nav.delta))), undefined, hops + 1);
      else {
        const intent = cleanIntent(nav, live.url);
        if (intent) {
          return this.navigate(live, ctx, op, { url: intent.url, method: intent.method, body: intent.body, contentType: intent.contentType, referer: stripHash(live.url) }, 'page', !intent.replace, hops + 1);
        }
      }
    }
    const events = dedupe(op.events);
    return {
      url: live.url,
      status: live.status,
      method: live.method,
      contentType: 'text/html',
      doc: res.doc ? sanitizeDoc(res.doc) : { root: { t: 'html', c: [] }, meta: emptyMeta() },
      bytes: op.bytes,
      ms: Math.round(performance.now() - op.t0),
      events: events.length ? events : undefined,
      escalate: typeof res.escalate === 'string' ? res.escalate.slice(0, 200) : undefined,
      headers: live.headers,
    };
  }

  /** go back across documents */
  private async historyGo(live: Live, ctx: SessionCtx, op: OpState, delta: number, current?: PageResult, hops = 0): Promise<Loaded> {
    const to = live.index + delta;
    if (to < 0 || !live.history[to]) {
      op.events.push('back: there is no earlier page in this session');
      if (current) return this.after(live, ctx, op, { ...current, noHistory: undefined }, hops);
      return this.snapshotNow(live, ctx, op);
    }
    live.index = to;
    const e = live.history[to];
    return this.navigate(live, ctx, op, { url: e.url, method: e.html ? 'POST' : 'GET' }, 'agent', false, hops + 1, e.html ? e : undefined);
  }

  private async snapshotNow(live: Live, ctx: SessionCtx, op: OpState): Promise<Loaded> {
    const res = await this.callPage(live, { t: 'snap', limits: this.limits, budgetMs: 0 }, op);
    return this.after(live, ctx, op, res);
  }

  // ───────────── requests made by the page ─────────────

  private async subrequest(live: Live, m: NetReq): Promise<void> {
    const rid = +m.rid;
    const reply = (r: Omit<NetReply, 't' | 'rid'>) => {
      live.net.delete(rid);
      live.proc.send({ t: 'netr', rid, cookie: live.docUrl ? documentCookie(live.ctx.jar, live.docUrl) : '', ...r });
    };
    this.counters.requests++;
    const kind = m.kind === 'script' || m.kind === 'style' ? m.kind : 'xhr';
    let url: URL;
    try {
      url = new URL(String(m.url));
    } catch {
      return reply({ error: 'invalid URL' });
    }
    if (!/^https?:$/.test(url.protocol)) return reply({ error: 'URL scheme is not supported' });
    const method = String(m.method || 'GET').toUpperCase();
    if (!/^[A-Z]{1,16}$/.test(method) || method === 'CONNECT' || method === 'TRACE') return reply({ error: 'method not allowed' });
    const pageOrigin = originOf(live.docUrl);
    const same = url.origin === pageOrigin;
    const headers = cleanHeaders(Array.isArray(m.headers) ? m.headers.slice(0, 100) : []);
    const ab = new AbortController();
    live.net.set(rid, ab);
    const ctx = { ...live.ctx, signal: live.ctx.signal ? AbortSignal.any([live.ctx.signal, ab.signal]) : ab.signal };
    const site: GhostRequest['site'] = live.docUrl && sameSite(live.docUrl, url.href) ? 'same' : 'none';
    const body = m.body instanceof Uint8Array && method !== 'GET' && method !== 'HEAD' ? m.body : undefined;
    const ctype = headers['content-type'];
    const max = kind === 'style' ? 2 << 20 : 16 << 20;
    const referer = stripHash(live.url);
    try {
      if (kind !== 'xhr') {
        const r = await this.fetchFn(ctx, { url: url.href, method: 'GET', kind, site, referer, headers: { accept: headers.accept || '*/*' }, maxBytes: max });
        live.netBytes += r.bytes.byteLength;
        return reply({ url: r.url, status: r.status, headers: Object.entries(r.headers), body: r.bytes, redirected: r.redirected });
      }
      // fetch() / XMLHttpRequest: the same rules a browser applies
      if (m.mode === 'same-origin' && !same) return reply({ error: 'cross-origin request in same-origin mode' });
      const creds = m.credentials === 'include' || (m.credentials !== 'omit' && same);
      if (!same) headers.origin = pageOrigin;
      if (!same && m.mode === 'no-cors' && !['GET', 'HEAD', 'POST'].includes(method)) return reply({ error: 'no-cors requests are limited to GET, HEAD and POST' });
      if (!same && m.mode !== 'no-cors' && !isSimple(method, withoutOrigin(headers))) {
        const names = Object.keys(withoutOrigin(headers)).sort();
        const pre = await this.fetchFn(ctx, {
          url: url.href, method: 'OPTIONS' as any, kind, credentials: false, site, referer, maxBytes: 64 << 10,
          headers: { origin: pageOrigin, 'access-control-request-method': method, ...(names.length ? { 'access-control-request-headers': names.join(',') } : {}) },
        });
        if (!(pre.status >= 200 && pre.status < 300) || !preflightAllows(pre.headers, pageOrigin, creds, method, names)) {
          this.pageNote(live, `blocked by CORS: ${method} ${short(url.href)} (preflight refused)`);
          return reply({ error: 'CORS preflight refused' });
        }
      }
      const r = await this.fetchFn(ctx, { url: url.href, method: method as any, kind, body, contentType: ctype, credentials: creds, site, referer, headers, maxBytes: max });
      live.netBytes += r.bytes.byteLength;
      if (!same && m.mode === 'no-cors') return reply({ url: r.url, status: 0, headers: [], body: new Uint8Array(0) });
      if (!same && !corsAllows(r.headers, pageOrigin, creds)) {
        this.pageNote(live, `blocked by CORS: ${short(url.href)} does not allow ${pageOrigin}`);
        return reply({ error: 'blocked by CORS policy' });
      }
      return reply({ url: r.url, status: r.status, headers: Object.entries(same ? r.headers : exposed(r.headers)), body: r.bytes, redirected: r.redirected });
    } catch (e: any) {
      if (e instanceof AwError && e.code === 'policy') {
        this.counters.blocked++;
        this.pageNote(live, `blocked by policy: ${short(url.href)} (${e.message})`);
      } else if (e instanceof AwError && e.code === 'too_large') this.pageNote(live, `skipped ${short(url.href)}: ${e.message}`);
      return reply({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  private pageNote(live: Live, msg: string): void {
    if (live.notes.length < 5 && !live.notes.includes(msg)) live.notes.push(msg);
  }
}

// ───────────── helpers ─────────────

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
}

const stripHash = (u: string) => u.split('#')[0];
const short = (u: string) => (u.length > 100 ? u.slice(0, 97) + '…' : u);
const dedupe = (a: string[]) => [...new Set(a)].slice(0, 20);

function withoutOrigin(h: Record<string, string>): Record<string, string> {
  const { origin: _o, ...rest } = h;
  return rest;
}

function sniff(bytes: Uint8Array): string {
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /^<(head|body|div|p|script|meta|title)[\s>]/.test(head) ? 'text/html' : '';
}

function pickHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['content-type', 'cache-control', 'last-modified', 'etag', 'x-robots-tag', 'link', 'content-language']) if (h[k]) out[k] = h[k];
  return out;
}

function cleanStore(s: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s || typeof s !== 'object') return out;
  let size = 0;
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    size += k.length + v.length;
    if (size > 5_000_000) break;
    out[k] = v;
  }
  return out;
}

function cleanIntent(n: NavIntent, base: string): NavIntent | null {
  if (!n || typeof n !== 'object') return null;
  let url: string;
  try {
    url = new URL(String(n.url), base).href;
  } catch {
    return null;
  }
  if (!/^https?:/.test(url)) return null;
  const method = n.method === 'POST' ? 'POST' : 'GET';
  return {
    url, method, why: n.why, replace: !!n.replace,
    body: method === 'POST' && n.body instanceof Uint8Array ? n.body.slice(0, 8 << 20) : undefined,
    contentType: method === 'POST' && typeof n.contentType === 'string' ? n.contentType.slice(0, 200) : undefined,
  };
}

const emptyMeta = (): DocMeta => ({ title: '', scripts: 0, json: [], links: [], noscript: '' });

const NODE_KEYS = new Set(['t', 'a', 'c', 'x', 'h', 'sr', 'n', 'v', 'k', 'p']);

/** the child is untrusted: rebuild its tree from known fields with bounded sizes */
export function sanitizeDoc(d: Doc): Doc {
  let budget = 60000;
  const node = (x: any, depth: number): LNode | null => {
    if (!x || typeof x !== 'object' || typeof x.t !== 'string' || budget-- <= 0 || depth > 1024) return null;
    const out: LNode = { t: x.t.slice(0, 64) };
    if (out.t === '#text') {
      out.x = typeof x.x === 'string' ? x.x.slice(0, 100_000) : '';
    }
    if (x.a && typeof x.a === 'object') {
      const a: Record<string, string> = {};
      let n = 0;
      for (const [k, v] of Object.entries(x.a)) {
        if (typeof v !== 'string' || n++ > 64) continue;
        a[k.slice(0, 64)] = v.slice(0, 4096);
      }
      out.a = a;
    }
    if (x.h === 1) out.h = 1;
    if (x.sr === 1) out.sr = 1;
    if (x.p === 1) out.p = 1;
    if (Number.isSafeInteger(x.n) && x.n > 0) out.n = x.n;
    if (typeof x.v === 'string') out.v = x.v.slice(0, 10_000);
    if (x.k === 0 || x.k === 1) out.k = x.k;
    if (Array.isArray(x.c)) {
      const c: LNode[] = [];
      for (const ch of x.c) {
        const y = node(ch, depth + 1);
        if (y) c.push(y);
      }
      out.c = c;
    }
    void NODE_KEYS;
    return out;
  };
  const root = node(d && d.root, 0) || { t: 'html', c: [] };
  const m: any = (d && d.meta) || {};
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);
  const meta: DocMeta = {
    title: str(m.title, 1000) ?? '',
    scripts: Number.isSafeInteger(m.scripts) ? m.scripts : 0,
    json: Array.isArray(m.json)
      ? m.json.slice(0, 50).filter((j: any) => j && typeof j.text === 'string').map((j: any) => ({ id: str(j.id, 200) ?? '', type: str(j.type, 200) ?? '', text: j.text.slice(0, 2_000_000) }))
      : [],
    links: Array.isArray(m.links)
      ? m.links.slice(0, 200).filter((l: any) => l && typeof l.href === 'string').map((l: any) => {
          const o: DocMeta['links'][number] = { rel: str(l.rel, 100) ?? '', href: l.href.slice(0, 4096) };
          if (typeof l.type === 'string') o.type = l.type.slice(0, 200);
          if (typeof l.title === 'string') o.title = l.title.slice(0, 500);
          return o;
        })
      : [],
    noscript: str(m.noscript, 10_000) ?? '',
  };
  for (const k of ['base', 'description', 'lang', 'refresh'] as const) {
    const v = str(m[k], 4096);
    if (v !== undefined) meta[k] = v;
  }
  return { root, meta };
}
