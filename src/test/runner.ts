// Runs test cases against one agentweb runtime. No model, no randomness: every test gets a fresh
// session (empty cookie jar, no history), steps run one at a time so a failure names its line,
// and a failure carries a small excerpt of the page instead of a trace.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseProgram, type Arg, type Step } from '../dsl.ts';
import { SESSION_NS, type SessionRecord } from '../session.ts';
import type { RuntimeImpl } from '../runtime.ts';
import { baseName, parseTestFile, type TestCase, type TestStep } from './parse.ts';

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
}

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

export async function runCase(rt: RuntimeImpl, tc: TestCase, o: RunOptions): Promise<TestResult> {
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

  const steps: TestStep[] = [];
  if (tc.profile) steps.push({ line: tc.line, src: `profile(${JSON.stringify(tc.profile)})` });
  if (tc.viewport && rt.verbHandler('viewport')) steps.push({ line: tc.line, src: `viewport(${JSON.stringify(tc.viewport)})` });
  steps.push(...tc.steps);

  const fail = async (st: TestStep, message: string, excerpt?: string) => {
    res.ok = false;
    res.failure = { line: st.line, step: st.src, message: message.replace(/\s+/g, ' ').trim(), excerpt: excerpt ?? (await pageExcerpt(rt, sid, o.excerptTokens)) };
  };

  try {
    for (const st of steps) {
      let step: Step;
      const snap = SNAPSHOT.exec(st.src.trim());
      try {
        if (snap) step = { verb: 'view', args: [], opts: {}, src: st.src };
        else {
          step = parseProgram(st.src)[0];
          if (step.verb === 'expect' && tc.timeoutMs && step.opts.timeout === undefined) step = { ...step, opts: { ...step.opts, timeout: tc.timeoutMs / 1000 } };
          if (step.verb === 'open' && typeof step.args[0] === 'string') step = { ...step, args: [withBase(step.args[0], base), ...step.args.slice(1)] };
        }
      } catch (e) {
        await fail(st, (e as Error).message, '');
        break;
      }
      if (step.verb === 'open' && typeof step.args[0] === 'string') {
        try { origins.add(new URL(step.args[0]).origin); } catch {}
      }
      const r = await rt.run(sid, snap ? 'view()' : stepToSource(step), { budget: snap ? 1500 : o.excerptTokens, signal: deadline });
      res.steps++;
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
  } finally {
    try {
      await rt.deps.store.del(SESSION_NS, sid);
    } catch {}
    res.ms = Math.round(performance.now() - t0);
  }
  return res;
}

/** "✗ <src> — message" is the first line of a failed run. */
function firstError(text: string, src: string): string {
  const line = text.split('\n')[0] ?? '';
  const m = /^✗ (.*)$/.exec(line);
  if (!m) return line || 'step failed';
  const i = m[1].indexOf(' — ');
  const body = m[1].startsWith(src) && m[1].slice(src.length).startsWith(' — ') ? m[1].slice(src.length + 3) : i >= 0 ? m[1].slice(i + 3) : m[1];
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
  const worker = async () => {
    for (;;) {
      if (stop) return;
      const i = next++;
      if (i >= cases.length) return;
      let r: TestResult;
      try {
        r = await runCase(rt, cases[i], o);
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
