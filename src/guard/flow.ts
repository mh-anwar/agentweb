// Cross-origin data-flow check.
//
// The attack this addresses (indirect prompt injection against agentic browsers) always has the
// same shape: a page tells the agent to read private data on site A, where the user is signed in,
// and put it into a URL or form for site B. Neither step is suspicious alone; the flow is. So the
// guard remembers, per origin, what the agent was shown while authenticated there, and checks
// agent-supplied text that is about to leave for some origin against that memory.
//
// Memory is two compact sets, both keyed by a per-session random seed so the persisted state does
// not reveal content to a dictionary attack:
//
//   * distinctive tokens, kept exactly: e-mail addresses, numbers with ≥ 7 digits (account, card,
//     phone, order numbers; separators ignored, dates excluded), and long mixed letter/digit
//     strings (API keys, ids). A single match is enough. Recency-ordered, capped (FIFO).
//   * word 5-shingles of everything else, as 24-bit fingerprints with "distinct sampling": each
//     shingle has a level (trailing zero bits of a second hash) and only shingles with level ≥ r
//     are kept. When the set is full r goes up by one and half the entries are dropped, so memory
//     is bounded however much is observed, and source and query select exactly the same shingles
//     (the selection is a function of the shingle alone). Two matching shingles from one origin
//     are a strong signal; one is a weak one (warn only).
//
// Every entry carries a bitmask of the origins (slots, LRU, capped) it was shown on. A match is
// ignored when the destination origin is among them: flows within one origin pass, as does sending
// a site something it showed you itself. Unauthenticated observations are never stored, so data
// from public pages never trips the check. Agent-supplied tokens that passed a check before any
// page showed them are remembered as the agent's own ("typed by the user") and exempt later.
//
// Outflow text is checked as given, URL-decoded (twice, for double encoding), and with every long
// base64 or hex run decoded. Cost is O(length) per check and per observation.

const K = 5;
const MIN_DIGITS = 7;
const MAX_GROUPS = 8;

// ASCII character classes for the hand-written scanners (regexes were 3-4x slower here)
const ALNUM = 1;
const CODE = 2; // alnum _ -
const B64 = 4; // alnum + / _ -
const MAIL = 8; // e-mail local part: alnum . _ % + -
const DOM = 16; // domain: alnum . -
const CLS = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  const ch = String.fromCharCode(c);
  if (/[A-Za-z0-9]/.test(ch)) CLS[c] = ALNUM | CODE | B64 | MAIL | DOM;
}
CLS[95] = CODE | B64 | MAIL; // _
CLS[45] = CODE | B64 | MAIL | DOM; // -
CLS[43] = B64 | MAIL; // +
CLS[47] = B64; // /
CLS[46] = MAIL | DOM; // .
CLS[37] = MAIL; // %
const cls = (c: number) => (c < 128 ? CLS[c] : 0);
const isDigit = (c: number) => c >= 48 && c <= 57;

const wideCache = new Map<number, boolean>();
const WIDE_RE = /[\p{L}\p{N}\p{M}]/u;
/** Is UTF-16 unit `c` part of a word? (letters, digits, marks; astral characters count) */
function wordChar(c: number): boolean {
  if (c < 128) return (CLS[c] & ALNUM) !== 0;
  if (c >= 0xd800 && c <= 0xdfff) return true;
  let v = wideCache.get(c);
  if (v === undefined) {
    v = WIDE_RE.test(String.fromCharCode(c));
    if (wideCache.size < 4096) wideCache.set(c, v);
  }
  return v;
}

const STOP = new Set(
  ('a an the and or but if then else of to in on at by for with from as is are was were be been being it its this that ' +
    'these those there here i you he she we they me him her us them my your his our their not no yes do does did done ' +
    'have has had will would can could should may might must shall so than too very just about into over under up down ' +
    'out off again more most some any all each other such only own same what which who whom when where why how')
    .split(' '),
);

export interface FlowLimits {
  /** shingle fingerprints kept (≈ 2 bytes each serialised) */
  shingles: number;
  /** distinctive tokens kept (≈ 5 bytes each) */
  tokens: number;
  /** origins tracked at once (bitmask width; max 24) */
  origins: number;
  /** agent-supplied tokens remembered as the agent's own */
  own: number;
}

export const DEFAULT_FLOW_LIMITS: FlowLimits = { shingles: 2048, tokens: 384, origins: 16, own: 128 };

export type FlowKind = 'email' | 'number' | 'code' | 'passage';

export interface FlowHit {
  /** origin the material was shown on while signed in */
  source: string;
  kind: FlowKind;
  /** strong: refuse in block mode. weak (one shingle, or a token seen on several sites): warn only */
  strong: boolean;
  /** number of matching shingles (passage) or 1 */
  matches: number;
  /** the match was found only after decoding */
  encoding?: 'url' | 'base64' | 'hex';
}

/** Serialised form. `h`, `t`, `w` are base64 of varint-packed fingerprint lists. */
export interface FlowState {
  v: 1;
  s: number;
  r: number;
  o: (string | null)[];
  u: number[];
  h?: string;
  t?: string;
  w?: string;
}

// ───────────────────────────── hashing ─────────────────────────────

function fnv(s: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const ctz = (x: number) => (x === 0 ? 32 : 31 - Math.clz32(x & -x));
const popcount = (x: number) => {
  let c = 0;
  for (; x; x &= x - 1) c++;
  return c;
};

/**
 * Call `cb(fp, level)` for every 5-word shingle of `text` with level ≥ minLevel, skipping shingles
 * made (almost) entirely of stopwords.
 */
function shingles(text: string, seed: number, minLevel: number, cb: (fp: number, level: number) => void): void {
  const ring = new Int32Array(K);
  const stop = new Uint8Array(K);
  let n = 0;
  let stops = 0;
  const t = text.toLowerCase();
  const len = t.length;
  let i = 0;
  while (i < len) {
    if (!wordChar(t.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (; i < len; i++) {
      const c = t.charCodeAt(i);
      if (!wordChar(c)) break;
      h = Math.imul(h ^ c, 0x01000193);
    }
    const slot = n % K;
    if (n >= K && stop[slot]) stops--;
    ring[slot] = h;
    stop[slot] = i - start <= 6 && STOP.has(t.slice(start, i)) ? 1 : 0;
    stops += stop[slot];
    n++;
    if (n < K || stops >= K - 1) continue;
    let acc = seed ^ 0x27d4eb2f;
    for (let j = 0; j < K; j++) {
      acc = Math.imul(acc ^ ring[(n + j) % K], 0x9e3779b1);
      acc = (acc << 13) | (acc >>> 19);
    }
    const level = ctz(fmix(acc ^ 0x165667b1));
    if (level < minLevel) continue;
    cb(fmix(acc + 0x3c6ef372) >>> 8, level);
  }
}

export type TokenKind = 'email' | 'number' | 'code';

function isDateLike(groups: string[], seps: string[]): boolean {
  if (groups.length !== 3 || seps[0] !== seps[1] || seps[0] === ' ') return false;
  const L = groups.map((g) => g.length);
  return (L[0] === 4 && L[1] <= 2 && L[2] <= 2) || (L[0] <= 2 && L[1] <= 2 && (L[2] === 4 || L[2] === 2));
}

/**
 * Distinctive tokens of `text`. `query` mode (outflow side) also yields every contiguous run of
 * digit groups, so "+1 555 123 4567" matches an observed "(555) 123-4567"; observed text yields
 * the maximal run and its suffixes.
 */
function tokens(text: string, seed: number, query: boolean, cb: (h: number, kind: TokenKind) => void): void {
  const len = text.length;
  // e-mail addresses, anchored on '@'
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    let a = at;
    while (a > 0 && cls(text.charCodeAt(a - 1)) & MAIL) a--;
    let b = at + 1;
    while (b < len && cls(text.charCodeAt(b)) & DOM) b++;
    let local = text.slice(a, at).replace(/^\.+/, '');
    let dom = text.slice(at + 1, b).replace(/[.\-]+$/, '');
    if (!local || !/^[a-z0-9\-]+(?:\.[a-z0-9\-]+)+$/i.test(dom)) continue;
    cb(fnv('e' + local.toLowerCase() + '@' + dom.toLowerCase(), seed), 'email');
  }
  let i = 0;
  while (i < len) {
    const c = text.charCodeAt(i);
    const k = cls(c);
    if (isDigit(c) && (i === 0 || !isDigit(text.charCodeAt(i - 1)))) {
      // a chain of digit groups joined by one of " .-" or by ")" / ") "
      const groups: string[] = [];
      const seps: string[] = [];
      let j = i;
      let digits = 0;
      for (;;) {
        const g0 = j;
        while (j < len && isDigit(text.charCodeAt(j))) j++;
        groups.push(text.slice(g0, j));
        digits += j - g0;
        if (j + 1 >= len) break;
        const s = text.charCodeAt(j);
        let next = -1;
        if (s === 32 || s === 46 || s === 45) next = j + 1;
        else if (s === 41) next = text.charCodeAt(j + 1) === 32 ? j + 2 : j + 1;
        if (next < 0 || next >= len || !isDigit(text.charCodeAt(next))) break;
        seps.push(text.slice(j, next));
        j = next;
      }
      if (digits >= MIN_DIGITS && !isDateLike(groups, seps)) {
        const gs = groups.length > MAX_GROUPS ? groups.slice(-MAX_GROUPS) : groups;
        const g = gs.length;
        for (let a = 0; a < g; a++) {
          // observed: suffixes only (b = g); query: every contiguous run
          for (let b = query ? a + 1 : g; b <= g; b++) {
            const run = gs.slice(a, b).join('');
            if (run.length >= MIN_DIGITS) cb(fnv('n' + run, seed), 'number');
          }
        }
      }
    }
    if (k & CODE && (i === 0 || !(cls(text.charCodeAt(i - 1)) & CODE))) {
      // a maximal run of [A-Za-z0-9_-]: long and mixed letters/digits = an identifier or key
      let j = i;
      let d = 0;
      let l = 0;
      for (; j < len; j++) {
        const x = text.charCodeAt(j);
        const kx = cls(x);
        if (!(kx & CODE)) break;
        if (isDigit(x)) d++;
        else if (kx & ALNUM) l++;
      }
      if (d + l >= 12 && d >= 2 && l >= 2) cb(fnv('c' + text.slice(i, j).replace(/[_\-]/g, '').toLowerCase(), seed), 'code');
    }
    i++;
  }
}

// ───────────────────────────── decoding ─────────────────────────────

function pctDecode(s: string): string {
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (seq) => {
    const bytes = Buffer.from(seq.replace(/%/g, ''), 'hex');
    return bytes.toString('utf8');
  });
}

function printable(s: string): boolean {
  if (s.length < 6) return false;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 32 && c < 127) || c === 9 || c === 10 || c === 13 || (c >= 0xa0 && c !== 0xfffd)) ok++;
  }
  return ok / s.length >= 0.9;
}

interface Variant {
  t: string;
  enc?: 'url' | 'base64' | 'hex';
}

function variants(text: string): Variant[] {
  const out: Variant[] = [{ t: text }];
  let cur = text;
  for (let i = 0; i < 2; i++) {
    if (!/%[0-9a-f]{2}|\+/i.test(cur)) break;
    const d = pctDecode(cur.replace(/\+/g, ' '));
    if (d === cur) break;
    out.push({ t: d, enc: 'url' });
    cur = d;
  }
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const enc = out[i].enc;
    const t = out[i].t;
    const len = t.length;
    for (let a = 0; a < len; a++) {
      if (!(cls(t.charCodeAt(a)) & B64)) continue;
      let b = a;
      while (b < len && cls(t.charCodeAt(b)) & B64) b++;
      if (b - a >= 16) {
        const m = t.slice(a, b);
        // '/' is both a base64 character and a path separator: try the run and its path segments
        const runs = m.includes('/') ? [m, ...m.split('/').filter((x) => x.length >= 16)] : [m];
        for (const s of runs) {
          if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) {
            const d = Buffer.from(s, 'hex').toString('utf8');
            if (printable(d)) out.push({ t: d, enc: enc ?? 'hex' });
            continue;
          }
          const d = Buffer.from(s, 'base64').toString('utf8');
          if (printable(d)) out.push({ t: d, enc: enc ?? 'base64' });
        }
      }
      a = b;
    }
  }
  return out;
}

// ───────────────────────────── varint codec ─────────────────────────────

class Writer {
  b: number[] = [];
  vu(n: number) {
    n >>>= 0;
    while (n >= 0x80) {
      this.b.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.b.push(n);
  }
  u32(n: number) {
    this.b.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  }
  out(): string | undefined {
    return this.b.length ? Buffer.from(this.b).toString('base64') : undefined;
  }
}

class Reader {
  i = 0;
  b: Buffer;
  constructor(s: string) {
    this.b = Buffer.from(s, 'base64');
  }
  get done() {
    return this.i >= this.b.length;
  }
  vu(): number {
    let n = 0;
    let shift = 0;
    for (;;) {
      if (this.i >= this.b.length || shift > 28) throw new Error('bad varint');
      const x = this.b[this.i++];
      n += (x & 0x7f) * 2 ** shift;
      if (x < 0x80) return n >>> 0;
      shift += 7;
    }
  }
  u32(): number {
    if (this.i + 4 > this.b.length) throw new Error('truncated');
    const n = this.b.readUInt32LE(this.i);
    this.i += 4;
    return n;
  }
}

// ───────────────────────────── tracker ─────────────────────────────

export class FlowTracker {
  readonly limits: FlowLimits;
  private seed: number;
  /** current sampling level */
  private r = 0;
  /** fp → (originMask << 6) | level */
  private sh = new Map<number, number>();
  /** token hash → originMask, in recency order */
  private tok = new Map<number, number>();
  /** agent's own tokens */
  private own = new Set<number>();
  private slots: (string | null)[] = [];
  private used: number[] = [];
  private seq = 1;

  constructor(limits: Partial<FlowLimits> = {}, state?: unknown) {
    this.limits = { ...DEFAULT_FLOW_LIMITS, ...limits };
    this.limits.origins = Math.min(24, Math.max(1, this.limits.origins));
    this.seed = (Math.random() * 2 ** 32) >>> 0;
    if (state) this.load(state);
  }

  get stats() {
    return { shingles: this.sh.size, tokens: this.tok.size, own: this.own.size, level: this.r, origins: this.slots.filter(Boolean).length };
  }

  private slotOf(origin: string): number {
    return this.slots.indexOf(origin);
  }

  private allocSlot(origin: string): number {
    let i = this.slotOf(origin);
    if (i < 0) {
      i = this.slots.indexOf(null);
      if (i < 0 && this.slots.length < this.limits.origins) i = this.slots.length;
      if (i < 0) {
        // evict the least recently observed origin and everything only it showed
        i = 0;
        for (let j = 1; j < this.slots.length; j++) if (this.used[j] < this.used[i]) i = j;
        this.dropBit(1 << i);
      }
      this.slots[i] = origin;
    }
    this.used[i] = this.seq++;
    return i;
  }

  private dropBit(bit: number): void {
    for (const [k, v] of this.sh) {
      const mask = (v >>> 6) & ~bit;
      if (mask) this.sh.set(k, (mask << 6) | (v & 63));
      else this.sh.delete(k);
    }
    for (const [k, m] of this.tok) {
      if (m & ~bit) this.tok.set(k, m & ~bit);
      else this.tok.delete(k);
    }
  }

  private trimShingles(max: number): void {
    while (this.sh.size > max) {
      this.r++;
      for (const [k, v] of this.sh) if ((v & 63) < this.r) this.sh.delete(k);
    }
  }

  /** Record text shown to the agent on `origin`. Only authenticated views are remembered. */
  observe(origin: string, text: string, authed: boolean): void {
    if (!authed || !text) return;
    const bit = 1 << this.allocSlot(origin);
    tokens(text, this.seed, false, (h) => {
      const prev = this.tok.get(h);
      if (prev !== undefined) this.tok.delete(h);
      this.tok.set(h, (prev ?? 0) | bit);
    });
    while (this.tok.size > this.limits.tokens) this.tok.delete(this.tok.keys().next().value!);
    const cap = this.limits.shingles;
    shingles(text, this.seed, this.r, (fp, level) => {
      if (level < this.r) return; // r may rise during a long observation
      const prev = this.sh.get(fp);
      this.sh.set(fp, ((((prev ?? 0) >>> 6) | bit) << 6) | level);
      if (this.sh.size > cap + (cap >> 2)) this.trimShingles(cap);
    });
    this.trimShingles(cap);
  }

  /** Does `text`, about to be sent to `dest`, carry material shown on another origin while signed in? */
  check(text: string, dest: string): FlowHit | null {
    if (!text || (!this.tok.size && !this.sh.size)) return null;
    const ds = this.slotOf(dest);
    const destBit = ds >= 0 ? 1 << ds : 0;
    const vs = variants(text);
    let tokHit: FlowHit | null = null;
    const perSlot = new Map<number, Set<number>>();
    let passEnc: Variant['enc'];
    for (const v of vs) {
      if (this.tok.size)
        tokens(v.t, this.seed, true, (h, kind) => {
          if (tokHit?.strong) return;
          const mask = this.tok.get(h);
          if (!mask || mask & destBit || this.own.has(h)) return;
          // a token several signed-in sites show (the user's own e-mail, say) is weak evidence
          const strong = popcount(mask) === 1;
          if (!tokHit || strong) tokHit = { source: this.slots[ctz(mask)]!, kind, strong, matches: 1, encoding: v.enc };
        });
      if (this.sh.size)
        shingles(v.t, this.seed, this.r, (fp) => {
          const e = this.sh.get(fp);
          if (e === undefined) return;
          const mask = e >>> 6;
          if (mask & destBit) return;
          for (let m = mask; m; m &= m - 1) {
            const s = ctz(m);
            let set = perSlot.get(s);
            if (!set) perSlot.set(s, (set = new Set()));
            if (!set.has(fp) && set.size === 0) passEnc = v.enc;
            set.add(fp);
          }
        });
    }
    let passage: FlowHit | null = null;
    for (const [s, set] of perSlot)
      if (!passage || set.size > passage.matches)
        passage = { source: this.slots[s]!, kind: 'passage', strong: set.size >= 2, matches: set.size, encoding: passEnc };
    const t = tokHit as FlowHit | null;
    if (t?.strong) return t;
    if (passage?.strong) return passage;
    return t ?? passage;
  }

  /**
   * Remember tokens of an outflow that passed as the agent's own, unless some page already showed
   * them. Call only after `check` returned null.
   */
  noteOwn(text: string): void {
    for (const v of variants(text)) {
      if (v.enc && v.enc !== 'url') continue;
      tokens(v.t, this.seed, false, (h) => {
        if (this.tok.has(h) || this.own.has(h)) return;
        this.own.add(h);
        if (this.own.size > this.limits.own) this.own.delete(this.own.values().next().value!);
      });
    }
  }

  state(): FlowState | undefined {
    if (!this.sh.size && !this.tok.size && !this.own.size) return undefined;
    const groups = new Map<number, number[]>();
    for (const [fp, v] of this.sh) {
      let g = groups.get(v);
      if (!g) groups.set(v, (g = []));
      g.push(fp);
    }
    const h = new Writer();
    for (const [v, fps] of groups) {
      fps.sort((a, b) => a - b);
      h.vu(v);
      h.vu(fps.length);
      let prev = 0;
      for (const fp of fps) {
        h.vu(fp - prev);
        prev = fp;
      }
    }
    const t = new Writer();
    for (const [k, m] of this.tok) {
      t.u32(k);
      t.vu(m);
    }
    const w = new Writer();
    for (const k of this.own) w.u32(k);
    const st: FlowState = { v: 1, s: this.seed, r: this.r, o: this.slots, u: this.used };
    const hs = h.out();
    const ts = t.out();
    const ws = w.out();
    if (hs) st.h = hs;
    if (ts) st.t = ts;
    if (ws) st.w = ws;
    return st;
  }

  private load(raw: unknown): void {
    const st = raw as FlowState;
    if (!st || st.v !== 1 || typeof st.s !== 'number' || !Array.isArray(st.o)) return; // unknown → start fresh
    try {
      this.seed = st.s >>> 0;
      this.r = Math.max(0, Math.min(32, st.r | 0));
      this.slots = st.o.slice(0, this.limits.origins).map((x) => (typeof x === 'string' ? x : null));
      this.used = this.slots.map((_, i) => Number(st.u?.[i]) || 0);
      this.seq = Math.max(0, ...this.used) + 1;
      const valid = (2 ** this.slots.length - 1) >>> 0;
      if (st.h) {
        const rd = new Reader(st.h);
        while (!rd.done) {
          const v = rd.vu();
          const n = rd.vu();
          const mask = (v >>> 6) & valid;
          let fp = 0;
          for (let i = 0; i < n; i++) {
            fp += rd.vu();
            if (mask) this.sh.set(fp, (mask << 6) | (v & 63));
          }
        }
      }
      if (st.t) {
        const rd = new Reader(st.t);
        while (!rd.done) {
          const k = rd.u32();
          const m = rd.vu() & valid;
          if (m) this.tok.set(k, m);
        }
      }
      if (st.w) {
        const rd = new Reader(st.w);
        while (!rd.done) this.own.add(rd.u32());
      }
    } catch {
      // corrupt state: forget everything rather than half of it
      this.sh.clear();
      this.tok.clear();
      this.own.clear();
    }
  }
}
