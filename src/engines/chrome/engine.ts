// The chrome tier: real Chromium, driven over raw CDP. The heaviest engine, used only when the
// cheaper tiers cannot handle a page. One browser serves every session; a session's context can be
// thrown away at any moment because its cookies and localStorage live in the session record.

import { accessSync, constants, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Action, Engine, Loaded, NavRequest, SessionCtx } from '../../types.ts';
import { AwError } from '../../types.ts';
import { hostMatcher, TRACKER_HOSTS } from './blocklist.ts';
import { connect } from './cdp.ts';
import { labelsOff, labelsOn, relayout, runCheck } from './checks.ts';
import { chordEvents, parseChord } from './keys.ts';
import { findBrowser, type Browser } from './launch.ts';
import { PageDriver, type DriverOptions } from './page.ts';
import { Pool, type PoolOptions, type Slot } from './pool.ts';

export interface ChromeEngineOptions extends PoolOptions {
  viewport?: { width: number; height: number };
  /** extra hosts whose requests are dropped; `false` turns the built-in tracker list off */
  blockHosts?: string[] | false;
  /** mark elements that have click listeners but no role and no pointer cursor (default true) */
  listenerProbe?: boolean;
  /** quiet windows that define "settled" (defaults 300 / 200 ms) and the cap on waiting for them (3 s) */
  netQuietMs?: number;
  domQuietMs?: number;
  settleCapMs?: number;
  /** where files the page downloads are kept (default ~/.agentweb/downloads); false refuses downloads */
  downloadDir?: string | false;
}

export interface ChromeEngine extends Engine {
  act(ctx: SessionCtx, action: Action): Promise<Loaded>;
  snapshot(ctx: SessionCtx): Promise<Loaded>;
  live(sessionId: string): boolean;
  stats(): Record<string, number>;
  /** the running browser, if any (tests and diagnostics) */
  browser(): Browser | undefined;
}

export const SHARED_NOTE = "this tab is in the user's own browser profile (AGENTWEB_CDP_SHARED): their logins are live here, so act only on what was asked";
export const RESTORED = 'browser state restored from cookies; in-page state was reset';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const HTML_MIME = /^(text\/html|application\/xhtml\+xml)$/;

/** actions that only edit a field: the page reacts within a frame or two, so a short settle is enough */
interface Out {
  value?: string;
}

const LIGHT: Record<string, true> = { fill: true, check: true, select: true, hover: true, shot: true, log: true, dialog: true };

export function createChromeEngine(opts: ChromeEngineOptions = {}): ChromeEngine {
  const hosts = opts.blockHosts === false ? [] : [...TRACKER_HOSTS, ...(opts.blockHosts ?? [])];
  const driverOpts: DriverOptions = {
    viewport: opts.viewport ?? { width: 1280, height: 800 },
    images: !!opts.images,
    isTracker: hostMatcher(hosts),
    probe: opts.listenerProbe !== false,
    netQuietMs: opts.netQuietMs ?? 300,
    domQuietMs: opts.domQuietMs ?? 200,
    settleCapMs: opts.settleCapMs ?? 3000,
    defaultUserAgent: '',
    shared: !!opts.shared && !!opts.endpoint,
    downloadDir: opts.downloadDir === false ? false : opts.downloadDir ?? join(process.env.AGENTWEB_HOME ?? join(homedir(), '.agentweb'), 'downloads'),
  };
  const n = { opens: 0, acts: 0, snapshots: 0, rehydrations: 0 };

  const pool = new Pool<PageDriver>(opts, {
    async create(slot) {
      const d = new PageDriver(slot.browser.cdp, slot.session, slot.contextId, slot.targetId, {
        ...driverOpts,
        // a headless shell says so in its user agent, which gets it refused before it is even looked at
        defaultUserAgent: slot.browser.userAgent.replace('HeadlessChrome', 'Chrome'),
        browserVersion: /Chrome\/([\d.]+)/.exec(slot.browser.product)?.[1],
      });
      await d.init();
      return d;
    },
    dispose(slot) {
      slot.data?.dispose();
    },
  });

  const budget = (ctx: SessionCtx) => Math.max(1000, ctx.timeoutMs > 0 ? ctx.timeoutMs : 30_000);

  /** Run a call body, turning an abort signal into an error and a dead page into a disposed slot. */
  async function serve<R>(ctx: SessionCtx, body: (slot: Slot<PageDriver>, fresh: boolean, deadline: number) => Promise<R>): Promise<R> {
    if (ctx.signal?.aborted) throw new AwError('timeout', 'the call was cancelled');
    const total = budget(ctx);
    return pool.use(ctx.id, total, async (slot, fresh) => {
      const deadline = Date.now() + total;
      const d = slot.data;
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        if (!ctx.signal) return;
        onAbort = () => reject(new AwError('timeout', 'the call was cancelled'));
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
      aborted.catch(() => {});
      try {
        return await Promise.race([body(slot, fresh, deadline), aborted]);
      } catch (e) {
        // A page in an unknown state is worth less than a fresh one: cookies and storage are safe in the session.
        if (ctx.signal?.aborted || d.crashed || (e instanceof AwError && e.code === 'gone')) pool.kill(slot, d.crashed || 'call abandoned');
        throw e;
      } finally {
        d.setActing(false);
        if (onAbort) ctx.signal!.removeEventListener('abort', onAbort);
      }
    });
  }

  /** Bring a new context up to the session: cookies in, localStorage queued for its origins. */
  async function hydrate(d: PageDriver, ctx: SessionCtx): Promise<void> {
    await d.begin(ctx);
    await Promise.all([d.cookiesIn(ctx), d.storageIn(ctx)]);
    if (driverOpts.shared) d.note(SHARED_NOTE);
  }

  /** A call arrived for a session whose page is gone: reopen where it was, from cookies and storage. */
  async function rehydrate(d: PageDriver, ctx: SessionCtx, deadline: number): Promise<void> {
    const url = ctx.url!;
    const v = await ctx.guard.checkUrl(url, 'open');
    if (!v.ok) throw new AwError('policy', v.reason);
    d.expect(url);
    await d.navigate(url, undefined, deadline);
    await d.settle({ deadline: settleBy(deadline) });
    n.rehydrations++;
    d.note(RESTORED);
  }

  /** leave room after settling to read the page and sync state */
  const settleBy = (deadline: number) => deadline - Math.min(1500, Math.max(200, (deadline - Date.now()) * 0.15));

  async function finish(d: PageDriver, ctx: SessionCtx, t0: number, bytes0: number, deadline: number, image?: Loaded['image'], value?: string): Promise<Loaded> {
    await d.finishDownloads(deadline);
    if (d.policy) throw new AwError('policy', d.policy.reason);
    const mime = d.doc.mime || 'text/html';
    const out: Loaded = {
      url: d.url,
      status: d.doc.status || 200,
      method: d.doc.method,
      contentType: mime,
      bytes: 0,
      ms: 0,
    };
    let isDoc = true;
    if (!HTML_MIME.test(mime) && /^https?:/i.test(d.url)) {
      // JSON, XML, plain text, an image: hand the bytes to a reader instead of Chromium's viewer DOM
      const body = await d.documentBody();
      if (body) {
        out.body = body;
        isDoc = false;
      }
    }
    if (isDoc) {
      const ex = await d.extract(deadline);
      if (/^chrome-error:/i.test(ex.url)) {
        const why = d.navError ? d.navError.replace(/^net::/, '') : 'the page could not be loaded';
        throw new AwError('net', `navigation failed: ${why}`, 'use back to return to the previous page');
      }
      out.doc = { root: ex.root, meta: ex.meta };
      if (ex.url) out.url = ex.url;
      if (ex.truncated) d.note(`the page is very large; only the first ${ex.nodes} elements were read`);
    }
    // After every call the session record is brought up to date: this is what makes the context disposable.
    await Promise.all([d.cookiesOut(ctx), d.storageOut(ctx)]);
    const late = d.refusal(); // a navigation refused while the page was being read
    if (late) throw new AwError('policy', late);
    if (Object.keys(d.doc.headers).length) out.headers = d.doc.headers;
    if (image) out.image = image;
    if (value !== undefined) out.value = value;
    const events = d.takeEvents();
    if (events.length) out.events = events;
    out.bytes = Math.max(0, Math.round(d.bytes - bytes0));
    out.ms = Math.round(performance.now() - t0);
    return out;
  }

  // ───────────────────────────── actions ─────────────────────────────

  async function mouseClick(d: PageDriver, x: number, y: number, o: { count?: number; button?: 'left' | 'right' | 'middle' } = {}): Promise<void> {
    const button = o.button ?? 'left';
    const mask = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    await d.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' });
    for (let i = 1; i <= (o.count ?? 1); i++) {
      await d.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: mask, clickCount: i, pointerType: 'mouse' });
      await d.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i, pointerType: 'mouse' });
    }
  }

  /** Press on one element, move in steps, release on the other. HTML5 drag and drop needs the browser's drag events replayed. */
  async function drag(d: PageDriver, from: number, to: number): Promise<void> {
    const a = await d.call<any>('aim', from, false);
    const b = await d.call<any>('aim', to, false);
    if (!a.ok || !b.ok) throw new AwError('bad_request', 'cannot drag: the source or the destination is hidden or covered by something else');
    let data: any;
    const off = d.s.on('Input.dragIntercepted', (p) => {
      data = p.data;
    });
    await d.s.send('Input.setInterceptDrags', { enabled: true });
    try {
      const mv = (x: number, y: number) => d.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1, pointerType: 'mouse' });
      await d.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, button: 'none', buttons: 0, pointerType: 'mouse' });
      await d.s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        await mv(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
        if (i === 2) await sleep(30); // let the page see the drag begin
      }
      if (data) {
        await d.s.send('Input.dispatchDragEvent', { type: 'dragEnter', x: b.x, y: b.y, data });
        await d.s.send('Input.dispatchDragEvent', { type: 'dragOver', x: b.x, y: b.y, data });
        await d.s.send('Input.dispatchDragEvent', { type: 'drop', x: b.x, y: b.y, data });
      }
      await d.s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    } finally {
      off();
      await d.s.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
  }

  /** Real mouse events at the element's centre; a scripted click when something is in the way. */
  async function click(d: PageDriver, id: number, viaLabel = false, o: { count?: number; button?: 'left' | 'right' | 'middle' } = {}): Promise<void> {
    const a = await d.call<any>('aim', id, viaLabel);
    if (a.option) {
      const r = await d.call<any>('pickOption', id);
      d.note(`chose option "${clip(String(r.label ?? ''), 80)}"`);
      return;
    }
    if (a.tag === 'select') {
      // a native list opens outside the page, where nobody can see it
      await d.call('focus', id);
      d.note('that is a select; use select with the option you want');
      return;
    }
    if (a.ariaDisabled) d.note('that control is marked disabled (aria-disabled)');
    if (a.ok) {
      await mouseClick(d, a.x, a.y, o);
      return;
    }
    await d.run(`__awh.scriptClick(${JSON.stringify(id)})`, { gesture: true }).then((r: any) => {
      if (r && r.err) throw new AwError(r.err, r.msg);
    });
    d.note(`the target was covered by ${a.by || 'another element'}; used a scripted click`);
  }

  async function pressKeys(d: PageDriver, spec: string): Promise<void> {
    for (const ev of chordEvents(parseChord(spec))) await d.s.send('Input.dispatchKeyEvent', ev);
  }

  async function fill(d: PageDriver, id: number, value: string): Promise<void> {
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
    // Typing replaces the selection made by prepFill, and fires the same events a keyboard would.
    if (want) await d.s.send('Input.insertText', { text: want });
    else if (!p.empty) await pressKeys(d, 'Backspace');
    let got = String((await d.call<any>('fieldValue', id)).value ?? '');
    const same = (a: string, b: string) => a === b || a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
    if (!same(got, want)) {
      const limited = p.max > 0 && want.length > p.max && got === want.slice(0, p.max);
      // Nothing we typed is there at all (focus was stolen, or the field ignores typing): write it directly.
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

  async function check(d: PageDriver, id: number, on: boolean): Promise<void> {
    const st = await d.call<any>('checkState', id);
    if (st.kind === 'none') throw new AwError('bad_request', 'that element cannot be checked', 'check works on checkboxes, radio buttons and switches');
    if (st.disabled) throw new AwError('bad_request', `that ${st.kind === 'aria' ? 'control' : st.kind} is disabled`);
    if (st.on === on) return;
    if (st.kind === 'radio' && !on) throw new AwError('bad_request', 'a radio button cannot be unchecked', 'check another option of the group instead');
    await click(d, id, true);
    const after = await d.call<any>('checkState', id);
    if (after.on === on) return;
    if (after.kind === 'aria') {
      // custom switches often update on the next frame
      await sleep(120);
      if ((await d.call<any>('checkState', id)).on === on) return;
      d.note('the control did not change state after the click');
      return;
    }
    const r = await d.call<any>('forceCheck', id, on);
    if (r.ok && r.on === on) d.note('the click did not change it; its state was set directly');
    else d.note('the control did not change state');
  }

  async function hover(d: PageDriver, id: number): Promise<void> {
    const a = await d.call<any>('aim', id, false).catch((e) => {
      // a disabled control can still be hovered (tooltips explain why it is disabled)
      if (e instanceof AwError && e.code === 'bad_request') return { ok: false, by: 'nothing' };
      throw e;
    });
    if (a.ok) {
      await d.s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, button: 'none', buttons: 0, pointerType: 'mouse' });
      return;
    }
    await d.call('hoverSynth', id);
    if (a.by && a.by !== 'nothing') d.note(`the target was covered by ${a.by}; hover events were sent by script`);
  }

  async function scroll(d: PageDriver, to: 'bottom' | 'top' | number, deadline: number): Promise<void> {
    const before = await d.call<any>('scroll', to);
    if (to !== 'bottom') return;
    // lazy lists load when their end comes into view: let that happen, then see whether the page grew
    await d.settle({ deadline: settleBy(deadline), since: Date.now() });
    const after = await d.call<any>('scrollInfo').catch(() => undefined);
    if (after && after.h <= before.h + 2) d.note('reached the end of the page; nothing more loaded');
    else if (after) d.note(`more content loaded (page height ${Math.round(before.h)} → ${Math.round(after.h)} px)`);
  }

  async function wait(d: PageDriver, a: { ms?: number; text?: string }, deadline: number): Promise<void> {
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
        if (await d.run<boolean>(`__awh.waitText(${JSON.stringify(a.text)},${Math.min(left, 5000)})`, { awaitPromise: true, timeoutMs: Math.min(left, 5000) + 2000 })) return;
      } catch (e) {
        if (!(e instanceof AwError) || (e.code !== 'internal' && e.code !== 'timeout')) throw e;
        await sleep(50); // the page navigated or was busy; keep looking until time is up
      }
    }
    throw new AwError('timeout', `"${clip(a.text, 60)}" did not appear within ${Math.max(1, Math.round((Date.now() - started) / 1000))} s`, 'read the page to see what is there instead');
  }

  async function back(d: PageDriver): Promise<void> {
    const h = await d.s.send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory');
    let i = h.currentIndex - 1;
    while (i >= 0 && /^about:blank$/i.test(h.entries[i].url)) i--;
    if (i < 0) throw new AwError('bad_request', 'there is no earlier page in this tab', 'open the URL you want instead');
    await d.s.send('Page.navigateToHistoryEntry', { entryId: h.entries[i].id });
  }

  async function forward(d: PageDriver): Promise<void> {
    const h = await d.s.send<{ currentIndex: number; entries: { id: number; url: string }[] }>('Page.getNavigationHistory');
    const e = h.entries[h.currentIndex + 1];
    if (!e) throw new AwError('bad_request', 'there is no later page in this tab', 'forward() only follows back()');
    await d.s.send('Page.navigateToHistoryEntry', { entryId: e.id });
  }

  async function upload(d: PageDriver, id: number, files: { name: string; mime: string; data: string }[]): Promise<void> {
    if (!Array.isArray(files) || !files.length) throw new AwError('bad_request', 'upload needs at least one file');
    let total = 0;
    const dir = mkdtempSync(join(tmpdir(), 'agentweb-upload-'));
    d.tmpDirs.push(dir); // kept until the context goes: the page reads the files when the form is sent
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const f of files) {
      const bytes = Buffer.from(String(f.data ?? ''), 'base64');
      total += bytes.length;
      if (total > 64 * 1024 * 1024) throw new AwError('too_large', 'uploads are limited to 64 MB per call');
      let name = basename(String(f.name || 'file').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '') || 'file';
      while (seen.has(name)) name = '_' + name;
      seen.add(name);
      const p = join(dir, name);
      writeFileSync(p, bytes);
      paths.push(p);
    }
    if (!(await d.call<boolean>('alive', id))) throw new AwError('stale', 'that element is no longer on the page');
    const target = await d.run<any>(`__awh.fileInput(${JSON.stringify(id)})`, { byValue: false });
    if (target && target.objectId) {
      await d.s.send('DOM.setFileInputFiles', { files: paths, objectId: target.objectId });
      void d.s.send('Runtime.releaseObject', { objectId: target.objectId }).catch(() => {});
      return;
    }
    // Not a file input: it is probably the button that opens the chooser. Press it and answer the chooser.
    const opened = new Promise<any>((resolve) => {
      d.chooser = resolve;
      setTimeout(() => resolve(undefined), 2500);
    });
    await click(d, id);
    const ch = await opened;
    d.chooser = undefined;
    if (!ch || !ch.backendNodeId) throw new AwError('bad_request', 'that element is not a file input and did not open a file chooser', 'target the file input, or the button that opens it');
    await d.s.send('DOM.setFileInputFiles', { files: ch.mode === 'selectMultiple' ? paths : paths.slice(0, 1), backendNodeId: ch.backendNodeId });
  }

  /** Write a file the agent asked to keep next to the session's downloads and say where it is. */
  function keep(d: PageDriver, bytes: Buffer, stem: string, ext: string): string {
    const dir = d.downloadDir || mkdtempSync(join(tmpdir(), 'agentweb-files-'));
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${stem}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.${ext}`);
    writeFileSync(path, bytes);
    return `${path} (${bytes.length} bytes)`;
  }

  async function shot(d: PageDriver, a: Extract<Action, { do: 'shot' }>, out: Out): Promise<Loaded['image'] | undefined> {
    if (a.pdf) {
      const r = await d.s.send<{ data: string }>('Page.printToPDF', { printBackground: true, preferCSSPageSize: true }, 30_000);
      out.value = 'saved PDF: ' + keep(d, Buffer.from(r.data, 'base64'), 'page', 'pdf');
      return undefined;
    }
    const MAX_W = 1024;
    // a picture at a given viewport width (shot(widths=…)) is kept at full size: it is a file, not a message
    if (a.w !== undefined) await relayout(d);
    let clipRect: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    let beyond = false;
    if (a.n !== undefined) {
      const r = await d.call<any>('rect', a.n);
      if (r.w < 1 || r.h < 1) throw new AwError('bad_request', 'that element has no visible box to capture');
      clipRect = { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.w, height: Math.min(r.h, 6000), scale: Math.min(1, MAX_W / r.w) };
      beyond = true;
    } else if (a.full) {
      const m = await d.s.send<any>('Page.getLayoutMetrics');
      const size = m.cssContentSize ?? m.contentSize;
      const height = Math.min(size.height, 8000);
      if (size.height > height) d.note(`the page is ${Math.round(size.height)} px tall; the screenshot shows the first ${height} px`);
      clipRect = { x: 0, y: 0, width: size.width, height, scale: Math.min(1, MAX_W / size.width) };
      beyond = true;
    } else {
      const v = d.viewport;
      const m = await d.s.send<any>('Page.getLayoutMetrics');
      const vv = m.cssVisualViewport ?? m.visualViewport ?? { pageX: 0, pageY: 0 };
      clipRect = { x: vv.pageX ?? 0, y: vv.pageY ?? 0, width: v.width, height: v.height, scale: Math.min(1, MAX_W / v.width) };
      beyond = true;
    }
    if (a.w !== undefined) clipRect.scale = 1;
    let r: { data: string };
    try {
      // element numbers are drawn for this picture only and taken off again before anything else happens
      if (a.labels?.length) await labelsOn(d, a.labels, { x: clipRect.x, y: clipRect.y, w: clipRect.width, h: clipRect.height });
      r = await d.s.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 60, clip: clipRect, captureBeyondViewport: beyond, optimizeForSpeed: true });
    } finally {
      if (a.labels?.length) await labelsOff(d);
    }
    if (a.save) out.value = 'saved screenshot: ' + keep(d, Buffer.from(r.data, 'base64'), a.w !== undefined ? `shot-w${a.w}` : 'shot', 'jpg');
    return a.quiet && a.save ? undefined : { mime: 'image/jpeg', data: r.data };
  }

  async function perform(slot: Slot<PageDriver>, action: Action, deadline: number, out: Out): Promise<Loaded['image'] | undefined> {
    const d = slot.data;
    switch (action.do) {
      case 'click':
        slot.committed = true;
        await click(d, action.n, false, { count: action.count, button: action.button });
        return;
      case 'drag':
        slot.committed = true;
        await drag(d, action.n, action.to);
        return;
      case 'js':
        slot.committed = true;
        out.value = await d.evalJs(action.code);
        return;
      case 'log':
        out.value = await d.readLog(action);
        return;
      case 'dialog':
        d.dialogAnswer = { accept: action.accept, text: action.text ?? '' };
        return;
      case 'forward':
        slot.committed = true;
        await forward(d);
        return;
      case 'fill':
        slot.committed = true;
        await fill(d, action.n, action.value);
        return;
      case 'select': {
        slot.committed = true;
        await d.call('select', action.n, String(action.value ?? ''));
        return;
      }
      case 'check':
        slot.committed = true;
        await check(d, action.n, !!action.on);
        return;
      case 'press':
        if (action.n !== undefined) await d.call('focus', action.n);
        parseChord(action.key); // reject a bad key before anything is sent
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
        await back(d);
        return;
      case 'upload':
        slot.committed = true;
        await upload(d, action.n, action.files);
        return;
      case 'shot':
        return shot(d, action, out);
      case 'probe':
        out.value = await runCheck(d, action);
        return;
      default:
        throw new AwError('bad_request', `unknown action "${(action as { do: string }).do}"`);
    }
  }

  // ───────────────────────────── engine ─────────────────────────────

  return {
    tier: 'chrome',

    async available() {
      if (pool.current()) return true;
      if (opts.endpoint) {
        // reachable means: something answers the DevTools handshake there right now
        try {
          const cdp = await connect(opts.endpoint, 3000);
          try {
            await cdp.send('Browser.getVersion', undefined, { timeoutMs: 3000 });
            return true;
          } finally {
            cdp.close('probe done');
          }
        } catch {
          return false;
        }
      }
      const exe = opts.executable ?? findBrowser(opts.env);
      if (!exe) return false;
      try {
        accessSync(exe, constants.X_OK);
        return statSync(exe).isFile();
      } catch {
        return false;
      }
    },

    async open(ctx: SessionCtx, req: NavRequest): Promise<Loaded> {
      const t0 = performance.now();
      const method = req.method === 'POST' ? 'POST' : 'GET';
      // Ask before a browser is even involved.
      const v = await ctx.guard.checkUrl(req.url, method === 'POST' ? 'submit' : 'open');
      if (!v.ok) throw new AwError('policy', v.reason);
      n.opens++;
      return serve(ctx, async (slot, fresh, deadline) => {
        const d = slot.data;
        const bytes0 = d.bytes;
        if (fresh) await hydrate(d, ctx);
        else {
          await d.begin(ctx);
          await Promise.all([d.cookiesIn(ctx), d.storageIn(ctx)]);
        }
        if (v.warn) d.note(clip(v.warn, 200));
        const reshape = method === 'POST' || req.headers ? { method, body: req.body, contentType: req.contentType, headers: req.headers } as const : undefined;
        if (method === 'POST') slot.committed = true;
        d.expect(req.url, reshape);
        await d.navigate(req.url, req.referer, deadline);
        await d.settle({ deadline: settleBy(deadline) });
        return finish(d, ctx, t0, bytes0, deadline);
      });
    },

    async act(ctx: SessionCtx, action: Action): Promise<Loaded> {
      const t0 = performance.now();
      if (!pool.live(ctx.id) && !ctx.url) throw new AwError('gone', 'this session has no live page', 'open a URL first');
      n.acts++;
      return serve(ctx, async (slot, fresh, deadline) => {
        const d = slot.data;
        const bytes0 = d.bytes;
        if (fresh) {
          if (!ctx.url) throw new AwError('gone', 'this session has no live page', 'open a URL first');
          await hydrate(d, ctx);
          await rehydrate(d, ctx, deadline);
        } else {
          await d.begin(ctx);
          await Promise.all([d.cookiesIn(ctx), d.storageIn(ctx)]);
        }
        d.setActing(true);
        const since = Date.now();
        const out: Out = {};
        const image = await perform(slot, action, deadline, out);
        const light = LIGHT[action.do];
        await d.settle({
          deadline: settleBy(deadline),
          since,
          netQuietMs: light ? Math.min(100, driverOpts.netQuietMs) : undefined,
          domQuietMs: light ? Math.min(100, driverOpts.domQuietMs) : undefined,
        });
        d.setActing(false);
        return finish(d, ctx, t0, bytes0, deadline, image, out.value);
      });
    },

    async snapshot(ctx: SessionCtx): Promise<Loaded> {
      const t0 = performance.now();
      if (!pool.live(ctx.id) && !ctx.url) throw new AwError('gone', 'this session has no live page', 'open a URL first');
      n.snapshots++;
      return serve(ctx, async (slot, fresh, deadline) => {
        const d = slot.data;
        const bytes0 = d.bytes;
        if (fresh) {
          if (!ctx.url) throw new AwError('gone', 'this session has no live page', 'open a URL first');
          await hydrate(d, ctx);
          await rehydrate(d, ctx, deadline);
        } else {
          await d.begin(ctx);
          await Promise.all([d.cookiesIn(ctx), d.storageIn(ctx)]);
          await d.settle({ deadline: settleBy(deadline) });
        }
        return finish(d, ctx, t0, bytes0, deadline);
      });
    },

    live(sessionId: string): boolean {
      return pool.live(sessionId);
    },

    async release(sessionId: string): Promise<void> {
      await pool.release(sessionId);
    },

    async close(): Promise<void> {
      await pool.close();
    },

    stats(): Record<string, number> {
      return { ...pool.stats(), ...n };
    },

    browser(): Browser | undefined {
      return pool.current();
    },
  };
}
