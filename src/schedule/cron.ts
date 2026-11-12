// A small cron matcher and the friendlier spellings that compile to it. No dependencies, local time.
//
// Five fields: minute hour day-of-month month day-of-week. Each field is a list of parts; a part is
// `*`, a number, a range `a-b`, optionally with a step (`*/15`, `10-40/10`, `5/20`). Months and weekdays
// may be written as names (jan, mon). Day-of-week 7 is Sunday, like 0. As in classic cron, when both
// day-of-month and day-of-week are restricted a day matches if EITHER does.
//
// Friendly forms: "every 30m" / "every 6h" / "every 2d", "hourly", "daily 09:00", "weekdays 08:30",
// "weekly mon 09:00". `every` is an interval from the last run; the others are cron expressions.

export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** field starts with a star (any value, or a step over all): decides the day-of-month / day-of-week rule */
  domStar: boolean;
  dowStar: boolean;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** first value the names map to (months start at 1, weekdays at 0) */
  nameBase?: number;
}

const FIELDS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: 'day of week', min: 0, max: 7, names: DAYS, nameBase: 0 },
];

const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const FULL_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function value(raw: string, f: FieldSpec): number {
  const t = raw.toLowerCase();
  if (f.names) {
    const full = f.names === MONTHS ? FULL_MONTHS : FULL_DAYS;
    const i = f.names.indexOf(t) >= 0 ? f.names.indexOf(t) : full.indexOf(t);
    if (i >= 0) return i + (f.nameBase ?? 0);
  }
  if (!/^\d+$/.test(t)) throw new Error(`'${raw}' is not a number${f.names ? ' or name' : ''} in the ${f.name} field`);
  return Number(t);
}

function field(text: string, f: FieldSpec): { set: Set<number>; star: boolean } {
  const set = new Set<number>();
  let star = false;
  if (!text) throw new Error(`the ${f.name} field is empty`);
  for (const part of text.split(',')) {
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined || !range) throw new Error(`cannot read '${part}' in the ${f.name} field`);
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`the step in '${part}' must be a positive number`);
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === '*') {
      lo = f.min;
      hi = f.name === 'day of week' ? 6 : f.max;
      star ||= true;
    } else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined || !a || !b) throw new Error(`cannot read the range '${range}' in the ${f.name} field`);
      lo = value(a, f);
      hi = value(b, f);
      if (lo > hi) throw new Error(`the range '${range}' runs backwards in the ${f.name} field`);
    } else {
      lo = value(range, f);
      hi = stepText !== undefined ? (f.name === 'day of week' ? 6 : f.max) : lo; // 5/20 = from 5, every 20
    }
    if (lo < f.min || hi > f.max) throw new Error(`${range} is outside ${f.min}-${f.max} in the ${f.name} field`);
    for (let v = lo; v <= hi; v += step) set.add(f.name === 'day of week' && v === 7 ? 0 : v);
  }
  return { set, star };
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`a cron expression has 5 fields (minute hour day-of-month month day-of-week), '${expr.trim()}' has ${parts.length}`);
  const [mi, h, dom, mo, dow] = FIELDS.map((f, i) => field(parts[i], f));
  return { minute: mi.set, hour: h.set, dom: dom.set, month: mo.set, dow: dow.set, domStar: dom.star, dowStar: dow.star };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dm = c.dom.has(d.getDate());
  const dw = c.dow.has(d.getDay());
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dw;
  if (c.dowStar) return dm;
  return dm || dw;
}

export function cronMatches(c: Cron, d: Date): boolean {
  return c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.month.has(d.getMonth() + 1) && dayMatches(c, d);
}

/** The first matching minute strictly after `after` (local time), or undefined if none within eight years (e.g. Feb 31). */
export function nextCronRun(c: Cron, after: Date): Date | undefined {
  let t = new Date(after.getFullYear(), after.getMonth(), after.getDate(), after.getHours(), after.getMinutes() + 1, 0, 0);
  const stop = after.getFullYear() + 8;
  for (let guard = 0; guard < 120000 && t.getFullYear() <= stop; guard++) {
    const y = t.getFullYear();
    const mo = t.getMonth();
    const d = t.getDate();
    const h = t.getHours();
    if (!c.month.has(mo + 1)) t = new Date(y, mo + 1, 1, 0, 0);
    else if (!dayMatches(c, t)) t = new Date(y, mo, d + 1, 0, 0);
    else if (!c.hour.has(h)) t = new Date(y, mo, d, h + 1, 0);
    else if (!c.minute.has(t.getMinutes())) t = new Date(y, mo, d, h, t.getMinutes() + 1);
    else return t;
  }
  return undefined;
}

// ───────────────────────────── friendly spellings ─────────────────────────────

export type When = { kind: 'cron'; cron: Cron; text: string } | { kind: 'every'; ms: number; text: string };

const WHEN_HELP = "use a cron expression ('0 9 * * 1-5'), 'every 6h' (m, h or d), 'hourly', 'daily 09:00', 'weekdays 08:30' or 'weekly mon 09:00'";

function clock(t: string | undefined, fallback = '00:00'): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec((t ?? fallback).trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`'${t}' is not a time like 09:00`);
  return [Number(m[1]), Number(m[2])];
}

export function parseWhen(input: string): When {
  const text = input.trim();
  let m = /^every\s+(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/i.exec(text);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0].toLowerCase();
    const ms = n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
    if (n < 1) throw new Error('an interval must be at least 1');
    if (ms < 60_000) throw new Error('the shortest interval is 1 minute');
    return { kind: 'every', ms, text };
  }
  if (/^hourly$/i.test(text)) return { kind: 'cron', cron: parseCron('0 * * * *'), text };
  m = /^daily(?:\s+(?:at\s+)?(\S+))?$/i.exec(text);
  if (m) {
    const [h, mi] = clock(m[1]);
    return { kind: 'cron', cron: parseCron(`${mi} ${h} * * *`), text };
  }
  m = /^weekdays(?:\s+(?:at\s+)?(\S+))?$/i.exec(text);
  if (m) {
    const [h, mi] = clock(m[1], '09:00');
    return { kind: 'cron', cron: parseCron(`${mi} ${h} * * 1-5`), text };
  }
  m = /^weekly\s+([A-Za-z]+)(?:\s+(?:at\s+)?(\S+))?$/i.exec(text);
  if (m) {
    const [h, mi] = clock(m[2], '09:00');
    return { kind: 'cron', cron: parseCron(`${mi} ${h} * * ${m[1]}`), text };
  }
  if (/^every\b/i.test(text) || /^(daily|weekly|weekdays|hourly)\b/i.test(text)) throw new Error(`cannot read '${text}': ${WHEN_HELP}`);
  try {
    return { kind: 'cron', cron: parseCron(text), text };
  } catch (e) {
    throw new Error(`${(e as Error).message}; ${WHEN_HELP}`);
  }
}

/** When this entry is next due, given when it last ran (or was created), as epoch ms. */
export function nextDue(when: When, last: number): number | undefined {
  if (when.kind === 'every') return last + when.ms;
  return nextCronRun(when.cron, new Date(last))?.getTime();
}
