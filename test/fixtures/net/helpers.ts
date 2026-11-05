// Shared helpers for the wire-engine tests: a fake Guard, a SessionCtx factory and an in-memory Store.

import type { Guard, SessionCtx, Store, Verdict } from '../../../src/types.ts';
import { createJar } from '../../../src/net/cookies.ts';

export function fakeGuard(deny?: (url: string, why: string) => string | undefined): Guard & { calls: { url: string; why: string }[] } {
  const calls: { url: string; why: string }[] = [];
  return {
    calls,
    async checkUrl(url, why): Promise<Verdict> {
      calls.push({ url, why });
      const r = deny?.(url, why);
      return r ? { ok: false, reason: r } : { ok: true };
    },
    async checkStep() { return { ok: true }; },
    reveal: (t) => t,
    redact: (t) => t,
    observe() {},
    checkOutflow: () => ({ ok: true }),
    state: () => ({}),
  };
}

export function makeCtx(over: Partial<SessionCtx> = {}): SessionCtx {
  return {
    id: 's1',
    jar: createJar(),
    storage: {},
    userAgent: 'agentweb-test/1.0',
    guard: fakeGuard(),
    timeoutMs: 5000,
    ...over,
  };
}

/** Minimal Store: values kept by reference, TTL honoured lazily. */
export function memStore(): Store & { map: Map<string, { v: unknown; exp: number }> } {
  const map = new Map<string, { v: unknown; exp: number }>();
  const k = (ns: string, key: string) => `${ns}\u0000${key}`;
  return {
    map,
    async get<T>(ns: string, key: string) {
      const e = map.get(k(ns, key));
      if (!e) return undefined;
      if (e.exp && e.exp <= Date.now()) { map.delete(k(ns, key)); return undefined; }
      return e.v as T;
    },
    async set(ns, key, value, ttlSec) { map.set(k(ns, key), { v: value, exp: ttlSec ? Date.now() + ttlSec * 1000 : 0 }); },
    async del(ns, key) { map.delete(k(ns, key)); },
    async keys(ns, prefix = '', limit = 1000) {
      const out: string[] = [];
      for (const key of map.keys()) {
        const [n, rest] = key.split('\u0000');
        if (n === ns && rest.startsWith(prefix)) out.push(rest);
        if (out.length >= limit) break;
      }
      return out;
    },
    async close() {},
  };
}
