// Verb pack: saved programs.
//
//   program('price-check', save="open('shop.example'); find('{item}')")   store it
//   program('price-check', item='usb hub')                                 run it, {item} filled in
//   program('price-check', show=1) · program('price-check', delete=1)      read / remove it
//   programs()                                                             names, placeholders, first step
//
// A stored program is plain text run by the same runtime in the same run: it uses the caller's
// session, guard and budget and gets no rights of its own. Programs may call programs, three deep.

import { parseProgram, type Step } from '../dsl.ts';
import type { RunCtx, RuntimeImpl } from '../runtime.ts';
import { estimateTokens } from '../tokens.ts';
import { AwError } from '../types.ts';
import { resolveUrl } from '../test/runner.ts';
import { cleanName, deleteProgramFile, fillPlaceholders, loadProgram, programNames, programText, validateProgram, valuesFromOpts, writeProgramFile, readProgramFile } from './files.ts';

export { agentwebHome, programsDir } from './files.ts';

const RESERVED = new Set(['save', 'delete', 'show']);
export const MAX_DEPTH = 3;
/** steps run by stored programs in one run: programs can nest, so the 40-step limit of a call is not enough */
const MAX_STEPS = 200;

const depth = new WeakMap<RunCtx, { level: number; steps: number }>();
const str = (a: unknown) => (a === undefined || a === null ? '' : String(a));
const truthy = (v: unknown) => v !== undefined && v !== false && v !== 0 && !/^(0|false|no|off)$/i.test(String(v));

type Env = Record<string, string | undefined>;

export function register(rt: RuntimeImpl, env: Env = process.env): void {
  rt.register('program', (rc, step) => program(rc, step, env));
  rt.register('programs', (rc) => programs(rc, env));
}

function listHint(env: Env): string {
  const names = programNames(env);
  return names.length ? `saved programs: ${names.join(', ')}` : "none saved yet: program('name', save=\"open('site.example'); find('{word}')\")";
}

async function program(rc: RunCtx, step: Step, env: Env): Promise<void> {
  if (!step.args.length) throw new AwError('bad_request', "program needs a name: program('price-check', item='usb hub')", 'programs() lists the saved ones');
  const name = cleanName(step.args[0]);
  const o = step.opts;

  if (o.save !== undefined) {
    const src = str(o.save).trim();
    if (!src) throw new AwError('bad_request', "save needs the steps: program('name', save=\"open('site.example'); find('{word}')\")");
    try {
      validateProgram(src);
    } catch (e) {
      throw new AwError('bad_request', `not saved: ${(e as Error).message}`, (e as AwError).hint);
    }
    // a stored program is plain text on disk: a secret typed into it would sit there for good
    if (rc.guard.redact(src) !== src) throw new AwError('policy', 'not saved: the program contains a stored secret value', "use the handle instead: fill('Password', '{{secret:NAME}}')");
    const { replaced } = writeProgramFile(env, name, programText(name, src));
    const def = loadProgram(env, name)!;
    rc.emit(`${replaced ? 'replaced' : 'saved'} program '${name}' (${def.steps.length} step${def.steps.length === 1 ? '' : 's'}${def.placeholders.length ? `; fill ${def.placeholders.map((p) => `${p}=…`).join(', ')}` : ''}). Run it: program('${name}'${def.placeholders.map((p) => `, ${p}='…'`).join('')})`);
    return;
  }

  if (truthy(o.delete)) {
    if (!deleteProgramFile(env, name)) throw new AwError('bad_request', `no saved program '${name}'`, listHint(env));
    rc.emit(`deleted program '${name}'`);
    return;
  }

  const text = readProgramFile(env, name);
  if (text === undefined) throw new AwError('bad_request', `no saved program '${name}'`, listHint(env));
  if (truthy(o.show)) {
    rc.emit(text.trim());
    return;
  }

  const def = loadProgram(env, name)!;
  const given = valuesFromOpts(o, RESERVED);
  const { steps: filled, missing } = fillPlaceholders(def.steps, given);
  if (missing.length) {
    throw new AwError('bad_request', `program '${name}' needs ${missing.map((m) => `${m}=`).join(', ')}`, `placeholders: ${def.placeholders.join(', ')}. Example: program('${name}'${def.placeholders.map((p) => `, ${p}='…'`).join('')})`);
  }
  const extra = [...given.keys()].filter((k) => !def.placeholders.includes(k));
  if (extra.length) rc.note(`program '${name}' has no placeholder ${extra.map((e) => `{${e}}`).join(', ')}; ignored`);

  const st = depth.get(rc) ?? { level: 0, steps: 0 };
  if (st.level >= MAX_DEPTH) throw new AwError('bad_request', `programs may call programs only ${MAX_DEPTH} deep; '${name}' was one level too many`, 'inline the inner program, or check for a program that calls itself');
  depth.set(rc, { level: st.level + 1, steps: st.steps });
  try {
    let steps: Step[];
    try {
      steps = parseProgram((def.profile ? `profile(${JSON.stringify(def.profile)}); ` : '') + filled.join('; '));
    } catch (e) {
      throw new AwError('bad_request', `program '${name}' cannot be read: ${(e as Error).message}`, (e as AwError).hint);
    }
    for (const [i, s] of steps.entries()) {
      const cur = depth.get(rc)!;
      if (++cur.steps > MAX_STEPS) throw new AwError('bad_request', `stored programs ran more than ${MAX_STEPS} steps in one call`, 'split the work over several calls');
      let run = s;
      // `# base:` makes open('/x') relative to a site, as it is in a test file
      if (s.verb === 'open' && typeof s.args[0] === 'string' && def.base) {
        try {
          run = { ...s, args: [resolveUrl(s.args[0], def.base), ...s.args.slice(1)] };
        } catch (e) {
          throw new AwError('bad_request', (e as Error).message);
        }
      }
      try {
        await rc.rt.execStep(rc, run);
      } catch (e) {
        if (!(e instanceof AwError)) throw e;
        // say which step of which program failed, keep the code and the hint
        const where = `in program '${name}' step ${i + 1} (${s.src})`;
        throw new AwError(e.code, e.message.includes(where) ? e.message : `${where}: ${e.message}`, e.hint);
      }
    }
  } finally {
    depth.set(rc, { level: st.level, steps: depth.get(rc)?.steps ?? st.steps });
  }
}

async function programs(rc: RunCtx, env: Env): Promise<void> {
  const names = programNames(env);
  if (!names.length) {
    rc.emit("no saved programs. Save one: program('price-check', save=\"open('shop.example'); find('{item}')\")");
    return;
  }
  const lines: string[] = [];
  let left = rc.remaining - 40;
  let hidden = 0;
  for (const name of names) {
    let line: string;
    try {
      const def = loadProgram(env, name)!;
      const first = def.steps[0].length > 70 ? def.steps[0].slice(0, 69) + '…' : def.steps[0];
      line = `${name}${def.placeholders.length ? `(${def.placeholders.join(', ')})` : ''} - ${first}${def.steps.length > 1 ? ` (+${def.steps.length - 1})` : ''}`;
    } catch (e) {
      line = `${name} - unreadable: ${(e as Error).message}`;
    }
    const cost = estimateTokens(line) + 1;
    if (cost > left) {
      hidden++;
      continue;
    }
    left -= cost;
    lines.push(line);
  }
  rc.emit([`${names.length} saved program${names.length === 1 ? '' : 's'}:`, ...lines, ...(hidden ? [`… +${hidden} more (raise budget)`] : [])].join('\n'));
}
