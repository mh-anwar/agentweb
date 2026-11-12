// Saved programs ("shortcuts") as plain files: NAME.aw under AGENTWEB_PROGRAMS (default
// ~/.agentweb/programs). The format is the one `agentweb test` reads: `# name:` / `# base:` /
// `# profile:` headers, then steps one per line or ';'-separated. A recording made with
// `agentweb test --record` is therefore already a program, and a program without placeholders can
// be run as a test.
//
// Placeholders are `{name}` inside the steps; `program('x', name='v')` fills them. Names are
// case-insensitive (the program parser lower-cases option names).

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseProgram, splitStatements, type Arg } from '../dsl.ts';
import { parseTestFile } from '../test/parse.ts';
import { AwError } from '../types.ts';

type Env = Record<string, string | undefined>;

export const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function agentwebHome(env: Env = process.env): string {
  return env.AGENTWEB_HOME || join(homedir(), '.agentweb');
}

export function programsDir(env: Env = process.env): string {
  return env.AGENTWEB_PROGRAMS || join(agentwebHome(env), 'programs');
}

/** Names are file names: lower-case letters, digits, '-' and '_' only, so a name can never leave the directory. */
export function cleanName(raw: unknown): string {
  const name = String(raw ?? '').trim().toLowerCase().replace(/\.aw$/, '');
  if (!NAME_RE.test(name)) throw new AwError('bad_request', `'${String(raw ?? '')}' is not a usable program name`, 'use letters, digits, - and _ (up to 64), e.g. price-check');
  return name;
}

const fileOf = (env: Env, name: string) => join(programsDir(env), `${name}.aw`);

export function readProgramFile(env: Env, name: string): string | undefined {
  try {
    return readFileSync(fileOf(env, name), 'utf8');
  } catch {
    return undefined;
  }
}

export function programNames(env: Env = process.env): string[] {
  try {
    return readdirSync(programsDir(env)).filter((f) => f.endsWith('.aw') && NAME_RE.test(f.slice(0, -3))).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}

/** Write through a temp file so a reader never sees half a program. */
export function writeProgramFile(env: Env, name: string, text: string): { replaced: boolean } {
  const dir = programsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = fileOf(env, name);
  const replaced = existsSync(path);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
  return { replaced };
}

export function deleteProgramFile(env: Env, name: string): boolean {
  const path = fileOf(env, name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

// ───────────────────────────── parsing ─────────────────────────────

export interface ProgramDef {
  name: string;
  /** the statements, one string each, placeholders still in place */
  steps: string[];
  /** `# base:` header: relative open('/x') resolves against it */
  base?: string;
  /** `# profile:` header: a saved sign-in applied before the first step */
  profile?: string;
  placeholders: string[];
}

const PLACEHOLDER = /(?<!\{)\{([A-Za-z_][\w-]*)\}(?!\})/g; // {{secret:x}} and {{PW}} are not placeholders

export function placeholdersOf(steps: string[]): string[] {
  const seen = new Set<string>();
  for (const s of steps) for (const m of s.matchAll(PLACEHOLDER)) seen.add(m[1].toLowerCase());
  return [...seen];
}

/** File text -> definition. One program per file: several `## ` tests are refused rather than guessed at. */
export function parseProgramText(name: string, text: string): ProgramDef {
  const cases = parseTestFile(text, `${name}.aw`);
  if (cases.length !== 1) throw new AwError('bad_request', cases.length ? `${name}.aw holds ${cases.length} tests; a program is one` : `program '${name}' has no steps`, 'save one program per name');
  const [tc] = cases;
  const steps = tc.steps.map((s) => s.src);
  if (!steps.length) throw new AwError('bad_request', `program '${name}' has no steps`);
  return { name, steps, base: tc.base, profile: tc.profile, placeholders: placeholdersOf(steps) };
}

/** What `program('x', save=...)` writes: a name header and one step per line. */
export function programText(name: string, src: string): string {
  const steps = splitStatements(src.trim());
  return `# name: ${name}\n\n${steps.join('\n')}\n`;
}

export function loadProgram(env: Env, name: string): ProgramDef | undefined {
  const text = readProgramFile(env, name);
  return text === undefined ? undefined : parseProgramText(name, text);
}

/** Refuse to save text that cannot run. Placeholders are filled with a dummy so the steps still parse. */
export function validateProgram(src: string): void {
  const dummy = fillPlaceholders(splitStatements(src.trim()), new Map()).steps;
  parseProgram(dummy.join('; '));
}

// ───────────────────────────── placeholders ─────────────────────────────

const quoteArg = (v: string, q: string) => v.replace(/\\/g, '\\\\').split(q).join('\\' + q);

/**
 * Fill `{name}` from `values`. A value inside a quoted string is escaped for that quote, so a value
 * with a quote or ';' in it stays one argument instead of becoming a second step. Missing names are
 * returned (and replaced with 'x' only so validation can parse the rest).
 */
export function fillPlaceholders(steps: string[], values: Map<string, string>): { steps: string[]; missing: string[] } {
  const missing = new Set<string>();
  const out = steps.map((s) => {
    let quote = '';
    let res = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === '\\' && i + 1 < s.length) {
          res += c + s[++i];
          continue;
        }
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      if (c === '{' && s[i - 1] !== '{') {
        const m = /^\{([A-Za-z_][\w-]*)\}(?!\})/.exec(s.slice(i));
        if (m) {
          const key = m[1].toLowerCase();
          const v = values.get(key);
          if (v === undefined) missing.add(key);
          res += quote ? quoteArg(v ?? 'x', quote) : (v ?? 'x');
          i += m[0].length - 1;
          continue;
        }
      }
      res += c;
    }
    return res;
  });
  return { steps: out, missing: [...missing] };
}

export function valuesFromOpts(opts: Record<string, Arg>, reserved: Set<string>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(opts)) if (!reserved.has(k)) m.set(k.toLowerCase(), String(v));
  return m;
}

/** A value as a quoted program argument (for building `program('x', key='v')` text). */
export function quoteValue(v: string): string {
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}
