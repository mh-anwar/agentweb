// Dev tool: compile a saved HTML file and print the view. node scripts/peek.ts <file> <url> [budget] [find query]
import { readFileSync } from 'node:fs';
import { encode } from 'gpt-tokenizer';
import { parseHtml } from '../src/parse.ts';
import { compile } from '../src/compile.ts';
import { renderView, renderFind, type Refs, type ViewState } from '../src/render.ts';
import { estimateTokens } from '../src/tokens.ts';
import type { Act } from '../src/types.ts';

const [file, url, budgetArg, query] = process.argv.slice(2);
const html = readFileSync(file, 'utf8');
const t0 = performance.now();
const doc = parseHtml(html);
const t1 = performance.now();
const page = compile(doc, url, { tier: 'wire', bytes: html.length });
const t2 = performance.now();
const map = new Map<string, number>();
const refs: Refs = { of: (a: Act) => { let n = map.get(a.f); if (!n) { n = map.size + 1; map.set(a.f, n); } return n; } };
const st: ViewState = { seq: 1, seen: {} };
const r = query ? renderFind(page, st, refs, query, Number(budgetArg) || 2000) : renderView(page, st, refs, { budget: Number(budgetArg) || 2000 });
const t3 = performance.now();
console.log(r.text);
const real = encode(r.text).length;
console.error(`\n--- html ${html.length}B (${encode(html.slice(0, 400000)).length}${html.length > 400000 ? '+' : ''} tok) | blocks ${page.blocks.length} forms ${page.forms.length} acts ${page.stats.acts} words ${page.stats.words} shell ${page.shell} | view est ${r.tokens} real(o200k) ${real} err ${(((estimateTokens(r.text) - real) / real) * 100).toFixed(1)}% | parse ${(t1 - t0).toFixed(1)}ms compile ${(t2 - t1).toFixed(1)}ms render ${(t3 - t2).toFixed(1)}ms`);
