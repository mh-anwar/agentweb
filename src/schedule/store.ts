// Schedules and their logs as plain files under ~/.agentweb (or AGENTWEB_HOME):
//   schedules.json                   { "entries": [ {name, when, program, session, onChange?, createdAt, lastRunAt?, lastHash?} ] }
//   schedule-logs/NAME.jsonl         one {at, ok, ms, text, changed?} per recorded run

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentwebHome } from '../programs/files.ts';
import { AwError } from '../types.ts';

type Env = Record<string, string | undefined>;

export interface ScheduleEntry {
  name: string;
  /** as written: a cron expression, 'every 6h', 'daily 09:00' */
  when: string;
  /** program text, or the name of a saved program */
  program: string;
  /** the session the runs use (cookies persist between runs; the page does not) */
  session: string;
  /** record only runs whose output differs from the previous run's */
  onChange?: boolean;
  createdAt: number;
  lastRunAt?: number;
  /** hash of the previous run's outcome, for onChange */
  lastHash?: string;
}

export interface LogRecord {
  /** ISO time */
  at: string;
  ok: boolean;
  ms: number;
  /** the run's output, capped */
  text: string;
  /** with onChange: this output differs from the previous run's */
  changed?: boolean;
}

export const LOG_TEXT_CAP = 4000;
const LOG_KEEP = 200;

/** Words the command line and the tool use as verbs: not usable as names. */
const RESERVED = new Set(['add', 'create', 'new', 'remove', 'rm', 'delete', 'del', 'run', 'list', 'log', 'edit', 'set', 'update', 'daemon', 'enable', 'disable', 'pause', 'help']);

export function cleanScheduleName(raw: unknown): string {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || RESERVED.has(name)) throw new AwError('bad_request', `'${String(raw ?? '')}' is not a usable schedule name`, 'use letters, digits, - and _ (up to 64), e.g. price-watch; not a command word like add or run');
  return name;
}

export const schedulesPath = (env: Env = process.env) => join(agentwebHome(env), 'schedules.json');
export const logDir = (env: Env = process.env) => join(agentwebHome(env), 'schedule-logs');
export const logPath = (env: Env, name: string) => join(logDir(env), `${name}.jsonl`);

export function readSchedules(env: Env = process.env): ScheduleEntry[] {
  let raw: string;
  try {
    raw = readFileSync(schedulesPath(env), 'utf8');
  } catch {
    return [];
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new AwError('internal', `${schedulesPath(env)} is not valid JSON`, 'fix or delete the file');
  }
  const list = Array.isArray(data) ? data : (data as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return [];
  return list.filter((e): e is ScheduleEntry => !!e && typeof e.name === 'string' && typeof e.when === 'string' && typeof e.program === 'string');
}

function writeSchedules(env: Env, entries: ScheduleEntry[]): void {
  const path = schedulesPath(env);
  mkdirSync(agentwebHome(env), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries }, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** Add or replace an entry. Replacing keeps the run history (log file) but resets last-run state. */
export function putSchedule(env: Env, entry: ScheduleEntry): { replaced: boolean } {
  const all = readSchedules(env);
  const at = all.findIndex((e) => e.name === entry.name);
  if (at >= 0) all[at] = entry;
  else all.push(entry);
  writeSchedules(env, all);
  return { replaced: at >= 0 };
}

/** Patch one entry from a fresh read, so an edit made by the command line while a daemon ran is not lost. */
export function patchSchedule(env: Env, name: string, patch: Partial<ScheduleEntry>): void {
  const all = readSchedules(env);
  const e = all.find((x) => x.name === name);
  if (!e) return;
  Object.assign(e, patch);
  writeSchedules(env, all);
}

export function removeSchedule(env: Env, name: string, keepLog = false): boolean {
  const all = readSchedules(env);
  const rest = all.filter((e) => e.name !== name);
  if (rest.length === all.length) return false;
  writeSchedules(env, rest);
  if (!keepLog) rmSync(logPath(env, name), { force: true });
  return true;
}

export function appendLog(env: Env, name: string, rec: LogRecord): void {
  mkdirSync(logDir(env), { recursive: true, mode: 0o700 });
  const path = logPath(env, name);
  appendFileSync(path, JSON.stringify(rec) + '\n', { mode: 0o600 });
  // keep the file small: past 2x the limit, rewrite with the newest
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length > LOG_KEEP * 2) writeFileSync(path, lines.slice(-LOG_KEEP).join('\n') + '\n');
  } catch {}
}

export function readLog(env: Env, name: string, n = 5): LogRecord[] {
  const path = logPath(env, name);
  if (!existsSync(path)) return [];
  const out: LogRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean).slice(-Math.max(1, n))) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}
