// The task benchmark: every task on the local farm, every tool, the same agent and harness.
//
//   node bench/run.ts [--tools agentweb,playwright-mcp] [--tasks core|all|id,id] [--model haiku] [--turns 20] [--out dir]
//
// Each run: reset the farm, fill the prompt from the farm's ground truth, run `claude -p` with only
// that tool (bench/baselines/run-agent.ts), then grade the answer AND the server-side state with the
// task's own check. Results append to <out>/results.jsonl (so an interrupted run can resume:
// finished (tool, task) pairs are skipped) and a summary goes to <out>/summary.md.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startFarm } from './sites/farm.ts';
import { fillPrompt, tasks, vars } from './sites/tasks.ts';
import { runAgentTask, type ToolId } from './baselines/run-agent.ts';

const { values } = parseArgs({
  options: {
    tools: { type: 'string', default: 'agentweb,playwright-mcp' },
    tasks: { type: 'string', default: 'core' },
    model: { type: 'string', default: 'haiku' },
    turns: { type: 'string', default: '20' },
    out: { type: 'string', default: join(import.meta.dirname, 'out', 'tasks') },
    port: { type: 'string', default: '4610' },
  },
});

const outDir = values.out!;
mkdirSync(join(outDir, 'transcripts'), { recursive: true });
const resultsPath = join(outDir, 'results.jsonl');

interface Row {
  tool: string;
  task: string;
  tags: string[];
  minTier: string;
  pass: boolean;
  why: string;
  answer: string;
  turns: number;
  toolCalls: number;
  totalInputTokens: number;
  outputTokens: number;
  toolResultTokens: number;
  costUsd: number;
  durationMs: number;
  error?: string;
  at: string;
}

const done = new Map<string, Row>();
if (existsSync(resultsPath)) {
  for (const l of readFileSync(resultsPath, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as Row;
    done.set(`${r.tool}/${r.task}`, r);
  }
}

const pick =
  values.tasks === 'all'
    ? tasks
    : values.tasks === 'core'
      ? tasks.filter((t) => t.tags.includes('core'))
      : tasks.filter((t) => values.tasks!.split(',').includes(t.id));
const tools = values.tools!.split(',').map((s) => s.trim()) as ToolId[];

const farm = await startFarm({ port: Number(values.port) });
console.error(`farm at ${farm.url} (other ${farm.other}); ${pick.length} tasks × ${tools.length} tools`);
const v = vars(farm.truth, farm);

try {
  for (const task of pick) {
    for (const tool of tools) {
      const key = `${tool}/${task.id}`;
      if (done.has(key)) continue;
      farm.reset();
      const prompt = fillPrompt(task.prompt, v);
      let row: Row;
      try {
        const r = await runAgentTask({
          tool,
          prompt,
          model: values.model,
          maxTurns: Number(values.turns),
          timeoutMs: 300_000,
          outDir: join(outDir, 'transcripts'),
          label: `${task.id}--${tool}`,
        });
        const c = task.check(r.answer ?? '', farm.state(), farm.truth);
        row = {
          tool,
          task: task.id,
          tags: task.tags,
          minTier: task.minTier,
          pass: c.pass,
          why: c.why,
          answer: (r.answer ?? '').slice(0, 400),
          turns: r.turns,
          toolCalls: r.toolCalls,
          totalInputTokens: r.totalInputTokens,
          outputTokens: r.outputTokens,
          toolResultTokens: r.toolResultTokens,
          costUsd: r.costUsd,
          durationMs: r.durationMs,
          at: new Date().toISOString(),
        };
      } catch (e) {
        row = {
          tool, task: task.id, tags: task.tags, minTier: task.minTier, pass: false, why: 'harness error', answer: '',
          turns: 0, toolCalls: 0, totalInputTokens: 0, outputTokens: 0, toolResultTokens: 0, costUsd: 0, durationMs: 0,
          error: (e as Error).message.slice(0, 300), at: new Date().toISOString(),
        };
      }
      appendFileSync(resultsPath, JSON.stringify(row) + '\n');
      done.set(key, row);
      console.error(`${row.pass ? 'PASS' : 'FAIL'} ${tool.padEnd(20)} ${task.id.padEnd(28)} calls=${row.toolCalls} in=${row.totalInputTokens} ${(row.durationMs / 1000).toFixed(1)}s ${row.pass ? '' : row.why.slice(0, 100)}`);
    }
  }
} finally {
  await farm.close();
}

// ── summary ──
const rows = [...done.values()].filter((r) => tools.includes(r.tool as ToolId) && pick.some((t) => t.id === r.task));
const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const lines = [
  `# Task benchmark (${new Date().toISOString().slice(0, 10)}, model ${values.model}, ${pick.length} tasks, n=1 per cell)`,
  '',
  '| Tool | Passed | Median tool calls | Median input tokens | Total input tokens | Median wall | Cost |',
  '|:--|--:|--:|--:|--:|--:|--:|',
];
for (const tool of tools) {
  const rs = rows.filter((r) => r.tool === tool);
  lines.push(
    `| ${tool} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${med(rs.map((r) => r.toolCalls))} | ${med(rs.map((r) => r.totalInputTokens)).toLocaleString('en')} | ${sum(rs.map((r) => r.totalInputTokens)).toLocaleString('en')} | ${(med(rs.map((r) => r.durationMs)) / 1000).toFixed(1)}s | $${sum(rs.map((r) => r.costUsd)).toFixed(3)} |`,
  );
}
const tags = [...new Set(rows.flatMap((r) => r.tags))].filter((t) => t !== 'core').sort();
lines.push('', '## Passed by tag', '', `| Tag | ${tools.join(' | ')} |`, `|:--|${tools.map(() => '--:').join('|')}|`);
for (const tag of tags) {
  lines.push(`| ${tag} | ${tools.map((tool) => {
    const rs = rows.filter((r) => r.tool === tool && r.tags.includes(tag));
    return `${rs.filter((r) => r.pass).length}/${rs.length}`;
  }).join(' | ')} |`);
}
lines.push('', '## Every run', '', `| Task | ${tools.map((t) => `${t} (pass · calls · input)`).join(' | ')} |`, `|:--|${tools.map(() => ':--').join('|')}|`);
for (const t of pick) {
  lines.push(`| ${t.id} | ${tools.map((tool) => {
    const r = done.get(`${tool}/${t.id}`);
    return r ? `${r.pass ? '✓' : '✗'} · ${r.toolCalls} · ${r.totalInputTokens.toLocaleString('en')}` : '';
  }).join(' | ')} |`);
}
writeFileSync(join(outDir, 'summary.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
