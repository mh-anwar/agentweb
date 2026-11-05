// Politeness: a per-origin concurrency limit with FIFO order inside each origin, an optional
// per-origin minimum interval between request starts, and a global cap. When a global slot frees
// up, origins with waiters are served round-robin, so one origin with a deep queue cannot starve
// the others.

import { AwError } from '../types.ts';

export interface LimiterOptions {
  /** concurrent requests per origin (default 6, like a browser) */
  perOrigin?: number;
  /** concurrent requests across all origins (default 256) */
  global?: number;
  /** minimum ms between request starts to the same origin (default 0) */
  minIntervalMs?: number;
  /** per-origin overrides, e.g. { 'http://127.0.0.1:8080': { perOrigin: 64 } } */
  origins?: Record<string, { perOrigin?: number; minIntervalMs?: number }>;
  /** max waiters per origin before acquire() fails fast with AwError('blocked') (default 10000) */
  maxQueue?: number;
}

export interface LimiterStats {
  active: number;
  queued: number;
  origins: number;
  granted: number;
  waited: number;
  aborted: number;
  rejected: number;
  maxQueued: number;
}

export interface Limiter {
  /** wait for a slot; resolves to a release function (idempotent) */
  acquire(origin: string, signal?: AbortSignal): Promise<() => void>;
  /** queue depth for one origin, or across all origins */
  depth(origin?: string): number;
  active(origin?: string): number;
  stats(): LimiterStats;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (e: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  queuedAt: number;
}

interface OriginState {
  key: string;
  active: number;
  queue: Waiter[];
  /** index of the first live waiter (queue is compacted lazily) */
  head: number;
  lastStart: number;
  limit: number;
  interval: number;
  timer?: NodeJS.Timeout;
  inRing: boolean;
}

export function createLimiter(opts: LimiterOptions = {}): Limiter {
  const perOrigin = Math.max(1, opts.perOrigin ?? 6);
  const globalCap = Math.max(1, opts.global ?? 256);
  const minInterval = Math.max(0, opts.minIntervalMs ?? 0);
  const maxQueue = opts.maxQueue ?? 10_000;
  const origins = new Map<string, OriginState>();
  /** origins that have waiters, in round-robin order */
  const ring: OriginState[] = [];
  let globalActive = 0;
  let queuedTotal = 0;
  const st = { granted: 0, waited: 0, aborted: 0, rejected: 0, maxQueued: 0 };

  function state(origin: string): OriginState {
    let s = origins.get(origin);
    if (!s) {
      const o = opts.origins?.[origin];
      s = { key: origin, active: 0, queue: [], head: 0, lastStart: 0, limit: Math.max(1, o?.perOrigin ?? perOrigin), interval: Math.max(0, o?.minIntervalMs ?? minInterval), inRing: false };
      origins.set(origin, s);
    }
    return s;
  }

  const pending = (s: OriginState) => s.queue.length - s.head;

  function gc(s: OriginState) {
    if (s.active === 0 && pending(s) === 0 && !s.timer && (s.interval === 0 || Date.now() - s.lastStart >= s.interval)) origins.delete(s.key);
  }

  function makeRelease(s: OriginState): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      s.active--;
      globalActive--;
      pump();
      gc(s);
    };
  }

  function grant(s: OriginState, w: Waiter | undefined): (() => void) {
    s.active++;
    globalActive++;
    s.lastStart = Date.now();
    st.granted++;
    const rel = makeRelease(s);
    if (w) {
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      w.resolve(rel);
    }
    return rel;
  }

  /** can `s` start a request right now? returns ms to wait for the interval, 0 = yes, -1 = no */
  function ready(s: OriginState): number {
    if (s.active >= s.limit) return -1;
    if (s.interval > 0 && s.lastStart > 0) {
      const wait = s.lastStart + s.interval - Date.now();
      if (wait > 0) return wait;
    }
    return 0;
  }

  function pump() {
    let scanned = 0;
    while (globalActive < globalCap && ring.length && scanned < ring.length) {
      const s = ring.shift()!;
      s.inRing = false;
      if (pending(s) === 0) continue;
      const r = ready(s);
      if (r === 0) {
        const w = s.queue[s.head];
        s.queue[s.head++] = undefined as unknown as Waiter;
        if (s.head > 64 && s.head * 2 > s.queue.length) { s.queue = s.queue.slice(s.head); s.head = 0; }
        queuedTotal--;
        grant(s, w);
        scanned = 0;
      } else {
        scanned++;
        if (r > 0 && !s.timer) {
          s.timer = setTimeout(() => { s.timer = undefined; pump(); gc(s); }, r);
          s.timer.unref?.();
        }
      }
      if (pending(s) > 0) { ring.push(s); s.inRing = true; }
    }
  }

  return {
    acquire(origin: string, signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      const s = state(origin);
      // fast path: nobody is waiting anywhere, so FIFO order cannot be violated
      if (queuedTotal === 0 && globalActive < globalCap && ready(s) === 0) {
        return Promise.resolve(grant(s, undefined));
      }
      if (pending(s) >= maxQueue) {
        st.rejected++;
        return Promise.reject(new AwError('blocked', `too many queued requests for ${origin}`, 'slow down or retry later'));
      }
      st.waited++;
      return new Promise((resolve, reject) => {
        const w: Waiter = { resolve, reject, signal, queuedAt: Date.now() };
        if (signal) {
          w.onAbort = () => {
            const i = s.queue.indexOf(w, s.head);
            if (i < 0) return;
            s.queue.splice(i, 1);
            queuedTotal--;
            st.aborted++;
            reject(abortError(signal));
            gc(s);
          };
          signal.addEventListener('abort', w.onAbort, { once: true });
        }
        s.queue.push(w);
        queuedTotal++;
        if (queuedTotal > st.maxQueued) st.maxQueued = queuedTotal;
        if (!s.inRing) { ring.push(s); s.inRing = true; }
        pump();
      });
    },
    depth(origin?: string): number {
      if (origin === undefined) return queuedTotal;
      const s = origins.get(origin);
      return s ? pending(s) : 0;
    },
    active(origin?: string): number {
      if (origin === undefined) return globalActive;
      return origins.get(origin)?.active ?? 0;
    },
    stats(): LimiterStats {
      return { active: globalActive, queued: queuedTotal, origins: origins.size, ...st };
    },
  };
}

function abortError(signal: AbortSignal): unknown {
  const r = signal.reason;
  if (r instanceof AwError) return r;
  if (r instanceof Error && r.name === 'TimeoutError') return new AwError('timeout', 'timed out waiting for a connection slot');
  return new AwError('timeout', 'aborted while waiting for a connection slot');
}
