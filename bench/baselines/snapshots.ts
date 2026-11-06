// Capture exactly the text each tool returns to the model when an agent opens a URL and,
// where it is a separate call, takes a snapshot.
//
//   node bench/baselines/snapshots.ts [--urls file] [--tools a,b,...] [--out dir] [--timeout ms]
//
// URL-major order: every tool keeps one browser session open for the whole run, and each URL is
// visited by all tools back to back, so live pages change as little as possible between tools.
// Raw outputs: <out>/<mode>/<slug>.<step>.txt (+ .png for images); summary: <out>/snapshots.json.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { McpClient } from './mcp-client.ts';
import type { McpCallResult } from './mcp-client.ts';
import {
  AGENT_BROWSER_ENV,
  BIN,
  CHROME,
  HERE,
  OUT,
  VERSIONS,
  variant,
  writePlaywrightCliConfig,
} from './tools.ts';
import {
  IMAGE_TOKEN_LABEL,
  TOKENIZER_LABEL,
  bytes,
  fmtInt,
  imageInfo,
  mdTable,
  slugify,
  tokens,
} from './measure.ts';
import type { ImageInfo } from './measure.ts';

// ---------------------------------------------------------------------------------------------

export interface StepResult {
  step: string;
  /** The call as the agent would make it. */
  call: string;
  ms: number;
  bytes: number;
  tokens: number;
  images: ImageInfo[];
  isError: boolean;
  error?: string;
  /** Text that is an artifact of this machine rather than of the tool (see notes). */
  machineNoise?: { bytes: number; tokens: number; what: string };
}

export interface Capture {
  mode: string;
  url: string;
  slug: string;
  steps: StepResult[];
  /** Sum over steps of text the model receives. */
  bytes: number;
  tokens: number;
  /** Sum over steps of estimated image tokens (width*height/750). */
  imageTokensEst: number;
  imageTokensEstAfterResize: number;
  ms: number;
  ok: boolean;
  error?: string;
  at: string;
}

interface Mode {
  id: string;
  label: string;
  note?: string;
}

export const MODES: Mode[] = [
  {
    id: 'playwright-mcp',
    label: 'Playwright MCP: browser_navigate + browser_snapshot',
    note: 'navigate returns page info and a link to a snapshot file; browser_snapshot returns the tree inline',
  },
  {
    id: 'playwright-mcp-vision',
    label: 'Playwright MCP --caps vision: browser_navigate + browser_take_screenshot',
    note: 'screenshot is the viewport (default), PNG; image tokens are an estimate',
  },
  { id: 'chrome-devtools-mcp', label: 'Chrome DevTools MCP: navigate_page + take_snapshot' },
  { id: 'agent-browser', label: 'agent-browser: open + snapshot' },
  { id: 'agent-browser-i', label: 'agent-browser: open + snapshot -i', note: 'documented interactive-only variant' },
  {
    id: 'agent-browser-read',
    label: 'agent-browser read <url>',
    note: 'documented HTTP "agent-readable text" mode; no browser, no refs',
  },
  { id: 'playwright-cli', label: 'Playwright CLI: goto + snapshot', note: 'goto prints a link to a snapshot file; snapshot prints it inline' },
  {
    id: 'fetch-readability',
    label: 'fetch → Readability → Turndown',
    note: 'typical web-fetch tool pipeline (main content only)',
  },
  { id: 'fetch-turndown', label: 'fetch → whole-page Turndown', note: 'script/style/noscript removed' },
];

// ---------------------------------------------------------------------------------------------

const FETCH_UA = 'Mozilla/5.0 (compatible; agentweb-baselines/0.1; fetch-to-markdown baseline)';

function mcpText(r: McpCallResult): { text: string; images: { data: string; mimeType: string }[] } {
  const texts: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const c of r.content) {
    if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    else if (c.type === 'image' && typeof c.data === 'string') images.push({ data: c.data, mimeType: c.mimeType ?? 'image/png' });
    else if (c.type === 'resource' || c.type === 'resource_link') texts.push(JSON.stringify(c));
  }
  return { text: texts.join('\n'), images };
}

class Writer {
  dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  save(mode: string, slug: string, step: string, text: string, images: { data: string; mimeType: string }[] = []): void {
    const d = join(this.dir, mode);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${slug}.${step}.txt`), text);
    images.forEach((im, i) => {
      const ext = im.mimeType.includes('jpeg') ? 'jpg' : im.mimeType.includes('webp') ? 'webp' : 'png';
      writeFileSync(join(d, `${slug}.${step}${images.length > 1 ? '-' + i : ''}.${ext}`), Buffer.from(im.data, 'base64'));
    });
  }
  combined(mode: string, slug: string, parts: { step: string; call: string; text: string }[]): void {
    const d = join(this.dir, mode);
    mkdirSync(d, { recursive: true });
    // Step headers are for humans; byte/token counts come from the per-step text only.
    const body = parts.map((p) => `<<<agentweb-bench step=${p.step} call=${JSON.stringify(p.call)}>>>\n${p.text}`).join('\n');
    writeFileSync(join(d, `${slug}.txt`), body);
  }
}

function stepFrom(step: string, call: string, ms: number, text: string, images: { data: string; mimeType: string }[], isError: boolean, error?: string): StepResult {
  return {
    step,
    call,
    ms,
    bytes: bytes(text),
    tokens: tokens(text),
    images: images.map((im) => imageInfo(im.data, im.mimeType)),
    isError,
    ...(error ? { error } : {}),
  };
}

// ---- MCP sessions ---------------------------------------------------------------------------

class McpSession {
  client: McpClient;
  launchMs = 0;
  error?: string;
  workdir: string;
  constructor(variantId: string) {
    this.workdir = mkdtempSync(join(tmpdir(), `aw-snap-${variantId}-`));
    const v = variant(variantId);
    this.client = new McpClient({ ...v.spec, cwd: this.workdir }, { requestTimeoutMs: 90_000 });
  }
  async start(warm: (c: McpClient) => Promise<unknown>): Promise<void> {
    const t0 = Date.now();
    try {
      await this.client.start();
      await warm(this.client);
    } catch (e) {
      this.error = `start failed: ${(e as Error).message}`;
    }
    this.launchMs = Date.now() - t0;
  }
  async call(step: string, name: string, args: Record<string, unknown>, timeoutMs = 90_000) {
    const t0 = Date.now();
    try {
      const r = await this.client.callTool(name, args, timeoutMs);
      const { text, images } = mcpText(r);
      return { res: stepFrom(step, `${name} ${JSON.stringify(args)}`, Date.now() - t0, text, images, r.isError === true, r.isError ? text.slice(0, 300) : undefined), text, images };
    } catch (e) {
      const msg = (e as Error).message;
      return { res: stepFrom(step, `${name} ${JSON.stringify(args)}`, Date.now() - t0, '', [], true, msg), text: '', images: [] };
    }
  }
  async close(): Promise<void> {
    await this.client.close();
    rmSync(this.workdir, { recursive: true, force: true });
  }
}

// ---- CLI sessions ---------------------------------------------------------------------------

interface CliRun {
  out: string;
  code: number | null;
  ms: number;
  timedOut: boolean;
}

/** Run a CLI and return stdout+stderr interleaved as the Bash tool would show them. */
function runCli(cmd: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs = 90_000): Promise<CliRun> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (out += c));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ out, code, ms: Date.now() - t0, timedOut });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ out: out + String(e), code: -1, ms: Date.now() - t0, timedOut });
    });
  });
}

/** agent-browser prints this when the local Chromium is older than current stable. */
const AB_CHROME_WARNING = /^⚠ Chrome [^\n]* is behind the current stable release[^\n]*\n?/m;

function cliStep(step: string, call: string, r: CliRun): StepResult {
  const failed = r.timedOut || r.code !== 0;
  const s = stepFrom(step, call, r.ms, r.out, [], failed, failed ? (r.timedOut ? 'timeout' : `exit ${r.code}: ${r.out.trim().slice(-300)}`) : undefined);
  const m = r.out.match(AB_CHROME_WARNING);
  if (m) s.machineNoise = { bytes: bytes(m[0]), tokens: tokens(m[0]), what: 'agent-browser outdated-Chrome warning (local Chromium 156 < stable 157)' };
  return s;
}

class AgentBrowserSession {
  session = `awsnap-${process.pid}`;
  env: Record<string, string> = { ...AGENT_BROWSER_ENV };
  cwd = mkdtempSync(join(tmpdir(), 'aw-snap-ab-'));
  launchMs = 0;
  error?: string;
  run(args: string[], timeoutMs?: number) {
    return runCli(BIN.agentBrowser, ['--session', this.session, ...args], this.env, this.cwd, timeoutMs);
  }
  async start() {
    const r = await this.run(['open', 'about:blank']);
    this.launchMs = r.ms;
    if (r.code !== 0) this.error = `start failed: ${r.out.trim().slice(-300)}`;
  }
  async close() {
    await this.run(['close'], 20_000);
    rmSync(this.cwd, { recursive: true, force: true });
  }
}

class PlaywrightCliSession {
  cwd = mkdtempSync(join(tmpdir(), 'aw-snap-pwcli-'));
  env: Record<string, string> = { NO_UPDATE_NOTIFIER: '1' };
  launchMs = 0;
  error?: string;
  constructor() {
    writePlaywrightCliConfig(this.cwd);
  }
  run(args: string[], timeoutMs?: number) {
    return runCli(process.execPath, [BIN.playwrightCli, ...args], this.env, this.cwd, timeoutMs);
  }
  async start() {
    const r = await this.run(['open']);
    this.launchMs = r.ms;
    if (r.code !== 0) this.error = `start failed: ${r.out.trim().slice(-300)}`;
  }
  async close() {
    await this.run(['close'], 20_000);
    rmSync(this.cwd, { recursive: true, force: true });
  }
}

// ---- fetch baseline -------------------------------------------------------------------------

function turndownService(): TurndownService {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  td.remove(['script', 'style', 'noscript']);
  return td;
}

async function fetchHtml(url: string, timeoutMs: number): Promise<{ html: string; finalUrl: string; status: number; ms: number; contentType: string }> {
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: { 'user-agent': FETCH_UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await res.text();
  return { html, finalUrl: res.url || url, status: res.status, ms: Date.now() - t0, contentType: res.headers.get('content-type') ?? '' };
}

function quietDom(html: string, url: string): JSDOM {
  const vc = new VirtualConsole(); // swallow CSS parse errors etc.
  return new JSDOM(html, { url, virtualConsole: vc });
}

export function readabilityMarkdown(html: string, url: string): { md: string; title?: string; found: boolean } {
  const dom = quietDom(html, url);
  try {
    const article = new Readability(dom.window.document).parse();
    if (!article?.content) return { md: '', found: false };
    const md = turndownService().turndown(article.content);
    return { md: (article.title ? `# ${article.title}\n\n` : '') + md, title: article.title ?? undefined, found: true };
  } finally {
    dom.window.close();
  }
}

export function wholePageMarkdown(html: string, url: string): string {
  const dom = quietDom(html, url);
  try {
    return turndownService().turndown(dom.window.document.body ?? dom.window.document.documentElement);
  } finally {
    dom.window.close();
  }
}

// ---- main -----------------------------------------------------------------------------------

function capture(mode: string, url: string, steps: StepResult[], at: string, extraError?: string): Capture {
  const failed = steps.find((s) => s.isError);
  const error = extraError ?? (failed ? `${failed.step}: ${failed.error ?? 'tool returned isError'}` : undefined);
  return {
    mode,
    url,
    slug: slugify(url),
    steps,
    bytes: steps.reduce((a, s) => a + s.bytes, 0),
    tokens: steps.reduce((a, s) => a + s.tokens, 0),
    imageTokensEst: steps.reduce((a, s) => a + s.images.reduce((b, i) => b + i.tokensEst, 0), 0),
    imageTokensEstAfterResize: steps.reduce((a, s) => a + s.images.reduce((b, i) => b + i.tokensEstAfterResize, 0), 0),
    ms: steps.reduce((a, s) => a + s.ms, 0),
    ok: !error,
    ...(error ? { error } : {}),
    at,
  };
}

/** Chrome DevTools MCP needs a pageId; list_pages prints lines like `1: https://… [selected]`. */
function pickPageId(text: string): number | undefined {
  const lines = text.split('\n');
  const sel = lines.find((l) => /^\s*\d+:/.test(l) && /\[selected\]/.test(l));
  const any = sel ?? lines.find((l) => /^\s*\d+:/.test(l));
  const m = any?.match(/^\s*(\d+):/);
  return m ? Number(m[1]) : undefined;
}

const READ_SESSION = `awsnap-read-${process.pid}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSnapshots(opts: {
  urls: string[];
  modes: string[];
  outDir: string;
  timeoutMs: number;
  /**
   * Pause between the navigation call and the snapshot call, the same for every tool and not
   * counted in wall time. A real agent spends seconds in the model between the two calls, and
   * pages that keep loading after the load event (ads, lazy sections) would otherwise favour
   * whichever tool happens to snapshot soonest.
   */
  settleMs: number;
  log?: (s: string) => void;
}) {
  const log = opts.log ?? ((s: string) => console.error(s));
  const want = new Set(opts.modes);
  const w = new Writer(opts.outDir);
  const captures: Capture[] = [];
  const launches: Record<string, { ms: number; error?: string }> = {};

  const pw = want.has('playwright-mcp') ? new McpSession('playwright-mcp') : undefined;
  const pwv = want.has('playwright-mcp-vision') ? new McpSession('playwright-mcp-vision') : undefined;
  const cdp = want.has('chrome-devtools-mcp') ? new McpSession('chrome-devtools-mcp') : undefined;
  const ab = want.has('agent-browser') || want.has('agent-browser-i') ? new AgentBrowserSession() : undefined;
  const pwc = want.has('playwright-cli') ? new PlaywrightCliSession() : undefined;
  let cdpPage: number | undefined;

  try {
    // Launch each browser before timing page loads, so launch cost is reported separately.
    if (pw) await pw.start((c) => c.callTool('browser_navigate', { url: 'about:blank' }));
    if (pwv) await pwv.start((c) => c.callTool('browser_navigate', { url: 'about:blank' }));
    if (cdp)
      await cdp.start(async (c) => {
        const r = await c.callTool('list_pages', {});
        cdpPage = pickPageId(mcpText(r).text);
        if (cdpPage === undefined) throw new Error(`no pageId in list_pages output: ${mcpText(r).text.slice(0, 200)}`);
      });
    if (ab) await ab.start();
    if (pwc) await pwc.start();
    for (const [k, s] of Object.entries({ 'playwright-mcp': pw, 'playwright-mcp-vision': pwv, 'chrome-devtools-mcp': cdp, 'agent-browser': ab, 'playwright-cli': pwc })) {
      if (s) launches[k] = { ms: s.launchMs, ...(s.error ? { error: s.error } : {}) };
    }
    log(`launch: ${JSON.stringify(launches)}`);

    for (const url of opts.urls) {
      const slug = slugify(url);
      log(`\n== ${url}`);
      const at = () => new Date().toISOString();
      const done = (c: Capture) => {
        captures.push(c);
        log(`  ${c.mode.padEnd(22)} ${String(c.tokens).padStart(7)} tok ${String(c.imageTokensEst || '').padStart(5)} img  ${(c.ms / 1000).toFixed(1).padStart(5)} s ${c.error ? 'ERROR ' + c.error.slice(0, 120) : ''}`);
      };

      if (pw) {
        const t = at();
        if (pw.error) done(capture('playwright-mcp', url, [], t, pw.error));
        else {
          // 0.0.8x writes the implicit post-navigation snapshot to a file and returns a link;
          // only an explicit browser_snapshot returns the tree inline.
          const nav = await pw.call('nav', 'browser_navigate', { url }, opts.timeoutMs);
          await sleep(opts.settleMs);
          const snap = await pw.call('snapshot', 'browser_snapshot', {}, opts.timeoutMs);
          w.save('playwright-mcp', slug, 'nav', nav.text);
          w.save('playwright-mcp', slug, 'snapshot', snap.text);
          w.combined('playwright-mcp', slug, [
            { step: 'nav', call: nav.res.call, text: nav.text },
            { step: 'snapshot', call: snap.res.call, text: snap.text },
          ]);
          done(capture('playwright-mcp', url, [nav.res, snap.res], t));
        }
      }

      if (pwv) {
        const t = at();
        if (pwv.error) done(capture('playwright-mcp-vision', url, [], t, pwv.error));
        else {
          const nav = await pwv.call('nav', 'browser_navigate', { url }, opts.timeoutMs);
          await sleep(opts.settleMs);
          const shot = await pwv.call('screenshot', 'browser_take_screenshot', {}, opts.timeoutMs);
          w.save('playwright-mcp-vision', slug, 'nav', nav.text);
          w.save('playwright-mcp-vision', slug, 'screenshot', shot.text, shot.images);
          w.combined('playwright-mcp-vision', slug, [
            { step: 'nav', call: nav.res.call, text: nav.text },
            { step: 'screenshot', call: shot.res.call, text: shot.text + shot.images.map((im) => `\n[image ${im.mimeType} ${imageInfo(im.data, im.mimeType).width}x${imageInfo(im.data, im.mimeType).height}]`).join('') },
          ]);
          done(capture('playwright-mcp-vision', url, [nav.res, shot.res], t));
        }
      }

      if (cdp) {
        const t = at();
        if (cdp.error || cdpPage === undefined) done(capture('chrome-devtools-mcp', url, [], t, cdp.error ?? 'no page'));
        else {
          const nav = await cdp.call('nav', 'navigate_page', { pageId: cdpPage, type: 'url', url }, opts.timeoutMs);
          await sleep(opts.settleMs);
          const snap = await cdp.call('snapshot', 'take_snapshot', { pageId: cdpPage }, opts.timeoutMs);
          w.save('chrome-devtools-mcp', slug, 'nav', nav.text);
          w.save('chrome-devtools-mcp', slug, 'snapshot', snap.text);
          w.combined('chrome-devtools-mcp', slug, [
            { step: 'nav', call: nav.res.call, text: nav.text },
            { step: 'snapshot', call: snap.res.call, text: snap.text },
          ]);
          done(capture('chrome-devtools-mcp', url, [nav.res, snap.res], t));
        }
      }

      if (ab) {
        const t = at();
        if (ab.error) {
          if (want.has('agent-browser')) done(capture('agent-browser', url, [], t, ab.error));
          if (want.has('agent-browser-i')) done(capture('agent-browser-i', url, [], t, ab.error));
        } else {
          // Each variant navigates on its own, so neither inherits the other's extra load time.
          for (const [mode, snapArgs] of [
            ['agent-browser', ['snapshot']],
            ['agent-browser-i', ['snapshot', '-i']],
          ] as const) {
            if (!want.has(mode)) continue;
            const open = await ab.run(['open', url], opts.timeoutMs);
            const openStep = cliStep('nav', `agent-browser open ${url}`, open);
            await sleep(opts.settleMs);
            const snap = await ab.run([...snapArgs], opts.timeoutMs);
            const s = cliStep('snapshot', `agent-browser ${snapArgs.join(' ')}`, snap);
            w.save(mode, slug, 'nav', open.out);
            w.save(mode, slug, 'snapshot', snap.out);
            w.combined(mode, slug, [
              { step: 'nav', call: openStep.call, text: open.out },
              { step: 'snapshot', call: s.call, text: snap.out },
            ]);
            done(capture(mode, url, [openStep, s], t));
          }
        }
      }

      if (want.has('agent-browser-read')) {
        const t = at();
        // `read` starts a session daemon (with a browser) even for HTTP reads; use our own and close it at the end.
        const r = await runCli(BIN.agentBrowser, ['--session', READ_SESSION, 'read', url], { ...AGENT_BROWSER_ENV }, tmpdir(), opts.timeoutMs);
        const s = cliStep('read', `agent-browser read ${url}`, r);
        w.save('agent-browser-read', slug, 'read', r.out);
        w.combined('agent-browser-read', slug, [{ step: 'read', call: s.call, text: r.out }]);
        done(capture('agent-browser-read', url, [s], t));
      }

      if (pwc) {
        const t = at();
        if (pwc.error) done(capture('playwright-cli', url, [], t, pwc.error));
        else {
          const nav = await pwc.run(['goto', url], opts.timeoutMs);
          const navStep = cliStep('nav', `playwright-cli goto ${url}`, nav);
          await sleep(opts.settleMs);
          const snap = await pwc.run(['snapshot'], opts.timeoutMs);
          const snapStep = cliStep('snapshot', 'playwright-cli snapshot', snap);
          w.save('playwright-cli', slug, 'nav', nav.out);
          w.save('playwright-cli', slug, 'snapshot', snap.out);
          w.combined('playwright-cli', slug, [
            { step: 'nav', call: navStep.call, text: nav.out },
            { step: 'snapshot', call: snapStep.call, text: snap.out },
          ]);
          done(capture('playwright-cli', url, [navStep, snapStep], t));
        }
      }

      if (want.has('fetch-readability') || want.has('fetch-turndown')) {
        const t = at();
        let page: Awaited<ReturnType<typeof fetchHtml>> | undefined;
        let fetchErr: string | undefined;
        try {
          page = await fetchHtml(url, opts.timeoutMs);
          if (page.status >= 400) fetchErr = `HTTP ${page.status}`;
        } catch (e) {
          fetchErr = `fetch failed: ${(e as Error).message}`;
        }
        for (const mode of ['fetch-readability', 'fetch-turndown'] as const) {
          if (!want.has(mode)) continue;
          if (!page) {
            done(capture(mode, url, [], t, fetchErr));
            continue;
          }
          const t0 = Date.now();
          let text = '';
          let err = fetchErr;
          try {
            if (mode === 'fetch-readability') {
              const r = readabilityMarkdown(page.html, page.finalUrl);
              text = r.md;
              if (!r.found && !err) err = 'Readability found no article';
            } else text = wholePageMarkdown(page.html, page.finalUrl);
          } catch (e) {
            err = `convert failed: ${(e as Error).message}`;
          }
          const s = stepFrom('fetch', `GET ${url} (HTTP ${page.status}, ${page.contentType})`, page.ms + (Date.now() - t0), text, [], !!err, err);
          w.save(mode, slug, 'fetch', text);
          w.combined(mode, slug, [{ step: 'fetch', call: s.call, text }]);
          done(capture(mode, url, [s], t));
        }
      }
    }
  } finally {
    await Promise.allSettled([
      pw?.close(),
      pwv?.close(),
      cdp?.close(),
      ab?.close(),
      pwc?.close(),
      want.has('agent-browser-read') ? runCli(BIN.agentBrowser, ['--session', READ_SESSION, 'close'], { ...AGENT_BROWSER_ENV }, tmpdir(), 20_000) : undefined,
    ]);
  }
  return { captures, launches };
}

export function snapshotTable(captures: Capture[], modes: string[], urls: string[]): string {
  const header = ['URL', ...modes];
  const rows = urls.map((u) => {
    const slug = slugify(u);
    return [
      slug.slice(0, 40),
      ...modes.map((m) => {
        const c = captures.find((x) => x.mode === m && x.url === u);
        if (!c) return '–';
        if (!c.ok && !c.tokens) return `FAIL`;
        const img = c.imageTokensEst ? `+${fmtInt(c.imageTokensEst)}img` : '';
        return `${fmtInt(c.tokens)}${img} / ${(c.ms / 1000).toFixed(1)}s${c.ok ? '' : ' ⚠'}`;
      }),
    ];
  });
  const med = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
  };
  rows.push([
    '**median (ok runs)**',
    ...modes.map((m) => {
      const cs = captures.filter((x) => x.mode === m && x.ok);
      if (!cs.length) return '–';
      const img = med(cs.map((c) => c.imageTokensEst));
      return `${fmtInt(Math.round(med(cs.map((c) => c.tokens))))}${img ? `+${fmtInt(Math.round(img))}img` : ''} / ${(med(cs.map((c) => c.ms)) / 1000).toFixed(1)}s`;
    }),
  ]);
  return mdTable(header, rows);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      urls: { type: 'string', default: join(HERE, 'urls.live.txt') },
      tools: { type: 'string' },
      out: { type: 'string', default: OUT },
      timeout: { type: 'string', default: '90000' },
      settle: { type: 'string', default: '3000' },
    },
  });
  const urls = readFileSync(values.urls!, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const modes = values.tools ? values.tools.split(',').map((s) => s.trim()) : MODES.map((m) => m.id);
  for (const m of modes) if (!MODES.find((x) => x.id === m)) throw new Error(`unknown mode ${m}; known: ${MODES.map((x) => x.id).join(', ')}`);
  const outDir = values.out!;
  mkdirSync(outDir, { recursive: true });
  const started = new Date().toISOString();
  const { captures, launches } = await runSnapshots({ urls, modes, outDir, timeoutMs: Number(values.timeout), settleMs: Number(values.settle) });
  const summary = {
    started,
    finished: new Date().toISOString(),
    tokenizer: TOKENIZER_LABEL,
    imageTokens: IMAGE_TOKEN_LABEL,
    chrome: CHROME,
    settleMs: Number(values.settle),
    versions: VERSIONS,
    modes: MODES.filter((m) => modes.includes(m.id)),
    launches,
    notes: [
      'bytes/tokens are of the text a tool call returns (MCP text content, or CLI stdout+stderr as a Bash tool shows it), summed over the listed steps.',
      'Raw tool output, before any client-side limit: Claude Code truncates long Bash output and warns on/limits large MCP results, so in agent runs the model may see less.',
      'agent-browser prints an outdated-Chrome warning on stderr after launching the local Chromium 156; it is counted (the model would see it) and flagged per step as machineNoise.',
      'Live pages change between runs and between tools; captures for one URL are taken back to back.',
      `Every two-call mode waits settleMs (${values.settle} ms) between navigation and snapshot/screenshot; the wait is not included in ms.`,
    ],
    captures,
  };
  writeFileSync(join(outDir, 'snapshots.json'), JSON.stringify(summary, null, 2));
  const md = [
    `# Snapshot sizes (${started})`,
    '',
    `Settle delay between navigation and snapshot: ${values.settle} ms for every tool (not counted in seconds).`,
    '',
    `Cell: proxy tokens (${TOKENIZER_LABEL}) / wall seconds for the step(s) in the mode. "+N img" = estimated image tokens (${IMAGE_TOKEN_LABEL}). ⚠ = a step failed.`,
    '',
    snapshotTable(captures, modes, urls),
    '',
    ...MODES.filter((m) => modes.includes(m.id)).map((m) => `- **${m.id}**: ${m.label}${m.note ? ` (${m.note})` : ''}`),
    '',
    `Browser launch (ms): ${JSON.stringify(launches)}`,
  ].join('\n');
  writeFileSync(join(outDir, 'snapshots.md'), md + '\n');
  console.log(md);
}
