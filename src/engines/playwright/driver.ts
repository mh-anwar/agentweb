// One live page in Firefox or WebKit, driven through Playwright. The same job as the chrome
// engine's PageDriver (navigation state, settling, policy on every request, cookie and
// localStorage sync), built on Playwright's events instead of raw CDP.
//
// The in-page code is exactly the chrome engine's (`installHelpers`, `extractPage`), so the LNode
// tree is identical across engines. One difference: Playwright has no public isolated world, so the
// helpers live in the page's main world under non-enumerable names.

import { extractPage, nodeById, type Extracted } from '../../inpage/extract.ts';
import { hash } from '../../tree.ts';
import { AwError, type CookieData, type ErrCode, type SessionCtx, type Verdict } from '../../types.ts';
import { installHelpers, listenerProbe, seedStorage } from '../chrome/inpage.ts';

export interface DriverOptions {
  viewport: { width: number; height: number };
  images: boolean;
  isTracker: (host: string) => boolean;
  probe: boolean;
  netQuietMs: number;
  domQuietMs: number;
  settleCapMs: number;
}

export interface SettleOptions {
  deadline: number;
  since?: number;
  netQuietMs?: number;
  domQuietMs?: number;
  capMs?: number;
}

interface NavOverride {
  method: 'GET' | 'POST';
  body?: string | Uint8Array;
  contentType?: string;
  headers?: Record<string, string>;
}

interface DocInfo {
  status: number;
  mime: string;
  headers: Record<string, string>;
  method: 'GET' | 'POST';
  response: any;
}

const noop = () => {};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Playwright resource types never worth fetching for a text reader */
const BLOCKED_TYPES = new Set(['font', 'media', 'texttrack', 'beacon', 'ping', 'csp_report', 'cspviolationreport', 'prefetch']);
const STREAMING = new Set(['eventsource', 'websocket', 'media']);
const MAX_EVENTS = 20;

/** The page navigated (or went away) while a script was running in it: try again on the new document. */
export function isContextLost(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /Execution context was destroyed|Cannot find context|frame (?:got|was) detached|because of a navigation|navigated|Inspected target navigated|Frame has been detached|context.*(?:was )?(?:destroyed|disposed)|JSHandles can be evaluated only in the context they were created/i.test(m);
}

/** The page, its context or the whole browser is gone. */
export function isClosed(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /Target (?:page, context or browser )?(?:has been )?closed|Browser has been closed|browser has disconnected|Page closed|Context closed|Target crashed|Connection closed/i.test(m);
}

/** Ports every browser refuses (the Fetch standard's "bad ports"). WebKit hangs on them instead of failing. */
const BAD_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);

function badPort(url: string): boolean {
  try {
    const u = new URL(url);
    return !!u.port && /^https?:$/.test(u.protocol) && BAD_PORTS.has(Number(u.port));
  } catch {
    return false;
  }
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return clip(url, 80);
  }
}

function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch {
    return false;
  }
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === lower) delete headers[k];
  headers[name] = value;
}

const cookieKey = (c: CookieData) => `${c.name}\n${c.domain.replace(/^\./, '').toLowerCase()}\n${c.path || '/'}`;
const cookieSig = (c: CookieData) => `${c.value}\n${c.expires === undefined ? '' : Math.round(c.expires)}\n${c.secure ? 1 : 0}${c.httpOnly ? 1 : 0}`;
const isIpOrBare = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || !host.includes('.');

/** Jar cookie -> Playwright cookie. Host-only cookies are set by URL, which is unambiguous in every browser. */
export function cookieToPw(c: CookieData): Record<string, unknown> {
  const host = c.domain.replace(/^\./, '');
  const out: Record<string, unknown> = { name: c.name, value: c.value, secure: !!c.secure, httpOnly: !!c.httpOnly, expires: c.expires ?? -1 };
  if (c.hostOnly || isIpOrBare(host)) {
    out.url = `${c.secure ? 'https' : 'http'}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${c.path || '/'}`;
  } else {
    out.domain = '.' + host;
    out.path = c.path || '/';
  }
  if (c.sameSite && (c.sameSite !== 'None' || c.secure)) out.sameSite = c.sameSite;
  return out;
}

export function cookieFromPw(c: any): CookieData {
  const domain = String(c.domain ?? '');
  const out: CookieData = {
    name: String(c.name ?? ''),
    value: String(c.value ?? ''),
    domain: domain.replace(/^\./, ''),
    path: String(c.path ?? '/'),
    hostOnly: !domain.startsWith('.'),
  };
  if (typeof c.expires === 'number' && c.expires > 0) out.expires = Math.round(c.expires);
  if (c.secure) out.secure = true;
  if (c.httpOnly) out.httpOnly = true;
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') out.sameSite = c.sameSite;
  return out;
}

export class PwDriver {
  readonly page: any;
  readonly context: any;
  readonly opts: DriverOptions;
  readonly name: string;

  ctx: SessionCtx | undefined;

  url = 'about:blank';
  loading = false;
  navSeq = 0;
  docSeq = 0;
  dclAt = 0;
  loadAt = 0;
  doc: DocInfo = { status: 0, mime: '', headers: {}, method: 'GET', response: undefined };
  private pendingDoc: DocInfo | undefined;
  private docMethod: 'GET' | 'POST' = 'GET';
  private forcedPost = false;

  private inflight = new Map<any, { t: number; type: string }>();
  private lastNet = 0;
  private wsLast = 0;
  bytes = 0;

  private boot: string;
  private probeName: string;

  events: string[] = [];
  private pageErrors = 0;
  policy: { url: string; reason: string } | undefined;
  /** a redirect hop the guard refused after the browser had already followed it: this page must not be reused */
  tainted = '';
  download: { url: string; name: string } | undefined;
  navError = '';
  crashed = '';
  popupUrl = '';
  /** popups whose address is not known yet: settling waits for them */
  private popupsPending = 0;
  private acting = false;
  private preapproved = '';
  private navOverride: NavOverride | undefined;
  private noisyDoc = -1;
  private subVerdicts = new Map<string, Promise<Verdict>>();
  private blockedOrigins = new Set<string>();
  chooser: ((fc: any) => void) | undefined;

  private cookieState: Map<string, { sig: string; c: CookieData; raw: any }> | undefined;
  private refused = new Map<string, string>();
  private storageSigs = new Map<string, string>();
  private seeds: Record<string, Record<string, string>> = {};
  private seedScript: any;
  private seedOp: Promise<void> = Promise.resolve();
  counters = { trackers: 0, blocked: 0, requests: 0 };

  constructor(name: string, context: any, page: any, opts: DriverOptions) {
    this.name = name;
    this.context = context;
    this.page = page;
    this.opts = opts;
    this.probeName = 'aw' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    // Node ids start at a random multiple of a million in every document (see the chrome engine).
    // The helpers are hidden from enumeration: this world is shared with the page's own scripts.
    this.boot =
      `(()=>{var __name=(f)=>f;` +
      `if(!self.__aw)Object.defineProperty(self,'__aw',{value:{ids:new WeakMap(),nodes:new Map(),next:(1+Math.floor(Math.random()*4e6))*1e6+1},enumerable:false,configurable:true,writable:true});` +
      `(${installHelpers.toString()})(self);` +
      `Object.defineProperty(self,'__awx',{value:${extractPage.toString()},enumerable:false,configurable:true,writable:true});` +
      `Object.defineProperty(self,'__awn',{value:${nodeById.toString()},enumerable:false,configurable:true,writable:true});` +
      `try{Object.defineProperty(self,'__awh',{value:self.__awh,enumerable:false,configurable:true,writable:true})}catch(e){}})()`;
    this.wire();
  }

  /** Before the first navigation: request policy, the click-listener probe, dialogs, popups. */
  async init(): Promise<void> {
    const tasks: Promise<unknown>[] = [this.context.route('**/*', (route: any) => void this.onRoute(route))];
    if (this.opts.probe) tasks.push(this.context.addInitScript({ content: `(${listenerProbe.toString()})(self,${JSON.stringify(this.probeName)})` }));
    await Promise.all(tasks);
  }

  dispose(): void {
    this.chooser = undefined;
  }

  private isMain(frame: any): boolean {
    try {
      return frame === this.page.mainFrame();
    } catch {
      return false;
    }
  }

  private mainNav(req: any): boolean {
    try {
      return req.isNavigationRequest() && this.isMain(req.frame());
    } catch {
      return false; // service worker requests have no frame
    }
  }

  private wire(): void {
    const p = this.page;
    p.on('request', (req: any) => {
      const now = Date.now();
      this.lastNet = now;
      this.counters.requests++;
      const type = String(req.resourceType?.() ?? 'other');
      this.inflight.set(req, { t: now, type });
      const redirected = req.redirectedFrom?.();
      if (this.mainNav(req)) {
        if (!redirected) {
          this.loading = true;
          this.navSeq++;
          this.dclAt = 0;
          this.loadAt = 0;
          this.navError = '';
        }
        this.docMethod = req.method() === 'POST' ? 'POST' : 'GET';
        if (redirected) this.forcedPost = false;
      }
      // Playwright does not route redirect hops: they are checked here, as the browser follows them.
      if (redirected) void this.checkHop(req);
    });
    p.on('response', (res: any) => {
      let req: any;
      try {
        req = res.request();
      } catch {
        return;
      }
      const headers: Record<string, string> = {};
      try {
        const h = res.headers();
        for (const k in h) headers[k.toLowerCase()] = String(h[k]);
      } catch {}
      this.bytes += Number(headers['content-length']) || 0;
      if (STREAMING.has(String(req.resourceType?.() ?? ''))) this.inflight.delete(req);
      if (!this.mainNav(req)) return;
      const status = Number(res.status()) || 0;
      if (status >= 300 && status < 400 && headers.location) return; // a hop, not the document
      this.pendingDoc = {
        status,
        mime: String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(),
        headers,
        method: this.forcedPost ? 'POST' : this.docMethod,
        response: res,
      };
      // "204 No Content" (our own policy answer among them) does not replace the page
      if (status === 204 || status === 205) this.loading = false;
    });
    p.on('requestfinished', (req: any) => {
      this.inflight.delete(req);
      this.lastNet = Date.now();
    });
    p.on('requestfailed', (req: any) => {
      this.inflight.delete(req);
      this.lastNet = Date.now();
      if (this.mainNav(req)) {
        const err = String(req.failure?.()?.errorText ?? '');
        if (err && !/abort|cancel/i.test(err)) this.navError = err;
        this.loading = false;
      }
    });
    p.on('framenavigated', (frame: any) => {
      if (!this.isMain(frame)) return;
      const url = String(frame.url() ?? '');
      const pending = this.pendingDoc;
      this.url = url;
      if (!pending) return; // same-document navigation (history API, fragment)
      this.pendingDoc = undefined;
      this.docSeq++;
      this.dclAt = 0;
      this.loadAt = 0;
      this.doc = pending;
      this.forcedPost = false;
      for (const [r, x] of this.inflight) if (x.type !== 'document' && Date.now() - x.t > 50) this.inflight.delete(r);
      this.lastNet = Date.now();
      const origin = originOf(url);
      if (origin && this.seeds[origin]) {
        delete this.seeds[origin];
        this.installSeeds();
      }
    });
    p.on('domcontentloaded', () => {
      this.dclAt = Date.now();
    });
    p.on('load', () => {
      this.loadAt = Date.now();
      this.loading = false;
    });
    p.on('dialog', (d: any) => {
      const type = String(d.type?.() ?? 'alert');
      const msg = clip(oneLine(d.message?.()), 200);
      void d.accept(type === 'prompt' ? '' : undefined).catch(noop);
      if (type === 'beforeunload') this.note('the page asked to confirm leaving; accepted');
      else if (type === 'prompt') this.note(`prompt "${msg}" answered with an empty string`);
      else if (type === 'confirm') this.note(`confirm "${msg}" accepted`);
      else this.note(`alert "${msg}"`);
    });
    p.on('download', (dl: any) => {
      const name = clip(oneLine(dl.suggestedFilename?.()) || 'file', 80);
      const url = String(dl.url?.() ?? '');
      this.download = { url, name };
      this.loading = false;
      void dl.cancel?.().catch(noop);
      this.note(`download blocked: ${name} (${clip(url, 160)})`);
    });
    p.on('filechooser', (fc: any) => {
      const waiter = this.chooser;
      if (waiter) {
        this.chooser = undefined;
        waiter(fc);
      } else this.note('a file chooser opened and was dismissed; use upload on that control');
    });
    p.on('pageerror', (err: any) => {
      if (this.pageErrors >= 5) return;
      this.pageErrors++;
      const text = oneLine(err?.message ?? err ?? 'error').split(' at ')[0];
      this.note(`page error: ${clip(text, 160)}`);
    });
    p.on('crash', () => {
      this.crashed = 'the page crashed';
      this.note('the page crashed');
    });
    p.on('close', () => {
      if (!this.crashed) this.crashed = 'the page was closed';
    });
    p.on('websocket', (ws: any) => {
      const sock = () => {
        this.wsLast = Date.now();
      };
      sock();
      ws.on('framesent', sock);
      ws.on('framereceived', sock);
    });
  }

  /** A popup was opened from this page. It is closed; the agent's own action follows it here. */
  async popup(pg: any): Promise<void> {
    let url = '';
    this.popupsPending++;
    try {
      url = String(pg.url() ?? '');
      if (!/^https?:/i.test(url)) {
        const req = await pg.waitForEvent('request', { timeout: 2500 }).catch(() => undefined);
        url = req ? String(req.url()) : String(pg.url() ?? '');
      }
    } catch {
    } finally {
      this.popupsPending--;
    }
    void pg.close().catch(noop);
    if (!/^https?:/i.test(url)) return;
    if (this.acting) this.popupUrl = url;
    else this.note(`the page tried to open a new window: ${clip(url, 160)}`);
  }

  note(text: string): void {
    if (this.events.length >= MAX_EVENTS) return;
    if (this.events[this.events.length - 1] === text) return;
    this.events.push(text);
  }

  // ───────────────────────────── policy ─────────────────────────────

  private async onRoute(route: any): Promise<void> {
    const req = route.request();
    const url: string = req.url();
    const abort = () => route.abort('blockedbyclient').catch(noop);
    let mainDoc = false;
    try {
      if (!/^https?:/i.test(url)) {
        await route.continue().catch(noop);
        return;
      }
      const type = String(req.resourceType() ?? 'other').toLowerCase();
      mainDoc = this.mainNav(req);
      if (!mainDoc) {
        if (BLOCKED_TYPES.has(type) || (type === 'image' && !this.opts.images)) {
          this.counters.blocked++;
          await abort();
          return;
        }
        let host = '';
        try {
          host = new URL(url).hostname;
        } catch {}
        if (host && this.opts.isTracker(host)) {
          this.counters.trackers++;
          await abort();
          return;
        }
      }
      const guard = this.ctx?.guard;
      if (mainDoc) {
        let v: Verdict = { ok: true };
        if (this.preapproved && sameUrl(this.preapproved, url)) this.preapproved = '';
        else if (guard) v = await guard.checkUrl(url, req.method() === 'POST' ? 'submit' : 'open');
        if (!v.ok) {
          this.policy = { url, reason: v.reason };
          this.navOverride = undefined;
          await route.fulfill({ status: 204, body: '' }).catch(noop);
          return;
        }
        if (v.warn) this.note(clip(v.warn, 200));
        const origin = originOf(url);
        if (origin) this.subVerdicts.set(origin, Promise.resolve({ ok: true }));
        const o = this.navOverride;
        if (o) {
          this.navOverride = undefined;
          const headers: Record<string, string> = { ...(req.headers() ?? {}) };
          if (o.headers) for (const k in o.headers) setHeader(headers, k, o.headers[k]);
          const params: Record<string, unknown> = {};
          if (o.method === 'POST') {
            params.method = 'POST';
            params.postData = typeof o.body === 'string' ? Buffer.from(o.body, 'utf8') : Buffer.from(o.body ?? new Uint8Array());
            setHeader(headers, 'Content-Type', o.contentType ?? 'application/x-www-form-urlencoded');
            this.forcedPost = true;
          }
          params.headers = headers;
          await route.continue(params).catch(noop);
          return;
        }
        await route.continue().catch(noop);
        return;
      }
      const v = await this.subVerdict(url);
      if (!v.ok) {
        this.refusedSub(url, v.reason);
        await abort();
        return;
      }
      await route.continue().catch(noop);
    } catch (e) {
      if (mainDoc) this.policy = { url, reason: `policy check failed: ${(e as Error).message}` };
      await abort();
    }
  }

  private subVerdict(url: string): Promise<Verdict> {
    const origin = originOf(url);
    let pending = this.subVerdicts.get(origin);
    if (!pending) {
      const guard = this.ctx?.guard;
      pending = guard ? guard.checkUrl(url, 'sub').catch((e) => ({ ok: false as const, reason: `guard failed: ${(e as Error).message}` })) : Promise.resolve({ ok: true as const });
      if (this.subVerdicts.size > 2000) this.subVerdicts.clear();
      this.subVerdicts.set(origin, pending);
    }
    return pending;
  }

  private refusedSub(url: string, reason: string): void {
    const origin = originOf(url);
    this.counters.blocked++;
    if (!this.blockedOrigins.has(origin) && this.blockedOrigins.size < 50) {
      this.blockedOrigins.add(origin);
      this.note(`requests to ${origin} refused by policy: ${clip(reason, 120)}`);
    }
  }

  /** A redirect hop the browser is following. A refusal stops the page and retires it. */
  private async checkHop(req: any): Promise<void> {
    const url = String(req.url());
    if (!/^https?:/i.test(url)) return;
    const guard = this.ctx?.guard;
    if (!guard) return;
    const main = this.mainNav(req);
    let v: Verdict;
    try {
      v = main ? await guard.checkUrl(url, 'redirect') : await this.subVerdict(url);
    } catch (e) {
      v = { ok: false, reason: `policy check failed: ${(e as Error).message}` };
    }
    if (v.ok) {
      if (main) {
        const origin = originOf(url);
        if (origin) this.subVerdicts.set(origin, Promise.resolve({ ok: true }));
      }
      return;
    }
    if (!main) {
      this.refusedSub(url, v.reason);
      return;
    }
    this.policy = { url, reason: v.reason };
    this.tainted = v.reason;
    void this.page.evaluate('window.stop()').catch(noop);
  }

  // ───────────────────────────── calls ─────────────────────────────

  begin(ctx: SessionCtx): void {
    this.ctx = ctx;
    this.policy = undefined;
    this.download = undefined;
    this.navError = '';
    this.popupUrl = '';
    this.pageErrors = 0;
  }

  refusal(): string | undefined {
    return this.policy?.reason;
  }

  setActing(on: boolean): void {
    this.acting = on;
  }

  takeEvents(): string[] {
    return this.events.splice(0);
  }

  expect(url: string, override?: NavOverride): void {
    this.preapproved = url;
    this.navOverride = override;
  }

  async navigate(url: string, referer: string | undefined, deadline: number): Promise<void> {
    const left = Math.max(500, deadline - Date.now());
    if (badPort(url)) throw new AwError('net', `could not load ${clip(url, 120)}: UNSAFE_PORT (browsers refuse this port)`);
    try {
      await this.page.goto(url, { referer, waitUntil: 'commit', timeout: left });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (this.policy) throw new AwError('policy', this.policy.reason);
      if (/Timeout .*exceeded/i.test(msg)) {
        void this.page.evaluate('window.stop()').catch(noop);
        throw new AwError('timeout', `${hostOf(url)} did not answer in ${Math.round(left / 1000)} s`);
      }
      if (/Download is starting/i.test(msg) || this.download) {
        throw new AwError('unsupported', `that URL is a file download (${this.download?.name ?? 'file'}), which the browser tier does not keep`, 'open it without the browser tier');
      }
      if (isClosed(e)) throw new AwError('gone', 'the browser page went away');
      if (/invalid url|Cannot navigate to invalid/i.test(msg)) throw new AwError('bad_request', `not a URL the browser can open: ${clip(url, 120)}`);
      // 204/205 and navigations that were replaced or cancelled: whatever is on screen stays
      const failed = await this.errorPage();
      if (failed) throw new AwError('net', `could not load ${clip(url, 120)}: ${failed}`);
      if (/NS_BINDING_ABORTED|ERR_ABORTED|frame was detached|Navigation interrupted|interrupted by another navigation|cancelled|Load request cancelled/i.test(msg)) {
        if (this.doc.status === 204 || this.pendingDoc?.status === 204) return;
        if (this.url !== 'about:blank') return;
        throw new AwError('net', `${hostOf(url)} answered without a document (navigation aborted)`);
      }
      const code = (/(NS_ERROR_[A-Z_]+|net::ERR_[A-Z_]+)/.exec(msg)?.[1] ?? oneLine(msg.replace(/^page\.goto:\s*/i, '').split('\n')[0])).replace(/^net::/, '');
      throw new AwError('net', `could not load ${clip(url, 120)}: ${clip(code, 120)}`);
    } finally {
      this.preapproved = '';
      this.navOverride = undefined;
    }
    if (this.policy) throw new AwError('policy', this.policy.reason);
  }

  /** Wait until a navigation after `seq` has started (or a popup opened), at most `ms`. */
  async waitNav(seq: number, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.navSeq !== seq || this.popupUrl || this.policy || this.download || this.crashed) return true;
      await sleep(15);
    }
    return false;
  }

  /** Firefox shows its own error page at the URL that failed; this names the error when that is on screen. */
  async errorPage(): Promise<string | undefined> {
    const uri = String(await this.page.evaluate('document.documentURI').catch(() => ''));
    if (!/^about:(neterror|certerror|blocked|httpsonlyerror)/i.test(uri)) return undefined;
    const e = /[?&]e=([^&]+)/.exec(uri)?.[1];
    return e ? decodeURIComponent(e) : uri.split('?')[0];
  }

  // ───────────────────────────── settling ─────────────────────────────

  private loaded(now: number): boolean {
    if (!this.loading) return true;
    if (this.loadAt) return true;
    return this.dclAt > 0 && now - this.dclAt > 3000;
  }

  private netIdle(now: number, since: number): number {
    if (this.wsLast && now - this.wsLast < 1200) return 0;
    for (const [r, x] of this.inflight) {
      if (STREAMING.has(x.type)) continue;
      const age = now - x.t;
      if (age > 30_000) this.inflight.delete(r);
      else if (age <= 2000) return 0;
    }
    return now - Math.max(this.lastNet, since);
  }

  /** Wait until the page has loaded and both network and DOM have been quiet for a moment (see the chrome engine). */
  async settle(o: SettleOptions): Promise<void> {
    const netQuiet = o.netQuietMs ?? this.opts.netQuietMs;
    const domQuiet = o.domQuietMs ?? this.opts.domQuietMs;
    const since = o.since ?? 0;
    let cap = o.capMs ?? this.opts.settleCapMs;
    let loadedAt = 0;
    let loadedSeq = -1;
    const started = Date.now();
    for (;;) {
      const now = Date.now();
      if (this.crashed) throw new AwError('gone', this.crashed);
      if (this.popupUrl) await this.followPopup(o.deadline);
      if (now >= o.deadline) {
        this.note(`the page had not settled after ${Math.max(1, Math.round((now - started) / 1000))} s; this may be incomplete`);
        return;
      }
      if (!this.loaded(now) || this.popupsPending) {
        await sleep(Math.min(20, o.deadline - now));
        continue;
      }
      if (loadedSeq !== this.navSeq) {
        loadedSeq = this.navSeq;
        loadedAt = now;
        if (this.noisyDoc === this.docSeq) cap = Math.min(cap, 600);
      }
      const end = Math.min(o.deadline, loadedAt + (this.wsLast > loadedAt ? Math.max(cap, 9000) : cap));
      if (now >= end) {
        if (now >= o.deadline) continue;
        if (this.noisyDoc !== this.docSeq) {
          this.noisyDoc = this.docSeq;
          this.note('the page keeps changing on its own; read it as a snapshot in time');
        }
        return;
      }
      const idle = this.netIdle(now, since);
      if (idle < netQuiet) {
        await sleep(Math.max(5, Math.min(netQuiet - idle, 50, end - now)));
        continue;
      }
      const seq = this.navSeq;
      let quiet = false;
      try {
        quiet = await this.run<boolean>(`__awh.quiet(${domQuiet},${Math.max(10, end - now)})`, { timeoutMs: end - now + 2000 });
      } catch (e) {
        if (isContextLost(e)) {
          await sleep(15);
          continue;
        }
        if (e instanceof AwError && e.code === 'timeout') continue;
        throw e;
      }
      if (!quiet) continue;
      const after = Date.now();
      if (seq === this.navSeq && this.loaded(after) && this.netIdle(after, since) >= netQuiet && !this.popupUrl) return;
    }
  }

  private async followPopup(deadline: number): Promise<void> {
    const url = this.popupUrl;
    this.popupUrl = '';
    if (!url) return;
    this.note(`a new tab was opened; following it here: ${clip(url, 160)}`);
    try {
      await this.navigate(url, undefined, deadline);
    } catch (e) {
      if (e instanceof AwError && e.code === 'policy') throw e;
      this.note(`could not open it: ${clip((e as Error).message, 160)}`);
    }
  }

  // ───────────────────────────── page scripts ─────────────────────────────

  private withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
    if (!ms || ms <= 0) return p;
    let t: NodeJS.Timeout;
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        t = setTimeout(() => reject(new AwError('timeout', 'the page did not answer in time (its main thread may be busy)')), ms);
      }),
    ]).finally(() => clearTimeout(t));
  }

  private mapEvalError(e: unknown): unknown {
    if (e instanceof AwError) return e;
    if (isContextLost(e)) return e;
    if (isClosed(e)) return new AwError('gone', this.crashed || 'the browser page went away');
    const msg = e instanceof Error ? e.message : String(e);
    return new AwError('internal', `page script failed: ${clip(oneLine(msg.replace(/^page\.evaluate(?:Handle)?:\s*/i, '')), 300)}`);
  }

  /** Evaluate an expression in the main frame, installing the helpers first if this document lacks them. */
  async run<T = any>(expr: string, o: { timeoutMs?: number; handle?: boolean } = {}): Promise<T> {
    const wrapped = `typeof __awh==="undefined"?"\\u0001boot":(${expr})`;
    for (let attempt = 0; ; attempt++) {
      let r: any;
      try {
        r = await this.withTimeout(o.handle ? this.page.evaluateHandle(wrapped) : this.page.evaluate(wrapped), o.timeoutMs ?? 30_000);
      } catch (e) {
        throw this.mapEvalError(e);
      }
      let boot = r === '\u0001boot';
      if (o.handle && r) {
        const v = await r.jsonValue().catch(() => undefined);
        boot = v === '\u0001boot';
        if (boot) void r.dispose().catch(noop);
      }
      if (boot && attempt < 2) {
        try {
          await this.page.evaluate(this.boot);
        } catch (e) {
          throw this.mapEvalError(e);
        }
        continue;
      }
      return r as T;
    }
  }

  async call<T = any>(name: string, ...args: unknown[]): Promise<T> {
    const expr = `__awh.${name}(${args.map((a) => JSON.stringify(a ?? null)).join(',')})`;
    let last: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await this.run<any>(expr);
        if (r && typeof r === 'object' && typeof r.err === 'string') throw new AwError(r.err as ErrCode, String(r.msg ?? r.err), r.hint ? String(r.hint) : undefined);
        return r as T;
      } catch (e) {
        if (!isContextLost(e)) throw e;
        last = e;
        await sleep(30);
      }
    }
    throw last instanceof AwError ? last : new AwError('internal', 'the page kept navigating while it was being used');
  }

  async extract(deadline: number): Promise<Extracted> {
    const opts = JSON.stringify({ layout: true, probe: this.opts.probe ? this.probeName : undefined });
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        const r = await this.run<Extracted>(`__awx(window,${opts})`, { timeoutMs: Math.max(3000, deadline - Date.now() + 3000) });
        if (r && r.root) return r;
        last = new AwError('internal', 'the page returned no document');
      } catch (e) {
        if (!isContextLost(e)) throw e;
        last = e;
      }
      await this.settle({ deadline: Math.max(deadline, Date.now() + 1500), capMs: 1500 });
    }
    throw last instanceof AwError ? last : new AwError('internal', 'could not read the page');
  }

  /** The body of a non-HTML main document, as the server sent it. */
  async documentBody(): Promise<{ text?: string; bytes?: Uint8Array } | undefined> {
    const res = this.doc.response;
    if (!res) return undefined;
    try {
      const buf: Buffer = await this.withTimeout(res.body(), 10_000);
      const mime = this.doc.mime;
      if (/^text\/|json|xml|javascript|csv/.test(mime)) return { text: buf.toString('utf8') };
      return { bytes: new Uint8Array(buf) };
    } catch {
      return undefined;
    }
  }

  // ───────────────────────────── cookies ─────────────────────────────

  private async readCookies(): Promise<{ map: Map<string, { sig: string; c: CookieData; raw: any }>; list: CookieData[] }> {
    const raw: any[] = await this.context.cookies();
    const map = new Map<string, { sig: string; c: CookieData; raw: any }>();
    const list: CookieData[] = [];
    for (const r of raw ?? []) {
      const c = cookieFromPw(r);
      if (!c.name && !c.value) continue;
      list.push(c);
      map.set(cookieKey(c), { sig: cookieSig(c), c, raw: r });
    }
    return { map, list };
  }

  /** Jar -> browser: what the jar added or changed is set, what it dropped is deleted. */
  async cookiesIn(ctx: SessionCtx): Promise<void> {
    const nowSec = Date.now() / 1000;
    const want = new Map<string, { sig: string; c: CookieData }>();
    for (const c of ctx.jar.all()) {
      if (!c || !c.name || !c.domain) continue;
      if (c.expires !== undefined && c.expires <= nowSec) continue;
      want.set(cookieKey(c), { sig: cookieSig(c), c });
    }
    const have = this.cookieState ?? new Map<string, { sig: string; c: CookieData; raw: any }>();
    const toSet: { k: string; sig: string; c: CookieData }[] = [];
    for (const [k, w] of want) if (have.get(k)?.sig !== w.sig && this.refused.get(k) !== w.sig) toSet.push({ k, sig: w.sig, c: w.c });
    const toDelete: any[] = [];
    for (const [k, h] of have) if (!want.has(k)) toDelete.push(h.raw);
    if (!toSet.length && !toDelete.length) {
      this.cookieState = have;
      return;
    }
    for (const r of toDelete) await this.context.clearCookies({ name: r.name, domain: r.domain, path: r.path }).catch(noop);
    if (toSet.length) {
      const params = toSet.map((x) => cookieToPw(x.c));
      try {
        await this.context.addCookies(params);
      } catch {
        for (const p of params) await this.context.addCookies([p]).catch(noop);
      }
    }
    const now = (await this.readCookies()).map;
    for (const x of toSet) if (!now.has(x.k)) this.refused.set(x.k, x.sig);
    this.cookieState = now;
  }

  /** Browser -> jar. Cookies the site removed are expired in the jar so they do not come back. */
  async cookiesOut(ctx: SessionCtx): Promise<void> {
    const { map, list } = await this.readCookies();
    if (this.cookieState) {
      for (const [k, h] of this.cookieState) {
        if (map.has(k)) continue;
        try {
          ctx.jar.set({ ...h.c, value: '', expires: 1 });
        } catch {}
      }
    }
    if (list.length) ctx.jar.merge(list);
    this.cookieState = map;
  }

  // ───────────────────────────── localStorage ─────────────────────────────

  private static sigOf(items: Record<string, string>): string {
    const keys = Object.keys(items).sort();
    let s = '';
    for (const k of keys) s += k + '\u0001' + items[k] + '\u0002';
    return keys.length + ':' + s.length + ':' + hash(s);
  }

  private installSeeds(): void {
    this.seedOp = this.seedOp
      .then(async () => {
        const old = this.seedScript;
        this.seedScript = undefined;
        if (old && typeof old.dispose === 'function') await old.dispose().catch(noop);
        if (!Object.keys(this.seeds).length) return;
        const content = `(${seedStorage.toString()})(self,${JSON.stringify(this.seeds)})`;
        this.seedScript = await this.context.addInitScript({ content });
      })
      .catch(noop);
  }

  async storageIn(ctx: SessionCtx): Promise<void> {
    const here = originOf(this.url);
    let seedsChanged = false;
    for (const origin of Object.keys(ctx.storage ?? {})) {
      const items = ctx.storage[origin];
      if (!items || typeof items !== 'object') continue;
      const sig = PwDriver.sigOf(items);
      if (this.storageSigs.get(origin) === sig) continue;
      this.storageSigs.set(origin, sig);
      if (origin === here) {
        await this.call('setStorage', items).catch(noop);
      } else {
        this.seeds[origin] = { ...items };
        seedsChanged = true;
      }
    }
    if (seedsChanged) this.installSeeds();
    await this.seedOp;
  }

  async storageOut(ctx: SessionCtx): Promise<void> {
    let r: { origin: string; items: Record<string, string> | null } | undefined;
    try {
      r = await this.call('storage');
    } catch {
      return;
    }
    if (!r || !r.origin || r.origin === 'null' || !r.items) return;
    if (!/^https?:/i.test(r.origin)) return;
    if (Object.keys(r.items).length) ctx.storage[r.origin] = r.items;
    else delete ctx.storage[r.origin];
    this.storageSigs.set(r.origin, PwDriver.sigOf(r.items));
  }
}
