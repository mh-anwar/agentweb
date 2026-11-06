// One browser, many sessions. Each session gets its own BrowserContext (cookies, storage and
// cache are isolated) with exactly one page in it. Contexts are disposable: the session's cookie
// jar and localStorage snapshot live outside the browser, so evicting a context loses only the JS
// heap. The pool decides who stays alive (LRU + idle TTL), relaunches a browser that died, and
// folds popups back into the page that opened them.

import { AwError } from '../../types.ts';
import type { CdpSession } from './cdp.ts';
import { launch, type Browser, type LaunchOptions } from './launch.ts';

export interface PoolOptions extends LaunchOptions {
  /** live contexts kept at most (default 24) */
  maxContexts?: number;
  /** a context untouched for this long is disposed (default 10 minutes) */
  idleMs?: number;
  /** the browser itself is shut down after this long with no contexts (default 5 minutes; 0 = never) */
  browserIdleMs?: number;
}

export interface Slot<T> {
  /** agent session id */
  id: string;
  browser: Browser;
  contextId: string;
  targetId: string;
  session: CdpSession;
  createdAt: number;
  lastUsed: number;
  busy: boolean;
  /** why this slot can no longer be used ('' while it can) */
  dead: string;
  /**
   * Set by the engine once a call has done something that must not be repeated (a click, a POST).
   * Until then a call that fails because the browser vanished is retried on a fresh browser.
   */
  committed: boolean;
  data: T;
}

export interface PoolHooks<T> {
  /** The page exists but has not run anything yet. Enable domains and install scripts here. */
  create(slot: Slot<T>): Promise<T>;
  /** Synchronous cleanup of engine data (temp files, timers). The context is disposed by the pool. */
  dispose?(slot: Slot<T>, reason: string): void;
  /** The page opened a new window; it has already been closed. */
  popup?(slot: Slot<T>): void;
}

const noop = () => {};

export class Pool<T> {
  readonly maxContexts: number;
  readonly idleMs: number;
  readonly browserIdleMs: number;

  private opts: PoolOptions;
  private hooks: PoolHooks<T>;
  private browser: Browser | undefined;
  private starting: Promise<Browser> | undefined;
  private slots = new Map<string, Slot<T>>();
  private byContext = new Map<string, Slot<T>>();
  private bySession = new Map<string, Slot<T>>();
  /** contexts being created: browserContextId -> resolver for the page's session */
  private expecting = new Map<string, (v: { sessionId: string; targetId: string }) => void>();
  private locks = new Map<string, Promise<void>>();
  private waiters: (() => void)[] = [];
  private creating = 0;
  private closed = false;
  private closing = false;
  private timer: NodeJS.Timeout | undefined;
  private emptySince = Date.now();

  private n = { launches: 0, crashes: 0, evictions: 0, expired: 0, created: 0, popups: 0, retries: 0, createMs: 0, launchMs: 0 };

  constructor(opts: PoolOptions, hooks: PoolHooks<T>) {
    this.opts = opts;
    this.hooks = hooks;
    this.maxContexts = Math.max(1, opts.maxContexts ?? 24);
    this.idleMs = Math.max(0, opts.idleMs ?? 600_000);
    this.browserIdleMs = Math.max(0, opts.browserIdleMs ?? 300_000);
  }

  live(id: string): boolean {
    const s = this.slots.get(id);
    return !!s && !s.dead && s.browser.alive();
  }

  current(): Browser | undefined {
    return this.browser && this.browser.alive() ? this.browser : undefined;
  }

  /**
   * Run `fn` with the session's page, creating it if needed. Calls for one session run one at a
   * time; calls for different sessions run concurrently. `fresh` tells the callee that the page was
   * just created and holds nothing of the session yet.
   */
  async use<R>(id: string, timeoutMs: number, fn: (slot: Slot<T>, fresh: boolean) => Promise<R>): Promise<R> {
    if (this.closed) throw new AwError('gone', 'the browser engine is closed');
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    const prev = this.locks.get(id) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((r) => (unlock = r));
    const tail = prev.then(() => gate);
    this.locks.set(id, tail);
    await prev;
    try {
      for (let attempt = 0; ; attempt++) {
        if (this.closed) throw new AwError('gone', 'the browser engine is closed');
        let slot = this.slots.get(id);
        let fresh = false;
        try {
          if (slot && (slot.dead || !slot.browser.alive())) {
            this.drop(slot, slot.dead || 'browser gone');
            slot = undefined;
          }
          if (!slot) {
            slot = await this.createSlot(id, deadline);
            fresh = true;
          }
          slot.busy = true;
          slot.committed = false;
          return await fn(slot, fresh);
        } catch (e) {
          const gone = e instanceof AwError && e.code === 'gone';
          const lost = !slot || !!slot.dead || !slot.browser.alive();
          // The browser (or just this page) died under us. If nothing irreversible was sent, do it again.
          if (gone && lost && attempt === 0 && !(slot && slot.committed) && !this.closed && Date.now() < deadline) {
            if (slot) this.drop(slot, 'browser gone');
            this.n.retries++;
            continue;
          }
          if (slot && gone && lost) this.drop(slot, 'browser gone');
          throw e;
        } finally {
          if (slot) {
            slot.busy = false;
            slot.lastUsed = Date.now();
          }
          this.wake();
        }
      }
    } finally {
      unlock();
      if (this.locks.get(id) === tail) this.locks.delete(id);
    }
  }

  /** Dispose the session's context now. Waits for a call in flight on that session to finish. */
  async release(id: string): Promise<void> {
    const prev = this.locks.get(id);
    if (prev) await prev.catch(noop);
    const slot = this.slots.get(id);
    if (slot) await this.drop(slot, 'released');
  }

  /** Mark a slot unusable (page crashed, engine gave up on it); it is disposed on the next use. */
  kill(slot: Slot<T>, reason: string): void {
    if (!slot.dead) slot.dead = reason;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const w of this.waiters.splice(0)) w();
    const pending = this.starting;
    for (const slot of [...this.slots.values()]) this.hooks.dispose?.(slot, 'closed');
    this.slots.clear();
    this.byContext.clear();
    this.bySession.clear();
    let b = this.browser;
    if (!b && pending) b = await pending.catch(() => undefined);
    this.browser = undefined;
    if (b) await b.close();
  }

  stats(): Record<string, number> {
    let busy = 0;
    for (const s of this.slots.values()) if (s.busy) busy++;
    const b = this.current();
    const mem = b ? b.memory() : { rss: 0, pss: 0, processes: 0 };
    return {
      contexts: this.slots.size,
      busy,
      waiting: this.waiters.length,
      launches: this.n.launches,
      crashes: this.n.crashes,
      evictions: this.n.evictions,
      expired: this.n.expired,
      created: this.n.created,
      popups: this.n.popups,
      retries: this.n.retries,
      createMsAvg: this.n.created ? Math.round((this.n.createMs / this.n.created) * 10) / 10 : 0,
      launchMs: Math.round(this.n.launchMs),
      processes: mem.processes,
      rssBytes: mem.rss,
    };
  }

  // ───────────────────────────── browser ─────────────────────────────

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) {
      if (this.browser.alive()) return this.browser;
      this.lostBrowser(this.browser);
    }
    if (!this.starting) {
      this.starting = this.start().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  private async start(): Promise<Browser> {
    const b = await launch(this.opts);
    this.n.launches++;
    this.n.launchMs = b.launchMs;
    const cdp = b.cdp;
    cdp.on('Target.attachedToTarget', (p) => this.onAttached(b, p));
    cdp.on('Target.detachedFromTarget', (p) => {
      const slot = this.bySession.get(p.sessionId);
      if (slot && !slot.dead) slot.dead = 'the page was closed';
    });
    cdp.on('Target.targetCrashed', (p) => {
      for (const slot of this.slots.values()) if (slot.targetId === p.targetId && !slot.dead) slot.dead = 'the page crashed';
    });
    b.onExit(() => {
      if (!this.closing && this.browser === b) this.n.crashes++;
      this.lostBrowser(b);
    });
    try {
      // Every new page is attached paused, so nothing runs before the engine has set it up, and a
      // popup can be closed before it loads anything.
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page', exclude: false }] });
    } catch (e) {
      await b.close();
      throw e;
    }
    if (this.closed) {
      await b.close();
      throw new AwError('gone', 'the browser engine is closed');
    }
    this.browser = b;
    this.emptySince = Date.now();
    if (!this.timer) {
      const every = Math.min(30_000, Math.max(250, Math.floor(Math.min(this.idleMs || Infinity, this.browserIdleMs || Infinity, 120_000) / 4)));
      this.timer = setInterval(() => this.sweep(), every);
      this.timer.unref();
    }
    return b;
  }

  /** Every slot of a dead browser is gone with it: nothing to dispose over CDP. */
  private lostBrowser(b: Browser): void {
    for (const slot of [...this.slots.values()]) {
      if (slot.browser !== b) continue;
      slot.dead ||= 'browser gone';
      this.forget(slot, 'browser gone');
    }
    for (const [ctx, resolve] of [...this.expecting]) {
      this.expecting.delete(ctx);
      resolve({ sessionId: '', targetId: '' });
    }
    if (this.browser === b) this.browser = undefined;
    this.wake();
  }

  private onAttached(b: Browser, p: any): void {
    const info = p.targetInfo ?? {};
    const sessionId: string = p.sessionId;
    const ctx: string = info.browserContextId ?? '';
    const expect = this.expecting.get(ctx);
    if (expect && !info.openerId) {
      this.expecting.delete(ctx);
      expect({ sessionId, targetId: info.targetId });
      return;
    }
    const owner = this.byContext.get(ctx);
    if (owner || expect) {
      // A second page in one of our contexts is a popup (window.open, target=_blank). A session has
      // one page, so close it; the engine navigates the opener there instead. A popup that can reach
      // its opener blocks the opener until it runs, so let it run with its network cut off.
      this.n.popups++;
      const ps = b.cdp.session(sessionId);
      ps.on('Fetch.requestPaused', (q) => void ps.send('Fetch.failRequest', { requestId: q.requestId, errorReason: 'Aborted' }).catch(noop));
      void ps.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }).catch(noop);
      void ps.send('Runtime.runIfWaitingForDebugger').catch(noop);
      void b.cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(noop).then(() => b.cdp.dropSession(sessionId, 'popup closed'));
      if (owner) {
        try {
          this.hooks.popup?.(owner);
        } catch {}
      }
      return;
    }
    // Not ours (a shared remote browser): let it go on its way.
    void b.cdp.send('Runtime.runIfWaitingForDebugger', undefined, { sessionId }).catch(noop);
    void b.cdp.send('Target.detachFromTarget', { sessionId }).catch(noop);
  }

  // ───────────────────────────── slots ─────────────────────────────

  private async createSlot(id: string, deadline: number): Promise<Slot<T>> {
    await this.makeRoom(deadline);
    this.creating++;
    let contextId = '';
    let b: Browser | undefined;
    try {
      b = await this.ensureBrowser();
      const cdp = b.cdp;
      const t0 = performance.now();
      const made = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: false });
      contextId = made.browserContextId;
      const attached = new Promise<{ sessionId: string; targetId: string }>((resolve) => this.expecting.set(contextId, resolve));
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: contextId });
      const at = await Promise.race([
        attached,
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => reject(new AwError('timeout', 'the browser did not open a page in 15 s')), 15_000);
          void attached.then(() => clearTimeout(t));
        }),
      ]);
      if (!at.sessionId) throw new AwError('gone', 'the browser went away while opening a page');
      const now = Date.now();
      const slot: Slot<T> = {
        id,
        browser: b,
        contextId,
        targetId: at.targetId || targetId,
        session: cdp.session(at.sessionId),
        createdAt: now,
        lastUsed: now,
        busy: true,
        dead: '',
        committed: false,
        data: undefined as T,
      };
      this.byContext.set(contextId, slot);
      this.bySession.set(at.sessionId, slot);
      try {
        slot.data = await this.hooks.create(slot);
        await slot.session.send('Runtime.runIfWaitingForDebugger');
      } catch (e) {
        this.byContext.delete(contextId);
        this.bySession.delete(at.sessionId);
        cdp.dropSession(at.sessionId);
        throw e;
      }
      this.slots.set(id, slot);
      this.n.created++;
      this.n.createMs += performance.now() - t0;
      return slot;
    } catch (e) {
      this.expecting.delete(contextId);
      if (contextId && b && b.alive()) void b.cdp.send('Target.disposeBrowserContext', { browserContextId: contextId }).catch(noop);
      throw e;
    } finally {
      this.creating--;
      this.wake();
    }
  }

  /** Keep the number of contexts at or under the limit: evict the least recently used idle one, or wait. */
  private async makeRoom(deadline: number): Promise<void> {
    for (;;) {
      if (this.closed) throw new AwError('gone', 'the browser engine is closed');
      if (this.slots.size + this.creating < this.maxContexts) return;
      let victim: Slot<T> | undefined;
      for (const s of this.slots.values()) {
        if (s.busy) continue;
        if (!victim || s.lastUsed < victim.lastUsed) victim = s;
      }
      if (victim) {
        this.n.evictions++;
        void this.drop(victim, 'evicted');
        continue;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new AwError('timeout', `all ${this.maxContexts} browser contexts are busy`, 'try again shortly, or raise maxContexts');
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, left);
        function done() {
          clearTimeout(t);
          resolve();
        }
        this.waiters.push(done);
      });
    }
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private forget(slot: Slot<T>, reason: string): void {
    if (this.slots.get(slot.id) === slot) this.slots.delete(slot.id);
    if (this.byContext.get(slot.contextId) === slot) this.byContext.delete(slot.contextId);
    this.bySession.delete(slot.session.id);
    try {
      this.hooks.dispose?.(slot, reason);
    } catch {}
    if (!this.slots.size) this.emptySince = Date.now();
  }

  private async drop(slot: Slot<T>, reason: string): Promise<void> {
    slot.dead ||= reason;
    this.forget(slot, reason);
    const b = slot.browser;
    if (!b.alive()) return;
    try {
      await b.cdp.send('Target.disposeBrowserContext', { browserContextId: slot.contextId }, { timeoutMs: 10_000 });
    } catch {}
    b.cdp.dropSession(slot.session.id, reason);
    this.wake();
  }

  private sweep(): void {
    if (this.closed) return;
    const now = Date.now();
    if (this.idleMs) {
      for (const slot of [...this.slots.values()]) {
        if (slot.busy || this.locks.has(slot.id)) continue;
        if (now - slot.lastUsed >= this.idleMs) {
          this.n.expired++;
          void this.drop(slot, 'idle');
        }
      }
    }
    const b = this.browser;
    if (b && this.browserIdleMs && !this.slots.size && !this.creating && !this.starting && now - this.emptySince >= this.browserIdleMs) {
      // Nobody has needed a browser for a while: give the memory back. The next call launches a new one.
      this.browser = undefined;
      this.closing = true;
      void b.close().finally(() => {
        this.closing = this.closed;
      });
    }
  }
}
