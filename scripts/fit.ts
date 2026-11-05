// Dev tool: grid-search estimator constants against o200k on rendered fixture lines.
import { readFileSync, readdirSync } from 'node:fs';
import { encode } from 'gpt-tokenizer';
import { parseHtml } from '../src/parse.ts';
import { compile } from '../src/compile.ts';
import { renderLine, type Refs } from '../src/render.ts';
import type { Act } from '../src/types.ts';

const samples: { line: string; real: number; file: string }[] = [];
for (const f of readdirSync('bench/fixtures').filter((f) => f.endsWith('.html'))) {
  const page = compile(parseHtml(readFileSync(`bench/fixtures/${f}`, 'utf8')), 'https://example.test/' + f, { tier: 'wire' });
  const map = new Map<string, number>();
  const refs: Refs = { of: (a: Act) => { let n = map.get(a.f); if (!n) { n = map.size + 1; map.set(a.f, n); } return n; } };
  for (const b of page.blocks) { const line = renderLine(b, refs); samples.push({ line, real: encode(line + '\n').length, file: f }); }
}
function est(s: string, A: number, B: number, C: number, P: number, U: number): number {
  let t = 0, i = 0; const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) { i++; continue; }
    if (c === 10 || c === 13) { t += 1; i++; while (i < n && (s.charCodeAt(i) === 10 || s.charCodeAt(i) === 13 || s.charCodeAt(i) === 32)) i++; continue; }
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) {
      let j = i + 1, upper = c <= 90 ? 1 : 0;
      while (j < n) { const d = s.charCodeAt(j); if (d >= 97 && d <= 122) j++; else if (d >= 65 && d <= 90) { upper++; j++; } else break; }
      const len = j - i;
      if (upper <= 1) t += len <= A ? 1 : 1 + (len - A) / B; else t += Math.max(1, len / C);
      i = j; continue;
    }
    if (c >= 48 && c <= 57) { let j = i + 1; while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++; t += Math.ceil((j - i) / 3); i = j; continue; }
    if (c < 128) { let j = i + 1; while (j < n && s.charCodeAt(j) === c) j++; t += j - i > 2 ? 1.5 : (j - i) * P; i = j; continue; }
    if (c >= 0x00c0 && c <= 0x024f) { t += 0.7; i++; continue; }
    t += U; i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return t;
}
let best: any = null;
for (const A of [6, 7, 8, 9, 10, 12]) for (const B of [3, 4, 5, 6, 8, 12]) for (const C of [2.5, 3, 3.5, 4]) for (const P of [0.6, 0.7, 0.8, 0.9, 1]) for (const U of [0.8, 1, 1.3]) {
  let se = 0, sr = 0, sq = 0; const perFile = new Map<string, [number, number]>();
  for (const s of samples) { const e = est(s.line, A, B, C, P, U) + 1; se += e; sr += s.real; sq += (e - s.real) ** 2 / (s.real + 5); const pf = perFile.get(s.file) ?? [0, 0]; pf[0] += e; pf[1] += s.real; perFile.set(s.file, pf); }
  let worstUnder = 0, worstOver = 0;
  for (const [, [e, r]] of perFile) { if (r < 200) continue; worstUnder = Math.min(worstUnder, e / r - 1); worstOver = Math.max(worstOver, e / r - 1); }
  const score = sq / samples.length + 40 * Math.max(0, -0.04 - worstUnder) ** 2 * 100 + Math.abs(se / sr - 1.04) * 3;
  if (!best || score < best.score) best = { A, B, C, P, U, score, total: se / sr - 1, worstUnder, worstOver, rmse: sq / samples.length };
}
console.log(best);
