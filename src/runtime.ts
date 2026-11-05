// The runtime: runs a program against a session.
//
//   load session record -> run steps (each on the cheapest engine that works) -> render one
//   bounded view of where the agent ended up -> save session record
//
// Rules the runtime enforces:
//   - A failed step is still an observation: the run stops there and the current page is shown.
//   - A POST is never replayed. Moving a page to a heavier engine happens only by re-opening a page
//     that was reached with GET; otherwise the step fails loudly.
//   - Nothing reaches the model that the guard has not redacted, and everything shown is recorded
//     with the guard for data-flow checks.

import { blockText } from './blocks.ts';
import { compile } from './compile.ts';
import { parseProgram, type Arg, type Step } from './dsl.ts';
import { renderFind, renderLinks, renderOutline, renderRead, renderView, sectionRange } from './render.ts';
import { actByFp, allActs, loadSession, rehash, resolveTarget, saveSession, SessionRefs, type Resolved, type SessionRecord } from './session.ts';
import { estimateTokens } from './tokens.ts';
import { TOOL } from './tooldoc.ts';
import {
  AwError,
  type Act,
  type Action,
  type Atlas,
  type Block,
  type CookieData,
  type CookieJar,
  type Doc,
  type Engine,
  type Fetcher,
  type Field,
  type FormDef,
  type Guard,
  type Loaded,
  type NavRequest,
  type Page,
  type ReadInput,
  type ReadOutput,
  type Region,
  type RunEvent,
  type RunOptions,
  type RunResult,
  type Runtime,
  type SearchResult,
  type SessionCtx,
  type Store,
  type Tier,
  type ToolSpec,
} from './types.ts';

export interface RuntimeDeps {
  store: Store;
  /** `wire` is required; `ghost` and `chrome` are used when present and available */
  engines: Partial<Record<Tier, Engine>> & { wire: Engine };
  createJar(data?: CookieData[]): CookieJar;
  createGuard(state: unknown, sessionId: string): Guard;
  encodeForm(form: FormDef, submitter?: Field): { url: string; method: 'GET' | 'POST'; body?: string | Uint8Array; contentType?: string };
  readBody?(input: ReadInput): Promise<ReadOutput>;
  mineEmbedded?(doc: Doc, url: string): ReadOutput | undefined;
  search?(q: string, o: { n: number; fetch: Fetcher }): Promise<{ results: SearchResult[]; used: string[]; failed: { name: string; why: string }[] }>;
  searchBlocks?(results: SearchResult[], q: string): Block[];
  atlas?: Atlas;
  options?: RuntimeOptions;
}

export interface RuntimeOptions {
  /** default output budget per call, in tokens */
  budget?: number;
  /** per engine call */
  timeoutMs?: number;
  /** whole run */
  runTimeoutMs?: number;
  userAgent?: string;
  sessionTtlSec?: number;
}

export type VerbHandler = (rc: RunCtx, step: Step) => Promise<void>;

const TIERS: Tier[] = ['wire', 'ghost', 'chrome'];
const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 agentweb/0.1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lc = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

export function normalizeUrl(input: string, base?: string): string {
  const s = input.trim().replace(/^<|>$/g, '');
  if (!s) throw new AwError('bad_request', 'open needs a URL');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return 'https:' + s;
  if (/^[/?#.]/.test(s) && !/^\.\w/.test(s)) {
    if (!base || !/^https?:/.test(base)) throw new AwError('bad_request', `'${s}' is a relative URL and no page is open`);
    return new URL(s, base).href;
  }
  if (/^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
  return 'https://' + s;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** One run of one program. Extension verbs receive this. */
export class RunCtx {
  rt: RuntimeImpl;
  rec: SessionRecord;
  refs: SessionRefs;
  jar: CookieJar;
  guard: Guard;
  ctx: SessionCtx;
  budget: number;
  used = 0;
  out: string[] = [];
  images: { mime: string; data: string }[] = [];
  notes: string[] = [];
  fetches = 0;
  /** the page changed (or was never shown) since the agent last saw something of it */
  stale = true;
  /** the page as the agent last saw it, for "what changed" */
  baseline?: { blocks: { hx: string; r: Region; i: string[] }[] };

  constructor(rt: RuntimeImpl, rec: SessionRecord, budget: number, signal?: AbortSignal) {
    this.rt = rt;
    this.rec = rec;
    this.refs = new SessionRefs(rec.refs);
    this.jar = rt.deps.createJar(rec.cookies);
    this.guard = rt.deps.createGuard(rec.guard, rec.id);
    this.budget = budget;
    this.ctx = {
      id: rec.id,
      jar: this.jar,
      storage: rec.storage,
      userAgent: rt.opts.userAgent,
      guard: this.guard,
      timeoutMs: rt.opts.timeoutMs,
      signal,
      url: rec.page?.url,
    };
    if (rec.page) this.baseline = { blocks: rec.page.blocks.map((b) => ({ hx: b.hx, r: b.r, i: [blockText(b)] })) };
  }

  get page(): Page {
    if (!this.rec.page) throw new AwError('bad_request', 'no page is open', "start with open('url') or search('query')");
    return this.rec.page;
  }
  get remaining(): number {
    return Math.max(160, this.budget - this.used);
  }
  note(s: string) {
    if (!this.notes.includes(s)) this.notes.push(s);
  }

  /** Show text to the agent: redacted, counted against the budget, recorded for data-flow tracking. */
  emit(text: string) {
    const safe = this.guard.redact(text);
    this.out.push(safe);
    this.used += estimateTokens(safe) + 1;
    const p = this.rec.page;
    if (p && /^https?:/.test(p.url)) this.guard.observe(originOf(p.url), safe, this.jar.has(p.url));
    this.stale = false;
  }

  // ── engines ──

  isLive(): boolean {
    const p = this.rec.page;
    return !!p && p.tier !== 'wire';
  }

  engine(tier: Tier): Engine {
    const e = this.rt.deps.engines[tier];
    if (!e) throw new AwError('unsupported', `the ${tier} engine is not configured`);
    return e;
  }

  async toPage(loaded: Loaded, tier: Tier): Promise<Page> {
    let page: Page;
    if (loaded.doc) {
      page = compile(loaded.doc, loaded.url, { tier, status: loaded.status, method: loaded.method, bytes: loaded.bytes, ms: loaded.ms });
    } else {
      const input: ReadInput = { url: loaded.url, contentType: loaded.contentType, text: loaded.body?.text, bytes: loaded.body?.bytes };
      let read: ReadOutput;
      if (this.rt.deps.readBody) read = await this.rt.deps.readBody(input);
      else read = { title: '', kind: 'text', blocks: [], notes: [`${loaded.contentType || 'unknown type'}, ${loaded.bytes} bytes: no reader configured`] };
      page = pageFromRead(read, loaded, tier);
    }
    if (loaded.events) for (const e of loaded.events.slice(0, 6)) page.notes.push(e);
    if (loaded.cached) page.notes.push('from shared cache');
    return page;
  }

  setPage(page: Page, o?: { push?: boolean }) {
    const old = this.rec.page;
    if (o?.push !== false && old && old.method === 'GET' && old.url !== page.url) {
      this.rec.history.push(old.url);
      if (this.rec.history.length > 30) this.rec.history.shift();
    }
    // secrets typed into script-engine pages come back in extracted values: never keep them
    for (const b of page.blocks) for (const x of b.i) if (typeof x !== 'string' && x.val) x.val = this.guard.redact(x.val);
    this.rec.page = page;
    this.rec.dirty = undefined;
    this.rec.lastField = undefined;
    this.rec.view.cursor = undefined;
    this.ctx.url = page.url;
    this.stale = true;
  }

  async pickTier(url: string): Promise<Tier> {
    if (this.rec.engine && (await this.rt.available(this.rec.engine))) return this.rec.engine;
    const hint = await this.rt.deps.atlas?.site(originOf(url)).catch(() => undefined);
    if (hint?.tier && (hint.tierConf ?? 0) >= 0.6 && (await this.rt.available(hint.tier))) return hint.tier;
    return 'wire';
  }

  async nextTier(t: Tier): Promise<Tier | undefined> {
    for (let i = TIERS.indexOf(t) + 1; i < TIERS.length; i++) if (await this.rt.available(TIERS[i])) return TIERS[i];
    return undefined;
  }

  /** Load a URL on the cheapest engine that works, escalating only for GET. */
  async navigate(req: NavRequest, o?: { tier?: Tier; push?: boolean }): Promise<void> {
    const method = req.method ?? 'GET';
    const v = await this.guard.checkStep({ verb: 'open', origin: this.rec.page ? originOf(this.rec.page.url) : undefined, dest: req.url, method });
    if (!v.ok) throw new AwError('policy', v.reason);
    if (v.warn) this.note(v.warn);
    let tier = o?.tier ?? (method === 'GET' ? await this.pickTier(req.url) : 'wire');
    const pinned = !!o?.tier || !!this.rec.engine;
    const before = this.rec.page?.tier;
    let page: Page;
    for (;;) {
      const loaded = await this.engine(tier).open(this.ctx, req);
      this.fetches++;
      page = await this.toPage(loaded, tier);
      const failed = !!page.shell || !!loaded.escalate;
      this.rt.deps.atlas?.observe({ type: 'load', origin: originOf(loaded.url), url: loaded.url, tier, ok: !failed, shell: !!page.shell, ms: loaded.ms });
      if (!failed) break;
      const why = loaded.escalate ?? 'the page is an empty shell that needs JavaScript';
      const up = method === 'GET' && !pinned ? await this.nextTier(tier) : undefined;
      if (up) {
        this.rt.count('escalations');
        tier = up;
        continue;
      }
      // nowhere heavier to go: recover what the HTML itself carries, and say so
      if (page.shell && loaded.doc && this.rt.deps.mineEmbedded) {
        const mined = this.rt.deps.mineEmbedded(loaded.doc, loaded.url);
        if (mined && mined.blocks.length) {
          page = pageFromRead(mined, loaded, tier);
          page.notes.push('shown from data embedded in the page; no JavaScript was run, so controls are not available');
          break;
        }
      }
      page.notes.push(tier === 'wire' && !(await this.nextTier('wire')) ? `${why}; no script engine is available (install Chrome or set AGENTWEB_CHROME)` : why);
      break;
    }
    if (before && before !== 'wire' && before !== tier) await this.engine(before).release(this.rec.id).catch(() => {});
    if (loaded_meta(page) && this.rt.deps.atlas) {
      this.rt.deps.atlas.observe({ type: 'forms', origin: originOf(page.url), url: page.url, forms: page.forms });
      this.rt.deps.atlas.observe({ type: 'meta', origin: originOf(page.url), url: page.url, links: page.meta?.links ?? [], markdown: page.kind === 'markdown' });
    }
    this.setPage(page, { push: o?.push });
  }

  /** Make sure the script engine really holds this session's page (it may have been evicted). */
  async ensureLive(): Promise<void> {
    const p = this.page;
    if (p.tier === 'wire') return;
    const eng = this.engine(p.tier);
    if (eng.live?.(this.rec.id)) return;
    this.ctx.url = p.url;
    const loaded = eng.snapshot ? await eng.snapshot(this.ctx) : await eng.open(this.ctx, { url: p.url });
    this.fetches++;
    this.setPage(await this.toPage(loaded, p.tier), { push: false });
  }

  async live(action: Action): Promise<Loaded> {
    const p = this.page;
    const eng = this.engine(p.tier);
    if (!eng.act) throw new AwError('unsupported', `the ${p.tier} engine cannot act on pages`);
    const loaded = await eng.act(this.ctx, action);
    if (loaded.image) this.images.push(loaded.image);
    if (loaded.doc || loaded.body) this.setPage(await this.toPage(loaded, p.tier));
    return loaded;
  }

  /** Act on a target in a script engine, re-resolving once if the page changed under us. */
  async liveOn(step: Step, build: (n: number, act: Act) => Action): Promise<void> {
    await this.ensureLive();
    for (let attempt = 0; ; attempt++) {
      const r = this.resolve(step);
      if ('portable' in r) return this.navigate({ url: r.portable.href!, referer: this.page.url });
      if (r.act.dis) throw new AwError('bad_request', `[${r.act.l}] is disabled`);
      try {
        if (r.act.n === undefined) throw new AwError('stale', 'no live node');
        await this.live(build(r.act.n, r.act));
        return;
      } catch (e) {
        if (e instanceof AwError && e.code === 'stale' && attempt === 0) {
          const eng = this.engine(this.page.tier);
          const loaded = await eng.snapshot!(this.ctx);
          this.setPage(await this.toPage(loaded, this.page.tier), { push: false });
          continue;
        }
        throw e;
      }
    }
  }

  resolve(step: Step, verb?: string): Resolved | { portable: { href?: string; l: string }; n: number } {
    if (!step.args.length) throw new AwError('bad_request', `${step.verb} needs a target: a number from the page or the visible text`);
    const near = step.opts.near !== undefined ? String(step.opts.near) : step.verb === 'click' && typeof step.args[1] === 'string' ? String(step.args[1]) : undefined;
    const nth = typeof step.opts.nth === 'number' ? step.opts.nth : typeof step.opts.index === 'number' ? step.opts.index : undefined;
    // a step re-aimed after an engine change carries the control's fingerprint
    if (typeof step.opts._fp === 'string') {
      const r = actByFp(this.page, step.opts._fp);
      if (r) return r;
    }
    return resolveTarget(this.page, this.refs, step.args[0], { verb: verb ?? step.verb, near, nth });
  }

  /**
   * A control that needs scripting was used on a wire-tier page: re-open the page in a script
   * engine and carry over what the agent already filled in. Only for pages reached by GET.
   */
  async escalate(reason: string): Promise<void> {
    const p = this.page;
    if (p.tier !== 'wire') return;
    const up = await this.nextTier('wire');
    if (!up) throw new AwError('unsupported', `${reason}, and no script engine is available`, 'install Chrome or set AGENTWEB_CHROME to enable the browser engine');
    if (p.method !== 'GET') throw new AwError('unsupported', `${reason}, but this page is the result of a form POST and cannot be re-opened safely`, "go back to the form with engine('" + up + "') set, then repeat the steps");
    const dirty = this.rec.dirty ?? {};
    await this.navigate({ url: p.url }, { tier: up, push: false });
    this.rt.count('escalations');
    for (const [fp, value] of Object.entries(dirty)) {
      const r = actByFp(this.page, fp);
      if (!r || r.act.n === undefined) continue;
      const action: Action = r.act.k === 'select' ? { do: 'select', n: r.act.n, value } : r.act.k === 'check' || r.act.k === 'radio' ? { do: 'check', n: r.act.n, on: value === '1' } : { do: 'fill', n: r.act.n, value: this.guard.reveal(value, originOf(this.page.url)) };
      await this.live(action).catch(() => {});
    }
    this.note(`page re-opened with the ${up} engine because ${reason}`);
  }

  outflow(text: string, dest: string) {
    if (!text || !dest) return;
    const v = this.guard.checkOutflow(text, dest);
    if (!v.ok) throw new AwError('policy', v.reason);
    if (v.warn) this.note(v.warn);
  }

  async submitForm(formIx: number, submitter?: Act): Promise<void> {
    const page = this.page;
    const form = page.forms[formIx];
    if (!form) throw new AwError('bad_request', 'that form is gone from the page');
    let action = form.action;
    let method = form.method;
    if (submitter?.href) action = submitter.href;
    if (submitter?.type === 'POST' || submitter?.type === 'GET') method = submitter.type;
    const dest = originOf(action);
    const fields = form.fields.map((f) => (f.value.includes('{{secret:') ? { ...f, value: this.guard.reveal(f.value, dest) } : f));
    const sub = submitter && submitter.fi !== undefined ? fields[submitter.fi] : fields.find((f) => f.type === 'submit');
    const req = this.rt.deps.encodeForm({ ...form, action, method, fields }, sub);
    const v = await this.guard.checkStep({ verb: 'submit', origin: originOf(page.url), dest: req.url, method: req.method, label: submitter?.l ?? sub?.label ?? 'submit' });
    if (!v.ok) throw new AwError('policy', v.reason);
    if (v.warn) this.note(v.warn);
    const beforeUrl = page.url;
    const beforeHashes = page.blocks.map((b) => b.hx).join(',');
    await this.navigate({ url: req.url, method: req.method, body: req.body, contentType: req.contentType, referer: page.url }, { tier: 'wire' });
    const now = this.page;
    if (now.url === beforeUrl && now.blocks.map((b) => b.hx).join(',') === beforeHashes) {
      this.note("the page did not change after submitting: the form may be handled by JavaScript (engine('ghost') re-opens the page with scripts)");
    }
    this.rt.count('submits');
  }
}

/** true for real web pages (not search results or other synthetic pages) */
function loaded_meta(page: Page): boolean {
  return /^https?:/.test(page.url) && page.kind === 'html';
}

function pageFromRead(read: ReadOutput, loaded: Loaded, tier: Tier): Page {
  let words = 0;
  let acts = 0;
  for (const b of read.blocks) {
    words += blockText(b).split(' ').length;
    for (const x of b.i) if (typeof x !== 'string') acts++;
  }
  return {
    url: loaded.url,
    status: loaded.status,
    title: read.title,
    tier,
    kind: read.kind,
    method: loaded.method,
    blocks: read.blocks,
    forms: [],
    notes: [...(read.notes ?? [])],
    stats: { bytes: loaded.bytes, ms: loaded.ms, hidden: 0, scripts: 0, words, acts },
  };
}

// ───────────────────────────── verbs ─────────────────────────────

const str = (a: Arg | undefined) => (a === undefined ? '' : String(a));

function displayValue(v: string, type?: string): string {
  if (!v) return '';
  if (type === 'password' && !v.includes('{{secret:')) return '••••';
  return v.length > 60 ? v.slice(0, 59) + '…' : v;
}

function fieldOf(page: Page, a: Act): Field | undefined {
  return a.form !== undefined && a.fi !== undefined ? page.forms[a.form]?.fields[a.fi] : undefined;
}

const VERBS: Record<string, VerbHandler> = {
  async open(rc, step) {
    const url = normalizeUrl(str(step.args[0]), rc.rec.page?.url);
    const u = new URL(url);
    rc.outflow(u.pathname + u.search + u.hash, u.origin);
    await rc.navigate({ url });
  },

  async back(rc) {
    if (rc.isLive()) return void (await rc.ensureLive(), await rc.live({ do: 'back' }));
    const url = rc.rec.history.pop();
    if (!url) throw new AwError('bad_request', 'there is no earlier page in this session');
    if (url.startsWith('search:')) return VERBS.search(rc, { verb: 'search', args: [url.slice(7)], opts: {}, src: 'back()' });
    await rc.navigate({ url }, { push: false });
  },

  async reload(rc) {
    const p = rc.page;
    if (!/^https?:/.test(p.url)) throw new AwError('bad_request', 'this page cannot be reloaded');
    await rc.navigate({ url: p.url }, { tier: p.tier, push: false });
  },

  async search(rc, step) {
    const q = str(step.args[0]);
    if (!q) throw new AwError('bad_request', "search needs a query: search('words')");
    const { search, searchBlocks } = rc.rt.deps;
    if (!search || !searchBlocks) throw new AwError('unsupported', 'web search is not configured');
    const fetch: Fetcher = (req) => {
      rc.fetches++;
      return rc.rt.deps.engines.wire.open(rc.ctx, req);
    };
    const res = await search(q, { n: typeof step.opts.n === 'number' ? step.opts.n : 8, fetch });
    const page: Page = {
      url: 'search:' + q,
      status: 200,
      title: `Search: ${q}`,
      tier: 'wire',
      kind: 'html',
      method: 'GET',
      blocks: searchBlocks(res.results, q),
      forms: [],
      notes: [],
      stats: { bytes: 0, ms: 0, hidden: 0, scripts: 0, words: 0, acts: res.results.length },
    };
    if (!res.results.length) page.notes.push('no results' + (res.failed.length ? ': ' + res.failed.map((f) => `${f.name} ${f.why}`).join('; ') : ''));
    rc.setPage(page);
  },

  async view(rc, step) {
    const region = step.args.length ? (lc(str(step.args[0])) as Region) : undefined;
    const r = renderView(rc.page, rc.rec.view, rc.refs, { budget: rc.remaining, full: true, region });
    rc.emit(r.text);
  },

  async read(rc, step) {
    const arg = step.args.length ? str(step.args[0]) : '';
    const links = step.opts.links === true || step.opts.links === 'true';
    if (arg && (/^[a-z]+:\/\//i.test(arg) || /^[\w-]+(\.[\w-]+)+(\/|$)/.test(arg))) {
      const url = normalizeUrl(arg, rc.rec.page?.url);
      const u = new URL(url);
      rc.outflow(u.pathname + u.search, u.origin);
      await rc.navigate({ url, read: true });
      rc.emit(renderRead(rc.page, rc.rec.view, rc.refs, { budget: rc.remaining, from: 0, links }).text);
      return;
    }
    if (arg) {
      const range = sectionRange(rc.page, arg);
      if (!range) throw new AwError('bad_request', `no section called '${arg}'`, renderOutline(rc.page).text);
      rc.emit(renderRead(rc.page, rc.rec.view, rc.refs, { budget: rc.remaining, from: range.from, to: range.to, links }).text);
      return;
    }
    rc.emit(renderRead(rc.page, rc.rec.view, rc.refs, { budget: rc.remaining, links }).text);
  },

  async find(rc, step) {
    const q = str(step.args[0]);
    if (!q) throw new AwError('bad_request', "find needs words: find('refund policy')");
    rc.emit(renderFind(rc.page, rc.rec.view, rc.refs, q, rc.remaining).text);
  },

  async links(rc, step) {
    rc.emit(renderLinks(rc.page, rc.refs, step.args.length ? str(step.args[0]) : undefined, rc.remaining).text);
  },

  async outline(rc) {
    rc.emit(renderOutline(rc.page).text);
  },

  async expect(rc, step) {
    const want = str(step.args[step.args.length - 1]);
    if (!want) throw new AwError('bad_request', "expect needs text: expect('Order placed')");
    const needle = lc(want);
    const p = rc.page;
    if (lc(p.title).includes(needle) || lc(p.url).includes(needle)) return;
    for (const b of p.blocks) if (lc(blockText(b)).includes(needle)) return;
    throw new AwError('bad_request', `'${want}' is not on the page`);
  },

  async click(rc, step) {
    if (rc.isLive()) return rc.liveOn(step, (n) => ({ do: 'click', n }));
    const r = rc.resolve(step);
    if ('portable' in r) {
      rc.note(`${r.n} is from an earlier page; followed its link`);
      return rc.navigate({ url: r.portable.href! });
    }
    const { act, block } = r;
    if (act.dis) throw new AwError('bad_request', `[${act.l}] is disabled`);
    const page = rc.page;
    if (act.k === 'link' && act.href) {
      const u = new URL(act.href);
      rc.outflow(u.pathname + u.search, u.origin);
      return rc.navigate({ url: act.href, referer: /^https?:/.test(page.url) ? page.url : undefined });
    }
    if ((act.k === 'check' || act.k === 'radio') && !act.js) {
      setChecked(rc, act, block, act.k === 'radio' ? true : !act.on);
      return;
    }
    if (act.k === 'button' && act.form !== undefined && !act.js) return rc.submitForm(act.form, act);
    await rc.escalate(`[${act.l}] is driven by JavaScript`);
    return rc.liveOn(retarget(step, act), (n) => ({ do: 'click', n }));
  },

  async fill(rc, step) {
    if (step.args.length < 2) throw new AwError('bad_request', "fill needs a target and a value: fill('Email', 'a@b.co')");
    const value = str(step.args[1]);
    if (!rc.isLive()) {
      const r = rc.resolve(step);
      if ('portable' in r) throw new AwError('bad_request', `${r.n} is a link from an earlier page, not a field`);
      const { act, block } = r;
      if (act.k === 'select') return VERBS.select(rc, step);
      const f = fieldOf(rc.page, act);
      if (f && !act.js) {
        rc.outflow(value, originOf(rc.page.forms[act.form!].action));
        f.value = value;
        act.val = displayValue(value, act.type) || undefined;
        rehash(block);
        (rc.rec.dirty ??= {})[act.f] = value;
        rc.rec.lastField = act.f;
        rc.stale = true;
        return;
      }
      await rc.escalate(`{${act.l}} is not part of a plain HTML form`);
      step = retarget(step, act);
    }
    const origin = originOf(rc.page.url);
    rc.outflow(value, origin);
    const actual = rc.guard.reveal(value, origin);
    let fp = '';
    await rc.liveOn(step, (n, act) => ((fp = act.f), { do: 'fill', n, value: actual }));
    rc.rec.lastField = fp;
  },

  async select(rc, step) {
    if (step.args.length < 2) throw new AwError('bad_request', "select needs a target and an option: select('Sort', 'Price')");
    const want = str(step.args[1]);
    if (rc.isLive()) return rc.liveOn(step, (n) => ({ do: 'select', n, value: want }));
    const r = rc.resolve(step);
    if ('portable' in r) throw new AwError('bad_request', `${r.n} is a link from an earlier page`);
    const { act, block } = r;
    if (act.k === 'radio') return void setChecked(rc, act, block, true);
    const f = fieldOf(rc.page, act);
    if (!f || act.js || !f.options) {
      await rc.escalate(`{${act.l}} is driven by JavaScript`);
      return rc.liveOn(retarget(step, act), (n) => ({ do: 'select', n, value: want }));
    }
    const w = lc(want);
    const opt = f.options.find((o) => lc(o.l) === w) ?? f.options.find((o) => lc(o.v) === w) ?? f.options.find((o) => lc(o.l).startsWith(w)) ?? f.options.find((o) => lc(o.l).includes(w));
    if (!opt) throw new AwError('bad_request', `{${act.l}} has no option '${want}'`, 'options: ' + f.options.slice(0, 30).map((o) => o.l).join(' | '));
    if (!f.multiple) for (const o of f.options) o.s = undefined;
    opt.s = true;
    f.value = opt.v;
    act.val = f.multiple ? f.options.filter((o) => o.s).map((o) => o.l).join(', ') : opt.l;
    rehash(block);
    (rc.rec.dirty ??= {})[act.f] = opt.l;
    rc.rec.lastField = act.f;
    rc.stale = true;
  },

  async check(rc, step) {
    const on = step.verb !== 'uncheck';
    if (rc.isLive()) return rc.liveOn(step, (n) => ({ do: 'check', n, on }));
    const r = rc.resolve(step);
    if ('portable' in r) throw new AwError('bad_request', `${r.n} is a link from an earlier page`);
    if (r.act.js || !fieldOf(rc.page, r.act)) {
      await rc.escalate(`{${r.act.l}} is driven by JavaScript`);
      return rc.liveOn(retarget(step, r.act), (n) => ({ do: 'check', n, on }));
    }
    setChecked(rc, r.act, r.block, on);
  },

  async submit(rc, step) {
    if (rc.isLive()) {
      await rc.ensureLive();
      if (step.args.length) {
        const r = rc.resolve(step, 'any');
        if (!('portable' in r) && (r.act.k === 'button' || r.act.k === 'click' || r.act.k === 'link')) return rc.liveOn(step, (n) => ({ do: 'click', n }));
        return rc.liveOn({ ...step, verb: 'any' }, (n) => ({ do: 'press', key: 'Enter', n }));
      }
      const last = rc.rec.lastField ? actByFp(rc.page, rc.rec.lastField) : undefined;
      if (last?.act.n !== undefined) return void (await rc.live({ do: 'press', key: 'Enter', n: last.act.n }));
      throw new AwError('bad_request', 'submit() needs a target on this page: click the button, or fill a field first');
    }
    const page = rc.page;
    let formIx: number | undefined;
    let submitter: Act | undefined;
    if (step.args.length) {
      const r = rc.resolve(step, 'any');
      if ('portable' in r) throw new AwError('bad_request', `${r.n} is a link from an earlier page`);
      if (r.act.k === 'button' && r.act.form !== undefined && !r.act.js) submitter = r.act;
      formIx = r.act.form;
      if (formIx === undefined) {
        await rc.escalate(`[${r.act.l}] is not part of a plain HTML form`);
        return rc.liveOn(retarget(step, r.act), (n) => ({ do: 'click', n }));
      }
    } else if (rc.rec.lastField) {
      formIx = actByFp(page, rc.rec.lastField)?.act.form;
    }
    if (formIx === undefined) {
      const usable = page.forms.map((f, i) => ({ f, i })).filter((x) => !x.f.js && x.f.fields.some((fl) => fl.type !== 'hidden' && fl.type !== 'submit'));
      if (usable.length === 1) formIx = usable[0].i;
      else if (!usable.length) throw new AwError('bad_request', 'there is no form on this page to submit');
      else throw new AwError('bad_request', `there are ${usable.length} forms here; say which: submit(n) with a field or button of the form`);
    }
    if (page.forms[formIx].js) {
      await rc.escalate('this form is handled by JavaScript');
      return void (await rc.live({ do: 'press', key: 'Enter' }));
    }
    await rc.submitForm(formIx, submitter);
  },

  async press(rc, step) {
    const key = str(step.args[0]);
    if (!key) throw new AwError('bad_request', "press needs a key: press('Enter')");
    if (!rc.isLive()) {
      if (/^(enter|return)$/i.test(key)) return VERBS.submit(rc, { ...step, verb: 'submit', args: step.args.slice(1) });
      await rc.escalate(`press('${key}') needs a script engine`);
    }
    await rc.ensureLive();
    if (step.args.length > 1) return rc.liveOn({ ...step, verb: 'any', args: step.args.slice(1) }, (n) => ({ do: 'press', key, n }));
    await rc.live({ do: 'press', key });
  },

  async hover(rc, step) {
    if (!rc.isLive()) await rc.escalate('hover needs a script engine');
    await rc.liveOn(step, (n) => ({ do: 'hover', n }));
  },

  async scroll(rc, step) {
    if (!rc.isLive()) return rc.note('nothing to scroll: the whole page is already available (read() pages through it)');
    const a = step.args[0];
    await rc.ensureLive();
    await rc.live({ do: 'scroll', to: typeof a === 'number' ? a : lc(str(a)) === 'top' ? 'top' : 'bottom' });
  },

  async wait(rc, step) {
    const a = step.args[0];
    const ms = typeof a === 'number' ? Math.min(a < 100 ? a * 1000 : a, 30000) : undefined;
    const text = typeof a === 'string' ? a : undefined;
    if (rc.isLive()) {
      await rc.ensureLive();
      await rc.live({ do: 'wait', ms, text });
      return;
    }
    // without scripts a page only changes when it is fetched again
    const p = rc.page;
    if (p.method !== 'GET' || !/^https?:/.test(p.url)) return rc.note('wait: nothing changes on this page without reloading it');
    if (text) {
      const needle = lc(text);
      for (let i = 0; i < 6; i++) {
        if (rc.page.blocks.some((b) => lc(blockText(b)).includes(needle))) return;
        await sleep(900);
        await rc.navigate({ url: p.url }, { tier: 'wire', push: false });
      }
      throw new AwError('timeout', `'${text}' did not appear after reloading the page 6 times`);
    }
    await sleep(Math.min(ms ?? 1000, 8000));
    await rc.navigate({ url: p.url }, { tier: 'wire', push: false });
  },

  async shot(rc) {
    if (!rc.isLive() || rc.page.tier !== 'chrome') {
      if (!(await rc.rt.available('chrome'))) throw new AwError('unsupported', 'screenshots need the chrome engine, which is not available', 'install Chrome or set AGENTWEB_CHROME');
      const p = rc.page;
      if (p.method !== 'GET') throw new AwError('unsupported', 'this page is the result of a form POST and cannot be re-opened for a screenshot');
      await rc.navigate({ url: p.url }, { tier: 'chrome', push: false });
    }
    await rc.ensureLive();
    await rc.live({ do: 'shot' });
    rc.note('screenshot attached');
  },

  async upload(rc, step) {
    if (!rc.isLive()) await rc.escalate('file upload needs the chrome engine');
    const name = str(step.args[1]) || 'file.txt';
    const data = Buffer.from(str(step.opts.text ?? step.args[2] ?? ''), 'utf8').toString('base64');
    await rc.liveOn(step, (n) => ({ do: 'upload', n, files: [{ name, mime: str(step.opts.mime) || 'text/plain', data }] }));
  },

  async engine(rc, step) {
    const name = lc(str(step.args[0]));
    if (name === 'auto' || name === '') {
      rc.rec.engine = undefined;
      return rc.note('engine: automatic');
    }
    if (!TIERS.includes(name as Tier)) throw new AwError('bad_request', `unknown engine '${name}'`, 'engines: auto, wire (HTTP only), ghost (JavaScript, no pixels), chrome');
    const tier = name as Tier;
    if (!(await rc.rt.available(tier))) throw new AwError('unsupported', `the ${tier} engine is not available here`);
    rc.rec.engine = tier;
    const p = rc.rec.page;
    if (p && p.tier !== tier && p.method === 'GET' && /^https?:/.test(p.url)) await rc.navigate({ url: p.url }, { tier, push: false });
    else rc.note(`engine: ${tier}`);
  },
};
VERBS.uncheck = VERBS.check;

/** After escalation the page object is new: aim the step at the same control by fingerprint or label. */
function retarget(step: Step, act: Act): Step {
  return { ...step, args: [act.l, ...step.args.slice(1)], opts: { ...step.opts, _fp: act.f } };
}

function setChecked(rc: RunCtx, act: Act, block: Block, on: boolean) {
  const page = rc.page;
  const f = fieldOf(page, act);
  if (!f) throw new AwError('unsupported', `{${act.l}} cannot be changed without a script engine`);
  if (act.k === 'radio' && on && act.form !== undefined) {
    for (const r of allActs(page)) {
      if (r.act.k !== 'radio' || r.act.form !== act.form || r.act === act) continue;
      const of = fieldOf(page, r.act);
      if (of && of.name === f.name && (of.checked || r.act.on)) {
        of.checked = false;
        r.act.on = undefined;
        rehash(r.block);
      }
    }
  }
  f.checked = on;
  act.on = on || undefined;
  rehash(block);
  (rc.rec.dirty ??= {})[act.f] = on ? '1' : '0';
  rc.rec.lastField = act.f;
  rc.stale = true;
}

// ───────────────────────────── runtime ─────────────────────────────

export class RuntimeImpl implements Runtime {
  deps: RuntimeDeps;
  opts: Required<RuntimeOptions>;
  private verbs: Record<string, VerbHandler> = { ...VERBS };
  private locks = new Map<string, Promise<unknown>>();
  private subs = new Set<(e: RunEvent) => void>();
  private counters: Record<string, number> = { runs: 0, steps: 0, errors: 0, fetches: 0, tokens_out: 0, escalations: 0, submits: 0 };
  private avail = new Map<Tier, Promise<boolean>>();

  constructor(deps: RuntimeDeps) {
    this.deps = deps;
    const o = deps.options ?? {};
    this.opts = {
      budget: o.budget ?? 2000,
      timeoutMs: o.timeoutMs ?? 20000,
      runTimeoutMs: o.runTimeoutMs ?? 90000,
      userAgent: o.userAgent ?? DEFAULT_UA,
      sessionTtlSec: o.sessionTtlSec ?? 86400,
    };
  }

  /** Add or replace a verb (extraction, fan-out, watchers live in their own modules). */
  register(verb: string, handler: VerbHandler) {
    this.verbs[verb] = handler;
  }

  count(name: string, by = 1) {
    this.counters[name] = (this.counters[name] ?? 0) + by;
  }

  available(tier: Tier): Promise<boolean> {
    let p = this.avail.get(tier);
    if (!p) {
      const e = this.deps.engines[tier];
      p = e ? e.available().catch(() => false) : Promise.resolve(false);
      this.avail.set(tier, p);
    }
    return p;
  }

  tool(): ToolSpec {
    return TOOL;
  }

  subscribe(fn: (e: RunEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  metrics(): Record<string, number> {
    const m: Record<string, number> = { ...this.counters };
    for (const t of TIERS) {
      const s = this.deps.engines[t]?.stats?.();
      if (s) for (const k in s) m[`${t}_${k}`] = s[k];
    }
    const ss = this.deps.store.stats?.();
    if (ss) for (const k in ss) m[`store_${k}`] = ss[k];
    return m;
  }

  async close(): Promise<void> {
    await Promise.allSettled(Object.values(this.deps.engines).map((e) => e?.close()));
    await this.deps.atlas?.flush().catch(() => {});
    await this.deps.store.close();
  }

  /** Calls for one session run one at a time; different sessions run concurrently. */
  private lock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return next;
  }

  run(session: string, program: string, opts?: RunOptions): Promise<RunResult> {
    return this.lock(session, () => this.runLocked(session, program, opts ?? {}));
  }

  private async runLocked(session: string, program: string, opts: RunOptions): Promise<RunResult> {
    const t0 = performance.now();
    const budget = Math.min(Math.max(opts.budget ?? this.opts.budget, 200), 30000);
    this.count('runs');
    let steps: Step[];
    try {
      steps = parseProgram(program);
    } catch (e) {
      this.count('errors');
      const err = e as AwError;
      const text = `✗ ${err.message}` + (err.hint ? '\n' + err.hint : '');
      return { ok: false, text, stats: { steps: 0, ms: Math.round(performance.now() - t0), tokens: estimateTokens(text), fetches: 0 } };
    }

    const timeout = AbortSignal.timeout(this.opts.runTimeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    const rec = await loadSession(this.deps.store, session, opts.fork);
    rec.view.seq++;
    const rc = new RunCtx(this, rec, budget, signal);

    let failed: { step: Step; err: AwError } | undefined;
    let done = 0;
    for (const step of steps) {
      if (signal.aborted) {
        failed = { step, err: new AwError('timeout', 'the run was cancelled or timed out') };
        break;
      }
      const handler = this.verbs[step.verb];
      try {
        if (!handler) throw new AwError('unsupported', `${step.verb}() is not available in this build`);
        await handler(rc, step);
        done++;
      } catch (e) {
        const err = e instanceof AwError ? e : new AwError('internal', shortError(e));
        failed = { step, err };
        break;
      }
    }
    this.count('steps', done);
    if (failed) this.count('errors');

    // one view of where the agent ended up, unless the last thing it did was already an observation
    let viewText = '';
    if (rec.page && rc.stale) {
      try {
        viewText = renderView(rec.page, rec.view, rc.refs, { budget: rc.remaining, prev: rc.baseline as unknown as Page | undefined }).text;
      } catch (e) {
        viewText = `(could not render the page: ${shortError(e)})`;
      }
    }

    const head: string[] = [];
    if (failed) {
      head.push(`✗ ${failed.step.src} — ${failed.err.message}`);
      if (failed.err.hint) head.push(failed.err.hint);
      const notRun = steps.slice(done + 1);
      if (notRun.length) head.push('not run: ' + notRun.map((s) => s.src).join('; '));
    } else if (steps.length > 1) {
      head.push('ok: ' + steps.map((s) => s.verb).join(' → '));
    }
    for (const n of rc.notes) head.push('note: ' + n);

    const parts = [...head.map((h) => rc.guard.redact(h)), ...rc.out];
    if (viewText) {
      const safe = rc.guard.redact(viewText);
      parts.push(safe);
      const p = rec.page!;
      if (/^https?:/.test(p.url)) rc.guard.observe(originOf(p.url), safe, rc.jar.has(p.url));
    }
    const text = parts.join('\n');

    rec.cookies = rc.jar.all();
    rec.guard = rc.guard.state();
    try {
      await saveSession(this.deps.store, rec, this.opts.sessionTtlSec);
    } catch (e) {
      this.count('errors');
      return { ok: false, text: text + `\n✗ session could not be saved: ${shortError(e)}`, stats: { steps: done, ms: Math.round(performance.now() - t0), tokens: estimateTokens(text), fetches: rc.fetches } };
    }

    const tokens = estimateTokens(text);
    this.count('fetches', rc.fetches);
    this.count('tokens_out', tokens);
    const result: RunResult = {
      ok: !failed,
      text,
      stats: { steps: done, ms: Math.round(performance.now() - t0), tokens, tier: rec.page?.tier, url: rec.page?.url, fetches: rc.fetches },
    };
    if (rc.images.length) result.images = rc.images;
    if (this.subs.size) {
      const ev: RunEvent = { at: Date.now(), session, tenant: opts.tenant, program, ok: result.ok, stats: result.stats, preview: text.slice(0, 600) };
      for (const fn of this.subs) {
        try {
          fn(ev);
        } catch {}
      }
    }
    return result;
  }
}

function shortError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.length > 200 ? m.slice(0, 199) + '…' : m;
}

export function createRuntime(deps: RuntimeDeps): RuntimeImpl {
  return new RuntimeImpl(deps);
}
