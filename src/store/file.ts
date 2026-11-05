// Directory store: one file per record.
//
// Layout   <root>/<ns dir>/<shard>/<record>
//            ns dir  = "n" + enc(ns)             (or "h" + sha256 if the encoding is too long)
//            shard   = 2 hex digits of FNV-1a(key) (256 shards per namespace)
//            record  = "k" + enc(key)            (or "h" + sha256 if the encoding is too long)
//          enc() keeps [a-z0-9_-], writes A-Z as "^" + lower case (safe on case-insensitive file
//          systems) and every other UTF-8 byte as "=xx". Encoded names never start with ".",
//          so temp files (".t…") and tombstones (".x…") can never collide with a record.
//
// Record   magic "AWv1" | exp f64 BE (epoch ms, 0 = never) | keyLen u32 | bodyLen u32 |
//          crc32(key ‖ body) u32 | key (UTF-8) | body = tagged blob (see codec.ts)
//          The key is stored so hashed names can be listed and hash collisions detected; the
//          CRC catches torn or damaged files, which read as missing (and are counted).
//
// Writes go to a unique temp file in the shard directory and are renamed over the record,
// so a reader in any process sees the old record or the new one, never a mix. Expired
// records are removed lazily on read and by a background sweep that walks one shard per
// tick; removal grabs the file with rename() first and puts it back with link() if a fresh
// write landed in between, so a sweeper in one process can never delete another
// process's newer record.

import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, link } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { dirname, join } from 'node:path';
import type { Store } from '../types.ts';
import { AwError } from '../types.ts';
import {
  type CodecOptions, Pending, checkLimit, checkNs, checkNsKey, checkPrefix, closedError,
  decodeBlob, encodeBlob, expiryFor, fromJson, toJson,
} from './codec.ts';

export interface FileStoreOptions extends CodecOptions {
  /** fsync file and directory on every write (default false: atomic but not crash-durable across power loss) */
  fsync?: boolean;
  /** time for one full background sweep over all 256 shards (default 10 min; 0 disables) */
  sweepIntervalMs?: number;
  /** temp files older than this are crash leftovers and get removed by the sweep (default 10 min) */
  tempMaxAgeMs?: number;
  /** clock, for tests */
  now?: () => number;
}

const MAGIC = 0x41577631; // "AWv1"
const HEADER = 24;
const MAX_NAME = 200;
const SHARDS = 256;

let tmpSeq = 0;
const tmpTag = `${process.pid.toString(36)}-${randomBytes(3).toString('hex')}`;

// ───────────── names ─────────────

export function encodeName(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d) out += s[i];
    else if (c >= 0x41 && c <= 0x5a) out += '^' + String.fromCharCode(c + 32);
    else {
      // encode the whole code point (surrogate pairs included) as UTF-8 bytes
      const cp = s.codePointAt(i)!;
      if (cp > 0xffff) i++;
      for (const b of Buffer.from(String.fromCodePoint(cp), 'utf8')) out += '=' + b.toString(16).padStart(2, '0');
    }
  }
  return out;
}

export function decodeName(s: string): string | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '^') {
      const n = s.charCodeAt(++i);
      if (!(n >= 0x61 && n <= 0x7a)) return undefined;
      bytes.push(n - 32);
    } else if (ch === '=') {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9a-f]{2}$/.test(hex)) return undefined;
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(s.charCodeAt(i));
  }
  const out = Buffer.from(bytes).toString('utf8');
  // only canonical encodings round-trip; anything else is not one of our names
  return encodeName(out) === s ? out : undefined;
}

function fileName(key: string): string {
  const e = encodeName(key);
  return e.length <= MAX_NAME ? 'k' + e : 'h' + createHash('sha256').update(key).digest('hex');
}

function nsDirName(ns: string): string {
  const e = encodeName(ns);
  return e.length <= MAX_NAME ? 'n' + e : 'h' + createHash('sha256').update(ns).digest('hex');
}

function shardOf(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h ^ (h >>> 8) ^ (h >>> 16) ^ (h >>> 24)) & 0xff).toString(16).padStart(2, '0');
}

// ───────────── record format ─────────────

function frame(key: string, body: Buffer, exp: number): Buffer {
  const k = Buffer.from(key, 'utf8');
  const out = Buffer.allocUnsafe(HEADER + k.length + body.length);
  out.writeUInt32BE(MAGIC, 0);
  out.writeDoubleBE(exp, 4);
  out.writeUInt32BE(k.length, 12);
  out.writeUInt32BE(body.length, 16);
  k.copy(out, HEADER);
  body.copy(out, HEADER + k.length);
  out.writeUInt32BE(crc32(out.subarray(HEADER)), 20);
  return out;
}

interface Head {
  exp: number;
  key: string;
}

/** Parses a full record; returns undefined if it is torn or damaged. */
function unframe(buf: Buffer): (Head & { body: Buffer }) | undefined {
  if (buf.length < HEADER || buf.readUInt32BE(0) !== MAGIC) return undefined;
  const exp = buf.readDoubleBE(4);
  const kl = buf.readUInt32BE(12);
  const bl = buf.readUInt32BE(16);
  if (buf.length !== HEADER + kl + bl) return undefined;
  if (crc32(buf.subarray(HEADER)) !== buf.readUInt32BE(20)) return undefined;
  return { exp, key: buf.toString('utf8', HEADER, HEADER + kl), body: buf.subarray(HEADER + kl) };
}

/** Reads just the header and key of a record file (no CRC check). */
async function readHead(path: string): Promise<(Head & { size: number }) | undefined> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  try {
    const first = Buffer.allocUnsafe(512);
    const { bytesRead } = await fh.read(first, 0, 512, 0);
    if (bytesRead < HEADER || first.readUInt32BE(0) !== MAGIC) return undefined;
    const kl = first.readUInt32BE(12);
    const size = HEADER + kl + first.readUInt32BE(16);
    let kb: Buffer;
    if (HEADER + kl <= bytesRead) kb = first.subarray(HEADER, HEADER + kl);
    else {
      if (kl > 64 * 1024) return undefined;
      kb = Buffer.allocUnsafe(kl);
      const r = await fh.read(kb, 0, kl, HEADER);
      if (r.bytesRead !== kl) return undefined;
    }
    return { exp: first.readDoubleBE(4), key: kb.toString('utf8'), size };
  } finally {
    await fh.close();
  }
}

const isNoEnt = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT';

// ───────────── store ─────────────

export class FileStore implements Store {
  readonly root: string;
  private readonly opts: FileStoreOptions;
  private readonly now: () => number;
  private readonly pending = new Pending();
  private readonly knownDirs = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private sweepShard = 0;
  private sweeping = false;
  private readonly tally = new Map<string, { entries: number; bytes: number }>();
  private c = { hits: 0, misses: 0, sets: 0, dels: 0, expired: 0, corrupt: 0, tempsRemoved: 0, sweeps: 0 };

  constructor(root: string, opts: FileStoreOptions = {}) {
    if (!root) throw new AwError('bad_request', 'file store needs a directory');
    this.root = root;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    const full = opts.sweepIntervalMs ?? 10 * 60_000;
    if (full > 0) {
      this.timer = setInterval(() => void this.sweepTick(), Math.max(50, Math.floor(full / SHARDS)));
      this.timer.unref();
    }
  }

  private pathOf(ns: string, key: string): { dir: string; file: string } {
    const dir = join(this.root, nsDirName(ns), shardOf(key));
    return { dir, file: join(dir, fileName(key)) };
  }

  async get<T = unknown>(ns: string, key: string): Promise<T | undefined> {
    this.live();
    checkNsKey(ns, key);
    return this.pending.run(async () => {
      const { file } = this.pathOf(ns, key);
      let buf: Buffer;
      try {
        buf = await readFile(file);
      } catch (e) {
        if (isNoEnt(e)) { this.c.misses++; return undefined; }
        throw e;
      }
      const rec = unframe(buf);
      if (!rec || rec.key !== key) {
        // a damaged file, or (astronomically unlikely) a sha256 collision of two long keys
        if (!rec) this.c.corrupt++;
        this.c.misses++;
        return undefined;
      }
      if (rec.exp !== 0 && rec.exp <= this.now()) {
        this.c.expired++;
        this.c.misses++;
        await this.removeExpired(file);
        return undefined;
      }
      let json: string;
      try {
        json = await decodeBlob(rec.body);
      } catch {
        this.c.corrupt++;
        this.c.misses++;
        return undefined;
      }
      this.c.hits++;
      return fromJson<T>(json);
    });
  }

  async set<T = unknown>(ns: string, key: string, value: T, ttlSec?: number): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    const exp = expiryFor(ttlSec, this.now());
    const json = toJson(value);
    if (json === undefined) return this.del(ns, key);
    return this.pending.run(async () => {
      const body = await encodeBlob(json, this.opts);
      const { dir, file } = this.pathOf(ns, key);
      await this.writeAtomic(dir, file, frame(key, body, exp));
      this.c.sets++;
    });
  }

  async del(ns: string, key: string): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    return this.pending.run(async () => {
      try {
        await unlink(this.pathOf(ns, key).file);
        this.c.dels++;
      } catch (e) {
        if (!isNoEnt(e)) throw e;
      }
    });
  }

  async keys(ns: string, prefix?: string, limit?: number): Promise<string[]> {
    this.live();
    checkNs(ns);
    const p = checkPrefix(prefix);
    const max = checkLimit(limit);
    return this.pending.run(async () => {
      const out: string[] = [];
      if (max === 0) return out;
      const nsDir = join(this.root, nsDirName(ns));
      const shards = await readdir(nsDir).catch((e) => { if (isNoEnt(e)) return [] as string[]; throw e; });
      const now = this.now();
      for (const shard of shards.sort()) {
        if (shard.length !== 2) continue;
        const names = await readdir(join(nsDir, shard)).catch((e) => { if (isNoEnt(e)) return [] as string[]; throw e; });
        for (const name of names) {
          let key: string | undefined;
          if (name[0] === 'k') {
            key = decodeName(name.slice(1));
            if (key === undefined || (p && !key.startsWith(p))) continue;
          } else if (name[0] !== 'h') continue;
          const head = await readHead(join(nsDir, shard, name));
          if (!head || (head.exp !== 0 && head.exp <= now)) continue;
          if (key !== undefined && head.key !== key) continue;
          if (p && !head.key.startsWith(p)) continue;
          out.push(head.key);
          if (out.length >= max) return out;
        }
      }
      return out;
    });
  }

  stats(): Record<string, number> {
    let entries = 0;
    let bytes = 0;
    for (const t of this.tally.values()) { entries += t.entries; bytes += t.bytes; }
    // entries/bytes are what the background sweep last saw (approximate, refreshed per shard)
    return { entries, bytes, evictions: 0, ...this.c };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pending.idle();
  }

  /** Runs one full sweep over every shard now (removes expired records and stale temp files). */
  async sweepAll(): Promise<void> {
    this.live();
    for (let i = 0; i < SHARDS; i++) await this.pending.run(() => this.sweepOne(i.toString(16).padStart(2, '0')));
  }

  // ───────────── internals ─────────────

  private async writeAtomic(dir: string, file: string, data: Buffer): Promise<void> {
    const tmp = join(dir, `.t${tmpTag}-${(tmpSeq++).toString(36)}`);
    if (!this.knownDirs.has(dir)) {
      await mkdir(dir, { recursive: true });
      this.knownDirs.add(dir);
    }
    try {
      await this.writeFileTo(tmp, data);
    } catch (e) {
      if (!isNoEnt(e)) throw e;
      // the directory was removed under us (another process, or an operator): recreate it
      await mkdir(dir, { recursive: true });
      await this.writeFileTo(tmp, data);
    }
    try {
      await rename(tmp, file);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      throw e;
    }
    if (this.opts.fsync) {
      const dh = await open(dir, 'r');
      try { await dh.sync(); } finally { await dh.close(); }
    }
  }

  private async writeFileTo(path: string, data: Buffer): Promise<void> {
    const fh = await open(path, 'wx');
    try {
      let off = 0;
      while (off < data.length) {
        const { bytesWritten } = await fh.write(data, off, data.length - off, off);
        off += bytesWritten;
      }
      if (this.opts.fsync) await fh.datasync();
    } catch (e) {
      await fh.close().catch(() => {});
      await unlink(path).catch(() => {});
      throw e;
    }
    await fh.close();
  }

  /**
   * Removes a record only if it is (still) expired. The file is grabbed with an atomic
   * rename; if what we grabbed turns out to be fresh (another process rewrote it after we
   * looked), it is linked back unless an even newer record already took its place.
   */
  private async removeExpired(file: string): Promise<boolean> {
    const tomb = join(dirname(file), `.x${tmpTag}-${(tmpSeq++).toString(36)}`);
    try {
      await rename(file, tomb);
    } catch (e) {
      if (isNoEnt(e)) return false;
      throw e;
    }
    const head = await readHead(tomb).catch(() => undefined);
    if (head && !(head.exp !== 0 && head.exp <= this.now())) {
      await link(tomb, file).catch(() => {}); // EEXIST: a newer record is already there
      await unlink(tomb).catch(() => {});
      return false;
    }
    await unlink(tomb).catch(() => {});
    return true;
  }

  private async sweepTick(): Promise<void> {
    if (this.closed || this.sweeping) return;
    this.sweeping = true;
    const shard = this.sweepShard.toString(16).padStart(2, '0');
    this.sweepShard = (this.sweepShard + 1) % SHARDS;
    try {
      await this.pending.run(() => this.sweepOne(shard));
    } catch {
      // a background sweep must never crash the process; the next tick tries again
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOne(shard: string): Promise<void> {
    const nsDirs = await readdir(this.root).catch((e) => { if (isNoEnt(e)) return [] as string[]; throw e; });
    const now = this.now();
    const tempMax = this.opts.tempMaxAgeMs ?? 10 * 60_000;
    let entries = 0;
    let bytes = 0;
    for (const nsd of nsDirs) {
      if (nsd[0] !== 'n' && nsd[0] !== 'h') continue;
      const dir = join(this.root, nsd, shard);
      const names = await readdir(dir).catch((e) => { if (isNoEnt(e) || (e as NodeJS.ErrnoException).code === 'ENOTDIR') return [] as string[]; throw e; });
      for (const name of names) {
        const path = join(dir, name);
        if (name[0] === '.') {
          const st = await stat(path).catch(() => undefined);
          if (st && now - st.mtimeMs > tempMax) {
            await rm(path, { force: true });
            this.c.tempsRemoved++;
          }
          continue;
        }
        const head = await readHead(path).catch(() => undefined);
        if (!head) continue;
        if (head.exp !== 0 && head.exp <= now) {
          if (await this.removeExpired(path)) this.c.expired++;
          continue;
        }
        entries++;
        bytes += head.size;
      }
    }
    this.tally.set(shard, { entries, bytes });
    this.c.sweeps++;
  }

  private live(): void {
    if (this.closed) throw closedError('file');
  }
}
