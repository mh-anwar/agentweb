// `agentweb test`: find test files, run them, print a report an agent can afford to read.

import { existsSync, globSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createAgentweb } from '../index.ts';
import { parseTestFile, type TestCase } from './parse.ts';
import { formatReport, summarize } from './report.ts';
import { recordCase, runAll, type RunOptions, type TestResult } from './runner.ts';

export const TEST_HELP = `agentweb test - end-to-end tests in agentweb programs, failures in a few lines

  agentweb test [paths|globs]       run *.aw / *.awtest files (default: ./tests, else .)
        --base URL                  resolve relative open('/x') against it (also AGENTWEB_BASE; overrides "# base:")
        --workers N                 tests in parallel (default 3)
        --grep TEXT                 only tests whose "file name" contains TEXT
        --bail                      stop after the first failure
        --update                    accept new or changed snapshot('name') baselines
        --ci                        a missing snapshot baseline fails instead of being written
        --json                      machine-readable result
        --verbose                   one line per test
        --timeout SEC               per-test limit (default 60)
        --excerpt N                 tokens of page shown with a failure (default 200)
  agentweb test --record out.aw "open('/'); click('Sign in'); expect('Welcome')" [--base URL] [--profile NAME]
                                    run the program; if it passes (and passes again in a fresh session), write it as a test
                                    with numbered targets replaced by their visible labels

  Test file:   # base: http://localhost:3000  (also # profile: parent, # timeout: 30)
               ## sign in works
               open('/login'); fill('Email','a@b.co'); submit(); expect('Welcome'); expect(url='/dashboard')
  Assertions:  expect('text')  expect('Item', n=3)  expect(not='Error')  expect(url='/cart')  expect(title='Cart')
               snapshot('name')   compare the page's text view with __aw_snapshots__/ (--update to accept)
  Exit code 0 when everything passes, 1 on a failure, 2 on bad usage.
`;

interface TestFlags {
  paths: string[];
  str: Record<string, string>;
  bool: Set<string>;
}

const BOOL = new Set(['bail', 'update', 'ci', 'json', 'verbose', 'help', 'v']);

export function parseTestArgs(argv: string[]): TestFlags {
  const f: TestFlags = { paths: [], str: {}, bool: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) f.str[name] = a.slice(eq + 1);
      else if (BOOL.has(name)) f.bool.add(name);
      else if (i + 1 < argv.length) f.str[name] = argv[++i];
      else f.bool.add(name);
    } else if (a === '-v') f.bool.add('verbose');
    else f.paths.push(a);
  }
  return f;
}

const SKIP_DIRS = new Set(['node_modules', '__aw_snapshots__', '.git', 'dist']);
const isTestFile = (p: string) => /\.(aw|awtest)$/i.test(p);

function walk(dir: string, out: string[]) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (isTestFile(e.name)) out.push(p);
  }
}

export function findTestFiles(paths: string[]): string[] {
  const roots = paths.length ? paths : [existsSync('tests') ? 'tests' : '.'];
  const out: string[] = [];
  for (const r of roots) {
    if (/[*?{[]/.test(r)) out.push(...globSync(r).filter((p) => isTestFile(p) && statSync(p).isFile()));
    else if (!existsSync(r)) throw new Error(`no such file or directory: ${r}`);
    else if (statSync(r).isDirectory()) walk(r, out);
    else out.push(r);
  }
  return [...new Set(out.map((p) => resolve(p)))].sort();
}

export async function testCommand(argv: string[], io: { out: (s: string) => void; err: (s: string) => void } = { out: (s) => console.log(s), err: (s) => console.error(s) }): Promise<number> {
  const f = parseTestArgs(argv);
  if (f.bool.has('help')) {
    io.out(TEST_HELP);
    return 0;
  }
  const env = process.env;
  const opts: RunOptions = {
    base: f.str.base ?? env.AGENTWEB_BASE,
    workers: Math.max(1, Number(f.str.workers ?? env.AGENTWEB_TEST_WORKERS ?? 3) || 3),
    bail: f.bool.has('bail'),
    update: f.bool.has('update'),
    ci: f.bool.has('ci') || (!!env.CI && env.CI !== '0' && env.CI !== 'false'),
    timeoutMs: (Number(f.str.timeout) || 60) * 1000,
    excerptTokens: Math.max(200, Number(f.str.excerpt) || 200),
  };

  const mk = () => createAgentweb({ store: 'memory:', cache: false, atlas: false, budget: opts.excerptTokens });

  if (f.str.record !== undefined || f.bool.has('record')) {
    // agentweb test --record out.aw "program"   (--record may also come first: out.aw is then its value)
    const [file, ...rest] = f.str.record !== undefined ? [f.str.record, ...f.paths] : f.paths;
    const program = rest.join(' ');
    if (!file || !program.trim()) {
      io.err('usage: agentweb test --record out.aw "open(\'/\'); click(\'Sign in\'); expect(\'Welcome\')" [--base URL] [--profile NAME]');
      return 2;
    }
    const rt = await mk();
    try {
      const name = f.str.name ?? basename(file).replace(/\.(aw|awtest)$/i, '').replace(/[-_]+/g, ' ');
      const r = await recordCase(rt, name, program, { ...opts, profile: f.str.profile });
      if (!r.ok) {
        io.out(`✗ not recorded: ${r.message}`);
        return 1;
      }
      writeFileSync(file, r.text!);
      io.out(`✓ recorded ${file} (${r.text!.trim().split('\n').filter((l) => l && !l.startsWith('#')).length} steps, replayed once in a fresh session)`);
      return 0;
    } catch (e) {
      io.err(`✗ ${(e as Error).message}`);
      return 2;
    } finally {
      await rt.close();
    }
  }

  let files: string[];
  try {
    files = findTestFiles(f.paths);
  } catch (e) {
    io.err((e as Error).message);
    return 2;
  }
  const cwd = process.cwd();
  const rel = (p: string) => (p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p);
  let cases: TestCase[] = [];
  const bad: TestResult[] = [];
  for (const file of files) {
    try {
      cases.push(...parseTestFile(readFileSync(file, 'utf8'), rel(file)));
    } catch (e) {
      bad.push({ file: rel(file), name: basename(file), line: 1, ok: false, ms: 0, steps: 0, failure: { line: 1, step: '', message: (e as Error).message, excerpt: '' } });
    }
  }
  // snapshots live next to the file; keep paths real for them
  for (const c of cases) c.file = resolve(cwd, c.file);
  const grep = f.str.grep?.toLowerCase();
  if (grep) cases = cases.filter((c) => `${rel(c.file)} ${c.name}`.toLowerCase().includes(grep));
  if (!cases.length && !bad.length) {
    io.out(files.length ? 'no tests match' : 'no test files found (*.aw, *.awtest)');
    return files.length && !grep ? 0 : 1;
  }

  const t0 = performance.now();
  const rt = await mk();
  let results: TestResult[];
  try {
    results = await runAll(rt, cases, opts);
  } finally {
    await rt.close();
  }
  results = [...bad, ...results].map((r) => ({ ...r, file: rel(r.file) }));
  const ms = Math.round(performance.now() - t0);
  const s = summarize(results, ms);
  io.out(f.bool.has('json') ? JSON.stringify(s, null, 2) : formatReport(s, { verbose: f.bool.has('verbose') }));
  return s.failed ? 1 : 0;
}
