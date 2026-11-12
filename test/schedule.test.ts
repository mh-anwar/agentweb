// Scheduled programs: the cron matcher, the files, the command line, the daemon, and the tool's read-only view.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentweb, type Runtime } from '../src/index.ts';
import { cronMatches, nextCronRun, nextDue, parseCron, parseWhen } from '../src/schedule/cron.ts';
import { scheduleCommand } from '../src/schedule/cli.ts';
import { startDaemon, isDue, runEntry } from '../src/schedule/run.ts';
import { appendLog, patchSchedule, putSchedule, readLog, readSchedules, type ScheduleEntry } from '../src/schedule/store.ts';
import { programCommand } from '../src/programs/cli.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

describe('cron', () => {
  it('matches fields: star, numbers, lists, ranges, steps', () => {
    const c = parseCron('*/15 9-17 * * 1-5'); // every 15 minutes in office hours, Monday-Friday
    assert.ok(cronMatches(c, at(2026, 11, 11, 9, 0))); // Wednesday
    assert.ok(cronMatches(c, at(2026, 11, 11, 17, 45)));
    assert.ok(!cronMatches(c, at(2026, 11, 11, 17, 50)));
    assert.ok(!cronMatches(c, at(2026, 11, 11, 18, 0)));
    assert.ok(!cronMatches(c, at(2026, 11, 14, 10, 0))); // Saturday
    const l = parseCron('0,30 6,18 1,15 * *');
    assert.ok(cronMatches(l, at(2026, 3, 15, 18, 30)));
    assert.ok(!cronMatches(l, at(2026, 3, 16, 18, 30)));
    const s = parseCron('5/20 * * * *'); // from minute 5, every 20: 5, 25, 45
    assert.deepEqual([...s.minute], [5, 25, 45]);
    assert.deepEqual([...parseCron('10-40/10 * * * *').minute], [10, 20, 30, 40]);
  });

  it('names for months and weekdays; 7 is Sunday', () => {
    const c = parseCron('0 8 * jan-mar mon,Fri');
    assert.deepEqual([...c.month], [1, 2, 3]);
    assert.deepEqual([...c.dow].sort(), [1, 5]);
    assert.deepEqual([...parseCron('0 0 * * 7').dow], [0]);
    assert.deepEqual([...parseCron('0 0 * * sunday').dow], [0]);
    assert.deepEqual([...parseCron('0 0 * march *').month], [3]);
  });

  it('day-of-month and day-of-week: either matches when both are restricted', () => {
    const c = parseCron('0 0 13 * 5'); // the 13th, or any Friday
    assert.ok(cronMatches(c, at(2026, 11, 13))); // Friday the 13th
    assert.ok(cronMatches(c, at(2026, 11, 6))); // a Friday
    assert.ok(cronMatches(c, at(2026, 12, 13))); // a Sunday that is the 13th
    assert.ok(!cronMatches(c, at(2026, 11, 12)));
  });

  it('rejects what it cannot read, saying where', () => {
    assert.throws(() => parseCron('* * * *'), /5 fields.*has 4/);
    assert.throws(() => parseCron('60 * * * *'), /outside 0-59 in the minute field/);
    assert.throws(() => parseCron('* 24 * * *'), /outside 0-23 in the hour field/);
    assert.throws(() => parseCron('* * 0 * *'), /outside 1-31/);
    assert.throws(() => parseCron('* * * 13 *'), /outside 1-12/);
    assert.throws(() => parseCron('* * * * 8'), /outside 0-7/);
    assert.throws(() => parseCron('5-1 * * * *'), /runs backwards/);
    assert.throws(() => parseCron('*/0 * * * *'), /positive/);
    assert.throws(() => parseCron('a * * * *'), /'a' is not a number/);
    assert.throws(() => parseCron('1,,2 * * * *'), /minute field/);
    assert.throws(() => parseCron('1/2/3 * * * *'), /cannot read/);
  });

  it('finds the next run strictly after a time, across hours, days, months and years', () => {
    const next = (expr: string, from: Date) => nextCronRun(parseCron(expr), from);
    assert.deepEqual(next('30 9 * * *', at(2026, 11, 11, 9, 29)), at(2026, 11, 11, 9, 30));
    assert.deepEqual(next('30 9 * * *', at(2026, 11, 11, 9, 30)), at(2026, 11, 12, 9, 30)); // strictly after
    assert.deepEqual(next('*/15 * * * *', at(2026, 11, 11, 23, 50)), at(2026, 11, 12, 0, 0));
    assert.deepEqual(next('0 0 1 * *', at(2026, 12, 15)), at(2027, 1, 1));
    assert.deepEqual(next('0 9 * * mon', at(2026, 11, 11, 10, 0)), at(2026, 11, 16, 9, 0)); // next Monday
    assert.deepEqual(next('0 0 29 2 *', at(2026, 3, 1)), at(2028, 2, 29)); // leap day
    assert.equal(next('0 0 31 2 *', at(2026, 1, 1)), undefined); // never
  });

  it('friendly spellings', () => {
    assert.deepEqual(parseWhen('every 6h'), { kind: 'every', ms: 6 * 3600_000, text: 'every 6h' });
    assert.equal((parseWhen('every 30 minutes') as { ms: number }).ms, 30 * 60_000);
    assert.equal((parseWhen('Every 2d') as { ms: number }).ms, 2 * 86_400_000);
    const daily = parseWhen('daily 09:05');
    assert.ok(daily.kind === 'cron' && cronMatches(daily.cron, at(2026, 11, 11, 9, 5)) && !cronMatches(daily.cron, at(2026, 11, 11, 9, 6)));
    const wd = parseWhen('weekdays 08:30');
    assert.ok(wd.kind === 'cron' && cronMatches(wd.cron, at(2026, 11, 11, 8, 30)) && !cronMatches(wd.cron, at(2026, 11, 14, 8, 30)));
    const wk = parseWhen('weekly mon 09:00');
    assert.ok(wk.kind === 'cron' && cronMatches(wk.cron, at(2026, 11, 16, 9, 0)) && !cronMatches(wk.cron, at(2026, 11, 17, 9, 0)));
    const h = parseWhen('hourly');
    assert.ok(h.kind === 'cron' && cronMatches(h.cron, at(2026, 11, 11, 4, 0)) && !cronMatches(h.cron, at(2026, 11, 11, 4, 1)));
    assert.ok(parseWhen('0 9 * * 1-5').kind === 'cron');
    assert.throws(() => parseWhen('every 10s'), /cannot read/);
    assert.throws(() => parseWhen('every 0m'), /at least 1/);
    assert.throws(() => parseWhen('daily 25:00'), /not a time/);
    assert.throws(() => parseWhen('whenever'), /cron expression/);
  });

  it('nextDue: interval from the last run, cron from the last run', () => {
    const t = at(2026, 11, 11, 10, 0).getTime();
    assert.equal(nextDue(parseWhen('every 6h'), t), t + 6 * 3600_000);
    assert.equal(nextDue(parseWhen('daily 09:00'), t), at(2026, 11, 12, 9, 0).getTime());
  });
});

let server: Server;
let base = '';
let rt: Runtime;
let dir = '';
let phase = 1;
let env: Record<string, string>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'awsched-'));
  env = { AGENTWEB_HOME: dir, AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_STORE: 'memory:' };
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Status</title><main><h1>Status</h1><p>stock level is ${phase}</p></main>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, env });
});

after(async () => {
  await rt.close();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
};
const entry = (name: string, extra: Partial<ScheduleEntry> = {}): ScheduleEntry => ({ name, when: 'every 1m', program: `open('${base}/'); find('stock level')`, session: `schedule-${name}`, createdAt: Date.now() - 3600_000, ...extra });

describe('schedule files and the command line', () => {
  it('add, list, log, remove', async () => {
    let c = io();
    assert.equal(await scheduleCommand(['add', 'stock', 'every 6h', `open('${base}/'); find('stock level')`, '--on-change'], c.io, env), 0, c.err.join());
    assert.match(c.out[0], /added schedule stock \[every 6h\], next run \d{4}-\d\d-\d\d \d\d:\d\d, recording only changes/);
    const saved = JSON.parse(readFileSync(join(dir, 'schedules.json'), 'utf8')).entries[0];
    assert.equal(saved.name, 'stock');
    assert.equal(saved.session, 'schedule-stock');
    assert.equal(saved.onChange, true);

    c = io();
    assert.equal(await scheduleCommand(['list'], c.io, env), 0);
    assert.match(c.out[0], /^stock {2}\[every 6h\] {2}next .* last never .*\(on-change\)/);

    c = io();
    assert.equal(await scheduleCommand(['log', 'stock'], c.io, env), 0);
    assert.match(c.out[0], /no recorded runs yet/);

    c = io();
    assert.equal(await scheduleCommand(['remove', 'stock'], c.io, env), 0);
    assert.deepEqual(readSchedules(env), []);
    assert.equal(await scheduleCommand(['remove', 'stock'], io().io, env), 1);
  });

  it('refuses a schedule it cannot read, a program that does not parse, reserved names, and a missing saved program', async () => {
    let c = io();
    assert.equal(await scheduleCommand(['add', 'x', 'sometimes', "open('a.example')"], c.io, env), 1);
    assert.match(c.err.join(), /cron expression/);
    c = io();
    assert.equal(await scheduleCommand(['add', 'x', 'every 1h', "frobnicate('a')"], c.io, env), 1);
    assert.match(c.err.join(), /unknown verb/);
    c = io();
    assert.equal(await scheduleCommand(['add', 'run', 'every 1h', "open('a.example')"], c.io, env), 1);
    assert.match(c.err.join(), /not a usable schedule name/);
    c = io();
    assert.equal(await scheduleCommand(['add', 'x', 'every 1h', 'nothing-saved'], c.io, env), 1);
    assert.match(c.err.join(), /no saved program 'nothing-saved'/);
    assert.deepEqual(readSchedules(env), []);
  });

  it('run now records the output; the log keeps {at, ok, ms, text}', async () => {
    putSchedule(env, entry('now'));
    const c = io();
    assert.equal(await scheduleCommand(['run', 'now', '--no-chrome', '--no-ghost'], c.io, env), 0, c.err.join());
    assert.match(c.out[0], /stock level is 1/);
    const [rec] = readLog(env, 'now');
    assert.equal(rec.ok, true);
    assert.match(rec.text, /stock level is 1/);
    assert.equal(typeof rec.ms, 'number');
    assert.ok(!Number.isNaN(Date.parse(rec.at)));
    assert.equal('changed' in rec, false); // only on-change entries are marked
    const log = io();
    assert.equal(await scheduleCommand(['log', 'now', '--n', '3'], log.io, env), 0);
    assert.match(log.out[0], /^--- \d{4}-.* ok \d+ms\n/);
  });

  it('a saved program name works as the program, with its placeholders given in program() form', async () => {
    assert.equal(await programCommand(['save', 'lvl', `open('${base}/'); find('stock level')`], io().io, { ...env, AGENTWEB_PROGRAMS: join(dir, 'programs') }), 0);
    const e = { ...env, AGENTWEB_PROGRAMS: join(dir, 'programs') };
    const local = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, env: e });
    try {
      const en = entry('byname', { program: 'lvl' });
      putSchedule(e, en);
      const r = await runEntry(local, e, en);
      assert.equal(r.record.ok, true, r.record.text);
      assert.match(r.record.text, /stock level is/);
    } finally {
      await local.close();
    }
  });
});

describe('on-change', () => {
  it('keeps only runs whose output differs from the previous run, and marks them changed', async () => {
    phase = 1;
    const e = entry('watch', { onChange: true });
    putSchedule(env, e);
    const run = async () => runEntry(rt as never, env, readSchedules(env).find((x) => x.name === 'watch')!);
    const a = await run();
    assert.equal(a.logged, true);
    assert.equal(a.record.changed, true); // nothing to compare with: new
    const b = await run();
    assert.equal(b.logged, false);
    assert.equal(b.record.changed, false);
    phase = 2;
    const c = await run();
    assert.equal(c.logged, true);
    assert.equal(c.record.changed, true);
    assert.match(c.record.text, /stock level is 2/);
    const d = await run();
    assert.equal(d.logged, false);
    const log = readLog(env, 'watch', 10);
    assert.equal(log.length, 2);
    assert.deepEqual(log.map((r) => r.changed), [true, true]);
    // last-run bookkeeping still advances on unchanged runs
    assert.ok(readSchedules(env).find((x) => x.name === 'watch')!.lastRunAt! >= Date.parse(log[1].at) - 1);
    phase = 1;
  });

  it('is not fooled by "only what changed" in the page view: every run starts from no open page', async () => {
    const e = entry('same', { onChange: false });
    putSchedule(env, e);
    const first = await runEntry(rt as never, env, readSchedules(env).find((x) => x.name === 'same')!);
    const second = await runEntry(rt as never, env, readSchedules(env).find((x) => x.name === 'same')!);
    assert.match(second.record.text, /stock level is 1/);
    assert.equal(second.record.text, first.record.text);
  });

  it('a failing run is recorded as not ok', async () => {
    const e = entry('broken', { program: `open('${base}/'); expect('nothing like this')` });
    putSchedule(env, e);
    const r = await runEntry(rt as never, env, e);
    assert.equal(r.record.ok, false);
    assert.match(r.record.text, /not on the page/);
    assert.equal(readLog(env, 'broken')[0].ok, false);
  });

  it('log text is capped', async () => {
    appendLog(env, 'big', { at: new Date().toISOString(), ok: true, ms: 1, text: 'x'.repeat(10) });
    assert.equal(readLog(env, 'big').length, 1);
    const e = entry('long', { program: `open('${base}/'); read()` });
    putSchedule(env, e);
    const r = await runEntry(rt as never, env, e, { budget: 30000 });
    assert.ok(r.record.text.length <= 4000);
  });
});

describe('due and the daemon', () => {
  it('isDue: intervals and cron count from the last run (or creation)', () => {
    const now = at(2026, 11, 11, 12, 0).getTime();
    assert.equal(isDue(entry('a', { when: 'every 6h', createdAt: now - 5 * 3600_000 }), now), false);
    assert.equal(isDue(entry('a', { when: 'every 6h', createdAt: now - 7 * 3600_000 }), now), true);
    assert.equal(isDue(entry('a', { when: 'every 6h', createdAt: now - 7 * 3600_000, lastRunAt: now - 1000 }), now), false);
    assert.equal(isDue(entry('b', { when: 'daily 09:00', createdAt: at(2026, 11, 11, 8, 0).getTime() }), now), true);
    assert.equal(isDue(entry('b', { when: 'daily 09:00', createdAt: at(2026, 11, 11, 8, 0).getTime(), lastRunAt: at(2026, 11, 11, 9, 0).getTime() }), now), false);
    assert.equal(isDue(entry('c', { when: 'not a schedule' }), now), false); // a broken line never stops the others
  });

  it('runs what is due once, one at a time, and not again until due', async () => {
    writeFileSync(join(dir, 'schedules.json'), JSON.stringify({ entries: [] }));
    putSchedule(env, entry('due-a'));
    putSchedule(env, entry('due-b'));
    putSchedule(env, entry('not-due', { when: 'every 6h', createdAt: Date.now() }));
    const ran: string[] = [];
    const d = startDaemon(rt as never, env, { tickMs: 3_600_000, onRun: (e) => ran.push(e.name) });
    try {
      await d.tick(); // queued behind the daemon's own first pass
      assert.deepEqual(ran.sort(), ['due-a', 'due-b']);
      assert.equal(await d.tick(), 0);
      assert.equal(readLog(env, 'due-a').length, 1);
      assert.equal(existsSync(join(dir, 'schedule-logs', 'not-due.jsonl')), false);
      // an entry added while the daemon runs is picked up on the next pass
      putSchedule(env, entry('late'));
      assert.equal(await d.tick(), 1);
      // editing an entry from the command line while a run is in flight is not overwritten by the run's bookkeeping
      patchSchedule(env, 'late', { when: 'every 9h' });
      assert.equal(readSchedules(env).find((x) => x.name === 'late')!.when, 'every 9h');
    } finally {
      await d.stop();
    }
  });
});

describe('schedule() in the tool: read-only', () => {
  it('lists entries with their last result', async () => {
    writeFileSync(join(dir, 'schedules.json'), JSON.stringify({ entries: [] }));
    const e = entry('tool-watch', { when: 'every 6h', createdAt: Date.now() });
    putSchedule(env, e);
    await runEntry(rt as never, env, readSchedules(env)[0]);
    const r = await rt.run('t1', 'schedule()');
    assert.ok(r.ok, r.text);
    assert.match(r.text, /1 schedule \(set by the user/);
    assert.match(r.text, /tool-watch {2}\[every 6h\] {2}(checked|last run) .*ok at /);
    assert.match(r.text, /stock level is 1/);
    const one = await rt.run('t1', "schedule('tool-watch', n=2)");
    assert.match(one.text, /runs: open\(/);
    assert.match(one.text, /--- \d{4}-.* ok \d+ms/);
    const none = await rt.run('t1', "schedule('missing')");
    assert.equal(none.ok, false);
    assert.match(none.text, /no schedule 'missing'/);
    assert.match(none.text, /schedules: tool-watch/);
  });

  it('cannot add, change, run or remove: it prints the command for the user instead', async () => {
    const before = readFileSync(join(dir, 'schedules.json'), 'utf8');
    for (const [program, expected] of [
      ["schedule('add', 'spy', 'every 1h', \"open('x.example')\")", /ask the user to run: agentweb schedule add spy "every 1h" "open\('x\.example'\)"/],
      ["schedule('remove', 'tool-watch')", /ask the user to run: agentweb schedule remove tool-watch/],
      ["schedule('run', 'tool-watch')", /agentweb schedule run tool-watch/],
      ["schedule('x', every='1h', program='open(1)')", /ask the user to run: agentweb schedule add/],
      ["schedule(add=1)", /ask the user to run/],
    ] as const) {
      const r = await rt.run('t2', program);
      assert.equal(r.ok, false, program);
      assert.match(r.text, /an agent cannot add, change, run or remove schedules/, program);
      assert.match(r.text, expected, program);
    }
    assert.equal(readFileSync(join(dir, 'schedules.json'), 'utf8'), before);
  });

  it('says so when nothing is set, and when a scheduler is not running', async () => {
    writeFileSync(join(dir, 'schedules.json'), JSON.stringify({ entries: [] }));
    assert.match((await rt.run('t3', 'schedule()')).text, /no schedules are set/);
    putSchedule(env, entry('stale', { when: 'every 1m', createdAt: Date.now() - 3 * 3600_000 }));
    assert.match((await rt.run('t3', 'schedule()')).text, /overdue: no scheduler is running/);
  });
});
