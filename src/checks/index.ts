// Verb pack: checks that a test (or an agent) runs on the page in a real browser, each answering in a few lines.
//
//   overflow()                       horizontal overflow at the current viewport, worst offenders first
//   overflow(clipped=1)              also text cut off by its own box;  overflow(widths='375,768') at several widths
//   audit()  audit('contrast,names') built-in accessibility rules (not axe-core); audit(axe=1) runs axe-core if installed
//   shot(widths='375,768', save=1)   one screenshot per viewport width;  shot(annotate=1) with the view's element numbers
//   expect(overflow=0, audit=0, console=0, requests=0, allow='favicon')   the same checks as assertions
//
// They need Chromium: a page that was fetched without one is reopened there, with a note, the way emulate() does it.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { VERBS as DSL_VERBS, type Step } from '../dsl.ts';
import { needChrome, type RunCtx, type RuntimeImpl } from '../runtime.ts';
import { allActs } from '../session.ts';
import { AwError, type Act, type Emulation, type Loaded } from '../types.ts';
import type { Problem } from '../engines/chrome/page.ts';
import type { AuditReport, OverflowReport } from './inpage.ts';
import { auditLines, overflowLines, parseRules, violations } from './report.ts';
import { imageSize, parseWidths, shotLine } from './shots.ts';
import { recordVerb } from './record.ts';

const truthy = (v: unknown) => v !== undefined && v !== false && v !== 0 && !/^(0|no|false|off)$/i.test(String(v));

export function register(rt: RuntimeImpl): void {
  rt.register('overflow', overflow);
  rt.register('audit', audit);
  rt.register('record', recordVerb);
  // not for programs: the pieces expect() and shot() hand over to
  rt.register('expect_checks', expectChecks);
  rt.register('shot_more', shotMore);
  for (const v of ['expect_checks', 'shot_more']) DSL_VERBS.delete(v);
}

/** The compare step of `screenshot(...)` in test files. Registered by the test runner only: it reads files by path. */
export function registerImgdiff(rt: RuntimeImpl): void {
  if (rt.verbHandler('imgdiff')) return;
  rt.register('imgdiff', imgdiff);
}

// ───────────────────────────── plumbing ─────────────────────────────

/** Make sure the page is live in Chromium, and say so when that meant reopening it. */
export async function inChrome(rc: RunCtx, what: string): Promise<void> {
  const before = rc.rec.page?.tier;
  await needChrome(rc, what);
  if (before && before !== 'chrome') rc.note(`${what} needs a real browser: this page was reopened in chrome`);
}

async function probe(rc: RunCtx, what: 'overflow' | 'audit' | 'problems' | 'imgdiff', args?: Record<string, unknown>): Promise<any> {
  const res = await rc.live({ do: 'probe', what, args });
  try {
    return JSON.parse(res.value ?? 'null');
  } catch {
    throw new AwError('internal', `the page check ${what} returned nothing readable`);
  }
}

/** Live node id -> the page view's act, for numbering what the checks point at. */
function actsByNode(rc: RunCtx): Map<number, Act> {
  const m = new Map<number, Act>();
  for (const r of allActs(rc.page)) if (r.act.n !== undefined) m.set(r.act.n, r.act);
  return m;
}

/** Run `fn` with the viewport at each width in turn, then put it back exactly as it was. */
async function atWidths<T>(rc: RunCtx, widths: number[], fn: (w: number) => Promise<T>): Promise<T[]> {
  const saved: Emulation | undefined = rc.ctx.emulate;
  const out: T[] = [];
  try {
    for (const w of widths) {
      rc.ctx.emulate = { ...(saved ?? {}), width: w };
      out.push(await fn(w));
    }
  } finally {
    rc.ctx.emulate = saved;
    // applies the viewport the session had before; the page is read again at that width
    await rc.live({ do: 'wait', ms: 0 }).catch(() => rc.note('the viewport could not be put back; emulate() sets it again'));
  }
  return out;
}

function widthsOf(step: Step): number[] | undefined {
  if (step.opts.widths === undefined) return undefined;
  try {
    return parseWidths(step.opts.widths);
  } catch (e) {
    throw new AwError('bad_request', (e as Error).message, "widths='375,768,1280'");
  }
}

// ───────────────────────────── overflow ─────────────────────────────

async function overflowReport(rc: RunCtx, clipped: boolean): Promise<{ lines: string[]; r: OverflowReport }> {
  const r: OverflowReport = await probe(rc, 'overflow', { clipped });
  return { lines: overflowLines(r, actsByNode(rc), rc.refs).lines, r };
}

/** overflow() · overflow(clipped=1) · overflow(widths='375,768,1280') */
async function overflow(rc: RunCtx, step: Step): Promise<void> {
  await inChrome(rc, 'overflow()');
  await rc.ensureLive();
  const clipped = truthy(step.opts.clipped);
  const widths = widthsOf(step);
  const lines = widths ? (await atWidths(rc, widths, () => overflowReport(rc, clipped))).flatMap((x) => x.lines) : (await overflowReport(rc, clipped)).lines;
  rc.emit(lines.join('\n'));
}

// ───────────────────────────── audit ─────────────────────────────

function axeSource(): string {
  const req = createRequire(join(process.cwd(), 'agentweb-axe.cjs'));
  for (const name of ['axe-core/axe.min.js', 'axe-core']) {
    try {
      return readFileSync(req.resolve(name), 'utf8');
    } catch {}
  }
  throw new AwError('unsupported', 'axe-core is not installed here', `install it in the project folder (npm install --save-dev axe-core; agentweb looks for it from the folder it runs in), or use audit() for the built-in rules`);
}

interface AxeReport {
  version?: string;
  violations: { id: string; impact?: string; help: string; count: number; nodes: { target: string; html: string }[] }[];
}

export function axeLines(r: AxeReport): string[] {
  const v = r.violations;
  const head = `axe-core ${r.version ?? ''}`.trim();
  if (!v.length) return [`${head}: no violations`];
  const total = v.reduce((n, x) => n + x.count, 0);
  const lines = [`${head}: ${v.length} rules violated, ${total} elements`];
  const room = 11;
  for (const x of v.slice(0, v.length > room ? room - 1 : room)) lines.push(`${x.id} (${x.impact ?? '?'}) ×${x.count}: ${x.help}: ${x.nodes.map((n) => n.target).filter(Boolean).slice(0, 2).join(' · ')}${x.count > 2 ? ' …' : ''}`);
  if (v.length > room) lines.push(`… ${v.length - room + 1} more rules: ${v.slice(room - 1).map((x) => x.id).join(', ')}`);
  return lines;
}

/** audit() · audit('contrast,names') · audit(axe=1) */
async function audit(rc: RunCtx, step: Step): Promise<void> {
  const axe = truthy(step.opts.axe) ? axeSource() : undefined;
  const rules = axe ? [] : parseRules(step.args[0] ?? step.opts.rules);
  await inChrome(rc, 'audit()');
  await rc.ensureLive();
  if (axe) return void rc.emit(axeLines(await probe(rc, 'audit', { axe })).join('\n'));
  const r: AuditReport = await probe(rc, 'audit', { rules });
  rc.emit(auditLines(r, rules, actsByNode(rc), rc.refs).join('\n'));
}

// ───────────────────────────── expect(...) ─────────────────────────────

/** A tolerance: 0 / false / 'clean' mean none, a number is how many are let through. */
function tolerance(v: unknown): number {
  if (typeof v === 'number') return Math.max(0, v);
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

const oneLine = (s: string, n = 220) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Errors (and warnings, with console='warn') of this page, minus what `allow` lets through. */
export function problemLines(all: Problem[], o: { kind: 'console' | 'request'; warn?: boolean; allow: string[]; doc?: number; url: string }): { total: number; lines: string[] } {
  const allow = o.allow.map((a) => a.toLowerCase());
  const seen = new Map<string, { n: number; p: Problem }>();
  let total = 0;
  for (const p of all) {
    if (p.kind !== o.kind || (o.doc !== undefined && p.doc !== o.doc)) continue;
    if (p.level === 'warning' && !o.warn) continue;
    const hay = (p.text + ' ' + p.page).toLowerCase();
    if (allow.some((a) => hay.includes(a))) continue;
    total++;
    const key = `${o.doc === undefined ? p.page + ' ' : ''}${p.level} ${p.text}`;
    const e = seen.get(key);
    if (e) e.n++;
    else seen.set(key, { n: 1, p });
  }
  const origin = (() => {
    try {
      return new URL(o.url).origin;
    } catch {
      return '';
    }
  })();
  const lines = [...seen.values()].slice(0, 3).map(({ n, p }) => {
    const text = origin ? p.text.split(origin).join('') : p.text;
    const where = o.doc === undefined ? ` [${shortPath(p.page)}]` : '';
    const label = o.kind === 'request' ? '' : p.level === 'warning' ? 'warning: ' : 'error: ';
    return `${label}${oneLine(text)}${n > 1 ? ` (×${n})` : ''}${where}`;
  });
  if (seen.size > 3) lines.push(`… ${seen.size - 3} more kinds`);
  return { total, lines };
}

function shortPath(u: string): string {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
}

/** The checks of expect(): overflow=, no_overflow=, audit=, console=, requests= (with allow=, all=1). Throws when one fails. */
async function expectChecks(rc: RunCtx, step: Step): Promise<void> {
  const o = step.opts;
  const failed: string[] = [];
  const wantOverflow = o.overflow !== undefined ? tolerance(o.overflow) : o.no_overflow !== undefined && truthy(o.no_overflow) ? 0 : undefined;
  await inChrome(rc, 'this check');
  await rc.ensureLive();

  if (wantOverflow !== undefined) {
    const { lines, r } = await overflowReport(rc, false);
    const worst = Math.max(r.scrolls ? r.scrollW - r.vw : 0, ...r.hits.map((h) => h.by ?? 0));
    if (worst > wantOverflow) failed.push(...lines);
  }
  if (o.audit !== undefined) {
    const spec = typeof o.audit === 'string' && !/^\d+$/.test(o.audit) ? o.audit : undefined;
    const rules = parseRules(spec);
    const r: AuditReport = await probe(rc, 'audit', { rules });
    if (violations(r) > (spec ? 0 : tolerance(o.audit))) failed.push(...auditLines(r, rules, actsByNode(rc), rc.refs));
  }
  if (o.console !== undefined || o.requests !== undefined) {
    const { doc, url, problems } = await probe(rc, 'problems');
    const allow = String(o.allow ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const scope = truthy(o.all) ? undefined : doc;
    if (o.console !== undefined) {
      const warn = /^warn/i.test(String(o.console));
      const { total, lines } = problemLines(problems, { kind: 'console', warn, allow, doc: scope, url });
      if (total > (warn ? 0 : tolerance(o.console))) failed.push(`console has ${total} ${warn ? 'errors or warnings' : total === 1 ? 'error' : 'errors'} ${scope === undefined ? 'in this test' : 'since the page loaded'}:`, ...lines);
    }
    if (o.requests !== undefined) {
      const { total, lines } = problemLines(problems, { kind: 'request', allow, doc: scope, url });
      if (total > tolerance(o.requests)) failed.push(`${total} request${total === 1 ? '' : 's'} failed (4xx, 5xx or a network error) ${scope === undefined ? 'in this test' : 'since the page loaded'}:`, ...lines);
    }
  }
  if (failed.length) throw new AwError('bad_request', failed.join('\n  '));
}

// ───────────────────────────── screenshots ─────────────────────────────

/** Element numbers for shot(annotate=1): the numbers the text view shows, by live node. */
function labelsFor(rc: RunCtx): { n: number; num: number }[] {
  const out: { n: number; num: number }[] = [];
  for (const { act } of allActs(rc.page)) if (act.n !== undefined && out.length < 400) out.push({ n: act.n, num: rc.refs.of(act) });
  return out;
}

/** shot(widths='375,768', save=1, full=1) and shot(annotate=1): what `shot` hands over when it has one of these. */
async function shotMore(rc: RunCtx, step: Step): Promise<void> {
  const widths = widthsOf(step);
  await inChrome(rc, 'screenshots');
  await rc.ensureLive();
  const full = truthy(step.opts.full);
  const save = truthy(step.opts.save);
  const annotate = truthy(step.opts.annotate);
  if (!widths) {
    let target: number | undefined;
    if (typeof step.args[0] === 'number' || typeof step.args[0] === 'string') {
      const r = rc.resolve(step);
      if ('portable' in r) throw new AwError('bad_request', `${r.n} is from an earlier page`);
      target = r.act.n;
    }
    const res = await rc.live({ do: 'shot', full, n: target, save, labels: annotate ? labelsFor(rc) : undefined });
    if (res.value) rc.note(res.value);
    rc.note('screenshot attached' + (annotate ? ' (element numbers drawn on it)' : ''));
    return;
  }
  const lines = await atWidths(rc, widths, async (w) => {
    const res: Loaded = await rc.live({ do: 'shot', full, save, w, quiet: save, labels: annotate ? labelsFor(rc) : undefined });
    if (save) {
      const m = /^saved screenshot: (.+) \((\d+) bytes\)$/.exec(res.value ?? '');
      if (!m) throw new AwError('internal', `the screenshot at ${w} px was not saved: ${res.value ?? 'no answer'}`);
      return shotLine(w, m[1], imageSize(readFileSync(m[1])), Number(m[2]));
    }
    const bytes = Buffer.from(res.image?.data ?? '', 'base64');
    return shotLine(w, 'screenshot attached', imageSize(bytes), bytes.length);
  });
  rc.emit(lines.join('\n'));
}

/** imgdiff('a.jpg', 'b.jpg'): the share of pixels that differ, as JSON, measured in the browser. */
async function imgdiff(rc: RunCtx, step: Step): Promise<void> {
  const [a, b] = step.args.slice(0, 2).map((p) => readFileSync(String(p)).toString('base64'));
  await inChrome(rc, 'comparing screenshots');
  await rc.ensureLive();
  const r = await probe(rc, 'imgdiff', { a, b });
  rc.emit(JSON.stringify(r));
}
