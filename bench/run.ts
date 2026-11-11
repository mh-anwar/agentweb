// The task benchmark: every task on the local farm, every tool, the same agent and harness.
//
//   node bench/run.ts [--tools agentweb,agent-browser,playwright-mcp] [--tasks core|all|id,id] [--repeats 3] [--out dir]
//
// Each run: reset the farm, fill the prompt from the farm's ground truth, run `claude -p` with only
// that tool (bench/baselines/run-agent.ts), then grade the answer AND the server-side state with the
// task's own check. Results append to <out>/results.jsonl (so an interrupted run can resume:
// finished (tool, task) pairs are skipped) and a summary goes to <out>/summary.md.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { VERSIONS, BIN, CHROME } from './baselines/tools.ts';
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
    repeats: { type: 'string', default: '1' },
  },
});

const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new Error('--repeats must be an integer from 1 to 20');
const outDir = values.out!;
mkdirSync(join(outDir, 'transcripts'), { recursive: true });
const resultsPath = join(outDir, 'results.jsonl');

interface Row {
  tool: string;
  repeat: number;
  permissionDenials?: number;
  model?: string;
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
    done.set(`${r.tool}/${r.task}/${r.repeat ?? 1}`, r);
  }
}

const pick =
  values.tasks === 'all'
    ? tasks
    : values.tasks === 'core'
      ? tasks.filter((t) => t.tags.includes('core'))
      : tasks.filter((t) => values.tasks!.split(',').includes(t.id));
const tools = values.tools!.split(',').map((s) => s.trim()) as ToolId[];

if (!pick.length) throw new Error('no tasks matched');
const manifestPath = join(outDir, 'manifest.json');
const manifest = {
  model: values.model, turns: Number(values.turns), repeats, tools, tasks: pick.map(t => t.id),
  gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim(),
  diffSha256: createHash('sha256').update(execFileSync('git', ['diff', 'HEAD'], { cwd: import.meta.dirname })).digest('hex'),
  node: process.version, versions: VERSIONS,
  browser: execFileSync(CHROME, ['--version'], { encoding: 'utf8' }).trim(),
  agentBrowserBinary: tools.some(t => t.startsWith('agent-browser'))
    ? execFileSync(BIN.agentBrowser, ['--version'], { encoding: 'utf8' }).trim() : undefined,
};
if (existsSync(manifestPath)) {
  if (JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== JSON.stringify(manifest)) {
    throw new Error('benchmark configuration or source changed; choose a new --out directory');
  }
} else {
  if (done.size) throw new Error('existing results have no provenance manifest; choose a new --out directory');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

const farm = await startFarm({ port: Number(values.port) });
console.error(`farm at ${farm.url} (other ${farm.other}); ${pick.length} tasks × ${tools.length} tools × ${repeats} repeats`);
const v = vars(farm.truth, farm);

try {
  for (let repeat = 1; repeat <= repeats; repeat++) {
    for (const task of pick) {
      // Rotate tool order to reduce systematic warm-cache and time-of-day advantages.
      const order = [...tools.slice((repeat - 1) % tools.length), ...tools.slice(0, (repeat - 1) % tools.length)];
      for (const tool of order) {
        const key = `${tool}/${task.id}/${repeat}`;
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
            label: `${task.id}--${tool}--r${repeat}`,
          });
          const c = task.check(r.answer ?? '', farm.state(), farm.truth);
          row = {
            tool, repeat, permissionDenials: r.permissionDenials, model: r.model,
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
            error: r.error,
            at: new Date().toISOString(),
          };
        } catch (e) {
          row = {
            tool, repeat, task: task.id, tags: task.tags, minTier: task.minTier, pass: false, why: 'harness error', answer: '',
            turns: 0, toolCalls: 0, totalInputTokens: 0, outputTokens: 0, toolResultTokens: 0, costUsd: 0, durationMs: 0,
            error: (e as Error).message.slice(0, 300), at: new Date().toISOString(),
          };
        }
        appendFileSync(resultsPath, JSON.stringify(row) + '\n');
        done.set(key, row);
        console.error(`${row.pass ? 'PASS' : 'FAIL'} ${tool.padEnd(20)} ${task.id.padEnd(28)} calls=${row.toolCalls} in=${row.totalInputTokens} ${(row.durationMs / 1000).toFixed(1)}s ${row.pass ? '' : row.why.slice(0, 100)}`);
      }
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
  `# Task benchmark (${new Date().toISOString().slice(0, 10)}, model ${values.model}, ${pick.length} tasks, n=${repeats} per cell)`,
  '',
  '| Tool | Passed | Median tool calls | Median input tokens | Total input tokens | Median wall | Cost | Permission denials |',
  '|:--|--:|--:|--:|--:|--:|--:|--:|',
];
for (const tool of tools) {
  const rs = rows.filter((r) => r.tool === tool);
  lines.push(
    `| ${tool} | ${rs.filter((r) => r.pass).length}/${rs.length} | ${med(rs.map((r) => r.toolCalls))} | ${med(rs.map((r) => r.totalInputTokens)).toLocaleString('en')} | ${sum(rs.map((r) => r.totalInputTokens)).toLocaleString('en')} | ${(med(rs.map((r) => r.durationMs)) / 1000).toFixed(1)}s | $${sum(rs.map((r) => r.costUsd)).toFixed(3)} | ${sum(rs.map(r => r.permissionDenials ?? 0))} |`,
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
    return Array.from({ length: repeats }, (_, i) => {
      const r = done.get(`${tool}/${t.id}/${i + 1}`);
      return r ? `${r.pass ? '✓' : '✗'} · ${r.toolCalls} · ${r.totalInputTokens.toLocaleString('en')}` : 'pending';
    }).join(' / ');
  }).join(' | ')} |`);
}
writeFileSync(join(outDir, 'summary.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
