// Firefox and WebKit (Safari's engine), driven through Playwright. Same contract as the chrome
// engine: one browser process per engine serves every session, each session gets its own context
// with one page, and a context can be thrown away at any time because cookies and localStorage live
// in the session record. `playwright-core` is an optional dependency, loaded only when one of these
// engines is first asked whether it is available.

import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { Action, Engine, Loaded, NavRequest, SessionCtx, Tier } from '../../types.ts';
import { AwError } from '../../types.ts';
import { hostMatcher, TRACKER_HOSTS } from '../chrome/blocklist.ts';
import { parseChord, type Chord } from '../chrome/keys.ts';
import { isClosed, PwDriver, type DriverOptions } from './driver.ts';

export type BrowserName = 'firefox' | 'webkit';

export interface PlaywrightEngineOptions {
  browser: BrowserName;
  /** browser binary to use instead of Playwright's own build (must be a Playwright-patched build) */
  executable?: string;
  /** live contexts kept at most (default 4: a Firefox page costs ~1.5x and a WebKit page ~2.5x a Chromium one) */
  maxContexts?: number;
  /** a context untouched for this long is disposed (default 10 minutes) */
  idleMs?: number;
  /** the browser is shut down after this long with no contexts (default 2 minutes; 0 = never) */
  browserIdleMs?: number;
  viewport?: { width: number; height: number };
  images?: boolean;
  blockHosts?: string[] | false;
  listenerProbe?: boolean;
  netQuietMs?: number;
  domQuietMs?: number;
  settleCapMs?: number;
  env?: Record<string, string | undefined>;
  /** keep one blank page ready so a new session does not wait for a content process (default true) */
  prewarm?: boolean;
  /** load the Playwright module some other way (tests) */
  loader?: () => Promise<any>;
}

export interface PlaywrightEngine extends Engine {
  act(ctx: SessionCtx, action: Action): Promise<Loaded>;
  snapshot(ctx: SessionCtx): Promise<Loaded>;
  live(sessionId: string): boolean;
  stats(): Record<string, number>;
  /** the browser's version string once it has been launched */
  version(): string | undefined;
}

export const RESTORED = 'browser state restored from cookies; in-page state was reset';
const HTML_MIME = /^(text\/html|application\/xhtml\+xml)$/;
const LIGHT: Record<string, true> = { fill: true, check: true, select: true, hover: true, shot: true };
/** 1 when pressing the element should load a new document (a real link, a form's submit button) */
const NAV_LIKE = `(()=>{const e=__awh.el($ID);if(!e||!e.closest)return 0;const a=e.closest('a[href],area[href]');if(a){const h=a.getAttribute('href')||'';return /^\\s*(#|javascript:)/i.test(h)?0:1}const b=e.closest('button,input[type=submit],input[type=image]');return b&&b.form&&(b.type==='submit'||b.type==='image')?1:0})()`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const noop = () => {};

let shared: Promise<any> | undefined;
/** playwright-core, or the full playwright package; undefined when neither is installed */
export function loadPlaywright(): Promise<any> {
  return (shared ??= import('playwright-core')
    .catch(() => import('playwright' as string))
    .then((m: any) => m.default ?? m)
    .catch(() => undefined));
}

/** Where the browser binary is, or undefined when it is not installed. */
export async function browserPath(name: BrowserName, o: { executable?: string; env?: Record<string, string | undefined>; loader?: () => Promise<any> } = {}): Promise<string | undefined> {
  const env = o.env ?? process.env;
  const own = o.executable ?? (name === 'firefox' ? env.AGENTWEB_FIREFOX : env.AGENTWEB_WEBKIT);
  const pw = await (o.loader ?? loadPlaywright)();
  if (!pw || !pw[name]) return undefined;
  if (own) return existsSync(own) ? own : undefined;
  try {
    const p = String(pw[name].executablePath());
    return p && existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** Playwright key name for a parsed chord ("Control+Shift+A", "Enter", " "). */
export function pwKey(c: Chord): string {
  const k = c.key;
  let key = k.key === ' ' ? 'Space' : k.key;
  if (!k.code && k.key.length === 1) key = k.key; // characters with no physical key are typed as-is
  return [...c.mods, key].join('+');
}

interface Slot {
  id: string;
  context: any;
  page: any;
  d: PwDriver;
  lastUsed: number;
  busy: boolean;
  dead: string;
  committed: boolean;
}

export function createPlaywrightEngine(opts: PlaywrightEngineOptions): PlaywrightEngine {
  const name = opts.browser;
  const tier = name as Tier;
  const maxContexts = Math.max(1, opts.maxContexts ?? 4);
  const idleMs = Math.max(0, opts.idleMs ?? 600_000);
  const browserIdleMs = Math.max(0, opts.browserIdleMs ?? 120_000);
  const hosts = opts.blockHosts === false ? [] : [...TRACKER_HOSTS, ...(opts.blockHosts ?? [])];
  const driverOpts: DriverOptions = {
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    images: !!opts.images,
    isTracker: hostMatcher(hosts),
    probe: opts.listenerProbe !== false,
    netQuietMs: opts.netQuietMs ?? 300,
    domQuietMs: opts.domQuietMs ?? 200,
    settleCapMs: opts.settleCapMs ?? 3000,
  };
  const n = { opens: 0, acts: 0, snapshots: 0, rehydrations: 0, launches: 0, crashes: 0, evictions: 0, expired: 0, created: 0, popups: 0, retries: 0, launchMs: 0 };

  let browser: any;
  let starting: Promise<any> | undefined;
  let closed = false;
  let emptySince = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let ver: string | undefined;
  let spare: Promise<{ b: any; context: any; page: any; d: PwDriver }> | undefined;
  const prewarm = opts.prewarm !== false;
  const slots = new Map<string, Slot>();
  const locks = new Map<string, Promise<void>>();

  // ───────────────────────────── browser and contexts ─────────────────────────────

  async function getBrowser(): Promise<any> {
    if (browser && browser.isConnected()) return browser;
    if (starting) return starting;
    starting = (async () => {
      const pw = await (opts.loader ?? loadPlaywright)();
      if (!pw) throw new AwError('unsupported', `the ${name} engine needs playwright-core`, 'npm i playwright-core, then npx playwright-core install ' + name);
      const exe = await browserPath(name, opts);
      if (!exe) throw new AwError('unsupported', `${name} is not installed`, `npx playwright-core install ${name}`);
      const t0 = performance.now();
      const launch: Record<string, unknown> = { headless: true, timeout: 30_000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
      if (opts.executable || (name === 'firefox' ? opts.env?.AGENTWEB_FIREFOX : opts.env?.AGENTWEB_WEBKIT)) launch.executablePath = exe;
      if (opts.env) launch.env = opts.env;
      if (name === 'firefox') {
        launch.firefoxUserPrefs = {
          // hand JSON and PDF bodies to agentweb's readers instead of Firefox's viewer apps
          'devtools.jsonview.enabled': false,
          'pdfjs.disabled': true,
          // keep it lean: no back/forward page cache, one content process per site is not needed here
          'browser.sessionhistory.max_total_viewers': 0,
          'fission.autostart': false,
          'dom.ipc.processCount': 2,
          'browser.cache.disk.enable': false,
          'media.autoplay.default': 5,
        };
      }
      const b = await pw[name].launch(launch);
      n.launches++;
      n.launchMs = performance.now() - t0;
      ver = String(b.version?.() ?? '');
      b.on('disconnected', () => {
        if (browser === b) browser = undefined;
        spare = undefined;
        for (const s of slots.values()) if (!s.dead) s.dead = 'browser gone';
        if (!closed) n.crashes++;
      });
      browser = b;
      emptySince = Date.now();
      return b;
    })();
    try {
      return await starting;
    } finally {
      starting = undefined;
    }
  }

  function tick(): void {
    const now = Date.now();
    for (const s of [...slots.values()]) {
      if (!s.busy && idleMs > 0 && now - s.lastUsed > idleMs) {
        n.expired++;
        void drop(s, 'idle');
      }
    }
    if (!slots.size && browser && browserIdleMs > 0 && now - emptySince > browserIdleMs && !starting) {
      dropSpare();
      const b = browser;
      browser = undefined;
      void b.close().catch(noop);
    }
    if (!slots.size && !browser && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function ensureTimer(): void {
    if (timer || closed) return;
    timer = setInterval(tick, Math.max(1000, Math.min(30_000, Math.min(idleMs || 30_000, browserIdleMs || 30_000) / 2)));
    timer.unref?.();
  }

  async function drop(s: Slot, reason: string): Promise<void> {
    if (slots.get(s.id) === s) slots.delete(s.id);
    if (!s.dead) s.dead = reason;
    s.d.dispose();
    if (!slots.size) emptySince = Date.now();
    await s.context.close().catch(noop);
  }

  async function createSlot(id: string): Promise<Slot> {
    // make room: the least recently used idle context goes
    while (slots.size >= maxContexts) {
      let victim: Slot | undefined;
      for (const s of slots.values()) if (!s.busy && (!victim || s.lastUsed < victim.lastUsed)) victim = s;
      if (!victim) break;
      n.evictions++;
      await drop(victim, 'evicted');
    }
    let fresh = spare ? await spare.catch(() => undefined) : undefined;
    spare = undefined;
    if (fresh && (fresh.b !== browser || !browser?.isConnected())) {
      void fresh.context.close().catch(noop);
      fresh = undefined;
    }
    const { context, page, d } = fresh ?? (await blankPage());
    const slot: Slot = { id, context, page, d, lastUsed: Date.now(), busy: false, dead: '', committed: false };
    slots.set(id, slot);
    n.created++;
    ensureTimer();
    // a new page costs a content process (most of a second); have the next one ready
    if (prewarm && slots.size < maxContexts && !closed) {
      const p = blankPage();
      p.catch(noop);
      spare = p;
    }
    return slot;
  }

  /** A context with one page, policy and probes installed, holding nothing of any session yet. */
  async function blankPage(): Promise<{ b: any; context: any; page: any; d: PwDriver }> {
    const b = await getBrowser();
    const context = await b.newContext({
      viewport: driverOpts.viewport,
      acceptDownloads: false,
      // requests a service worker makes would bypass the request policy
      serviceWorkers: 'block',
      locale: 'en-US',
    });
    try {
      const page = await context.newPage();
      const d = new PwDriver(name, context, page, driverOpts);
      await d.init();
      context.on('page', (pg: any) => {
        if (pg === page) return;
        n.popups++;
        void d.popup(pg);
      });
      return { b, context, page, d };
    } catch (e) {
      void context.close().catch(noop);
      throw e;
    }
  }

  function dropSpare(): void {
    const p = spare;
    spare = undefined;
    if (p) void p.then((x) => x.context.close()).catch(noop);
  }

  async function use<R>(id: string, fn: (slot: Slot, fresh: boolean) => Promise<R>): Promise<R> {
    if (closed) throw new AwError('gone', 'the browser engine is closed');
    const prev = locks.get(id) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((r) => (unlock = r));
    const tail = prev.then(() => gate);
    locks.set(id, tail);
    await prev;
    try {
      for (let attempt = 0; ; attempt++) {
        if (closed) throw new AwError('gone', 'the browser engine is closed');
        let slot = slots.get(id);
        let fresh = false;
        try {
          if (slot && (slot.dead || !browser || !browser.isConnected())) {
            await drop(slot, slot.dead || 'browser gone');
            slot = undefined;
          }
          if (!slot) {
            slot = await createSlot(id);
            fresh = true;
          }
          slot.busy = true;
          slot.committed = false;
          return await fn(slot, fresh);
        } catch (e) {
          const gone = (e instanceof AwError && e.code === 'gone') || isClosed(e);
          const lost = !slot || !!slot.dead || !browser || !browser.isConnected();
          if (gone && lost && attempt === 0 && !(slot && slot.committed) && !closed) {
            if (slot) await drop(slot, 'browser gone');
            n.retries++;
            continue;
          }
          if (slot && gone) await drop(slot, 'browser gone');
          if (isClosed(e)) throw new AwError('gone', `the ${name} page went away`);
          throw e;
        } finally {
          if (slot) {
            slot.busy = false;
            slot.lastUsed = Date.now();
          }
        }
      }
    } finally {
      unlock();
      if (locks.get(id) === tail) locks.delete(id);
    }
  }

  const budget = (ctx: SessionCtx) => Math.max(1000, ctx.timeoutMs > 0 ? ctx.timeoutMs : 30_000);
  const settleBy = (deadline: number) => deadline - Math.min(1500, Math.max(200, (deadline - Date.now()) * 0.15));

  async function serve<R>(ctx: SessionCtx, body: (slot: Slot, fresh: boolean, deadline: number) => Promise<R>): Promise<R> {
    if (ctx.signal?.aborted) throw new AwError('timeout', 'the call was cancelled');
    const total = budget(ctx);
    return use(ctx.id, async (slot, fresh) => {
      const deadline = Date.now() + total;
      const d = slot.d;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        if (!ctx.signal) return;
        onAbort = () => reject(new AwError('timeout', 'the call was cancelled'));
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
      aborted.catch(noop);
      try {
        return await Promise.race([body(slot, fresh, deadline), aborted]);
      } catch (e) {
        // a page in an unknown state, or one that followed a redirect the policy refused, is not reused
        if (ctx.signal?.aborted || d.crashed || d.tainted || (e instanceof AwError && e.code === 'gone')) {
          if (!slot.dead) slot.dead = d.crashed || d.tainted || 'call abandoned';
        }
        throw e;
      } finally {
        d.setActing(false);
        if (onAbort) ctx.signal!.removeEventListener('abort', onAbort);
      }
    });
  }

  async function hydrate(d: PwDriver, ctx: SessionCtx): Promise<void> {
    d.begin(ctx);
    await Promise.all([d.cookiesIn(ctx), d.storageIn(ctx)]);
  }

  async function rehydrate(d: PwDriver, ctx: SessionCtx, deadline: number): Promise<void> {
    const url = ctx.url!;
    const v = await ctx.guard.checkUrl(url, 'open');
    if (!v.ok) throw new AwError('policy', v.reason);
    d.expect(url);
    await d.navigate(url, undefined, deadline);
    await d.settle({ deadline: settleBy(deadline) });
    n.rehydrations++;
    d.note(RESTORED);
  }

  async function finish(d: PwDriver, ctx: SessionCtx, t0: number, bytes0: number, deadline: number, image?: Loaded['image']): Promise<Loaded> {
    if (d.policy) throw new AwError('policy', d.policy.reason);
    const mime = d.doc.mime || 'text/html';
    const out: Loaded = { url: d.url, status: d.doc.status || 200, method: d.doc.method, contentType: mime, bytes: 0, ms: 0 };
    let isDoc = true;
    if (!HTML_MIME.test(mime) && /^https?:/i.test(d.url)) {
      const body = await d.documentBody();
      if (body) {
        out.body = body;
        isDoc = false;
      }
    }
    if (isDoc) {
      // Firefox keeps the failed URL in the address bar and shows its own error page under it
      const failed = name === 'firefox' ? await d.errorPage() : undefined;
      if (failed) throw new AwError('net', `navigation failed: ${failed}`, 'use back to return to the previous page');
      const ex = await d.extract(deadline);
      if (/^about:(neterror|certerror|blank\?)|^chrome-error:/i.test(ex.url) || (d.navError && /^about:/i.test(ex.url))) {
        const why = d.navError || 'the page could not be loaded';
        throw new AwError('net', `navigation failed: ${why}`, 'use back to return to the previous page');
      }
      out.doc = { root: ex.root, meta: ex.meta };
      if (ex.url) out.url = ex.url;
      if (ex.truncated) d.note(`the page is very large; only the first ${ex.nodes} elements were read`);
    }
    await Promise.all([d.cookiesOut(ctx), d.storageOut(ctx)]);
    const late = d.refusal();
    if (late) throw new AwError('policy', late);
    if (Object.keys(d.doc.headers).length) out.headers = d.doc.headers;
    if (image) out.image = image;
    const events = d.takeEvents();
    if (events.length) out.events = events;
    out.bytes = Math.max(0, Math.round(d.bytes - bytes0));
    out.ms = Math.round(performance.now() - t0);
    return out;
  }

  // ───────────────────────────── actions ─────────────────────────────

  async function click(d: PwDriver, id: number, viaLabel = false): Promise<void> {
    const a = await d.call<any>('aim', id, viaLabel);
    if (a.option) {
      const r = await d.call<any>('pickOption', id);
      d.note(`chose option "${clip(String(r.label ?? ''), 80)}"`);
      return;
    }
    if (a.tag === 'select') {
      await d.call('focus', id);
      d.note('that is a select; use select with the option you want');
      return;
    }
    if (a.ariaDisabled) d.note('that control is marked disabled (aria-disabled)');
    if (a.ok) {
      // Firefox and WebKit can take a moment to start the navigation a click causes; the settle
      // that follows would otherwise read the old page as "quiet"
      const navs = await d.run<number>(NAV_LIKE.replace('$ID', JSON.stringify(id))).catch(() => 0);
      const seq = d.navSeq;
      await d.page.mouse.click(a.x, a.y);
      if (navs) await d.waitNav(seq, 1500);
      return;
    }
    const r = await d.run<any>(`__awh.scriptClick(${JSON.stringify(id)})`);
    if (r && r.err) throw new AwError(r.err, r.msg);
    d.note(`the target was covered by ${a.by || 'another element'}; used a scripted click`);
  }

  async function pressKeys(d: PwDriver, spec: string): Promise<void> {
    await d.page.keyboard.press(pwKey(parseChord(spec)));
  }

  async function fill(d: PwDriver, id: number, value: string): Promise<void> {
    const text = String(value ?? '');
    const p = await d.call<any>('prepFill', id, text);
    if (p.kind === 'select') {
      await d.call('select', id, text);
      return;
    }
    if (p.kind === 'set') {
      if (p.value !== text && p.type !== 'range' && p.type !== 'color') d.note(`the ${p.type} field did not accept "${clip(text, 60)}"; it now reads "${clip(String(p.value), 60)}"`);
      return;
    }
    const want = p.multiline ? text.replace(/\r\n?/g, '\n') : text.replace(/[\r\n]+/g, '');
    if (want) await d.page.keyboard.insertText(want);
    else if (!p.empty) await d.page.keyboard.press('Backspace');
    let got = String((await d.call<any>('fieldValue', id)).value ?? '');
    const same = (a: string, b: string) => a === b || a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
    if (!same(got, want)) {
      const limited = p.max > 0 && want.length > p.max && got === want.slice(0, p.max);
      if (!limited && want && !got.includes(want.slice(0, Math.min(3, want.length)))) {
        got = String((await d.call<any>('forceValue', id, want)).value ?? '');
        if (same(got, want)) {
          d.note('typing did not reach the field; its value was set directly');
          return;
        }
      }
      if (p.secret) d.note('the field did not keep exactly what was typed');
      else if (limited) d.note(`the field holds at most ${p.max} characters; it now reads "${clip(got, 80)}"`);
      else d.note(`the field now reads "${clip(got, 80)}"`);
    }
  }

  async function check(d: PwDriver, id: number, on: boolean): Promise<void> {
    const st = await d.call<any>('checkState', id);
    if (st.kind === 'none') throw new AwError('bad_request', 'that element cannot be checked', 'check works on checkboxes, radio buttons and switches');
    if (st.disabled) throw new AwError('bad_request', `that ${st.kind === 'aria' ? 'control' : st.kind} is disabled`);
    if (st.on === on) return;
    if (st.kind === 'radio' && !on) throw new AwError('bad_request', 'a radio button cannot be unchecked', 'check another option of the group instead');
    await click(d, id, true);
    const after = await d.call<any>('checkState', id);
    if (after.on === on) return;
    if (after.kind === 'aria') {
      await sleep(120);
      if ((await d.call<any>('checkState', id)).on === on) return;
      d.note('the control did not change state after the click');
      return;
    }
    const r = await d.call<any>('forceCheck', id, on);
    if (r.ok && r.on === on) d.note('the click did not change it; its state was set directly');
    else d.note('the control did not change state');
  }

  async function hover(d: PwDriver, id: number): Promise<void> {
    const a = await d.call<any>('aim', id, false).catch((e) => {
      if (e instanceof AwError && e.code === 'bad_request') return { ok: false, by: 'nothing' };
      throw e;
    });
    if (a.ok) {
      await d.page.mouse.move(a.x, a.y);
      return;
    }
    await d.call('hoverSynth', id);
    if (a.by && a.by !== 'nothing') d.note(`the target was covered by ${a.by}; hover events were sent by script`);
  }

  async function scroll(d: PwDriver, to: 'bottom' | 'top' | number, deadline: number): Promise<void> {
    const before = await d.call<any>('scroll', to);
    if (to !== 'bottom') return;
    await d.settle({ deadline: settleBy(deadline), since: Date.now() });
    const after = await d.call<any>('scrollInfo').catch(() => undefined);
    if (after && after.h <= before.h + 2) d.note('reached the end of the page; nothing more loaded');
    else if (after) d.note(`more content loaded (page height ${Math.round(before.h)} → ${Math.round(after.h)} px)`);
  }

  async function wait(d: PwDriver, a: { ms?: number; text?: string }, deadline: number): Promise<void> {
    const started = Date.now();
    const end = Math.min(settleBy(deadline), a.ms !== undefined ? started + Math.max(0, a.ms) : Infinity);
    if (!a.text) {
      if (a.ms) await sleep(Math.max(0, end - Date.now()));
      return;
    }
    for (;;) {
      const left = end - Date.now();
      if (left <= 0) break;
      try {
        if (await d.run<boolean>(`__awh.waitText(${JSON.stringify(a.text)},${Math.min(left, 5000)})`, { timeoutMs: Math.min(left, 5000) + 2000 })) return;
      } catch (e) {
        if (e instanceof AwError && e.code !== 'internal' && e.code !== 'timeout') throw e;
        await sleep(50);
      }
    }
    throw new AwError('timeout', `"${clip(a.text, 60)}" did not appear within ${Math.max(1, Math.round((Date.now() - started) / 1000))} s`, 'read the page to see what is there instead');
  }

  async function back(d: PwDriver, deadline: number): Promise<void> {
    const before = d.url;
    const len = await d.page.evaluate('history.length').catch(() => 1);
    if (len <= 1) throw new AwError('bad_request', 'there is no earlier page in this tab', 'open the URL you want instead');
    await d.page.goBack({ waitUntil: 'commit', timeout: Math.max(500, deadline - Date.now()) }).catch((e: unknown) => {
      if (isClosed(e)) throw e;
    });
    if (/^about:blank/i.test(d.page.url())) {
      // the tab's first entry is the blank page it was created with: that is not an earlier page
      await d.page.goForward({ waitUntil: 'commit', timeout: Math.max(500, deadline - Date.now()) }).catch(noop);
      throw new AwError('bad_request', 'there is no earlier page in this tab', 'open the URL you want instead');
    }
    if (d.page.url() === before) await sleep(50);
  }

  async function upload(d: PwDriver, id: number, files: { name: string; mime: string; data: string }[]): Promise<void> {
    if (!Array.isArray(files) || !files.length) throw new AwError('bad_request', 'upload needs at least one file');
    let total = 0;
    const payload: { name: string; mimeType: string; buffer: Buffer }[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const buffer = Buffer.from(String(f.data ?? ''), 'base64');
      total += buffer.length;
      if (total > 64 * 1024 * 1024) throw new AwError('too_large', 'uploads are limited to 64 MB per call');
      let fname = basename(String(f.name || 'file').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '') || 'file';
      while (seen.has(fname)) fname = '_' + fname;
      seen.add(fname);
      payload.push({ name: fname, mimeType: String(f.mime || 'application/octet-stream'), buffer });
    }
    if (!(await d.call<boolean>('alive', id))) throw new AwError('stale', 'that element is no longer on the page');
    const h = await d.run<any>(`__awh.fileInput(${JSON.stringify(id)})`, { handle: true });
    const el = h && typeof h.asElement === 'function' ? h.asElement() : null;
    if (el) {
      try {
        await el.setInputFiles(payload);
      } finally {
        void el.dispose().catch(noop);
      }
      return;
    }
    if (h) void h.dispose?.().catch(noop);
    const opened = new Promise<any>((resolve) => {
      d.chooser = resolve;
      setTimeout(() => resolve(undefined), 2500);
    });
    await click(d, id);
    const fc = await opened;
    d.chooser = undefined;
    if (!fc) throw new AwError('bad_request', 'that element is not a file input and did not open a file chooser', 'target the file input, or the button that opens it');
    await fc.setFiles(fc.isMultiple() ? payload : payload.slice(0, 1));
  }

  async function shot(d: PwDriver, a: { full?: boolean; n?: number }): Promise<NonNullable<Loaded['image']>> {
    const o: Record<string, unknown> = { type: 'jpeg', quality: 60, timeout: 15_000, animations: 'disabled', caret: 'hide' };
    if (a.n !== undefined) {
      const r = await d.call<any>('rect', a.n);
      if (r.w < 1 || r.h < 1) throw new AwError('bad_request', 'that element has no visible box to capture');
      o.clip = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.w, height: Math.min(r.h, 6000) };
      o.fullPage = true;
    } else if (a.full) {
      const h = await d.page.evaluate('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)').catch(() => 0);
      const height = Math.min(Number(h) || 0, 8000);
      if (Number(h) > height) d.note(`the page is ${Math.round(Number(h))} px tall; the screenshot shows the first ${height} px`);
      o.fullPage = true;
      if (height > 0) o.clip = { x: 0, y: 0, width: d.opts.viewport.width, height };
    }
    const buf: Buffer = await d.page.screenshot(o);
    return { mime: 'image/jpeg', data: buf.toString('base64') };
  }

  async function perform(slot: Slot, action: Action, deadline: number): Promise<Loaded['image'] | undefined> {
    const d = slot.d;
    switch (action.do) {
      case 'click':
        slot.committed = true;
        await click(d, action.n);
        return;
      case 'fill':
        slot.committed = true;
        await fill(d, action.n, action.value);
        return;
      case 'select':
        slot.committed = true;
        await d.call('select', action.n, String(action.value ?? ''));
        return;
      case 'check':
        slot.committed = true;
        await check(d, action.n, !!action.on);
        return;
      case 'press':
        if (action.n !== undefined) await d.call('focus', action.n);
        parseChord(action.key);
        slot.committed = true;
        await pressKeys(d, action.key);
        return;
      case 'hover':
        await hover(d, action.n);
        return;
      case 'scroll':
        await scroll(d, action.to, deadline);
        return;
      case 'wait':
        await wait(d, action, deadline);
        return;
      case 'back':
        slot.committed = true;
        await back(d, deadline);
        return;
      case 'upload':
        slot.committed = true;
        await upload(d, action.n, action.files);
        return;
      case 'shot':
        return shot(d, action);
      default:
        throw new AwError('bad_request', `unknown action "${(action as { do: string }).do}"`);
    }
  }

  // ───────────────────────────── engine ─────────────────────────────

  async function resume(slot: Slot, ctx: SessionCtx, fresh: boolean, deadline: number, needPage: boolean): Promise<void> {
    const d = slot.d;
    if (fresh) {
      if (needPage && !ctx.url) throw new AwError('gone', 'this session has no live page', 'open a URL first');
      await hydrate(d, ctx);
      if (needPage) await rehydrate(d, ctx, deadline);
    } else {
      d.begin(ctx);
      await Promise.all([d.cookiesIn(ctx), d.storageIn(ctx)]);
    }
  }

  return {
    tier,

    async available() {
      return !!(await browserPath(name, opts));
    },

    async open(ctx: SessionCtx, req: NavRequest): Promise<Loaded> {
      const t0 = performance.now();
      const method = req.method === 'POST' ? 'POST' : 'GET';
      const v = await ctx.guard.checkUrl(req.url, method === 'POST' ? 'submit' : 'open');
      if (!v.ok) throw new AwError('policy', v.reason);
      n.opens++;
      return serve(ctx, async (slot, fresh, deadline) => {
        const d = slot.d;
        const bytes0 = d.bytes;
        await resume(slot, ctx, fresh, deadline, false);
        if (v.warn) d.note(clip(v.warn, 200));
        const reshape = method === 'POST' || req.headers ? ({ method, body: req.body, contentType: req.contentType, headers: req.headers } as const) : undefined;
        if (method === 'POST') slot.committed = true;
        d.expect(req.url, reshape);
        await d.navigate(req.url, req.referer, deadline);
        await d.settle({ deadline: settleBy(deadline) });
        return finish(d, ctx, t0, bytes0, deadline);
      });
    },

    async act(ctx: SessionCtx, action: Action): Promise<Loaded> {
      const t0 = performance.now();
      if (!slots.has(ctx.id) && !ctx.url) throw new AwError('gone', 'this session has no live page', 'open a URL first');
      n.acts++;
      return serve(ctx, async (slot, fresh, deadline) => {
        const d = slot.d;
        const bytes0 = d.bytes;
        await resume(slot, ctx, fresh, deadline, true);
        d.setActing(true);
        const since = Date.now();
        const image = await perform(slot, action, deadline);
        const light = LIGHT[action.do];
        await d.settle({
          deadline: settleBy(deadline),
          since,
          netQuietMs: light ? Math.min(100, driverOpts.netQuietMs) : undefined,
          domQuietMs: light ? Math.min(100, driverOpts.domQuietMs) : undefined,
        });
        d.setActing(false);
        return finish(d, ctx, t0, bytes0, deadline, image);
      });
    },

    async snapshot(ctx: SessionCtx): Promise<Loaded> {
      const t0 = performance.now();
      if (!slots.has(ctx.id) && !ctx.url) throw new AwError('gone', 'this session has no live page', 'open a URL first');
      n.snapshots++;
      return serve(ctx, async (slot, fresh, deadline) => {
        const d = slot.d;
        const bytes0 = d.bytes;
        await resume(slot, ctx, fresh, deadline, true);
        if (!fresh) await d.settle({ deadline: settleBy(deadline) });
        return finish(d, ctx, t0, bytes0, deadline);
      });
    },

    live(sessionId: string): boolean {
      const s = slots.get(sessionId);
      return !!s && !s.dead && !!browser && browser.isConnected();
    },

    async release(sessionId: string): Promise<void> {
      const prev = locks.get(sessionId);
      if (prev) await prev.catch(noop);
      const s = slots.get(sessionId);
      if (s) await drop(s, 'released');
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const s of [...slots.values()]) s.d.dispose();
      slots.clear();
      if (spare) await spare.catch(noop);
      spare = undefined;
      const b = browser ?? (starting ? await starting.catch(() => undefined) : undefined);
      browser = undefined;
      if (b) await b.close().catch(noop);
    },

    stats(): Record<string, number> {
      let busy = 0;
      for (const s of slots.values()) if (s.busy) busy++;
      return { contexts: slots.size, busy, ...n, launchMs: Math.round(n.launchMs) };
    },

    version(): string | undefined {
      return ver;
    },
  };
}

