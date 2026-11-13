// `agentweb test`: find test files, run them, print a report an agent can afford to read.

import { existsSync, globSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createAgentweb } from '../index.ts';
import { parseTestFile, type TestCase } from './parse.ts';
import { formatReport, htmlReport, summarize, testLine } from './report.ts';
import { recordCase, runAll, type RunOptions, type TestResult } from './runner.ts';
import { watchResources } from './resources.ts';

export const TEST_HELP = `agentweb test - end-to-end tests in agentweb programs, failures in a few lines

  agentweb test [paths|globs]       run *.aw / *.awtest files (default: ./tests, else .)
        --base URL                  resolve relative open('/x') against it (also AGENTWEB_BASE; overrides "# base:")
        --workers N                 tests in parallel (default 3)
        --grep TEXT                 only tests whose "file name" contains TEXT
        --grep-test TEXT            only tests whose "## " title contains TEXT (the title as written, before "# each:" values)
        --setup CMD  --teardown CMD shell commands run once for the whole run; name=value lines setup prints are \${name} in
                                    every test of every file. \${worker} is the worker's number, 0 to N-1 (AW_WORKER in commands)
        --bail                      stop after the first failure
        --update                    accept new or changed snapshot('name') baselines
        --ci                        a missing snapshot baseline fails instead of being written
        --json                      machine-readable result (each test: engine, engines, emulation, ms, failure)
        --verbose                   one line per test, with the engine that ran it, printed as each test ends
        --report DIR                write DIR/index.html: every test's result with a full-page screenshot of where it ended
                                    (and of every shot(full=1, attach='label') step in between)
        --quiet                     no "… 12/46 done" lines on stderr while a long run is going
        --engine NAME               load every page in chrome | ghost | wire | firefox | webkit (overrides "# engine:")
        --no-ghost  --no-chrome     switch an engine off     --browser chrome|firefox|webkit   the real browser to use
        --images                    load page images (on by itself when a test takes screenshots or checks layout, accessibility or requests)
        --no-exec                   refuse "# setup:", "# teardown:" and exec() commands
        --timeout SEC               per-test limit (default 60)
        --excerpt N                 tokens of page shown with a failure (default 200)
  agentweb test --record out.aw "open('/'); click('Sign in'); expect('Welcome')" [--base URL] [--profile NAME]
                                    run the program; if it passes (and passes again in a fresh session), write it as a test
                                    with numbered targets replaced by their visible labels

  Test file:   # base: http://localhost:3000  (also # profile: parent, # timeout: 30, # engine: chrome)
               # expect-timeout: 5                 how long one assertion waits (then "# timeout:" is only the whole test's limit)
               # soft: on                          a failing expect does not end the test; all failures are reported together
               # each: path in /home, /help        the test runs once per value, \${path} standing for it (also in its name)
               # profile: \${profile}              a sign-in file that a setup command wrote and printed as profile=/path.json
               # setup: node scripts/seed.mjs      shell commands; name=value lines they print become \${name}
               # teardown: node scripts/clean.mjs  (top of file: once per file; under a ## test: for that test)
               ## sign in works
               open('/login'); fill('Email','a@b.co'); submit(); expect('Welcome'); expect(url='/dashboard')
  Commands:    exec('node scripts/otp.mjs', as='otp', retry=10); fill('Code', '\${otp}')
               mail(to='\${email}', wait=30); open('\${mail.link}')   newest message in a local Mailpit (AGENTWEB_MAILPIT=http://127.0.0.1:54324);
                                                                       also \${mail.subject}, \${mail.code}, \${mail.text}
  Assertions:  expect('text')  expect('Item', n=3)  expect(not='Error')  expect(url='/cart')  expect(title='Cart')
               expect(role='heading', level=1)  expect(axe=0, tags='wcag2a,wcag2aa', impact='serious', disable='…', exclude='…')
               expect(overflow=0)  expect(audit=0)  expect(console=0)  expect(requests=0, allow='favicon', allow_status='401')
               expect(same='menu', of='nav a')   the same text in every test of the run that says so    expect(…, soft=1)
               snapshot('name')   compare the page's text view with __aw_snapshots__/ (--update to accept)
  Exit code 0 when everything passes, 1 on a failure, 2 on bad usage.
`;

interface TestFlags {
  paths: string[];
  str: Record<string, string>;
  bool: Set<string>;
}

const BOOL = new Set(['quiet', 'images', 'bail', 'update', 'ci', 'json', 'verbose', 'help', 'v', 'no-ghost', 'no-chrome', 'no-exec', 'record']);
const VALUE = new Set(['grep-test', 'setup', 'teardown', 'report', 'base', 'workers', 'grep', 'timeout', 'excerpt', 'engine', 'browser', 'record', 'profile', 'name']);

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
  // a flag that does nothing is worse than an error: the run would not be what was asked for
  const unknown = [...Object.keys(f.str), ...f.bool].filter((k) => !BOOL.has(k) && !VALUE.has(k));
  if (unknown.length) {
    io.err(`agentweb test: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => '--' + k).join(', ')} (agentweb test --help lists them)`);
    return 2;
  }
  const env = process.env;
  const engine = f.str.engine?.toLowerCase();
  const opts: RunOptions = {
    engine: engine && engine !== 'auto' ? engine : undefined,
    exec: !f.bool.has('no-exec'),
    base: f.str.base ?? env.AGENTWEB_BASE,
    workers: Math.max(1, Number(f.str.workers ?? env.AGENTWEB_TEST_WORKERS ?? 3) || 3),
    bail: f.bool.has('bail'),
    update: f.bool.has('update'),
    ci: f.bool.has('ci') || (!!env.CI && env.CI !== '0' && env.CI !== 'false'),
    timeoutMs: (Number(f.str.timeout) || 60) * 1000,
    excerptTokens: Math.max(200, Number(f.str.excerpt) || 200),
    report: f.str.report ? resolve(process.cwd(), f.str.report) : undefined,
    runSetup: f.str.setup ? [f.str.setup] : undefined,
    runTeardown: f.str.teardown ? [f.str.teardown] : undefined,
  };

  let wantImages = f.bool.has('images');
  const browser = f.str.browser?.toLowerCase() === 'safari' ? 'webkit' : f.str.browser?.toLowerCase();
  const mk = () =>
    createAgentweb({
      store: 'memory:',
      cache: false,
      atlas: false,
      // a test file is the person's own program: a sign-in file its setup wrote may be loaded, and its steps are not asked about twice
      profileFiles: true,
      // Images cost time and memory and most page checks do not look at them, so a run loads them only when it
      // asks for something that does: a screenshot, a layout or accessibility check, a request check (--images forces it)
      env: { ...process.env, AGENTWEB_IMAGES: process.env.AGENTWEB_IMAGES ?? (wantImages ? '1' : '0'), AGENTWEB_CONFIRM: process.env.AGENTWEB_CONFIRM ?? 'never', AGENTWEB_SETTLE: process.env.AGENTWEB_SETTLE ?? 'test' },
      budget: opts.excerptTokens,
      ...(f.bool.has('no-ghost') ? { ghost: false } : {}),
      ...(f.bool.has('no-chrome') ? { chrome: false } : {}),
      ...(browser === 'chrome' || browser === 'firefox' || browser === 'webkit' ? { browser } : {}),
    });

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
  const grepTest = f.str['grep-test']?.toLowerCase();
  if (grepTest) cases = cases.filter((c) => (c.title ?? c.name).toLowerCase().includes(grepTest));
  if (!cases.length && !bad.length) {
    io.out(files.length ? 'no tests match' : 'no test files found (*.aw, *.awtest)');
    return files.length && !grep ? 0 : 1;
  }

  if (cases.some((c) => !!c.console || c.steps.some((st) => /\b(?:screenshot|shot|overflow|audit|record)\s*\(|\b(?:requests|console|overflow|no_overflow|audit|axe)\s*=/.test(st.src)))) wantImages = true;
  const t0 = performance.now();
  const watch = watchResources();
  const rt = await mk();
  // which engine each site needed, remembered between runs (a week at most) so a suite does not re-learn it every time
  const mem = env.AGENTWEB_TEST_MEMORY;
  const memory = opts.engine || mem === '0' ? undefined : mem && mem !== '1' ? resolve(cwd, mem) : existsSync(join(cwd, 'node_modules')) ? join(cwd, 'node_modules', '.cache', 'agentweb', 'engines.json') : undefined;
  const WEEK = 7 * 86400_000;
  const seenAt = new Map<string, number>();
  if (memory) {
    try {
      for (const [origin, v] of Object.entries(JSON.parse(readFileSync(memory, 'utf8')) as Record<string, { tier: string; at: number }>)) {
        seenAt.set(origin, v.at);
        if (Date.now() - v.at < WEEK && ['ghost', 'chrome', 'firefox', 'webkit'].includes(v.tier)) rt.tierHints.set(origin, v.tier as never);
      }
    } catch {}
  }
  let results: TestResult[];
  let resources: ReturnType<typeof watch.stop>;
  // A long run is not silent: with --verbose each test's line is printed as it ends; otherwise stderr gets a count
  // every 15 s (stdout stays the report an agent reads).
  const live = f.bool.has('verbose') && !f.bool.has('json');
  let done = 0;
  let failedSoFar = 0;
  const beat = f.bool.has('quiet') || live ? undefined : setInterval(() => io.err(`… ${done}/${cases.length} done${failedSoFar ? `, ${failedSoFar} failed` : ''} (${Math.round((performance.now() - t0) / 1000)}s)`), 15_000);
  beat?.unref();
  try {
    results = await runAll(rt, cases, opts, (r) => {
      done++;
      if (!r.ok) failedSoFar++;
      if (live) io.out(testLine({ ...r, file: rel(r.file) }));
    });
  } finally {
    if (beat) clearInterval(beat);
    // measured before the browser is closed: after that its processes are gone from the tree
    resources = watch.stop();
    if (memory) {
      try {
        mkdirSync(dirname(memory), { recursive: true });
        writeFileSync(memory, JSON.stringify(Object.fromEntries([...rt.tierHints].map(([origin, tier]) => [origin, { tier, at: seenAt.get(origin) ?? Date.now() }]))));
      } catch {}
    }
    await rt.close();
  }
  results = [...bad, ...results].map((r) => ({ ...r, file: rel(r.file) }));
  const ms = Math.round(performance.now() - t0);
  const s = summarize(results, ms);
  if (resources) s.resources = resources;
  if (opts.report) {
    try {
      mkdirSync(opts.report, { recursive: true });
      writeFileSync(join(opts.report, 'index.html'), htmlReport(s));
    } catch (e) {
      io.err(`could not write the report: ${(e as Error).message}`);
    }
  }
  io.out(f.bool.has('json') ? JSON.stringify(s, null, 2) : formatReport(s, { verbose: f.bool.has('verbose'), streamed: live }) + (opts.report ? `\nreport: ${join(opts.report, 'index.html')}` : ''));
  return s.failed ? 1 : 0;
}
