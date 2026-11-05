// Dev tool: compare the token estimator with o200k on real rendered output.
import { readFileSync, readdirSync } from 'node:fs';
import { encode } from 'gpt-tokenizer';
import { parseHtml } from '../src/parse.ts';
import { compile } from '../src/compile.ts';
import { renderLine, type Refs } from '../src/render.ts';
import { estimateTokens } from '../src/tokens.ts';
import type { Act } from '../src/types.ts';

const dir = 'bench/fixtures';
let est = 0, real = 0, under = 0, lines = 0;
const worst: [number, string][] = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.html'))) {
  const page = compile(parseHtml(readFileSync(`${dir}/${f}`, 'utf8')), 'https://example.test/' + f, { tier: 'wire' });
  const map = new Map<string, number>();
  const refs: Refs = { of: (a: Act) => { let n = map.get(a.f); if (!n) { n = map.size + 1; map.set(a.f, n); } return n; } };
  let fe = 0, fr = 0;
  for (const b of page.blocks) {
    const line = renderLine(b, refs);
    const e = estimateTokens(line) + 1, r = encode(line + '\n').length;
    fe += e; fr += r; lines++;
    if (e < r) under++;
    if (r > 30) worst.push([e / r, line.slice(0, 110)]);
  }
  est += fe; real += fr;
  console.log(f.padEnd(22), 'est', String(fe).padStart(6), 'real', String(fr).padStart(6), ((fe / fr - 1) * 100).toFixed(1).padStart(6) + '%');
}
console.log('TOTAL', est, real, ((est / real - 1) * 100).toFixed(1) + '%', 'lines under-estimated:', ((under / lines) * 100).toFixed(1) + '%');
worst.sort((a, b) => a[0] - b[0]);
console.log('most under:'); for (const w of worst.slice(0, 4)) console.log(' ', w[0].toFixed(2), w[1]);
console.log('most over:'); for (const w of worst.slice(-6)) console.log(' ', w[0].toFixed(2), w[1]);
