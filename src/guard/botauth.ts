// Web Bot Auth: a cryptographic identity for the agent, so sites can tell a well-behaved,
// accountable agent from an anonymous scraper. HTTP Message Signatures (RFC 9421) with Ed25519,
// key id = JWK thumbprint (RFC 7638), covering `@authority` and `signature-agent`, tagged
// `web-bot-auth`, as in draft-meunier-web-bot-auth-architecture. The public key is published in a
// key directory (draft-meunier-http-message-signatures-directory) at
// `/.well-known/http-message-signatures-directory` on the origin named by `Signature-Agent`.
//
// Signature-Agent is sent as an sf-string (`"https://agent.example"`), the form deployed by
// Cloudflare and others; later drafts discuss a dictionary form.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AwError } from '../types.ts';

export const DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const DIRECTORY_TYPE = 'application/http-message-signatures-directory+json';

export interface BotKey {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** public JWK (kty, crv, x) */
  jwk: JsonWebKey;
  /** RFC 7638 thumbprint, base64url */
  keyid: string;
}

// ───────────────────────────── keys ─────────────────────────────

/** RFC 7638 thumbprint of an OKP (Ed25519) public JWK. */
export function jwkThumbprint(jwk: JsonWebKey): string {
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') throw new AwError('bad_request', 'expected an Ed25519 OKP JWK');
  // required members only, lexicographic order, no whitespace
  const canon = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
  return createHash('sha256').update(canon).digest('base64url');
}

function fromPrivate(privateKey: KeyObject): BotKey {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new AwError('bad_request', 'bot key must be Ed25519');
  const publicKey = createPublicKey(privateKey);
  const full = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const jwk: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', x: full.x };
  return { privateKey, publicKey, jwk, keyid: jwkThumbprint(jwk) };
}

export function generateBotKey(): BotKey {
  return fromPrivate(generateKeyPairSync('ed25519').privateKey);
}

/** Load a private key from a JWK (object or JSON text, with `d`) or PKCS#8 PEM. */
export function loadBotKey(src: string | JsonWebKey | KeyObject): BotKey {
  try {
    if (typeof src === 'object' && 'asymmetricKeyType' in src) return fromPrivate(src as KeyObject);
    if (typeof src === 'string' && src.trim().startsWith('-----')) return fromPrivate(createPrivateKey(src));
    const jwk = typeof src === 'string' ? (JSON.parse(src) as JsonWebKey) : (src as JsonWebKey);
    return fromPrivate(createPrivateKey({ key: jwk, format: 'jwk' }));
  } catch (e) {
    if (e instanceof AwError) throw e;
    // do not include the parser's message: it may quote key material
    throw new AwError('bad_request', 'cannot load bot key (expected an Ed25519 private JWK or PKCS#8 PEM)');
  }
}

/** Private JWK as JSON, for persisting a generated key. Treat as a secret. */
export function exportBotKey(k: BotKey): string {
  return JSON.stringify(k.privateKey.export({ format: 'jwk' }));
}

/** `AGENTWEB_BOT_KEY` (JWK JSON or PEM) or `AGENTWEB_BOT_KEY_FILE`; null if neither is set. */
export function botKeyFromEnv(env: Record<string, string | undefined>): BotKey | null {
  if (env.AGENTWEB_BOT_KEY) return loadBotKey(env.AGENTWEB_BOT_KEY);
  if (env.AGENTWEB_BOT_KEY_FILE) {
    let raw: string;
    try {
      raw = readFileSync(env.AGENTWEB_BOT_KEY_FILE, 'utf8');
    } catch (e) {
      throw new AwError('bad_request', `cannot read bot key file: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    return loadBotKey(raw);
  }
  return null;
}

// ───────────────────────────── structured fields (RFC 8941 subset) ─────────────────────────────

export type BareItem = string | number | boolean | { token: string } | { bytes: Buffer };
export interface Item {
  v: BareItem;
  p: [string, BareItem][];
}
export interface InnerList {
  list: Item[];
  p: [string, BareItem][];
}

function serBare(v: BareItem): string {
  if (typeof v === 'string') return '"' + v.replace(/[\\"]/g, '\\$&') + '"';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');
  if (typeof v === 'boolean') return v ? '?1' : '?0';
  if ('token' in v) return v.token;
  return ':' + v.bytes.toString('base64') + ':';
}

function serParams(p: [string, BareItem][]): string {
  return p.map(([k, v]) => (v === true ? `;${k}` : `;${k}=${serBare(v)}`)).join('');
}

export function serItem(i: Item): string {
  return serBare(i.v) + serParams(i.p);
}

export function serInnerList(l: InnerList): string {
  return '(' + l.list.map(serItem).join(' ') + ')' + serParams(l.p);
}

class SfParser {
  i = 0;
  s: string;
  constructor(s: string) {
    this.s = s;
  }
  fail(): never {
    throw new Error('structured field syntax');
  }
  ws() {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
  }
  key(): string {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(this.s.slice(this.i));
    if (!m) this.fail();
    this.i += m[0].length;
    return m[0];
  }
  bare(): BareItem {
    const c = this.s[this.i];
    if (c === '"') {
      let out = '';
      for (this.i++; this.i < this.s.length; this.i++) {
        const ch = this.s[this.i];
        if (ch === '\\') {
          const n = this.s[++this.i];
          if (n !== '"' && n !== '\\') this.fail();
          out += n;
        } else if (ch === '"') {
          this.i++;
          return out;
        } else out += ch;
      }
      this.fail();
    }
    if (c === ':') {
      const end = this.s.indexOf(':', this.i + 1);
      if (end < 0) this.fail();
      const b = this.s.slice(this.i + 1, end);
      if (!/^[A-Za-z0-9+/=]*$/.test(b)) this.fail();
      this.i = end + 1;
      return { bytes: Buffer.from(b, 'base64') };
    }
    if (c === '?') {
      const v = this.s[this.i + 1];
      if (v !== '0' && v !== '1') this.fail();
      this.i += 2;
      return v === '1';
    }
    const num = /^-?\d{1,15}(?:\.\d{1,3})?/.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return Number(num[0]);
    }
    const tok = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/.exec(this.s.slice(this.i));
    if (tok) {
      this.i += tok[0].length;
      return { token: tok[0] };
    }
    this.fail();
  }
  params(): [string, BareItem][] {
    const p: [string, BareItem][] = [];
    while (this.s[this.i] === ';') {
      this.i++;
      this.ws();
      const k = this.key();
      let v: BareItem = true;
      if (this.s[this.i] === '=') {
        this.i++;
        v = this.bare();
      }
      p.push([k, v]);
    }
    return p;
  }
  itemOrList(): Item | InnerList {
    if (this.s[this.i] === '(') {
      this.i++;
      const list: Item[] = [];
      for (;;) {
        this.ws();
        if (this.s[this.i] === ')') {
          this.i++;
          return { list, p: this.params() };
        }
        if (this.i >= this.s.length) this.fail();
        list.push({ v: this.bare(), p: this.params() });
        if (this.s[this.i] !== ' ' && this.s[this.i] !== ')') this.fail();
      }
    }
    return { v: this.bare(), p: this.params() };
  }
  dictionary(): Map<string, Item | InnerList> {
    const out = new Map<string, Item | InnerList>();
    this.ws();
    while (this.i < this.s.length) {
      const k = this.key();
      if (this.s[this.i] === '=') {
        this.i++;
        out.set(k, this.itemOrList());
      } else out.set(k, { v: true, p: this.params() });
      this.ws();
      if (this.i >= this.s.length) break;
      if (this.s[this.i] !== ',') this.fail();
      this.i++;
      this.ws();
    }
    return out;
  }
}

export function parseDictionary(s: string): Map<string, Item | InnerList> {
  return new SfParser(s.trim()).dictionary();
}

// ───────────────────────────── signing ─────────────────────────────

export interface SignOptions {
  /** epoch seconds (default: now) */
  now?: number;
  /** lifetime in seconds (default 60) */
  ttl?: number;
  label?: string;
  nonce?: string;
}

export interface BotSigner {
  readonly keyid: string;
  readonly agent: string;
  /** headers to add to a request for `url` */
  headers(url: string, opts?: SignOptions): Record<string, string>;
  /** the key directory JSON document */
  directory(): { keys: JsonWebKey[] };
  /** a full, signed response for GET /.well-known/http-message-signatures-directory */
  directoryResponse(authority: string, opts?: SignOptions): { status: number; headers: Record<string, string>; body: string };
}

/** `host[:port]` as it appears in `@authority` (lower-case, default port omitted). */
export function authorityOf(url: string): string {
  return new URL(url).host.toLowerCase();
}

function componentId(it: Item): string {
  return serItem(it);
}

/** RFC 9421 §2.5 signature base. `values` maps component identifiers (serialised) to values. */
export function signatureBase(params: InnerList, values: Map<string, string>): string {
  const lines: string[] = [];
  for (const it of params.list) {
    const id = componentId(it);
    const v = values.get(id);
    if (v === undefined) throw new Error(`missing component ${id}`);
    lines.push(`${id}: ${v}`);
  }
  lines.push(`"@signature-params": ${serInnerList(params)}`);
  return lines.join('\n');
}

function sigParams(keyid: string, now: number, ttl: number, nonce: string, tag: string, comps: Item[]): InnerList {
  return {
    list: comps,
    p: [
      ['created', now],
      ['keyid', keyid],
      ['alg', 'ed25519'],
      ['expires', now + ttl],
      ['nonce', nonce],
      ['tag', tag],
    ],
  };
}

export function createBotSigner(opts: { key: BotKey; agent: string; ttl?: number }): BotSigner {
  const { key } = opts;
  let agent: string;
  try {
    agent = new URL(opts.agent).origin;
  } catch {
    throw new AwError('bad_request', `Signature-Agent must be an https URL, got "${opts.agent}"`);
  }
  const agentHeader = serBare(agent);
  const defTtl = opts.ttl ?? 60;
  const nowSec = () => Math.floor(Date.now() / 1000);
  return {
    keyid: key.keyid,
    agent,
    headers(url, o = {}) {
      const now = o.now ?? nowSec();
      const label = o.label ?? 'sig1';
      const params = sigParams(key.keyid, now, o.ttl ?? defTtl, o.nonce ?? randomBytes(32).toString('base64url'), 'web-bot-auth', [
        { v: '@authority', p: [] },
        { v: 'signature-agent', p: [] },
      ]);
      const values = new Map([
        ['"@authority"', authorityOf(url)],
        ['"signature-agent"', agentHeader],
      ]);
      const sig = sign(null, Buffer.from(signatureBase(params, values)), key.privateKey);
      return {
        'signature-agent': agentHeader,
        'signature-input': `${label}=${serInnerList(params)}`,
        signature: `${label}=${serBare({ bytes: sig })}`,
      };
    },
    directory() {
      return { keys: [{ ...key.jwk }] };
    },
    directoryResponse(authority, o = {}) {
      const now = o.now ?? nowSec();
      const label = o.label ?? 'sig1';
      const params = sigParams(key.keyid, now, o.ttl ?? 300, o.nonce ?? randomBytes(32).toString('base64url'), 'http-message-signatures-directory', [
        { v: '@authority', p: [['req', true]] },
      ]);
      const values = new Map([['"@authority";req', authority.toLowerCase()]]);
      const sig = sign(null, Buffer.from(signatureBase(params, values)), key.privateKey);
      return {
        status: 200,
        headers: {
          'content-type': DIRECTORY_TYPE,
          'cache-control': 'max-age=86400',
          'signature-input': `${label}=${serInnerList(params)}`,
          signature: `${label}=${serBare({ bytes: sig })}`,
        },
        body: JSON.stringify(this.directory()),
      };
    },
  };
}

// ───────────────────────────── verifying ─────────────────────────────

export interface VerifyOptions {
  /** request headers (any case); array values are joined with ", " */
  headers: Record<string, string | string[] | undefined>;
  /** `@authority` of the request as the server saw it */
  authority: string;
  /** trusted public keys (from the agent's key directory) */
  keys: JsonWebKey[];
  /** epoch seconds */
  now?: number;
  /** allowed clock skew in seconds (default 30) */
  skew?: number;
  /** expected tag (default web-bot-auth) */
  tag?: string;
  /** set when verifying a response signature with `;req` components (directory responses) */
  requestAuthority?: string;
}

export type VerifyResult = { ok: true; keyid: string; label: string; agent?: string } | { ok: false; reason: string };

function header(h: VerifyOptions['headers'], name: string): string | undefined {
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(', ') : v;
  return undefined;
}

const param = (p: [string, BareItem][], k: string) => p.find(([x]) => x === k)?.[1];

export function verifyBotSignature(o: VerifyOptions): VerifyResult {
  const tag = o.tag ?? 'web-bot-auth';
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const skew = o.skew ?? 30;
  const si = header(o.headers, 'signature-input');
  const sg = header(o.headers, 'signature');
  if (!si || !sg) return { ok: false, reason: 'no Signature-Input / Signature headers' };
  let inputs: Map<string, Item | InnerList>;
  let sigs: Map<string, Item | InnerList>;
  try {
    inputs = parseDictionary(si);
    sigs = parseDictionary(sg);
  } catch {
    return { ok: false, reason: 'malformed signature headers' };
  }
  let label: string | undefined;
  let params: InnerList | undefined;
  for (const [k, v] of inputs)
    if ('list' in v && param(v.p, 'tag') === tag) {
      label = k;
      params = v;
      break;
    }
  if (!label || !params) return { ok: false, reason: `no signature tagged ${tag}` };
  const sv = sigs.get(label);
  if (!sv || 'list' in sv || typeof sv.v !== 'object' || !('bytes' in sv.v)) return { ok: false, reason: `no signature value for ${label}` };
  const created = param(params.p, 'created');
  const expires = param(params.p, 'expires');
  const keyid = param(params.p, 'keyid');
  const alg = param(params.p, 'alg');
  if (typeof created !== 'number' || typeof expires !== 'number') return { ok: false, reason: 'created and expires are required' };
  if (created > now + skew) return { ok: false, reason: 'signature created in the future' };
  if (expires < now - skew) return { ok: false, reason: 'signature expired' };
  if (expires <= created) return { ok: false, reason: 'expires is not after created' };
  if (typeof keyid !== 'string') return { ok: false, reason: 'keyid is required' };
  if (alg !== undefined && alg !== 'ed25519') return { ok: false, reason: `unsupported alg ${String(alg)}` };

  const values = new Map<string, string>();
  const names = new Set<string>();
  for (const it of params.list) {
    if (typeof it.v !== 'string') return { ok: false, reason: 'component identifiers must be strings' };
    const id = componentId(it);
    const req = it.p.some(([k]) => k === 'req');
    names.add(it.v);
    let val: string | undefined;
    if (it.v === '@authority') val = (req ? o.requestAuthority ?? o.authority : o.authority).toLowerCase();
    else if (it.v.startsWith('@')) return { ok: false, reason: `unsupported component ${it.v}` };
    else val = header(o.headers, it.v.toLowerCase())?.trim();
    if (val === undefined) return { ok: false, reason: `covered component ${it.v} is missing` };
    values.set(id, val);
  }
  if (!names.has('@authority')) return { ok: false, reason: '@authority is not covered' };
  const agentHdr = header(o.headers, 'signature-agent');
  if (tag === 'web-bot-auth' && agentHdr !== undefined && !names.has('signature-agent'))
    return { ok: false, reason: 'signature-agent is present but not covered' };

  const jwk = o.keys.find((k) => {
    try {
      return jwkThumbprint(k) === keyid;
    } catch {
      return false;
    }
  });
  if (!jwk) return { ok: false, reason: `unknown keyid ${keyid}` };
  let pub: KeyObject;
  try {
    pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
  } catch {
    return { ok: false, reason: 'bad public key' };
  }
  const base = signatureBase(params, values);
  const good = verify(null, Buffer.from(base), pub, sv.v.bytes);
  if (!good) return { ok: false, reason: 'signature does not verify' };
  let agent: string | undefined;
  if (agentHdr) {
    try {
      const d = new SfParser(agentHdr.trim()).bare();
      agent = typeof d === 'string' ? d : undefined;
    } catch {
      agent = undefined;
    }
  }
  return { ok: true, keyid, label, agent };
}
