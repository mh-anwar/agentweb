// Running scheduled entries: one run, and the daemon loop that runs whatever is due.

import { createHash } from 'node:crypto';
import { parseProgram } from '../dsl.ts';
import { programNames } from '../programs/files.ts';
import type { RuntimeImpl } from '../runtime.ts';
import { liveId, SESSION_NS, type SessionRecord } from '../session.ts';
import { nextDue, parseWhen } from './cron.ts';
import { appendLog, LOG_TEXT_CAP, patchSchedule, readSchedules, type LogRecord, type ScheduleEntry } from './store.ts';

type Env = Record<string, string | undefined>;

/** A bare saved-program name means program('name'); anything else is program text. */
export function programFor(env: Env, text: string): string {
  const t = text.trim();
  return /^[A-Za-z0-9][\w-]*$/.test(t) && programNames(env).includes(t.toLowerCase()) ? `program('${t.toLowerCase()}')` : t;
}

/** Cheap check at `schedule add`: the program must parse. Saved programs are looked up at run time, so one may be saved later. */
export function checkProgram(env: Env, text: string): void {
  const t = text.trim();
  if (!t) throw new Error('the program is empty');
  if (/^[A-Za-z0-9][\w-]*$/.test(t) && !programNames(env).includes(t.toLowerCase())) {
    // a lone word is a saved program that is not there (yet), or a one-word shell-style step: parse decides
    try {
      parseProgram(t);
      return;
    } catch {
      throw new Error(`there is no saved program '${t}'; save it first: agentweb program save ${t} "<program>"`);
    }
  }
  parseProgram(programFor(env, t));
}

/**
 * Cookies carry over from run to run, the page does not: every run starts with no page open, no
 * history and nothing already shown, so the output is the same kind of thing each time and
 * "only what changed" in the view does not hide what a previous run saw.
 */
export async function resetSessionPage(rt: RuntimeImpl, id: string): Promise<void> {
  const store = rt.deps.store;
  const rec = await store.get<SessionRecord>(SESSION_NS, id);
  if (!rec) return;
  const tier = rec.page?.tier;
  if (tier && tier !== 'wire') await rt.deps.engines[tier]?.release(liveId(rec)).catch(() => {});
  rec.page = undefined;
  rec.history = [];
  rec.forward = undefined;
  rec.tabs = undefined;
  rec.tab = undefined;
  rec.lastField = undefined;
  rec.dirty = undefined;
  rec.view = { seq: rec.view.seq, seen: {} };
  await store.set(SESSION_NS, id, rec, rt.opts.sessionTtlSec);
}

const hashOf = (ok: boolean, text: string) => createHash('sha1').update(ok ? '1' : '0').update(text).digest('hex').slice(0, 16);

export interface RunOutcome {
  record: LogRecord;
  /** written to the log (false for an unchanged run of an on-change entry) */
  logged: boolean;
}

export async function runEntry(rt: RuntimeImpl, env: Env, entry: ScheduleEntry, o: { budget?: number } = {}): Promise<RunOutcome> {
  const t0 = performance.now();
  let ok: boolean;
  let text: string;
  try {
    await resetSessionPage(rt, entry.session);
    const r = await rt.run(entry.session, programFor(env, entry.program), { budget: o.budget ?? 3000 });
    ok = r.ok;
    text = r.text;
  } catch (e) {
    ok = false;
    text = `✗ ${(e as Error).message}`;
  }
  const hash = hashOf(ok, text);
  const changed = hash !== entry.lastHash;
  const record: LogRecord = { at: new Date().toISOString(), ok, ms: Math.round(performance.now() - t0), text: text.length > LOG_TEXT_CAP ? text.slice(0, LOG_TEXT_CAP - 1) + '…' : text };
  if (entry.onChange) record.changed = changed;
  const logged = !entry.onChange || changed;
  if (logged) appendLog(env, entry.name, record);
  // read-modify-write from a fresh read: the entry may have been edited since this run began
  patchSchedule(env, entry.name, { lastRunAt: Date.now(), lastHash: hash });
  entry.lastRunAt = Date.now();
  entry.lastHash = hash;
  return { record, logged };
}

/** When an entry is due: it last ran (or was created) before its most recent scheduled time. */
export function isDue(entry: ScheduleEntry, now = Date.now()): boolean {
  let when;
  try {
    when = parseWhen(entry.when);
  } catch {
    return false; // a broken line in the file must not stop the others
  }
  const due = nextDue(when, entry.lastRunAt ?? entry.createdAt);
  return due !== undefined && due <= now;
}

export interface Daemon {
  /** run everything due now, one at a time; resolves to how many ran */
  tick(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * Run due entries until stopped. One entry at a time (the machine is shared; a check is a few
 * requests). After downtime an entry runs once, not once per missed slot.
 */
export function startDaemon(rt: RuntimeImpl, env: Env = process.env, o: { tickMs?: number; onRun?: (e: ScheduleEntry, r: RunOutcome) => void; onError?: (err: Error) => void } = {}): Daemon {
  const tickMs = Math.max(100, o.tickMs ?? 30_000);
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  // ticks never overlap: the loop's and an explicit tick() queue up behind each other
  let chain: Promise<number> = Promise.resolve(0);

  const doTick = async (): Promise<number> => {
    let ran = 0;
    let entries: ScheduleEntry[];
    try {
      entries = readSchedules(env);
    } catch (e) {
      o.onError?.(e as Error);
      return 0;
    }
    for (const e of entries) {
      if (stopped) break;
      if (!isDue(e)) continue;
      try {
        const r = await runEntry(rt, env, e);
        ran++;
        o.onRun?.(e, r);
      } catch (err) {
        o.onError?.(err as Error);
      }
    }
    return ran;
  };

  const tick = (): Promise<number> => {
    const p = chain.then(doTick);
    chain = p.catch(() => 0);
    return p;
  };

  const loop = () => {
    if (stopped) return;
    void tick().finally(() => {
      if (!stopped) timer = setTimeout(loop, tickMs);
    });
  };
  loop();

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await chain;
    },
  };
}
