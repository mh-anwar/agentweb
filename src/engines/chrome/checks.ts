// The chrome side of src/checks: runs the page-side checks in the engine's isolated world and hands
// their JSON back. The verbs, the wording and the rules live in src/checks; this file only moves data.

import { pageChecks } from '../../checks/inpage.ts';
import { AwError } from '../../types.ts';
import type { PageDriver } from './page.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `expr` is a call on the checks object (`C.audit({...})`); the checks are installed fresh for the call and leave nothing behind. */
function inPage(call: string): string {
  return `(()=>{var __name=(f)=>f;const C=(${pageChecks.toString()})(self);return ${call}})()`;
}

/** A page's own layout needs a frame or two to follow a viewport change. */
export async function relayout(d: PageDriver): Promise<void> {
  await d
    .run('Promise.race([new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(1)))),new Promise(r=>setTimeout(r,300))])', { awaitPromise: true, timeoutMs: 2000 })
    .catch(() => {});
  await sleep(60);
}

export async function labelsOn(d: PageDriver, items: { n: number; num: number }[], region: { x: number; y: number; w: number; h: number }): Promise<number> {
  return d.run<number>(inPage(`C.label(${JSON.stringify(items)},${JSON.stringify(region)})`), { timeoutMs: 8000 });
}

export async function labelsOff(d: PageDriver): Promise<void> {
  await d.run(inPage('C.unlabel()'), { timeoutMs: 5000 }).catch(() => {});
}

/** axe-core, run in the isolated world: it reads the page's DOM and adds nothing to it. */
async function runAxe(d: PageDriver, source: string, o: { tags?: string[]; disable?: string[]; exclude?: string[] } = {}): Promise<unknown> {
  const contextId = await d.world();
  const send = (expression: string, awaitPromise = false) => d.s.send<any>('Runtime.evaluate', { expression, contextId, awaitPromise, returnByValue: true }, 60_000);
  const has = await send('typeof axe');
  if (has.result?.value !== 'object') {
    const r = await send(source + '\n;typeof axe');
    if (r.exceptionDetails || r.result?.value !== 'object') throw new AwError('internal', 'axe-core did not load in the page', 'check that the installed axe-core is a browser build (axe.min.js)');
  }
  const r = await send(
    `axe.run(${o.exclude?.length ? JSON.stringify({ exclude: o.exclude.map((x) => [x]) }) : 'document'},${JSON.stringify({
      resultTypes: ['violations'],
      ...(o.tags?.length ? { runOnly: { type: 'tag', values: o.tags } } : {}),
      ...(o.disable?.length ? { rules: Object.fromEntries(o.disable.map((id) => [id, { enabled: false }])) } : {}),
    })}).then(r=>JSON.stringify({version:axe.version,violations:r.violations.map(v=>({id:v.id,impact:v.impact,help:v.help,count:v.nodes.length,nodes:v.nodes.slice(0,2).map(n=>({target:(n.target||[]).join(' '),html:String(n.html||'').slice(0,100)}))}))}))`,
    true,
  );
  if (r.exceptionDetails) throw new AwError('internal', `axe-core failed: ${String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n')[0].slice(0, 200)}`);
  return JSON.parse(String(r.result?.value ?? '{}'));
}

export type CheckAction = { what: 'overflow' | 'audit' | 'problems' | 'imgdiff'; args?: Record<string, unknown> };

/** Run one check; the answer is JSON text (the engine's `Loaded.value`). */
export async function runCheck(d: PageDriver, a: CheckAction): Promise<string> {
  const args = a.args ?? {};
  switch (a.what) {
    case 'overflow':
      return JSON.stringify(await d.run(inPage(`C.overflow(${JSON.stringify({ clipped: !!args.clipped, max: args.max })})`), { timeoutMs: 20_000 }));
    case 'audit':
      if (typeof args.axe === 'string') return JSON.stringify(await runAxe(d, args.axe, args as { tags?: string[]; disable?: string[]; exclude?: string[] }));
      return JSON.stringify(await d.run(inPage(`C.audit(${JSON.stringify({ rules: args.rules ?? [] })})`), { timeoutMs: 30_000 }));
    case 'problems':
      return JSON.stringify({ doc: d.docSeq, url: d.url, problems: d.problems });
    case 'imgdiff':
      return JSON.stringify(await d.run(inPage(`C.imgdiff(${JSON.stringify(args.a)},${JSON.stringify(args.b)})`), { awaitPromise: true, timeoutMs: 30_000 }));
    default:
      throw new AwError('bad_request', `unknown check "${(a as { what: string }).what}"`);
  }
}
