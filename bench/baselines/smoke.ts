// A handful of short live runs that prove the agent harness end to end.
//
//   node bench/baselines/smoke.ts <run-id> [<run-id> ...]     (or "all")
//
// Transcripts and a cumulative summary go to bench/out/baselines/smoke/.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './tools.ts';
import { runAgentTask } from './run-agent.ts';
import type { AgentTaskResult, ToolId } from './run-agent.ts';
import { fmtInt, mdTable } from './measure.ts';

const HN = 'What is the title of the top story on https://news.ycombinator.com/ ? Reply with the title only.';
const BOOKS =
  'On https://books.toscrape.com/ find the three cheapest books in the Poetry category. Reply with one line per book: title, price.';
const SAUCE =
  'Log in to https://www.saucedemo.com/ with username standard_user and password secret_sauce, then tell me the price of the "Sauce Labs Backpack". Reply with the price only.';

export const SMOKE_RUNS: { id: string; tool: ToolId; prompt: string }[] = [
  { id: 'hn-playwright-mcp', tool: 'playwright-mcp', prompt: HN },
  { id: 'hn-agent-browser', tool: 'agent-browser', prompt: HN },
  { id: 'hn-chrome-devtools-mcp', tool: 'chrome-devtools-mcp', prompt: HN },
  { id: 'hn-playwright-cli', tool: 'playwright-cli', prompt: HN },
  { id: 'sauce-playwright-mcp', tool: 'playwright-mcp', prompt: SAUCE },
  { id: 'sauce-agent-browser', tool: 'agent-browser', prompt: SAUCE },
  { id: 'hn-agentweb', tool: 'agentweb', prompt: HN },
  { id: 'sauce-agentweb', tool: 'agentweb', prompt: SAUCE },
  { id: 'books-agentweb', tool: 'agentweb', prompt: BOOKS },
  { id: 'books-playwright-mcp', tool: 'playwright-mcp', prompt: BOOKS },
  { id: 'books-agent-browser', tool: 'agent-browser', prompt: BOOKS },
];

const DIR = join(OUT, 'smoke');

if (import.meta.url === `file://${process.argv[1]}`) {
  const ids = process.argv.slice(2);
  const runs = ids.includes('all') ? SMOKE_RUNS : SMOKE_RUNS.filter((r) => ids.includes(r.id));
  if (!runs.length) {
    console.error(`usage: node smoke.ts <id...>|all\nids: ${SMOKE_RUNS.map((r) => r.id).join(', ')}`);
    process.exit(2);
  }
  mkdirSync(DIR, { recursive: true });
  const summaryPath = join(DIR, 'smoke.json');
  const all: Record<string, unknown> = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : {};
  for (const r of runs) {
    console.error(`run ${r.id} …`);
    const res: AgentTaskResult = await runAgentTask({ tool: r.tool, prompt: r.prompt, model: 'haiku', maxTurns: 15, timeoutMs: 240_000, outDir: DIR, label: r.id });
    all[r.id] = { ...r, at: new Date().toISOString(), result: res };
    writeFileSync(summaryPath, JSON.stringify(all, null, 2));
    console.error(
      `  answer=${JSON.stringify(res.answer.slice(0, 120))} turns=${res.turns} calls=${res.toolCalls} in=${res.totalInputTokens} out=${res.outputTokens} cost=$${res.costUsd.toFixed(4)} ${(res.durationMs / 1000).toFixed(1)}s denials=${res.permissionDenials} ${res.error ?? ''}`,
    );
  }
  const rows = Object.values(all).map((x: any) => {
    const r = x.result as AgentTaskResult;
    return [
      x.id,
      r.model ?? '',
      r.answer.replace(/\s+/g, ' ').slice(0, 60),
      r.turns,
      r.toolCalls,
      fmtInt(r.toolResultTokens),
      fmtInt(r.totalInputTokens),
      fmtInt(r.cacheReadTokens),
      fmtInt(r.outputTokens),
      `$${r.costUsd.toFixed(4)}`,
      `${(r.durationMs / 1000).toFixed(1)}s`,
      r.error ?? (r.permissionDenials ? `${r.permissionDenials} denied` : ''),
    ];
  });
  const md = mdTable(
    ['Run', 'Model', 'Answer', 'Turns', 'Tool calls', 'Tool-result tokens (proxy)', 'Input tokens (all)', 'of which cache read', 'Output tokens', 'Cost', 'Wall', 'Error'],
    rows,
    ['l', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'],
  );
  writeFileSync(join(DIR, 'smoke.md'), md + '\n');
  console.log(md);
}
