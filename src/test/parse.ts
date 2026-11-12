// Test files. Plain text, one file may hold several tests:
//
//     # base: http://localhost:3000        file headers (also: profile, viewport, timeout)
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
  steps: TestStep[];
  /** line of the test's `## ` header (or 1) */
  line: number;
}

const HEADER = /^#\s*(name|base|profile|viewport|timeout|skip)\s*:\s*(.*?)\s*$/i;
const COMMENT = /^(#|\/\/)/;

interface Meta {
  name?: string;
  base?: string;
  profile?: string;
  viewport?: string;
  timeoutMs?: number;
  skip?: boolean;
}

function applyHeader(m: Meta, key: string, value: string) {
  switch (key.toLowerCase()) {
    case 'name': m.name = value; break;
    case 'base': m.base = value; break;
    case 'profile': m.profile = value; break;
    case 'viewport': m.viewport = value; break;
    case 'timeout': m.timeoutMs = (/ms$/i.test(value) ? parseFloat(value) : parseFloat(value) * 1000) || undefined; break;
    case 'skip': m.skip = !/^(0|false|no)$/i.test(value); break;
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
      cases.push({ file, name: cur.name ?? m.name ?? baseName(file), base: m.base, profile: m.profile, viewport: m.viewport, timeoutMs: m.timeoutMs, skip: m.skip, steps: cur.steps, line: cur.line });
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
