// Public surface of the storage layer.
//
//   openStore('memory:')                         in-process LRU
//   openStore('memory:?maxBytes=67108864')
//   openStore('file:/var/lib/agentweb')           directory store (also file:///abs, file:./rel)
//   openStore('sqlite:/var/lib/agentweb/aw.db')   node:sqlite store (sqlite::memory: for RAM)
//   openStore('redis://user:pass@host:6379/2')    Redis (rediss:// for TLS)
//   openStore('tiered+redis://host')              2 s L1 memory cache in front of any of the above
//
// Query parameters set numeric / boolean options (gzipAbove, gzipLevel, maxBytes,
// maxEntries, fsync, prefix, l1TtlMs, …); `opts` wins over the URL.

import type { Store } from '../types.ts';
import { AwError } from '../types.ts';
import { MemoryStore, type MemoryStoreOptions } from './memory.ts';
import { FileStore, type FileStoreOptions } from './file.ts';
import { SqliteStore, type SqliteStoreOptions } from './sqlite.ts';
import { RedisStore, type RedisStoreOptions, parseRedisUrl } from './redis.ts';
import { TieredStore, type TieredStoreOptions } from './tiered.ts';

export { MemoryStore, type MemoryStoreOptions, ENTRY_OVERHEAD } from './memory.ts';
export { FileStore, type FileStoreOptions, encodeName, decodeName } from './file.ts';
export { SqliteStore, type SqliteStoreOptions } from './sqlite.ts';
export { RedisClient, RedisStore, RedisError, parseRedisUrl, type RedisClientOptions, type RedisStoreOptions, type RedisUrl } from './redis.ts';
export { RespParser, encodeCommand, type RespValue } from './resp.ts';
export { TieredStore, type TieredStoreOptions } from './tiered.ts';
export { TAG_RAW, TAG_GZIP, encodeBlob, decodeBlob, toJson } from './codec.ts';

export type OpenStoreOptions =
  & MemoryStoreOptions & FileStoreOptions & SqliteStoreOptions & Omit<RedisStoreOptions, 'tls'>
  & { tiered?: TieredStoreOptions; tls?: RedisStoreOptions['tls'];
      /** redis: ms to wait for the first connection before failing (default 5000; 0 = do not wait) */
      waitMs?: number };

function splitQuery(s: string): [string, Record<string, unknown>] {
  const q = s.indexOf('?');
  if (q === -1) return [s, {}];
  const params: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(s.slice(q + 1))) params[k] = coerce(v);
  return [s.slice(0, q), params];
}

function coerce(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'Infinity') return Infinity;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function fsPath(rest: string, scheme: string): string {
  let p = rest;
  if (p.startsWith('//')) {
    // file:///abs/path or file://localhost/abs/path
    p = p.slice(2);
    const slash = p.indexOf('/');
    const host = slash === -1 ? p : p.slice(0, slash);
    if (host && host !== 'localhost') throw new AwError('bad_request', `${scheme}: URLs cannot name a remote host`);
    p = slash === -1 ? '' : p.slice(slash);
  }
  p = decodeURIComponent(p);
  if (!p) throw new AwError('bad_request', `${scheme}: URL needs a path, e.g. ${scheme}:/var/lib/agentweb`);
  return p;
}

/** Opens a store from a URL. See the module comment for the accepted forms. */
export async function openStore(url: string, opts: OpenStoreOptions = {}): Promise<Store> {
  if (typeof url !== 'string' || !url) throw new AwError('bad_request', 'store URL is empty');
  if (url.startsWith('tiered+')) {
    const [, params] = splitQuery(url);
    const inner = await openStore(url.slice('tiered+'.length), opts);
    const t: TieredStoreOptions = { ...pick(params, ['l1TtlMs', 'negativeTtlMs']), ...opts.tiered };
    if (params.l1MaxBytes !== undefined || params.l1MaxEntries !== undefined) {
      t.l1 = { maxBytes: params.l1MaxBytes as number, maxEntries: params.l1MaxEntries as number, ...t.l1 };
    }
    return new TieredStore(inner, t);
  }
  const colon = url.indexOf(':');
  const scheme = url.slice(0, colon).toLowerCase();
  const [rest, params] = splitQuery(url.slice(colon + 1));
  const o = { ...params, ...opts } as OpenStoreOptions;
  switch (scheme) {
    case 'memory':
      return new MemoryStore(o);
    case 'file':
      return new FileStore(fsPath(rest, 'file'), o);
    case 'sqlite': {
      const p = rest === ':memory:' || rest === '//:memory:' ? ':memory:' : fsPath(rest, 'sqlite');
      return new SqliteStore(p, o);
    }
    case 'redis':
    case 'rediss': {
      const u = parseRedisUrl(url);
      const store = new RedisStore(
        { host: u.host, port: u.port, tls: u.tls, username: u.username, password: u.password, db: u.db, protocol: u.params.protocol === '3' ? 3 : 2 },
        { ...o, tls: o.tls ?? u.tls },
      );
      const wait = o.waitMs ?? 5000;
      if (wait > 0) {
        try {
          await store.client.waitReady(wait);
        } catch (e) {
          await store.close();
          throw e;
        }
      }
      return store;
    }
    default:
      throw new AwError('bad_request', `unknown store URL "${url}"`, 'use memory:, file:/path, sqlite:/path, redis://host or tiered+<url>');
  }
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
