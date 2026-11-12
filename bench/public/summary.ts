// summary.md for a public-benchmark results.jsonl.

import type { Verdict } from './judge.ts';

export interface Row {
  tool: string;
  task: string;
  site: string;
  split: string;
  repeat: number;
  ques: string;
  web: string;
  ref: string;
  refType: 'golden' | 'possible';
  date: string;
  model?: string;
  answer: string; // final answer text (after "ANSWER:" if present)
  rawAnswer: string;
  hasAnswerLine: boolean;
  lastPage: string;
  turns: number;
  toolCalls: number;
  totalInputTokens: number;
  outputTokens: number;
  toolResultTokens: number;
  costUsd: number;
  durationMs: number;
  permissionDenials: number;
  error?: string;
  transcript?: string;
  judge?: Verdict;
  at: string;
}

export const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2) : 0;
};
export const p90 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]! : 0;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const n0 = (x: number) => Math.round(x).toLocaleString('en');

/** 95% Wilson score interval. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
export const passed = (r: Row) => r.judge?.verdict === 'SUCCESS';
const judged = (r: Row) => !!r.judge && !r.judge.error;

function rate(rs: Row[]): string {
  const j = rs.filter(judged);
  if (!j.length) return '-';
  const k = j.filter(passed).length;
  const [lo, hi] = wilson(k, j.length);
  return `${k}/${j.length} = ${pct(k / j.length)} [${pct(lo)}-${pct(hi)}]`;
}

export function summarize(rows: Row[], tools: string[], meta: { model: string; split: string; repeats: number }): string {
  const L: string[] = [];
  const tasks = [...new Set(rows.map((r) => r.task))];
  L.push(`# Public benchmark: WebVoyager sample (${new Date().toISOString().slice(0, 10)}, agent model ${meta.model}, split ${meta.split}, ${tasks.length} tasks, repeats ${meta.repeats})`, '');
  L.push('Pass rate = judge SUCCESS / judged runs, with a 95% Wilson interval. Live sites drift; read small differences as noise.', '');
  L.push('| Tool | Runs | Pass rate [95% CI] | Median input tok | p90 input tok | Total input tok | Cost | Median wall | Median calls | Errors | Timeouts | Perm. denials | Unjudged |');
  L.push('|:--|--:|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
  for (const t of tools) {
    const rs = rows.filter((r) => r.tool === t);
    L.push(`| ${t} | ${rs.length} | ${rate(rs)} | ${n0(med(rs.map((r) => r.totalInputTokens)))} | ${n0(p90(rs.map((r) => r.totalInputTokens)))} | ${n0(sum(rs.map((r) => r.totalInputTokens)))} | $${sum(rs.map((r) => r.costUsd)).toFixed(2)} | ${(med(rs.map((r) => r.durationMs)) / 1000).toFixed(0)}s | ${med(rs.map((r) => r.toolCalls))} | ${rs.filter((r) => r.error && !r.error.startsWith('timeout')).length} | ${rs.filter((r) => r.error?.startsWith('timeout')).length} | ${sum(rs.map((r) => r.permissionDenials))} | ${rs.filter((r) => !judged(r)).length} |`);
  }
  const judgeCost = sum(rows.map((r) => r.judge?.costUsd ?? 0));
  L.push('', `Agent cost is claude's total_cost_usd at list prices. Judge cost (not included above): $${judgeCost.toFixed(2)}. "Errors" are runs where claude reported a non-success result (max turns, API error, harness error) excluding timeouts; such runs are still judged on whatever answer exists.`, '');

  const sites = [...new Set(rows.map((r) => r.site))].sort();
  L.push('## Pass by site', '', `| Site | ${tools.join(' | ')} |`, `|:--|${tools.map(() => '--:').join('|')}|`);
  for (const s of sites) {
    L.push(`| ${s} | ${tools.map((t) => {
      const j = rows.filter((r) => r.tool === t && r.site === s && judged(r));
      return j.length ? `${j.filter(passed).length}/${j.length}` : '-';
    }).join(' | ')} |`);
  }

  // Matched cells: (task, repeat) pairs that every tool ran.
  const cells = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.task}/${r.repeat}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  const matched = [...cells.values()].filter((rs) => tools.every((t) => rs.some((r) => r.tool === t && judged(r))));
  L.push('', `## Matched cells (only task x repeat pairs that all ${tools.length} tools ran and were judged: ${matched.length})`, '');
  if (matched.length) {
    L.push('| Tool | Pass rate [95% CI] | Median input tok | Total input tok | Cost | Median wall | Median calls |', '|:--|:--|--:|--:|--:|--:|--:|');
    for (const t of tools) {
      const rs = matched.map((c) => c.find((r) => r.tool === t)!);
      L.push(`| ${t} | ${rate(rs)} | ${n0(med(rs.map((r) => r.totalInputTokens)))} | ${n0(sum(rs.map((r) => r.totalInputTokens)))} | $${sum(rs.map((r) => r.costUsd)).toFixed(2)} | ${(med(rs.map((r) => r.durationMs)) / 1000).toFixed(0)}s | ${med(rs.map((r) => r.toolCalls))} |`);
    }
  } else L.push('(none yet)');

  L.push('', '## Every run', '', `| Task | ${tools.map((t) => `${t} (verdict · calls · input)`).join(' | ')} |`, `|:--|${tools.map(() => ':--').join('|')}|`);
  for (const task of tasks) {
    L.push(`| ${task} | ${tools.map((t) => rows.filter((r) => r.tool === t && r.task === task).sort((a, b) => a.repeat - b.repeat).map((r) => `${!r.judge ? '?' : r.judge.error ? 'J!' : passed(r) ? '✓' : '✗'} · ${r.toolCalls} · ${n0(r.totalInputTokens)}`).join(' / ') || '-').join(' | ')} |`);
  }
  return L.join('\n') + '\n';
}
