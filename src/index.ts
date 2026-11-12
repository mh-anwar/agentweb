// Composition root: wires the modules into one Runtime. Everything else in src/ depends on
// interfaces only; this is the single place that knows the concrete pieces.

import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRuntime, type RuntimeImpl, type RuntimeOptions } from './runtime.ts';
import { findDevice } from './devices.ts';
import { createJar, createWireEngine, encodeForm } from './net/index.ts';
import { createGuard, isPublicAddress, loadPolicy, scoreInjection, type Policy } from './guard/index.ts';
import { openStore } from './store/index.ts';
import { mineEmbedded, readBody } from './readers/index.ts';
import { search, toBlocks } from './search/index.ts';
import type { Atlas, Engine, Store, Tier } from './types.ts';

export interface AgentwebConfig extends RuntimeOptions {
  /** store URL (memory:, file:/path, sqlite:/path, redis://…, tiered+…) or a Store. Default: sqlite in ~/.agentweb */
  store?: string | Store;
  policy?: Policy;
  /** which script engines to use: 'auto' = when available on this machine (default) */
  ghost?: boolean | 'auto';
  chrome?: boolean | 'auto';
  /** Firefox and WebKit through Playwright (needs playwright-core and its browser builds); 'auto' = when installed */
  firefox?: boolean | 'auto';
  webkit?: boolean | 'auto';
  /** the real browser automatic escalation uses: chrome (default), firefox, or webkit / safari (AGENTWEB_BROWSER) */
  browser?: 'chrome' | 'firefox' | 'webkit';
  /** share fetched public pages between sessions (default true) */
  cache?: boolean;
  /** learn per-site facts and reuse them across sessions (default true) */
  atlas?: boolean;
  /** remote Chromium DevTools endpoint instead of launching one (ws://… or http://host:port) */
  cdp?: string;
  /**
   * With `cdp`: open pages in that browser's default context, the user's own profile and logins
   * (AGENTWEB_CDP_SHARED=1). Off by default: each session otherwise gets an isolated context.
   */
  cdpShared?: boolean;
  /**
   * Use the user's own Chrome through the agentweb browser extension (AGENTWEB_EXTENSION=1): pages
   * open as tabs in their profile, with their sign-ins. Needs the extension from extension/.
   */
  extension?: boolean;
  /** proxy for all traffic: http://[user:pass@]host:port (all engines) or socks5://host:port (chrome only) */
  proxy?: string;
  /** browser window size, default 1280x800 */
  viewport?: { width: number; height: number };
  /** accept invalid TLS certificates in the browser */
  ignoreHttpsErrors?: boolean;
  env?: Record<string, string | undefined>;
}

export function defaultStoreUrl(env: Record<string, string | undefined> = process.env): string {
  if (env.AGENTWEB_STORE) return env.AGENTWEB_STORE;
  const dir = env.AGENTWEB_HOME ?? join(homedir(), '.agentweb');
  mkdirSync(dir, { recursive: true });
  return 'sqlite:' + join(dir, 'state.db');
}

export async function createAgentweb(config: AgentwebConfig = {}): Promise<RuntimeImpl> {
  const env = config.env ?? process.env;
  const policy = config.policy ?? loadPolicy(env);
  let store: Store;
  if (typeof config.store === 'object') store = config.store;
  else {
    const url = config.store ?? defaultStoreUrl(env);
    try {
      store = await openStore(url);
    } catch (e) {
      if (config.store || env.AGENTWEB_STORE) throw e;
      store = await openStore('memory:'); // no sqlite in this Node: keep working, without persistence
    }
  }

  const proxy = config.proxy ?? env.AGENTWEB_PROXY ?? undefined;
  const socks = !!proxy && /^socks/i.test(proxy);
  const wire = createWireEngine({
    proxy: proxy && !socks ? proxy : undefined,
    checkAddress: policy.allowPrivate ? undefined : (ip: string) => isPublicAddress(ip),
    cache: config.cache === false ? undefined : store,
  });
  const engines: Partial<Record<Tier, Engine>> & { wire: Engine } = { wire };

  const want = (v: boolean | 'auto' | undefined, envName: string) => (v === undefined ? env[envName] !== '0' && env[envName] !== 'off' : v !== false);
  if (want(config.ghost, 'AGENTWEB_GHOST')) {
    try {
      const mod = await import('./engines/ghost/index.ts');
      // ghost page requests go through the wire engine's connection pool and its address check
      engines.ghost = mod.createGhostEngine({ fetch: mod.defaultFetch({ dispatcher: wire.dispatcher }) });
    } catch {
      // the ghost engine or its DOM dependency is not installed: the other tiers still work
    }
  }
  if (want(config.chrome, 'AGENTWEB_CHROME_ENGINE')) {
    try {
      const mod = await import('./engines/chrome/index.ts');
      const vp = /^(\d{3,4})\s*[x,]\s*(\d{3,4})$/.exec(env.AGENTWEB_VIEWPORT ?? '');
      const dl = env.AGENTWEB_DOWNLOADS;
      // The user's own browser through the agentweb extension is a shared DevTools endpoint found through
      // the bridge. AGENTWEB_EXTENSION=1 sends every session there; otherwise a session asks with engine('mine').
      const viaExtension = config.extension ?? /^(1|true|yes|on)$/i.test(env.AGENTWEB_EXTENSION ?? '');
      if (viaExtension) void import('./bridge/hub.ts').then((m) => m.bridgeEndpoint(env)).catch(() => {}); // listen now, so the extension is connected by the first call
      const common = {
        proxy: proxy ? proxy.replace(/\/\/[^@/]*@/, '//') : undefined,
        viewport: config.viewport ?? (vp ? { width: Number(vp[1]), height: Number(vp[2]) } : undefined),
        downloadDir: dl === 'off' || dl === '0' ? (false as const) : dl || undefined,
      };
      const isolated = mod.createChromeEngine({
        ...common,
        endpoint: viaExtension ? 'extension:' : config.cdp ?? env.AGENTWEB_CDP,
        shared: viaExtension || (config.cdpShared ?? /^(1|true|yes|on)$/i.test(env.AGENTWEB_CDP_SHARED ?? '')),
        args: config.ignoreHttpsErrors || /^(1|true|yes|on)$/i.test(env.AGENTWEB_IGNORE_HTTPS_ERRORS ?? '') ? ['--ignore-certificate-errors'] : undefined,
      });
      let own: Engine | undefined;
      const mine = () => (own ??= mod.createChromeEngine({ ...common, proxy: undefined, endpoint: 'extension:', shared: true }));
      const pick = (ctx: { own?: boolean }) => (ctx.own && !viaExtension ? mine() : isolated);
      engines.chrome = {
        tier: 'chrome',
        available: () => isolated.available(),
        open: (ctx, req) => pick(ctx).open(ctx, req),
        act: (ctx, action) => pick(ctx).act!(ctx, action),
        snapshot: (ctx) => pick(ctx).snapshot!(ctx),
        live: (id) => !!isolated.live?.(id) || !!own?.live?.(id),
        release: async (id) => {
          await Promise.all([isolated.release(id), own?.release(id)]);
        },
        close: async () => {
          await Promise.all([isolated.close(), own?.close()]);
        },
        stats: () => isolated.stats?.() ?? {},
      };
    } catch {
      // no chrome engine in this build
    }
  }

  // Firefox and WebKit: creating them costs nothing; playwright-core is loaded the first time one is asked for
  for (const b of ['firefox', 'webkit'] as const) {
    if (!want(config[b], b === 'firefox' ? 'AGENTWEB_FIREFOX_ENGINE' : 'AGENTWEB_WEBKIT_ENGINE')) continue;
    try {
      const mod = await import('./engines/playwright/index.ts');
      engines[b] = mod.createPlaywrightEngine({ browser: b });
    } catch {
      // no playwright engine in this build
    }
  }
  const asked = String(config.browser ?? env.AGENTWEB_BROWSER ?? '').toLowerCase().trim();
  const browser = asked === 'safari' ? 'webkit' : asked === 'firefox' || asked === 'webkit' || asked === 'chrome' ? asked : undefined;

  let atlas: Atlas | undefined;
  if (config.atlas !== false && env.AGENTWEB_ATLAS !== '0') {
    try {
      const mod = await import('./atlas/index.ts');
      atlas = mod.createAtlas(store);
    } catch {
      // atlas module absent
    }
  }

  const rt = createRuntime({
    store,
    engines,
    createJar,
    createGuard: (state) => createGuard(policy, state),
    encodeForm,
    readBody,
    mineEmbedded,
    search: (q, o) => search(q, o),
    searchBlocks: (results, q) => toBlocks(results, q),
    atlas,
    scoreInjection: (t) => scoreInjection(t).score,
    options: {
      budget: config.budget ?? (env.AGENTWEB_BUDGET ? Number(env.AGENTWEB_BUDGET) : undefined),
      timeoutMs: config.timeoutMs,
      runTimeoutMs: config.runTimeoutMs,
      userAgent: config.userAgent ?? env.AGENTWEB_USER_AGENT,
      defaultEngine: socks ? 'chrome' : undefined,
      emulate: env.AGENTWEB_DEVICE ? findDevice(env.AGENTWEB_DEVICE)?.emu : undefined,
      sessionTtlSec: config.sessionTtlSec,
      secretNames: policy.secrets.map((x) => x.name),
      browser,
      // drop() reads files from the downloads folder, AGENTWEB_FILES (a path list) and the working directory
      fileRoots: [
        env.AGENTWEB_DOWNLOADS && !/^(off|0)$/.test(env.AGENTWEB_DOWNLOADS) ? env.AGENTWEB_DOWNLOADS : join(env.AGENTWEB_HOME ?? join(homedir(), '.agentweb'), 'downloads'),
        ...(env.AGENTWEB_FILES ?? '').split(delimiter).filter(Boolean),
      ],
    },
  });

  // verb packs (literal import paths, so the bundler includes them)
  (await import('./extract/index.ts')).register(rt);
  (await import('./programs/index.ts')).register(rt, env);
  (await import('./schedule/index.ts')).register(rt, env);
  (await import('./sitemap/index.ts')).register(rt);
  (await import('./docs/index.ts')).register(rt);
  return rt;
}

export { createRuntime, RuntimeImpl, RunCtx, normalizeUrl } from './runtime.ts';
export type { RuntimeDeps, RuntimeOptions, VerbHandler } from './runtime.ts';
export { parseProgram } from './dsl.ts';
export { compile } from './compile.ts';
export { parseHtml } from './parse.ts';
export { renderView, renderFind, renderRead } from './render.ts';
export { estimateTokens } from './tokens.ts';
export { TOOL } from './tooldoc.ts';
export * from './types.ts';
