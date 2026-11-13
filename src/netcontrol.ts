// Request control for a session: route() mocks or blocks requests, headers() and auth() add what every
// request carries, init() runs a script before each page's own, wait() gained conditions, drop()
// puts a file on an element, network(har=) saves the log.
//
// All state lives in the session record (`rec.net`, `rec.emulate`), so it survives the browser page
// being evicted and re-created: engines read it from `ctx.net` at the start of every call and put it on
// the page again when the page is new. The helpers here are pure so every engine can share them; the
// verbs at the bottom are registered by the runtime.

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { blockText } from './blocks.ts';
import type { Arg, Step } from './dsl.ts';
import type { RunCtx, VerbHandler } from './runtime.ts';
import { AwError, type NetControl, type NetRoute, type Page, type SessionCtx } from './types.ts';

const truthy = (v: Arg | undefined) => v !== undefined && v !== false && v !== 0 && !/^(0|no|false|off)$/i.test(String(v));
const str = (a: Arg | undefined) => (a === undefined ? '' : String(a));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
const originOf = (url: string): string => {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
};

// ───────────────────────────── routes ─────────────────────────────

// `*/api/*` is already a glob over the full URL; `/api/*` and `host/path` are completed so they match too.
export function normalizePattern(p: string): string {
  const s = p.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('*')) return s;
  if (s.startsWith('/')) return '*' + s;
  return '*://' + s;
}

const rxCache = new Map<string, RegExp>();

/** Glob on a URL: `*` and `**` match anything, `?` one character, `{a,b}` alternatives. */
export function globToRegExp(glob: string): RegExp {
  let rx = rxCache.get(glob);
  if (rx) return rx;
  let out = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      while (glob[i + 1] === '*') i++;
      out += '.*';
    } else if (c === '?') out += '.';
    else if (c === '{') {
      depth++;
      out += '(?:';
    } else if (c === '}' && depth > 0) {
      depth--;
      out += ')';
    } else if (c === ',' && depth > 0) out += '|';
    else out += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  out += ')'.repeat(depth);
  try {
    rx = new RegExp(`^${out}$`, 'i');
  } catch {
    rx = /^(?!)/; // a pattern that cannot match anything rather than one that throws on every request
  }
  if (rxCache.size > 200) rxCache.clear();
  rxCache.set(glob, rx);
  return rx;
}

/** The route that answers this request: the newest one that matches wins. */
export function matchRoute(routes: NetRoute[] | undefined, url: string, method: string): NetRoute | undefined {
  if (!routes) return undefined;
  const bare = url.split('#')[0];
  for (let i = routes.length - 1; i >= 0; i--) {
    const r = routes[i];
    if (r.method && r.method !== method.toUpperCase()) continue;
    if (globToRegExp(normalizePattern(r.pattern)).test(bare)) return r;
  }
  return undefined;
}

/** CDP error names a route can fail a request with. */
const ABORTS: Record<string, string> = {
  failed: 'Failed', aborted: 'Aborted', timedout: 'TimedOut', timeout: 'TimedOut', accessdenied: 'AccessDenied', denied: 'AccessDenied', blocked: 'BlockedByClient',
  blockedbyclient: 'BlockedByClient', connectionclosed: 'ConnectionClosed', connectionreset: 'ConnectionReset', connectionrefused: 'ConnectionRefused', refused: 'ConnectionRefused',
  connectionaborted: 'ConnectionAborted', connectionfailed: 'ConnectionFailed', namenotresolved: 'NameNotResolved', dns: 'NameNotResolved', internetdisconnected: 'InternetDisconnected', offline: 'InternetDisconnected', addressunreachable: 'AddressUnreachable',
};

export function abortReason(v: string): string | undefined {
  return ABORTS[v.toLowerCase().replace(/[^a-z]/g, '')];
}

export interface MockedResponse {
  code: number;
  headers: { name: string; value: string }[];
  /** base64 */
  body: string;
}

/**
 * What the browser is told for a mocked request. Cross-origin pages need CORS headers on a mock, or
 * the page's own fetch() would refuse it, so they are added for any request that carries an Origin.
 */
export function mockResponse(r: NetRoute, reqHeaders: Record<string, string>, method: string): MockedResponse {
  const h = (n: string) => reqHeaders[n] ?? reqHeaders[n.toLowerCase()] ?? Object.entries(reqHeaders).find(([k]) => k.toLowerCase() === n.toLowerCase())?.[1];
  const origin = h('Origin');
  const cors = origin
    ? [
        { name: 'Access-Control-Allow-Origin', value: origin },
        { name: 'Access-Control-Allow-Credentials', value: 'true' },
        { name: 'Access-Control-Allow-Headers', value: h('Access-Control-Request-Headers') || '*' },
        { name: 'Access-Control-Allow-Methods', value: '*' },
        { name: 'Vary', value: 'Origin' },
      ]
    : [];
  if (method.toUpperCase() === 'OPTIONS' && h('Access-Control-Request-Method')) return { code: 204, headers: cors, body: '' };
  const body = r.body ?? '';
  const code = r.status ?? 200;
  const bodyless = code === 204 || code === 205 || code === 304;
  return {
    code,
    headers: [{ name: 'Content-Type', value: `${r.ctype ?? 'text/plain'}; charset=utf-8` }, { name: 'Cache-Control', value: 'no-store' }, ...cors],
    body: bodyless ? '' : Buffer.from(body, 'utf8').toString('base64'),
  };
}

export function describeRoute(r: NetRoute): string {
  const what = r.abort ? `abort (${r.abort})` : `${r.status ?? 200}${r.body ? ` ${clip(JSON.stringify(r.body), 50)}` : ''}${r.ctype && r.ctype !== 'text/plain' ? ` ${r.ctype}` : ''}`;
  return `${r.method ? r.method + ' ' : ''}${r.pattern} → ${what}${r.delay ? ` after ${r.delay} ms` : ''} · ${r.hits} hit${r.hits === 1 ? '' : 's'}`;
}

// ───────────────────────────── headers and credentials ─────────────────────────────

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'expect']);
const SENSITIVE = /^(authorization|proxy-authorization|cookie|x-api-key|x-auth-token)$|token|secret|password|api[-_]?key/i;

/** `X-Debug: 1` → [name, value]. Throws with a hint an agent can act on. */
export function parseHeaderLine(line: string): [string, string] {
  const i = line.indexOf(':');
  const name = (i < 0 ? line : line.slice(0, i)).trim();
  const value = i < 0 ? '' : line.slice(i + 1).trim();
  if (!name || i < 0) throw new AwError('bad_request', `'${clip(line, 60)}' is not a header`, "write each header as 'Name: value', e.g. headers('X-Debug: 1', 'Accept-Language: fr')");
  if (!TOKEN.test(name)) throw new AwError('bad_request', `'${clip(name, 40)}' is not a valid header name`);
  if (FORBIDDEN.has(name.toLowerCase())) throw new AwError('bad_request', `${name} is set by the transport and cannot be overridden`);
  if (/[\r\n\0]/.test(value)) throw new AwError('bad_request', `the value of ${name} has a line break in it`);
  if (value.includes('{{secret:')) throw new AwError('bad_request', 'secret handles are not supported in headers', "use auth('user', '{{secret:name}}') for basic credentials, or fill() into the page's own form");
  return [name, value];
}

/** Session headers keyed by lower-case name (the form the HTTP tiers use). */
export function sessionHeaders(net: NetControl | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (net?.headers) for (const [k, v] of Object.entries(net.headers)) out[k.toLowerCase()] = v;
  return out;
}

export function maskHeader(name: string, value: string): string {
  return SENSITIVE.test(name) ? '••••' : clip(value, 80);
}

/** Is a 401 answering with a scheme basic credentials can satisfy (or with no stated scheme)? */
export function basicChallenge(wwwAuthenticate: string | undefined): boolean {
  return !wwwAuthenticate || /(^|[\s,])basic\b/i.test(wwwAuthenticate);
}

/** May the session's credentials go to this origin when it challenges? */
export function mayAnswer(net: NetControl | undefined, origin: string, pageOrigin: string): boolean {
  const a = net?.auth;
  if (!a || !origin) return false;
  if (a.origins?.length) return a.origins.some((o) => originOf(o) === origin || o === origin);
  return origin === pageOrigin || !!net?.authOrigins?.includes(origin);
}

/** `Authorization` value for an origin. Secret handles are revealed here, for this origin only, and never echoed. */
export function basicFor(ctx: Pick<SessionCtx, 'net' | 'guard'>, origin: string): string | undefined {
  const a = ctx.net?.auth;
  if (!a) return undefined;
  const user = ctx.guard.reveal(a.user, origin);
  const pass = ctx.guard.reveal(a.pass, origin);
  return 'Basic ' + Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
}

export function rememberChallenge(net: NetControl, origin: string): void {
  const l = (net.authOrigins ??= []);
  if (!l.includes(origin)) l.push(origin);
  if (l.length > 20) l.shift();
}

/** Credentials to send at once to an origin that has challenged before (what browsers do after the first 401). */
export function preemptiveBasic(ctx: Pick<SessionCtx, 'net' | 'guard'>, origin: string): string | undefined {
  const net = ctx.net;
  if (!net?.auth || !net.authOrigins?.includes(origin)) return undefined;
  try {
    return basicFor(ctx, origin);
  } catch {
    return undefined;
  }
}

// ───────────────────────────── emulation tables ─────────────────────────────

/** Network.emulateNetworkConditions presets (the values Chrome DevTools and Puppeteer use). */
export const THROTTLE: Record<'slow3g' | 'fast4g', { latency: number; down: number; up: number }> = {
  slow3g: { latency: 2000, down: 50_000, up: 50_000 },
  fast4g: { latency: 165, down: 1_012_500, up: 1_012_500 },
};

export function parseThrottle(v: Arg): 'slow3g' | 'fast4g' | undefined {
  const s = str(v).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!s || /^(off|none|no|false|0|reset|full|normal)$/.test(s)) return undefined;
  if (/^(slow3g|3g|slow|slow4g|fast3g)$/.test(s)) return 'slow3g';
  if (/^(fast4g|4g|fast|lte)$/.test(s)) return 'fast4g';
  throw new AwError('bad_request', `unknown network speed '${str(v)}'`, "throttle='slow3g' | 'fast4g' | 'off'");
}

/** Playwright-style permission names to CDP's. */
const PERMS: Record<string, string[]> = {
  'clipboard-read': ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  'clipboard-write': ['clipboardSanitizedWrite'],
  notifications: ['notifications'],
  geolocation: ['geolocation'],
  camera: ['videoCapture'],
  microphone: ['audioCapture'],
  midi: ['midi'],
  'midi-sysex': ['midiSysex'],
  accelerometer: ['sensors'],
  gyroscope: ['sensors'],
  magnetometer: ['sensors'],
  'ambient-light-sensor': ['sensors'],
  'background-sync': ['backgroundSync'],
  'payment-handler': ['paymentHandler'],
  'storage-access': ['storageAccess'],
  'screen-wake-lock': ['wakeLockScreen'],
  'local-fonts': ['localFonts'],
  'idle-detection': ['idleDetection'],
  'persistent-storage': ['durableStorage'],
  'window-management': ['windowManagement'],
};

/** Names the agent wrote → canonical names (validated). Throws for one that does not exist. */
export function parsePermissions(v: Arg): string[] | undefined {
  const list = str(v).split(/[\s,;]+/).map((x) => x.trim().toLowerCase().replace(/_/g, '-')).filter(Boolean);
  if (!list.length || list.every((x) => /^(off|none|no|false|0|reset|clear)$/.test(x))) return undefined;
  for (const p of list) if (!PERMS[p]) throw new AwError('bad_request', `unknown permission '${p}'`, `permissions: ${Object.keys(PERMS).join(', ')}`);
  return [...new Set(list)];
}

/** CDP permission names for the canonical ones (plus geolocation when a location is emulated). */
export function cdpPermissions(names: string[] | undefined, geo: boolean): string[] {
  const out = new Set<string>(geo ? ['geolocation'] : []);
  for (const n of names ?? []) for (const c of PERMS[n] ?? []) out.add(c);
  return [...out];
}

// ───────────────────────────── HAR ─────────────────────────────

export interface HarRow {
  method: string;
  url: string;
  type: string;
  status: number;
  failed: string;
  /** epoch ms the request started */
  wall?: number;
  /** milliseconds until the response finished */
  ms?: number;
  reqHeaders?: Record<string, string>;
  resHeaders?: Record<string, string>;
  mime?: string;
  statusText?: string;
  protocol?: string;
  size?: number;
  post?: string;
}

const harHeaders = (h?: Record<string, string>) => Object.entries(h ?? {}).map(([name, value]) => ({ name, value: String(value) }));

/** The requests the page made since it loaded, as a HAR 1.2 document (bodies are left out: they would dwarf the file). */
export function buildHar(pageUrl: string, title: string, rows: HarRow[], version = '0'): string {
  const first = rows.find((r) => r.wall)?.wall ?? Date.now();
  const entries = rows.map((r) => {
    let query: { name: string; value: string }[] = [];
    try {
      query = [...new URL(r.url).searchParams].map(([name, value]) => ({ name, value }));
    } catch {}
    const ms = Math.max(0, Math.round(r.ms ?? 0));
    const loc = r.resHeaders && Object.entries(r.resHeaders).find(([k]) => k.toLowerCase() === 'location')?.[1];
    return {
      pageref: 'page_1',
      startedDateTime: new Date(r.wall ?? first).toISOString(),
      time: ms,
      request: {
        method: r.method,
        url: r.url,
        httpVersion: r.protocol || 'HTTP/1.1',
        cookies: [],
        headers: harHeaders(r.reqHeaders),
        queryString: query,
        headersSize: -1,
        bodySize: r.post ? Buffer.byteLength(r.post) : 0,
        ...(r.post ? { postData: { mimeType: (r.reqHeaders && Object.entries(r.reqHeaders).find(([k]) => k.toLowerCase() === 'content-type')?.[1]) || '', text: r.post } } : {}),
      },
      response: {
        status: r.failed ? 0 : r.status,
        statusText: r.failed ? r.failed : r.statusText || '',
        httpVersion: r.protocol || 'HTTP/1.1',
        cookies: [],
        headers: harHeaders(r.resHeaders),
        content: { size: r.size ?? -1, mimeType: r.mime || '' },
        redirectURL: loc ?? '',
        headersSize: -1,
        bodySize: r.size ?? -1,
        ...(r.failed ? { _error: r.failed } : {}),
      },
      cache: {},
      timings: { send: 0, wait: ms, receive: 0 },
      _resourceType: r.type.toLowerCase(),
    };
  });
  return JSON.stringify(
    {
      log: {
        version: '1.2',
        creator: { name: 'agentweb', version },
        pages: [{ startedDateTime: new Date(first).toISOString(), id: 'page_1', title: title || pageUrl, pageTimings: {} }],
        entries,
      },
    },
    null,
    1,
  );
}

/** a short file stem from what the agent named the file */
export function fileStem(name: string): string {
  return basename(name).replace(/\.har$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'network';
}

// ───────────────────────────── wait ─────────────────────────────

export interface WaitSpec {
  /** return when any of these appears (the first that does is reported) */
  any?: string[];
  /** return when this text is no longer on the page */
  gone?: string;
  /** the page URL contains this, or matches it when it has a `*` */
  url?: string;
  /** a numbered or named target reaching a state */
  target?: Arg;
  state?: 'visible' | 'hidden' | 'enabled';
  /** cap, in milliseconds */
  timeoutMs?: number;
}

/** The URL condition as a test: substring, or a glob (`**` / `*`) on the whole URL. */
export function urlMatcher(spec: string): (href: string) => boolean {
  if (!/[*{?]/.test(spec)) return (href) => href.includes(spec);
  const rx = globToRegExp(normalizePattern(spec));
  return (href) => rx.test(href);
}

const STATES = new Set(['visible', 'hidden', 'enabled']);

/** Is this wait more than `wait('text')` / `wait(2)`? Those two keep their original path. */
export function isAdvancedWait(step: Step): boolean {
  const o = step.opts;
  const strings = step.args.filter((a) => typeof a === 'string').length;
  return o.url !== undefined || o.gone !== undefined || o.state !== undefined || strings > 1 || (strings === 1 && (o.timeout !== undefined || o.timeoutms !== undefined));
}

export function parseWait(step: Step): WaitSpec {
  const o = step.opts;
  const spec: WaitSpec = {};
  if (o.state !== undefined) {
    const st = str(o.state).toLowerCase().replace(/^(shown|attached|present)$/, 'visible').replace(/^(detached|gone|removed)$/, 'hidden');
    if (!STATES.has(st)) throw new AwError('bad_request', `unknown state '${str(o.state)}'`, "state='visible' | 'hidden' | 'enabled'");
    if (!step.args.length) throw new AwError('bad_request', "wait with state= needs a target: wait(12, state='hidden') or wait('Submit', state='enabled')");
    spec.state = st as WaitSpec['state'];
    spec.target = step.args[0];
  } else {
    const words = step.args.filter((a): a is string => typeof a === 'string' && a.trim() !== '');
    if (words.length) spec.any = words;
  }
  if (o.gone !== undefined) spec.gone = str(o.gone);
  if (o.url !== undefined) spec.url = str(o.url);
  const t = o.timeout ?? o.timeoutms;
  if (t !== undefined && Number.isFinite(Number(t))) {
    const n = Number(t);
    spec.timeoutMs = Math.min(Math.max(n < 1000 ? n * 1000 : n, 100), 60_000);
  }
  return spec;
}

/** One line for timeout messages and notes: what was asked. */
export function describeWait(s: WaitSpec): string {
  const bits: string[] = [];
  if (s.any) bits.push(s.any.length === 1 ? `"${clip(s.any[0], 50)}" to appear` : `any of ${s.any.map((a) => `"${clip(a, 30)}"`).join(', ')} to appear`);
  if (s.gone) bits.push(`"${clip(s.gone, 50)}" to go away`);
  if (s.url) bits.push(`the URL to match ${clip(s.url, 60)}`);
  if (s.state) bits.push(`${typeof s.target === 'number' ? `[${s.target}]` : `"${clip(str(s.target), 40)}"`} to be ${s.state}`);
  return bits.join(' and ') || 'nothing';
}

/** What the page says right now, for a timeout message. */
export function glance(page: Page): string {
  const text = page.blocks.map(blockText).join(' ').replace(/\s+/g, ' ').trim();
  return `${page.title ? `"${clip(page.title, 60)}" ` : ''}${page.url}: ${text ? `"${clip(text, 160)}"` : '(no text)'}`;
}

/**
 * Wait for conditions that all hold. In the chrome engine the engine polls inside the page; every other
 * tier polls here against the page model (re-fetched on the wire tier, which has no scripts to wait for).
 */
async function waitVerb(rc: RunCtx, step: Step): Promise<void> {
  const spec = parseWait(step);
  const limit = spec.timeoutMs ?? rc.rt.opts.timeoutMs;
  const t0 = Date.now();
  let target: number | undefined;

  const resolveTarget = (): { n?: number; present: boolean } => {
    try {
      const r = rc.resolve({ ...step, verb: 'click', args: [spec.target!], opts: {} });
      if ('portable' in r) return { n: r.n, present: true };
      return { n: r.act.n, present: true };
    } catch (e) {
      if (e instanceof AwError && e.code === 'bad_request') return { present: false };
      throw e;
    }
  };

  if (spec.state) {
    await rc.ensureLive().catch(() => {});
    if (typeof spec.target === 'number' && !resolveTarget().present && spec.state !== 'hidden') throw new AwError('bad_request', `[${spec.target}] is not on this page`, 'numbers come from the page as last shown');
    const r = resolveTarget();
    if (!r.present && spec.state === 'hidden') return rc.note(`wait: ${describeWait(spec)} (it is not on the page)`);
    target = r.n;
  }

  if (rc.isLive() && rc.page.tier === 'chrome' && (!spec.state || target !== undefined)) {
    await rc.ensureLive();
    const res = await rc.live({ do: 'wait', any: spec.any, gone: spec.gone, url: spec.url, n: target, state: spec.state, ms: spec.timeoutMs });
    if (res.value && spec.any && spec.any.length > 1) rc.note(`wait: "${clip(res.value, 60)}" appeared`);
    return;
  }

  // everything else: poll the page model
  const holds = (): { ok: boolean; hit?: string } => {
    const p = rc.page;
    let hit: string | undefined;
    if (spec.any || spec.gone) {
      const text = norm(p.blocks.map(blockText).join(' '));
      if (spec.any) {
        hit = spec.any.find((a) => text.includes(norm(a)));
        if (hit === undefined) return { ok: false };
      }
      if (spec.gone && text.includes(norm(spec.gone))) return { ok: false };
    }
    if (spec.url && !urlMatcher(spec.url)(p.url)) return { ok: false };
    if (spec.state) {
      const r = resolveTarget();
      const ok = spec.state === 'hidden' ? !r.present : spec.state === 'visible' ? r.present : r.present && !isDisabled(rc, step, spec);
      if (!ok) return { ok: false };
    }
    return { ok: true, hit };
  };
  const live = rc.isLive();
  const plain = !live && rc.page.method === 'GET' && /^https?:/.test(rc.page.url);
  for (let tries = 0; ; tries++) {
    const h = holds();
    if (h.ok) {
      if (h.hit && spec.any && spec.any.length > 1) rc.note(`wait: "${clip(h.hit, 60)}" appeared`);
      return;
    }
    const left = limit - (Date.now() - t0);
    if (left <= 0 || (plain && tries >= 6)) break;
    if (live) await rc.live({ do: 'wait', ms: Math.min(400, left) });
    else if (plain) {
      await new Promise((r) => setTimeout(r, Math.min(900, left)));
      await rc.navigate({ url: rc.page.url }, { tier: 'wire', push: false });
    } else break;
  }
  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  throw new AwError('timeout', `${describeWait(spec)}: not within ${secs} s. The page shows ${glance(rc.page)}`, "read() or view() shows the page; wait(timeout=30) waits longer");
}

function isDisabled(rc: RunCtx, step: Step, spec: WaitSpec): boolean {
  try {
    const r = rc.resolve({ ...step, verb: 'click', args: [spec.target!], opts: {} });
    return !('portable' in r) && !!r.act.dis;
  } catch {
    return false;
  }
}

// ───────────────────────────── verbs ─────────────────────────────

/** The session's NetControl, created on first use and shared with the ctx engines read. */
function netOf(rc: RunCtx): NetControl {
  rc.rec.net ??= {};
  rc.ctx.net = rc.rec.net;
  return rc.rec.net;
}

function tidy(rc: RunCtx): void {
  const n = rc.rec.net;
  if (!n) return;
  if (!n.routes?.length) n.routes = undefined;
  if (!n.init?.length) n.init = undefined;
  if (n.headers && !Object.keys(n.headers).length) n.headers = undefined;
  if (!n.routes && !n.init && n.pinned && rc.rec.engine === 'chrome' && !Object.keys(rc.rec.emulate ?? {}).some((k) => k !== 'ua' && k !== 'label')) {
    rc.rec.engine = undefined; // route() pinned it; nothing needs chrome any more
    n.pinned = false;
  }
  if (!n.routes && !n.init && !n.headers && !n.auth) {
    rc.rec.net = undefined;
    rc.ctx.net = undefined;
  }
}

/** Routes and init scripts only work in chrome: pin the session there, and re-open a page loaded elsewhere. */
async function pinChrome(rc: RunCtx, what: string, reopen: boolean): Promise<string | undefined> {
  if (!(await rc.rt.available('chrome'))) throw new AwError('unsupported', `${what} need the chrome engine, which is not available`, 'install Chrome or set AGENTWEB_CHROME');
  const net = netOf(rc);
  const was = rc.rec.engine;
  if (was !== 'chrome') {
    if (!was) net.pinned = true;
    rc.rec.engine = 'chrome';
  }
  const p = rc.rec.page;
  if (reopen && p && p.tier !== 'chrome' && p.method === 'GET' && /^https?:/.test(p.url)) {
    await rc.navigate({ url: p.url }, { tier: 'chrome', push: false });
    return `${what} need the chrome engine: this page was re-opened there and this session's pages load there now`;
  }
  return was !== 'chrome' ? `${what} need the chrome engine: this session's pages load there now` : undefined;
}

const MAX_ROUTES = 30;
const MAX_BODY = 256 * 1024;

// route('*/api/cart*', status=500, body='boom') · route('*/api/user', json='{"name":"x"}') · route('*.png', abort=1)
// route('*/api/*', off=1) removes one · route(off=1) removes all. Options: status, body, json, type (content type), method, delay (ms).
const route: VerbHandler = async (rc, step) => {
  const o = step.opts;
  const pattern = step.args.length ? str(step.args[0]).trim() : '';
  if (truthy(o.off)) {
    const net = rc.rec.net;
    const before = net?.routes?.length ?? 0;
    if (!pattern) {
      if (net) net.routes = undefined;
      rc.note(before ? `removed ${before} route${before === 1 ? '' : 's'}` : 'there were no routes');
    } else {
      const want = normalizePattern(pattern);
      const keep = (net?.routes ?? []).filter((r) => normalizePattern(r.pattern) !== want || (!!o.method && r.method !== str(o.method).toUpperCase()));
      if (!net?.routes || keep.length === before) throw new AwError('bad_request', `there is no route '${clip(pattern, 80)}'`, 'routes() lists them; route(off=1) removes all');
      net.routes = keep;
      rc.note(`removed route ${pattern}`);
    }
    tidy(rc);
    return;
  }
  if (!pattern) throw new AwError('bad_request', "route needs a URL pattern: route('*/api/cart*', status=500, body='boom')", "also json='{...}', abort=1, route('...', off=1) to remove");
  const r: NetRoute = { pattern, hits: 0 };
  if (o.method !== undefined) r.method = str(o.method).toUpperCase();
  if (o.delay !== undefined) {
    const d = Number(o.delay);
    if (!Number.isFinite(d) || d < 0) throw new AwError('bad_request', 'delay is a number of milliseconds');
    r.delay = Math.min(d < 100 && d !== 0 ? d * 1000 : d, 30_000);
  }
  if (truthy(o.abort)) {
    const named = typeof o.abort === 'string' && !/^(1|true|yes|on)$/i.test(o.abort) ? abortReason(o.abort) : undefined;
    if (typeof o.abort === 'string' && !/^(1|true|yes|on)$/i.test(o.abort) && !named) throw new AwError('bad_request', `unknown abort reason '${o.abort}'`, `abort=1, or one of: ${[...new Set(Object.values(ABORTS))].join(', ')}`);
    r.abort = named ?? 'Failed';
  } else {
    if (o.status !== undefined) {
      const s = Number(o.status);
      if (!Number.isInteger(s) || s < 100 || s > 599) throw new AwError('bad_request', `status must be an HTTP status code, not '${str(o.status)}'`);
      r.status = s;
    }
    if (o.json !== undefined) {
      const text = str(o.json);
      try {
        JSON.parse(text);
      } catch {
        throw new AwError('bad_request', 'json= is not valid JSON', `pass the JSON as a string: json='{"name":"x"}'`);
      }
      r.body = text;
      r.ctype = 'application/json';
    } else if (o.body !== undefined) r.body = str(o.body);
    const ctype = o.type ?? o.ctype ?? o.contenttype ?? o.content_type;
    if (ctype !== undefined) r.ctype = str(ctype);
    else if (!r.ctype && r.body) r.ctype = /^\s*[<]/.test(r.body) ? 'text/html' : /^\s*[[{]/.test(r.body) ? 'application/json' : 'text/plain';
    if (r.status === undefined && r.body === undefined) throw new AwError('bad_request', `route '${clip(pattern, 60)}' does nothing: give it status=, body=, json= or abort=1`, "route('*/api/*', status=500, body='boom')");
    if (r.status === undefined) r.status = 200;
    if ((r.body?.length ?? 0) > MAX_BODY) throw new AwError('too_large', `a mocked body is limited to ${MAX_BODY / 1024} KB`);
  }
  if (!/[*?{]/.test(pattern) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(pattern) && !pattern.startsWith('/') && !/[./]/.test(pattern)) {
    throw new AwError('bad_request', `'${clip(pattern, 60)}' is not a URL pattern`, "patterns are globs on the full URL: '*/api/*', '*.png', 'https://site.example/x*'");
  }
  const note = await pinChrome(rc, 'routes', true);
  const net = netOf(rc);
  const list = (net.routes ??= []);
  const same = list.findIndex((x) => normalizePattern(x.pattern) === normalizePattern(r.pattern) && x.method === r.method);
  if (same >= 0) list.splice(same, 1);
  if (list.length >= MAX_ROUTES) throw new AwError('too_large', `at most ${MAX_ROUTES} routes per session`, 'route(off=1) removes them all');
  list.push(r);
  rc.note(`route: ${describeRoute(r).replace(/ · 0 hits$/, '')}${note ? `; ${note}` : ''}`);
};

/** routes(): what is routed, newest first (the first match wins), with hit counts */
const routes: VerbHandler = async (rc) => {
  const list = rc.rec.net?.routes ?? [];
  if (!list.length) return void rc.emit('(no routes: route(pattern, status=…, body=…) adds one)');
  rc.emit(`routes (${list.length}, the newest match wins):\n` + [...list].reverse().map((r, i) => `${i + 1}. ${describeRoute(r)}`).join('\n'));
  rc.stale = false;
};

/**
 * headers('X-Debug: 1', 'Accept-Language: fr') adds to every request of the session · headers('X-Debug', off=1) removes one
 * headers(off=1) removes all · headers() lists them. Applies on every tier.
 */
const headers: VerbHandler = async (rc, step) => {
  const o = step.opts;
  const off = truthy(o.off);
  const net = rc.rec.net;
  const lines = step.args.filter((a) => typeof a === 'string').map(String);
  const extra = Object.entries(o).filter(([k]) => k !== 'off' && !k.startsWith('_')).map(([k, v]) => `${k}: ${str(v)}`);
  if (off) {
    const names = [...lines, ...extra.map((e) => e.split(':')[0])].map((l) => l.split(':')[0].trim().toLowerCase()).filter(Boolean);
    if (!names.length) {
      if (net) net.headers = undefined;
      rc.note('extra headers removed');
    } else if (net?.headers) {
      for (const k of Object.keys(net.headers)) if (names.includes(k.toLowerCase())) delete net.headers[k];
      rc.note(`removed ${names.join(', ')}`);
    }
    tidy(rc);
    return;
  }
  if (!lines.length && !extra.length) {
    const cur = net?.headers ?? {};
    const names = Object.keys(cur);
    return void rc.emit(names.length ? 'extra headers:\n' + names.map((k) => `${k}: ${maskHeader(k, cur[k])}`).join('\n') : "(no extra headers: headers('X-Debug: 1') adds one)");
  }
  const parsed = [...lines, ...extra].map(parseHeaderLine);
  const n = netOf(rc);
  const cur = (n.headers ??= {});
  for (const [k, v] of parsed) {
    for (const old of Object.keys(cur)) if (old.toLowerCase() === k.toLowerCase()) delete cur[old]; // one value per name
    cur[k] = v;
  }
  if (Object.keys(cur).length > 40) throw new AwError('too_large', 'at most 40 extra headers');
  rc.note(`every request now carries ${parsed.map(([k, v]) => `${k}: ${maskHeader(k, v)}`).join(', ')}`);
};

/**
 * auth('user', 'pass') answers HTTP basic 401 challenges on every tier · auth('user', '{{secret:name}}') · auth(off=1)
 * auth('user', 'pass', origin='https://x.example') only for that origin. Without origin, only the page's own origin is answered.
 * The password is never shown.
 */
const auth: VerbHandler = async (rc, step) => {
  if (truthy(step.opts.off)) {
    if (rc.rec.net) {
      rc.rec.net.auth = undefined;
      rc.rec.net.authOrigins = undefined;
    }
    tidy(rc);
    return void rc.note('basic credentials removed');
  }
  const user = str(step.args[0] ?? step.opts.user ?? step.opts.username);
  const pass = str(step.args[1] ?? step.opts.pass ?? step.opts.password);
  if (!user || !step.args.length && step.opts.pass === undefined && step.opts.password === undefined) throw new AwError('bad_request', "auth needs a user and a password: auth('user', 'pass') or auth('user', '{{secret:name}}')");
  const origin = step.opts.origin !== undefined ? str(step.opts.origin) : undefined;
  // a handle that cannot be sent where the agent is working is better reported now than as a 401 later
  const here = origin ? originOf(/^[a-z]+:\/\//i.test(origin) ? origin : 'https://' + origin) : rc.rec.page && /^https?:/.test(rc.rec.page.url) ? originOf(rc.rec.page.url) : '';
  if (here && (pass.includes('{{secret:') || user.includes('{{secret:'))) {
    rc.guard.reveal(user, here);
    rc.guard.reveal(pass, here);
  }
  const n = netOf(rc);
  n.auth = { user, pass, ...(origin ? { origins: [/^[a-z]+:\/\//i.test(origin) ? origin : 'https://' + origin] } : {}) };
  n.authOrigins = undefined;
  rc.note(`basic credentials for ${user} will answer 401 challenges${origin ? ` from ${origin}` : " from the page's own origin"}`);
};

/** init('window.__TEST__ = true') runs on every new document before the page's scripts · init(off=1) removes them all · init() counts them */
const init: VerbHandler = async (rc, step) => {
  if (truthy(step.opts.off)) {
    const n = rc.rec.net?.init?.length ?? 0;
    if (rc.rec.net) rc.rec.net.init = undefined;
    tidy(rc);
    return void rc.note(n ? `removed ${n} init script${n === 1 ? '' : 's'}` : 'there were no init scripts');
  }
  const code = str(step.args[0]);
  if (!code.trim()) {
    const n = rc.rec.net?.init?.length ?? 0;
    return void rc.emit(n ? `${n} init script${n === 1 ? '' : 's'}:\n` + rc.rec.net!.init!.map((c, i) => `${i + 1}. ${clip(c.replace(/\s+/g, ' '), 100)}`).join('\n') : "(no init scripts: init('window.__TEST__ = true') adds one)");
  }
  const p = rc.rec.page;
  // the same gate as js(): a script that runs in every page is at least as powerful
  const v = await rc.guard.checkStep({ verb: 'js', origin: p ? originOf(p.url) : undefined, text: code });
  if (!v.ok) throw new AwError('policy', v.reason);
  if (code.length > 64 * 1024) throw new AwError('too_large', 'an init script is limited to 64 KB');
  const note = await pinChrome(rc, 'init scripts', true);
  const n = netOf(rc);
  const list = (n.init ??= []);
  if (!list.includes(code)) list.push(code);
  if (list.length > 10) list.shift();
  const live = rc.rec.page?.tier === 'chrome' && rc.isLive();
  rc.note(`init script added (${list.length} in all); it runs on pages loaded from now on${live ? ': reload() applies it to this one' : ''}${note ? `; ${note}` : ''}`);
};

// ── drop(): a local file onto an element ──

const MAX_DROP = 8 * 1024 * 1024;

/** Folders a file may be dropped from: downloads, AGENTWEB_FILES, and the working directory. */
function fileRoots(rc: RunCtx): string[] {
  const extra = rc.rt.opts.fileRoots ?? [];
  const roots = [...extra, process.cwd()];
  const out: string[] = [];
  for (const r of roots) {
    try {
      out.push(realpathSync(r));
    } catch {}
  }
  return out;
}

export function readDroppable(rc: RunCtx, path: string): { name: string; mime: string; data: string } {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs)) throw new AwError('bad_request', `no such file: ${clip(path, 120)}`, 'give a path relative to the working directory, or inside the downloads folder');
  const real = realpathSync(abs);
  const root = fileRoots(rc).find((r) => {
    const rel = relative(r, real);
    // inside the root, and not through a hidden folder or file (.ssh, .env, .git)
    return !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).some((s) => s.startsWith('.'));
  });
  if (!root) throw new AwError('policy', `${clip(path, 120)} is outside the folders files can be dropped from`, 'use a file in the working directory or the downloads folder; AGENTWEB_FILES adds more folders (hidden files are never read)');
  const st = statSync(real);
  if (!st.isFile()) throw new AwError('bad_request', `${clip(path, 120)} is not a file`);
  if (st.size > MAX_DROP) throw new AwError('too_large', `files dropped on a page are limited to ${MAX_DROP / 1024 / 1024} MB`);
  const name = basename(real);
  return { name, mime: mimeOf(name), data: readFileSync(real).toString('base64') };
}

const MIMES: Record<string, string> = { txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', zip: 'application/zip', xml: 'application/xml' };
const mimeOf = (name: string) => MIMES[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/** drop(target, 'path/to/file') · drop(target, 'a.txt', text='inline content'): dragenter, dragover and drop with the file on an element */
const drop: VerbHandler = async (rc, step) => {
  if (step.args.length < 1) throw new AwError('bad_request', "drop needs a target and a file: drop('Upload area', 'report.csv')");
  const inline = step.opts.text !== undefined;
  const file = inline ? { name: str(step.args[1]) || 'file.txt', mime: str(step.opts.mime) || mimeOf(str(step.args[1]) || 'file.txt'), data: Buffer.from(str(step.opts.text), 'utf8').toString('base64') } : undefined;
  if (!inline && !str(step.args[1])) throw new AwError('bad_request', "drop needs a file path: drop('Upload area', 'report.csv') or text: drop('Upload area', 'a.txt', text='hello')");
  const p = rc.rec.page;
  // a drop sends a file to the page: the same consequence as upload()
  const v = await rc.guard.checkStep({ verb: 'upload', origin: p ? originOf(p.url) : undefined, label: str(step.args[1]) });
  if (!v.ok) throw new AwError('policy', v.reason);
  const f = file ?? readDroppable(rc, str(step.args[1]));
  if (p && /^https?:/.test(p.url)) rc.outflow(f.name, originOf(p.url));
  if (!rc.isLive()) await rc.escalate('dropping a file needs a script engine');
  await rc.liveOn({ ...step, args: [step.args[0]] }, (n) => ({ do: 'drop', n, files: [f] }));
  rc.note(`dropped ${f.name} (${Buffer.from(f.data, 'base64').length} bytes)`);
};

export const netVerbs: Record<string, VerbHandler> = { route, routes, headers, auth, init, drop };
export { waitVerb };
