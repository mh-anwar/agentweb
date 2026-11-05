// RESP2 / RESP3 wire format: an incremental parser and a command encoder.

export class RedisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisError';
  }
}

/** An out-of-band RESP3 push message (pub/sub, client tracking invalidations). */
export class RespPush {
  readonly data: RespValue[];
  constructor(data: RespValue[]) {
    this.data = data;
  }
}

export type RespValue =
  | null | string | number | bigint | boolean | Buffer | RedisError | RespPush
  | RespValue[] | Map<RespValue, RespValue>;

const INCOMPLETE = Symbol('incomplete');
type Parsed = RespValue | typeof INCOMPLETE;

/** Hard cap on one bulk string (Redis' own proto-max-bulk-len default is 512 MB). */
const MAX_BULK = 512 * 1024 * 1024;
const MAX_ELEMENTS = 64 * 1024 * 1024;

/**
 * Incremental RESP parser. Bulk strings are returned as Buffers (values may be binary),
 * simple strings as JS strings. Feed it chunks in arrival order; it returns every reply
 * completed so far. Throws on a malformed stream (the connection must then be dropped).
 */
export class RespParser {
  private buf: Buffer = Buffer.alloc(0);
  private pos = 0;
  /** bytes the buffer must hold before a re-parse can possibly succeed */
  private need = 0;
  private furthest = 0;

  feed(chunk: Buffer): RespValue[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: RespValue[] = [];
    if (this.buf.length < this.need) return out;
    let start = 0;
    while (start < this.buf.length) {
      this.pos = start;
      this.furthest = 0;
      const v = this.value();
      if (v === INCOMPLETE) {
        this.need = Math.max(0, this.furthest - start);
        break;
      }
      out.push(v);
      start = this.pos;
      this.need = 0;
    }
    this.buf = start >= this.buf.length ? Buffer.alloc(0) : this.buf.subarray(start);
    return out;
  }

  /** bytes buffered but not yet parsed */
  get buffered(): number {
    return this.buf.length;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
    this.need = 0;
  }

  private line(): string | typeof INCOMPLETE {
    const i = this.buf.indexOf(13, this.pos);
    if (i === -1 || i + 1 >= this.buf.length) return INCOMPLETE;
    if (this.buf[i + 1] !== 10) throw new RedisError('protocol error: expected CRLF');
    const s = this.buf.toString('latin1', this.pos, i);
    this.pos = i + 2;
    return s;
  }

  private int(s: string): number {
    if (!/^-?\d+$/.test(s)) throw new RedisError(`protocol error: bad length ${JSON.stringify(s.slice(0, 20))}`);
    return Number(s);
  }

  private blob(): Buffer | null | typeof INCOMPLETE {
    const l = this.line();
    if (l === INCOMPLETE) return INCOMPLETE;
    const n = this.int(l);
    if (n < 0) return null;
    if (n > MAX_BULK) throw new RedisError('protocol error: bulk string too large');
    const end = this.pos + n;
    if (end + 2 > this.buf.length) {
      this.furthest = end + 2;
      return INCOMPLETE;
    }
    if (this.buf[end] !== 13 || this.buf[end + 1] !== 10) throw new RedisError('protocol error: bulk string not terminated');
    // copy so the reply does not pin the whole receive buffer
    const b = Buffer.from(this.buf.subarray(this.pos, end));
    this.pos = end + 2;
    return b;
  }

  private items(n: number): RespValue[] | typeof INCOMPLETE {
    if (n > MAX_ELEMENTS) throw new RedisError('protocol error: aggregate too large');
    const arr: RespValue[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const v = this.value();
      if (v === INCOMPLETE) return INCOMPLETE;
      arr[i] = v;
    }
    return arr;
  }

  private value(): Parsed {
    if (this.pos >= this.buf.length) return INCOMPLETE;
    const type = this.buf[this.pos++];
    switch (type) {
      case 0x2b: /* + */ return this.line();
      case 0x2d: /* - */ {
        const l = this.line();
        return l === INCOMPLETE ? l : new RedisError(Buffer.from(l, 'latin1').toString('utf8'));
      }
      case 0x3a: /* : */ {
        const l = this.line();
        if (l === INCOMPLETE) return l;
        const n = this.int(l);
        return Number.isSafeInteger(n) ? n : BigInt(l);
      }
      case 0x24: /* $ */ return this.blob();
      case 0x2a: /* * */ {
        const l = this.line();
        if (l === INCOMPLETE) return l;
        const n = this.int(l);
        return n < 0 ? null : this.items(n);
      }
      // ── RESP3 ──
      case 0x5f: /* _ */ { const l = this.line(); return l === INCOMPLETE ? l : null; }
      case 0x23: /* # */ { const l = this.line(); return l === INCOMPLETE ? l : l === 't'; }
      case 0x2c: /* , */ {
        const l = this.line();
        if (l === INCOMPLETE) return l;
        return l === 'inf' ? Infinity : l === '-inf' ? -Infinity : l === 'nan' ? NaN : Number(l);
      }
      case 0x28: /* ( */ { const l = this.line(); return l === INCOMPLETE ? l : BigInt(l); }
      case 0x21: /* ! */ { const b = this.blob(); return b === INCOMPLETE ? b : new RedisError(b ? b.toString('utf8') : 'error'); }
      case 0x3d: /* = */ { const b = this.blob(); return b === INCOMPLETE || b === null ? b : b.subarray(4).toString('utf8'); }
      case 0x7e: /* ~ */ {
        const l = this.line();
        return l === INCOMPLETE ? l : this.items(this.int(l));
      }
      case 0x3e: /* > */ {
        const l = this.line();
        if (l === INCOMPLETE) return l;
        const it = this.items(this.int(l));
        return it === INCOMPLETE ? it : new RespPush(it);
      }
      case 0x25: /* % */ {
        const l = this.line();
        if (l === INCOMPLETE) return l;
        const it = this.items(this.int(l) * 2);
        if (it === INCOMPLETE) return it;
        const m = new Map<RespValue, RespValue>();
        for (let i = 0; i < it.length; i += 2) m.set(Buffer.isBuffer(it[i]) ? (it[i] as Buffer).toString('utf8') : it[i], it[i + 1]);
        return m;
      }
      case 0x7c: /* | attribute: metadata about the next reply, which is what we return */ {
        const l = this.line();
        if (l === INCOMPLETE) return l;
        const it = this.items(this.int(l) * 2);
        return it === INCOMPLETE ? it : this.value();
      }
      default:
        throw new RedisError(`protocol error: unexpected type byte 0x${type.toString(16)}`);
    }
  }
}

export type Arg = string | number | Buffer;

/** Encodes one command as a RESP array of bulk strings; returns the pieces to write. */
export function encodeCommand(args: Arg[]): Buffer[] {
  const out: Buffer[] = [];
  let head = `*${args.length}\r\n`;
  for (const a of args) {
    if (Buffer.isBuffer(a)) {
      head += `$${a.length}\r\n`;
      out.push(Buffer.from(head, 'utf8'), a);
      head = '\r\n';
    } else {
      const s = typeof a === 'number' ? String(a) : a;
      head += `$${Buffer.byteLength(s, 'utf8')}\r\n${s}\r\n`;
    }
  }
  if (head) out.push(Buffer.from(head, 'utf8'));
  return out;
}
