// Seeded randomness. Everything the farm generates comes from here, never from Math.random()
// or the clock, so the same seed always produces the same sites and the same correct answers.
import { createHash } from 'node:crypto';

export function hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function hashHex(...parts: (string | number)[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

export class Rng {
  private s: number;
  constructor(seed: number | string) {
    this.s = (typeof seed === 'string' ? hash32(seed) : seed) >>> 0;
  }
  /** A child generator whose stream depends only on (this seed state at creation, label). */
  static for(seed: number, label: string): Rng {
    return new Rng((hash32(label) ^ Math.imul(seed >>> 0, 2654435761)) >>> 0);
  }
  next(): number {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)] as T;
  }
  shuffle<T>(xs: readonly T[]): T[] {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j] as T, a[i] as T];
    }
    return a;
  }
  pickN<T>(xs: readonly T[], n: number): T[] {
    return this.shuffle(xs).slice(0, n);
  }
}

const WORDS = (
  'system service request response client server module package version release feature option setting ' +
  'default value parameter network cluster node worker queue batch stream buffer cache index table record ' +
  'field schema policy token session account project team region zone latency throughput budget quota limit ' +
  'retry timeout backoff window shard replica snapshot backup restore deploy rollout rollback canary metric ' +
  'alert dashboard report export import format encoding checksum signature certificate key secret rotation ' +
  'audit event handler plugin adapter driver gateway router proxy tunnel firewall resolver registry mirror ' +
  'pipeline stage artifact build test lint review merge branch commit tag release changelog migration upgrade'
).split(' ');

const VERBS = 'creates updates removes validates returns accepts rejects forwards stores reads writes schedules cancels retries monitors'.split(' ');
const ADJ = 'default optional required internal external stable experimental deprecated reliable incremental parallel atomic remote local secure'.split(' ');

/** Plain filler prose. Deterministic given the generator. */
export function sentence(r: Rng, minWords = 8, maxWords = 18): string {
  const n = r.int(minWords, maxWords);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const k = i % 4;
    out.push(k === 0 ? r.pick(ADJ) : k === 2 ? r.pick(VERBS) : r.pick(WORDS));
  }
  const s = out.join(' ');
  return s[0]!.toUpperCase() + s.slice(1) + '.';
}

export function paragraph(r: Rng, sentences = 4): string {
  const out: string[] = [];
  for (let i = 0; i < sentences; i++) out.push(sentence(r));
  return out.join(' ');
}

export function title(r: Rng): string {
  const w = [r.pick(ADJ), r.pick(WORDS), r.pick(WORDS)];
  return w.map((x) => x[0]!.toUpperCase() + x.slice(1)).join(' ');
}

export function money(cents: number): string {
  return '$' + (cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export const FIRST = 'Ada Ben Cleo Dev Eli Fay Gus Hana Ivo Jun Kai Lia Max Noor Omar Pia Quin Rae Sol Tess Uma Vik Wren Xan Yara Zed'.split(' ');
export const LAST = 'Alvarez Brandt Chen Dubois Evans Frost Gupta Haas Ito Jansen Khan Lopez Meyer Novak Okafor Park Quinn Rossi Sato Tran Ueda Vogel Wong Xu Young Zhou'.split(' ');
