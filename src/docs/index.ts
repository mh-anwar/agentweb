// Verb pack: cheap documentation reading.
//
//   read(url, outline=1)     only the heading outline, each heading with its section's size, so the agent
//                            can then read('Section name') instead of the whole page
//   outline()                the same outline for the current page (sizes added to the existing verb)
//   read('llms')             open this site's /llms.txt (read('llms-full') the /llms-full.txt)
//   open / read(url)         on a documentation page, one note says the site publishes /llms.txt;
//                            learned once per origin (a single probe, remembered a week), not per page
//
// The existing open/read/outline handlers do the real work; these wrap them.

import { blockText } from '../blocks.ts';
import { renderRead } from '../render.ts';
import type { RunCtx, RuntimeImpl } from '../runtime.ts';
import { normalizeUrl } from '../runtime.ts';
import type { Step } from '../dsl.ts';
import { estimateTokens } from '../tokens.ts';
import { AwError, type Loaded, type Page } from '../types.ts';

const str = (a: unknown) => (a === undefined || a === null ? '' : String(a));
const truthy = (v: unknown) => v !== undefined && v !== false && v !== 0 && !/^(0|false|no|off)$/i.test(String(v));
const isUrl = (s: string) => /^[a-z]+:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(s);
const LLMS = /^llms(-full)?(\.txt)?$/i;

export const LLMS_NS = 'llms';
const WEEK = 7 * 86400;
const HOUR = 3600;

export function register(rt: RuntimeImpl): void {
  const open = rt.verbHandler('open');
  const read = rt.verbHandler('read');
  if (open) {
    rt.register('open', async (rc, step) => {
      await open(rc, step);
      await llmsNote(rc);
    });
  }
  if (read) rt.register('read', (rc, step) => readVerb(rc, step, read));
  rt.register('outline', async (rc) => {
    rc.emit(renderSizedOutline(rc.page, rc.remaining));
  });
}

// ───────────────────────────── outline with sizes ─────────────────────────────

const CONTENT = new Set(['main', 'other', 'dialog']);
const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

export interface Section {
  text: string;
  level: number;
  /** tokens of the section's own text and its subsections */
  tokens: number;
}

/** Headings in page order, each with the size of what `read('Heading')` would show under it. */
export function sections(page: Page): { intro: number; list: Section[]; total: number } {
  const bl = page.blocks;
  const sizes = bl.map((b) => (b.k !== 'h' && CONTENT.has(b.r) ? estimateTokens(blockText(b)) + 1 : 0));
  const list: Section[] = [];
  let intro = 0;
  let first = -1;
  for (let i = 0; i < bl.length; i++) {
    const b = bl[i];
    if (b.k !== 'h') continue;
    const text = blockText(b).trim();
    if (!text) continue;
    if (first < 0) first = i;
    const lv = b.lv ?? 1;
    let tokens = 0;
    for (let j = i + 1; j < bl.length; j++) {
      if (bl[j].k === 'h' && (bl[j].lv ?? 1) <= lv) break;
      tokens += sizes[j];
    }
    list.push({ text: text.length > 80 ? text.slice(0, 79) + '…' : text, level: lv, tokens });
  }
  for (let i = 0; i < (first < 0 ? bl.length : first); i++) intro += sizes[i];
  return { intro, list, total: sizes.reduce((a, b) => a + b, 0) };
}

function header(page: Page): string {
  let title = page.title || '(untitled)';
  if (title.length > 90) title = title.slice(0, 89) + '…';
  const tags: string[] = [];
  if (page.tier !== 'wire') tags.push(page.tier);
  if (page.status >= 400 || page.status === 0) tags.push('HTTP ' + page.status);
  if (page.kind !== 'html') tags.push(page.kind);
  return `${title} — ${page.url.length > 220 ? page.url.slice(0, 219) + '…' : page.url}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
}

/** The outline within `budget` tokens: when it does not fit, the deepest headings are dropped first. */
export function renderSizedOutline(page: Page, budget: number): string {
  const { intro, list, total } = sections(page);
  const head = header(page);
  if (!list.length) return `${head}\n(no headings; ${fmtTokens(total)} tokens of content: read() shows it)`;
  const min = Math.min(...list.map((s) => s.level));
  const line = (s: Section) => `${'  '.repeat(Math.min(5, s.level - min))}${s.text} (${fmtTokens(s.tokens)} tok)`;
  const room = Math.max(160, budget) - 60;
  let depth = Math.max(...list.map((s) => s.level));
  let shown = list.filter((s) => s.level <= depth);
  while (depth > min && estimateTokens(shown.map(line).join('\n')) > room) shown = list.filter((s) => s.level <= --depth);
  const out = [head, `${fmtTokens(total)} tokens in all${intro ? `, ${fmtTokens(intro)} before the first heading` : ''}; read('Heading') reads one section`];
  let left = room;
  let cut = 0;
  for (const s of shown) {
    const l = line(s);
    const cost = estimateTokens(l) + 1;
    if (cost > left) {
      cut++;
      continue;
    }
    left -= cost;
    out.push(l);
  }
  if (list.length > shown.length - cut) out.push(`(+${list.length - (shown.length - cut)} deeper or later headings not shown; raise budget, or read('Heading') then outline())`);
  return out.join('\n');
}

// ───────────────────────────── read ─────────────────────────────

async function readVerb(rc: RunCtx, step: Step, read: (rc: RunCtx, step: Step) => Promise<void>): Promise<void> {
  const arg = str(step.args[0]).trim();
  const wantsOutline = truthy(step.opts.outline);

  if (arg && LLMS.test(arg) && !hasHeading(rc, arg)) return readLlms(rc, arg);

  if (wantsOutline) {
    if (arg && !isUrl(arg)) throw new AwError('bad_request', "outline=1 goes with an address or nothing: read('docs.example.com/guide', outline=1) or read(outline=1)", `then read('${arg.replace(/'/g, "\\'")}') reads that section`);
    if (arg) {
      const url = normalizeUrl(arg, rc.rec.page?.url);
      const u = new URL(url);
      rc.outflow(u.pathname + u.search, u.origin);
      await rc.navigate({ url, read: true });
    }
    rc.emit(renderSizedOutline(rc.page, rc.remaining));
    if (arg) await llmsNote(rc);
    return;
  }

  await read(rc, step);
  if (arg && isUrl(arg)) await llmsNote(rc);
}

const hasHeading = (rc: RunCtx, text: string) => !!rc.rec.page?.blocks.some((b) => b.k === 'h' && blockText(b).trim().toLowerCase() === text.toLowerCase());

// ───────────────────────────── llms.txt ─────────────────────────────

interface Fact {
  txt: boolean;
  full: boolean;
  at: number;
}

/** Documentation sites, by host or path: the only pages worth a probe for /llms.txt. */
export function looksLikeDocs(url: string, page?: Page): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (page?.kind === 'markdown') return true;
  return /^(docs?|developers?|dev|api|help|support|learn|wiki|guide|guides|reference|manual|handbook)\./i.test(u.hostname) || /\/(docs?|documentation|guides?|reference|api|manual|learn|tutorials?|help|handbook|wiki)(\/|$)/i.test(u.pathname);
}

function looksLikeLlms(l: Loaded): boolean {
  if (l.status !== 200 || l.doc) return false;
  const text = l.body?.text;
  if (!text || !text.trim() || /^\s*</.test(text)) return false;
  return /^(text\/plain|text\/markdown|text\/x-markdown|application\/markdown)$/.test(l.contentType);
}

async function probeFile(rc: RunCtx, origin: string, file: string): Promise<boolean> {
  const url = `${origin}/${file}`;
  try {
    const v = await rc.guard.checkStep({ verb: 'open', origin, dest: url, method: 'GET' });
    if (!v.ok) return false;
    // no session cookies: this is a question about the site, not a visit
    const loaded = await rc.engine('wire').open({ ...rc.ctx, jar: rc.rt.deps.createJar([]), timeoutMs: 3000 }, { url, read: true });
    return looksLikeLlms(loaded);
  } catch {
    if (rc.ctx.signal?.aborted) throw new AwError('timeout', 'the run was cancelled or timed out');
    return false;
  }
}

async function llmsNote(rc: RunCtx): Promise<void> {
  const p = rc.rec.page;
  // learning is the atlas's job: with the atlas off (AGENTWEB_ATLAS=0) agentweb makes no extra requests
  if (!p || !/^https?:/.test(p.url) || !rc.rt.deps.atlas || !looksLikeDocs(p.url, p) || /\/llms(-full)?\.txt$/.test(new URL(p.url).pathname)) return;
  const store = rc.rt.deps.store;
  const origin = new URL(p.url).origin;
  let fact = await store.get<Fact>(LLMS_NS, origin).catch(() => undefined);
  if (!fact) {
    const [txt, full] = await Promise.all([probeFile(rc, origin, 'llms.txt'), probeFile(rc, origin, 'llms-full.txt')]);
    fact = { txt, full, at: Date.now() };
    await store.set(LLMS_NS, origin, fact, txt || full ? WEEK : HOUR).catch(() => {});
  }
  if (!fact.txt && !fact.full) return;
  // once per session and site: a docs session opens many pages
  const told = `told:${rc.rec.id}|${origin}`;
  if (await store.get(LLMS_NS, told).catch(() => undefined)) return;
  await store.set(LLMS_NS, told, 1, HOUR).catch(() => {});
  rc.note(`this site publishes ${[fact.txt && '/llms.txt', fact.full && '/llms-full.txt'].filter(Boolean).join(' and ')} (a text index for agents): read('llms') opens it${fact.full ? ", read('llms-full') the whole of it" : ''}`);
}

async function readLlms(rc: RunCtx, arg: string): Promise<void> {
  const p = rc.rec.page;
  if (!p || !/^https?:/.test(p.url)) throw new AwError('bad_request', 'read(\'llms\') needs a site: open a page first', "or read('docs.example.com/llms.txt')");
  const origin = new URL(p.url).origin;
  const file = /full/i.test(arg) ? 'llms-full.txt' : 'llms.txt';
  if (!(await probeFile(rc, origin, file))) {
    // remember the answer so the note is not offered again
    const store = rc.rt.deps.store;
    const fact = (await store.get<Fact>(LLMS_NS, origin).catch(() => undefined)) ?? { txt: false, full: false, at: Date.now() };
    if (file === 'llms.txt') fact.txt = false;
    else fact.full = false;
    await store.set(LLMS_NS, origin, fact, fact.txt || fact.full ? WEEK : HOUR).catch(() => {});
    throw new AwError('bad_request', `${origin} has no /${file}`, 'find() and outline() work on the page itself; map() lists the site\'s URLs');
  }
  const url = `${origin}/${file}`;
  rc.outflow('/' + file, origin);
  await rc.navigate({ url, read: true });
  rc.emit(renderRead(rc.page, rc.rec.view, rc.refs, { budget: rc.remaining, from: 0 }).text);
}
