// RFC 6265 (with the 6265bis tightening that browsers ship) cookie jar.
//
// Storage is bucketed by cookie domain so that building a Cookie header costs one map lookup per
// label of the request host, not a scan of the whole jar. The jar is the session's source of
// truth across tiers, so `all()` round-trips through `createJar()` exactly (creation order is the
// array order).

import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type { CookieData, CookieJar } from '../types.ts';
import { isPublicSuffix, registrable } from './psl.ts';

export interface JarOptions {
  /** max cookies per registrable domain (Chrome: 180) */
  perDomain?: number;
  /** max cookies in the jar (Chrome: 3000) */
  total?: number;
  /** clock in epoch milliseconds (tests) */
  now?: () => number;
}

interface Cookie extends CookieData {
  hostOnly: boolean;
  /** creation sequence: preserved when a cookie is replaced */
  seq: number;
  /** last time it was sent or set, for LRU eviction */
  used: number;
}

const MAX_AGE_CAP = 400 * 86400; // 6265bis: cap lifetime at 400 days
const MAX_NAME_VALUE = 4096;
const MAX_ATTR = 1024;
const CTL = /[\x00-\x08\x0a-\x1f\x7f]/;

export function createJar(data?: CookieData[], opts: JarOptions = {}): CookieJar & { size(): number } {
  const perDomain = opts.perDomain ?? 180;
  const totalCap = opts.total ?? 3000;
  const now = opts.now ?? Date.now;
  const buckets = new Map<string, Cookie[]>();
  let count = 0;
  let seq = 0;

  const nowSec = () => Math.floor(now() / 1000);
  const expired = (c: Cookie, t: number) => c.expires !== undefined && c.expires <= t;

  function remove(c: Cookie) {
    const b = buckets.get(c.domain);
    if (!b) return;
    const i = b.indexOf(c);
    if (i >= 0) {
      b.splice(i, 1);
      count--;
      if (!b.length) buckets.delete(c.domain);
    }
  }

  function findSame(name: string, domain: string, path: string): Cookie | undefined {
    const b = buckets.get(domain);
    if (!b) return undefined;
    for (const c of b) if (c.name === name && c.path === path) return c;
    return undefined;
  }

  function evictExpired(t: number) {
    for (const [d, b] of buckets) {
      for (let i = b.length - 1; i >= 0; i--) if (expired(b[i], t)) { b.splice(i, 1); count--; }
      if (!b.length) buckets.delete(d);
    }
  }

  function lru(filter: (c: Cookie) => boolean): Cookie | undefined {
    let best: Cookie | undefined;
    for (const b of buckets.values()) {
      for (const c of b) if (filter(c) && (!best || c.used < best.used || (c.used === best.used && c.seq < best.seq))) best = c;
    }
    return best;
  }

  function enforceCaps(added: Cookie) {
    const reg = registrable(added.domain);
    let inReg = 0;
    for (const [d, b] of buckets) if (registrable(d) === reg) inReg += b.length;
    if (inReg > perDomain || count > totalCap) evictExpired(nowSec());
    while (true) {
      inReg = 0;
      for (const [d, b] of buckets) if (registrable(d) === reg) inReg += b.length;
      if (inReg <= perDomain) break;
      const victim = lru((c) => c !== added && registrable(c.domain) === reg);
      if (!victim) break;
      remove(victim);
    }
    while (count > totalCap) {
      const victim = lru((c) => c !== added);
      if (!victim) break;
      remove(victim);
    }
  }

  /** insert or replace (a replacement keeps the original creation order) */
  function upsert(c: Omit<Cookie, 'seq' | 'used'>, existingSeq?: number): void {
    const old = findSame(c.name, c.domain, c.path);
    if (old) remove(old);
    if (c.expires !== undefined && c.expires <= nowSec()) return; // expiring an existing cookie
    const t = now();
    const full: Cookie = { ...c, seq: old ? old.seq : (existingSeq ?? ++seq), used: t };
    if (full.seq > seq) seq = full.seq;
    let b = buckets.get(full.domain);
    if (!b) buckets.set(full.domain, (b = []));
    // keep each bucket in creation order so header() and all() are deterministic
    let i = b.length;
    while (i > 0 && b[i - 1].seq > full.seq) i--;
    b.splice(i, 0, full);
    count++;
    enforceCaps(full);
  }

  function fromData(d: CookieData): Omit<Cookie, 'seq' | 'used'> | undefined {
    if (typeof d.name !== 'string' || typeof d.value !== 'string' || !d.domain) return undefined;
    const rawDomain = String(d.domain).toLowerCase();
    const hostOnly = d.hostOnly ?? !rawDomain.startsWith('.');
    const domain = canonHost(rawDomain.replace(/^\.+/, ''));
    if (!domain) return undefined;
    const out: Omit<Cookie, 'seq' | 'used'> = {
      name: d.name,
      value: d.value,
      domain,
      path: d.path && d.path.startsWith('/') ? d.path : '/',
      hostOnly,
    };
    if (d.expires !== undefined && d.expires !== null && Number.isFinite(d.expires) && d.expires >= 0) out.expires = Math.floor(d.expires);
    if (d.secure) out.secure = true;
    if (d.httpOnly) out.httpOnly = true;
    if (d.sameSite === 'Strict' || d.sameSite === 'Lax' || d.sameSite === 'None') out.sameSite = d.sameSite;
    return out;
  }

  function matching(u: URL, touch: boolean): Cookie[] {
    const host = canonHost(u.hostname);
    if (!host) return [];
    const secure = isSecureUrl(u);
    const path = u.pathname || '/';
    const t = nowSec();
    const out: Cookie[] = [];
    const ip = isIP(stripBrackets(host)) !== 0;
    let d = host;
    while (true) {
      const b = buckets.get(d);
      if (b) {
        for (let i = 0; i < b.length; i++) {
          const c = b[i];
          if (expired(c, t)) { b.splice(i--, 1); count--; continue; }
          if (c.hostOnly && d !== host) continue;
          if (c.secure && !secure) continue;
          if (!pathMatch(path, c.path)) continue;
          out.push(c);
        }
        if (!b.length) buckets.delete(d);
      }
      if (ip) break;
      const dot = d.indexOf('.');
      if (dot < 0) break;
      d = d.slice(dot + 1);
    }
    out.sort((a, b) => b.path.length - a.path.length || a.seq - b.seq);
    if (touch) { const tm = now(); for (const c of out) c.used = tm; }
    return out;
  }

  function parseAndStore(u: URL, line: string) {
    const p = parseSetCookie(line, nowSec());
    if (!p) return;
    const host = canonHost(u.hostname);
    if (!host) return;
    const ip = isIP(stripBrackets(host)) !== 0;
    let domain = host;
    let hostOnly = true;
    if (p.domain !== undefined) {
      const dom = canonHost(p.domain);
      if (!dom) return;
      if (ip) {
        if (dom !== host) return;
      } else if (isPublicSuffix(dom)) {
        if (dom !== host) return; // Domain=com, Domain=github.io from a subdomain: refuse
      } else {
        if (!domainMatch(host, dom)) return;
        domain = dom;
        hostOnly = false;
      }
    }
    const secureUrl = isSecureUrl(u);
    if (p.secure && !secureUrl) return;
    const lname = p.name.toLowerCase();
    if (lname.startsWith('__secure-') && !p.secure) return;
    if (lname.startsWith('__host-') && (!p.secure || !hostOnly || p.path !== '/')) return;
    if (p.sameSite === 'None' && !p.secure) return; // browsers reject SameSite=None without Secure
    const path = p.path ?? defaultPath(u.pathname);
    // "leave secure cookies alone": an insecure origin may not shadow a secure cookie
    if (!p.secure && !secureUrl) {
      for (const [bd, b] of buckets) {
        if (!(domainMatch(bd, domain) || domainMatch(domain, bd))) continue;
        for (const c of b) if (c.secure && c.name === p.name && pathMatch(path, c.path)) return;
      }
    }
    const c: Omit<Cookie, 'seq' | 'used'> = { name: p.name, value: p.value, domain, path, hostOnly };
    if (p.expires !== undefined) c.expires = p.expires;
    if (p.secure) c.secure = true;
    if (p.httpOnly) c.httpOnly = true;
    if (p.sameSite) c.sameSite = p.sameSite;
    upsert(c);
  }

  const jar = {
    header(url: string): string {
      let u: URL;
      try { u = new URL(url); } catch { return ''; }
      const list = matching(u, true);
      if (!list.length) return '';
      let s = '';
      for (const c of list) {
        if (s) s += '; ';
        s += c.name ? `${c.name}=${c.value}` : c.value;
      }
      return s;
    },
    setFromHeaders(url: string, setCookie: string[]): void {
      let u: URL;
      try { u = new URL(url); } catch { return; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      for (const line of setCookie) if (line) parseAndStore(u, line);
    },
    all(): CookieData[] {
      evictExpired(nowSec());
      const flat: Cookie[] = [];
      for (const b of buckets.values()) flat.push(...b);
      flat.sort((a, b) => a.seq - b.seq);
      return flat.map((c) => {
        const d: CookieData = { name: c.name, value: c.value, domain: c.domain, path: c.path, hostOnly: c.hostOnly };
        if (c.expires !== undefined) d.expires = c.expires;
        if (c.secure) d.secure = true;
        if (c.httpOnly) d.httpOnly = true;
        if (c.sameSite) d.sameSite = c.sameSite;
        return d;
      });
    },
    set(c: CookieData): void {
      const x = fromData(c);
      if (x) upsert(x);
    },
    merge(cookies: CookieData[]): void {
      for (const c of cookies) jar.set(c);
    },
    has(url: string): boolean {
      try { return matching(new URL(url), false).length > 0; } catch { return false; }
    },
    clear(): void {
      buckets.clear();
      count = 0;
    },
    size(): number {
      return count;
    },
  };

  if (data) for (const d of data) jar.set(d);
  return jar;
}

// ───────────────────────────── parsing ─────────────────────────────

export interface ParsedCookie {
  name: string;
  value: string;
  /** epoch seconds */
  expires?: number;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Parse one Set-Cookie header value (RFC 6265 §5.2 / 6265bis). Returns undefined to ignore it. */
export function parseSetCookie(line: string, nowSec = Math.floor(Date.now() / 1000)): ParsedCookie | undefined {
  if (CTL.test(line)) return undefined;
  const semi = line.indexOf(';');
  const pair = semi < 0 ? line : line.slice(0, semi);
  const eq = pair.indexOf('=');
  const name = eq < 0 ? '' : pair.slice(0, eq).trim();
  const value = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
  if (!name && !value) return undefined;
  if (name.length + value.length > MAX_NAME_VALUE) return undefined;
  // a nameless cookie whose value looks like a prefixed name would bypass the prefix rules
  if (!name && /^__(secure|host)-/i.test(value)) return undefined;
  const out: ParsedCookie = { name, value };
  let maxAge: number | undefined;
  let expires: number | undefined;
  if (semi >= 0) {
    for (const raw of line.slice(semi + 1).split(';')) {
      const i = raw.indexOf('=');
      const key = (i < 0 ? raw : raw.slice(0, i)).trim().toLowerCase();
      const val = i < 0 ? '' : raw.slice(i + 1).trim();
      if (val.length > MAX_ATTR) continue;
      switch (key) {
        case 'expires': {
          const t = parseCookieDate(val);
          if (t !== undefined) expires = Math.floor(t / 1000);
          break;
        }
        case 'max-age': {
          if (!/^-?\d+$/.test(val)) break;
          const n = Number(val);
          maxAge = n;
          break;
        }
        case 'domain':
          if (val) out.domain = val.replace(/^\.+/, '').toLowerCase();
          break;
        case 'path':
          out.path = val && val[0] === '/' ? val : undefined;
          break;
        case 'secure':
          out.secure = true;
          break;
        case 'httponly':
          out.httpOnly = true;
          break;
        case 'samesite': {
          const v = val.toLowerCase();
          out.sameSite = v === 'strict' ? 'Strict' : v === 'lax' ? 'Lax' : v === 'none' ? 'None' : undefined;
          if (!out.sameSite) delete out.sameSite;
          break;
        }
      }
    }
  }
  if (out.path === undefined) delete out.path;
  // Max-Age wins over Expires
  if (maxAge !== undefined) out.expires = maxAge <= 0 ? 0 : nowSec + Math.min(maxAge, MAX_AGE_CAP);
  else if (expires !== undefined) out.expires = Math.max(0, Math.min(expires, nowSec + MAX_AGE_CAP));
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** RFC 6265 §5.1.1 cookie-date algorithm. Returns epoch ms or undefined. */
export function parseCookieDate(s: string): number | undefined {
  // delimiters are %x09 / %x20-2F / %x3B-40 / %x5B-60 / %x7B-7E (':' is not one)
  const tokens = s.split(/[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/);
  let hh: number | undefined, mm = 0, ss = 0;
  let day: number | undefined, month: number | undefined, year: number | undefined;
  for (const tok of tokens) {
    if (!tok) continue;
    let m: RegExpExecArray | null;
    if (hh === undefined && (m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D|$)/.exec(tok))) {
      hh = +m[1]; mm = +m[2]; ss = +m[3];
    } else if (day === undefined && (m = /^(\d{1,2})(?:\D|$)/.exec(tok))) {
      day = +m[1];
    } else if (month === undefined && MONTHS.includes(tok.slice(0, 3).toLowerCase())) {
      month = MONTHS.indexOf(tok.slice(0, 3).toLowerCase());
    } else if (year === undefined && (m = /^(\d{2,4})(?:\D|$)/.exec(tok))) {
      year = +m[1];
    }
  }
  if (year !== undefined) {
    if (year >= 70 && year <= 99) year += 1900;
    else if (year >= 0 && year <= 69) year += 2000;
  }
  if (day === undefined || month === undefined || year === undefined || hh === undefined) return undefined;
  if (day < 1 || day > 31 || year < 1601 || hh > 23 || mm > 59 || ss > 59) return undefined;
  const t = Date.UTC(year, month, day, hh, mm, ss);
  if (new Date(t).getUTCDate() !== day) return undefined; // Feb 30 and friends
  return t;
}

// ───────────────────────────── matching ─────────────────────────────

function stripBrackets(h: string) {
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function canonHost(h: string): string {
  if (!h) return '';
  let x = h.toLowerCase().replace(/\.$/, '');
  if (/[^\x00-\x7f]/.test(x)) x = domainToASCII(x);
  return x;
}

function isSecureUrl(u: URL): boolean {
  if (u.protocol === 'https:' || u.protocol === 'wss:') return true;
  // browsers treat loopback as a secure context for cookie purposes
  const h = stripBrackets(u.hostname);
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

export function domainMatch(host: string, domain: string): boolean {
  if (host === domain) return true;
  return host.endsWith('.' + domain) && isIP(stripBrackets(host)) === 0;
}

export function pathMatch(reqPath: string, cookiePath: string): boolean {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
}

export function defaultPath(p: string): string {
  if (!p || p[0] !== '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
