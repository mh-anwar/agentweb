// Headless agent harness: run one task through `claude -p` with exactly one browser tool.
//
// Isolation, so that tools are compared on equal terms:
//   - an empty temporary working directory per run (the CLI tools' own skill files and config are
//     the only things placed in it, where their install commands would put them);
//   - --setting-sources project: no user settings, CLAUDE.md, hooks or plugins from this machine;
//   - --strict-mcp-config: only the MCP server under test (no claude.ai connectors);
//   - --tools: built-in tools limited to none (MCP tools) or Bash+Read (CLI tools);
//   - --permission-mode dontAsk + --allowedTools: anything not allowed is denied, never prompted.
//
// The stream-json transcript is parsed to count tool calls and the size of what tools returned.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, accessSync, constants, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BIN,
  CLI_TOOLS,
  AGENT_BROWSER_ENV,
  MCP_VARIANTS,
  OUT,
  mcpConfigJson,
  writePlaywrightCliConfig,
} from './tools.ts';
import type { CliTool, McpVariant } from './tools.ts';
import { tokens } from './measure.ts';

export type ToolId =
  | 'none'
  | 'playwright-mcp'
  | 'playwright-mcp-vision'
  | 'chrome-devtools-mcp'
  | 'chrome-devtools-mcp-slim'
  | 'agent-browser-mcp'
  | 'agentweb'
  | 'agent-browser'
  | 'playwright-cli';

export interface AgentTaskInput {
  tool: ToolId;
  prompt: string;
  /** Claude Code model alias or id. Default 'haiku'. */
  model?: string;
  /** Default 20. */
  maxTurns?: number;
  /** Wall-clock limit for the whole run. Default 5 min. */
  timeoutMs?: number;
  /**
   * Working directory for the agent. Default: a fresh empty temp dir, deleted afterwards.
   * If given it must already exist and should be empty; it is not deleted.
   */
  cwd?: string;
  /** Where to write <label>.jsonl. Default bench/out/baselines/runs. */
  outDir?: string;
  /** File name stem for the transcript. Default <tool>-<timestamp>. */
  label?: string;
  /** Optional spend cap passed to claude (--max-budget-usd). */
  maxBudgetUsd?: number;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
  resultChars: number;
  resultTokens: number;
  images: number;
  isError: boolean;
}

export interface AgentTaskResult {
  answer: string;
  /** num_turns as reported by claude (assistant API round trips). */
  turns: number;
  toolCalls: number;
  /** Uncached input tokens, summed over all API calls. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** inputTokens + cacheReadTokens + cacheWriteTokens. */
  totalInputTokens: number;
  /**
   * From result.modelUsage: every API call claude made, including small auxiliary calls it makes
   * besides the agent loop. costUsd (total_cost_usd, at list prices) covers these too; the token
   * fields above are the agent loop only (result.usage).
   */
  allCalls: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; thinkingTokens: number; models: string[] };
  costUsd: number;
  durationMs: number;
  /** Characters of text in all tool results the model received. */
  toolResultChars: number;
  /** Same text in o200k proxy tokens. */
  toolResultTokens: number;
  toolResultImages: number;
  calls: ToolCallRecord[];
  /** Tool calls refused by the permission layer (should be 0 if the agent stays inside its tool). */
  permissionDenials: number;
  model?: string;
  toolsOffered: string[];
  mcpServers: unknown;
  stopReason?: string;
  error?: string;
  transcriptPath: string;
}

const CLAUDE = process.env.AW_BASELINE_CLAUDE ?? 'claude';

interface Prepared {
  args: string[];
  env: Record<string, string>;
  cleanup: () => Promise<void>;
}

function cliTool(id: string): CliTool | undefined {
  return CLI_TOOLS.find((t) => t.id === id);
}

function skillPrompt(t: CliTool, cwd: string): string {
  const raw = readFileSync(join(t.skillDir, 'SKILL.md'), 'utf8');
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
  return [
    `The \`${t.bin}\` command is installed and on PATH. Its skill is installed at ${join(cwd, '.claude/skills', t.skillName)}/ and its SKILL.md follows.`,
    // Harness rule, stated so the agent is not surprised by denials (an MCP agent sees its tool
    // list; a shell agent otherwise cannot know which commands the permission rule admits).
    `In this environment the Bash tool may run only \`${t.bin}\` commands, optionally piped into head/grep. Other programs (curl, python, node, ...), shell variable assignments and command substitution are denied.`,
    '',
    body,
  ].join('\n');
}

/** Build the claude argv/env for a tool. `root` is a private temp dir for helper files. */
function prepare(input: AgentTaskInput, cwd: string, root: string): Prepared {
  const common = [
    '--model',
    input.model ?? 'haiku',
    '--max-turns',
    String(input.maxTurns ?? 20),
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--permission-mode',
    'dontAsk',
    ...(input.maxBudgetUsd ? ['--max-budget-usd', String(input.maxBudgetUsd)] : []),
  ];
  const env: Record<string, string> = {};
  let cleanup = async () => {};

  if (input.tool === 'none') {
    return { args: [...common, '--tools', ''], env, cleanup };
  }

  const v: McpVariant | undefined = MCP_VARIANTS.find((x) => x.id === input.tool);
  if (v) {
    const cfgPath = join(root, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify(mcpConfigJson(v), null, 2));
    // agent-browser's MCP server shares daemons by session name; give the run its own.
    if (v.id === 'agent-browser-mcp') {
      const session = `aw-${randomUUID().slice(0, 8)}`;
      env.AGENT_BROWSER_SESSION = session;
      // Its daemon detaches from claude's process group; close it explicitly.
      cleanup = async () => {
        await runQuiet(BIN.agentBrowser, ['--session', session, 'close'], { ...process.env, ...v.spec.env, ...env }, cwd);
      };
    }
    return {
      args: [...common, '--mcp-config', cfgPath, '--tools', '', '--allowedTools', `mcp__${v.server}`],
      env,
      cleanup,
    };
  }

  const t = cliTool(input.tool);
  if (!t) throw new Error(`unknown tool ${input.tool}`);
  // The skill exactly where its installer puts it.
  cpSync(t.skillDir, join(cwd, '.claude', 'skills', t.skillName), { recursive: true });
  // The CLI on PATH as a global install would provide it (agent-browser: the native binary).
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  if (t.id === 'agent-browser') {
    // A non-executable symlink lets the shell silently fall through to a different binary
    // on PATH. Fail before starting the model, and track every session the model creates.
    accessSync(BIN.agentBrowser, constants.X_OK);
    const session = `aw-${randomUUID().slice(0, 8)}`;
    const sessionLog = join(root, 'browser-sessions.jsonl');
    writeFileSync(sessionLog, '');
    writeFileSync(join(binDir, 'agent-browser'), `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
let session = process.env.AGENT_BROWSER_SESSION;
const prefix = ${JSON.stringify(session + '-')};
const scoped = name => name.startsWith(prefix) ? name : prefix + name;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--session' && args[i + 1]) { session = scoped(args[++i]); args[i] = session; }
  else if (args[i].startsWith('--session=')) { session = scoped(args[i].slice(10)); args[i] = '--session=' + session; }
}
if (session) appendFileSync(${JSON.stringify(sessionLog)}, JSON.stringify(session) + '\\n');
const result = spawnSync(${JSON.stringify(BIN.agentBrowser)}, args, { stdio: 'inherit', env: process.env });
if (result.error) { process.stderr.write(String(result.error) + '\\n'); process.exit(1); }
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    Object.assign(env, AGENT_BROWSER_ENV);
    env.AGENT_BROWSER_SESSION = session;
    env.AGENT_BROWSER_SCREENSHOT_DIR = cwd;
    cleanup = async () => {
      const sessions = new Set<string>([session, ...readFileSync(sessionLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as string)]);
      for (const name of sessions) await runQuiet(BIN.agentBrowser, ['--session', name, 'close'], { ...process.env, ...env }, cwd);
    };
  } else {
    writeFileSync(join(binDir, 'playwright-cli'), `#!/bin/sh\nexec "${process.execPath}" "${BIN.playwrightCli}" "$@"\n`, {
      mode: 0o755,
    });
    writePlaywrightCliConfig(cwd);
    env.NO_UPDATE_NOTIFIER = '1';
    cleanup = async () => {
      await runQuiet(process.execPath, [BIN.playwrightCli, 'close-all'], { ...process.env, ...env }, cwd);
    };
  }
  env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
  return {
    args: [
      ...common,
      '--mcp-config',
      JSON.stringify({ mcpServers: {} }),
      '--tools',
      'Bash,Read',
      '--allowedTools',
      t.bashRule,
      'Read',
      '--append-system-prompt',
      skillPrompt(t, cwd),
    ],
    env,
    cleanup: async () => cleanup(),
  };
}

function runQuiet(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env, cwd, stdio: 'ignore' });
    const t = setTimeout(() => p.kill('SIGKILL'), 15_000);
    p.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
    p.on('error', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** Parse a claude stream-json transcript (one JSON object per line). */
export function parseStream(lines: string[]): Omit<AgentTaskResult, 'transcriptPath' | 'durationMs'> & { durationMs?: number } {
  const calls = new Map<string, ToolCallRecord>();
  let init: any;
  let result: any;
  const assistantText: string[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.type === 'system' && d.subtype === 'init') init = d;
    else if (d.type === 'assistant' && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b.type === 'tool_use' && !calls.has(b.id)) {
          calls.set(b.id, { id: b.id, name: b.name, input: b.input, resultChars: 0, resultTokens: 0, images: 0, isError: false });
        } else if (b.type === 'text' && typeof b.text === 'string') assistantText.push(b.text);
      }
    } else if (d.type === 'user' && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) {
        if (b.type !== 'tool_result') continue;
        const rec = calls.get(b.tool_use_id) ?? {
          id: b.tool_use_id,
          name: '?',
          input: undefined,
          resultChars: 0,
          resultTokens: 0,
          images: 0,
          isError: false,
        };
        const parts = typeof b.content === 'string' ? [{ type: 'text', text: b.content }] : Array.isArray(b.content) ? b.content : [];
        for (const p of parts) {
          if (p.type === 'text' && typeof p.text === 'string') {
            rec.resultChars += p.text.length;
            rec.resultTokens += tokens(p.text);
          } else if (p.type === 'image') rec.images++;
        }
        rec.isError = rec.isError || b.is_error === true;
        calls.set(rec.id, rec);
      }
    } else if (d.type === 'result') result = d;
  }
  const u = result?.usage ?? {};
  const list = [...calls.values()];
  const inputTokens = u.input_tokens ?? 0;
  const cacheReadTokens = u.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
  const mu: Record<string, any> = result?.modelUsage ?? {};
  const sum = (k: string) => Object.values(mu).reduce((a: number, m: any) => a + (typeof m?.[k] === 'number' ? m[k] : 0), 0);
  const allCalls = {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cacheReadTokens: sum('cacheReadInputTokens'),
    cacheWriteTokens: sum('cacheCreationInputTokens'),
    thinkingTokens: sum('thinkingTokens'),
    models: Object.keys(mu),
  };
  let error: string | undefined;
  if (!result) error = 'no result message in stream';
  else if (result.is_error || result.subtype !== 'success') error = `${result.subtype ?? 'error'}${result.api_error_status ? ' ' + result.api_error_status : ''}`;
  return {
    answer: typeof result?.result === 'string' ? result.result : assistantText.join('\n'),
    turns: result?.num_turns ?? 0,
    toolCalls: list.length,
    inputTokens,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
    totalInputTokens: inputTokens + cacheReadTokens + cacheWriteTokens,
    allCalls,
    costUsd: result?.total_cost_usd ?? 0,
    durationMs: result?.duration_ms,
    toolResultChars: list.reduce((s, c) => s + c.resultChars, 0),
    toolResultTokens: list.reduce((s, c) => s + c.resultTokens, 0),
    toolResultImages: list.reduce((s, c) => s + c.images, 0),
    calls: list,
    permissionDenials: Array.isArray(result?.permission_denials) ? result.permission_denials.length : 0,
    model: init?.model,
    toolsOffered: Array.isArray(init?.tools) ? init.tools : [],
    mcpServers: init?.mcp_servers,
    stopReason: result?.terminal_reason ?? result?.stop_reason,
    error,
  };
}

export async function runAgentTask(input: AgentTaskInput): Promise<AgentTaskResult> {
  const root = mkdtempSync(join(tmpdir(), 'aw-agent-'));
  const cwd = input.cwd ?? join(root, 'work');
  mkdirSync(cwd, { recursive: true });
  const outDir = input.outDir ?? join(OUT, 'runs');
  mkdirSync(outDir, { recursive: true });
  const label = input.label ?? `${input.tool}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const transcriptPath = join(outDir, `${label}.jsonl`);
  const stderrPath = join(outDir, `${label}.stderr.txt`);

  const prep = prepare(input, cwd, root);
  const t0 = Date.now();
  const lines: string[] = [];
  let timedOut = false;
  let spawnError: string | undefined;
  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    const child = spawn(CLAUDE, ['-p', input.prompt, ...prep.args], {
      cwd,
      env: { ...process.env, ...prep.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const tx = createWriteStream(transcriptPath);
    const errOut = createWriteStream(stderrPath);
    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      tx.write(chunk);
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    child.stderr!.pipe(errOut);
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000).unref();
    }, input.timeoutMs ?? 300_000);
    child.on('error', (e) => {
      spawnError = String(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (buf) lines.push(buf);
      tx.end();
      errOut.end();
      // MCP servers and browsers are children of claude; make sure none survive.
      killGroup(child.pid, 'SIGKILL');
      resolve({ code, signal });
    });
  });
  const wall = Date.now() - t0;
  await prep.cleanup().catch(() => {});
  // root holds the default cwd (if we made it), the MCP config and the PATH shims.
  rmSync(root, { recursive: true, force: true });

  const parsed = parseStream(lines);
  let error = parsed.error;
  if (timedOut) error = `timeout after ${input.timeoutMs ?? 300_000} ms` + (error ? ` (${error})` : '');
  else if (spawnError) error = spawnError;
  else if (exit.code !== 0 && !error) error = `claude exited ${exit.code ?? exit.signal}`;
  if (error && !parsed.error) {
    try {
      const tail = readFileSync(stderrPath, 'utf8').trim().split('\n').slice(-3).join(' | ');
      if (tail) error += `: ${tail.slice(0, 300)}`;
    } catch {}
  }
  return { ...parsed, durationMs: wall, error, transcriptPath };
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {}
}

/**
 * Context cost of a tool as Claude itself counts it: total input tokens of a one-word reply with
 * the tool loaded, minus the same with no tools. Uses the real Claude tokenizer (via billing).
 */
export async function measureContextTokens(tool: ToolId, model = 'haiku'): Promise<{ total: number; costUsd: number; error?: string; toolsOffered: string[] }> {
  const r = await runAgentTask({
    tool,
    model,
    prompt: 'Reply with the single word ok. Do not use any tools.',
    maxTurns: 1,
    timeoutMs: 120_000,
    outDir: join(OUT, 'context-probe'),
    label: `${tool}-${model}`,
  });
  return { total: r.totalInputTokens, costUsd: r.costUsd, error: r.error, toolsOffered: r.toolsOffered };
}

// CLI: node run-agent.ts <tool> "<prompt>" [model] [maxTurns]
if (import.meta.url === `file://${process.argv[1]}`) {
  const [tool, prompt, model, maxTurns] = process.argv.slice(2);
  if (!tool || !prompt) {
    console.error('usage: node run-agent.ts <tool> "<prompt>" [model] [maxTurns]');
    process.exit(2);
  }
  const r = await runAgentTask({ tool: tool as ToolId, prompt, model, maxTurns: maxTurns ? Number(maxTurns) : undefined });
  const { calls, ...summary } = r;
  console.log(JSON.stringify({ ...summary, calls: calls.map((c) => ({ name: c.name, resultTokens: c.resultTokens, images: c.images, isError: c.isError })) }, null, 2));
}
