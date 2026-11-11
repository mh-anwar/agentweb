// Correct only the inspected five-cheapest grader, without rerunning agents or overwriting raw
// evidence. Server-state-based verdicts for every other task remain exactly as recorded.
// node bench/regrade-five.ts <run-directory> <output-jsonl>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { taskById } from './sites/tasks.ts';
import { makeTruth } from './sites/truth.ts';
import { blankState } from './sites/core.ts';

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error('usage: node bench/regrade-five.ts <run-directory> <output-jsonl>');
if (existsSync(out)) throw new Error('output already exists; preserve evidence and choose another path');
const raw = readFileSync(join(dir, 'results.jsonl'), 'utf8');
const hash = createHash('sha256').update(raw).digest('hex');
const truth = makeTruth(7); // the original farm and these runs use seed 7
const task = taskById('shop-five-cheapest-rated');
const rows = raw.trim().split('\n').map(l => JSON.parse(l));
let changed = 0;
for (const row of rows) {
  if (row.task !== task.id) continue;
  const stem = `${row.task}--${row.tool}${row.repeat ? `--r${row.repeat}` : ''}`;
  const events = readFileSync(join(dir, 'transcripts', stem + '.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const result = events.findLast(e => e.type === 'result');
  if (typeof result?.result !== 'string') throw new Error(`no full final answer for ${stem}`);
  const verdict = task.check(result.result, blankState(), truth);
  if (verdict.pass !== row.pass) changed++;
  row.originalPass = row.pass;
  row.originalWhy = row.why;
  row.pass = verdict.pass;
  row.why = verdict.why;
  row.regradedBy = 'five-cheapest-list-v2';
}
writeFileSync(out, rows.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
writeFileSync(out + '.provenance.json', JSON.stringify({ originalResultsSha256: hash, originalDirectory: dir, seed: 7, regradedTask: task.id, graderSha256: createHash('sha256').update(readFileSync(new URL('./sites/tasks.ts', import.meta.url))).digest('hex'), changedVerdicts: changed, at: new Date().toISOString() }, null, 2) + '\n', { flag: 'wx' });
console.log(`${rows.length} preserved rows; ${changed} verdicts changed; ${out}`);
