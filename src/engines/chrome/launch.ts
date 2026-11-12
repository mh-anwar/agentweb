// Find a Chromium, start it with the smallest footprint that still runs real pages, and keep
// track of the process so a crash is noticed and the temporary profile is always removed.

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { AwError } from '../../types.ts';
import { Cdp, connect, pipeTransport } from './cdp.ts';

export interface LaunchOptions {
  /** path to a Chromium-family binary; default: AGENTWEB_CHROME, then discovery */
  executable?: string;
  /** connect to a running browser (ws://… or http://host:port) instead of launching one */
  endpoint?: string;
  /** load images (default false: they cost memory and bandwidth and the agent never sees pixels) */
  images?: boolean;
  /** force --no-sandbox. Default: only when AGENTWEB_NO_SANDBOX=1 or the sandboxed launch fails with the namespace error */
  noSandbox?: boolean;
  /** extra command-line switches */
  args?: string[];
  /**
   * With `endpoint`: open pages in the browser's DEFAULT context, i.e. the user's own profile
   * (their cookies and logins), instead of a fresh isolated one. Opt-in only.
   */
  shared?: boolean;
  /** proxy for all contexts, e.g. http://host:3128 */
  proxy?: string;
  launchTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BrowserMemory {
  /** resident set size summed over the process tree, bytes (shared pages are counted once per process) */
  rss: number;
  /** proportional set size summed over the tree, bytes (shared pages divided fairly); 0 when not asked for or unavailable */
  pss: number;
  processes: number;
}

export interface Browser {
  cdp: Cdp;
  /** undefined for a remote browser */
  pid?: number;
  executable?: string;
  /** e.g. "HeadlessChrome/156.0.8078.4" */
  product: string;
  userAgent: string;
  remote: boolean;
  noSandbox: boolean;
  /** ms from spawn to the first CDP answer */
  launchMs: number;
  alive(): boolean;
  /** why the browser stopped, once it has */
  exitReason(): string;
  onExit(fn: (reason: string) => void): void;
  close(): Promise<void>;
  /** hard kill, used by tests and by the process exit hook */
  kill(): void;
  memory(withPss?: boolean): BrowserMemory;
}

// ───────────────────────────── discovery ─────────────────────────────

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

const subdirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/** Newest first: "chromium-1248" before "chromium-1100", "linux-131.0.2" before "linux-99.0.1". */
const newestFirst = (names: string[]): string[] => {
  const key = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  return [...names].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const d = (kb[i] ?? 0) - (ka[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });
};

interface Names {
  shell: string[];
  full: string[];
}

function binaryNames(platform: NodeJS.Platform): Names {
  if (platform === 'win32') return { shell: ['chrome-headless-shell.exe', 'headless_shell.exe'], full: ['chrome.exe'] };
  if (platform === 'darwin') {
    return {
      shell: ['chrome-headless-shell', 'headless_shell'],
      full: [
        'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        'Chromium.app/Contents/MacOS/Chromium',
        'Google Chrome.app/Contents/MacOS/Google Chrome',
      ],
    };
  }
  return { shell: ['chrome-headless-shell', 'headless_shell'], full: ['chrome'] };
}

/** `<versionDir>/<anything>/<binary>`: both caches unpack an archive with one top-level folder. */
function inVersionDir(versionDir: string, names: string[]): string | undefined {
  for (const name of names) {
    const direct = join(versionDir, name);
    if (isFile(direct)) return direct;
  }
  for (const sub of subdirs(versionDir)) {
    for (const name of names) {
      const p = join(versionDir, sub, name);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

function playwrightDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const out: string[] = [];
  const custom = env.PLAYWRIGHT_BROWSERS_PATH;
  if (custom && custom !== '0') out.push(custom);
  if (platform === 'win32') out.push(join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright'));
  else if (platform === 'darwin') out.push(join(home, 'Library', 'Caches', 'ms-playwright'));
  else out.push(join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright'));
  return out;
}

function puppeteerDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const out: string[] = [];
  if (env.PUPPETEER_CACHE_DIR) out.push(env.PUPPETEER_CACHE_DIR);
  out.push(join(home, '.cache', 'puppeteer'));
  return out;
}

function fromPlaywright(dirs: string[], prefix: string, names: string[]): string | undefined {
  for (const dir of dirs) {
    const versions = newestFirst(subdirs(dir).filter((d) => d.startsWith(prefix + '-')));
    for (const v of versions) {
      const hit = inVersionDir(join(dir, v), names);
      if (hit) return hit;
    }
  }
  return undefined;
}

function fromPuppeteer(dirs: string[], product: string, names: string[]): string | undefined {
  for (const dir of dirs) {
    for (const v of newestFirst(subdirs(join(dir, product)))) {
      const hit = inVersionDir(join(dir, product, v), names);
      if (hit) return hit;
    }
  }
  return undefined;
}

function systemBrowser(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string | undefined {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA, env.PROGRAMW6432].filter((x): x is string => !!x);
    const rel = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ];
    for (const r of rel) for (const root of roots) {
      const p = join(root, ...r);
      if (isFile(p)) return p;
    }
    return undefined;
  }
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ];
    for (const app of apps) for (const root of ['/Applications', join(home, 'Applications')]) {
      const p = join(root, app);
      if (isFile(p)) return p;
    }
    return undefined;
  }
  const names = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge-stable', 'microsoft-edge', 'chrome'];
  const path = (env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const name of names) for (const dir of path) {
    const p = join(dir, name);
    if (isFile(p)) return p;
  }
  for (const p of ['/opt/google/chrome/chrome', '/usr/lib/chromium/chromium', '/usr/lib/chromium-browser/chromium-browser', '/snap/bin/chromium', '/opt/microsoft/msedge/msedge']) {
    if (isFile(p)) return p;
  }
  return undefined;
}

/**
 * Where is a browser? Order: AGENTWEB_CHROME, a headless shell from the Playwright or Puppeteer
 * cache (smallest footprint), a full Chromium from those caches, then the system's Chrome,
 * Chromium or Edge. Returns undefined when nothing is installed.
 */
export function findBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string | undefined {
  const forced = env.AGENTWEB_CHROME;
  if (forced) return isFile(forced) ? forced : undefined;
  const n = binaryNames(platform);
  const pw = playwrightDirs(env, platform, home);
  const pp = puppeteerDirs(env, home);
  return (
    fromPlaywright(pw, 'chromium_headless_shell', n.shell) ??
    fromPuppeteer(pp, 'chrome-headless-shell', n.shell) ??
    fromPlaywright(pw, 'chromium', n.full) ??
    fromPuppeteer(pp, 'chrome', n.full) ??
    systemBrowser(env, platform, home)
  );
}

// ───────────────────────────── flags ─────────────────────────────

const DISABLED_FEATURES = [
  'Translate',
  'MediaRouter',
  'DialMediaRouteProvider',
  'OptimizationHints',
  'OptimizationGuideModelDownloading',
  'InterestFeedContentSuggestions',
  'AutofillServerCommunication',
  'CertificateTransparencyComponentUpdater',
  'CalculateNativeWinOcclusion',
  'BackForwardCache', // a restored page keeps its old world; a fresh load is easier to reason about
  'AcceptCHFrame',
  'PaintHolding',
  'IsolateOrigins', // one renderer per page, not one per origin: cross-origin frames share it
  'site-per-process',
  'HttpsUpgrades',
  'LensOverlay',
  'PrivacySandboxSettings4',
  'Prerender2', // never fetch a page the agent did not ask for
  'SpeculationRulesPrefetchProxy',
];

/** The command line for a browser we own. Exported for tests. */
export function chromeArgs(userDataDir: string, opts: { images?: boolean; noSandbox?: boolean; args?: string[]; proxy?: string }): string[] {
  const blink = ['primaryPointerType=4', 'availablePointerTypes=4', 'primaryHoverType=2', 'availableHoverTypes=2'];
  if (!opts.images) blink.push('imagesEnabled=false');
  const args = [
    '--headless',
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-startup-window',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--no-pings',
    '--no-service-autorun',
    '--metrics-recording-only',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-hang-monitor',
    '--disable-popup-blocking', // popups are folded into the one page; a blocked one would be invisible to us
    '--disable-prompt-on-repost',
    '--disable-notifications',
    '--disable-search-engine-choice-screen',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--disable-site-isolation-trials',
    '--password-store=basic',
    '--use-mock-keychain',
    '--mute-audio',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    '--window-size=1280,800',
    `--disable-features=${DISABLED_FEATURES.join(',')}`,
    // navigator.webdriver is false, like a browser nobody is automating
    '--disable-blink-features=AutomationControlled',
    `--blink-settings=${blink.join(',')}`,
  ];
  if (opts.noSandbox) args.push('--no-sandbox');
  if (opts.proxy) args.push(`--proxy-server=${opts.proxy}`);
  if (opts.args) args.push(...opts.args);
  return args;
}

// ───────────────────────────── process bookkeeping ─────────────────────────────

/** Sandbox start-up failures that mean "this kernel will not give us user namespaces". */
const NAMESPACE_ERROR = /No usable sandbox|Failed to move to new namespace|unprivileged user namespaces|user namespace/i;

/** executables known to need --no-sandbox in this process, so a relaunch does not pay for the failed try again */
const needsNoSandbox = new Set<string>();

interface Owned {
  child: ChildProcess;
  dir: string;
}
const owned = new Set<Owned>();
let exitHookInstalled = false;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL'); // the browser leads its own process group
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  } catch {}
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const o of owned) {
      killTree(o.child);
      removeDir(o.dir);
    }
  });
}

/** pid -> parent pid for every process we can see (Linux /proc). */
function linuxParents(): Map<number, number> {
  const out = new Map<number, number>();
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return out;
  }
  for (const name of names) {
    const c = name.charCodeAt(0);
    if (c < 48 || c > 57) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'latin1');
      // "pid (comm) state ppid …": comm may contain spaces and parentheses, so cut at the last ')'
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      out.set(Number(name), Number(rest[1]));
    } catch {}
  }
  return out;
}

function descendants(root: number, parents: Map<number, number>): number[] {
  const kids = new Map<number, number[]>();
  for (const [pid, ppid] of parents) {
    let list = kids.get(ppid);
    if (!list) kids.set(ppid, (list = []));
    list.push(pid);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    const pid = queue.pop()!;
    out.push(pid);
    for (const k of kids.get(pid) ?? []) queue.push(k);
  }
  return out;
}

const kbField = (text: string, field: string): number => {
  const m = new RegExp(`^${field}:\\s+(\\d+) kB`, 'm').exec(text);
  return m ? Number(m[1]) * 1024 : 0;
};

/** Memory of a process tree. Linux reads /proc; macOS asks ps; elsewhere it reports zeros. */
export function treeMemory(rootPid: number, withPss = false): BrowserMemory {
  const mem: BrowserMemory = { rss: 0, pss: 0, processes: 0 };
  if (process.platform === 'linux') {
    for (const pid of descendants(rootPid, linuxParents())) {
      try {
        mem.rss += kbField(readFileSync(`/proc/${pid}/status`, 'latin1'), 'VmRSS');
        mem.processes++;
        if (withPss) mem.pss += kbField(readFileSync(`/proc/${pid}/smaps_rollup`, 'latin1'), 'Pss');
      } catch {}
    }
    return mem;
  }
  if (process.platform === 'darwin') {
    try {
      const text = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 2000 });
      const parents = new Map<number, number>();
      const rss = new Map<number, number>();
      for (const line of text.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
        if (!m) continue;
        parents.set(Number(m[1]), Number(m[2]));
        rss.set(Number(m[1]), Number(m[3]) * 1024);
      }
      for (const pid of descendants(rootPid, parents)) {
        mem.rss += rss.get(pid) ?? 0;
        mem.processes++;
      }
    } catch {}
  }
  return mem;
}

// ───────────────────────────── launch ─────────────────────────────

interface Attempt {
  child: ChildProcess;
  cdp: Cdp;
  dir: string;
  version: { product: string; userAgent: string };
  stderr: () => string;
  /** registers a callback for process exit; fires at most once */
  exited: Promise<string>;
}

class LaunchFailure extends Error {
  stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

async function attempt(executable: string, opts: LaunchOptions, noSandbox: boolean): Promise<Attempt> {
  const dir = mkdtempSync(join(tmpdir(), 'agentweb-chrome-'));
  const args = chromeArgs(dir, { images: opts.images, noSandbox, args: opts.args, proxy: opts.proxy });
  let child: ChildProcess;
  try {
    child = spawn(executable, args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      cwd: dir, // anything the browser drops in its working directory goes away with the profile
      detached: process.platform !== 'win32',
      env: opts.env ?? process.env,
      windowsHide: true,
    });
  } catch (e) {
    removeDir(dir);
    throw new LaunchFailure(`could not start ${executable}: ${(e as Error).message}`, '');
  }
  const entry: Owned = { child, dir };
  owned.add(entry);
  installExitHook();

  let err = '';
  child.stderr?.on('data', (d: Buffer) => {
    err = (err + d.toString('utf8')).slice(-16_384);
  });
  const exited = new Promise<string>((resolve) => {
    child.once('error', (e) => resolve(`spawn error: ${e.message}`));
    child.once('exit', (code, signal) => resolve(signal ? `killed by ${signal}` : `exited with code ${code}`));
  });
  void exited.then(() => {
    owned.delete(entry);
    removeDir(dir);
  });

  const cdp = new Cdp(pipeTransport(child.stdio[3] as Writable, child.stdio[4] as Readable));
  const timeoutMs = opts.launchTimeoutMs ?? 20_000;
  try {
    const version = await Promise.race([
      cdp.send<{ product: string; userAgent: string }>('Browser.getVersion', undefined, { timeoutMs }),
      exited.then((reason) => {
        throw new LaunchFailure(`browser ${reason} during start-up`, err);
      }),
    ]);
    return { child, cdp, dir, version, stderr: () => err, exited };
  } catch (e) {
    cdp.close('launch failed');
    killTree(child);
    // give the dying process a moment to flush stderr: the sandbox message is what decides the retry
    await Promise.race([exited, new Promise((r) => setTimeout(r, 1500))]);
    owned.delete(entry);
    removeDir(dir);
    if (e instanceof LaunchFailure) throw new LaunchFailure(e.message, err);
    throw new LaunchFailure((e as Error).message, err);
  }
}

function lastLines(text: string, n: number): string {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).slice(-n).join(' | ').slice(0, 600);
}

/** Start a browser (or connect to `opts.endpoint`). */
export async function launch(opts: LaunchOptions = {}): Promise<Browser> {
  const t0 = performance.now();
  if (opts.endpoint) return remote(opts.endpoint, t0);

  const env = opts.env ?? process.env;
  const executable = opts.executable ?? findBrowser(env);
  if (!executable) {
    throw new AwError('unsupported', 'no Chromium-family browser found', 'set AGENTWEB_CHROME to a Chrome, Chromium or Edge binary, or run `npx playwright install chromium`');
  }
  if (!existsSync(executable)) throw new AwError('unsupported', `browser binary not found: ${executable}`);

  let noSandbox = opts.noSandbox ?? (env.AGENTWEB_NO_SANDBOX === '1' || needsNoSandbox.has(executable));
  let a: Attempt;
  try {
    a = await attempt(executable, opts, noSandbox);
  } catch (e) {
    const f = e as LaunchFailure;
    if (!noSandbox && opts.noSandbox === undefined && NAMESPACE_ERROR.test(f.stderr ?? '')) {
      // This kernel refuses unprivileged user namespaces, so the sandbox cannot start at all.
      noSandbox = true;
      needsNoSandbox.add(executable);
      try {
        a = await attempt(executable, opts, true);
      } catch (e2) {
        const f2 = e2 as LaunchFailure;
        throw new AwError('internal', `Chromium did not start even without its sandbox: ${f2.message}. ${lastLines(f2.stderr ?? '', 3)}`);
      }
    } else {
      const sandboxy = /sandbox/i.test(f.stderr ?? '');
      throw new AwError('internal', `Chromium did not start: ${f.message}. ${lastLines(f.stderr ?? '', 3)}`, sandboxy ? 'if the sandbox cannot work here (container, root), set AGENTWEB_NO_SANDBOX=1' : undefined);
    }
  }

  const { child, cdp, dir } = a;
  let dead = '';
  const exitFns: ((reason: string) => void)[] = [];
  const die = (reason: string) => {
    if (dead) return;
    dead = reason;
    cdp.close(reason);
    for (const fn of exitFns.splice(0)) {
      try {
        fn(reason);
      } catch {}
    }
  };
  void a.exited.then((reason) => die(`browser process ${reason}`));
  cdp.onClose((reason) => {
    // The pipe closing means the browser is going or gone; make sure nothing lingers.
    if (!dead) killTree(child);
    die(reason);
  });

  // An idle browser must not keep a finished program alive. In-flight calls hold a timer, so the
  // event loop stays up exactly as long as somebody is waiting for an answer.
  child.unref();
  for (const s of child.stdio) (s as any)?.unref?.();

  let memAt = 0;
  let memPss = false;
  let memVal: BrowserMemory = { rss: 0, pss: 0, processes: 0 };

  return {
    cdp,
    pid: child.pid,
    executable,
    product: a.version.product,
    userAgent: a.version.userAgent,
    remote: false,
    noSandbox,
    launchMs: performance.now() - t0,
    alive: () => !dead,
    exitReason: () => dead,
    onExit(fn) {
      if (dead) queueMicrotask(() => fn(dead));
      else exitFns.push(fn);
    },
    async close() {
      if (!dead) {
        try {
          await cdp.send('Browser.close', undefined, { timeoutMs: 2000 });
        } catch {}
        await Promise.race([a.exited, new Promise((r) => setTimeout(r, 2000))]);
      }
      killTree(child);
      die('closed');
      await Promise.race([a.exited, new Promise((r) => setTimeout(r, 2000))]);
      removeDir(dir);
    },
    kill() {
      killTree(child);
    },
    memory(withPss = false) {
      if (dead || child.pid === undefined) return { rss: 0, pss: 0, processes: 0 };
      const now = Date.now();
      if (now - memAt < 1000 && (memPss || !withPss)) return memVal;
      memVal = treeMemory(child.pid, withPss);
      memAt = now;
      memPss = withPss;
      return memVal;
    },
  };
}

async function remote(endpoint: string, t0: number): Promise<Browser> {
  // 'extension:' = the user's own browser through the agentweb extension; the bridge is found (or started) now
  if (/^extension:/i.test(endpoint)) endpoint = await (await import('../../bridge/hub.ts')).bridgeEndpoint();
  const cdp = await connect(endpoint);
  let version: { product: string; userAgent: string };
  try {
    version = await cdp.send('Browser.getVersion', undefined, { timeoutMs: 10_000 });
  } catch (e) {
    cdp.close('handshake failed');
    throw e;
  }
  let dead = '';
  const exitFns: ((reason: string) => void)[] = [];
  cdp.onClose((reason) => {
    dead = reason || 'closed';
    for (const fn of exitFns.splice(0)) {
      try {
        fn(dead);
      } catch {}
    }
  });
  return {
    cdp,
    product: version.product,
    userAgent: version.userAgent,
    remote: true,
    noSandbox: false,
    launchMs: performance.now() - t0,
    alive: () => !dead,
    exitReason: () => dead,
    onExit(fn) {
      if (dead) queueMicrotask(() => fn(dead));
      else exitFns.push(fn);
    },
    async close() {
      cdp.close('closed'); // the browser belongs to somebody else: disconnect, do not shut it down
    },
    kill() {
      cdp.close('closed');
    },
    memory: () => ({ rss: 0, pss: 0, processes: 0 }),
  };
}
