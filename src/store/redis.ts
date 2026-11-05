// A zero-dependency Redis client and a Store on top of it.
//
// Client: RESP2 by default (RESP3 with `protocol: 3`, which sends HELLO 3), over node:net or
// node:tls. Commands are pipelined: they are written as soon as they are issued (batched
// per tick with cork/uncork) and replies are matched in FIFO order. When the connection
// drops, every command that was already written fails with `net` (it may or may not have
// run, so it is not replayed) and the client reconnects with jittered exponential backoff.
// Commands issued while disconnected wait in a bounded offline queue and are sent after the
// AUTH / SELECT handshake on the next connection. A watchdog fails commands that wait
// longer than `commandTimeoutMs` and drops a connection that stops answering.

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import type { Store } from '../types.ts';
import { AwError } from '../types.ts';
import {
  type CodecOptions, Pending, checkLimit, checkNs, checkNsKey, checkPrefix, closedError,
  decodeBlob, encodeBlob, expiryFor, fromJson, toJson,
} from './codec.ts';
import { type Arg, RedisError, RespParser, RespPush, type RespValue, encodeCommand } from './resp.ts';

export { RedisError } from './resp.ts';

export interface RedisUrl {
  host: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  db: number;
  /** query parameters, passed on to store options by openStore */
  params: Record<string, string>;
}

/** Parses redis://[user[:pass]@]host[:port][/db][?k=v] and rediss://… (TLS). */
export function parseRedisUrl(url: string): RedisUrl {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AwError('bad_request', `not a redis URL: ${url}`);
  }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new AwError('bad_request', `not a redis URL: ${url}`);
  const tls = u.protocol === 'rediss:';
  const path = u.pathname.replace(/^\/+/, '');
  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  const dbStr = path || params.db || '0';
  if (!/^\d+$/.test(dbStr)) throw new AwError('bad_request', `bad redis database number "${dbStr}"`);
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1') || '127.0.0.1';
  return {
    host,
    port: u.port ? Number(u.port) : 6379,
    tls,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : params.password,
    db: Number(dbStr),
    params,
  };
}

export interface RedisClientOptions {
  host?: string;
  port?: number;
  tls?: boolean | ConnectionOptions;
  username?: string;
  password?: string;
  db?: number;
  /** 2 (default) or 3 (sends HELLO 3) */
  protocol?: 2 | 3;
  connectTimeoutMs?: number;
  /** fail a command that has waited this long for its reply (default 10 s) */
  commandTimeoutMs?: number;
  /** reconnect backoff: first delay and cap (defaults 50 ms, 2 s) */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** commands queued while disconnected before new ones are refused (default 10 000) */
  offlineQueueMax?: number;
  /** client name sent with CLIENT SETNAME */
  name?: string;
}

interface Cmd {
  args: Arg[];
  resolve: (v: RespValue) => void;
  reject: (e: Error) => void;
  at: number;
  /** handshake commands bypass the offline queue */
  internal?: boolean;
}

type State = 'connecting' | 'handshake' | 'ready' | 'closing' | 'closed';

export class RedisClient {
  private readonly o: Required<Omit<RedisClientOptions, 'username' | 'password' | 'name' | 'tls'>> &
    Pick<RedisClientOptions, 'username' | 'password' | 'name' | 'tls'>;
  private socket: Socket | null = null;
  private parser = new RespParser();
  private state: State = 'connecting';
  private inflight: Cmd[] = [];
  private inflightHead = 0;
  private offline: Cmd[] = [];
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout;
  private corked = false;
  private readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private lastError: Error | null = null;
  readonly counters = { reconnects: 0, connects: 0, commands: 0, failedInflight: 0, timeouts: 0 };

  constructor(opts: RedisClientOptions | string = {}) {
    const o = typeof opts === 'string' ? fromUrl(opts) : opts;
    this.o = {
      host: o.host ?? '127.0.0.1',
      port: o.port ?? 6379,
      tls: o.tls,
      username: o.username,
      password: o.password,
      db: o.db ?? 0,
      protocol: o.protocol ?? 2,
      connectTimeoutMs: o.connectTimeoutMs ?? 5000,
      commandTimeoutMs: o.commandTimeoutMs ?? 10_000,
      minBackoffMs: o.minBackoffMs ?? 50,
      maxBackoffMs: o.maxBackoffMs ?? 2000,
      offlineQueueMax: o.offlineQueueMax ?? 10_000,
      name: o.name,
    };
    this.watchdog = setInterval(() => this.checkTimeouts(), Math.max(25, Math.min(1000, this.o.commandTimeoutMs / 4)));
    this.watchdog.unref();
    this.open();
  }

  get isReady(): boolean {
    return this.state === 'ready';
  }

  /** Resolves when the client is connected and authenticated; rejects after `timeoutMs`. */
  waitReady(timeoutMs = this.o.connectTimeoutMs): Promise<void> {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state === 'closed' || this.state === 'closing') return Promise.reject(closedError('redis'));
    return new Promise((resolve, reject) => {
      const w = {
        resolve: () => { clearTimeout(t); resolve(); },
        reject: (e: Error) => { clearTimeout(t); reject(e); },
      };
      const t = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((x) => x !== w);
        const why = this.lastError ? `: ${this.lastError.message}` : '';
        reject(new AwError('net', `redis at ${this.o.host}:${this.o.port} not reachable${why}`, 'check the URL and that the server is up'));
      }, timeoutMs);
      this.readyWaiters.push(w);
    });
  }

  /** Sends one command. Error replies reject with RedisError; connection problems with AwError('net'). */
  command(...args: Arg[]): Promise<RespValue> {
    if (this.state === 'closing' || this.state === 'closed') return Promise.reject(closedError('redis'));
    return new Promise((resolve, reject) => {
      const cmd: Cmd = { args, resolve, reject, at: Date.now() };
      this.counters.commands++;
      if (this.state === 'ready') this.send(cmd);
      else if (this.offline.length >= this.o.offlineQueueMax) {
        reject(new AwError('net', 'redis is disconnected and the offline queue is full', 'retry later'));
      } else this.offline.push(cmd);
    });
  }

  stats(): Record<string, number> {
    return { ...this.counters, inflight: this.inflight.length - this.inflightHead, queued: this.offline.length, ready: this.isReady ? 1 : 0 };
  }

  /** Waits for in-flight replies (up to commandTimeoutMs), sends QUIT and releases the socket. */
  async close(): Promise<void> {
    if (this.state === 'closed' || this.state === 'closing') return;
    const wasReady = this.state === 'ready';
    this.state = 'closing';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    clearInterval(this.watchdog);
    for (const c of this.offline.splice(0)) c.reject(closedError('redis'));
    for (const w of this.readyWaiters.splice(0)) w.reject(closedError('redis'));
    const sock = this.socket;
    if (sock && wasReady) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.o.commandTimeoutMs);
        const quit: Cmd = { args: ['QUIT'], resolve: () => { clearTimeout(t); resolve(); }, reject: () => { clearTimeout(t); resolve(); }, at: Date.now(), internal: true };
        sock.once('close', () => { clearTimeout(t); resolve(); });
        this.send(quit);
      });
    }
    this.state = 'closed';
    this.failInflight(closedError('redis'));
    this.socket?.destroy();
    this.socket = null;
  }

  // ───────────── connection ─────────────

  private open(): void {
    this.state = 'connecting';
    this.parser.reset();
    const { host, port } = this.o;
    let sock: Socket;
    const onConnected = () => {
      clearTimeout(ct);
      this.counters.connects++;
      void this.handshake(sock);
    };
    if (this.o.tls) {
      const extra = typeof this.o.tls === 'object' ? this.o.tls : {};
      sock = tlsConnect({ host, port, servername: /^[\d.:]+$/.test(host) ? undefined : host, ...extra }, onConnected);
    } else {
      sock = netConnect({ host, port }, onConnected);
    }
    const ct = setTimeout(() => sock.destroy(new Error(`connect timeout after ${this.o.connectTimeoutMs} ms`)), this.o.connectTimeoutMs);
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30_000);
    this.socket = sock;
    sock.on('data', (chunk: Buffer) => this.onData(sock, chunk));
    sock.on('error', (e) => { this.lastError = e; });
    sock.on('close', () => {
      clearTimeout(ct);
      this.onClose(sock);
    });
  }

  private async handshake(sock: Socket): Promise<void> {
    if (this.socket !== sock) return;
    this.state = 'handshake';
    const { username, password, db, protocol, name } = this.o;
    try {
      if (protocol === 3) {
        const args: Arg[] = ['HELLO', '3'];
        if (password !== undefined) args.push('AUTH', username ?? 'default', password);
        await this.internal(args);
      } else if (password !== undefined) {
        await this.internal(username ? ['AUTH', username, password] : ['AUTH', password]);
      }
      if (db) await this.internal(['SELECT', db]);
      if (name) await this.internal(['CLIENT', 'SETNAME', name]).catch(() => {});
    } catch (e) {
      if (this.socket !== sock) return;
      const err = new AwError('net', `redis handshake failed: ${(e as Error).message}`, 'check the password and database in the URL');
      this.lastError = err;
      // the server refused us: queued work cannot succeed on this connection
      for (const c of this.offline.splice(0)) c.reject(err);
      sock.destroy();
      return;
    }
    if (this.socket !== sock || this.state !== 'handshake') return;
    this.state = 'ready';
    this.attempt = 0;
    this.lastError = null;
    for (const c of this.offline.splice(0)) this.send(c);
    for (const w of this.readyWaiters.splice(0)) w.resolve();
  }

  private internal(args: Arg[]): Promise<RespValue> {
    return new Promise((resolve, reject) => {
      this.send({
        args,
        resolve: (v) => (v instanceof RedisError ? reject(v) : resolve(v)),
        reject,
        at: Date.now(),
        internal: true,
      });
    });
  }

  private onClose(sock: Socket): void {
    if (this.socket !== sock) return;
    this.socket = null;
    this.failInflight(new AwError('net', 'redis connection lost; the command may or may not have run', 'retry if the command is safe to repeat'));
    if (this.state === 'closing' || this.state === 'closed') return;
    this.state = 'connecting';
    const base = Math.min(this.o.maxBackoffMs, this.o.minBackoffMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    const delay = Math.round(base * (0.5 + Math.random() * 0.5));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state !== 'connecting') return;
      this.counters.reconnects++;
      this.open();
    }, delay);
  }

  private failInflight(err: Error): void {
    (err as { connectionLost?: boolean }).connectionLost = true;
    const pending = this.inflight.slice(this.inflightHead);
    this.inflight = [];
    this.inflightHead = 0;
    for (const c of pending) {
      if (!c.internal) this.counters.failedInflight++;
      c.reject(err);
    }
  }

  private onData(sock: Socket, chunk: Buffer): void {
    if (this.socket !== sock) return;
    let replies: RespValue[];
    try {
      replies = this.parser.feed(chunk);
    } catch (e) {
      this.lastError = e as Error;
      sock.destroy();
      return;
    }
    for (const r of replies) {
      if (r instanceof RespPush) continue;
      if (this.inflightHead >= this.inflight.length) {
        // a reply nobody asked for: the stream is out of sync, start over
        sock.destroy();
        return;
      }
      const c = this.inflight[this.inflightHead++];
      if (this.inflightHead > 1024 && this.inflightHead * 2 > this.inflight.length) {
        this.inflight = this.inflight.slice(this.inflightHead);
        this.inflightHead = 0;
      }
      if (r instanceof RedisError) c.reject(r);
      else c.resolve(r);
    }
  }

  private send(c: Cmd): void {
    const sock = this.socket!;
    this.inflight.push(c);
    if (!this.corked) {
      this.corked = true;
      sock.cork();
      process.nextTick(() => {
        this.corked = false;
        sock.uncork();
      });
    }
    for (const piece of encodeCommand(c.args)) sock.write(piece);
  }

  private checkTimeouts(): void {
    const now = Date.now();
    const limit = this.o.commandTimeoutMs;
    while (this.offline.length && now - this.offline[0].at > limit) {
      this.counters.timeouts++;
      this.offline.shift()!.reject(new AwError('timeout', `redis command waited ${limit} ms for a connection`, 'check that redis is reachable'));
    }
    const head = this.inflight[this.inflightHead];
    if (head && now - head.at > limit && this.socket) {
      // replies are strictly ordered, so a stuck head means the whole connection is stuck
      this.counters.timeouts++;
      this.lastError = new Error(`no reply within ${limit} ms`);
      this.socket.destroy();
    }
  }
}

/** True for the error a command gets when its connection dropped before the reply arrived. */
export function isConnectionLost(e: unknown): boolean {
  return !!(e as { connectionLost?: boolean } | null)?.connectionLost;
}

function fromUrl(url: string): RedisClientOptions {
  const u = parseRedisUrl(url);
  return { host: u.host, port: u.port, tls: u.tls, username: u.username, password: u.password, db: u.db, protocol: u.params.protocol === '3' ? 3 : 2 };
}

// ───────────── store ─────────────

export interface RedisStoreOptions extends CodecOptions, RedisClientOptions {
  /** prefix for every Redis key this store writes (default "aw:") */
  prefix?: string;
  /** SCAN COUNT hint (default 1000) */
  scanCount?: number;
}

function globEscape(s: string): string {
  return s.replace(/[*?[\]\\]/g, (c) => '\\' + c);
}

export class RedisStore implements Store {
  readonly client: RedisClient;
  private readonly owns: boolean;
  private readonly opts: RedisStoreOptions;
  private readonly prefix: string;
  private closed = false;
  private readonly pending = new Pending();
  private c = { hits: 0, misses: 0, sets: 0, dels: 0, corrupt: 0, errors: 0, readRetries: 0 };

  /** Pass a URL / options to own a client, or an existing client to share one. */
  constructor(target: string | RedisClient | RedisClientOptions, opts: RedisStoreOptions = {}) {
    if (target instanceof RedisClient) {
      this.client = target;
      this.owns = false;
    } else {
      const base = typeof target === 'string' ? fromUrl(target) : target;
      this.client = new RedisClient({ ...base, ...stripStore(opts) });
      this.owns = true;
    }
    this.opts = opts;
    this.prefix = opts.prefix ?? 'aw:';
  }

  /** Redis key for (ns, key): length-prefixed namespace so "a:b"/"c" never meets "a"/"b:c". */
  rkey(ns: string, key: string): string {
    return `${this.prefix}${ns.length}:${ns}:${key}`;
  }

  async get<T = unknown>(ns: string, key: string): Promise<T | undefined> {
    this.live();
    checkNsKey(ns, key);
    return this.pending.run(() => this.getInner<T>(ns, key));
  }

  private async getInner<T>(ns: string, key: string): Promise<T | undefined> {
    const v = await this.read('GET', this.rkey(ns, key));
    if (v === null || v === undefined) { this.c.misses++; return undefined; }
    if (!Buffer.isBuffer(v)) { this.c.corrupt++; this.c.misses++; return undefined; }
    let json: string;
    try {
      json = await decodeBlob(v);
    } catch {
      this.c.corrupt++;
      this.c.misses++;
      return undefined;
    }
    this.c.hits++;
    return fromJson<T>(json);
  }

  async set<T = unknown>(ns: string, key: string, value: T, ttlSec?: number): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    const exp = expiryFor(ttlSec, 0); // validates; relative ms when non-zero
    const json = toJson(value);
    if (json === undefined) return this.del(ns, key);
    return this.pending.run(async () => {
      const blob = await encodeBlob(json, this.opts);
      const args: Arg[] = ['SET', this.rkey(ns, key), blob];
      if (exp) args.push('PX', exp);
      await this.cmd(...args);
      this.c.sets++;
    });
  }

  async del(ns: string, key: string): Promise<void> {
    this.live();
    checkNsKey(ns, key);
    const n = await this.pending.run(() => this.cmd('DEL', this.rkey(ns, key)));
    if (n) this.c.dels++;
  }

  async keys(ns: string, prefix?: string, limit?: number): Promise<string[]> {
    this.live();
    checkNs(ns);
    const p = checkPrefix(prefix);
    const max = checkLimit(limit);
    if (max === 0) return [];
    const base = `${this.prefix}${ns.length}:${ns}:`;
    const baseLen = Buffer.byteLength(base, 'utf8');
    const match = globEscape(base + p) + '*';
    return this.pending.run(() => this.scan(match, baseLen, p, max));
  }

  private async scan(match: string, baseLen: number, p: string, max: number): Promise<string[]> {
    const seen = new Set<string>();
    let cursor = '0';
    do {
      const r = await this.read('SCAN', cursor, 'MATCH', match, 'COUNT', this.opts.scanCount ?? 1000);
      if (!Array.isArray(r) || r.length !== 2 || !Array.isArray(r[1])) throw new AwError('net', 'unexpected SCAN reply from redis');
      cursor = String(Buffer.isBuffer(r[0]) ? r[0].toString() : r[0]);
      for (const k of r[1]) {
        if (!Buffer.isBuffer(k)) continue;
        const key = k.subarray(baseLen).toString('utf8');
        if (!key.startsWith(p)) continue;
        seen.add(key);
        if (seen.size >= max) return [...seen];
      }
    } while (cursor !== '0');
    return [...seen];
  }

  stats(): Record<string, number> {
    const cs = this.client.stats();
    return { evictions: 0, ...this.c, reconnects: cs.reconnects, inflight: cs.inflight, queued: cs.queued, failedInflight: cs.failedInflight };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pending.idle();
    if (this.owns) await this.client.close();
  }

  /**
   * Reads are idempotent, so one that was cut off by a dropped connection is sent once more
   * (it then waits for the reconnect). Writes are never retried: they may have been applied.
   */
  private async read(...args: Arg[]): Promise<RespValue> {
    try {
      return await this.client.command(...args);
    } catch (e) {
      if (!isConnectionLost(e) || this.closed) return this.fail(e);
      this.c.readRetries++;
      return this.cmd(...args);
    }
  }

  private fail(e: unknown): never {
    this.c.errors++;
    if (e instanceof RedisError) throw new AwError('internal', `redis: ${e.message}`);
    throw e;
  }

  private async cmd(...args: Arg[]): Promise<RespValue> {
    try {
      return await this.client.command(...args);
    } catch (e) {
      this.c.errors++;
      if (e instanceof RedisError) throw new AwError('internal', `redis: ${e.message}`);
      throw e;
    }
  }

  private live(): void {
    if (this.closed) throw closedError('redis');
  }
}

function stripStore(o: RedisStoreOptions): RedisClientOptions {
  const { prefix: _p, scanCount: _s, gzipAbove: _g, gzipLevel: _l, ...rest } = o;
  return rest;
}
