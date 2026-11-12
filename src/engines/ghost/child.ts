// The page process. One per live page: it holds a jsdom window, runs the page's scripts on a
// virtual clock, and answers load / act / snapshot requests from the engine over IPC.
//
// Started by the engine with --max-old-space-size (memory cap), --experimental-vm-modules
// (ES modules) and Node's permission model (no fs writes, no child processes, no workers).
// It never touches the network: every request goes to the parent as a NetReq.

import vm from 'node:vm';
import { Clock, bindLineage } from './clock.ts';
import type { SettleHooks } from './clock.ts';
import { installSurface } from './surface.ts';
import type { SurfaceHooks } from './surface.ts';
import { extractPage, nodeById } from '../../inpage/extract.ts';
import { jsdom, idl, reportException, installPatches, register } from './patches.ts';
import { ModuleLoader } from './modules.ts';
import { ActError, click, fill, select, check, press, hover } from './actions.ts';
import type { ActMsg, FromChild, LoadMsg, Limits, NavIntent, NetKind, NetReply, PageResult, SnapMsg, ToChild } from './protocol.ts';
import type { Action } from '../../types.ts';
import type { LNode } from '../../tree.ts';

const send = (m: FromChild) => {
  if (process.connected) process.send!(m);
};

installPatches();

// page code may leave promises rejected or throw from host callbacks: that is the page's
// problem, never a reason for this process to exit
process.on('unhandledRejection', (e) => current?.uncaught(e));
process.on('uncaughtException', (e) => current?.uncaught(e));

const tick = () => new Promise<void>((r) => setImmediate(r));
const CAP_EVENTS = 12;
const MAX_TEXT = 8 << 20;

/** the CPU guard: page functions called from here are terminated after `ms` */
const guardCtx = vm.createContext({ f: null as null | (() => void) });
const guardScript = new vm.Script('f()');

interface Pending {
  kind: NetKind;
  bg: boolean;
  deliver: (r: NetReply) => void;
}

class Page {
  win: any;
  dom: any;
  ctx: object;
  clock = new Clock();
  url: string;
  status: number;
  limits: Limits;
  cpuMs: number;
  idBase: number;
  hooks!: SurfaceHooks;
  modules: ModuleLoader;
  state = { hovered: null as any };
  events: string[] = [];
  errors: string[] = [];
  nav: NavIntent | undefined;
  failedModule = '';
  cpuKills = 0;
  requests = 0;
  work = 0;
  destroyed = false;
  settling = false;
  cookie: string;
  private rid = 0;
  private pending = new Map<number, Pending>();
  private queued: (() => void)[] = [];
  private wake: (() => void) | null = null;
  private stylesOn: boolean;
  private probe = '__awprobe' + Math.random().toString(36).slice(2, 10);
  private extractFn: any = null;
  private consoleErrors = 0;
  private gaveUpNet = false;
  private refreshes = 0;

  constructor(msg: LoadMsg) {
    this.url = msg.url;
    this.status = msg.status;
    this.limits = msg.limits;
    this.cpuMs = msg.limits.cpuMs;
    this.idBase = msg.idBase;
    this.cookie = msg.cookie;
    this.stylesOn = msg.styles;
    const self = this;
    const vc = new jsdom.VirtualConsole();
    vc.on('jsdomError', (e: any) => this.jsdomError(e));
    vc.on('error', (...a: unknown[]) => this.consoleError(a));
    const contentType = /charset=/i.test(msg.contentType) ? msg.contentType : 'text/html';
    this.modules = null as any;
    this.ctx = null as any;
    this.dom = new jsdom.JSDOM(Buffer.from(msg.html.buffer, msg.html.byteOffset, msg.html.byteLength), {
      url: msg.url,
      referrer: msg.referrer || undefined,
      contentType: /xhtml|\+xml/i.test(contentType) ? contentType : contentType.replace(/^[^;]*/, 'text/html'),
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      storageQuota: 5_000_000,
      virtualConsole: vc,
      resources: { interceptors: [jsdom.requestInterceptor((req: Request, info: { element: any }) => self.intercept(req, info.element))] },
      beforeParse(win: any) {
        self.win = win;
        self.boot(win, msg);
      },
    });
  }

  /** before the parser runs: surface, storage, identity, hooks */
  private boot(win: any, msg: LoadMsg): void {
    // the window jsdom hands to beforeParse is the contextified global (=== getInternalVMContext())
    this.ctx = win;
    const host = this.hostApi();
    const streams: Record<string, unknown> = {};
    for (const k of ['ReadableStream', 'WritableStream', 'TransformStream', 'TextEncoderStream', 'TextDecoderStream', 'CompressionStream', 'DecompressionStream', 'ByteLengthQueuingStrategy', 'CountQueuingStrategy'])
      if ((globalThis as any)[k]) streams[k] = (globalThis as any)[k];
    const install = win.eval('(' + installSurface.toString() + ')');
    this.hooks = install(win, host, { idBase: msg.idBase, streams });
    try {
      Object.defineProperty(win.navigator, 'userAgent', { get: () => msg.userAgent, configurable: true });
      Object.defineProperty(win.navigator, 'appVersion', { get: () => msg.userAgent.replace(/^Mozilla\//, ''), configurable: true });
    } catch {}
    for (const [store, data] of [[win.localStorage, msg.local], [win.sessionStorage, msg.session]] as const)
      for (const k of Object.keys(data || {}))
        try {
          store.setItem(k, String(data[k]));
        } catch {}
    // the extractor asks "does a script listen for clicks here?" with this event
    win.addEventListener(this.probe, (e: any) => {
      e.stopImmediatePropagation();
      if (listensForClick(e.target)) e.preventDefault();
    }, true);
    this.modules = new ModuleLoader({
      ctx: this.ctx,
      win,
      cpuMs: this.cpuMs,
      fetchText: (url) => this.fetchText(url),
      report: (e, url) => this.report(e, url),
      failed: (why) => {
        if (!this.failedModule) this.failedModule = why;
      },
      cpuKilled: () => this.cpuKilled(),
      busy: (d) => (this.work += d),
    });
    register(this, this.ctx);
  }

  // ───────────── HookedPage ─────────────
  navigate(intent: NavIntent): void {
    if (this.destroyed) return;
    this.nav = intent;
    this.wakeUp();
  }

  note(kind: string, msg: string): void {
    if (kind === 'ws') {
      try {
        const site = (h: string) => h.split('.').slice(-2).join('.');
        if (site(new URL(msg).hostname) === site(String(this.win.location.hostname))) this.ownSocket = true;
      } catch {}
    }
    if (kind === 'ws') msg = 'the page tried to open a WebSocket (' + msg + '); live updates are not available in this engine';
    else if (kind === 'popup') msg = msg.startsWith('link') || msg.startsWith('form') ? msg : 'blocked a popup: ' + msg;
    this.event(msg);
  }

  cpuKilled(): void {
    this.cpuKills++;
  }

  dynamicImport(spec: string, referrer: string, attrs: unknown): Promise<any> {
    return this.modules.dynamic(spec, referrer, attrs);
  }

  importMap(text: string): void {
    this.modules.addImportMap(text, String(this.win.document.baseURI));
  }

  moduleScript(elImpl: any, parserInserted: boolean): void {
    const el = idl.wrapperForImpl(elImpl);
    const docImpl = elImpl._ownerDocument;
    const srcAttr = el.getAttribute('src');
    let src: string | null = null;
    if (srcAttr !== null) {
      try {
        src = new URL(srcAttr, String(this.win.document.baseURI)).href;
      } catch {
        return;
      }
    }
    const inline = src === null ? el.textContent : null;
    const base = String(this.win.document.baseURI);
    const run = () => this.modules.runScript(el, inline, src, base);
    if (parserInserted && !el.hasAttribute('async') && Array.isArray(docImpl._scriptsToExecuteAfterParsing)) {
      // deferred like the spec says: in document order, after parsing, before DOMContentLoaded
      this.work++;
      docImpl._scriptsToExecuteAfterParsing.push({ ready: null, execute: () => run().finally(() => this.work--) });
    } else {
      const release = typeof docImpl._delayLoadEvent === 'function' ? docImpl._delayLoadEvent() : () => {};
      run().finally(release);
    }
  }

  // ───────────── host API lent to the surface ─────────────
  private hostApi(): any {
    const clock = this.clock;
    return {
      timer: (kind: any, delay: number, fn: () => void, repeat: boolean) => clock.add(kind, delay, fn, repeat),
      cancel: (id: number, kind: any) => clock.cancel(id, kind),
      now: () => clock.dateNow(),
      perf: () => clock.now(),
      note: (kind: string, msg: string) => this.note(kind, msg),
      getCookie: () => this.cookie,
      setCookie: (v: string) => this.setCookie(v),
      fetch: (spec: any, cb: (err: string | null, r?: any) => void) => this.request(spec, cb),
      abort: (rid: number) => this.abort(rid),
      json: (v: unknown) => JSON.stringify(v),
      subtle: (m: string, args: any[], cb: (err: string | null, v?: any) => void) => {
        const subtle: any = (globalThis.crypto as any).subtle;
        Promise.resolve()
          .then(() => subtle[m](...args))
          .then(
            (v: any) => this.deliver(() => cb(null, v)),
            (e: any) => this.deliver(() => cb(String((e && e.message) || e))),
          );
      },
    };
  }

  private setCookie(v: string): void {
    const m = /^\s*([^=;]*)=?([^;]*)/.exec(v);
    if (!m) return;
    if (/;\s*httponly\s*(;|$)/i.test(v)) return; // scripts cannot set HttpOnly cookies
    const name = m[1].trim();
    const value = m[2].trim();
    const expired = /;\s*max-age\s*=\s*(-\d+|0)\s*(;|$)/i.test(v) || (() => {
      const e = /;\s*expires\s*=\s*([^;]+)/i.exec(v);
      return !!e && Date.parse(e[1]) < this.clock.dateNow();
    })();
    const parts = this.cookie ? this.cookie.split(/;\s*/).filter((p) => p && p.split('=')[0] !== name) : [];
    if (!expired) parts.push(name ? `${name}=${value}` : value);
    this.cookie = parts.join('; ');
    send({ t: 'cookie', value: String(v).slice(0, 8192) });
  }

  // ───────────── network: everything goes to the parent ─────────────
  private request(spec: any, cb: (err: string | null, r?: any) => void): number {
    const rid = ++this.rid;
    if (++this.requests > this.limits.maxRequests) {
      this.queued.push(() => cb('too many requests from this page'));
      return rid;
    }
    const kind: NetKind = spec.kind === 'script' || spec.kind === 'style' ? spec.kind : 'xhr';
    const done = bindLineage(cb);
    this.pending.set(rid, {
      kind,
      bg: false,
      deliver: (r) => {
        if (r.error) done(r.error);
        else done(null, { url: r.url, status: r.status, statusText: r.statusText, headers: r.headers, body: r.body, redirected: r.redirected });
      },
    });
    const headers: [string, string][] = [];
    for (const h of spec.headers || []) if (Array.isArray(h) && h.length === 2) headers.push([String(h[0]), String(h[1])]);
    send({
      t: 'net', rid, kind, url: String(spec.url), method: String(spec.method || 'GET'), headers,
      body: spec.body ? new Uint8Array(spec.body) : null,
      credentials: spec.credentials === 'omit' || spec.credentials === 'include' ? spec.credentials : 'same-origin',
      mode: spec.mode === 'no-cors' || spec.mode === 'same-origin' ? spec.mode : 'cors',
    });
    return rid;
  }

  private abort(rid: number): void {
    if (this.pending.delete(rid)) send({ t: 'netc', rid });
  }

  onReply(r: NetReply): void {
    const p = this.pending.get(r.rid);
    if (!p) return;
    this.pending.delete(r.rid);
    if (typeof r.cookie === 'string') this.cookie = r.cookie;
    this.deliver(() => p.deliver(r));
  }

  /** page code only runs inside a settle: anything arriving between operations waits for the next one */
  private deliver(fn: () => void): void {
    if (this.destroyed) return;
    if (this.settling) this.guard(fn);
    else this.queued.push(fn);
    this.clock.activity++;
    this.wakeUp();
  }

  private wakeUp(): void {
    const w = this.wake;
    this.wake = null;
    if (w) w();
  }

  /** jsdom's own loads (scripts, stylesheets, frames) */
  private async intercept(req: Request, element: any): Promise<Response> {
    const tag = element && element.localName ? String(element.localName) : '';
    let kind: NetKind | null = null;
    if (tag === 'script') kind = 'script';
    else if (tag === 'link' && this.stylesOn && /(^|\s)stylesheet(\s|$)/i.test(String(element.getAttribute && element.getAttribute('rel')))) kind = 'style';
    if (!kind) {
      // images, fonts, media, frames: never fetched
      if (tag === 'iframe' || tag === 'frame') return new Response('<!doctype html><title></title>', { headers: { 'content-type': 'text/html' } });
      if (tag === 'link') return new Response('', { headers: { 'content-type': 'text/css' } });
      if (!tag) throw new TypeError('this request is not available in the ghost engine');
      return new Response(null, { status: 204 });
    }
    const body = req.method !== 'GET' && req.method !== 'HEAD' ? new Uint8Array(await req.arrayBuffer()) : null;
    const headers: [string, string][] = [];
    req.headers.forEach((v, k) => headers.push([k, v]));
    const r = await new Promise<NetReply>((resolve) => {
      const rid = this.request({ kind, url: req.url, method: req.method, headers, body, credentials: 'include', mode: 'no-cors' }, (err, res) => resolve(err ? { t: 'netr', rid, error: err } : { t: 'netr', rid, ...res }));
    });
    if (r.error) throw new TypeError(r.error);
    const status = r.status && r.status >= 200 && r.status <= 599 ? r.status : 502;
    return new Response(status === 204 || status === 205 || status === 304 ? null : (r.body as any), { status, headers: (r.headers || []).filter(([k]) => k !== 'content-encoding' && k !== 'content-length') });
  }

  private fetchText(url: string): Promise<{ url: string; status: number; text: string; type: string }> {
    return new Promise((resolve, reject) => {
      if (/^data:/i.test(url)) {
        const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(url);
        if (!m) return reject(new TypeError('malformed data: URL'));
        const text = m[2] ? Buffer.from(decodeURIComponent(m[3]), 'base64').toString('utf8') : decodeURIComponent(m[3]);
        return resolve({ url, status: 200, text, type: m[1] || 'text/javascript' });
      }
      this.request({ kind: 'script', url, method: 'GET', headers: [['accept', '*/*']], credentials: 'same-origin', mode: 'cors' }, (err, r) => {
        if (err) return reject(new this.win.TypeError(`failed to fetch module ${url} (${err})`));
        const type = ((r.headers || []).find((h: string[]) => h[0] === 'content-type') || [, ''])[1];
        resolve({ url: r.url || url, status: r.status, text: new TextDecoder().decode(r.body), type });
      });
    });
  }

  // ───────────── errors and events ─────────────
  event(msg: string): void {
    msg = String(msg).replace(/\s+/g, ' ').slice(0, 240);
    if (this.events.length < CAP_EVENTS && !this.events.includes(msg)) this.events.push(msg);
  }

  private error(msg: string): void {
    msg = String(msg).replace(/\s+/g, ' ').replace(/^Uncaught \[?|\]$/g, '').slice(0, 200);
    if (this.errors.length < 20) this.errors.push(msg);
  }

  uncaught(e: unknown): void {
    if (this.destroyed) return;
    const msg = e && typeof e === 'object' && 'message' in e ? `${(e as any).name || 'Error'}: ${(e as any).message}` : String(e);
    this.error('uncaught (in promise) ' + msg);
  }

  report(e: unknown, url: string): void {
    try {
      reportException(this.win, e, url);
    } catch {
      this.uncaught(e);
    }
  }

  private jsdomError(e: any): void {
    const type = e && e.type;
    const msg = String((e && e.message) || e);
    if (type === 'unhandled-exception') {
      const detail = e.cause || e.detail;
      this.error(detail && detail.message ? `${detail.name || 'Error'}: ${detail.message}` : msg);
    } else if (type === 'resource-loading') {
      const url = e.url || (msg.match(/https?:\/\/\S+/) || [''])[0];
      if (url) this.error('could not load ' + url + (e.cause && e.cause.message ? ' (' + e.cause.message + ')' : ''));
    } else if (type === 'not-implemented') {
      if (/navigation|traversing/.test(msg)) return;
    }
  }

  private consoleError(a: unknown[]): void {
    if (this.consoleErrors++ >= 3) return;
    const text = a.map((x) => (x && typeof x === 'object' && 'message' in (x as any) ? String((x as any).message) : String(x))).join(' ');
    this.event('console.error: ' + text.slice(0, 160));
  }

  // ───────────── running page code ─────────────
  guard(fn: () => void): void {
    guardCtx.f = fn;
    try {
      guardScript.runInContext(guardCtx, { timeout: this.cpuMs });
    } catch (e: any) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') this.cpuKilled();
      else if (!(e instanceof ActError)) this.report(e, String(this.win.location.href));
      else throw e;
    } finally {
      guardCtx.f = null;
    }
  }

  /** run until quiet. `until` stops early (wait text), `minMs` keeps the clock going (wait ms). */
  async settle(budgetMs: number, opts: { until?: () => boolean; minMs?: number } = {}): Promise<{ tasks: number; skippedMs: number; wallMs: number; stop: string }> {
    const limits = this.limits;
    this.settling = true;
    try {
      // deliveries that arrived between operations run first
      for (let i = 0; i < 10000 && this.queued.length; i++) {
        const fn = this.queued.shift()!;
        this.guard(fn);
        await tick();
      }
      let until = opts.until;
      if (opts.minMs && opts.minMs > 0) {
        const target = this.clock.now() + opts.minMs;
        this.clock.add('timeout', opts.minMs, () => {}, false);
        const inner = until;
        until = () => (inner ? inner() : false) || this.clock.now() >= target;
      }
      const hooks: SettleHooks = {
        limits: opts.minMs ? { ...limits, maxVirtualMs: Math.max(limits.maxVirtualMs, opts.minMs + 1000) } : limits,
        wallMs: Math.max(50, Math.min(limits.maxWallMs, budgetMs)),
        inflight: () => {
          let n = 0;
          for (const p of this.pending.values()) if (!p.bg) n++;
          return n + (this.queued.length ? 1 : 0);
        },
        waitActivity: (ms) =>
          new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              this.wake = null;
              resolve();
            }, ms);
            this.wake = () => {
              clearTimeout(t);
              resolve();
            };
          }).then(() => {
            while (this.queued.length) this.guard(this.queued.shift()!);
          }),
        stop: () => (this.destroyed ? 'closed' : this.nav ? 'nav' : undefined),
        background: () => {
          this.gaveUpNet = true;
          for (const p of this.pending.values()) p.bg = true;
        },
        guard: (fn) => this.guard(fn),
        until,
        busy: () => !this.gaveUpNet && (this.work > 0 || this.win.document.readyState !== 'complete' || this.historyBusy()),
      };
      const st = await this.clock.settle(hooks);
      if (!this.nav && st.stop !== 'closed') this.metaRefresh();
      return st;
    } finally {
      this.settling = false;
    }
  }

  private backFrom = -1;
  private historyBusy(): boolean {
    if (this.backFrom < 0) return false;
    const sh = this.win._sessionHistory;
    if (!sh || sh._currentIndex !== this.backFrom) {
      this.backFrom = -1;
      return false;
    }
    return true;
  }

  private metaRefresh(): void {
    let el: any;
    try {
      el = this.win.document.querySelector('meta[http-equiv="refresh" i]');
    } catch {}
    if (!el || this.refreshes > 0) return;
    const m = /^\s*(\d+(?:\.\d*)?)?\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?([^'"]+)['"]?)?/i.exec(String(el.getAttribute('content') || ''));
    if (!m || m[1] === undefined) return;
    const secs = parseFloat(m[1]);
    if (!(secs <= 30)) return;
    let target = String(this.win.location.href);
    if (m[2]) {
      try {
        target = new URL(m[2].trim(), String(this.win.document.baseURI)).href;
      } catch {
        return;
      }
    }
    // refreshing the same URL is a polling page, not a redirect
    if (target.split('#')[0] === String(this.win.location.href).split('#')[0]) return;
    this.refreshes++;
    this.event(`followed <meta http-equiv=refresh> after ${secs}s`);
    this.nav = { url: target, method: 'GET', why: 'refresh', replace: true };
  }

  extract(): { doc: { root: LNode; meta: any }; nodes: number; truncated: boolean; words: number } {
    const win = this.win;
    if (!this.extractFn) this.extractFn = win.eval('(' + extractPage.toString() + ')');
    let out: any = null;
    const geom0 = this.hooks.stats.geom;
    // jsdom caches the full cascade of every element it resolves (~8 KB each) and the extractor
    // resolves all of them: drop the cache every few thousand elements so the peak stays bounded
    const docImpl = idl.implForWrapper(win.document);
    const gcs = win.getComputedStyle;
    let calls = 0;
    const bounded = function (this: any, el: any, pseudo?: any) {
      if (++calls % 2000 === 0 && docImpl._styleCache) docImpl._styleCache.elements = null;
      return gcs.call(win, el, pseudo);
    };
    guardCtx.f = () => {
      win.getComputedStyle = bounded;
      try {
        out = this.extractFn(win, { layout: false, maxNodes: this.limits.maxNodes, probe: this.probe });
      } finally {
        win.getComputedStyle = gcs;
      }
    };
    // our own code, but it runs page getters: bounded by what is left of the operation
    const left = this.opEnd - performance.now() + 2000;
    try {
      guardScript.runInContext(guardCtx, { timeout: Math.round(Math.max(1500, Math.min(10000, left))) });
    } catch (e: any) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw new ActError('timeout', 'the page is too large to read in time', 'try engine(\'chrome\') or a narrower find');
      throw e;
    } finally {
      guardCtx.f = null;
      this.hooks.stats.geom = geom0;
      // and drop what is left: jsdom rebuilds what page code needs on demand
      if (docImpl._styleCache) docImpl._styleCache.elements = null;
    }
    if (!out || !out.root) throw new ActError('internal', 'the page could not be read');
    // clone out of the page realm: plain data only
    const doc = JSON.parse(JSON.stringify({ root: out.root, meta: out.meta }));
    return { doc, nodes: +out.nodes || 0, truncated: !!out.truncated, words: countWords(doc.root) };
  }

  storage(which: 'localStorage' | 'sessionStorage'): Record<string, string> {
    const out: Record<string, string> = {};
    try {
      const s = this.win[which];
      let size = 0;
      for (let i = 0; i < s.length; i++) {
        const k = String(s.key(i));
        const v = String(s.getItem(k) ?? '');
        size += k.length + v.length;
        if (size > MAX_TEXT) break;
        out[k] = v;
      }
    } catch {}
    return out;
  }

  /** the page plainly did not work without pixels */
  /** the page opened a WebSocket to its own site */
  ownSocket = false;

  escalation(words: number, acts: boolean): string | undefined {
    const s = this.hooks.stats;
    if (this.failedModule) return 'a JavaScript module could not be loaded: ' + this.failedModule;
    if (this.cpuKills) return `a script ran longer than ${this.cpuMs} ms and was stopped`;
    if (s.webgl) return 'the page draws with WebGL';
    if (s.syncXhr) return 'the page uses synchronous XMLHttpRequest';
    // the site's own socket: its content (results, prices, chat) arrives over it, which this engine cannot do
    if (this.ownSocket) return 'the page loads its content over a WebSocket';
    const thin = words < 25;
    if (thin && this.errors.length) return 'script error while booting: ' + this.errors[0];
    if (words === 0 && !acts) return 'the page body is empty after running its scripts';
    if (thin && s.draws > 20) return 'the page draws its content on a canvas';
    if (thin && s.geom > 300) return 'the page relies on layout measurement';
    return undefined;
  }

  result(id: number, st: { tasks: number; skippedMs: number; wallMs: number; stop: string }, boot: boolean): PageResult {
    const nav = this.nav;
    let doc: any;
    let nodes = 0;
    let truncated = false;
    let escalate: string | undefined;
    if (!nav) {
      const x = this.extract();
      doc = x.doc;
      nodes = x.nodes;
      truncated = x.truncated;
      if (boot) escalate = this.escalation(x.words, hasControls(doc.root));
    }
    if (st.stop === 'wall') this.event('the page was still busy when the time budget ran out');
    if (!boot) for (const e of this.errors.slice(0, 3)) this.event('script error: ' + e);
    else if (this.errors.length && !escalate) this.event(`${this.errors.length} script error(s) while booting; first: ${this.errors[0]}`);
    const res: PageResult = {
      t: 'res', id, ok: true,
      url: String(this.win.location.href),
      doc,
      events: this.events.slice(),
      escalate,
      nav,
      local: this.storage('localStorage'),
      session: this.storage('sessionStorage'),
      idNext: this.win.__aw ? +this.win.__aw.next || this.idBase : this.idBase,
      stats: { ...st, requests: this.requests, nodes, truncated, rssMb: Math.round(process.memoryUsage().rss / 1048576) },
    };
    this.events = [];
    this.errors = [];
    this.requests = 0;
    return res;
  }

  /** when the current operation's budget runs out (performance.now() ms) */
  opEnd = 0;

  /** start a new operation */
  begin(limits: Limits, budgetMs: number): void {
    this.opEnd = performance.now() + budgetMs;
    this.limits = limits;
    this.cpuMs = limits.cpuMs;
    this.nav = undefined;
    this.gaveUpNet = false;
    this.consoleErrors = 0;
    for (const p of this.pending.values()) p.bg = false;
  }

  act(a: Action): { minMs?: number; until?: () => boolean; noHistory?: boolean } {
    const win = this.win;
    const env = { win, note: (k: string, m: string) => this.note(k, m) };
    const target = (n: number) => {
      const el = nodeById(win, n);
      if (!el) throw new ActError('stale', `element ${n} is no longer on the page`, 're-read the page and pick it again');
      return el;
    };
    let thrown: unknown;
    const run = (fn: () => void) => {
      this.guard(() => {
        try {
          fn();
        } catch (e) {
          thrown = e;
        }
      });
      if (thrown) throw thrown;
    };
    switch (a.do) {
      case 'click':
        run(() => click(env, target(a.n), this.state));
        return {};
      case 'fill':
        run(() => fill(env, target(a.n), String(a.value), this.state));
        return {};
      case 'select':
        run(() => select(env, target(a.n), String(a.value)));
        return {};
      case 'check':
        run(() => check(env, target(a.n), !!a.on, this.state));
        return {};
      case 'hover':
        run(() => hover(env, target(a.n), this.state));
        return {};
      case 'press':
        run(() => press(env, a.n !== undefined ? target(a.n) : null, String(a.key || 'Enter'), this.state));
        return {};
      case 'scroll': {
        const y = a.to === 'top' ? 0 : a.to === 'bottom' ? 100000 + win.scrollY : Math.max(0, +a.to || 0);
        run(() => this.hooks.scrolled(y));
        return {};
      }
      case 'wait': {
        const ms = typeof a.ms === 'number' && a.ms > 0 ? Math.min(a.ms, 60000) : 0;
        if (a.text) {
          const needle = String(a.text).toLowerCase();
          return { until: () => visibleText(win).toLowerCase().includes(needle), minMs: 0 };
        }
        return { minMs: ms || 1000 };
      }
      case 'back': {
        const sh = win._sessionHistory;
        if (sh && sh._currentIndex > 0) {
          this.backFrom = sh._currentIndex;
          run(() => win.history.back());
          return {};
        }
        return { noHistory: true };
      }
      default:
        throw new ActError('unsupported', `the ghost engine cannot ${(a as any).do}`, "use engine('chrome')");
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clock.clear();
    this.pending.clear();
    this.queued = [];
    this.wakeUp();
    try {
      this.win.close();
    } catch {}
  }
}

function listensForClick(el: any): boolean {
  try {
    const impl = idl.implForWrapper(el);
    const ls = impl && impl._eventListeners;
    if (ls && ((ls.click && ls.click.length) || (ls.mousedown && ls.mousedown.length) || (ls.pointerdown && ls.pointerdown.length) || (ls.mouseup && ls.mouseup.length))) return true;
    if (typeof el.onclick === 'function' || typeof el.onmousedown === 'function') return true;
    for (const k of Object.keys(el)) {
      // React keeps the props of the host component on the element
      if (k.startsWith('__reactProps$')) {
        const p = el[k];
        if (p && (typeof p.onClick === 'function' || typeof p.onMouseDown === 'function' || typeof p.onPointerDown === 'function')) return true;
      } else if (k === '_vei') {
        // Vue 3 event invokers
        const v = el[k];
        if (v && (v.onClick || v.onMousedown || v.onPointerdown)) return true;
      } else if (k === 'l' || k === '__l' || k === '_listeners') {
        // Preact
        const v = el[k];
        if (v && typeof v === 'object' && Object.keys(v).some((x) => /^(click|mousedown|pointerdown)/i.test(x))) return true;
      }
    }
  } catch {}
  return false;
}

/** document text without script, style and template contents (what `wait text` looks at) */
function visibleText(win: any): string {
  const doc = win.document;
  if (!doc.body) return '';
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/;
  const tw = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
  let s = '';
  for (let t = tw.nextNode(); t && s.length < MAX_TEXT; t = tw.nextNode()) {
    const p = t.parentNode;
    if (p && SKIP.test(p.nodeName)) continue;
    s += t.data + ' ';
  }
  return s.replace(/\s+/g, ' ');
}

function countWords(n: LNode): number {
  let words = 0;
  const walk = (x: LNode, depth: number) => {
    if (depth > 400 || words > 1000) return;
    if (x.t === '#text') {
      const m = (x.x || '').match(/\S+/g);
      if (m) words += m.length;
      return;
    }
    if (x.h) return;
    if (x.c) for (const c of x.c) walk(c, depth + 1);
  };
  walk(n, 0);
  return words;
}

function hasControls(n: LNode): boolean {
  const stack = [n];
  while (stack.length) {
    const x = stack.pop()!;
    if (x.t === 'input' || x.t === 'button' || x.t === 'select' || x.t === 'textarea' || (x.t === 'a' && x.a && x.a.href)) return true;
    if (x.c) stack.push(...x.c);
  }
  return false;
}

// ───────────── IPC ─────────────
let current: Page | null = null;
let busy: Promise<void> = Promise.resolve();

const fail = (id: number, e: any) =>
  send({
    t: 'res', id, ok: false,
    code: e instanceof ActError ? e.code : 'internal',
    message: String((e && e.message) || e).slice(0, 400),
    hint: e instanceof ActError ? e.hint : undefined,
  });

async function onLoad(msg: LoadMsg): Promise<void> {
  const t0 = performance.now();
  if (current) current.destroy();
  current = null;
  const page = new Page(msg);
  current = page;
  page.begin(msg.limits, msg.budgetMs - (performance.now() - t0));
  const st = await page.settle(msg.budgetMs - (performance.now() - t0) - 300);
  send(page.result(msg.id, st, true));
}

async function onAct(msg: ActMsg): Promise<void> {
  const page = current;
  if (!page) throw new ActError('gone', 'no page is open');
  const t0 = performance.now();
  page.begin(msg.limits, msg.budgetMs);
  const plan = page.act(msg.action);
  if (plan.noHistory) {
    const st = await page.settle(Math.min(500, msg.budgetMs));
    const r = page.result(msg.id, st, false);
    r.noHistory = true;
    send(r);
    return;
  }
  const st = await page.settle(msg.budgetMs - (performance.now() - t0) - 300, plan);
  if (msg.action.do === 'wait' && msg.action.text && st.stop !== 'found' && !page.nav) page.event(`"${msg.action.text}" did not appear`);
  send(page.result(msg.id, st, false));
}

async function onSnap(msg: SnapMsg): Promise<void> {
  const page = current;
  if (!page) throw new ActError('gone', 'no page is open');
  page.begin(msg.limits, msg.budgetMs);
  const st = await page.settle(Math.min(msg.budgetMs - 300, 2000));
  send(page.result(msg.id, st, false));
}

process.on('message', (m: ToChild) => {
  if (!m || typeof m !== 'object') return;
  if (m.t === 'netr') {
    current?.onReply(m);
    return;
  }
  if (m.t === 'ping') {
    send({ t: 'pong', id: m.id, rssMb: Math.round(process.memoryUsage().rss / 1048576) });
    return;
  }
  const id = (m as any).id;
  const job = m.t === 'load' ? () => onLoad(m) : m.t === 'act' ? () => onAct(m) : m.t === 'snap' ? () => onSnap(m) : null;
  if (!job) return;
  busy = busy.then(job).catch((e) => fail(id, e));
});

process.on('disconnect', () => process.exit(0));
send({ t: 'ready', pid: process.pid });
