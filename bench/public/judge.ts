// LLM judge for WebVoyager-style tasks, blind to which tool produced the answer.
//
// One `claude -p --model sonnet` call with no tools, no MCP, no user settings. The judge sees the
// task, the start site, the reference answer (and whether it is "golden" or only an example), the
// agent's final answer and the text of the last page/tool result the agent saw. It never sees the
// tool name, the transcript, or any cost/turn information.
//
// Criteria follow WebVoyager's evaluation prompt: the task must be fully completed, and the answer
// must be consistent with the evidence shown (an answer the page text does not support is a FAIL).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface JudgeInput {
  ques: string;
  site: string;
  web: string;
  ref: string;
  refType: 'golden' | 'possible';
  answer: string;
  lastPage: string;
  today: string;
}
export interface Verdict {
  verdict: 'SUCCESS' | 'FAIL';
  reason: string;
  model: string;
  costUsd: number;
  error?: string;
}

const CLAUDE = process.env.AW_BASELINE_CLAUDE ?? 'claude';
export const JUDGE_MODEL = 'sonnet';

export function judgePrompt(i: JudgeInput): string {
  const refNote =
    i.refType === 'golden'
      ? 'The reference answer is GOLDEN: the final answer must agree with it on every requested fact (wording may differ; numbers and names must match).'
      : 'The reference answer is only a POSSIBLE example, written when the task was created. The live site changes (prices, ratings, counts, news, availability), so a different answer can be correct. Judge by whether the agent did what the task asks and whether its answer is supported by the page evidence; use the reference only as a plausibility check.';
  return `You are grading an AI web agent. The agent was given a task on a live website and produced a final answer. Decide whether the task was successfully completed.

Rules:
- SUCCESS only if the agent fully completed what the task asks (every constraint: filters, sort order, counts, names, units) and gave the information requested.
- The final answer must be consistent with the page evidence below. If the answer states specifics (names, numbers, dates) that the page evidence does not support, treat them as hallucinated and answer FAIL. The page evidence is only the LAST page the agent saw, so it can be partial; a plausible answer that does not contradict it and matches the reference may still be SUCCESS, but an answer contradicted by the evidence is FAIL.
- FAIL if the agent gave no answer, says it could not complete the task, was blocked (captcha, bot wall, login) without completing it, or answered a different question.
- A task that only asks to "find/show/search" something is complete when the answer correctly identifies it; do not require actions the task does not ask for.
- ${refNote}

Today's date: ${i.today}
Start site: ${i.site} (${i.web})

TASK:
${i.ques}

REFERENCE ANSWER (${i.refType}):
${i.ref}

AGENT FINAL ANSWER:
${i.answer.trim() || '(empty)'}

LAST PAGE / TOOL OUTPUT SEEN BY THE AGENT (may be truncated):
<<<
${i.lastPage.trim() || '(none)'}
>>>

Reply with ONLY a JSON object, no markdown fences, no other text:
{"verdict":"SUCCESS" or "FAIL","reason":"one or two sentences"}`;
}

function runClaude(prompt: string, timeoutMs: number): Promise<{ out: string; err: string; code: number | null }> {
  const cwd = mkdtempSync(join(tmpdir(), 'aw-judge-'));
  return new Promise((resolve) => {
    // The prompt goes on stdin, not argv: it contains page text and can be large.
    const child = spawn(
      CLAUDE,
      ['-p', '--model', JUDGE_MODEL, '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
       '--setting-sources', 'project', '--no-session-persistence', '--permission-mode', 'dontAsk', '--max-turns', '2'],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '', err = '';
    child.stdout.setEncoding('utf8').on('data', (c) => (out += c));
    child.stderr.setEncoding('utf8').on('data', (c) => (err += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const done = (code: number | null) => { clearTimeout(timer); rmSync(cwd, { recursive: true, force: true }); resolve({ out, err, code }); };
    child.on('error', (e) => { err += String(e); done(null); });
    child.on('close', done);
    child.stdin.end(prompt);
  });
}

export function parseVerdict(text: string): { verdict: 'SUCCESS' | 'FAIL'; reason: string } | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const d = JSON.parse(m[0]);
    const v = String(d.verdict ?? '').toUpperCase();
    if (v !== 'SUCCESS' && v !== 'FAIL') return undefined;
    return { verdict: v, reason: String(d.reason ?? '').slice(0, 600) };
  } catch {
    return undefined;
  }
}

export async function judge(i: JudgeInput): Promise<Verdict> {
  let cost = 0;
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runClaude(judgePrompt(i), 180_000);
    try {
      const d = JSON.parse(r.out);
      cost += d.total_cost_usd ?? 0;
      const p = parseVerdict(String(d.result ?? ''));
      if (p) return { ...p, model: JUDGE_MODEL, costUsd: cost };
      lastErr = `unparseable judge reply: ${String(d.result ?? r.err).slice(0, 200)}`;
    } catch {
      lastErr = `judge call failed (exit ${r.code}): ${(r.err || r.out).slice(0, 200)}`;
    }
  }
  // A judge that cannot answer is not a pass. The error field lets the summary count it separately.
  return { verdict: 'FAIL', reason: 'judge error', model: JUDGE_MODEL, costUsd: cost, error: lastErr };
}
