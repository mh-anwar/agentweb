// Composition root: wires the modules into one Runtime. Everything else in src/ depends on
// interfaces only; this is the single place that knows the concrete pieces.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRuntime, type RuntimeImpl, type RuntimeOptions } from './runtime.ts';
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
  /** share fetched public pages between sessions (default true) */
  cache?: boolean;
  /** learn per-site facts and reuse them across sessions (default true) */
  atlas?: boolean;
  /** remote Chromium DevTools endpoint instead of launching one (ws://… or http://host:port) */
  cdp?: string;
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

  const wire = createWireEngine({
    checkAddress: policy.allowPrivate ? undefined : (ip: string) => isPublicAddress(ip),
    cache: config.cache === false ? undefined : store,
  });
  const engines: Partial<Record<Tier, Engine>> & { wire: Engine } = { wire };

  const want = (v: boolean | 'auto' | undefined, envName: string) => (v === undefined ? env[envName] !== '0' && env[envName] !== 'off' : v !== false);
  if (want(config.ghost, 'AGENTWEB_GHOST')) {
    try {
      const mod = await import('./engines/ghost/index.ts');
      engines.ghost = mod.createGhostEngine({});
    } catch {
      // the ghost engine or its DOM dependency is not installed: the other tiers still work
    }
  }
  if (want(config.chrome, 'AGENTWEB_CHROME_ENGINE')) {
    try {
      const mod = await import('./engines/chrome/index.ts');
      engines.chrome = mod.createChromeEngine({ endpoint: config.cdp ?? env.AGENTWEB_CDP });
    } catch {
      // no chrome engine in this build
    }
  }

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
      sessionTtlSec: config.sessionTtlSec,
    },
  });

  // optional verb packs
  for (const pack of ['./extract/index.ts', './watch/index.ts']) {
    try {
      const mod = await import(pack);
      mod.register?.(rt);
    } catch {
      // pack absent
    }
  }
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
