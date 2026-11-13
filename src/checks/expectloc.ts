// Assertions and targets by role, accessible name, label, test id or CSS, optionally inside a scope:
//
//   expect(role='button', name='Send report')              a visible button with that name (substring; name='/re/i'; exact=1)
//   expect(role='button', name='Save', disabled=1)          ... and its state: checked= disabled= enabled= focused= selected=
//                                                            expanded= pressed= (1 or 0), value='…', text='…' (contains), attr='k=v'
//   expect(checked='Kiosk') expect(focused='Email')         shorthand: the control with that name has that state
//   expect(role='row', n=3)  expect(role='dialog', hidden=1)   how many are visible; none visible (or none at all)
//   expect(not='QR codes', role='heading')                  no visible heading with that name
//   expect(label='Clock-in code', value='482 913')          a field by its label;  testid='…'  css='…'
//   expect('Saved', in='dialog:Settings')                   text inside a scope: 'role:name', 'role', '.css' / 'css=…'
//   within(role='dialog', name='Report a problem') / within('row:Ada') / within()   later steps act inside it
//
// Runs in the real browser (src/checks/locate.ts in the isolated world) and waits like expect('text').

import type { Step } from '../dsl.ts';
import { VERBS as DSL_VERBS } from '../dsl.ts';
import { needChrome, type RunCtx, type RuntimeImpl } from '../runtime.ts';
import { AwError } from '../types.ts';
import type { LocMatch, LocResult, LocSpec } from './locate.ts';

const STATE_KEYS = ['checked', 'unchecked', 'disabled', 'enabled', 'focused', 'selected', 'expanded', 'collapsed', 'pressed', 'hidden', 'visible', 'empty'] as const;
const LOCATOR_KEYS = ['role', 'label', 'testid', 'test_id', 'css', 'in', 'name'] as const;

const yes = (v: unknown) => v !== undefined && v !== false && v !== 0 && !/^(0|no|false|off)$/i.test(String(v));
/** a state given as a name: expect(checked='Kiosk') */
const asName = (v: unknown) => typeof v === 'string' && !/^(0|1|yes|no|true|false|on|off)$/i.test(v.trim());

export function register(rt: RuntimeImpl): void {
  rt.register('expect_loc', expectLoc);
  rt.register('within', within);
  DSL_VERBS.delete('expect_loc');
}

/** Does this expect() need the locator (rather than the page-text check)? */
export function wantsLocator(o: Record<string, unknown>, rec: { within?: string }): boolean {
  if (o.role !== undefined && String(o.role).toLowerCase() !== 'heading') return true;
  if (o.label !== undefined || o.testid !== undefined || o.test_id !== undefined || o.css !== undefined || o.in !== undefined || o.name !== undefined) return true;
  if (STATE_KEYS.some((k) => o[k] !== undefined) || o.value !== undefined || o.attr !== undefined || o.text !== undefined || o.exact !== undefined) return true;
  // inside within(...), text and headings are looked for in the scope
  return !!rec.within;
}

/** Run the in-page locator once. */
export async function locate(rc: RunCtx, spec: LocSpec): Promise<LocResult> {
  await needChrome(rc, 'finding elements by role and name');
  await rc.ensureLive();
  const res = await rc.live({ do: 'probe', what: 'locate', args: spec as Record<string, unknown> });
  try {
    return JSON.parse(res.value ?? 'null') as LocResult;
  } catch {
    throw new AwError('internal', 'the element search returned nothing readable');
  }
}

const desc = (m: { role: string; name: string }) => `${m.role}${m.name ? ` '${clip(m.name)}'` : ''}`;
const clip = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function specOf(step: Step, rec: { within?: string }, nameFrom?: string): LocSpec {
  const o = step.opts;
  const spec: LocSpec = {};
  if (o.role !== undefined) spec.role = String(o.role).toLowerCase();
  const name = o.name !== undefined ? String(o.name) : nameFrom;
  if (name !== undefined) spec.name = name;
  if (yes(o.exact)) spec.exact = true;
  if (o.label !== undefined) spec.label = String(o.label);
  const tid = o.testid ?? o.test_id;
  if (tid !== undefined) spec.testid = String(tid);
  if (o.css !== undefined) spec.css = String(o.css);
  if (o.level !== undefined) spec.level = Number(o.level);
  const scope = o.in !== undefined ? String(o.in) : rec.within;
  if (scope) spec.within = scope;
  return spec;
}

function what(spec: LocSpec): string {
  const bits = [spec.role ?? (spec.label !== undefined ? 'field' : spec.testid !== undefined ? 'element' : spec.css !== undefined ? 'element' : 'element')];
  if (spec.level) bits[0] = `level ${spec.level} ${bits[0]}`;
  if (spec.name !== undefined) bits.push(`named '${spec.name}'`);
  if (spec.label !== undefined) bits.push(`labelled '${spec.label}'`);
  if (spec.testid !== undefined) bits.push(`with test id '${spec.testid}'`);
  if (spec.css !== undefined) bits.push(`matching ${spec.css}`);
  if (spec.within) bits.push(`in ${spec.within}`);
  return bits.join(' ');
}

type Check = (m: LocMatch) => string | undefined;

/** The checks one matched element must pass, each returning why it fails. */
function stateChecks(o: Record<string, unknown>, focus: LocResult['focus']): Check[] {
  const c: Check[] = [];
  const flag = (k: string, v: unknown, get: (m: LocMatch) => boolean | undefined, on: string, off: string) => {
    if (v === undefined) return;
    const want = asName(v) ? true : yes(v);
    c.push((m) => (!!get(m) === want ? undefined : `${desc(m)} is ${want ? off : on}`));
  };
  flag('checked', o.checked, (m) => m.checked === true, 'checked', 'not checked');
  if (o.unchecked !== undefined) c.push((m) => (m.checked === true ? `${desc(m)} is checked` : undefined));
  flag('disabled', o.disabled, (m) => m.disabled, 'disabled', 'enabled');
  flag('enabled', o.enabled, (m) => !m.disabled, 'enabled', 'disabled');
  flag('selected', o.selected, (m) => m.selected, 'selected', 'not selected');
  flag('expanded', o.expanded, (m) => m.expanded, 'expanded', 'collapsed');
  if (o.collapsed !== undefined) c.push((m) => (m.expanded ? `${desc(m)} is expanded` : undefined));
  flag('pressed', o.pressed, (m) => m.pressed, 'pressed', 'not pressed');
  if (o.focused !== undefined) {
    const want = asName(o.focused) ? true : yes(o.focused);
    c.push((m) => (m.focused === want ? undefined : want ? `${desc(m)} does not have the focus (${focus ? `it is on ${desc(focus)}` : 'nothing has it'})` : `${desc(m)} has the focus`));
  }
  if (o.empty !== undefined) c.push((m) => ((m.value ?? m.text) === '' ? undefined : `${desc(m)} is not empty: '${clip(m.value ?? m.text)}'`));
  if (o.value !== undefined) {
    const v = String(o.value);
    const re = /^\/(.*)\/([a-z]*)$/s.exec(v);
    c.push((m) => {
      const got = m.value ?? '';
      const ok = re ? new RegExp(re[1], re[2]).test(got) : got === v;
      return ok ? undefined : `${desc(m)} has the value '${clip(got)}', expected '${v}'`;
    });
  }
  if (o.text !== undefined) {
    const v = String(o.text);
    const re = /^\/(.*)\/([a-z]*)$/s.exec(v);
    c.push((m) => {
      const ok = re ? new RegExp(re[1], re[2]).test(m.text) : m.text.toLowerCase().includes(v.replace(/\s+/g, ' ').trim().toLowerCase());
      return ok ? undefined : `${desc(m)} says '${clip(m.text, 120)}', expected it to contain '${v}'`;
    });
  }
  if (o.attr !== undefined) {
    const raw = String(o.attr);
    const i = raw.indexOf('=');
    const k = (i < 0 ? raw : raw.slice(0, i)).trim();
    const v = i < 0 ? undefined : raw.slice(i + 1).trim();
    c.push((m) => {
      const got = m.attrs[k];
      if (got === undefined) return `${desc(m)} has no ${k} attribute`;
      return v === undefined || got === v ? undefined : `${desc(m)} has ${k}="${clip(got)}", expected "${v}"`;
    });
  }
  return c;
}

/** One evaluation of the assertion: undefined when it holds, else why not. */
function judge(step: Step, spec: LocSpec, r: LocResult, own: string | undefined): string | undefined {
  const o = step.opts;
  if (r.noScope) return o.hidden !== undefined && yes(o.hidden) && !own ? undefined : r.noScope;
  const vis = r.matches.filter((m) => m.visible);
  const nth = o.nth !== undefined ? Number(o.nth) : yes(o.last) ? -1 : undefined;
  const pick = nth === undefined ? vis : nth === -1 ? vis.slice(-1) : vis.slice(nth - 1, nth);
  const nearLine = () => {
    if (!r.near.length) return '';
    return ` (${spec.role ?? 'elements'} here: ${r.near.slice(0, 6).map((x) => `'${clip(x.name, 40)}'${x.visible ? '' : ' (hidden)'}`).join(', ')})`;
  };
  // how many
  const nWant = o.n ?? o.count;
  if (nWant !== undefined) {
    const want = Number(nWant);
    if (vis.length === want) return undefined;
    const list = vis.slice(0, 5).map((m) => `'${clip(m.name || m.text, 40)}'`).join(', ');
    return `expected ${want} visible ${what(spec)}, found ${vis.length}${list ? `: ${list}` : ''}${vis.length < r.matches.length ? ` (and ${r.matches.length - vis.length} hidden)` : ''}`;
  }
  // none should be visible
  const hidden = o.hidden !== undefined ? (asName(o.hidden) ? true : yes(o.hidden)) : o.visible !== undefined && !asName(o.visible) ? !yes(o.visible) : false;
  if (hidden || o.not !== undefined) {
    return pick.length ? `${desc(pick[0])} is visible but should not be${pick.length > 1 ? ` (${pick.length} are)` : ''}` : undefined;
  }
  if (!r.matches.length) return `no ${what(spec)} on the page${nearLine()}`;
  if (!pick.length) return nth !== undefined && vis.length ? `there are only ${vis.length} visible ${what(spec)}` : `${desc(r.matches[0])} is on the page but not visible`;
  const checks = stateChecks(o, r.focus);
  if (!checks.length) return undefined;
  // the assertion holds when one of the visible matches passes every check
  let why: string | undefined;
  for (const m of pick) {
    const fails = checks.map((c) => c(m)).filter(Boolean) as string[];
    if (!fails.length) return undefined;
    why ??= fails.join('; ');
  }
  return pick.length > 1 ? `${why} (and ${pick.length - 1} more like it)` : why;
}

/** expect(...) with a role, label, test id, CSS, scope or element state. Waits until it holds or the time is up. */
async function expectLoc(rc: RunCtx, step: Step): Promise<void> {
  const o = step.opts;
  const own = step.args.length ? String(step.args[step.args.length - 1]) : undefined;
  // a state given as a name is the element's name: expect(checked='Kiosk')
  let nameFrom: string | undefined = own;
  for (const k of STATE_KEYS) if (asName(o[k]) && o.name === undefined && own === undefined) nameFrom = String(o[k]);
  if (o.not !== undefined && (o.role !== undefined || o.label !== undefined || o.testid !== undefined || o.css !== undefined)) nameFrom = String(o.not);
  const spec = specOf(step, rc.rec as { within?: string }, nameFrom);
  // expect('Saved', in='dialog:Settings') / expect(not='Error', in='row:Ada'): text inside the scope
  const textOnly = spec.role === undefined && spec.label === undefined && spec.testid === undefined && spec.css === undefined && o.name === undefined && !STATE_KEYS.some((k) => asName(o[k]));
  // expect('1 student', exact=1): an element whose whole text is that (getByText with exact)
  if (spec.exact && own !== undefined && o.name === undefined && !spec.role && !spec.label && !spec.testid && !spec.css) {
    spec.text = own;
    delete spec.name;
  }
  const textOnly2 = textOnly && !spec.text;
  if (!spec.role && !spec.label && !spec.testid && !spec.css && !spec.text && spec.name === undefined && !spec.within) throw new AwError('bad_request', "expect needs something to find: role='button', name='Save', label='Email', testid='…' or css='…'");
  const timeoutMs = o.timeout === undefined ? 5000 : Math.min(Number(o.timeout) < 100 ? Number(o.timeout) * 1000 : Number(o.timeout), 60000);
  for (const end = Date.now() + timeoutMs; ; ) {
    let why: string | undefined;
    if (textOnly2 && spec.within) why = scopeText(await locate(rc, { within: spec.within, roots: true }), spec.within, own, o.not !== undefined ? String(o.not) : undefined);
    else why = judge(step, spec, await locate(rc, spec), own);
    if (!why) return;
    if (Date.now() >= end || rc.ctx.signal?.aborted) throw new AwError('bad_request', why);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Text in a scope: what the scope's elements say. */
function scopeText(r: LocResult, scope: string, own: string | undefined, not: string | undefined): string | undefined {
  if (r.noScope) return not !== undefined && own === undefined ? undefined : r.noScope;
  const texts = r.matches.filter((m) => m.visible).map((m) => m.text);
  const all = texts.join(' \n ').toLowerCase();
  const has = (s: string) => all.includes(s.replace(/\s+/g, ' ').trim().toLowerCase());
  if (not !== undefined && has(not)) return `'${not}' is in ${scope} but should not be`;
  if (own !== undefined && !has(own)) return `'${own}' is not in ${scope}${texts.length ? ` (it says: '${clip(texts.sort((a, b) => b.length - a.length)[0] ?? '', 120)}')` : ' (it is not visible)'}`;
  return undefined;
}

/** within(role='dialog', name='Report a problem') · within('row:Ada') · within('.card') · within(): later steps act inside it. */
async function within(rc: RunCtx, step: Step): Promise<void> {
  const rec = rc.rec as { within?: string };
  const o = step.opts;
  let scope: string | undefined;
  if (step.args.length) scope = String(step.args[0]);
  else if (o.role !== undefined) scope = `${String(o.role).toLowerCase()}${o.name !== undefined ? `:${String(o.name)}` : ''}`;
  else if (o.css !== undefined) scope = `css=${String(o.css)}`;
  if (!scope) {
    rec.within = undefined;
    return void rc.note('steps act on the whole page again');
  }
  const r = await locate(rc, { within: scope, roots: true });
  if (r.noScope) throw new AwError('bad_request', r.noScope);
  rec.within = scope;
  rc.note(`later steps act inside ${scope} (within() ends it)`);
}

/**
 * The live node a step aims at, found by role/name/label/test id inside the current scope, for steps the
 * page view cannot place (a scope is set, or the control is named only by aria-label). Undefined: not found.
 */
export async function locateTarget(rc: RunCtx, step: Step, opts: { actionable?: boolean; must?: boolean } = {}): Promise<number | undefined> {
  const o = step.opts;
  const target = step.args.length && typeof step.args[0] === 'string' ? String(step.args[0]) : undefined;
  const spec = specOf(step, rc.rec as { within?: string }, target);
  if (target !== undefined && spec.role === undefined && spec.label === undefined && spec.testid === undefined && spec.css === undefined) {
    // a field is found by its label first, then anything with that name
    spec.actionable = true;
  }
  const end = Date.now() + (opts.must ? 5000 : 0);
  for (;;) {
    let r = await locate(rc, spec);
    let vis = r.matches.filter((m) => m.visible && !m.disabled);
    if (!vis.length && spec.actionable && target !== undefined) {
      // by its label (a field), or its visible text
      const r2 = await locate(rc, { label: target, within: spec.within, exact: spec.exact });
      const v2 = r2.matches.filter((m) => m.visible);
      if (v2.length) {
        r = r2;
        vis = v2;
      }
    }
    const nth = o.nth !== undefined ? Number(o.nth) : undefined;
    if (vis.length) {
      // the exact name wins over a longer one that contains it
      const exact = target !== undefined ? vis.filter((m) => m.name.trim().toLowerCase() === target.trim().toLowerCase()) : [];
      const pool = exact.length ? exact : vis;
      if (nth !== undefined) {
        if (!pool[nth - 1]) throw new AwError('bad_request', `there are only ${pool.length} ${what(spec)}`);
        return pool[nth - 1].n;
      }
      if (pool.length > 1 && opts.must) {
        const names = pool.slice(0, 5).map((m) => desc(m)).join(', ');
        throw new AwError('bad_request', `${pool.length} elements match ${what(spec)}: ${names}`, "add role=, in='…' or nth=N");
      }
      return pool[0].n;
    }
    if (!opts.must) return undefined;
    if (Date.now() >= end || rc.ctx.signal?.aborted) {
      if (r.noScope) throw new AwError('bad_request', r.noScope);
      const hiddenOnes = r.matches.filter((m) => !m.visible);
      throw new AwError('bad_request', hiddenOnes.length ? `${desc(hiddenOnes[0])} is on the page but not visible` : r.matches.some((m) => m.disabled) ? `${desc(r.matches[0])} is disabled` : `no ${what(spec)} on the page${r.near.length ? ` (${spec.role ?? 'elements'} here: ${r.near.slice(0, 6).map((x) => `'${clip(x.name, 40)}'`).join(', ')})` : ''}`);
    }
    await new Promise((res) => setTimeout(res, 200));
  }
}
