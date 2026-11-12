// Test files. Plain text, one file may hold several tests:
//
//     # base: http://localhost:3000        file headers (also: profile, viewport, timeout, expect-timeout, soft, each,
//                                          engine, console, setup, teardown)
//     # profile: parent
//
//     ## sign in works                     a test; its steps follow, one per line or ';'-separated
//     open('/login'); fill('Email','a@b.co'); fill('Password','pw'); submit()
//     expect('Welcome'); expect(url='/dashboard')
//
//     ## wrong password is refused
//     # profile:                           (empty: this test starts signed out)
//     open('/login'); fill('Email','a@b.co'); fill('Password','nope'); submit()
//     expect(not='Welcome')
//
// A file without `## ` headers is one test (`# name: …` or the file name). Lines starting with
// `#` or `//` that are not headers are comments. Steps are agentweb program statements.

import { splitStatements } from '../dsl.ts';

export interface TestStep {
  /** 1-based line in the file */
  line: number;
  src: string;
}

export interface TestCase {
  file: string;
  name: string;
  base?: string;
  profile?: string;
  viewport?: string;
  timeoutMs?: number;
  skip?: boolean;
  /** engine every page of this test loads in ('chrome', 'ghost', 'wire', 'firefox', 'webkit'); absent = automatic */
  engine?: string;
  /** shell commands run before / after this test (`# setup:` / `# teardown:` under its `##`) */
  setup?: string[];
  teardown?: string[];
  /** shell commands run once before the file's first test / after its last (`# setup:` / `# teardown:` at the top) */
  fileSetup?: string[];
  fileTeardown?: string[];
  /** `# expect-timeout: 5`: how long an assertion waits for late content; `# timeout:` is then only the limit of the whole test */
  expectTimeoutMs?: number;
  /** `# soft: on`: a failing expect does not end the test; every failure is reported together */
  soft?: boolean;
  /** `# console: clean`: expect(console=0) is checked at the end of the test, over every page it visited */
  console?: ConsoleRule;
  steps: TestStep[];
  /** line of the test's `## ` header (or 1) */
  line: number;
}

export interface ConsoleRule {
  /** console='warn': warnings fail too */
  warn?: boolean;
  /** messages containing any of these are ignored */
  allow?: string;
}

/** `clean` · `clean, warn` · `clean, allow=favicon,hot-update` · `off` (switches a file-level rule off for one test) */
export function parseConsoleRule(value: string): ConsoleRule | undefined {
  const m = /^clean\b(.*)$/i.exec(value.trim());
  if (!m) return undefined;
  const rule: ConsoleRule = {};
  const allow = /(?:^|,)\s*allow\s*=\s*(.*)$/i.exec(m[1]);
  const rest = allow ? m[1].slice(0, allow.index) : m[1];
  if (/\bwarn/i.test(rest)) rule.warn = true;
  if (allow?.[1].trim()) rule.allow = allow[1].trim();
  return rule;
}

const HEADER = /^#\s*(name|base|profile|viewport|timeout|expect-timeout|soft|each|skip|engine|console|setup|teardown)\s*:\s*(.*?)\s*$/i;
const COMMENT = /^(#|\/\/)/;

interface Meta {
  name?: string;
  base?: string;
  profile?: string;
  viewport?: string;
  timeoutMs?: number;
  expectTimeoutMs?: number;
  soft?: boolean;
  /** `# each: path in /a, /b`: the test is run once per value, `${path}` standing for it */
  each?: { name: string; values: string[] };
  skip?: boolean;
  engine?: string;
  console?: ConsoleRule | null;
  setup?: string[];
  teardown?: string[];
}

function applyHeader(m: Meta, key: string, value: string) {
  switch (key.toLowerCase()) {
    case 'name': m.name = value; break;
    case 'base': m.base = value; break;
    case 'profile': m.profile = value; break;
    case 'viewport': m.viewport = value; break;
    case 'timeout': m.timeoutMs = (/ms$/i.test(value) ? parseFloat(value) : parseFloat(value) * 1000) || undefined; break;
    case 'expect-timeout': m.expectTimeoutMs = (/ms$/i.test(value) ? parseFloat(value) : parseFloat(value) * 1000) || undefined; break;
    case 'soft': m.soft = !/^(0|false|no|off)$/i.test(value); break;
    case 'each': {
      // `path in /a, /b, /c`; values with a comma inside go one per line, each on its own `# each:` line with the same name
      const e = /^([A-Za-z_]\w*)\s+in\s+(.*)$/.exec(value);
      if (!e) throw new Error(`"# each: ${value}" is not "name in value, value, …"`);
      const values = e[2].split(',').map((v) => v.trim()).filter(Boolean);
      if (m.each && m.each.name === e[1]) m.each.values.push(...values);
      else m.each = { name: e[1], values };
      break;
    }
    case 'skip': m.skip = !/^(0|false|no)$/i.test(value); break;
    case 'engine': m.engine = value.toLowerCase() || undefined; break;
    case 'console': m.console = parseConsoleRule(value) ?? null; break;
    case 'setup': if (value) (m.setup ??= []).push(value); break;
    case 'teardown': if (value) (m.teardown ??= []).push(value); break;
  }
}

export function baseName(file: string): string {
  return file.replace(/^.*[\\/]/, '').replace(/\.(aw|awtest)$/i, '');
}

export function parseTestFile(text: string, file: string): TestCase[] {
  const lines = text.split(/\r?\n/);
  const fileMeta: Meta = {};
  const cases: TestCase[] = [];
  let cur: { meta: Meta; name?: string; steps: TestStep[]; line: number; sawStep: boolean } | undefined;
  let sections = false;

  const open = (name: string | undefined, line: number) => {
    cur = { meta: {}, name, steps: [], line, sawStep: false };
  };
  const close = () => {
    if (!cur) return;
    if (cur.steps.length || cur.name) {
      const m = { ...fileMeta, ...cur.meta };
      // a file without sections is one test: its headers are the file's, and its hooks run once either way
      const own = sections ? cur.meta : {};
      const one: TestCase = { file, name: cur.name ?? m.name ?? baseName(file), base: m.base, profile: m.profile, viewport: m.viewport, timeoutMs: m.timeoutMs, expectTimeoutMs: m.expectTimeoutMs, soft: m.soft, skip: m.skip, engine: m.engine, console: m.console ?? undefined, setup: own.setup, teardown: own.teardown, fileSetup: fileMeta.setup, fileTeardown: fileMeta.teardown, steps: cur.steps, line: cur.line };
      if (!m.each) cases.push(one);
      else {
        // one test per value: `${name}` in its steps, its headers and its name stands for the value
        const ph = '${' + m.each.name + '}';
        const put = (text: string | undefined, v: string) => (text === undefined ? undefined : text.split(ph).join(v));
        for (const v of m.each.values) {
          cases.push({ ...one, name: one.name.includes(ph) ? put(one.name, v)! : `${one.name} [${v}]`, base: put(one.base, v), profile: put(one.profile, v), setup: one.setup?.map((c) => put(c, v)!), teardown: one.teardown?.map((c) => put(c, v)!), steps: one.steps.map((st) => ({ ...st, src: put(st.src, v)! })) });
        }
      }
    }
    cur = undefined;
  };

  open(undefined, 1);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    const sec = /^##\s+(.+?)\s*$/.exec(t);
    if (sec) {
      close();
      sections = true;
      open(sec[1], i + 1);
      continue;
    }
    const h = HEADER.exec(t);
    if (h && !cur!.sawStep) {
      // headers before the first `## ` belong to the file; inside a section they belong to the test
      applyHeader(sections ? cur!.meta : fileMeta, h[1], h[2]);
      if (!sections && h[1].toLowerCase() === 'name') cur!.name = undefined; // used as default name, applied at close()
      continue;
    }
    if (COMMENT.test(t)) continue;
    cur!.sawStep = true;
    for (const st of splitStatements(raw)) {
      if (COMMENT.test(st)) continue;
      cur!.steps.push({ line: i + 1, src: st });
    }
  }
  close();
  return cases;
}
