// Verb pack: scheduled programs, read-only from inside the tool.
//
//   schedule()                 the entries and what their last run found
//   schedule('name', n=3)      the last n recorded runs of one entry
//
// Adding, changing, removing or running a schedule is NOT possible here: an agent must not be able
// to give itself standing tasks. It is told the command line to hand to the user instead.

import type { Step } from '../dsl.ts';
import type { RunCtx, RuntimeImpl } from '../runtime.ts';
import { estimateTokens } from '../tokens.ts';
import { AwError } from '../types.ts';
import { nextDue, parseWhen } from './cron.ts';
import { readLog, readSchedules, type LogRecord, type ScheduleEntry } from './store.ts';

export { startDaemon, runEntry, isDue } from './run.ts';
export type { Daemon } from './run.ts';

type Env = Record<string, string | undefined>;

const MUTATING = new Set(['add', 'create', 'new', 'remove', 'rm', 'delete', 'del', 'run', 'edit', 'set', 'update', 'daemon', 'enable', 'disable', 'pause', 'start', 'stop']);
const MUTATING_OPTS = new Set(['add', 'remove', 'delete', 'create', 'every', 'cron', 'daily', 'program', 'when', 'session', 'onchange', 'run']);

export function register(rt: RuntimeImpl, env: Env = process.env): void {
  rt.register('schedule', (rc, step) => schedule(rc, step, env));
}

const q = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;

function refuse(step: Step): AwError {
  const [verb = '', name, when, prog] = step.args.map(String);
  const v = verb.toLowerCase();
  const n = name ?? 'NAME';
  let cmd: string;
  if (['remove', 'rm', 'delete', 'del'].includes(v)) cmd = `agentweb schedule remove ${n}`;
  else if (v === 'run') cmd = `agentweb schedule run ${n}`;
  else cmd = `agentweb schedule add ${['add', 'create', 'new'].includes(v) ? n : 'NAME'} ${when && ['add', 'create', 'new'].includes(v) ? q(when) : '"every 6h"'} ${prog && ['add', 'create', 'new'].includes(v) ? q(prog) : '"<program or program name>"'} [--on-change]`;
  return new AwError('policy', 'an agent cannot add, change, run or remove schedules; they are standing tasks and only the user sets them', `ask the user to run: ${cmd}`);
}

const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function summary(e: ScheduleEntry, last: LogRecord | undefined, now: number): string {
  let state = 'never run';
  if (e.lastRunAt) state = `last run ${ago(now - e.lastRunAt)}`;
  if (last) state = `${e.lastRunAt ? `checked ${ago(now - e.lastRunAt)}` : 'ran'}; ${last.ok ? 'ok' : 'FAILED'} at ${last.at.slice(0, 16).replace('T', ' ')} UTC${last.changed ? ', changed' : ''}`;
  let overdue = '';
  try {
    const due = nextDue(parseWhen(e.when), e.lastRunAt ?? e.createdAt);
    if (due !== undefined && now - due > 10 * 60_000) overdue = ' - overdue: no scheduler is running (agentweb schedule daemon)';
  } catch {
    overdue = ' - unreadable schedule';
  }
  return `${e.name}  [${e.when}]  ${state}${overdue}`;
}

async function schedule(rc: RunCtx, step: Step, env: Env): Promise<void> {
  const first = step.args.length ? String(step.args[0]).trim() : '';
  if (MUTATING.has(first.toLowerCase()) || Object.keys(step.opts).some((k) => MUTATING_OPTS.has(k))) throw refuse(step);

  const entries = readSchedules(env);
  const now = Date.now();
  if (first) {
    const e = entries.find((x) => x.name === first.toLowerCase());
    if (!e) throw new AwError('bad_request', `no schedule '${first}'`, entries.length ? `schedules: ${entries.map((x) => x.name).join(', ')}` : 'none are set; the user adds one with: agentweb schedule add NAME "every 6h" "<program>"');
    const n = typeof step.opts.n === 'number' ? Math.max(1, Math.min(20, step.opts.n)) : 1;
    const log = readLog(env, e.name, n);
    const lines = [summary(e, log[log.length - 1], now), `runs: ${e.program}${e.session ? ` (session ${e.session})` : ''}${e.onChange ? ', recorded only when the output changes' : ''}`];
    if (!log.length) lines.push('no recorded runs yet');
    let left = rc.remaining - estimateTokens(lines.join('\n')) - 20;
    for (const r of [...log].reverse()) {
      const head = `--- ${r.at.slice(0, 19).replace('T', ' ')} UTC ${r.ok ? 'ok' : 'FAILED'} ${r.ms}ms${r.changed ? ' changed' : ''}`;
      const room = Math.max(120, left) * 3; // ~3 chars per token
      const body = clip(r.text, room);
      left -= estimateTokens(head + body) + 1;
      lines.push(head, body);
      if (left < 60) break;
    }
    rc.emit(lines.join('\n'));
    return;
  }

  if (!entries.length) {
    rc.emit('no schedules are set. The user adds one with: agentweb schedule add NAME "every 6h" "<program or program name>" [--on-change]');
    return;
  }
  const out: string[] = [`${entries.length} schedule${entries.length === 1 ? '' : 's'} (set by the user; schedule('name') shows more):`];
  let left = rc.remaining - 60;
  let hidden = 0;
  for (const e of entries) {
    const last = readLog(env, e.name, 1)[0];
    const head = summary(e, last, now);
    const peek = last ? '\n    ' + clip(last.text.split('\n').filter((l) => l.trim() && !/^ok: /.test(l)).slice(0, 3).join(' | '), 240) : '';
    const cost = estimateTokens(head + peek) + 1;
    if (cost > left) {
      hidden++;
      continue;
    }
    left -= cost;
    out.push(head + peek);
  }
  if (hidden) out.push(`… +${hidden} more (raise budget)`);
  rc.emit(out.join('\n'));
}
