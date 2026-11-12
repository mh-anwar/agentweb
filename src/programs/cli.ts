// `agentweb program ...`: the command-line side of saved programs.

import { readFileSync } from 'node:fs';
import { createAgentweb, type AgentwebConfig } from '../index.ts';
import { cleanName, deleteProgramFile, loadProgram, parseProgramText, programNames, programsDir, programText, quoteValue, readProgramFile, validateProgram, writeProgramFile } from './files.ts';

export const PROGRAM_HELP = `agentweb program - named programs you can run again

  agentweb program list                      names, placeholders and first step
  agentweb program show NAME                 the stored file
  agentweb program save NAME "<program>"     store a program; {word} in it is a placeholder
  agentweb program save NAME --from FILE     store a file (a recording made with: agentweb test --record out.aw "<program>")
  agentweb program run NAME key=value ...    run it, filling the placeholders  (--session S, --budget N, --json)
  agentweb program delete NAME

  Files are NAME.aw in ${'$'}AGENTWEB_PROGRAMS (default ~/.agentweb/programs), the format 'agentweb test' reads:
  a program without placeholders can also be run as a test: agentweb test ~/.agentweb/programs/NAME.aw
  Inside the tool: program('NAME', key='v') · programs()
`;

type IO = { out: (s: string) => void; err: (s: string) => void };
const stdio: IO = { out: (s) => console.log(s), err: (s) => console.error(s) };

interface Parsed {
  pos: string[];
  str: Record<string, string>;
  bool: Set<string>;
}

const VALUE_FLAGS = new Set(['session', 'budget', 'from', 'store']);

function parse(argv: string[]): Parsed {
  const p: Parsed = { pos: [], str: {}, bool: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      if (eq > 0) p.str[name] = a.slice(eq + 1);
      else if (VALUE_FLAGS.has(name) && i + 1 < argv.length) p.str[name] = argv[++i];
      else p.bool.add(name);
    } else p.pos.push(a);
  }
  return p;
}

export function runtimeConfig(p: Parsed): AgentwebConfig {
  const c: AgentwebConfig = {};
  if (p.str.store) c.store = p.str.store;
  if (p.bool.has('no-chrome')) c.chrome = false;
  if (p.bool.has('no-ghost')) c.ghost = false;
  if (p.bool.has('no-cache')) c.cache = false;
  if (p.str.budget) c.budget = Number(p.str.budget);
  return c;
}

export async function programCommand(argv: string[], io: IO = stdio, env: Record<string, string | undefined> = process.env): Promise<number> {
  const p = parse(argv);
  const [sub, ...rest] = p.pos;
  if (!sub || sub === 'help' || p.bool.has('help')) {
    io.out(PROGRAM_HELP);
    return sub || p.bool.has('help') ? 0 : 2;
  }
  try {
    switch (sub) {
      case 'list':
      case 'ls': {
        const names = programNames(env);
        if (!names.length) {
          io.out(`no saved programs in ${programsDir(env)}. Save one: agentweb program save NAME "open('site.example'); find('{word}')"`);
          return 0;
        }
        for (const n of names) {
          try {
            const d = loadProgram(env, n)!;
            io.out(`${n}${d.placeholders.length ? `(${d.placeholders.join(', ')})` : ''} - ${d.steps[0]}${d.steps.length > 1 ? ` (+${d.steps.length - 1})` : ''}`);
          } catch (e) {
            io.out(`${n} - unreadable: ${(e as Error).message}`);
          }
        }
        return 0;
      }
      case 'show': {
        const name = cleanName(rest[0]);
        const text = readProgramFile(env, name);
        if (text === undefined) {
          io.err(`no saved program '${name}'`);
          return 1;
        }
        io.out(text.trimEnd());
        return 0;
      }
      case 'save': {
        const name = cleanName(rest[0]);
        const file = p.str.from ?? (rest[1]?.startsWith('@') ? rest[1].slice(1) : undefined);
        let text: string;
        if (file) {
          text = readFileSync(file, 'utf8');
          const def = parseProgramText(name, text);
          validateProgram(def.steps.join('; '));
        } else {
          const src = rest.slice(1).join(' ').trim();
          if (!src) {
            io.err('usage: agentweb program save NAME "<program>"   (or --from FILE)');
            return 2;
          }
          validateProgram(src);
          text = programText(name, src);
        }
        const { replaced } = writeProgramFile(env, name, text);
        const def = loadProgram(env, name)!;
        io.out(`${replaced ? 'replaced' : 'saved'} ${name} (${def.steps.length} steps${def.placeholders.length ? `; placeholders: ${def.placeholders.join(', ')}` : ''})`);
        return 0;
      }
      case 'delete':
      case 'rm':
      case 'remove': {
        const name = cleanName(rest[0]);
        if (!deleteProgramFile(env, name)) {
          io.err(`no saved program '${name}'`);
          return 1;
        }
        io.out(`deleted ${name}`);
        return 0;
      }
      case 'run': {
        const name = cleanName(rest[0]);
        const kv = rest.slice(1);
        const bad = kv.find((x) => !/^[A-Za-z_][\w-]*=/.test(x));
        if (bad) {
          io.err(`'${bad}' is not key=value`);
          return 2;
        }
        const args = kv.map((x) => {
          const i = x.indexOf('=');
          return `${x.slice(0, i)}=${quoteValue(x.slice(i + 1))}`;
        });
        const rt = await createAgentweb({ ...runtimeConfig(p), env });
        try {
          const r = await rt.run(p.str.session ?? 'cli', `program(${[quoteValue(name), ...args].join(', ')})`, { budget: p.str.budget ? Number(p.str.budget) : undefined });
          io.out(p.bool.has('json') ? JSON.stringify(r, null, 2) : r.text);
          return r.ok ? 0 : 1;
        } finally {
          await rt.close();
        }
      }
      default:
        io.err(`unknown program command '${sub}'\n\n${PROGRAM_HELP}`);
        return 2;
    }
  } catch (e) {
    io.err(`✗ ${(e as Error).message}${(e as { hint?: string }).hint ? '\n' + (e as { hint?: string }).hint : ''}`);
    return 1;
  }
}
