// Measurements the brief asks for, reported as test diagnostics (node --test prints them).
// Assertions are loose ceilings so the file catches regressions without being flaky.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGuard, defaultPolicy } from '../src/guard/index.ts';

// Deterministic pseudo-text with a realistic vocabulary spread (Zipf-ish) plus ids and numbers.
function rng(seed: number) {
  return () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
    return ((seed ^ (seed >>> 13)) >>> 0) / 2 ** 32;
  };
}
const VOCAB = (() => {
  const r = rng(7);
  const out: string[] = [];
  const syl = ['ka', 'lo', 'mi', 'ten', 'ra', 'su', 'vin', 'de', 'po', 'gor', 'el', 'an', 'is', 'tu', 'ber', 'nal'];
  for (let i = 0; i < 6000; i++) {
    let w = '';
    const n = 1 + Math.floor(r() * 3);
    for (let j = 0; j < n; j++) w += syl[Math.floor(r() * syl.length)];
    out.push(w);
  }
  return out;
})();
function text(chars: number, seed: number): string {
  const r = rng(seed);
  let s = '';
  while (s.length < chars) {
    const z = Math.floor(VOCAB.length * r() ** 3); // skewed towards common words
    s += VOCAB[z] + (r() < 0.08 ? '. ' : ' ');
    if (r() < 0.004) s += `ref ${Math.floor(r() * 1e10)} `;
    if (r() < 0.002) s += `key${Math.floor(r() * 1e6)}x${Math.floor(r() * 1e6)}abc `;
  }
  return s.slice(0, chars);
}

function time(fn: () => void, reps: number): number {
  for (let i = 0; i < Math.min(50, reps); i++) fn(); // warm up
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < reps; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e3 / reps; // µs
}

describe('flow measurements (200 KB observed, authenticated)', () => {
  const g = createGuard({ ...defaultPolicy('local'), flow: 'block' });
  const pages = 20;
  const observed: string[] = [];
  for (let i = 0; i < pages; i++) {
    const t = text(10_000, 100 + i);
    observed.push(t);
    g.observe(`https://site${i % 4}.example`, t, true);
  }

  it('state size', (t) => {
    const json = JSON.stringify(g.state());
    t.diagnostic(`serialised state after 200 KB observed: ${json.length} bytes JSON`);
    assert.ok(json.length < 12_000);
  });

  it('checkOutflow latency', (t) => {
    const short = text(100, 999);
    const long = text(10_000, 998);
    const us100 = time(() => g.checkOutflow(short, 'https://dest.example'), 2000);
    const us10k = time(() => g.checkOutflow(long, 'https://dest.example'), 200);
    t.diagnostic(`checkOutflow 100 chars: ${us100.toFixed(1)} µs; 10,000 chars: ${us10k.toFixed(1)} µs`);
    const obsUs = time(() => createGuard(defaultPolicy('local')).observe('https://a.example', observed[0], true), 20);
    t.diagnostic(`observe 10 KB page: ${(obsUs / 1000).toFixed(2)} ms`);
    assert.ok(us10k < 50_000);
  });

  it('detection rate vs copy length at saturation, and false positives on unrelated text', (t) => {
    const r = rng(42);
    for (const words of [8, 16, 32, 64, 128]) {
      let hit = 0;
      let strong = 0;
      const trials = 200;
      for (let i = 0; i < trials; i++) {
        const src = observed[Math.floor(r() * pages)].split(' ');
        const at = Math.floor(r() * (src.length - words - 1));
        const copy = src.slice(at, at + words).join(' ');
        const v = g.checkOutflow(copy, 'https://dest.example');
        if (!v.ok) strong++;
        if (!v.ok || v.warn) hit++;
      }
      t.diagnostic(`copy of ${words} words: refused ${((100 * strong) / trials).toFixed(0)}%, refused or warned ${((100 * hit) / trials).toFixed(0)}%`);
    }
    let fpBlock = 0;
    let fpWarn = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const v = g.checkOutflow(text(400, 5000 + i), 'https://dest.example');
      if (!v.ok) fpBlock++;
      else if (v.warn) fpWarn++;
    }
    t.diagnostic(`unrelated 400-char texts (same vocabulary): refused ${fpBlock}/${n}, warned ${fpWarn}/${n}`);
    assert.ok(fpBlock <= n * 0.02);
  });
});
