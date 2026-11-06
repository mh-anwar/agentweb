// Secret handles. The agent never sees a secret value: it writes `{{secret:name}}` and the guard
// substitutes the value at the last moment, only for a destination origin the secret is bound to.
// Anything going back to the model is passed through `redact`, which replaces the value (and its
// common encodings) with the handle again, for pages that echo what was typed.
//
// LIMITS OF REDACTION. `redact` is a backstop, not the protection; the protection is that the value
// is never put in model context in the first place. Redaction is exact string matching, so it
// cannot catch a value that a page transforms in any way it does not know about: split across
// elements or lines, masked or partially shown ("••••1234"), reversed, case-changed, hashed,
// encrypted, encoded as base32/punycode/HTML numeric entities per character, or compressed. It
// matches base64 at all three byte alignments but only when at least 8 characters of the encoding
// depend on the secret alone. Values shorter than MIN_REDACT (4) characters are never redacted
// because doing so would destroy ordinary text; such secrets should not be used. A model that saw
// a value through some other channel can always paraphrase it.

import { readFileSync } from 'node:fs';
import { AwError } from '../types.ts';

export interface SecretDef {
  /** handle name, matched case-insensitively: `{{secret:github_token}}` */
  name: string;
  value: string;
  /**
   * origins the value may be sent to: `https://github.com`, `https://*.github.com` (subdomains
   * only), `http://localhost:3000`. A bare host means https. Empty = never revealed.
   */
  origins: string[];
}

const MIN_REDACT = 4;
const HANDLE_RE = /\{\{\s*secret\s*:\s*([A-Za-z0-9_.\-]+)\s*\}\}/g;
const NAME_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

export const handle = (name: string) => `{{secret:${name}}}`;

// ───────────────────────────── origins ─────────────────────────────

interface OriginPat {
  scheme: string;
  host: string;
  /** '*.example.com' style: match subdomains of `host` */
  sub: boolean;
  port: string;
}

const DEFAULT_PORT: Record<string, string> = { http: '80', https: '443' };

export function parseOriginPattern(p: string): OriginPat | null {
  const m = /^(?:([a-z][a-z0-9+.\-]*):\/\/)?(\*\.)?(\[[0-9a-f:.]+\]|[^/:?#[\]]+)(?::(\d+))?\/?$/i.exec(p.trim());
  if (!m) return null;
  const scheme = (m[1] ?? 'https').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  let host = m[3].toLowerCase();
  try {
    host = new URL(`${scheme}://${host}`).hostname; // IDN → punycode, IPv6 forms
  } catch {
    return null;
  }
  return { scheme, host, sub: !!m[2], port: m[4] ?? DEFAULT_PORT[scheme] };
}

/** Normalise an origin or URL to `scheme://host[:port]`, or null. */
export function toOrigin(s: string): string | null {
  try {
    const o = new URL(s).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

export function originMatches(pats: OriginPat[], origin: string): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  const scheme = u.protocol.slice(0, -1);
  const host = u.hostname.toLowerCase();
  const port = u.port || DEFAULT_PORT[scheme] || '';
  for (const p of pats) {
    if (p.scheme !== scheme || p.port !== port) continue;
    if (p.sub ? host.endsWith('.' + p.host) : host === p.host) return true;
  }
  return false;
}

// ───────────────────────────── encodings ─────────────────────────────

const b64 = (b: Buffer) => b.toString('base64');
const b64url = (b: Buffer) => b.toString('base64url');
const unpad = (s: string) => s.replace(/=+$/, '');

/**
 * Base64 text that depends only on the secret's bytes, at byte offsets 0, 1 and 2 within a larger
 * encoded blob (e.g. `Authorization: Basic base64(user:password)`).
 */
function base64Cores(v: Buffer): string[] {
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const buf = Buffer.concat([Buffer.alloc(k), v]);
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + v.length)) / 6);
    for (const enc of [b64(buf), b64url(buf)]) {
      const core = enc.slice(start, end);
      if (core.length >= 8) out.push(core);
    }
  }
  return out;
}

function htmlEscape(s: string): string[] {
  const a = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return [a, a.replace(/'/g, '&#39;'), a.replace(/'/g, '&#x27;')];
}

/** Every form of `value` that `redact` removes. */
export function encodedForms(value: string): string[] {
  const forms = new Set<string>();
  const add = (s: string) => {
    if (s.length >= MIN_REDACT) forms.add(s);
  };
  add(value);
  const bytes = Buffer.from(value, 'utf8');
  const uri = encodeURIComponent(value);
  add(uri);
  add(uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()));
  add(uri.replace(/%20/g, '+'));
  // application/x-www-form-urlencoded also escapes !'()*
  add(uri.replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+'));
  add(encodeURI(value));
  add(JSON.stringify(value).slice(1, -1));
  for (const h of htmlEscape(value)) add(h);
  for (const e of [b64(bytes), b64url(bytes)]) {
    add(e);
    add(unpad(e));
  }
  for (const c of base64Cores(bytes)) add(c);
  const hex = bytes.toString('hex');
  if (hex.length >= 8) {
    add(hex);
    add(hex.toUpperCase());
  }
  return [...forms];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ───────────────────────────── the store ─────────────────────────────

export class SecretStore {
  private byName = new Map<string, { def: SecretDef; pats: OriginPat[] }>();
  private re: RegExp | null = null;
  private formToName = new Map<string, string>();

  constructor(defs: SecretDef[] = []) {
    for (const d of defs) {
      const name = d.name.toLowerCase();
      if (!NAME_RE.test(name)) throw new AwError('bad_request', `invalid secret name "${d.name}" (letters, digits, _ . - only)`);
      if (typeof d.value !== 'string' || !d.value) throw new AwError('bad_request', `secret "${name}" has no value`);
      const pats: OriginPat[] = [];
      for (const o of d.origins ?? []) {
        const p = parseOriginPattern(o);
        if (!p) throw new AwError('bad_request', `secret "${name}": invalid origin "${o}"`);
        pats.push(p);
      }
      this.byName.set(name, { def: { name, value: d.value, origins: d.origins ?? [] }, pats });
    }
    // longest form first so a longer encoding is never half-replaced by a shorter one
    const all: [string, string][] = [];
    for (const { def } of this.byName.values()) for (const f of encodedForms(def.value)) all.push([f, def.name]);
    all.sort((a, b) => b[0].length - a[0].length);
    for (const [f, n] of all) if (!this.formToName.has(f)) this.formToName.set(f, n);
    if (all.length) this.re = new RegExp([...this.formToName.keys()].map(escapeRe).join('|'), 'g');
  }

  get size(): number {
    return this.byName.size;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /** Bound origins of a secret (not secret themselves). */
  origins(name: string): string[] {
    return this.byName.get(name.toLowerCase())?.def.origins ?? [];
  }

  static hasHandles(text: string): boolean {
    HANDLE_RE.lastIndex = 0;
    return HANDLE_RE.test(text);
  }

  /**
   * Substitute every `{{secret:name}}` in `text` for `origin` (an origin or URL). Throws
   * AwError('policy') naming the secret and origin, never the value, if any handle is unknown or
   * not bound to that origin. All-or-nothing: either every handle is replaced or none.
   */
  reveal(text: string, origin: string): string {
    if (!text.includes('{{')) return text;
    const dest = toOrigin(origin);
    return text.replace(HANDLE_RE, (_m, raw: string) => {
      const name = raw.toLowerCase();
      const s = this.byName.get(name);
      if (!s) {
        const known = this.names();
        throw new AwError(
          'policy',
          `unknown secret "${name}"`,
          known.length ? `known secrets: ${known.join(', ')}; if the user gave you the value, type it directly` : 'no secrets are configured (AGENTWEB_SECRET_<NAME> or a secrets file); if the user gave you the value, type it directly',
        );
      }
      if (!dest) throw new AwError('policy', `secret "${name}" cannot be sent to "${origin}" (not an http(s) origin)`);
      if (!s.pats.length) throw new AwError('policy', `secret "${name}" is not bound to any origin, so it is never sent`);
      if (!originMatches(s.pats, dest))
        throw new AwError('policy', `secret "${name}" is not allowed on ${dest}`, `it is bound to ${s.def.origins.join(', ')}`);
      return s.def.value;
    });
  }

  /** Replace secret values and their encodings with handles. See LIMITS OF REDACTION above. */
  redact(text: string): string {
    if (!this.re || !text) return text;
    return text.replace(this.re, (m) => handle(this.formToName.get(m) ?? 'unknown'));
  }
}

// ───────────────────────────── sources ─────────────────────────────

/**
 * `AGENTWEB_SECRET_<NAME>=value` and `AGENTWEB_SECRET_<NAME>_ORIGINS=https://a.com,https://*.b.com`.
 * `<NAME>` becomes the lower-case handle name.
 */
export function secretsFromEnv(env: Record<string, string | undefined>): SecretDef[] {
  const P = 'AGENTWEB_SECRET_';
  const vals = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) if (k.startsWith(P) && v !== undefined) vals.set(k.slice(P.length), v);
  const out: SecretDef[] = [];
  for (const [k, v] of vals) {
    if (k.endsWith('_ORIGINS') && vals.has(k.slice(0, -'_ORIGINS'.length))) continue;
    if (!k) continue;
    out.push({ name: k.toLowerCase(), value: v, origins: splitList(vals.get(k + '_ORIGINS') ?? '') });
  }
  return out;
}

export function splitList(s: string): string[] {
  return s.split(/[\s,]+/).filter(Boolean);
}

/**
 * Secrets JSON: either `{ "name": { "value": "...", "origins": ["https://..."] } }` or
 * `[{ "name": "...", "value": "...", "origins": [...] }]`. A plain string value has no origins.
 */
export function parseSecrets(json: unknown, where = 'secrets'): SecretDef[] {
  const bad = (m: string) => new AwError('bad_request', `${where}: ${m}`);
  const one = (name: string, x: unknown): SecretDef => {
    if (typeof x === 'string') return { name, value: x, origins: [] };
    if (!x || typeof x !== 'object') throw bad(`secret "${name}" must be an object`);
    const o = x as Record<string, unknown>;
    if (typeof o.value !== 'string') throw bad(`secret "${name}" needs a string "value"`);
    const origins = typeof o.origins === 'string' ? splitList(o.origins) : o.origins ?? [];
    if (!Array.isArray(origins) || origins.some((s) => typeof s !== 'string')) throw bad(`secret "${name}": "origins" must be a list of strings`);
    return { name, value: o.value, origins: origins as string[] };
  };
  if (Array.isArray(json))
    return json.map((x, i) => {
      const n = (x as { name?: unknown })?.name;
      if (typeof n !== 'string') throw bad(`entry ${i} needs a "name"`);
      return one(n, x);
    });
  if (json && typeof json === 'object') return Object.entries(json).map(([n, x]) => one(n, x));
  throw bad('expected an object or a list');
}

export function secretsFromFile(path: string): SecretDef[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new AwError('bad_request', `cannot read secrets file ${path}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // never echo the parser message: it can quote file content, i.e. a secret
    throw new AwError('bad_request', `secrets file ${path} is not valid JSON`);
  }
  return parseSecrets(json, path);
}
