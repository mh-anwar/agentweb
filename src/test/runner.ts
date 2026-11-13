// Runs test cases against one agentweb runtime. No model, no randomness: every test gets a fresh
// session (empty cookie jar, no history), steps run one at a time so a failure names its line,
// and a failure carries a small excerpt of the page instead of a trace.

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { parseProgram, type Arg, type Step } from '../dsl.ts';
import { liveId, SESSION_NS, type SessionRecord } from '../session.ts';
import type { RuntimeImpl } from '../runtime.ts';
import { baseName, parseTestFile, type TestCase, type TestStep } from './parse.ts';
import { compareScreenshot, SCREENSHOT } from './screenshots.ts';

export interface RunOptions {
  /** overrides every test's own `# base:` */
  base?: string;
  workers: number;
  bail?: boolean;
  /** accept new/changed snapshots */
  update?: boolean;
  /** missing snapshot baselines fail instead of being written (CI) */
  ci?: boolean;
  /** per-test time limit */
  timeoutMs: number;
  /** token budget of the page excerpt shown with a failure */
  excerptTokens: number;
  /** load every page in this engine (overrides `# engine:`) */
  engine?: string;
  /** false: `# setup:`, `# teardown:` and exec() are refused (--no-exec) */
  exec?: boolean;
  /** --setup / --teardown: shell commands run once for the whole run; what setup prints as name=value is `${name}` in every test */
  runSetup?: string[];
  runTeardown?: string[];
  /** --report dir: a full-page screenshot of where each test ended is saved there (tests that ran in a real browser) */
  report?: string;
}

export interface Failure {
  /** 1-based line of the failing step in the test file */
  line: number;
  step: string;
  message: string;
  /** a few lines of the page as it was when the step failed */
  excerpt: string;
}

export interface TestResult {
  file: string;
  name: string;
  line: number;
  ok: boolean;
  skipped?: boolean;
  ms: number;
  steps: number;
  failure?: Failure;
  /** snapshot names written or updated in this test */
  wrote?: string[];
  /** the engine the test's last page was on: wire (HTTP, no scripts), ghost (scripts, no real browser), chrome, firefox, webkit */
  engine?: string;
  /** every engine a page of this test was on, in order, when there was more than one */
  engines?: string[];
  /** device, viewport, locale, timezone the test ran with (these force a real browser) */
  emulation?: string;
  /** things the person should know that did not fail the test (a sign-in with no cookies for this host) */
  warnings?: string[];
  /** --report: file name of the screenshot of where the test ended */
  shot?: string;
  /** expect(same=…) of this test: what it saw, compared with the other tests when the run ends */
  same?: { name: string; text: string; line: number; step: string }[];
  /** --report: screenshots the test asked for with shot(attach='label') */
  shots?: { label: string; file: string }[];
}

// ───────────────────────────── hooks ─────────────────────────────
//
// Test setup the page language cannot express (seeding a database, reading a one-time code from a
// local mailbox) is a shell command: `# setup:` / `# teardown:` headers, and the exec() step. They
// exist only in `agentweb test`, which runs files the user wrote; the agent tool has no such verb.

export interface ExecResult {
  ok: boolean;
  out: string;
  err: string;
  /** exit code, or the signal that ended it */
  code?: number | string;
}

export function runShell(cmd: string, env: Record<string, string | undefined>, timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(cmd, { shell: true, env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: timeoutMs });
    } catch (e) {
      return resolve({ ok: false, out: '', err: (e as Error).message });
    }
    child.stdout!.on('data', (d: Buffer) => (out = (out + d.toString('utf8')).slice(-65_536)));
    child.stderr!.on('data', (d: Buffer) => (err = (err + d.toString('utf8')).slice(-8192)));
    child.once('error', (e) => resolve({ ok: false, out, err: err || e.message }));
    child.once('close', (code, sig) => resolve({ ok: code === 0, out, code: code ?? sig ?? undefined, err: code === 0 ? err : err || (sig ? `killed (${sig}) after ${Math.round(timeoutMs / 1000)} s` : '') }));
  });
}

const tail = (s: string, n = 3) => s.trim().split('\n').slice(-n).join(' / ').slice(0, 300);

/**
 * Why a command failed, in one line: the error line of a stack trace (`Error: …`, `TypeError: …`, `error: …`)
 * rather than its last lines, then the exit code.
 */
export function whyFailed(r: ExecResult): string {
  const text = `${r.err}\n${r.out}`;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const errLine = lines.find((l) => /^(?:Uncaught )?(?:[A-Z]\w*)?(?:Error|Exception)\b[:\s]/.test(l) || /^(?:error|fatal|ERROR|FATAL)\b[:\s]/.test(l) || /^AssertionError/.test(l));
  const code = r.code === undefined ? '' : typeof r.code === 'number' ? `exit code ${r.code}` : `killed (${r.code})`;
  const what = errLine ?? (lines.filter((l) => !/^at\s|^\^+$|^Node\.js v|^[{}\[\]();,]*$/.test(l)).slice(-2).join(' / ') || tail(text));
  return [what.slice(0, 300), code].filter(Boolean).join(' — ') || 'no output';
}

/** `name=value` lines a hook prints become ${name} in the tests; a JSON object does too. */
export function varsFrom(out: string): Record<string, string> {
  const vars: Record<string, string> = {};
  const t = out.trim();
  if (t.startsWith('{')) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(t) as Record<string, unknown>)) if (v !== null && typeof v !== 'object') vars[k] = String(v);
      return vars;
    } catch {}
  }
  for (const line of t.split('\n')) {
    const m = /^([A-Za-z_][\w]*)=(.*)$/.exec(line.trim());
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

/** Steps that only a real browser can run (layout, accessibility, console, uploads, elements by role or state, emulation). */
export const NEEDS_BROWSER = /\b(?:emulate|upload|drop|within|js|route|init|shot|overflow|audit)\s*\(|\bexpect\s*\([^)]*\b(?:overflow|no_overflow|audit|axe|console|requests|label|testid|test_id|css|in|focused|checked|unchecked|disabled|enabled|selected|expanded|collapsed|pressed|hidden|visible|value|attr|exact)\s*=|\bexpect\s*\([^)]*\brole\s*=\s*['"](?!heading['"])/;

/** ${today}, ${today+3}, ${today-1}: a date key (YYYY-MM-DD) in AGENTWEB_TZ (else TZ, else this machine's zone). */
export function dateKey(offsetDays: number, tz = process.env.AGENTWEB_TZ || process.env.TZ || undefined): string {
  let today: string;
  try {
    today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    today = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function substitute(src: string, vars: Record<string, string>): string {
  return src.replace(/\$\{([A-Za-z_][\w.]*)(?:([+-])(\d+))?\}/g, (_m, name: string, sign?: string, num?: string) => {
    if (name === 'today' && !(name in vars)) return dateKey(sign ? (sign === '-' ? -1 : 1) * Number(num) : 0);
    if (sign) throw new Error(`\${${name}${sign}${num}} : only \${today+N} takes a number of days`);
    if (!(name in vars)) throw new Error(`\${${name}} is not set: a "# setup:" command prints ${name}=value, or exec('command', as='${name}') sets it`);
    return vars[name];
  });
}

const hookEnv = (tc: TestCase, base: string | undefined, vars: Record<string, string>) => ({
  ...process.env,
  AGENTWEB_BASE: base ?? '',
  AGENTWEB_TEST_FILE: tc.file,
  AGENTWEB_TEST_NAME: tc.name,
  ...Object.fromEntries(Object.entries(vars).map(([k, v]) => ['AW_' + k.toUpperCase(), v])),
});

let sessionCounter = 0;

// ───────────────────────────── steps ─────────────────────────────

const q = (a: Arg) => (typeof a === 'string' ? JSON.stringify(a) : String(a));

/** A step as program text (what `--record` writes). */
export function stepToSource(s: Step): string {
  const parts = s.args.map(q);
  for (const [k, v] of Object.entries(s.opts)) parts.push(`${k}=${q(v)}`);
  return `${s.verb}(${parts.join(', ')})`;
}

/** open('/x') against the base; anything with a scheme or a host is left alone. */
export function resolveUrl(url: string, base?: string): string {
  const relative = url.startsWith('/') || url.startsWith('?') || url.startsWith('#') || url.startsWith('.') || url === '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || !relative) return url;
  if (!base) throw new Error(`'${url}' is a relative address and there is no base: add "# base: http://…" to the file or pass --base`);
  return new URL(url, base).toString();
}
const withBase = resolveUrl;

const SNAPSHOT = /^(?:await\s+)?snap(?:shot)?\s*\(\s*(?:(['"`])(.*?)\1)?\s*\)\s*;?$/i;

// ───────────────────────────── one test ─────────────────────────────

function snapshotPath(tc: TestCase, name: string): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test';
  return join(dirname(tc.file), '__aw_snapshots__', baseName(tc.file), `${slug(tc.name)}.${slug(name)}.txt`);
}

/** The text view, made stable: no ports, no engine tag. */
function normalizeView(text: string, origins: string[]): string {
  let t = text.replace(/\r/g, '');
  for (const o of origins) if (o) t = t.split(o).join('{origin}');
  t = t.replace(/^(.*? — \S+) \[(?:wire|ghost|chrome)\]$/m, '$1');
  return t.split('\n').map((l) => l.trimEnd()).join('\n').trim() + '\n';
}

function lineDiff(want: string, got: string, max = 6): string {
  const a = want.split('\n');
  const b = got.split('\n');
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < max * 2; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
  }
  const shown = out.slice(0, max * 2);
  let diffs = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) diffs++;
  if (diffs * 2 > shown.length) shown.push(`… ${diffs} lines differ in all`);
  return shown.join('\n');
}

export async function runCase(rt: RuntimeImpl, tc: TestCase, o: RunOptions, shared: Record<string, string> = {}): Promise<TestResult> {
  const t0 = performance.now();
  const res: TestResult = { file: tc.file, name: tc.name, line: tc.line, ok: true, ms: 0, steps: 0 };
  if (tc.skip) {
    res.skipped = true;
    return res;
  }
  const sid = `aw-test-${process.pid}-${++sessionCounter}`;
  const base = o.base ?? tc.base;
  // `# timeout:` is how long assertions wait for a script-rendered page; the test as a whole gets at least the run limit
  // With `# expect-timeout:` the two are separate: that is the wait of one assertion, `# timeout:` the limit of the test.
  const expectMs = tc.expectTimeoutMs ?? tc.timeoutMs;
  const deadline = AbortSignal.timeout(tc.expectTimeoutMs !== undefined ? (tc.timeoutMs ?? o.timeoutMs) : Math.max(o.timeoutMs, (tc.timeoutMs ?? 0) * 4));
  // `# soft: on` or expect(…, soft=1): a failing assertion is kept and the test goes on; all are reported together
  const soft: { st: TestStep; message: string }[] = [];
  const origins = new Set<string>();
  if (base) try { origins.add(new URL(base).origin); } catch {}

  const vars: Record<string, string> = { ...shared };
  // ${base}: the address tests run against (for an api='${base}/…' or a command)
  if (base && vars.base === undefined) vars.base = base.replace(/\/+$/, '');
  const tiers: string[] = [];
  const engine = o.engine ?? tc.engine;
  const steps: TestStep[] = [];
  // The engine a page needed is remembered for the tests after this one (and, on disk, for the next run), so the climb
  // wire -> ghost -> browser is paid once per page. A test that compares a stored view keeps the plain climb, so its
  // view never depends on which test ran before it.
  const hinted = !engine && !tc.console && !tc.steps.some((st) => /\b(?:snapshot|screenshot)\s*\(/.test(st.src));
  if (hinted) rt.hinted.add(sid);
  // `# console: clean` needs the browser's own console from the first page on; so does a test whose steps can only
  // run in a real browser: starting there saves re-opening the page halfway through the test
  if ((tc.console || tc.steps.some((st) => NEEDS_BROWSER.test(st.src))) && !engine) steps.push({ line: tc.line, src: 'engine("chrome")' });
  if (engine && engine !== 'auto') steps.push({ line: tc.line, src: `engine(${JSON.stringify(engine)})` });
  if (tc.profile) steps.push({ line: tc.line, src: `profile(${JSON.stringify(tc.profile)})` });
  if (tc.viewport && rt.verbHandler('viewport')) steps.push({ line: tc.line, src: `viewport(${JSON.stringify(tc.viewport)})` });
  steps.push(...tc.steps);

  // as('name'): the sessions of the test's other users, and the one steps run in now
  const others = new Set<string>();
  let cur = sid;
  const fail = async (st: TestStep, message: string, excerpt?: string) => {
    res.ok = false;
    res.failure = { line: st.line, step: st.src, message: message.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'), excerpt: excerpt ?? (await pageExcerpt(rt, cur, o.excerptTokens)) };
  };

  const hook = async (cmds: string[] | undefined, what: string): Promise<boolean> => {
    for (const cmd of cmds ?? []) {
      if (o.exec === false) {
        await fail({ line: tc.line, src: `# ${what}: ${cmd}` }, `${what} commands are switched off (--no-exec)`, '');
        return false;
      }
      const r = await runShell(cmd, hookEnv(tc, base, vars), 120_000, deadline);
      if (!r.ok) {
        if (res.ok) await fail({ line: tc.line, src: `# ${what}: ${cmd}` }, `${what} failed: ${whyFailed(r)}`, '');
        return false;
      }
      Object.assign(vars, varsFrom(r.out));
    }
    return true;
  };

  try {
    if (!(await hook(tc.setup, 'setup'))) return res;
    for (const st0 of steps) {
      let st = st0;
      let step: Step;
      const snap = SNAPSHOT.exec(st.src.trim());
      try {
        if (st.src.includes('${')) st = { ...st, src: substitute(st.src, vars) };
        if (/^\s*(?:await\s+)?exec\s*\(/.test(st.src)) {
          // exec('command', as='name', retry=10): run it, keep what it prints; retry= waits for something to arrive (a mail)
          if (o.exec === false) throw new Error('exec() is switched off (--no-exec)');
          const ex = parseProgram(st.src.replace(/^\s*(?:await\s+)?exec\s*\(/, 'find('))[0];
          const cmd = String(ex.args[0] ?? '');
          if (!cmd) throw new Error("exec needs a command: exec('node scripts/otp.mjs', as='otp')");
          const until = Date.now() + Math.min(120, Math.max(0, Number(ex.opts.retry) || 0)) * 1000;
          let r: ExecResult;
          for (;;) {
            r = await runShell(cmd, hookEnv(tc, base, vars), Math.max(1000, (Number(ex.opts.timeout) || 60) * 1000), deadline);
            if (r.ok || Date.now() >= until || deadline.aborted) break;
            await new Promise((done) => setTimeout(done, 500));
          }
          res.steps++;
          if (!r.ok) {
            await fail(st0, `the command failed: ${whyFailed(r)}`, '');
            break;
          }
          // exec('node scripts/sql.mjs …', expect='/history', not='error'): what it prints must (not) contain that ('/re/' for a pattern)
          const printed = r.out.trim();
          const holds = (want: string) => {
            const re = /^\/(.*)\/([a-z]*)$/s.exec(want);
            return re ? new RegExp(re[1], re[2]).test(printed) : printed.toLowerCase().includes(want.toLowerCase());
          };
          const shown = printed.length > 200 ? printed.slice(0, 199) + '…' : printed;
          if (ex.opts.expect !== undefined && !holds(String(ex.opts.expect))) {
            await fail(st0, `the command printed ${shown ? `'${shown}'` : 'nothing'}, expected it to contain '${ex.opts.expect}'`, '');
            break;
          }
          if (ex.opts.not !== undefined && holds(String(ex.opts.not))) {
            await fail(st0, `the command printed '${shown}', which contains '${ex.opts.not}'`, '');
            break;
          }
          if (typeof ex.opts.as === 'string') vars[ex.opts.as] = printed;
          else Object.assign(vars, varsFrom(r.out));
          continue;
        }
        if (/^\s*expect\s*\(\s*download\s*=/.test(st.src)) {
          // expect(download='/^export-.*\.xlsx$/'): the last file a step downloaded has that name (substring, or /pattern/)
          const d = parseProgram(st.src)[0];
          res.steps++;
          const want = String(d.opts.download);
          const name = vars['download.name'];
          const re = /^\/(.*)\/([a-z]*)$/s.exec(want);
          const ok = name !== undefined && (re ? new RegExp(re[1], re[2]).test(name) : name.toLowerCase().includes(want.toLowerCase()));
          if (!ok) {
            const message = name === undefined ? `nothing was downloaded (expected '${want}')` : `the download is '${name}', expected '${want}'`;
            if (d.opts.soft !== undefined ? !/^(0|false|no|off)$/i.test(String(d.opts.soft)) : tc.soft) soft.push({ st, message });
            else {
              await fail(st0, message, '');
              break;
            }
          }
          continue;
        }
        if (/^\s*(?:await\s+)?as\s*\(/.test(st.src)) {
          // as('parent', profile='${profile_parent}'): later steps run as another user, in a browser context of their own
          // that stays open (both users at once); as('main') goes back to the test's first user
          const a = parseProgram(st.src.replace(/^\s*(?:await\s+)?as\s*\(/, 'find('))[0];
          const who = String(a.args[0] ?? a.opts.name ?? '').trim();
          if (!who) throw new Error("as needs a name: as('parent', profile='${profile_parent}')");
          res.steps++;
          const next = who === 'main' || who === 'default' ? sid : `${sid}~${who.replace(/[^\w-]/g, '_')}`;
          if (next !== sid && !others.has(next)) {
            others.add(next);
            if (hinted) rt.hinted.add(next);
            const init: string[] = [];
            const pin = steps.find((x) => /^engine\(/.test(x.src));
            if (pin) init.push(pin.src);
            if (a.opts.profile !== undefined) init.push(`profile(file=${JSON.stringify(String(a.opts.profile))})`);
            for (const src of init) {
              const r = await rt.run(next, src, { budget: o.excerptTokens, signal: deadline });
              if (!r.ok) throw new Error(r.text.split('\n')[0].replace(/^✗\s*/, ''));
            }
          } else if (a.opts.profile !== undefined) {
            const r = await rt.run(next, `profile(file=${JSON.stringify(String(a.opts.profile))})`, { budget: o.excerptTokens, signal: deadline });
            if (!r.ok) throw new Error(r.text.split('\n')[0].replace(/^✗\s*/, ''));
          }
          cur = next;
          continue;
        }
        if (/^\s*(?:await\s+)?mail\s*\(/.test(st.src)) {
          // mail(to='${email}', wait=30): the newest message for that address from a local Mailpit; ${mail.subject},
          // ${mail.link}, ${mail.code}, ${mail.text} are then set (as='name' changes the prefix)
          const ml = parseProgram(st.src.replace(/^\s*(?:await\s+)?mail\s*\(/, 'find('))[0];
          res.steps++;
          const got = await readMail({ to: String(ml.opts.to ?? ml.args[0] ?? ''), subject: ml.opts.subject !== undefined ? String(ml.opts.subject) : undefined, waitMs: Math.min(120, Math.max(0, Number(ml.opts.wait ?? 15))) * 1000, api: ml.opts.api !== undefined ? String(ml.opts.api) : process.env.AGENTWEB_MAILPIT, signal: deadline });
          if ('failure' in got) {
            await fail(st0, got.failure, '');
            break;
          }
          const as = typeof ml.opts.as === 'string' ? ml.opts.as : 'mail';
          for (const [k, v] of Object.entries(got)) vars[`${as}.${k}`] = v;
          continue;
        }
        if (SCREENSHOT.test(st.src)) {
          // screenshot('name', widths='375,768', threshold=0.01): compared with a saved picture, like snapshot()
          const sc = parseProgram(st.src)[0];
          res.steps++;
          const v = await compareScreenshot(rt, cur, tc, sc, o, deadline);
          if (v.tier && tiers[tiers.length - 1] !== v.tier) tiers.push(v.tier);
          if (v.wrote) (res.wrote ??= []).push(...v.wrote);
          if (v.failure) {
            await fail(st0, v.failure, '');
            break;
          }
          continue;
        }
        if (snap) step = { verb: 'view', args: [], opts: {}, src: st.src };
        else {
          step = parseProgram(st.src)[0];
          if (step.verb === 'expect' && expectMs && step.opts.timeout === undefined) step = { ...step, opts: { ...step.opts, timeout: expectMs / 1000 } };
          if (step.verb === 'open' && typeof step.args[0] === 'string') step = { ...step, args: [withBase(step.args[0], base), ...step.args.slice(1)] };
        }
      } catch (e) {
        await fail(st0, (e as Error).message, '');
        break;
      }
      if (step.verb === 'open' && typeof step.args[0] === 'string') {
        try { origins.add(new URL(step.args[0]).origin); } catch {}
      }
      const isSoft = step.verb === 'expect' && (step.opts.soft !== undefined ? !/^(0|false|no|off)$/i.test(String(step.opts.soft)) : !!tc.soft);
      if (step.verb === 'expect' && step.opts.soft !== undefined) {
        const { soft: _soft, ...rest } = step.opts;
        step = { ...step, opts: rest };
      }
      if (step.verb === 'shot' && step.opts.attach !== undefined) {
        // shot(full=1, attach='after sign-in'): a picture for the --report page (without --report the step does nothing)
        res.steps++;
        if (!o.report) continue;
        const { attach, ...rest } = step.opts;
        const r = await rt.run(cur, stepToSource({ ...step, opts: { ...rest, save: 1 } }), { budget: 200, signal: deadline });
        if (r.stats.tier && tiers[tiers.length - 1] !== r.stats.tier) tiers.push(r.stats.tier);
        const from = /saved screenshot: (.+?) \(\d+ bytes\)/.exec(r.text)?.[1];
        if (!r.ok || !from || !existsSync(from)) {
          await fail(st, r.ok ? 'the screenshot was not saved' : firstError(r.text, step.src), '');
          break;
        }
        const file = saveShot(o.report, from, `${tc.name} ${attach}`);
        (res.shots ??= []).push({ label: String(attach), file });
        continue;
      }
      if (step.verb === 'expect' && step.opts.same !== undefined) {
        // expect(same='menu', of='nav a'): the text of those elements is the same in every test of this run that says so
        res.steps++;
        const v = await sameAcross(rt, cur, step, deadline);
        if (v.tier && tiers[tiers.length - 1] !== v.tier) tiers.push(v.tier);
        if (v.text !== undefined) (res.same ??= []).push({ name: String(step.opts.same), text: v.text, line: st.line, step: st.src });
        if (v.failure) {
          if (isSoft) soft.push({ st, message: v.failure });
          else {
            await fail(st, v.failure, '');
            break;
          }
        }
        continue;
      }
      const r = await rt.run(cur, snap ? 'view()' : stepToSource(step), { budget: snap ? 1500 : o.excerptTokens, signal: deadline });
      res.steps++;
      if (r.stats.tier && tiers[tiers.length - 1] !== r.stats.tier) tiers.push(r.stats.tier);
      for (const m of r.text.matchAll(/^note: (profile '.*' has no cookies for .*)$/gm)) (res.warnings ??= []).push(m[1]);
      // a step that downloaded a file: ${download.name}, ${download.path}, ${download.bytes}; expect(download='…') checks it
      for (const m of r.text.matchAll(/downloaded (.+?): (\S+) \((\d+) bytes\)/g)) {
        vars['download.name'] = m[1];
        vars['download.path'] = m[2];
        vars['download.bytes'] = m[3];
      }
      if (!r.ok && isSoft && !deadline.aborted) {
        soft.push({ st, message: firstError(r.text, step.src) });
        continue;
      }
      if (snap) {
        if (!r.ok) {
          await fail(st, firstError(r.text, 'view()'), '');
          break;
        }
        const name = snap[2] || 'page';
        const got = normalizeView(r.text, [...origins]);
        const path = snapshotPath(tc, name);
        if (o.update || !existsSync(path)) {
          if (!o.update && o.ci) {
            await fail(st, `no baseline for snapshot '${name}' (run without --ci, or with --update, to write it)`, '');
            break;
          }
          mkdirSync(dirname(path), { recursive: true });
          const prev = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
          if (prev !== got) {
            writeFileSync(path, got);
            (res.wrote ??= []).push(name);
          }
        } else {
          const want = readFileSync(path, 'utf8');
          if (want !== got) {
            await fail(st, `snapshot '${name}' changed (- baseline, + now; --update accepts it)`, lineDiff(want, got));
            break;
          }
        }
        continue;
      }
      if (!r.ok) {
        await fail(st, firstError(r.text, step.src));
        break;
      }
    }
    if (soft.length) {
      const also = (x: { st: TestStep; message: string }) => `also line ${x.st.line}: ${x.st.src} — ${x.message}`;
      if (res.ok) await fail(soft[0].st, [soft[0].message, ...soft.slice(1).map(also)].join('\n'));
      else if (res.failure) res.failure.message += '\n' + soft.map(also).join('\n');
    }
    if (res.ok && tc.console) {
      // `# console: clean`: no console errors (or, with warn, warnings) on any page this test visited
      const allow = tc.console.allow ? `, allow=${JSON.stringify(tc.console.allow)}` : '';
      const src = `expect(console=${tc.console.warn ? "'warn'" : 0}, all=1${allow})`;
      const r = await rt.run(cur, src, { budget: o.excerptTokens, signal: deadline });
      res.steps++;
      if (r.stats.tier && tiers[tiers.length - 1] !== r.stats.tier) tiers.push(r.stats.tier);
      if (!r.ok) await fail({ line: tc.line, src: `# console: clean${tc.console.warn ? ', warn' : ''}${tc.console.allow ? ', allow=' + tc.console.allow : ''}` }, firstError(r.text, src), '');
    }
  } finally {
    if (o.report && tiers.length && ['chrome', 'firefox', 'webkit'].includes(tiers[tiers.length - 1])) {
      // the screen as the test left it, for a person to look at afterwards
      try {
        const r = await rt.run(cur, 'shot(full=1, save=1)', { budget: 200, signal: AbortSignal.timeout(20_000) });
        const from = /saved screenshot: (.+?) \(\d+ bytes\)/.exec(r.text)?.[1];
        if (from && existsSync(from)) res.shot = saveShot(o.report, from, tc.name);
      } catch {}
    }
    if (tc.teardown?.length) await hook(tc.teardown, 'teardown');
    if (tiers.length) res.engine = tiers[tiers.length - 1];
    if (tiers.length > 1) res.engines = tiers;
    // the other users' sessions and browser contexts go with the test
    for (const other of others) {
      try {
        const r2 = await rt.deps.store.get<SessionRecord>(SESSION_NS, other);
        await rt.deps.store.del(SESSION_NS, other);
        rt.hinted.delete(other);
        const ids2 = [other, ...(r2?.tabs ?? []).map((t) => liveId({ id: other }, t.n)), ...(r2?.tab ? [liveId({ id: other }, r2.tab)] : [])];
        await Promise.all(Object.values(rt.deps.engines).flatMap((e) => (e && e.tier !== 'wire' ? ids2.map((id) => e.release(id).catch(() => {})) : [])));
      } catch {}
    }
    let rec: SessionRecord | undefined;
    try {
      rec = await rt.deps.store.get<SessionRecord>(SESSION_NS, sid);
      const e = rec?.emulate;
      if (e) {
        const parts = Object.entries(e).filter(([, v]) => v !== undefined && v !== '' && v !== false).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
        if (parts.length) res.emulation = parts.join(' ');
      }
      await rt.deps.store.del(SESSION_NS, sid);
      rt.hinted.delete(sid);
    } catch {}
    // the test's browser pages (one per tab) are closed now, not when they go idle: a suite holds
    // only as many browser contexts as it has workers
    const ids = [sid, ...(rec?.tabs ?? []).map((t) => liveId({ id: sid }, t.n)), ...(rec?.tab ? [liveId({ id: sid }, rec.tab)] : [])];
    await Promise.all(Object.values(rt.deps.engines).flatMap((e) => (e && e.tier !== 'wire' ? ids.map((id) => e.release(id).catch(() => {})) : [])));
    res.ms = Math.round(performance.now() - t0);
  }
  return res;
}

/**
 * The newest message to an address in a local Mailpit (the mailbox Supabase and many dev stacks run): its subject,
 * text, first link and first 4 to 8 digit code. Waits for it to arrive. Test runner only.
 */
export async function readMail(o: { to: string; subject?: string; waitMs: number; api?: string; signal?: AbortSignal }): Promise<Record<string, string> | { failure: string }> {
  if (!o.to) return { failure: "mail needs an address: mail(to='user@example.com', wait=30)" };
  if (!o.api) return { failure: 'no mailbox is configured: set AGENTWEB_MAILPIT=http://127.0.0.1:54324 (a Mailpit address), or mail(…, api=\'http://…\')' };
  const api = o.api.replace(/\/+$/, '');
  const query = `to:${o.to}` + (o.subject ? ` subject:"${o.subject.replace(/"/g, '')}"` : '');
  const until = Date.now() + o.waitMs;
  let last = 'no message arrived';
  for (;;) {
    try {
      const list = (await (await fetch(`${api}/api/v1/search?query=${encodeURIComponent(query)}&limit=1`, { signal: AbortSignal.timeout(5000) })).json()) as { messages?: { ID: string }[] };
      const id = list.messages?.[0]?.ID;
      if (id) {
        const m = (await (await fetch(`${api}/api/v1/message/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5000) })).json()) as { Subject?: string; Text?: string; HTML?: string };
        const text = String(m.Text ?? '');
        const html = String(m.HTML ?? '');
        const links = [...new Set([...html.matchAll(/href="(https?:[^"]+)"/g)].map((x) => x[1].replace(/&amp;/g, '&')).concat([...text.matchAll(/https?:\/\/[^\s<>")\]]+/g)].map((x) => x[0])))];
        const out: Record<string, string> = { subject: String(m.Subject ?? ''), text: text.replace(/\s+/g, ' ').trim().slice(0, 2000), link: links[0] ?? '', links: links.slice(0, 10).join(' '), code: /(?<![\d\w])\d{4,8}(?![\d\w])/.exec(text || html.replace(/<[^>]+>/g, ' '))?.[0] ?? '' };
        return out;
      }
    } catch (e) {
      last = `the mailbox at ${api} did not answer (${(e as Error).message.split('\n')[0]})`;
    }
    if (Date.now() >= until || o.signal?.aborted) return { failure: `${last} for ${o.to} within ${Math.round(o.waitMs / 1000)} s` };
    await new Promise((done) => setTimeout(done, 500));
  }
}

let shotCounter = 0;

/** Move a saved screenshot into the report folder under a name that says which test it is from. */
function saveShot(dir: string, from: string, label: string): string {
  mkdirSync(dir, { recursive: true });
  const name = `${String(++shotCounter).padStart(3, '0')}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test'}${extname(from) || '.jpg'}`;
  copyFileSync(from, join(dir, name));
  rmSync(from, { force: true });
  return name;
}

/** expect(same='menu', of='css selector'): the visible text of the matching elements, compared with the first test that recorded that name. */
async function sameAcross(rt: RuntimeImpl, sid: string, step: Step, signal: AbortSignal): Promise<{ failure?: string; tier?: string; text?: string }> {
  const of = step.opts.of !== undefined ? String(step.opts.of) : undefined;
  if (!of) return { failure: "expect(same='name', of='css selector') needs of=: which elements to compare" };
  // the selector travels percent-encoded: whatever quotes and backslashes it has, none of them meet the script's own
  const code = `JSON.stringify([...document.querySelectorAll(decodeURIComponent("${encodeURIComponent(of).replace(/'/g, '%27')}"))].filter(e=>e.getClientRects().length).map(e=>(e.innerText||e.textContent||"").replace(/\\s+/g," ").trim()).filter(Boolean))`;
  const r = await rt.run(sid, `js('${code}')`, { budget: 4000, signal });
  if (!r.ok) return { failure: firstError(r.text, step.src), tier: r.stats.tier };
  let items: string[] = [];
  try {
    const line = r.text.split('\n').find((l) => l.trim().startsWith('"[') || l.trim().startsWith('['))!;
    const once = JSON.parse(line);
    items = typeof once === 'string' ? JSON.parse(once) : once;
  } catch {
    return { failure: `could not read the elements matching ${of}`, tier: r.stats.tier };
  }
  if (!items.length) return { failure: `nothing visible matches ${of}`, tier: r.stats.tier };
  return { tier: r.stats.tier, text: items.join('\n') };
}

/**
 * expect(same='name', …) is settled when the run ends: for each name, what most tests saw is the reference and the
 * tests that saw something else fail, each with its difference. The order tests happened to run in does not matter.
 */
export function settleSame(results: TestResult[]): void {
  const byName = new Map<string, { r: TestResult; text: string; line: number; step: string }[]>();
  for (const r of results) {
    for (const x of r?.same ?? []) {
      let list = byName.get(x.name);
      if (!list) byName.set(x.name, (list = []));
      list.push({ r, ...x });
    }
    if (r) delete r.same;
  }
  for (const [name, seen] of byName) {
    const groups = new Map<string, number>();
    for (const x of seen) groups.set(x.text, (groups.get(x.text) ?? 0) + 1);
    if (groups.size < 2) continue;
    // the most common view; on a tie, the one seen first in file order
    const [most] = [...groups].sort((a, b) => b[1] - a[1])[0];
    const odd = seen.filter((x) => x.text !== most);
    for (const x of odd) {
      const message = `'${name}' is different here: ${odd.length} of ${seen.length} tests differ from the other ${seen.length - odd.length} (- the others, + here)\n${lineDiff(most, x.text)}`;
      if (x.r.ok) {
        x.r.ok = false;
        x.r.failure = { line: x.line, step: x.step, message, excerpt: '' };
      } else if (x.r.failure) x.r.failure.message += `\nalso line ${x.line}: ${x.step} — ${message}`;
    }
  }
}

/** "✗ <src> — message" is the first line of a failed run. */
export function firstError(text: string, src: string): string {
  const line = text.split('\n')[0] ?? '';
  const m = /^✗ (.*)$/.exec(line);
  if (!m) return line || 'step failed';
  const i = m[1].indexOf(' — ');
  const body = m[1].startsWith(src) && m[1].slice(src.length).startsWith(' — ') ? m[1].slice(src.length + 3) : i >= 0 ? m[1].slice(i + 3) : m[1];
  // the checks of expect() (overflow, audit, console, requests) list what they found on indented lines
  if (/^expect\(/.test(src)) {
    const more: string[] = [];
    const lines = text.split('\n');
    for (let k = 1; k < lines.length && /^ {2}\S/.test(lines[k]); k++) more.push(lines[k].trim());
    if (more.length) return body + '\n' + more.join('\n');
  }
  return body;
}

/** The main content of the page where the step failed (not the site chrome), in a small budget. */
async function pageExcerpt(rt: RuntimeImpl, sid: string, tokens: number): Promise<string> {
  try {
    let r = await rt.run(sid, "view('main')", { budget: tokens });
    if (!r.ok) return '';
    if (/\(no main region/.test(r.text)) r = await rt.run(sid, 'view()', { budget: tokens });
    return r.ok ? r.text.split('\n').filter((l) => !/^\(\d+ hidden text block/.test(l)).join('\n') : '';
  } catch {
    return '';
  }
}

// ───────────────────────────── many tests ─────────────────────────────

export async function runAll(rt: RuntimeImpl, cases: TestCase[], o: RunOptions, onResult?: (r: TestResult) => void): Promise<TestResult[]> {
  const results: TestResult[] = new Array(cases.length);
  let next = 0;
  let stop = false;
  // file-level hooks: setup once before the file's first test (its printed name=value lines are shared by
  // the file's tests), teardown once after its last
  const left = new Map<string, number>();
  for (const c of cases) if (!c.skip) left.set(c.file, (left.get(c.file) ?? 0) + 1);
  const setups = new Map<string, Promise<{ ok: boolean; vars: Record<string, string>; message: string }>>();
  const fileSetup = (tc: TestCase) => {
    let p = setups.get(tc.file);
    if (!p) {
      p = (async () => {
        const vars: Record<string, string> = {};
        for (const cmd of tc.fileSetup ?? []) {
          if (o.exec === false) return { ok: false, vars, message: 'setup commands are switched off (--no-exec)' };
          const r = await runShell(cmd, hookEnv(tc, o.base ?? tc.base, { ...world, ...vars }), 300_000);
          if (!r.ok) return { ok: false, vars, message: `setup failed (${cmd}): ${whyFailed(r)}` };
          Object.assign(vars, varsFrom(r.out));
        }
        return { ok: true, vars, message: '' };
      })();
      setups.set(tc.file, p);
    }
    return p;
  };
  const fileDone = async (tc: TestCase) => {
    const n = (left.get(tc.file) ?? 1) - 1;
    left.set(tc.file, n);
    if (n > 0 || !tc.fileTeardown?.length || o.exec === false) return;
    const vars = (await setups.get(tc.file))?.vars ?? {};
    for (const cmd of tc.fileTeardown) await runShell(cmd, hookEnv(tc, o.base ?? tc.base, vars), 300_000);
  };
  // --setup: once for the whole run, before any test; what it prints is shared by every file
  const world: Record<string, string> = {};
  const runEnv = { ...process.env, AGENTWEB_BASE: o.base ?? '', AW_WORKERS: String(Math.max(1, Math.min(o.workers, cases.length || 1))) };
  for (const cmd of o.runSetup ?? []) {
    const r = o.exec === false ? { ok: false, out: '', err: 'setup commands are switched off (--no-exec)' } : await runShell(cmd, runEnv, 600_000);
    if (!r.ok) {
      const message = `run setup failed (${cmd}): ${whyFailed(r)}`;
      for (const cmd2 of o.runTeardown ?? []) if (o.exec !== false) await runShell(cmd2, { ...runEnv, ...Object.fromEntries(Object.entries(world).map(([k, v]) => ['AW_' + k.toUpperCase(), v])) }, 600_000);
      return cases.map((c) => ({ file: c.file, name: c.name, line: c.line, ok: !!c.skip, skipped: c.skip || undefined, ms: 0, steps: 0, failure: c.skip ? undefined : { line: 1, step: '', message, excerpt: '' } }));
    }
    Object.assign(world, varsFrom(r.out));
  }
  const worker = async (index: number) => {
    // ${worker} is 0..N-1: each worker can keep to its own data (AW_WORKER in commands)
    const mine = { ...world, worker: String(index) };
    for (;;) {
      if (stop) return;
      const i = next++;
      if (i >= cases.length) return;
      let r: TestResult;
      try {
        const tc = cases[i];
        if (tc.skip) r = await runCase(rt, tc, o);
        else {
          const su = await fileSetup(tc);
          try {
            r = su.ok ? await runCase(rt, tc, o, { ...mine, ...su.vars }) : { file: tc.file, name: tc.name, line: tc.line, ok: false, ms: 0, steps: 0, failure: { line: 1, step: '', message: su.message, excerpt: '' } };
          } finally {
            await fileDone(tc);
          }
        }
      } catch (e) {
        r = { file: cases[i].file, name: cases[i].name, line: cases[i].line, ok: false, ms: 0, steps: 0, failure: { line: cases[i].line, step: '', message: `runner error: ${(e as Error).message}`, excerpt: '' } };
      }
      results[i] = r;
      if (!r.ok && o.bail) stop = true;
      onResult?.(r);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(o.workers, cases.length || 1)) }, (_x, i) => worker(i)));
  } finally {
    for (const cmd of o.runTeardown ?? []) if (o.exec !== false) await runShell(cmd, { ...runEnv, ...Object.fromEntries(Object.entries(world).map(([k, v]) => ['AW_' + k.toUpperCase(), v])) }, 600_000);
  }
  settleSame(results);
  return results.filter(Boolean);
}

// ───────────────────────────── record ─────────────────────────────

/**
 * Run a program step by step and, when it passes, return it as portable test text: numbered refs
 * become the control's visible label, URLs under the base become relative. The recording is
 * replayed once in a fresh session; a program that does not pass again is not worth saving.
 */
export async function recordCase(rt: RuntimeImpl, name: string, program: string, o: RunOptions & { profile?: string }): Promise<{ ok: boolean; text?: string; message?: string; result?: TestResult }> {
  const sid = `aw-rec-${process.pid}-${++sessionCounter}`;
  const base = o.base;
  const out: string[] = [];
  const steps = parseProgram(program);
  const pre = o.profile ? `profile(${JSON.stringify(o.profile)})` : '';
  const all: Step[] = [...(pre ? parseProgram(pre) : []), ...steps];
  try {
    for (const [si, step] of all.entries()) {
      const portable: Step = { ...step, args: [...step.args], opts: { ...step.opts } };
      const ix = portable.verb === 'press' ? 1 : 0;
      if (['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'submit', 'upload', 'press'].includes(portable.verb) && typeof portable.args[ix] === 'number') {
        const rec = await rt.deps.store.get<SessionRecord>(SESSION_NS, sid);
        const label = rec?.refs[(portable.args[ix] as number) - 1]?.l;
        if (label) portable.args[ix] = label;
      }
      if (portable.verb === 'open' && typeof portable.args[0] === 'string') {
        const abs = withBase(portable.args[0], base);
        portable.args[0] = base && abs.startsWith(new URL(base).origin) ? abs.slice(new URL(base).origin.length) || '/' : abs;
      }
      const run = { ...portable, args: [...portable.args] };
      if (run.verb === 'open' && typeof run.args[0] === 'string') run.args[0] = withBase(run.args[0], base);
      const r = await rt.run(sid, stepToSource(run), { budget: o.excerptTokens });
      if (!r.ok) return { ok: false, message: `${step.src}: ${firstError(r.text, stepToSource(run))}` };
      if (pre && si === 0) continue; // the header carries it
      out.push(stepToSource(portable));
    }
  } finally {
    await rt.deps.store.del(SESSION_NS, sid).catch(() => {});
  }
  const body = out;
  let text = `# name: ${name}\n`;
  if (base) text += `# base: ${base}\n`;
  if (o.profile) text += `# profile: ${o.profile}\n`;
  text += '\n' + body.join('\n') + '\n';
  // replay in a fresh session: a recording that does not pass again is not worth saving
  const [tc] = parseTestFile(text, 'recording.aw');
  if (tc) {
    const again = await runCase(rt, tc, { ...o, update: false, ci: false });
    if (!again.ok) return { ok: false, message: `the recording does not pass when replayed: line ${again.failure?.line} ${again.failure?.step} — ${again.failure?.message}`, result: again };
  }
  return { ok: true, text };
}
