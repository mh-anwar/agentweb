// A small in-process Redis stand-in for tests (no redis-server on the build box).
// Speaks RESP2 (and answers HELLO 3 with a RESP3 map), and implements the commands the
// store and client use: PING AUTH HELLO SELECT GET SET(EX/PX/NX/XX) DEL EXISTS PTTL SCAN
// DBSIZE FLUSHALL CLIENT QUIT. Keys are binary-safe. It has hooks to drop every
// connection and to stop answering, which the reconnect tests use.

import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import type { AddressInfo } from 'node:net';
import { RespParser, type RespValue } from './resp.ts';

export interface FakeRedisOptions {
  /** require AUTH with this password */
  password?: string;
  /** require this username with the password (ACL style) */
  username?: string;
  /** serve TLS with this key and certificate (PEM) */
  tls?: { key: string | Buffer; cert: string | Buffer };
}

interface Item {
  v: Buffer;
  /** epoch ms, 0 = never */
  exp: number;
}

function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) re += escapeRe(glob[++i]);
    else if (c === '*') re += '[\\s\\S]*';
    else if (c === '?') re += '[\\s\\S]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        let cls = glob.slice(i + 1, end);
        const neg = cls[0] === '^';
        if (neg) cls = cls.slice(1);
        re += '[' + (neg ? '^' : '') + cls.replace(/[\]\\]/g, '\\$&') + ']';
        i = end;
      }
    } else re += escapeRe(c);
  }
  return new RegExp(re + '$');
}

function escapeRe(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export class FakeRedis {
  private server: Server;
  private readonly dbs = new Map<number, Map<string, Item>>();
  private readonly sockets = new Set<Socket>();
  private readonly opts: FakeRedisOptions;
  /** when true, commands are read but never answered */
  silent = false;
  /** per-command count, for assertions */
  readonly calls = new Map<string, number>();
  connections = 0;
  private closing = false;

  constructor(opts: FakeRedisOptions = {}) {
    this.opts = opts;
    this.server = opts.tls
      ? createTlsServer({ key: opts.tls.key, cert: opts.tls.cert }, (s) => this.accept(s))
      : createServer((s) => this.accept(s));
  }

  async listen(port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => resolve());
    });
    return this.port;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `${this.opts.tls ? 'rediss' : 'redis'}://127.0.0.1:${this.port}`;
  }

  /** Destroys every client connection (the server keeps listening). */
  dropAll(): void {
    for (const s of this.sockets) s.destroy();
  }

  /** Stops listening and drops every connection. */
  async close(): Promise<void> {
    this.closing = true;
    this.dropAll();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  db(n = 0): Map<string, Item> {
    let d = this.dbs.get(n);
    if (!d) { d = new Map(); this.dbs.set(n, d); }
    return d;
  }

  private accept(s: Socket): void {
    if (this.closing) { s.destroy(); return; }
    this.connections++;
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => {});
    const parser = new RespParser();
    const state = { authed: this.opts.password === undefined, db: 0, resp: 2 };
    s.on('data', (chunk: Buffer) => {
      let reqs: RespValue[];
      try {
        reqs = parser.feed(chunk);
      } catch {
        s.end('-ERR Protocol error\r\n');
        return;
      }
      if (this.silent) return;
      const out: Buffer[] = [];
      let quit = false;
      for (const r of reqs) {
        if (!Array.isArray(r) || r.length === 0) { out.push(err('ERR Protocol error')); continue; }
        const args = r.map((a) => (Buffer.isBuffer(a) ? a : Buffer.from(String(a))));
        const name = args[0].toString().toUpperCase();
        this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
        if (name === 'QUIT') { out.push(ok()); quit = true; break; }
        out.push(this.exec(name, args.slice(1), state));
      }
      if (out.length) s.write(Buffer.concat(out));
      if (quit) s.end();
    });
  }

  private exec(name: string, a: Buffer[], st: { authed: boolean; db: number; resp: number }): Buffer {
    const str = (i: number) => a[i]?.toString('utf8') ?? '';
    if (name === 'AUTH') {
      const [user, pass] = a.length >= 2 ? [str(0), str(1)] : ['default', str(0)];
      if (this.opts.password === undefined) return err('ERR AUTH <password> called without any password configured for the default user.');
      if (pass !== this.opts.password || (this.opts.username ?? 'default') !== user) return err('WRONGPASS invalid username-password pair or user is disabled.');
      st.authed = true;
      return ok();
    }
    if (name === 'HELLO') {
      const ver = Number(str(0) || '2');
      if (ver !== 2 && ver !== 3) return err('NOPROTO unsupported protocol version');
      const ai = a.findIndex((b) => b.toString().toUpperCase() === 'AUTH');
      if (ai !== -1) {
        if (a[ai + 2]?.toString() !== this.opts.password || (this.opts.username ?? 'default') !== a[ai + 1]?.toString()) {
          return err('WRONGPASS invalid username-password pair or user is disabled.');
        }
        st.authed = true;
      }
      if (!st.authed) return err('NOAUTH HELLO must be called with the client already authenticated');
      st.resp = ver;
      const pairs: Array<[string, Buffer]> = [['server', bulk('fake')], ['version', bulk('7.0.0')], ['proto', int(ver)]];
      const head = ver === 3 ? `%${pairs.length}\r\n` : `*${pairs.length * 2}\r\n`;
      return Buffer.concat([Buffer.from(head), ...pairs.flatMap(([k, v]) => [bulk(k), v])]);
    }
    if (!st.authed) return err('NOAUTH Authentication required.');
    const db = this.db(st.db);
    const now = Date.now();
    const live = (k: string): Item | undefined => {
      const it = db.get(k);
      if (it && it.exp && it.exp <= now) { db.delete(k); return undefined; }
      return it;
    };
    switch (name) {
      case 'PING': return a.length ? bulk(a[0]) : simple('PONG');
      case 'SELECT': {
        const n = Number(str(0));
        if (!Number.isInteger(n) || n < 0 || n > 15) return err('ERR DB index is out of range');
        st.db = n;
        return ok();
      }
      case 'CLIENT': return ok();
      case 'GET': {
        if (a.length !== 1) return err("ERR wrong number of arguments for 'get' command");
        const it = live(a[0].toString('latin1'));
        return it ? bulk(it.v) : (st.resp === 3 ? Buffer.from('_\r\n') : Buffer.from('$-1\r\n'));
      }
      case 'SET': {
        if (a.length < 2) return err("ERR wrong number of arguments for 'set' command");
        const k = a[0].toString('latin1');
        let exp = 0;
        let nx = false;
        let xx = false;
        for (let i = 2; i < a.length; i++) {
          const opt = str(i).toUpperCase();
          if (opt === 'EX' || opt === 'PX') {
            const n = Number(str(++i));
            if (!Number.isInteger(n) || n <= 0) return err('ERR invalid expire time in set');
            exp = now + (opt === 'EX' ? n * 1000 : n);
          } else if (opt === 'NX') nx = true;
          else if (opt === 'XX') xx = true;
          else return err('ERR syntax error');
        }
        const exists = live(k) !== undefined;
        if ((nx && exists) || (xx && !exists)) return Buffer.from('$-1\r\n');
        db.set(k, { v: Buffer.from(a[1]), exp });
        return ok();
      }
      case 'DEL': {
        let n = 0;
        for (const k of a) if (live(k.toString('latin1')) && db.delete(k.toString('latin1'))) n++;
        return int(n);
      }
      case 'EXISTS': return int(a.filter((k) => live(k.toString('latin1'))).length);
      case 'PTTL': {
        const it = live(a[0]?.toString('latin1') ?? '');
        return int(!it ? -2 : it.exp ? it.exp - now : -1);
      }
      case 'DBSIZE': return int(db.size);
      case 'FLUSHALL': this.dbs.clear(); return ok();
      case 'SCAN': {
        const cursor = Number(str(0));
        let match: RegExp | null = null;
        let count = 10;
        for (let i = 1; i < a.length; i++) {
          const opt = str(i).toUpperCase();
          if (opt === 'MATCH') match = globToRegExp(a[++i].toString('latin1'));
          else if (opt === 'COUNT') count = Number(str(++i));
          else return err('ERR syntax error');
        }
        const all = [...db.keys()];
        const slice = all.slice(cursor, cursor + count);
        const next = cursor + count >= all.length ? 0 : cursor + count;
        const hits = slice.filter((k) => live(k) && (!match || match.test(k)));
        return Buffer.concat([Buffer.from('*2\r\n'), bulk(String(next)), Buffer.from(`*${hits.length}\r\n`), ...hits.map((k) => bulk(Buffer.from(k, 'latin1')))]);
      }
      default:
        return err(`ERR unknown command '${name.toLowerCase()}'`);
    }
  }
}

const ok = () => Buffer.from('+OK\r\n');
const simple = (s: string) => Buffer.from(`+${s}\r\n`);
const err = (s: string) => Buffer.from(`-${s}\r\n`);
const int = (n: number) => Buffer.from(`:${n}\r\n`);
function bulk(v: Buffer | string): Buffer {
  const b = typeof v === 'string' ? Buffer.from(v) : v;
  return Buffer.concat([Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')]);
}
