// Runs test cases against one agentweb runtime. No model, no randomness: every test gets a fresh
// session (empty cookie jar, no history), steps run one at a time so a failure names its line,
// and a failure carries a small excerpt of the page instead of a trace.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
    child.once('close', (code, sig) => resolve({ ok: code === 0, out, err: code === 0 ? err : err || (sig ? `killed (${sig}) after ${Math.round(timeoutMs / 1000)} s` : `exit code ${code}`) }));
  });
}

const tail = (s: string, n = 3) => s.trim().split('\n').slice(-n).join(' / ').slice(0, 300);

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

function substitute(src: string, vars: Record<string, string>): string {
  return src.replace(/\$\{([A-Za-z_]\w*)\}/g, (_m, name: string) => {
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
  const deadline = AbortSignal.timeout(Math.max(o.timeoutMs, (tc.timeoutMs ?? 0) * 4));
  const origins = new Set<string>();
  if (base) try { origins.add(new URL(base).origin); } catch {}

  const vars: Record<string, string> = { ...shared };
  const tiers: string[] = [];
  const engine = o.engine ?? tc.engine;
  const steps: TestStep[] = [];
  // `# console: clean` needs the browser's own console from the first page on
  if (tc.console && !engine) steps.push({ line: tc.line, src: 'engine("chrome")' });
  if (engine && engine !== 'auto') steps.push({ line: tc.line, src: `engine(${JSON.stringify(engine)})` });
  if (tc.profile) steps.push({ line: tc.line, src: `profile(${JSON.stringify(tc.profile)})` });
  if (tc.viewport && rt.verbHandler('viewport')) steps.push({ line: tc.line, src: `viewport(${JSON.stringify(tc.viewport)})` });
  steps.push(...tc.steps);

  const fail = async (st: TestStep, message: string, excerpt?: string) => {
    res.ok = false;
    res.failure = { line: st.line, step: st.src, message: message.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'), excerpt: excerpt ?? (await pageExcerpt(rt, sid, o.excerptTokens)) };
  };

  const hook = async (cmds: string[] | undefined, what: string): Promise<boolean> => {
    for (const cmd of cmds ?? []) {
      if (o.exec === false) {
        await fail({ line: tc.line, src: `# ${what}: ${cmd}` }, `${what} commands are switched off (--no-exec)`, '');
        return false;
      }
      const r = await runShell(cmd, hookEnv(tc, base, vars), 120_000, deadline);
      if (!r.ok) {
        if (res.ok) await fail({ line: tc.line, src: `# ${what}: ${cmd}` }, `${what} failed: ${tail(r.err || r.out) || 'no output'}`, '');
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
            await fail(st0, `the command failed: ${tail(r.err || r.out) || 'no output'}`, '');
            break;
          }
          if (typeof ex.opts.as === 'string') vars[ex.opts.as] = r.out.trim();
          else Object.assign(vars, varsFrom(r.out));
          continue;
        }
        if (SCREENSHOT.test(st.src)) {
          // screenshot('name', widths='375,768', threshold=0.01): compared with a saved picture, like snapshot()
          const sc = parseProgram(st.src)[0];
          res.steps++;
          const v = await compareScreenshot(rt, sid, tc, sc, o, deadline);
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
          if (step.verb === 'expect' && tc.timeoutMs && step.opts.timeout === undefined) step = { ...step, opts: { ...step.opts, timeout: tc.timeoutMs / 1000 } };
          if (step.verb === 'open' && typeof step.args[0] === 'string') step = { ...step, args: [withBase(step.args[0], base), ...step.args.slice(1)] };
        }
      } catch (e) {
        await fail(st0, (e as Error).message, '');
        break;
      }
      if (step.verb === 'open' && typeof step.args[0] === 'string') {
        try { origins.add(new URL(step.args[0]).origin); } catch {}
      }
      const r = await rt.run(sid, snap ? 'view()' : stepToSource(step), { budget: snap ? 1500 : o.excerptTokens, signal: deadline });
      res.steps++;
      if (r.stats.tier && tiers[tiers.length - 1] !== r.stats.tier) tiers.push(r.stats.tier);
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
    if (res.ok && tc.console) {
      // `# console: clean`: no console errors (or, with warn, warnings) on any page this test visited
      const allow = tc.console.allow ? `, allow=${JSON.stringify(tc.console.allow)}` : '';
      const src = `expect(console=${tc.console.warn ? "'warn'" : 0}, all=1${allow})`;
      const r = await rt.run(sid, src, { budget: o.excerptTokens, signal: deadline });
      res.steps++;
      if (!r.ok) await fail({ line: tc.line, src: `# console: clean${tc.console.warn ? ', warn' : ''}${tc.console.allow ? ', allow=' + tc.console.allow : ''}` }, firstError(r.text, src), '');
    }
  } finally {
    if (tc.teardown?.length) await hook(tc.teardown, 'teardown');
    if (tiers.length) res.engine = tiers[tiers.length - 1];
    if (tiers.length > 1) res.engines = tiers;
    let rec: SessionRecord | undefined;
    try {
      rec = await rt.deps.store.get<SessionRecord>(SESSION_NS, sid);
      const e = rec?.emulate;
      if (e) {
        const parts = Object.entries(e).filter(([, v]) => v !== undefined && v !== '' && v !== false).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`);
        if (parts.length) res.emulation = parts.join(' ');
      }
      await rt.deps.store.del(SESSION_NS, sid);
    } catch {}
    // the test's browser pages (one per tab) are closed now, not when they go idle: a suite holds
    // only as many browser contexts as it has workers
    const ids = [sid, ...(rec?.tabs ?? []).map((t) => liveId({ id: sid }, t.n)), ...(rec?.tab ? [liveId({ id: sid }, rec.tab)] : [])];
    await Promise.all(Object.values(rt.deps.engines).flatMap((e) => (e && e.tier !== 'wire' ? ids.map((id) => e.release(id).catch(() => {})) : [])));
    res.ms = Math.round(performance.now() - t0);
  }
  return res;
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
          const r = await runShell(cmd, hookEnv(tc, o.base ?? tc.base, vars), 300_000);
          if (!r.ok) return { ok: false, vars, message: `setup failed (${cmd}): ${tail(r.err || r.out) || 'no output'}` };
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
  const worker = async () => {
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
            r = su.ok ? await runCase(rt, tc, o, su.vars) : { file: tc.file, name: tc.name, line: tc.line, ok: false, ms: 0, steps: 0, failure: { line: 1, step: '', message: su.message, excerpt: '' } };
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
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.workers, cases.length || 1)) }, worker));
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
