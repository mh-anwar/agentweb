// Summarize matched task/repeat cells only. Never silently compare different denominators.
// node bench/summarize.ts <results.jsonl> <output-directory>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const [input, out] = process.argv.slice(2);
if (!input || !out) throw new Error('usage: node bench/summarize.ts <results.jsonl> <output-directory>');
const raw = readFileSync(input, 'utf8');
const rows = raw.trim().split('\n').map(l => JSON.parse(l));
const tools: string[] = [...new Set<string>(rows.map(r => r.tool))];
const cell = (r: any) => `${r.task}/${r.repeat ?? 1}`;
const cells = new Map<string, Set<string>>();
const unique = new Set<string>();
for (const row of rows) {
  const key = `${row.tool}/${cell(row)}`;
  if (unique.has(key)) throw new Error(`duplicate row: ${key}`);
  unique.add(key);
  if (!cells.has(cell(row))) cells.set(cell(row), new Set());
  cells.get(cell(row))!.add(row.tool);
}
const matched = new Set([...cells].filter(([, ts]) => ts.size === tools.length).map(([c]) => c));
const paired = rows.filter(r => matched.has(cell(r)));
const sum = (rs: any[], k: string) => rs.reduce((n, r) => n + (r[k] ?? 0), 0);
const median = (xs: number[]) => {
  const sorted = [...xs].sort((a,b) => a-b), mid = Math.floor(xs.length / 2);
  return sorted.length ? (sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) : 0;
};
const summary = tools.map(tool => {
  const rs = paired.filter(r => r.tool === tool);
  return { tool, n: rs.length, passed: rs.filter(r => r.pass).length,
    rawPassed: rs.filter(r => r.originalPass ?? r.pass).length,
    inputTokens: sum(rs, 'totalInputTokens'), outputTokens: sum(rs, 'outputTokens'),
    medianCalls: median(rs.map(r => r.toolCalls)), medianWallMs: median(rs.map(r => r.durationMs)),
    costUsd: sum(rs, 'costUsd'), permissionDenials: rs.every(r => typeof r.permissionDenials === 'number') ? sum(rs, 'permissionDenials') : null,
    errors: rs.filter(r => r.error).length };
});
const note = `${matched.size} matched task/repeat cells per tool; ${rows.length - paired.length} unmatched rows excluded. Development tasks, not held-out evidence. Raw failures, including infrastructure errors and permission denials, remain in the denominator.`;
const lines = ['# Matched benchmark results', '', note, '',
  '| Tool | Pass (adjusted / raw) | Total input tokens | Median calls | Median wall | Cost | Permission denials |',
  '|:--|--:|--:|--:|--:|--:|--:|',
  ...summary.map(r => `| ${r.tool} | ${r.passed}/${r.n} / ${r.rawPassed}/${r.n} | ${r.inputTokens.toLocaleString('en')} | ${r.medianCalls} | ${(r.medianWallMs/1000).toFixed(1)}s | $${r.costUsd.toFixed(3)} | ${r.permissionDenials ?? 'not recorded'} |`),
  '', '## Failed cells after grading correction', '',
  ...paired.filter(r => !r.pass).map(r => `- ${r.tool}, ${r.task}, repeat ${r.repeat ?? 1}: ${r.why}${r.error ? ` (${r.error})` : ''}`),
  '', 'Input tokens include cached input reread across model turns; they are not billed uncached tokens. Costs are harness estimates at list prices.',
  '', `Source results SHA-256: ${createHash('sha256').update(raw).digest('hex')}`, ''];
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const maxTokens = Math.max(1,...summary.map(r => r.inputTokens));
const colors = ['var(--chart-1)','var(--chart-2)','var(--chart-3)'];
const bars = (kind: 'tokens'|'pass') => summary.map((r,i) => {
  const width = kind === 'tokens' ? r.inputTokens/maxTokens*100 : r.passed/Math.max(1,r.n)*100;
  const value = kind === 'tokens' ? `${(r.inputTokens/1e6).toFixed(2)}M` : `${r.passed}/${r.n}`;
  return `<div class="row"><div class="label">${esc(r.tool)}<strong>${value}</strong></div><div class="track"><div class="bar" style="width:${width}%;background:${colors[i%colors.length]}"></div></div></div>`;
}).join('');
const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{font-family:var(--font-sans);color:var(--foreground);margin:0}h2{font-size:16px;margin:0 0 16px}.section{padding:16px;background:var(--card);border-radius:var(--radius);margin-bottom:12px}.row{margin:12px 0}.label{display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px}.track{height:18px;border-radius:4px;background:var(--secondary);overflow:hidden}.bar{height:18px;min-width:2px}.note{font-size:12px;color:var(--muted-foreground);line-height:1.5}strong{font-family:var(--font-mono)}
</style><div class="section"><h2>Total model input · lower is better</h2>${bars('tokens')}</div><div class="section"><h2>Tasks passed · corrected grader</h2>${bars('pass')}</div><p class="note">${esc(note)} One five-product-list grader was corrected equally for every tool; original scores remain in the accompanying report.</p>`;
mkdirSync(out,{recursive:true});
writeFileSync(join(out,'summary.md'),lines.join('\n'));
writeFileSync(join(out,'summary.json'),JSON.stringify({note,input,summary},null,2)+'\n');
writeFileSync(join(out,'comparison.html'),html);
console.log(lines.join('\n'));
