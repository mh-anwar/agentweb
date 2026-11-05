// Self-validating MCP session ids.
//
// A session id is `<payload>.<mac>` where payload = base64url(format ‖ rid ‖ iat ‖ protocol ‖ tenant)
// and mac = HMAC-SHA256(k, payload) truncated to 128 bits, k derived from the server secret. Any
// worker holding the secret can validate any session id without a session table; the tenant
// inside the token must match the tenant the request authenticated as.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Protocol versions in a fixed order: the index is stored in tokens, so only ever append. */
const VERSION_TABLE = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const FORMAT = 1;
const RID_BYTES = 16;
const MAC_BYTES = 16;
const MAX_TOKEN = 512;
/** tolerated clock skew between workers on different hosts */
const SKEW_SEC = 300;
const SEEN_MAX = 20_000;

export interface SessionClaims {
  /** random id, base64url (22 chars): the middle segment of runtime session ids */
  id: string;
  tenant: string;
  /** issue time, epoch seconds */
  iat: number;
  /** negotiated protocol version, if known */
  version?: string;
}

export function secretBytes(secret: string | Uint8Array): Buffer {
  const b = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
  if (b.length < 16) throw new Error('agentweb: server secret must be at least 16 bytes');
  return b;
}

export class SessionTokens {
  #key: Buffer;
  #ttl: number;
  /** recently verified tokens: skips the HMAC on the hot path (expiry is still checked) */
  #seen = new Map<string, SessionClaims>();

  constructor(secret: string | Uint8Array, ttlSec: number) {
    // Derive a purpose-bound key so the raw secret can be reused for other things safely.
    this.#key = createHmac('sha256', secretBytes(secret)).update('agentweb/mcp-session/v1').digest();
    this.#ttl = ttlSec;
  }

  issue(tenant: string, version?: string, now = Date.now()): { token: string; claims: SessionClaims } {
    const rid = randomBytes(RID_BYTES);
    const t = Buffer.from(tenant, 'utf8');
    const p = Buffer.allocUnsafe(1 + RID_BYTES + 4 + 1 + t.length);
    p[0] = FORMAT;
    rid.copy(p, 1);
    const iat = Math.floor(now / 1000);
    p.writeUInt32BE(iat >>> 0, 1 + RID_BYTES);
    const vi = version ? VERSION_TABLE.indexOf(version) : -1;
    p[1 + RID_BYTES + 4] = vi < 0 ? 255 : vi;
    t.copy(p, 1 + RID_BYTES + 5);
    const payload = p.toString('base64url');
    const token = `${payload}.${this.#mac(payload).toString('base64url')}`;
    return { token, claims: { id: rid.toString('base64url'), tenant, iat, version: vi < 0 ? undefined : version } };
  }

  /** Returns the claims of a valid, unexpired token, else undefined. Never throws. */
  verify(token: string | undefined, now = Date.now()): SessionClaims | undefined {
    if (!token || token.length > MAX_TOKEN) return undefined;
    const hit = this.#seen.get(token);
    if (hit) {
      if (Math.floor(now / 1000) - hit.iat <= this.#ttl) return hit;
      this.#seen.delete(token);
      return undefined;
    }
    const c = this.#verify(token, now);
    if (c) {
      if (this.#seen.size >= SEEN_MAX) this.#seen.clear();
      this.#seen.set(token, c);
    }
    return c;
  }

  #verify(token: string, now: number): SessionClaims | undefined {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot !== token.lastIndexOf('.')) return undefined;
    const payload = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1), 'base64url');
    if (mac.length !== MAC_BYTES) return undefined;
    if (!timingSafeEqual(mac, this.#mac(payload))) return undefined;
    const p = Buffer.from(payload, 'base64url');
    if (p.length < 1 + RID_BYTES + 5 || p[0] !== FORMAT) return undefined;
    const iat = p.readUInt32BE(1 + RID_BYTES);
    const nowSec = Math.floor(now / 1000);
    if (iat > nowSec + SKEW_SEC || nowSec - iat > this.#ttl) return undefined;
    const vi = p[1 + RID_BYTES + 4];
    return {
      id: p.subarray(1, 1 + RID_BYTES).toString('base64url'),
      tenant: p.subarray(1 + RID_BYTES + 5).toString('utf8'),
      iat,
      version: VERSION_TABLE[vi],
    };
  }

  /** seconds until a token issued at `iat` expires */
  remaining(iat: number, now = Date.now()): number {
    return Math.max(0, iat + this.#ttl - Math.floor(now / 1000));
  }

  #mac(payload: string): Buffer {
    return createHmac('sha256', this.#key).update(payload).digest().subarray(0, MAC_BYTES);
  }
}
