// Public-benchmark runner: a frozen WebVoyager sample on the live web, every tool, one agent model.
//
//   node bench/public/run.ts --tools agentweb,playwright-mcp [--split dev|sealed|all] [--limit N]
//        [--sites Allrecipes,ArXiv] [--model haiku] [--turns 25] [--repeats 1] [--timeout 300] [--out dir]
//        [--rejudge] [--summary-only]
//
// Order is task-major: for each task, every tool runs back to back (tool order rotated per task), so
// live-site drift hits all tools alike. Tasks are interleaved across sites so --limit N covers many
// sites. Sequential on purpose: one browser at a time. Wrap in `box heavy --`.
//
// Results append to <out>/results.jsonl; finished (tool, task, repeat) triples are skipped on resume.
// The judge (bench/public/judge.ts) runs right after each run and its verdict is saved in the row.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { VERSIONS, CHROME, BROWSER_USE } from '../baselines/tools.ts';
import { runAgentTask, type ToolId } from '../baselines/run-agent.ts';
import { loadSample, SAMPLE_PATH, type PublicTask } from './sample.ts';
import { judge, JUDGE_MODEL } from './judge.ts';
import { summarize, type Row } from './summary.ts';

const { values } = parseArgs({
  options: {
    tools: { type: 'string', default: 'agentweb,playwright-mcp' },
    split: { type: 'string', default: 'dev' },
    limit: { type: 'string' },
    sites: { type: 'string' },
    model: { type: 'string', default: 'haiku' },
    turns: { type: 'string', default: '25' },
    repeats: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '300' },
    out: { type: 'string', default: join(import.meta.dirname, '..', 'out', 'public') },
    rejudge: { type: 'boolean', default: false },
    'summary-only': { type: 'boolean', default: false },
  },
});

if (!['dev', 'sealed', 'all'].includes(values.split!)) throw new Error('--split must be dev, sealed or all');
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be an integer from 1 to 20');
const turns = Number(values.turns);
const timeoutMs = Number(values.timeout) * 1000;
const outDir = values.out!;
const tools = values.tools!.split(',').map((s) => s.trim()).filter(Boolean) as ToolId[];
mkdirSync(join(outDir, 'transcripts'), { recursive: true });
const resultsPath = join(outDir, 'results.jsonl');
const today = new Date().toISOString().slice(0, 10);

const sample = loadSample();
const sampleSha = createHash('sha256').update(readFileSync(SAMPLE_PATH)).digest('hex');

function readRows(): Map<string, Row> {
  const m = new Map<string, Row>();
  if (!existsSync(resultsPath)) return m;
  for (const l of readFileSync(resultsPath, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as Row;
    m.set(`${r.tool}/${r.task}/${r.repeat}`, r);
  }
  return m;
}
const done = readRows();
const keyOf = (tool: string, task: string, repeat: number) => `${tool}/${task}/${repeat}`;

// ── task selection: filter, then interleave across sites so --limit spreads out ──
let pick: PublicTask[] = sample.tasks.filter((t) => values.split === 'all' || t.split === values.split);
if (values.sites) {
  const want = values.sites.split(',').map((s) => s.trim().toLowerCase());
  pick = pick.filter((t) => want.includes(t.site.toLowerCase()));
}
{
  const bySite = new Map<string, PublicTask[]>();
  for (const t of pick) bySite.set(t.site, [...(bySite.get(t.site) ?? []), t]);
  const lists = [...bySite.values()];
  pick = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) pick.push(l[i]!);
}
if (values.limit) pick = pick.slice(0, Number(values.limit));
if (!pick.length) throw new Error('no tasks matched');

// ── manifest: fixed config is compared on resume; per-invocation provenance is appended ──
const manifestPath = join(outDir, 'manifest.json');
const git = (...a: string[]) => execFileSync('git', a, { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
const fixed = { sampleSha256: sampleSha, model: values.model, turns, timeoutSec: Number(values.timeout), judgeModel: JUDGE_MODEL };
const invocation = {
  at: new Date().toISOString(), gitHead: git('rev-parse', 'HEAD'),
  diffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD', '--', '.', ':!bench/out'], { cwd: import.meta.dirname })).digest('hex'),
  node: process.version, versions: { ...VERSIONS, ...(tools.includes('browser-use') ? { 'browser-use': BROWSER_USE.version } : {}) }, browser: execFileSync(CHROME, ['--version'], { encoding: 'utf8' }).trim(),
  tools, split: values.split, sites: values.sites, limit: values.limit, repeats, tasks: pick.map((t) => t.id), today,
};
if (existsSync(manifestPath)) {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (JSON.stringify(m.fixed) !== JSON.stringify(fixed)) throw new Error('sample, model, turns, timeout or judge changed; choose a new --out directory');
  m.invocations.push(invocation);
  writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');
} else {
  if (done.size) throw new Error('existing results have no manifest; choose a new --out directory');
  writeFileSync(manifestPath, JSON.stringify({ fixed, invocations: [invocation] }, null, 2) + '\n');
}

// ── helpers ──
function extractAnswer(text: string): { answer: string; hasLine: boolean } {
  const ms = [...text.matchAll(/^\s*\**ANSWER:\**\s*([\s\S]*)$/gm)];
  const last = ms[ms.length - 1];
  return last ? { answer: last[1]!.trim(), hasLine: true } : { answer: text.trim(), hasLine: false };
}

/** Text of the last tool result(s) in a claude stream-json transcript, for the judge. */
function lastToolText(path: string, maxChars = 12_000): string {
  let texts: string[] = [];
  try {
    for (const l of readFileSync(path, 'utf8').split('\n')) {
      if (!l.includes('"tool_result"')) continue;
      const d = JSON.parse(l);
      if (d.type !== 'user' || !Array.isArray(d.message?.content)) continue;
      for (const b of d.message.content) {
        if (b.type !== 'tool_result') continue;
        const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : Array.isArray(b.content) ? b.content : [];
        const t = parts.filter((p: any) => p.type === 'text' && typeof p.text === 'string').map((p: any) => p.text).join('\n');
        if (t.trim()) texts.push(t);
      }
    }
  } catch {}
  if (!texts.length) return '';
  // Newest result in full, plus up to two earlier ones while they fit: many tools answer an action
  // (click, type) with a one-line status and show the page only in an earlier snapshot.
  let out = texts[texts.length - 1]!;
  for (let k = texts.length - 2; k >= Math.max(0, texts.length - 3) && out.length < maxChars; k--) out = texts[k]!.slice(0, maxChars - out.length) + '\n---\n' + out;
  return out.length > maxChars ? out.slice(-maxChars) : out;
}

function prompt(t: PublicTask): string {
  return `${t.ques}\n\nStart URL: ${t.web}\nToday's date: ${today}\nThis browser connects from Canada, so a site may show a regional store, currency or units; treat those as acceptable and complete the task as closely as you can.\n\nWhen done, give your final answer on a line starting with ANSWER:`;
}

async function judgeRow(r: Row): Promise<void> {
  if (!r.answer.trim()) {
    r.judge = { verdict: 'FAIL', reason: `no answer produced${r.error ? ` (${r.error.slice(0, 80)})` : ''}`, model: 'none', costUsd: 0 };
    return;
  }
  r.judge = await judge({ ques: r.ques, site: r.site, web: r.web, ref: r.ref, refType: r.refType, answer: r.answer, lastPage: r.lastPage, today: r.date });
}

function writeSummary(): string {
  const rows = [...readRows().values()].filter((r) => tools.includes(r.tool as ToolId) && pick.some((t) => t.id === r.task));
  const md = summarize(rows, tools, { model: values.model!, split: values.split!, repeats });
  writeFileSync(join(outDir, 'summary.md'), md);
  return md;
}

// ── modes ──
if (values['summary-only']) {
  console.log(writeSummary());
  process.exit(0);
}

if (values.rejudge) {
  const all = [...readRows().values()];
  console.error(`rejudging ${all.length} saved rows`);
  for (const r of all) {
    await judgeRow(r);
    console.error(`${r.judge!.verdict} ${r.tool.padEnd(18)} ${r.task} ${r.judge!.reason.slice(0, 90)}`);
  }
  const tmp = resultsPath + '.tmp';
  writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + '\n');
  renameSync(tmp, resultsPath);
  console.log(writeSummary());
  process.exit(0);
}

console.error(`${pick.length} tasks x ${tools.length} tools x ${repeats} repeats, split ${values.split}, model ${values.model}, out ${outDir}`);
for (let repeat = 1; repeat <= repeats; repeat++) {
  for (let i = 0; i < pick.length; i++) {
    const task = pick[i]!;
    // Rotate tool order per task (and per repeat) so no tool always goes first on a cold cache.
    const rot = (i + repeat - 1) % tools.length;
    const order = [...tools.slice(rot), ...tools.slice(0, rot)];
    for (const tool of order) {
      if (done.has(keyOf(tool, task.id, repeat))) continue;
      const base = {
        tool, task: task.id, site: task.site, split: task.split, repeat, ques: task.ques, web: task.web, ref: task.ref, refType: task.refType, date: today,
      };
      let row: Row;
      try {
        const r = await runAgentTask({
          tool, prompt: prompt(task), model: values.model, maxTurns: turns, timeoutMs,
          outDir: join(outDir, 'transcripts'), label: `${task.id.replace(/\W+/g, '_')}--${tool}--r${repeat}`,
        });
        const a = extractAnswer(r.answer ?? '');
        row = {
          ...base, model: r.model, answer: a.answer.slice(0, 3000), rawAnswer: (r.answer ?? '').slice(0, 4000), hasAnswerLine: a.hasLine,
          lastPage: lastToolText(r.transcriptPath), turns: r.turns, toolCalls: r.toolCalls, totalInputTokens: r.totalInputTokens,
          outputTokens: r.outputTokens, toolResultTokens: r.toolResultTokens, costUsd: r.costUsd, durationMs: r.durationMs,
          permissionDenials: r.permissionDenials, error: r.error, transcript: r.transcriptPath, at: new Date().toISOString(),
        };
      } catch (e) {
        row = {
          ...base, answer: '', rawAnswer: '', hasAnswerLine: false, lastPage: '', turns: 0, toolCalls: 0, totalInputTokens: 0, outputTokens: 0,
          toolResultTokens: 0, costUsd: 0, durationMs: 0, permissionDenials: 0, error: `harness error: ${(e as Error).message.slice(0, 300)}`, at: new Date().toISOString(),
        };
      }
      await judgeRow(row);
      appendFileSync(resultsPath, JSON.stringify(row) + '\n');
      done.set(keyOf(tool, task.id, repeat), row);
      console.error(`${row.judge!.verdict.padEnd(7)} ${tool.padEnd(18)} ${task.id.padEnd(26)} calls=${row.toolCalls} in=${row.totalInputTokens} ${(row.durationMs / 1000).toFixed(0)}s${row.error ? ' ERR ' + row.error.slice(0, 60) : ''} | ${row.judge!.reason.slice(0, 100)}`);
    }
  }
}
console.log(writeSummary());
