// SSRF defence. An agent service that fetches arbitrary URLs is a request-forgery cannon pointed at
// whatever network it runs in, so in hosted mode every destination must be a public address.
//
// Three layers, all needed:
//   1. `checkUrlSafety` refuses bad schemes, embedded credentials, internal hostnames and numeric
//      hosts in any encoding a resolver accepts, then resolves every A/AAAA record and requires all
//      of them to be public.
//   2. `ssrfLookup` / `makeSsrfLookup` has `dns.lookup`'s signature and is meant to be passed to the
//      HTTP client as its connect-time `lookup`. The address the socket actually connects to is the
//      one checked, so DNS rebinding (public at check time, private at connect time) cannot win.
//   3. Cloud metadata endpoints are refused in every mode, including local mode with
//      `allowPrivate`, because a prompt-injected agent on a cloud VM would otherwise read the
//      instance credentials.
//
// Note: Node's `net.connect` does not call `lookup` for IP-literal hosts, so layer 1 is what covers
// literal addresses; engines must call `checkUrl` for every navigation and redirect hop.

import dns from 'node:dns';
import net from 'node:net';
import { AwError } from '../types.ts';

// ───────────────────────────── address parsing ─────────────────────────────

/**
 * Parse an IPv4 address the way `inet_aton` and the WHATWG URL parser do: 1 to 4 parts, each
 * decimal, `0x` hex or leading-zero octal, the last part filling the remaining bytes. A single
 * trailing dot is accepted. Returns the address as an unsigned 32-bit number, or null.
 */
export function parseIPv4Loose(s: string): number | null {
  if (!s || s.length > 64) return null;
  if (s.endsWith('.')) s = s.slice(0, -1);
  const parts = s.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    let n: number;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^(0|[1-9][0-9]*)$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  const last = nums.pop()!;
  for (const n of nums) if (n > 255) return null;
  if (last >= 256 ** (4 - nums.length)) return null;
  let v = 0;
  for (let i = 0; i < nums.length; i++) v += nums[i] * 256 ** (3 - i);
  return v + last;
}

/** Strict dotted-decimal IPv4 (what appears inside IPv6 text forms). */
function parseIPv4Strict(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let v = 0;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n > 255 || (m[i].length > 1 && m[i][0] === '0')) return null;
    v = v * 256 + n;
  }
  return v;
}

/** Parse IPv6 text (optionally bracketed, optionally with a zone id) into eight 16-bit words. */
export function parseIPv6(s: string): number[] | null {
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(':') || s.length > 64) return null;
  const lastColon = s.lastIndexOf(':');
  const lastPart = s.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    // trailing dotted IPv4 ("::ffff:127.0.0.1") → two hex groups
    const n = parseIPv4Strict(lastPart);
    if (n === null) return null;
    s = s.slice(0, lastColon + 1) + (n >>> 16).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const tail: number[] = [];
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string): number[] | null => {
    if (h === '') return [];
    const out: number[] = [];
    for (const g of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  if (!head) return null;
  if (halves.length === 1) {
    const all = [...head, ...tail];
    return all.length === 8 ? all : null;
  }
  const back = parse(halves[1]);
  if (!back) return null;
  const fill = 8 - head.length - back.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...back, ...tail];
}

const v4 = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
const inV4 = (ip: number, base: number, bits: number) =>
  bits === 0 ? true : ip >>> (32 - bits) === base >>> (32 - bits);

/** IPv4 ranges that are not globally reachable (IANA special-purpose registry, conservatively). */
const V4_BLOCKED: [number, number, string][] = [
  [v4(0, 0, 0, 0), 8, 'this-network'],
  [v4(10, 0, 0, 0), 8, 'private'],
  [v4(100, 64, 0, 0), 10, 'carrier-grade NAT'],
  [v4(127, 0, 0, 0), 8, 'loopback'],
  [v4(169, 254, 0, 0), 16, 'link-local'],
  [v4(172, 16, 0, 0), 12, 'private'],
  [v4(192, 0, 0, 0), 24, 'IETF protocol assignment'],
  [v4(192, 0, 2, 0), 24, 'documentation'],
  [v4(192, 88, 99, 0), 24, '6to4 relay anycast'],
  [v4(192, 168, 0, 0), 16, 'private'],
  [v4(198, 18, 0, 0), 15, 'benchmarking'],
  [v4(198, 51, 100, 0), 24, 'documentation'],
  [v4(203, 0, 113, 0), 24, 'documentation'],
  [v4(224, 0, 0, 0), 4, 'multicast'],
  [v4(240, 0, 0, 0), 4, 'reserved'], // includes 255.255.255.255 broadcast
];

/** Cloud instance-metadata and host-agent endpoints. Refused in every mode. */
const V4_METADATA = new Set<number>([
  v4(169, 254, 169, 254), // AWS, GCP, Azure, OCI, DigitalOcean, Hetzner, OpenStack
  v4(169, 254, 170, 2), // AWS ECS task metadata
  v4(169, 254, 170, 23), // AWS EKS pod identity
  v4(169, 254, 0, 23), // Tencent Cloud
  v4(100, 100, 100, 200), // Alibaba Cloud
  v4(192, 0, 0, 192), // Oracle Cloud (legacy)
  v4(168, 63, 129, 16), // Azure WireServer: a *public* address that only answers inside Azure
]);
const V6_METADATA = ['fd00:ec2::254', 'fd00:ec2::23'].map((s) => parseIPv6(s)!.join(':'));

export const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.tencentyun.com',
]);

function v4Class(ip: number): string | null {
  for (const [base, bits, label] of V4_BLOCKED) if (inV4(ip, base, bits)) return label;
  return null;
}

/** The IPv4 address embedded in a mapped / compatible / translated / NAT64 IPv6 address. */
function embeddedV4(w: number[]): number | null {
  const z = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  const tail = ((w[6] << 16) | w[7]) >>> 0;
  if (z(0, 5) && w[5] === 0xffff) return tail; // ::ffff:a.b.c.d  mapped
  if (z(0, 6)) return tail; // ::a.b.c.d  compatible (deprecated); covers :: and ::1
  if (z(0, 4) && w[4] === 0xffff && w[5] === 0) return tail; // ::ffff:0:a.b.c.d  SIIT translated
  if (w[0] === 0x64 && w[1] === 0xff9b && z(2, 6)) return tail; // 64:ff9b::/96 NAT64
  return null;
}

/** Why an address is not public, or null when it is. Unparseable input is "not an address". */
export function addressClass(ip: string): string | null {
  ip = ip.trim();
  if (net.isIPv4(ip) || /^[0-9a-fx.]+$/i.test(ip)) {
    const n = parseIPv4Loose(ip);
    if (n === null) return 'not an IP address';
    if (V4_METADATA.has(n)) return 'cloud metadata';
    return v4Class(n);
  }
  const w = parseIPv6(ip);
  if (!w) return 'not an IP address';
  if (V6_METADATA.includes(w.join(':'))) return 'cloud metadata';
  const e = embeddedV4(w);
  if (e !== null) {
    if (V4_METADATA.has(e)) return 'cloud metadata';
    const c = v4Class(e);
    return c ? `IPv4-embedded ${c}` : null;
  }
  if (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) return 'local-use NAT64';
  if ((w[0] & 0xe000) !== 0x2000) {
    // outside 2000::/3 global unicast: ULA fc00::/7, link-local fe80::/10, multicast ff00::/8,
    // site-local fec0::/10, discard 100::/64, SRv6 5f00::/16 ...
    if ((w[0] & 0xfe00) === 0xfc00) return 'unique-local';
    if ((w[0] & 0xffc0) === 0xfe80) return 'link-local';
    if ((w[0] & 0xff00) === 0xff00) return 'multicast';
    return 'reserved';
  }
  if (w[0] === 0x2002) {
    // 6to4: 2002:AABB:CCDD::/48 carries IPv4 AA.BB.CC.DD
    const e4 = ((w[1] << 16) | w[2]) >>> 0;
    if (V4_METADATA.has(e4)) return 'cloud metadata';
    const c = v4Class(e4);
    return c ? `6to4-embedded ${c}` : null;
  }
  if (w[0] === 0x2001 && w[1] === 0) {
    // Teredo: server IPv4 in words 2-3, client IPv4 obfuscated (inverted) in words 6-7
    const server = ((w[2] << 16) | w[3]) >>> 0;
    const client = (~((w[6] << 16) | w[7])) >>> 0;
    for (const e4 of [server, client]) {
      if (V4_METADATA.has(e4)) return 'cloud metadata';
      const c = v4Class(e4);
      if (c) return `Teredo-embedded ${c}`;
    }
    return null;
  }
  if (w[0] === 0x2001 && w[1] < 0x200) return 'IETF protocol assignment'; // 2001::/23
  if (w[0] === 0x2001 && w[1] === 0x0db8) return 'documentation';
  if (w[0] === 0x3fff && w[1] < 0x1000) return 'documentation'; // 3fff::/20
  return null;
}

/** True only for a globally reachable unicast address. Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  return addressClass(ip) === null;
}

export function isMetadataAddress(ip: string): boolean {
  return addressClass(ip) === 'cloud metadata';
}

// ───────────────────────────── hostnames ─────────────────────────────

const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'home.arpa', 'localdomain', 'lan', 'intranet', 'corp', 'home'];
const LOCAL_NAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback', 'localhost.localdomain', 'broadcasthost']);

/** Lower-case, strip brackets and trailing dots. */
export function normHost(h: string): string {
  h = h.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

/** If `host` is a numeric address in any encoding a resolver accepts, its canonical text form. */
export function numericHost(host: string): string | null {
  const h = normHost(host);
  if (h.includes(':')) return parseIPv6(h) ? h : null;
  const n = parseIPv4Loose(h);
  if (n === null) return null;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Why a hostname must be treated as internal without resolving it, or null. */
export function internalHostReason(host: string): string | null {
  const h = normHost(host);
  if (!h) return 'empty host';
  if (METADATA_HOSTS.has(h)) return 'cloud metadata host';
  if (LOCAL_NAMES.has(h)) return 'localhost';
  for (const s of INTERNAL_SUFFIXES) if (h === s || h.endsWith('.' + s)) return `.${s} name`;
  if (!h.includes('.') && !h.includes(':') && numericHost(h) === null) return 'single-label (intranet) name';
  return null;
}

// ───────────────────────────── URL check ─────────────────────────────

/** Resolve a hostname to every address (A and AAAA). Injected in tests. */
export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  // dns.lookup (getaddrinfo) rather than dns.resolve: it is what the socket uses at connect time,
  // including /etc/hosts, so the check and the connection see the same answers.
  const res = await dns.promises.lookup(host, { all: true, verbatim: true });
  return res.map((r) => r.address);
};

export interface UrlCheckOptions {
  allowPrivate: boolean;
  resolve?: Resolver;
  /** ms; DNS that takes longer is treated as a failure */
  dnsTimeoutMs?: number;
}

export type UrlCheck = { ok: true; url: URL; host: string; addresses?: string[] } | { ok: false; reason: string };

const DNS_CACHE_TTL_MS = 30_000;
const DNS_CACHE_MAX = 512;
const dnsCaches = new WeakMap<Resolver, Map<string, { at: number; addrs: string[] }>>();

async function resolveCached(resolve: Resolver, host: string, timeoutMs: number): Promise<string[]> {
  let cache = dnsCaches.get(resolve);
  if (!cache) dnsCaches.set(resolve, (cache = new Map()));
  const hit = cache.get(host);
  const now = Date.now();
  if (hit && now - hit.at < DNS_CACHE_TTL_MS) return hit.addrs;
  let timer: NodeJS.Timeout | undefined;
  const addrs = await Promise.race([
    resolve(host),
    new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error('DNS timeout')), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
  if (cache.size >= DNS_CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(host, { at: now, addrs });
  return addrs;
}

/**
 * Scheme, credentials, hostname and address checks for one URL. Allow/deny lists are applied by
 * the guard, not here.
 */
export async function checkUrlSafety(raw: string, opts: UrlCheckOptions): Promise<UrlCheck> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'not a valid absolute URL' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    return { ok: false, reason: `scheme ${u.protocol} is not allowed (http and https only)` };
  if (u.username || u.password)
    return { ok: false, reason: 'URLs with embedded credentials are refused; use a {{secret:name}} handle in a form field instead' };
  const host = normHost(u.hostname);
  const label = u.host;

  if (METADATA_HOSTS.has(host)) return { ok: false, reason: `${label} is a cloud metadata endpoint` };
  const num = numericHost(host);
  if (num !== null) {
    const cls = addressClass(num);
    if (cls === 'cloud metadata') return { ok: false, reason: `${label} is a cloud metadata endpoint` };
    if (cls && !opts.allowPrivate) return { ok: false, reason: `${label} is a ${cls} address` };
    return { ok: true, url: u, host, addresses: [num] };
  }
  if (opts.allowPrivate) return { ok: true, url: u, host };

  const why = internalHostReason(host);
  if (why) return { ok: false, reason: `${label} is an internal host (${why})` };

  let addrs: string[];
  try {
    addrs = await resolveCached(opts.resolve ?? systemResolver, host, opts.dnsTimeoutMs ?? 5000);
  } catch (e) {
    return { ok: false, reason: `cannot resolve ${host} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})` };
  }
  if (!addrs.length) return { ok: false, reason: `${host} has no addresses` };
  for (const a of addrs) {
    const cls = addressClass(a);
    if (cls) return { ok: false, reason: `${host} resolves to ${a}, a ${cls} address` };
  }
  return { ok: true, url: u, host, addresses: addrs };
}

// ───────────────────────────── connect-time lookup ─────────────────────────────

export type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** `dns.lookup`'s call signature (all three overloads). */
export interface LookupFn {
  (hostname: string, callback: LookupCallback): void;
  (hostname: string, options: number | dns.LookupOptions, callback: LookupCallback): void;
}

function policyError(msg: string): NodeJS.ErrnoException {
  // AwError so callers that unwrap `err.cause` (undici: TypeError('fetch failed', {cause})) can
  // map it straight to a policy refusal.
  return new AwError('policy', msg) as unknown as NodeJS.ErrnoException;
}

/**
 * Build a `dns.lookup`-compatible function that resolves every address for the host and fails if
 * any of them is refused. With `allowPrivate` only cloud metadata addresses are refused.
 * Pass it as the HTTP client's connect `lookup` (undici `connect: { lookup }`, `http.request({ lookup })`).
 */
export function makeSsrfLookup(opts: { allowPrivate?: boolean; lookup?: typeof dns.lookup } = {}): LookupFn {
  const base = opts.lookup ?? dns.lookup;
  const allowPrivate = !!opts.allowPrivate;
  function lookup(hostname: string, a: unknown, b?: unknown): void {
    const cb = (typeof a === 'function' ? a : b) as LookupCallback;
    const o: dns.LookupOptions = typeof a === 'number' ? { family: a } : typeof a === 'object' && a ? { ...(a as dns.LookupOptions) } : {};
    const wantAll = !!o.all;
    const h = normHost(hostname);
    if (!allowPrivate) {
      const why = numericHost(h) === null ? internalHostReason(h) : null;
      if (why) return void process.nextTick(cb, policyError(`${hostname} is an internal host (${why})`), wantAll ? [] : '', 0);
    } else if (METADATA_HOSTS.has(h)) {
      return void process.nextTick(cb, policyError(`${hostname} is a cloud metadata endpoint`), wantAll ? [] : '', 0);
    }
    base(hostname, { ...o, all: true }, (err, addrs) => {
      if (err) return cb(err, wantAll ? [] : '', 0);
      const list = addrs as dns.LookupAddress[];
      for (const x of list) {
        const cls = addressClass(x.address);
        if (cls && (!allowPrivate || cls === 'cloud metadata'))
          return cb(policyError(`refused to connect to ${hostname}: ${x.address} is a ${cls} address`), wantAll ? [] : '', 0);
      }
      if (!list.length) return cb(Object.assign(new Error(`no addresses for ${hostname}`), { code: 'ENOTFOUND' }), wantAll ? [] : '', 0);
      if (wantAll) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  }
  return lookup as LookupFn;
}

/** Strict connect-time lookup: every resolved address must be public. */
export const ssrfLookup: LookupFn = makeSsrfLookup();
