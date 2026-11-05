// Shared value handling for every store: validation of namespaces and keys, JSON
// serialisation with defined edge-case behaviour, and the one-byte-tagged binary codec
// (raw JSON or gzip) used at rest by the file, sqlite and redis stores.

import { gzip, gunzip, gzipSync, gunzipSync } from 'node:zlib';
import { promisify } from 'node:util';
import { AwError } from '../types.ts';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Codec tags: the first byte of every stored blob. */
export const TAG_RAW = 0x00;
export const TAG_GZIP = 0x01;

/** Longest namespace / key accepted, in UTF-16 code units. */
export const MAX_NS_LENGTH = 256;
export const MAX_KEY_LENGTH = 2048;

/** Values at or above this size are (de)compressed on the libuv threadpool instead of inline. */
const ASYNC_ZLIB_THRESHOLD = 64 * 1024;

export interface CodecOptions {
  /** gzip values whose JSON is at least this many bytes (default 1024; Infinity disables) */
  gzipAbove?: number;
  /** zlib level 1..9 (default 4: on 200 KB session JSON, 2.3x faster than 6 for 4% more bytes) */
  gzipLevel?: number;
}

export function closedError(name: string): AwError {
  return new AwError('internal', `${name} store is closed`, 'open a new store');
}

/**
 * Namespaces and keys must be well-formed strings (no lone surrogates, which would be
 * silently replaced by U+FFFD in UTF-8 and make two distinct keys collide).
 */
/** String.prototype.isWellFormed (ES2024; the tsconfig lib is ES2023). */
function wellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

export function checkNsKey(ns: string, key: string): void {
  checkNs(ns);
  if (typeof key !== 'string') throw new AwError('bad_request', 'store key must be a string');
  if (key.length > MAX_KEY_LENGTH) throw new AwError('too_large', `store key longer than ${MAX_KEY_LENGTH} chars`);
  if (!wellFormed(key)) throw new AwError('bad_request', 'store key contains a lone surrogate');
}

export function checkNs(ns: string): void {
  if (typeof ns !== 'string') throw new AwError('bad_request', 'store namespace must be a string');
  if (ns.length > MAX_NS_LENGTH) throw new AwError('too_large', `store namespace longer than ${MAX_NS_LENGTH} chars`);
  if (!wellFormed(ns)) throw new AwError('bad_request', 'store namespace contains a lone surrogate');
}

export function checkPrefix(prefix: string | undefined): string {
  if (prefix === undefined) return '';
  if (typeof prefix !== 'string' || !wellFormed(prefix)) throw new AwError('bad_request', 'key prefix must be a well-formed string');
  return prefix;
}

export function checkLimit(limit: number | undefined, dflt = 1000): number {
  if (limit === undefined) return dflt;
  if (typeof limit !== 'number' || Number.isNaN(limit) || limit < 0) throw new AwError('bad_request', 'keys limit must be a non-negative number');
  return limit === Infinity ? Infinity : Math.floor(limit);
}

/**
 * Converts a ttl in seconds to an absolute expiry in epoch ms; 0 means "never expires".
 * `undefined`, `0` and non-finite values mean no expiry; negative ttl is rejected.
 */
export function expiryFor(ttlSec: number | undefined, now = Date.now()): number {
  if (ttlSec === undefined || ttlSec === 0 || ttlSec === Infinity) return 0;
  if (typeof ttlSec !== 'number' || Number.isNaN(ttlSec) || ttlSec < 0) throw new AwError('bad_request', 'ttlSec must be a non-negative number');
  return now + Math.max(1, Math.round(ttlSec * 1000));
}

/**
 * JSON-serialises a value. Defined behaviour for non-JSON input:
 *  - top-level `undefined` returns `undefined` (callers treat `set(…, undefined)` as `del`)
 *  - functions / symbols at the top level, BigInt anywhere and cycles throw `bad_request`
 *  - everything else follows JSON.stringify (NaN → null, nested undefined dropped, Date → ISO string)
 */
export function toJson(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let s: string | undefined;
  try {
    s = JSON.stringify(value);
  } catch (e) {
    throw new AwError('bad_request', `store value is not JSON-serialisable: ${(e as Error).message}`);
  }
  if (s === undefined) throw new AwError('bad_request', `store value of type ${typeof value} is not JSON-serialisable`);
  return s;
}

export function fromJson<T>(s: string): T {
  return JSON.parse(s) as T;
}

/** Encodes JSON text into a tagged blob: [tag][payload]. */
export async function encodeBlob(json: string, opts: CodecOptions = {}): Promise<Buffer> {
  const raw = Buffer.from(json, 'utf8');
  const above = opts.gzipAbove ?? 1024;
  if (raw.length < above) return tag(TAG_RAW, raw);
  const level = opts.gzipLevel ?? 4;
  const z = raw.length >= ASYNC_ZLIB_THRESHOLD
    ? await gzipAsync(raw, { level })
    : gzipSync(raw, { level });
  // Only keep the compressed form if it actually saves something.
  return z.length < raw.length ? tag(TAG_GZIP, z) : tag(TAG_RAW, raw);
}

export function encodeBlobSync(json: string, opts: CodecOptions = {}): Buffer {
  const raw = Buffer.from(json, 'utf8');
  if (raw.length < (opts.gzipAbove ?? 1024)) return tag(TAG_RAW, raw);
  const z = gzipSync(raw, { level: opts.gzipLevel ?? 4 });
  return z.length < raw.length ? tag(TAG_GZIP, z) : tag(TAG_RAW, raw);
}

function tag(t: number, payload: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length + 1);
  out[0] = t;
  payload.copy(out, 1);
  return out;
}

/** Decodes a tagged blob back to JSON text. Throws on an unknown tag or a damaged gzip stream. */
export async function decodeBlob(blob: Uint8Array): Promise<string> {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (buf.length === 0) throw new Error('empty blob');
  const t = buf[0];
  const body = buf.subarray(1);
  if (t === TAG_RAW) return body.toString('utf8');
  if (t === TAG_GZIP) {
    const out = body.length >= ASYNC_ZLIB_THRESHOLD / 4
      ? await gunzipAsync(body)
      : gunzipSync(body);
    return out.toString('utf8');
  }
  throw new Error(`unknown codec tag 0x${t.toString(16)}`);
}

export function decodeBlobSync(blob: Uint8Array): string {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  if (buf.length === 0) throw new Error('empty blob');
  const t = buf[0];
  const body = buf.subarray(1);
  if (t === TAG_RAW) return body.toString('utf8');
  if (t === TAG_GZIP) return gunzipSync(body).toString('utf8');
  throw new Error(`unknown codec tag 0x${t.toString(16)}`);
}

/** Tracks in-flight async operations so `close()` can wait for them. */
export class Pending {
  private n = 0;
  private waiters: Array<() => void> = [];
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.n++;
    try {
      return await fn();
    } finally {
      if (--this.n === 0) for (const w of this.waiters.splice(0)) w();
    }
  }
  idle(): Promise<void> {
    if (this.n === 0) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }
}
