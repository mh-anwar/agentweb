// `agentweb schedule ...`: the only place schedules are created, changed and run.

import { createAgentweb } from '../index.ts';
import { runtimeConfig } from '../programs/cli.ts';
import { checkProgram, runEntry, startDaemon } from './run.ts';
import { nextDue, parseWhen } from './cron.ts';
import { cleanScheduleName, logPath, putSchedule, readLog, readSchedules, removeSchedule, schedulesPath, type ScheduleEntry } from './store.ts';

export const SCHEDULE_HELP = `agentweb schedule - run programs on a timetable and keep what they found

  agentweb schedule add NAME "<when>" "<program or program name>" [--session S] [--on-change]
        when:  a cron expression ('0 9 * * 1-5'), 'every 30m' | 'every 6h' | 'every 2d',
               'hourly', 'daily 09:00', 'weekdays 08:30', 'weekly mon 09:00'   (local time)
        --session S   the session the runs use; its cookies carry over, its page does not (default schedule-NAME)
        --on-change   keep only runs whose output differs from the previous run's (marked "changed")
  agentweb schedule list                      entries, next run, last result
  agentweb schedule run NAME                  run it now (and record it)
  agentweb schedule log NAME [--n 5]          the last recorded runs
  agentweb schedule remove NAME               remove it and its log
  agentweb schedule daemon                    stay in the foreground and run what is due
                                              (agentweb serve --schedules does the same inside the server)

  Entries: ~/.agentweb/schedules.json   Logs: ~/.agentweb/schedule-logs/NAME.jsonl ({at, ok, ms, text})
  An agent can read results with schedule() in the tool, but cannot add or remove schedules.
`;

type IO = { out: (s: string) => void; err: (s: string) => void };
const stdio: IO = { out: (s) => console.log(s), err: (s) => console.error(s) };

const VALUE_FLAGS = new Set(['session', 'n', 'store', 'budget', 'tick']);

function parse(argv: string[]) {
  const pos: string[] = [];
  const str: Record<string, string> = {};
  const bool = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) str[name] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) str[name] = argv[++i];
      else bool.add(name);
    } else pos.push(a);
  }
  return { pos, str, bool };
}

const fmt = (ms?: number) => (ms === undefined ? '-' : new Date(ms).toLocaleString('sv-SE', { hour12: false }).slice(0, 16));

export async function scheduleCommand(argv: string[], io: IO = stdio, env: Record<string, string | undefined> = process.env): Promise<number> {
  const p = parse(argv);
  const [sub, ...rest] = p.pos;
  if (!sub || sub === 'help' || p.bool.has('help')) {
    io.out(SCHEDULE_HELP);
    return sub || p.bool.has('help') ? 0 : 2;
  }
  try {
    switch (sub) {
      case 'add': {
        const name = cleanScheduleName(rest[0]);
        const whenText = rest[1];
        const program = rest.slice(2).join(' ').trim();
        if (!whenText || !program) {
          io.err('usage: agentweb schedule add NAME "<when>" "<program or program name>" [--session S] [--on-change]');
          return 2;
        }
        const when = parseWhen(whenText);
        checkProgram(env, program);
        const entry: ScheduleEntry = { name, when: when.text, program, session: p.str.session || `schedule-${name}`, createdAt: Date.now() };
        if (p.bool.has('on-change')) entry.onChange = true;
        const { replaced } = putSchedule(env, entry);
        const next = nextDue(when, entry.createdAt);
        io.out(`${replaced ? 'replaced' : 'added'} schedule ${name} [${when.text}], next run ${fmt(next)}${entry.onChange ? ', recording only changes' : ''}. A scheduler must be running: agentweb schedule daemon (or agentweb serve --schedules)`);
        return 0;
      }
      case 'list':
      case 'ls': {
        const all = readSchedules(env);
        if (!all.length) {
          io.out(`no schedules (${schedulesPath(env)}). Add one: agentweb schedule add NAME "every 6h" "<program>"`);
          return 0;
        }
        for (const e of all) {
          let next = '?';
          try {
            next = fmt(nextDue(parseWhen(e.when), e.lastRunAt ?? e.createdAt));
          } catch {}
          const last = readLog(env, e.name, 1)[0];
          io.out(`${e.name}  [${e.when}]  next ${next}  last ${e.lastRunAt ? fmt(e.lastRunAt) : 'never'}${last ? (last.ok ? ' ok' : ' FAILED') + (last.changed ? ' changed' : '') : ''}${e.onChange ? '  (on-change)' : ''}\n  ${e.program.length > 100 ? e.program.slice(0, 99) + '…' : e.program}`);
        }
        return 0;
      }
      case 'remove':
      case 'rm':
      case 'delete': {
        const name = cleanScheduleName(rest[0]);
        if (!removeSchedule(env, name)) {
          io.err(`no schedule '${name}'`);
          return 1;
        }
        io.out(`removed schedule ${name} and its log`);
        return 0;
      }
      case 'log': {
        const name = cleanScheduleName(rest[0]);
        if (!readSchedules(env).some((e) => e.name === name) && !readLog(env, name, 1).length) {
          io.err(`no schedule '${name}'`);
          return 1;
        }
        const n = Math.max(1, Number(p.str.n) || 5);
        const log = readLog(env, name, n);
        if (!log.length) {
          io.out(`no recorded runs yet (${logPath(env, name)})`);
          return 0;
        }
        for (const r of log) io.out(`--- ${r.at} ${r.ok ? 'ok' : 'FAILED'} ${r.ms}ms${r.changed ? ' changed' : ''}\n${r.text}`);
        return 0;
      }
      case 'run': {
        const name = cleanScheduleName(rest[0]);
        const entry = readSchedules(env).find((e) => e.name === name);
        if (!entry) {
          io.err(`no schedule '${name}'`);
          return 1;
        }
        const rt = await createAgentweb({ ...runtimeConfig(p), env });
        try {
          const r = await runEntry(rt, env, entry);
          io.out(r.record.text);
          io.out(`[${r.record.ok ? 'ok' : 'FAILED'} ${r.record.ms}ms${entry.onChange ? (r.record.changed ? ', changed, recorded' : ', unchanged, not recorded') : ', recorded'}]`);
          return r.record.ok ? 0 : 1;
        } finally {
          await rt.close();
        }
      }
      case 'daemon': {
        const rt = await createAgentweb({ ...runtimeConfig(p), env });
        const d = startDaemon(rt, env, {
          tickMs: p.str.tick ? Number(p.str.tick) : undefined,
          onRun: (e, r) => io.err(`${new Date().toISOString()} ran ${e.name}: ${r.record.ok ? 'ok' : 'FAILED'} ${r.record.ms}ms${r.record.changed ? ' changed' : ''}${r.logged ? '' : ' (unchanged, not recorded)'}`),
          onError: (err) => io.err(`schedule error: ${err.message}`),
        });
        io.err(`agentweb schedule daemon: ${readSchedules(env).length} schedule(s) in ${schedulesPath(env)}; Ctrl-C to stop`);
        await new Promise<void>((resolve) => {
          const stop = () => resolve();
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
        await d.stop();
        await rt.close().catch(() => {});
        return 0;
      }
      default:
        io.err(`unknown schedule command '${sub}'\n\n${SCHEDULE_HELP}`);
        return 2;
    }
  } catch (e) {
    io.err(`✗ ${(e as Error).message}${(e as { hint?: string }).hint ? '\n' + (e as { hint?: string }).hint : ''}`);
    return 1;
  }
}
