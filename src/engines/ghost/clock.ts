// The page clock. Runs inside the page process.
//
// Virtual time is "real time plus whatever has been skipped": it never goes backwards, a busy
// wait on Date.now() still terminates, and when nothing is runnable except a timer the clock
// jumps straight to it. No real timer is ever armed for page code, so a page only executes
// while the engine is inside `settle()`.
//
// Repetition is tracked by lineage, not by guessing at call sites: a timer armed (directly, or
// through any chain of promises) from inside a timer with the same delay extends that timer's
// chain. A chain that grows past the limit is polling or animation; it is parked and stops
// holding the settle open.

import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_LIMITS } from './protocol.ts';
import type { Limits } from './protocol.ts';

export type TaskKind = 'timeout' | 'interval' | 'frame' | 'idle' | 'port';

interface Chain {
  delay: number;
  kind: TaskKind;
  /** consecutive firings in this lineage with the same kind and delay */
  count: number;
  /** identity shared by the whole lineage */
  root: object;
}

export interface Task {
  id: number;
  kind: TaskKind;
  due: number;
  seq: number;
  run: (now: number) => void;
  period: number;
  chain: Chain;
  /** background: does not hold a settle open, runs at most once per settle */
  bg: boolean;
  dead: boolean;
  /** index in the heap, -1 when not queued */
  at: number;
}

export interface SettleHooks {
  limits: Limits;
  /** real ms this settle may take at most (already clipped to the operation budget) */
  wallMs: number;
  /** requests and resources the page is still waiting for */
  inflight(): number;
  /** resolve on the next network delivery or after `ms`, whichever is first */
  waitActivity(ms: number): Promise<void>;
  /** stop early (navigation requested, page destroyed) */
  stop(): string | undefined;
  /** the in-flight requests have outlived the wait budget: stop counting them */
  background(): void;
  /** run page code under the CPU guard */
  guard(fn: () => void): void;
  /** extra condition checked when idle (used by `wait text`) */
  until?: () => boolean;
  /** the document itself is still doing work that is not a timer (parsing, module graphs, history traversal) */
  busy?: () => boolean;
}

export interface SettleStats {
  tasks: number;
  skippedMs: number;
  wallMs: number;
  stop: string;
}

const lineage = new AsyncLocalStorage<Chain>();
const tick = () => new Promise<void>((r) => setImmediate(r));

/** capture the current lineage so a later host callback (XHR events) continues it */
export const bindLineage = <T extends (...a: any[]) => any>(fn: T): T => {
  const chain = lineage.getStore();
  if (!chain) return fn;
  return ((...a: any[]) => lineage.run(chain, () => fn(...a))) as T;
};

export class Clock {
  /** wall clock at page creation, ms since the Unix epoch */
  readonly epoch = Date.now();
  private readonly t0 = performance.now();
  skipped = 0;
  /** bumped by anything that might have made the page runnable again */
  activity = 0;
  private heap: Task[] = [];
  private byId = new Map<number, Task>();
  private parked: Task[] = [];
  private nextId = 1;
  private seq = 0;
  private limits: Limits = DEFAULT_LIMITS;
  private frames = 0;
  private lastFrame = -1;
  private framesBg = false;
  private settling = false;

  /** virtual ms since the page was created */
  now(): number {
    return performance.now() - this.t0 + this.skipped;
  }

  dateNow(): number {
    return Math.floor(this.epoch + this.now());
  }

  get pending(): number {
    return this.byId.size;
  }

  add(kind: TaskKind, delay: number, run: (now: number) => void, repeat = false): number {
    delay = Number.isFinite(delay) && delay > 0 ? Math.min(delay, 2 ** 31 - 1) : 0;
    const now = this.now();
    let due = now + delay;
    if (kind === 'frame') due = Math.floor(now / 16) * 16 + 16; // callbacks of one frame share a timestamp
    const parent = lineage.getStore();
    const chain: Chain =
      parent && parent.kind === kind && parent.delay === delay
        ? { delay, kind, count: parent.count + 1, root: parent.root }
        : { delay, kind, count: 1, root: {} };
    const task: Task = { id: this.nextId++, kind, due, seq: this.seq++, run, period: repeat ? Math.max(delay, 1) : 0, chain, bg: false, dead: false, at: -1 };
    // a lineage that keeps re-arming the same timer is polling: from here on it is background
    if (!repeat && kind !== 'frame' && chain.count > this.allowance(task)) task.bg = true;
    this.byId.set(task.id, task);
    this.push(task);
    this.activity++;
    return task.id;
  }

  cancel(id: number, kind?: TaskKind): void {
    const task = this.byId.get(id);
    if (!task) return;
    // timeouts and intervals share one id space, frames and idle callbacks have their own verbs
    if (kind && (kind === 'frame' || kind === 'idle' || task.kind === 'frame' || task.kind === 'idle') && task.kind !== kind) return;
    task.dead = true;
    this.byId.delete(id);
    if (task.at >= 0) this.removeAt(task.at);
    else this.parked = this.parked.filter((t) => t !== task);
  }

  /** drop everything (page is being destroyed) */
  clear(): void {
    for (const t of this.byId.values()) t.dead = true;
    this.byId.clear();
    this.heap = [];
    this.parked = [];
  }

  /** how many firings of one chain are allowed in a settle before it is treated as background */
  private allowance(task: Task): number {
    const limits = this.limits;
    if (task.kind === 'port') return Infinity;
    if (task.kind === 'frame') return limits.frameLimit;
    if (task.kind === 'idle') return limits.frameLimit;
    const d = task.kind === 'interval' ? task.period : task.chain.delay;
    if (task.kind === 'timeout' && d < 5) return Infinity; // zero-delay chunking is work, not polling; maxTasks bounds it
    return d < 50 ? limits.frameLimit : limits.repeatLimit;
  }

  async settle(h: SettleHooks): Promise<SettleStats> {
    if (this.settling) throw new Error('settle re-entered');
    this.settling = true;
    const { limits } = h;
    this.limits = limits;
    const wall0 = performance.now();
    const skipped0 = this.skipped;
    let tasks = 0;
    let netWaited = 0;
    let stop = 'settled';
    const bgRan = new Set<object>();
    this.frames = 0;
    this.lastFrame = -1;
    // parked background work gets one more turn per settle, from now
    const now0 = this.now();
    for (const t of this.parked) {
      if (t.dead) continue;
      t.due = Math.max(t.due, now0);
      this.push(t);
    }
    this.parked = [];
    try {
      for (;;) {
        await tick(); // drains microtasks, lets IPC and jsdom's own task queue run
        const why = h.stop();
        if (why) {
          stop = why;
          break;
        }
        const wall = performance.now() - wall0;
        if (wall > h.wallMs) {
          stop = 'wall';
          break;
        }
        if (tasks >= limits.maxTasks) {
          stop = 'tasks';
          break;
        }
        const now = this.now();
        const task = this.heap[0];
        if (task && task.due <= now) {
          this.removeAt(0);
          if (this.fire(task, now, limits, bgRan, h)) tasks++;
          continue;
        }
        const inflight = h.inflight();
        if (inflight > 0) {
          if (netWaited >= limits.netWaitMs) {
            h.background();
            continue;
          }
          const t0 = performance.now();
          const untilTask = task ? Math.max(1, task.due - now) : Infinity;
          await h.waitActivity(Math.max(1, Math.min(limits.netWaitMs - netWaited, untilTask, h.wallMs - wall, 250)));
          netWaited += performance.now() - t0;
          continue;
        }
        if (h.busy && h.busy() && netWaited < limits.netWaitMs) {
          const t0 = performance.now();
          await h.waitActivity(Math.max(1, Math.min(5, h.wallMs - wall)));
          netWaited += performance.now() - t0;
          continue;
        }
        // nothing runnable and nothing in flight: make sure the process is really quiet
        const mark = this.activity;
        await tick();
        await tick();
        if (this.activity !== mark || h.inflight() > 0 || (this.heap[0] && this.heap[0].due <= this.now())) continue;
        if (h.until && h.until()) {
          stop = 'found';
          break;
        }
        const next = this.nextForeground();
        if (!next) break;
        const gap = next.due - this.now();
        if (gap > limits.horizonMs && !h.until) break;
        const used = this.skipped - skipped0;
        if (used + gap > limits.maxVirtualMs) {
          stop = h.until ? 'waited' : 'virtual';
          break;
        }
        if (gap > 0) this.skipped += gap;
      }
    } finally {
      this.settling = false;
    }
    return { tasks, skippedMs: Math.round(this.skipped - skipped0), wallMs: Math.round(performance.now() - wall0), stop };
  }

  /** move the clock forward by `ms`, running what comes due (used by `wait ms`) */
  skip(ms: number): void {
    if (ms > 0) this.skipped += ms;
  }

  private fire(task: Task, now: number, limits: Limits, bgRan: Set<object>, h: SettleHooks): boolean {
    if (task.dead) return false;
    const chain = task.chain;
    if (task.kind === 'frame') {
      if (task.due !== this.lastFrame) {
        this.lastFrame = task.due;
        this.frames++;
      }
      if (this.frames > (this.framesBg ? 3 : limits.frameLimit)) {
        this.framesBg = true;
        task.bg = true;
        this.parked.push(task);
        return false;
      }
    } else if (task.bg) {
      // background work runs once per settle, then waits for the next one
      if (bgRan.has(chain.root)) {
        this.parked.push(task);
        return false;
      }
      bgRan.add(chain.root);
    }
    if (task.period) {
      chain.count++; // an interval is its own lineage
      if (!task.bg && chain.count > this.allowance(task)) task.bg = true;
      task.due = Math.max(task.due + task.period, now); // never replay missed firings
      task.seq = this.seq++;
      this.push(task);
    } else {
      this.byId.delete(task.id);
    }
    lineage.run(chain, () => h.guard(() => task.run(now)));
    return true;
  }

  private push(task: Task): void {
    const heap = this.heap;
    let i = heap.length;
    heap.push(task);
    task.at = i;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(heap[i], heap[p])) break;
      swap(heap, i, p);
      i = p;
    }
  }

  private removeAt(i: number): void {
    const heap = this.heap;
    const task = heap[i];
    const last = heap.pop()!;
    task.at = -1;
    if (last === task) return;
    heap[i] = last;
    last.at = i;
    // sift up, then down
    let k = i;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (!before(heap[k], heap[p])) break;
      swap(heap, k, p);
      k = p;
    }
    for (;;) {
      const l = k * 2 + 1;
      const r = l + 1;
      let m = k;
      if (l < heap.length && before(heap[l], heap[m])) m = l;
      if (r < heap.length && before(heap[r], heap[m])) m = r;
      if (m === k) break;
      swap(heap, k, m);
      k = m;
    }
  }

  private nextForeground(): Task | undefined {
    let best: Task | undefined;
    for (const t of this.heap) if (!t.bg && !t.dead && (!best || before(t, best))) best = t;
    return best;
  }
}

const before = (a: Task, b: Task) => a.due < b.due || (a.due === b.due && a.seq < b.seq);
const swap = (heap: Task[], i: number, j: number) => {
  const a = heap[i];
  const b = heap[j];
  heap[i] = b;
  heap[j] = a;
  a.at = j;
  b.at = i;
};
