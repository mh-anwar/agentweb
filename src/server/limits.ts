// Per-tenant admission: a token bucket on run starts and a cap on concurrent runs.

import { ServerError } from './mcp.ts';

export interface LimitOptions {
  /** sustained runs per second per tenant; 0 or undefined = unlimited */
  perSec?: number;
  /** bucket size (burst); default max(1, 2 × perSec) */
  burst?: number;
  /** concurrent runs per tenant; 0 or undefined = unlimited */
  concurrent?: number;
}

interface TenantState {
  tokens: number;
  last: number;
  running: number;
}

export class Limiter {
  #rate: number;
  #burst: number;
  #cap: number;
  #t = new Map<string, TenantState>();
  #now: () => number;

  constructor(o: LimitOptions = {}, now: () => number = () => performance.now()) {
    this.#rate = o.perSec && o.perSec > 0 ? o.perSec : 0;
    this.#burst = this.#rate ? Math.max(1, o.burst ?? Math.ceil(2 * this.#rate)) : 0;
    this.#cap = o.concurrent && o.concurrent > 0 ? Math.floor(o.concurrent) : 0;
    this.#now = now;
  }

  #state(tenant: string): TenantState {
    let s = this.#t.get(tenant);
    if (!s) {
      s = { tokens: this.#burst, last: this.#now(), running: 0 };
      this.#t.set(tenant, s);
    }
    return s;
  }

  /**
   * Admit `n` runs for `tenant` or throw a ServerError(429). On success the caller must call
   * `release(tenant, n)` once the runs settle.
   */
  admit(tenant: string, n = 1): void {
    const s = this.#state(tenant);
    if (this.#cap && s.running + n > this.#cap) {
      throw new ServerError('busy', 429, `too many concurrent runs for this key (limit ${this.#cap})`, 'wait for a running call to finish, then retry', 1);
    }
    if (this.#rate) {
      const now = this.#now();
      s.tokens = Math.min(this.#burst, s.tokens + ((now - s.last) / 1000) * this.#rate);
      s.last = now;
      if (s.tokens < n) {
        const wait = Math.max(1, Math.ceil((n - s.tokens) / this.#rate));
        throw new ServerError('rate_limited', 429, `rate limit exceeded (${this.#rate}/s, burst ${this.#burst})`, `retry in ${wait}s`, wait);
      }
      s.tokens -= n;
    }
    s.running += n;
  }

  release(tenant: string, n = 1): void {
    const s = this.#t.get(tenant);
    if (s) s.running = Math.max(0, s.running - n);
  }

  running(tenant: string): number {
    return this.#t.get(tenant)?.running ?? 0;
  }
}
