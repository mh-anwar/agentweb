// Everything the engine knows about one live page: where it is in a navigation, which requests
// are in flight, the isolated world the extractor runs in, the policy decisions made for it, and
// what happened that the agent should hear about.

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { release as osRelease } from 'node:os';
import { join } from 'node:path';
import { extractPage, nodeById, type Extracted } from '../../inpage/extract.ts';
import { hash } from '../../tree.ts';
import { AwError, type CookieData, type Emulation, type ErrCode, type SessionCtx, type Verdict } from '../../types.ts';
import { isContextLost, type Cdp, type CdpSession } from './cdp.ts';
import { basicFor, buildHar, cdpPermissions, mayAnswer, matchRoute, mockResponse, rememberChallenge, THROTTLE, type HarRow } from '../../netcontrol.ts';
import { installHelpers, listenerProbe, seedStorage, webmcpShim, WEBMCP_LIST } from './inpage.ts';

export const WORLD = 'agentweb';

export interface DriverOptions {
  viewport: { width: number; height: number };
  images: boolean;
  isTracker: (host: string) => boolean;
  /** main-world probe for click listeners */
  probe: boolean;
  netQuietMs: number;
  domQuietMs: number;
  /** after the page has loaded, wait at most this long for it to go quiet */
  settleCapMs: number;
  defaultUserAgent: string;
  /** the browser's real full version ("156.0.8078.4"), for the client hints that go with the user agent */
  browserVersion?: string;
  /** the pages live in the user's own browser profile: leave its cookies, storage and download settings alone */
  shared?: boolean;
  /** where downloads are kept (one folder per session); false refuses them */
  downloadDir?: string | false;
  /** how a dialog is answered until the agent says otherwise */
  maxDownloadBytes?: number;
}

export interface SettleOptions {
  /** absolute time (ms) by which we must return whatever is there */
  deadline: number;
  /** quiet windows start here: activity before the action does not count as "after it" */
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

/** a request seen by the Network domain: what network() prints and network(har=) saves */
interface NetRow {
  method: string;
  url: string;
  type: string;
  status: number;
  failed: string;
  wall?: number;
  ts?: number;
  ms?: number;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  mime?: string;
  statusText?: string;
  protocol?: string;
  size?: number;
  post?: string;
}

interface DocInfo {
  status: number;
  mime: string;
  headers: Record<string, string>;
  method: 'GET' | 'POST';
  requestId: string;
}

const noop = () => {};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

const BLOCKED_TYPES = new Set(['Font', 'Media', 'TextTrack', 'Ping', 'CSPViolationReport', 'Prefetch']);
/** request kinds that never stop on their own and so cannot hold up "network quiet" */
const STREAMING = new Set(['EventSource', 'WebSocket', 'Ping', 'Media']);
const MAX_EVENTS = 20;

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
}

const cookieKey = (c: CookieData) => `${c.name}\n${c.domain.replace(/^\./, '').toLowerCase()}\n${c.path || '/'}`;
const cookieSig = (c: CookieData) => `${c.value}\n${c.expires === undefined ? '' : Math.round(c.expires)}\n${c.secure ? 1 : 0}${c.httpOnly ? 1 : 0}`;
const isIpOrBare = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || !host.includes('.');

export function cookieToCdp(c: CookieData): Record<string, unknown> {
  const host = c.domain.replace(/^\./, '');
  const out: Record<string, unknown> = {
    name: c.name,
    value: c.value,
    // CDP: a leading dot makes a domain cookie, none makes it host-only
    domain: c.hostOnly || isIpOrBare(host) ? host : '.' + host,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
  };
  if (c.expires !== undefined) out.expires = c.expires;
  if (c.sameSite && (c.sameSite !== 'None' || c.secure)) out.sameSite = c.sameSite;
  return out;
}

export function cookieFromCdp(c: any): CookieData {
  const domain = String(c.domain ?? '');
  const out: CookieData = {
    name: String(c.name ?? ''),
    value: String(c.value ?? ''),
    domain: domain.replace(/^\./, ''),
    path: String(c.path ?? '/'),
    hostOnly: !domain.startsWith('.'),
  };
  if (!c.session && typeof c.expires === 'number' && c.expires > 0) out.expires = Math.round(c.expires);
  if (c.secure) out.secure = true;
  if (c.httpOnly) out.httpOnly = true;
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') out.sameSite = c.sameSite;
  return out;
}

/** hot-reload / live-reload sockets of development servers */
export function isDevSocket(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (/\/_next\/(webpack-hmr|hmr)|\/__webpack_hmr|\/sockjs-node|\/__vite|\/@vite|\/__turbopack|\/livereload|\/browser-sync\/|\/__parcel|\/_nuxt\/|\/__hmr|\/_hmr/i.test(u.pathname)) return true;
  // generic paths (webpack-dev-server's /ws, Vite's /?token=…) only count on a local address
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|.*\.localhost|.*\.local)$/i.test(u.hostname);
  return local && (/^\/(ws|hmr)?$/.test(u.pathname) || u.searchParams.has('token'));
}

/** An error or warning the page produced, kept for expect(console=0) and expect(requests=0) (src/checks). */
export interface Problem {
  /** which document of this page it belongs to (PageDriver.docSeq when it happened) */
  doc: number;
  /** the address of that document */
  page: string;
  kind: 'console' | 'request';
  level: 'error' | 'warning';
  text: string;
}

/** What agentweb itself blocks (trackers, fonts, images, policy) fails like any other request: that is not the page's fault. */
const OUR_BLOCK = /ERR_BLOCKED_BY_CLIENT/;

export class PageDriver {
  readonly cdp: Cdp;
  readonly s: CdpSession;
  readonly contextId: string;
  readonly targetId: string;
  readonly opts: DriverOptions;
  mainFrame: string;

  /** the session currently (or last) served; its guard answers for requests made between calls too */
  ctx: SessionCtx | undefined;

  // navigation of the main frame
  url = 'about:blank';
  loading = false;
  navSeq = 0;
  docSeq = 0;
  dclAt = 0;
  loadAt = 0;
  doc: DocInfo = { status: 0, mime: '', headers: {}, method: 'GET', requestId: '' };

  // network
  private inflight = new Map<string, { t: number; type: string; loader: string }>();
  private lastNet = 0;
  /** last WebSocket activity (created, frame in or out) */
  private wsLast = 0;
  bytes = 0;
  private responses = new Map<string, { status: number; mime: string; headers: Record<string, string> }>();
  private docMethods = new Map<string, 'GET' | 'POST'>();
  /** navigations we turned into a POST ourselves (the Network domain may still report the original GET) */
  private forcedPost = new Set<string>();

  // isolated world
  private isoCtx = 0;
  private boot: string;
  private probeName: string;

  // per-call state
  events: string[] = [];
  private pageErrors = 0;
  policy: { url: string; reason: string } | undefined;
  download: { url: string; name: string } | undefined;
  navError = '';
  crashed = '';
  popupUrl = '';
  private acting = false;
  private preapproved = '';
  private navOverride: NavOverride | undefined;
  private noisyDoc = -1;
  private subVerdicts = new Map<string, Promise<Verdict>>();
  private blockedOrigins = new Set<string>();
  chooser: ((p: any) => void) | undefined;

  // what the page said and did, for console() and network(): reset when a new document loads
  private consoleLog: { type: string; text: string }[] = [];
  /** errors and warnings of every document this page showed (the console log above starts over with each) */
  problems: Problem[] = [];
  private netLog = new Map<string, NetRow>();
  private authTried = new Set<string>();
  /** origin of the last main-frame request: a credentials prompt from it is the page's own */
  private navOrigin = '';
  /** how JS dialogs are answered (the agent changes it with dialog()) */
  dialogAnswer: { accept: boolean; text: string } = { accept: true, text: '' };
  private downloads = new Map<string, { name: string; url: string; state: 'running' | 'done' | 'failed'; path: string; bytes: number }>();
  private downloadWaiters: (() => void)[] = [];
  private offDownloads: (() => void) | undefined;
  private downloadPath = '';
  private emuSig = '{}';
  private granted = false;
  private langSig = '';
  /** the viewport in effect (the default, or what emulate() set) */
  viewport: { width: number; height: number };

  // state mirrored from the session
  private cookieState: Map<string, { sig: string; c: CookieData }> | undefined;
  /** jar cookies the browser would not take (key -> signature), so they are not retried on every call */
  private refused = new Map<string, string>();
  private storageSigs = new Map<string, string>();
  private seeds: Record<string, Record<string, string>> = {};
  private seedScript = '';
  private seedOp: Promise<void> = Promise.resolve();
  private userAgent = '';
  tmpDirs: string[] = [];
  counters = { trackers: 0, blocked: 0, requests: 0 };

  constructor(cdp: Cdp, session: CdpSession, contextId: string, targetId: string, opts: DriverOptions) {
    this.cdp = cdp;
    this.s = session;
    this.contextId = contextId;
    this.targetId = targetId;
    this.mainFrame = targetId;
    this.opts = opts;
    this.viewport = opts.viewport;
    this.probeName = 'aw' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    // Node ids start at a random multiple of a million in every document, so an id from an earlier
    // page (or from before an eviction) can never resolve to an element of this one.
    this.boot =
      `(()=>{var __name=(f)=>f;` +
      `if(!self.__aw)self.__aw={ids:new WeakMap(),nodes:new Map(),next:(1+Math.floor(Math.random()*4e6))*1e6+1};` +
      `(${installHelpers.toString()})(self);` +
      `self.__awx=${extractPage.toString()};` +
      `self.__awn=${nodeById.toString()};})()`;
    this.wire();
  }

  // ───────────────────────────── setup ─────────────────────────────

  /** Runs while the page is still paused: nothing has loaded, so every hook is in place first. */
  async init(): Promise<void> {
    const s = this.s;
    const v = this.opts.viewport;
    const tasks: Promise<unknown>[] = [
      s.send('Page.enable'),
      s.send('Runtime.enable'),
      // keep the response buffers small: bodies are only read for non-HTML documents
      s.send('Network.enable', { maxTotalBufferSize: 6_000_000, maxResourceBufferSize: 3_000_000 }),
      s.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }], handleAuthRequests: true }),
      s.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 1, mobile: false }),
      s.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      s.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(noop),
      s.send('Page.addScriptToEvaluateOnNewDocument', { source: this.boot, worldName: WORLD }),
      s.send('Log.enable').catch(noop),
    ];
    if (!this.opts.shared) tasks.push(this.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: this.contextId, eventsEnabled: true }).catch(noop));
    if (this.opts.probe) {
      tasks.push(s.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${listenerProbe.toString()})(self,${JSON.stringify(this.probeName)})` }));
      tasks.push(s.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${webmcpShim.toString()})(self)` }));
    }
    await Promise.all(tasks);
  }

  dispose(): void {
    for (const d of this.tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    this.chooser = undefined;
    this.offDownloads?.();
    this.offDownloads = undefined;
  }

  private wire(): void {
    const s = this.s;
    const main = (frameId: string) => frameId === this.mainFrame;

    s.on('Page.frameStartedLoading', (p) => {
      if (!main(p.frameId)) return;
      this.loading = true;
      this.navSeq++;
      this.dclAt = 0;
      this.loadAt = 0;
    });
    s.on('Page.frameStoppedLoading', (p) => {
      if (main(p.frameId)) this.loading = false;
    });
    s.on('Page.frameNavigated', (p) => {
      const f = p.frame;
      if (!f || f.parentId) return;
      this.mainFrame = f.id;
      this.url = String(f.url ?? '') + String(f.urlFragment ?? '');
      this.docSeq++;
      this.consoleLog = [];
      for (const [id, r] of this.netLog) if (r.type !== 'Document' || id !== f.loaderId) this.netLog.delete(id);
      this.isoCtx = 0;
      this.dclAt = 0;
      this.loadAt = 0;
      const res = this.responses.get(f.loaderId);
      this.doc = {
        status: res ? res.status : 0,
        mime: (res ? res.mime : String(f.mimeType ?? '')).toLowerCase(),
        headers: res ? res.headers : {},
        method: this.forcedPost.has(f.loaderId) ? 'POST' : (this.docMethods.get(f.loaderId) ?? 'GET'),
        requestId: f.loaderId,
      };
      this.responses.clear();
      this.docMethods.clear();
      this.forcedPost.clear();
      for (const [id, r] of this.inflight) if (r.loader !== f.loaderId) this.inflight.delete(id);
      this.lastNet = Date.now();
      // this origin's saved localStorage has just been put back by the seed script: once is enough
      const origin = originOf(this.url);
      if (origin && this.seeds[origin]) {
        delete this.seeds[origin];
        this.installSeeds();
      }
    });
    s.on('Page.navigatedWithinDocument', (p) => {
      if (main(p.frameId)) this.url = String(p.url ?? this.url);
    });
    s.on('Page.domContentEventFired', () => {
      this.dclAt = Date.now();
    });
    s.on('Page.loadEventFired', () => {
      this.loadAt = Date.now();
    });
    s.on('Page.javascriptDialogOpening', (p) => {
      const type = String(p.type ?? 'alert');
      // Nobody is there to read a dialog. Answer it the way the agent asked (default: the way that lets the page carry on).
      const { accept, text } = this.dialogAnswer;
      void s.send('Page.handleJavaScriptDialog', { accept, promptText: type === 'prompt' ? (text || String(p.defaultPrompt ?? '')) : '' }).catch(noop);
      const msg = clip(oneLine(p.message), 200);
      if (type === 'beforeunload') this.note(`the page asked to confirm leaving; ${accept ? 'accepted' : 'dismissed'}`);
      else if (type === 'prompt') this.note(accept ? `prompt "${msg}" answered with ${text ? `"${clip(text, 60)}"` : 'an empty string'}` : `prompt "${msg}" dismissed`);
      else if (type === 'confirm') this.note(`confirm "${msg}" ${accept ? 'accepted' : 'dismissed'}`);
      else this.note(`alert "${msg}"`);
    });
    s.on('Page.windowOpen', (p) => {
      const url = String(p.url ?? '');
      if (!/^https?:/i.test(url)) return;
      // Popups opened by the agent's own action are followed in this page; others are just reported.
      if (p.userGesture || this.acting) this.popupUrl = url;
      else this.note(`the page tried to open a new window: ${clip(url, 160)}`);
    });
    s.on('Page.downloadWillBegin', (p) => {
      const name = clip(oneLine(p.suggestedFilename) || 'file', 80);
      this.download = { url: String(p.url ?? ''), name };
      if (!this.downloadPath) this.note(`download blocked: ${name} (${clip(String(p.url ?? ''), 160)})`);
      else this.downloads.set(String(p.guid ?? name), { name, url: String(p.url ?? ''), state: 'running', path: '', bytes: 0 });
    });
    s.on('Page.fileChooserOpened', (p) => {
      const waiter = this.chooser;
      if (waiter) {
        this.chooser = undefined;
        waiter(p);
      } else this.note('a file chooser opened and was dismissed; use upload on that control');
    });
    s.on('Runtime.executionContextCreated', (p) => {
      const c = p.context;
      if (c && c.name === WORLD && c.auxData && c.auxData.frameId === this.mainFrame) this.isoCtx = c.id;
    });
    s.on('Runtime.executionContextDestroyed', (p) => {
      if (p.executionContextId === this.isoCtx) this.isoCtx = 0;
    });
    s.on('Runtime.executionContextsCleared', () => {
      this.isoCtx = 0;
    });
    s.on('Runtime.consoleAPICalled', (p) => {
      const args: any[] = Array.isArray(p.args) ? p.args : [];
      const text = args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : String(a.unserializableValue ?? a.description ?? a.type))).join(' ');
      this.pushConsole(String(p.type ?? 'log'), text);
    });
    s.on('Log.entryAdded', (p) => {
      const e = p.entry ?? {};
      if (e.source === 'javascript') return; // already seen as console or exception
      this.pushConsole(String(e.level ?? 'info') === 'warning' ? 'warning' : String(e.level ?? 'info'), `${oneLine(e.text)}${e.url ? ` (${clip(String(e.url), 100)})` : ''}`);
    });
    s.on('Runtime.exceptionThrown', (p) => {
      {
        const d = p.exceptionDetails ?? {};
        this.pushConsole('error', oneLine(d.exception?.description ?? d.text ?? 'error').split('\n')[0]);
      }
      if (this.pageErrors >= 5) return;
      const d = p.exceptionDetails ?? {};
      const text = oneLine(d.exception?.description ?? d.text ?? 'error').split(' at ')[0];
      this.pageErrors++;
      this.note(`page error: ${clip(text, 160)}`);
    });
    s.on('Inspector.targetCrashed', () => {
      this.crashed = 'the page crashed';
      this.note('the page crashed');
    });

    // Sites that answer over a socket (computations, live search) are silent on HTTP while the
    // answer streams in over a WebSocket; socket traffic shortly after load counts as loading.
    // A dev server's hot-reload socket (Next.js, Vite, webpack) chatters for as long as the page is open
    // and says nothing about the page being ready: it must not hold a test back for seconds per page.
    const devSockets = new Set<string>();
    const sock = (p: any) => {
      if (p && typeof p.url === 'string' && isDevSocket(p.url)) devSockets.add(String(p.requestId));
      if (p && devSockets.has(String(p.requestId))) return;
      this.wsLast = Date.now();
    };
    s.on('Network.webSocketCreated', sock);
    s.on('Network.webSocketFrameSent', sock);
    s.on('Network.webSocketFrameReceived', sock);
    s.on('Network.webSocketClosed', (p) => void devSockets.delete(String(p.requestId)));
    s.on('Network.requestWillBeSent', (p) => {
      const now = Date.now();
      this.lastNet = now;
      this.counters.requests++;
      const type = String(p.type ?? 'Other');
      this.inflight.set(p.requestId, { t: now, type, loader: String(p.loaderId ?? '') });
      if (this.netLog.size < 400 && !p.redirectResponse) {
        this.netLog.set(p.requestId, {
          method: String(p.request?.method ?? 'GET'),
          url: String(p.request?.url ?? ''),
          type,
          status: 0,
          failed: '',
          wall: Number(p.wallTime) * 1000 || Date.now(),
          ts: Number(p.timestamp) || undefined,
          reqHeaders: p.request?.headers,
          post: typeof p.request?.postData === 'string' ? clip(p.request.postData, 4000) : undefined,
        });
      }
      if (type === 'Document' && p.frameId === this.mainFrame && p.requestId === p.loaderId) {
        this.docMethods.set(p.requestId, p.request?.method === 'POST' ? 'POST' : 'GET');
        if (p.redirectResponse) this.forcedPost.delete(p.requestId); // a redirect after our POST is followed with whatever the browser chose
      }
    });
    s.on('Network.responseReceived', (p) => {
      const type = String(p.type ?? '');
      const rec = this.netLog.get(p.requestId);
      if (rec) {
        rec.status = Number(p.response?.status) || 0;
        rec.statusText = String(p.response?.statusText ?? '');
        rec.resHeaders = p.response?.headers;
        rec.mime = String(p.response?.mimeType ?? '');
        rec.protocol = String(p.response?.protocol ?? '');
      }
      if (Number(p.response?.status) >= 400) this.problem('request', 'error', `${rec?.method ?? 'GET'} ${p.response.status} ${p.response.url ?? rec?.url ?? ''}`, type === 'Document' && p.frameId === this.mainFrame);
      if (type === 'EventSource') this.inflight.delete(p.requestId);
      if (type === 'Document' && p.frameId === this.mainFrame && p.requestId === p.loaderId) {
        const r = p.response ?? {};
        const headers: Record<string, string> = {};
        for (const k in r.headers ?? {}) headers[k.toLowerCase()] = String(r.headers[k]);
        this.responses.set(p.requestId, { status: Number(r.status) || 0, mime: String(r.mimeType ?? ''), headers });
      }
    });
    s.on('Network.loadingFinished', (p) => {
      const row = this.netLog.get(p.requestId);
      if (row) {
        row.size = Number(p.encodedDataLength) || 0;
        if (row.ts && p.timestamp) row.ms = (Number(p.timestamp) - row.ts) * 1000;
      }
      this.inflight.delete(p.requestId);
      this.lastNet = Date.now();
      this.bytes += Number(p.encodedDataLength) || 0;
    });
    s.on('Network.loadingFailed', (p) => {
      const rec = this.netLog.get(p.requestId);
      if (rec && !p.canceled) rec.failed = String(p.blockedReason ? 'blocked' : p.errorText ?? 'failed').replace(/^net::/, '');
      if (rec && rec.ts && p.timestamp) rec.ms = (Number(p.timestamp) - rec.ts) * 1000;
      if (!p.canceled && !OUR_BLOCK.test(String(p.errorText ?? ''))) this.problem('request', 'error', `${rec?.method ?? 'GET'} FAILED ${String(p.errorText ?? 'failed').replace(/^net::/, '')} ${rec?.url ?? ''}`, p.type === 'Document');
      this.inflight.delete(p.requestId);
      this.lastNet = Date.now();
      if (p.type === 'Document' && !p.canceled && p.errorText && this.docMethods.has(p.requestId)) this.navError = String(p.errorText);
    });

    s.on('Fetch.requestPaused', (p) => void this.onPaused(p));
    s.on('Fetch.authRequired', (p) => void this.onAuth(p));
  }

  note(text: string): void {
    if (this.events.length >= MAX_EVENTS) return;
    if (this.events[this.events.length - 1] === text) return;
    this.events.push(text);
  }

  // ───────────────────────────── policy ─────────────────────────────

  private async onPaused(p: any): Promise<void> {
    const s = this.s;
    const id = p.requestId;
    const url: string = p.request?.url ?? '';
    const fail = () => s.send('Fetch.failRequest', { requestId: id, errorReason: 'BlockedByClient' }).catch(noop);
    try {
      const type: string = p.resourceType ?? 'Other';
      const mainDoc = type === 'Document' && p.frameId === this.mainFrame;
      if (!/^https?:/i.test(url)) {
        await s.send('Fetch.continueRequest', { requestId: id }).catch(noop);
        return;
      }
      // a request the agent routed is answered (or failed) on purpose: the speed-ups below must not pre-empt it,
      // but the guard still decides whether the request may happen at all
      const routed = this.routeFor(p);
      if (!mainDoc && !routed) {
        if (BLOCKED_TYPES.has(type) || (type === 'Image' && !this.opts.images)) {
          this.counters.blocked++;
          await fail();
          return;
        }
        let host = '';
        try {
          host = new URL(url).hostname;
        } catch {}
        if (host && this.opts.isTracker(host)) {
          this.counters.trackers++;
          await fail();
          return;
        }
      }
      const guard = this.ctx?.guard;
      if (mainDoc) {
        const o0 = originOf(url);
        if (o0) this.navOrigin = o0;
        const redirect = !!p.redirectedRequestId;
        const why = redirect ? 'redirect' : p.request?.method === 'POST' ? 'submit' : 'open';
        let v: Verdict = { ok: true };
        if (!redirect && this.preapproved && sameUrl(this.preapproved, url)) this.preapproved = '';
        else if (guard) v = await guard.checkUrl(url, why);
        if (!v.ok) {
          // Answer "204 No Content": the navigation is dropped and the page the agent was on stays intact.
          this.policy = { url, reason: v.reason };
          this.navOverride = undefined;
          await s.send('Fetch.fulfillRequest', { requestId: id, responseCode: 204 }).catch(noop);
          return;
        }
        if (v.warn) this.note(clip(v.warn, 200));
        const origin = originOf(url);
        if (origin) this.subVerdicts.set(origin, Promise.resolve({ ok: true }));
        if (routed) {
          this.navOverride = undefined; // a mocked answer needs no reshaped request
          await this.serveRoute(p, routed);
          return;
        }
        const o = this.navOverride;
        if (o && !redirect) {
          this.navOverride = undefined;
          const headers: Record<string, string> = { ...(p.request?.headers ?? {}) };
          if (o.headers) for (const k in o.headers) setHeader(headers, k, o.headers[k]);
          const params: Record<string, unknown> = { requestId: id };
          if (o.method === 'POST') {
            params.method = 'POST';
            const body = typeof o.body === 'string' ? Buffer.from(o.body, 'utf8') : Buffer.from(o.body ?? new Uint8Array());
            params.postData = body.toString('base64');
            setHeader(headers, 'Content-Type', o.contentType ?? 'application/x-www-form-urlencoded');
            if (p.networkId) this.forcedPost.add(String(p.networkId));
          }
          params.headers = Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
          await s.send('Fetch.continueRequest', params).catch(noop);
          return;
        }
        await s.send('Fetch.continueRequest', { requestId: id }).catch(noop);
        return;
      }
      // Everything else the page loads: one verdict per origin.
      const origin = originOf(url);
      let pending = this.subVerdicts.get(origin);
      if (!pending) {
        pending = guard ? guard.checkUrl(url, 'sub').catch((e) => ({ ok: false as const, reason: `guard failed: ${(e as Error).message}` })) : Promise.resolve({ ok: true as const });
        if (this.subVerdicts.size > 2000) this.subVerdicts.clear();
        this.subVerdicts.set(origin, pending);
      }
      const v = await pending;
      if (!v.ok) {
        this.counters.blocked++;
        if (!this.blockedOrigins.has(origin) && this.blockedOrigins.size < 50) {
          this.blockedOrigins.add(origin);
          this.note(`requests to ${origin} refused by policy: ${clip(v.reason, 120)}`);
        }
        await fail();
        return;
      }
      if (routed) {
        await this.serveRoute(p, routed);
        return;
      }
      await s.send('Fetch.continueRequest', { requestId: id }).catch(noop);
    } catch (e) {
      // A guard that throws has not said yes.
      if (p.resourceType === 'Document' && p.frameId === this.mainFrame) this.policy = { url, reason: `policy check failed: ${(e as Error).message}` };
      await fail();
    }
  }

  /** the session's route for this paused request (a CORS preflight is matched by the method it asks about) */
  private routeFor(p: any): import('../../types.ts').NetRoute | undefined {
    const routes = this.ctx?.net?.routes;
    if (!routes || !routes.length) return undefined;
    let method = String(p.request?.method ?? 'GET');
    if (method === 'OPTIONS') method = String(headerOf(p.request?.headers, 'Access-Control-Request-Method') || method);
    return matchRoute(routes, String(p.request?.url ?? ''), method);
  }

  private async serveRoute(p: any, route: import('../../types.ts').NetRoute): Promise<void> {
    const s = this.s;
    const reqHeaders: Record<string, string> = p.request?.headers ?? {};
    const preflight = p.request?.method === 'OPTIONS' && !!headerOf(reqHeaders, 'Access-Control-Request-Method');
    if (!preflight) route.hits++;
    if (route.delay) await sleep(route.delay);
    if (route.abort && !preflight) {
      await s.send('Fetch.failRequest', { requestId: p.requestId, errorReason: route.abort }).catch(noop);
      return;
    }
    const m = mockResponse(route, reqHeaders, String(p.request?.method ?? 'GET'));
    await s.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: m.code, responseHeaders: m.headers, ...(m.body ? { body: m.body } : {}) }).catch(noop);
  }

  /** A basic-auth prompt: answered with the session's credentials for the page's own origin (or the origins auth() named). */
  private async onAuth(p: any): Promise<void> {
    const s = this.s;
    const id = String(p.requestId);
    const ch = p.authChallenge ?? {};
    const answer = (response: string, extra: Record<string, unknown> = {}) => s.send('Fetch.continueWithAuth', { requestId: id, authChallengeResponse: { response, ...extra } }).catch(noop);
    const ctx = this.ctx;
    const net = ctx?.net;
    const origin = String(ch.origin ?? '');
    if (!ctx || !net?.auth || ch.source === 'Proxy' || !/basic/i.test(String(ch.scheme ?? '')) || !mayAnswer(net, origin, originOf(this.url)) && !mayAnswer(net, origin, this.navOrigin)) return void (await answer('Default'));
    if (this.authTried.has(id)) {
      // the server said no to what we sent: stop instead of asking again
      this.note(`${origin} rejected the credentials from auth()`);
      return void (await answer('CancelAuth'));
    }
    try {
      const header = basicFor(ctx, origin);
      const [user, pass] = splitBasic(header);
      if (this.authTried.size > 200) this.authTried.clear();
      this.authTried.add(id);
      rememberChallenge(net, origin);
      await answer('ProvideCredentials', { username: user, password: pass });
    } catch (e) {
      // a secret handle that may not go to this origin, for instance
      this.note(`auth: ${clip((e as Error).message, 160)}`);
      await answer('CancelAuth');
    }
  }

  // ───────────────────────────── calls ─────────────────────────────

  /** Start serving one engine call. */
  async begin(ctx: SessionCtx): Promise<void> {
    this.ctx = ctx;
    this.policy = undefined;
    this.download = undefined;
    this.navError = '';
    this.popupUrl = '';
    this.pageErrors = 0;
    // headers('Accept-Language: …') of the session wins: the user-agent override below would otherwise overrule the header
    const asked = Object.entries(ctx.net?.headers ?? {}).find(([k]) => k.toLowerCase() === 'accept-language')?.[1];
    const lang = asked ?? (ctx.emulate?.locale ? `${ctx.emulate.locale},${ctx.emulate.locale.split('-')[0]};q=0.9` : 'en-US,en;q=0.9');
    const ua = consistentUa(ctx.userAgent, this.opts.defaultUserAgent);
    if (ua && (ua !== this.userAgent || lang !== this.langSig)) {
      this.userAgent = ua;
      this.langSig = lang;
      await this.s.send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: lang, userAgentMetadata: uaMetadata(ua, this.opts.browserVersion) });
    }
    await this.emulate(ctx.emulate ?? {});
    await this.applyNet(ctx);
    await this.allowDownloads(ctx.id);
  }

  private headerSig = '{}';
  private initSig = '[]';
  private initIds: string[] = [];

  /** The session's extra request headers and init scripts, put on this page when they differ from what it has. */
  private async applyNet(ctx: SessionCtx): Promise<void> {
    const headers = ctx.net?.headers ?? {};
    const hsig = JSON.stringify(headers);
    if (hsig !== this.headerSig) {
      await this.s.send('Network.setExtraHTTPHeaders', { headers });
      this.headerSig = hsig;
    }
    const init = ctx.net?.init ?? [];
    const isig = JSON.stringify(init);
    if (isig !== this.initSig) {
      for (const id of this.initIds.splice(0)) await this.s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }).catch(noop);
      // main world, every frame, before the page's own scripts
      for (const source of init) this.initIds.push((await this.s.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source })).identifier);
      this.initSig = isig;
    }
  }

  /** The network log as a HAR 1.2 document (the requests since this page loaded). */
  har(): { text: string; count: number } {
    const rows: HarRow[] = [...this.netLog.values()].map((r) => ({
      method: r.method, url: r.url, type: r.type, status: r.status, failed: r.failed, wall: r.wall, ms: r.ms,
      reqHeaders: r.reqHeaders, resHeaders: r.resHeaders, mime: r.mime, statusText: r.statusText, protocol: r.protocol, size: r.size, post: r.post,
    }));
    return { text: buildHar(this.url, '', rows), count: rows.length };
  }

  /** Put the session's emulation (viewport, device, locale, timezone, location, dark mode, offline) on this page. */
  private async emulate(e: Emulation): Promise<void> {
    const sig = JSON.stringify(e);
    if (sig === this.emuSig) return;
    const s = this.s;
    const w = e.width ?? this.opts.viewport.width;
    const h = e.height ?? this.opts.viewport.height;
    const bad = (what: string, v: string) => (err: unknown) => {
      if (err instanceof AwError && /invalid|unknown|not supported|Invalid/i.test(err.message)) throw new AwError('bad_request', `unknown ${what} '${v}'`);
      throw err;
    };
    const features = [
      { name: 'prefers-color-scheme', value: e.dark ? 'dark' : '' },
      { name: 'prefers-reduced-motion', value: e.motion ? 'reduce' : '' },
      { name: 'prefers-contrast', value: e.contrast ? 'more' : '' },
      { name: 'forced-colors', value: e.forcedColors ? 'active' : '' },
    ];
    const net = e.throttle ? THROTTLE[e.throttle] : undefined;
    const perms = cdpPermissions(e.permissions, !!e.geo);
    await Promise.all([
      s.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: e.dpr ?? 1, mobile: !!e.mobile }),
      s.send('Emulation.setTouchEmulationEnabled', { enabled: !!e.mobile }),
      s.send('Emulation.setLocaleOverride', e.locale ? { locale: e.locale } : {}).catch(e.locale ? bad('locale', e.locale) : noop),
      s.send('Emulation.setTimezoneOverride', { timezoneId: e.tz ?? '' }).catch(bad('timezone', e.tz ?? '')),
      s.send('Emulation.setEmulatedMedia', { features }).catch(noop),
      s.send('Network.emulateNetworkConditions', { offline: !!e.offline, latency: net?.latency ?? 0, downloadThroughput: net?.down ?? -1, uploadThroughput: net?.up ?? -1 }).catch(noop),
      s.send('Emulation.setCPUThrottlingRate', { rate: e.cpu && e.cpu > 1 ? e.cpu : 1 }).catch(noop),
      // permissions are a browser-context setting: in the user's own profile they are not ours to change
      this.opts.shared
        ? undefined
        : perms.length
          ? this.cdp.send('Browser.grantPermissions', { permissions: perms, browserContextId: this.contextId }).then(() => void (this.granted = true)).catch(noop)
          : this.granted
            ? this.cdp.send('Browser.resetPermissions', { browserContextId: this.contextId }).then(() => void (this.granted = false)).catch(noop)
            : undefined,
      e.geo ? s.send('Emulation.setGeolocationOverride', { latitude: e.geo.lat, longitude: e.geo.lon, accuracy: 50 }) : s.send('Emulation.setGeolocationOverride', {}).catch(noop),
    ]);
    this.viewport = { width: w, height: h };
    this.emuSig = sig;
  }

  // ───────────────────────────── downloads, logs, scripts ─────────────────────────────

  /** Files the page saves land in a folder of this session instead of being refused. */
  private async allowDownloads(session: string): Promise<void> {
    const root = this.opts.downloadDir;
    if (!root || this.downloadPath || this.opts.shared) return;
    const dir = join(root, session.replace(/[^\w.-]+/g, '_').slice(0, 64) || 'session');
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return;
    }
    this.downloadPath = dir;
    await this.cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir, browserContextId: this.contextId, eventsEnabled: true }).catch(() => {
      this.downloadPath = '';
    });
    this.offDownloads = this.cdp.on('Browser.downloadProgress', (p) => {
      const d = this.downloads.get(String(p.guid));
      if (!d) return;
      d.bytes = Number(p.receivedBytes) || d.bytes;
      const cap = this.opts.maxDownloadBytes ?? 250 * 1024 * 1024;
      if (p.state === 'inProgress' && d.bytes > cap) {
        void this.cdp.send('Browser.cancelDownload', { guid: p.guid, browserContextId: this.contextId }).catch(noop);
        return;
      }
      if (p.state === 'completed') {
        d.state = 'done';
        d.path = typeof p.filePath === 'string' && p.filePath ? p.filePath : this.guessPath(d.name);
        try {
          d.bytes = statSync(d.path).size;
        } catch {}
      } else if (p.state === 'canceled') d.state = 'failed';
      if (d.state !== 'running') for (const w of this.downloadWaiters.splice(0)) w();
    });
  }

  private guessPath(name: string): string {
    const base = join(this.downloadPath, name);
    try {
      statSync(base);
      return base;
    } catch {}
    try {
      const m = readdirSync(this.downloadPath).filter((f) => f.startsWith(name.replace(/\.[^.]*$/, '')));
      if (m.length) return join(this.downloadPath, m[m.length - 1]);
    } catch {}
    return base;
  }

  /** Wait (briefly) for downloads this call started, and tell the agent where the files are. */
  async finishDownloads(deadline: number): Promise<void> {
    if (!this.downloads.size) return;
    const end = Math.min(deadline, Date.now() + 20_000);
    while ([...this.downloads.values()].some((d) => d.state === 'running') && Date.now() < end) {
      await new Promise<void>((r) => {
        this.downloadWaiters.push(r);
        setTimeout(r, 200);
      });
    }
    for (const d of this.downloads.values()) {
      if (d.state === 'done') this.note(`downloaded ${clip(d.name, 60)}: ${d.path} (${d.bytes} bytes)`);
      else if (d.state === 'failed') this.note(`download of ${clip(d.name, 60)} failed or was cancelled`);
      else this.note(`download of ${clip(d.name, 60)} is still running`);
    }
    for (const [k, d] of this.downloads) if (d.state !== 'running') this.downloads.delete(k);
  }

  get downloadDir(): string {
    return this.downloadPath;
  }

  private pushConsole(type: string, text: string): void {
    if (this.consoleLog.length >= 200) this.consoleLog.shift();
    this.consoleLog.push({ type, text: clip(oneLine(text), 400) });
    if (type === 'error' || type === 'assert' || type === 'warning') this.problem('console', type === 'warning' ? 'warning' : 'error', text);
  }

  private problem(kind: Problem['kind'], level: Problem['level'], text: string, nextDoc = false): void {
    if (OUR_BLOCK.test(text)) return;
    if (this.problems.length >= 300) this.problems.shift();
    this.problems.push({ doc: this.docSeq + (nextDoc ? 1 : 0), page: this.url, kind, level, text: clip(oneLine(text), 400) });
  }

  /** console() and network() */
  async readLog(a: { kind: 'console' | 'network'; match?: string; failed?: boolean; body?: boolean; n?: number }): Promise<string> {
    const n = Math.min(Math.max(a.n ?? 30, 1), 200);
    const needle = (a.match ?? '').toLowerCase();
    if (a.kind === 'console') {
      let rows = this.consoleLog;
      if (a.failed) rows = rows.filter((r) => r.type === 'error' || r.type === 'warning' || r.type === 'assert');
      if (needle) rows = rows.filter((r) => r.text.toLowerCase().includes(needle));
      if (!rows.length) return `(console: nothing logged${a.failed ? ' as an error or warning' : ''}${needle ? ` matching '${a.match}'` : ''} since this page loaded)`;
      const shown = rows.slice(-n);
      return `console, ${rows.length} message${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? ` (last ${shown.length})` : ''}:\n` + shown.map((r) => `${r.type === 'log' ? 'log' : r.type}: ${r.text}`).join('\n');
    }
    let rows = [...this.netLog.entries()].map(([id, r]) => ({ id, ...r }));
    if (a.failed) rows = rows.filter((r) => r.failed || r.status >= 400);
    if (needle) rows = rows.filter((r) => (r.method + ' ' + r.url).toLowerCase().includes(needle));
    if (!rows.length) return `(network: no requests${a.failed ? ' that failed' : ''}${needle ? ` matching '${a.match}'` : ''} since this page loaded)`;
    if (a.body) {
      const r = rows[rows.length - 1];
      let text = '';
      try {
        const b = await this.s.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: r.id });
        text = b.base64Encoded ? `(binary, ${Math.round((b.body.length * 3) / 4)} bytes)` : b.body;
      } catch {
        text = '(the browser no longer has this response body)';
      }
      return `${r.method} ${r.status || r.failed} ${clip(r.url, 160)}\n${text}`;
    }
    const shown = rows.slice(-n);
    return `network, ${rows.length} request${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? ` (last ${shown.length})` : ''}:\n` + shown.map((r) => `${r.method} ${r.failed ? 'FAILED ' + r.failed : r.status || '...'} ${r.type.toLowerCase()} ${clip(r.url, 140)}`).join('\n');
  }

  /**
   * Run JavaScript in the page's own world. An expression gives its value; statements give the last
   * value (REPL rules); a body with `return` is run as a function; an arrow function is called.
   */
  async evalJs(code: string): Promise<string> {
    const send = (expression: string, repl = true) =>
      this.s.send<any>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: false, objectGroup: 'aw-eval', userGesture: true, replMode: repl, timeout: 15_000, allowUnsafeEvalBlockedByCSP: true }, 20_000);
    let r = await send(code);
    if (r.exceptionDetails && /^SyntaxError/.test(String(r.exceptionDetails.exception?.description ?? ''))) {
      const r2 = await send(`(async()=>{\n${code}\n})()`, false);
      if (!r2.exceptionDetails || !/^SyntaxError/.test(String(r2.exceptionDetails.exception?.description ?? ''))) r = r2;
    }
    if (!r.exceptionDetails && r.result?.type === 'function') r = await send(`(${code.replace(/;\s*$/, '')})()`);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      const msg = oneLine(d.exception?.description ?? d.exception?.value ?? d.text ?? 'error').split(' at ')[0];
      throw new AwError('bad_request', `the script failed: ${clip(msg, 300)}`);
    }
    const res = r.result ?? {};
    if (res.objectId) {
      try {
        const o = await this.s.send<any>('Runtime.callFunctionOn', {
          objectId: res.objectId,
          returnByValue: true,
          functionDeclaration: `function(){try{if(this&&this.nodeType)return this.nodeType===1?this.outerHTML.slice(0,600):String(this.textContent).slice(0,600);var seen=new WeakSet();var j=JSON.stringify(this,function(k,v){if(typeof v==='object'&&v){if(seen.has(v))return '[circular]';seen.add(v)}if(typeof v==='function')return '[function]';if(typeof v==='bigint')return v+'n';return v});return j===undefined?String(this):j}catch(e){return String(this)}}`,
        });
        return String(o.result?.value ?? res.description ?? res.type);
      } finally {
        void this.s.send('Runtime.releaseObjectGroup', { objectGroup: 'aw-eval' }).catch(noop);
      }
    }
    if (res.type === 'undefined') return 'undefined';
    if (res.unserializableValue !== undefined) return String(res.unserializableValue);
    return JSON.stringify(res.value) ?? String(res.description ?? res.type);
  }

  /** reason of the main-frame navigation the guard refused during this call, if any */
  refusal(): string | undefined {
    return this.policy?.reason;
  }

  setActing(on: boolean): void {
    this.acting = on;
  }

  /** Tools the page published for agents (WebMCP), one line: name(params) - description. */
  async pageTools(): Promise<string> {
    if (!this.opts.probe) return '';
    try {
      const raw = (await this.s.send<any>('Runtime.evaluate', { expression: WEBMCP_LIST, returnByValue: true }, 2000))?.result?.value as string | undefined;
      if (!raw) return '';
      const tools = JSON.parse(raw) as { name: string; description: string; params: { name: string; required: boolean }[] }[];
      return tools.map((t) => `${t.name}(${t.params.map((p) => p.name + (p.required ? '' : '?')).join(', ')})${t.description ? ' - ' + t.description : ''}`).join(' · ');
    } catch {
      return '';
    }
  }

  takeEvents(): string[] {
    return this.events.splice(0);
  }

  /** The next main-frame request for `url` was already approved by the caller; optionally reshape it. */
  expect(url: string, override?: NavOverride): void {
    this.preapproved = url;
    this.navOverride = override;
  }

  async navigate(url: string, referer: string | undefined, deadline: number): Promise<void> {
    const left = Math.max(500, deadline - Date.now());
    let r: any;
    try {
      const params: Record<string, unknown> = { url };
      if (referer) params.referrer = referer;
      r = await this.s.send('Page.navigate', params, left);
    } catch (e) {
      if (e instanceof AwError && e.code === 'timeout') {
        void this.s.send('Page.stopLoading').catch(noop);
        throw new AwError('timeout', `${hostOf(url)} did not answer in ${Math.round(left / 1000)} s`);
      }
      if (e instanceof AwError && /Cannot navigate to invalid URL/i.test(e.message)) throw new AwError('bad_request', `not a URL the browser can open: ${clip(url, 120)}`);
      throw e;
    } finally {
      this.preapproved = '';
      this.navOverride = undefined;
    }
    if (this.policy) throw new AwError('policy', this.policy.reason);
    if (r && r.errorText) {
      if (r.isDownload || this.download) {
        throw new AwError('unsupported', `that URL is a file download (${this.download?.name ?? 'file'}), which the browser tier does not keep`, 'open it without the browser tier');
      }
      const code = String(r.errorText).replace(/^net::/, '');
      if (code === 'ERR_ABORTED') throw new AwError('net', `${hostOf(url)} answered without a document (navigation aborted)`);
      throw new AwError('net', `could not load ${clip(url, 120)}: ${code}`);
    }
  }

  // ───────────────────────────── settling ─────────────────────────────

  private loaded(now: number): boolean {
    if (!this.loading) return true;
    if (this.loadAt) return true;
    // A hung subresource can hold the load event back for a very long time. Once the DOM is parsed
    // and a few seconds have passed, what is there is what the agent gets.
    return this.dclAt > 0 && now - this.dclAt > 3000;
  }

  private netIdle(now: number, since: number): number {
    if (this.wsLast && now - this.wsLast < 1200) return 0;
    for (const [id, r] of this.inflight) {
      if (STREAMING.has(r.type)) continue;
      const age = now - r.t;
      if (age > 30_000) this.inflight.delete(id); // we missed its end
      else if (age <= 2000) return 0; // a young request is still in flight
    }
    return now - Math.max(this.lastNet, since);
  }

  /**
   * Wait until the page has loaded and both the network and the DOM have been quiet for a moment.
   * Never waits past `deadline`. Says so in `events` when it had to give up.
   */
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
      if (this.cdp.closed) throw new AwError('gone', 'the browser went away');
      if (this.popupUrl) await this.followPopup(o.deadline);
      if (now >= o.deadline) {
        this.note(`the page had not settled after ${Math.max(1, Math.round((now - started) / 1000))} s; this may be incomplete`);
        return;
      }
      if (!this.loaded(now)) {
        await sleep(Math.min(20, o.deadline - now));
        continue;
      }
      if (loadedSeq !== this.navSeq) {
        // (re)start the quiet budget every time a new document finishes loading
        loadedSeq = this.navSeq;
        loadedAt = now;
        if (this.noisyDoc === this.docSeq) cap = Math.min(cap, 600);
      }
      // answers streamed over a socket can take several seconds; allow them, within the deadline
      const end = Math.min(o.deadline, loadedAt + (this.wsLast > loadedAt ? Math.max(cap, 9000) : cap));
      if (now >= end) {
        if (now >= o.deadline) continue; // report it as a hard timeout above
        if (this.noisyDoc !== this.docSeq) {
          // Tickers, carousels and polling never go quiet. Remember it so later steps on this page stay fast.
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
        quiet = await this.run<boolean>(`__awh.quiet(${domQuiet},${Math.max(10, end - now)})`, { awaitPromise: true, timeoutMs: end - now + 2000 });
      } catch (e) {
        if (isContextLost(e)) {
          await sleep(15); // the document changed under us: look again
          continue;
        }
        if (e instanceof AwError && e.code === 'timeout') continue; // main thread busy; the loop bounds it
        throw e;
      }
      if (!quiet) continue;
      const after = Date.now();
      if (seq === this.navSeq && this.loaded(after) && this.netIdle(after, since) >= netQuiet && !this.popupUrl) return;
    }
  }

  /** window.open / target=_blank: the popup was closed; go there in this page instead. */
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

  // ───────────────────────────── isolated world ─────────────────────────────

  async world(): Promise<number> {
    if (this.isoCtx) return this.isoCtx;
    const r = await this.s.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: this.mainFrame, worldName: WORLD });
    this.isoCtx = r.executionContextId;
    return this.isoCtx;
  }

  /** Evaluate an expression in the engine's isolated world of the main frame. */
  async run<T = any>(expr: string, o: { awaitPromise?: boolean; timeoutMs?: number; byValue?: boolean; gesture?: boolean } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const contextId = await this.world();
      let r: any;
      try {
        r = await this.s.send(
          'Runtime.evaluate',
          {
            expression: `typeof __awh==="undefined"?"\\u0001boot":(${expr})`,
            contextId,
            returnByValue: o.byValue !== false,
            awaitPromise: !!o.awaitPromise,
            userGesture: !!o.gesture,
          },
          o.timeoutMs,
        );
      } catch (e) {
        if (isContextLost(e) && this.isoCtx === contextId) this.isoCtx = 0;
        throw e;
      }
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new AwError('internal', `page script failed: ${clip(oneLine(d.exception?.description ?? d.text), 300)}`);
      }
      if (r.result && r.result.value === '\u0001boot' && attempt < 2) {
        // a world made before our document-start script was registered (about:blank)
        await this.s.send('Runtime.evaluate', { expression: this.boot, contextId });
        continue;
      }
      return o.byValue === false ? r.result : r.result?.value;
    }
  }

  /** Call a helper from `__awh`. `{ err }` results become AwErrors. Retries when the document changes. */
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
    throw last;
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
      // the page navigated while we were reading it: let it land, then read again
      await this.settle({ deadline: Math.max(deadline, Date.now() + 1500), capMs: 1500 });
    }
    throw last instanceof AwError ? last : new AwError('internal', 'could not read the page');
  }

  /** The body of a non-HTML main document, as the server sent it. */
  async documentBody(): Promise<{ text?: string; bytes?: Uint8Array } | undefined> {
    if (!this.doc.requestId) return undefined;
    try {
      const r = await this.s.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: this.doc.requestId }, 10_000);
      if (r.base64Encoded) return { bytes: new Uint8Array(Buffer.from(r.body, 'base64')) };
      return { text: r.body };
    } catch {
      return undefined;
    }
  }

  // ───────────────────────────── cookies ─────────────────────────────

  private async readCookies(): Promise<{ map: Map<string, { sig: string; c: CookieData }>; list: CookieData[] }> {
    const r = await this.cdp.send<{ cookies: any[] }>('Storage.getCookies', { browserContextId: this.contextId });
    const map = new Map<string, { sig: string; c: CookieData }>();
    const list: CookieData[] = [];
    for (const raw of r.cookies ?? []) {
      const c = cookieFromCdp(raw);
      if (!c.name && !c.value) continue;
      list.push(c);
      map.set(cookieKey(c), { sig: cookieSig(c), c });
    }
    return { map, list };
  }

  /**
   * Jar -> browser. The jar is the truth: what it added or changed is set, what it dropped is
   * deleted. `cookieState` always mirrors what the browser really holds, so a cookie the browser
   * refuses is never mistaken for one the site deleted.
   */
  async cookiesIn(ctx: SessionCtx): Promise<void> {
    if (this.opts.shared) return; // the profile's own cookies are the truth; never copied into or out of the session
    const nowSec = Date.now() / 1000;
    const want = new Map<string, { sig: string; c: CookieData }>();
    for (const c of ctx.jar.all()) {
      if (!c || !c.name || !c.domain) continue;
      if (c.expires !== undefined && c.expires <= nowSec) continue;
      want.set(cookieKey(c), { sig: cookieSig(c), c });
    }
    const have = this.cookieState ?? new Map<string, { sig: string; c: CookieData }>();
    const toSet: { k: string; sig: string; c: CookieData }[] = [];
    for (const [k, w] of want) if (have.get(k)?.sig !== w.sig && this.refused.get(k) !== w.sig) toSet.push({ k, sig: w.sig, c: w.c });
    const toDelete: CookieData[] = [];
    for (const [k, h] of have) if (!want.has(k)) toDelete.push(h.c);
    if (!toSet.length && !toDelete.length) {
      this.cookieState = have;
      return;
    }
    for (const c of toDelete) {
      await this.s.send('Network.deleteCookies', { name: c.name, domain: c.domain.replace(/^\./, ''), path: c.path || '/' }).catch(noop);
    }
    if (toSet.length) {
      const params = toSet.map((x) => cookieToCdp(x.c));
      try {
        await this.cdp.send('Storage.setCookies', { cookies: params, browserContextId: this.contextId });
      } catch {
        // one malformed cookie fails the whole batch: set them one by one and skip the bad ones
        for (const p of params) await this.cdp.send('Storage.setCookies', { cookies: [p], browserContextId: this.contextId }).catch(noop);
      }
    }
    const now = (await this.readCookies()).map;
    for (const x of toSet) if (!now.has(x.k)) this.refused.set(x.k, x.sig);
    this.cookieState = now;
  }

  /** Browser -> jar. Cookies the site removed are expired in the jar so they do not come back. */
  async cookiesOut(ctx: SessionCtx): Promise<void> {
    if (this.opts.shared) return;
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
    // serialised: remove the previous seed script, then register the current set (if any)
    this.seedOp = this.seedOp
      .then(async () => {
        const old = this.seedScript;
        this.seedScript = '';
        if (old) await this.s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: old }).catch(noop);
        if (!Object.keys(this.seeds).length) return;
        const source = `(${seedStorage.toString()})(self,${JSON.stringify(this.seeds)})`;
        const r = await this.s.send<{ identifier: string }>('Page.addScriptToEvaluateOnNewDocument', { source, worldName: WORLD });
        this.seedScript = r.identifier;
      })
      .catch(noop);
  }

  /**
   * Session -> browser. Origins whose snapshot differs from what this context last saw are written
   * now (the origin on screen) or when the page next lands there (all others), before any page script.
   */
  async storageIn(ctx: SessionCtx): Promise<void> {
    if (this.opts.shared) return;
    const here = originOf(this.url);
    let seedsChanged = false;
    for (const origin of Object.keys(ctx.storage ?? {})) {
      const items = ctx.storage[origin];
      if (!items || typeof items !== 'object') continue;
      const sig = PageDriver.sigOf(items);
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

  /** Browser -> session, for the origin on screen. */
  async storageOut(ctx: SessionCtx): Promise<void> {
    if (this.opts.shared) return;
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
    this.storageSigs.set(r.origin, PageDriver.sigOf(r.items));
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

/**
 * The user agent the session asked for, with its Chrome version replaced by the real browser's:
 * a header that disagrees with the browser's client hints and behaviour is what bot filters look for.
 */
export function consistentUa(wanted: string | undefined, real: string): string {
  if (!wanted) return real;
  const v = /(?:Headless)?Chrome\/([\d.]+)/.exec(real)?.[1];
  return v ? wanted.replace(/Chrome\/[\d.]+/, 'Chrome/' + v) : wanted;
}

/**
 * Client hints (`navigator.userAgentData`, Sec-CH-UA-*) that agree with a user agent string, so
 * the header and the script-visible brands tell one story. Only Chrome-family UAs get them; for
 * anything else the browser's own hints are left alone.
 */
export function uaMetadata(ua: string, fullVersion?: string): Record<string, unknown> | undefined {
  const m = /Chrome\/([\d.]+)/.exec(ua);
  if (!m) return undefined;
  const full = fullVersion && fullVersion.split('.')[0] === m[1].split('.')[0] ? fullVersion : m[1];
  const major = full.split('.')[0];
  const android = /Android/.test(ua);
  const platform = android ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'Chrome OS' : 'Linux';
  const mobile = android && /Mobile/.test(ua);
  const arm = /aarch64|arm/i.test(ua) || (platform === 'Linux' && process.arch === 'arm64');
  const brands = (v: string) => [
    { brand: 'Not=A?Brand', version: v === major ? '24' : '24.0.0.0' },
    { brand: 'Chromium', version: v },
    { brand: 'Google Chrome', version: v },
  ];
  return {
    brands: brands(major),
    fullVersionList: brands(full),
    fullVersion: full,
    platform,
    platformVersion: platform === 'Linux' ? release() : platform === 'Android' ? (/Android ([\d.]+)/.exec(ua)?.[1] ?? '') : '',
    architecture: mobile ? '' : arm ? 'arm' : 'x86',
    model: '',
    mobile,
    bitness: mobile ? '' : '64',
    wow64: false,
  };
}

const release = (): string => osRelease().split('-')[0];

function headerOf(h: Record<string, string> | undefined, name: string): string | undefined {
  if (!h) return undefined;
  const want = name.toLowerCase();
  for (const k in h) if (k.toLowerCase() === want) return h[k];
  return undefined;
}

function splitBasic(header: string | undefined): [string, string] {
  const raw = Buffer.from(String(header ?? '').replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  const i = raw.indexOf(':');
  return [raw.slice(0, i), raw.slice(i + 1)];
}
