// How much context each tool costs before the agent has done anything.
//
//   node bench/baselines/schemas.ts [--claude] [--model haiku]
//
// MCP servers: tools/list is fetched over stdio and saved; each tool definition is measured as
// the model receives it ({name, description, input_schema}). Server `instructions` (which Claude
// Code places in the system prompt) are measured separately.
// CLI tools: the skill text their installers provide, plus what the skill tells the agent to load.
// --claude additionally measures the real Claude input-token delta of loading each tool into
// `claude -p` (one-word reply, max 1 turn) against a no-tools baseline.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { McpClient } from './mcp-client.ts';
import type { McpTool } from './mcp-client.ts';
import { AGENT_BROWSER_ENV, BIN, CLI_TOOLS, MCP_VARIANTS, OUT, VERSIONS, writeMcpConfigs } from './tools.ts';
import { TOKENIZER_LABEL, bytes, fmtInt, mdTable, tokens } from './measure.ts';
import { measureContextTokens } from './run-agent.ts';
import type { ToolId } from './run-agent.ts';

export interface ToolDefSize {
  name: string;
  bytes: number;
  tokens: number;
}

export interface SchemaEntry {
  id: string;
  label: string;
  kind: 'mcp' | 'cli';
  note?: string;
  server?: { name?: string; version?: string; protocolVersion?: string };
  toolCount: number;
  /** Sum over tool definitions as sent to the model. */
  bytes: number;
  tokens: number;
  /** Raw tools/list result (all fields, incl. annotations/outputSchema) for reference. */
  rawListBytes?: number;
  instructionsBytes?: number;
  instructionsTokens?: number;
  largest?: ToolDefSize[];
  perTool?: ToolDefSize[];
  /** For CLI tools: pieces of text that reach the model. */
  parts?: { what: string; when: string; bytes: number; tokens: number }[];
  /** Measured with claude -p: total input tokens minus the no-tools baseline. */
  claudeDeltaTokens?: number;
  error?: string;
}

/** The definition as an MCP client hands it to the model (Anthropic tool format). */
export function modelFacingDef(t: McpTool): { name: string; description: string; input_schema: unknown } {
  return { name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? { type: 'object' } };
}

export function sizeTools(tools: McpTool[]): { bytes: number; tokens: number; perTool: ToolDefSize[] } {
  const perTool = tools.map((t) => {
    const s = JSON.stringify(modelFacingDef(t));
    return { name: t.name, bytes: bytes(s), tokens: tokens(s) };
  });
  return {
    bytes: perTool.reduce((a, x) => a + x.bytes, 0),
    tokens: perTool.reduce((a, x) => a + x.tokens, 0),
    perTool,
  };
}

async function mcpEntry(v: (typeof MCP_VARIANTS)[number], saveDir: string): Promise<SchemaEntry> {
  const abSession = `awschema-${process.pid}`;
  const spec = v.id === 'agent-browser-mcp' ? { ...v.spec, env: { ...v.spec.env, AGENT_BROWSER_SESSION: abSession } } : v.spec;
  const c = new McpClient(spec);
  try {
    await c.start();
    const tools = await c.listTools();
    writeFileSync(join(saveDir, `${v.id}.tools.json`), JSON.stringify({ serverInfo: c.serverInfo, instructions: c.instructions, tools }, null, 2));
    const s = sizeTools(tools);
    return {
      id: v.id,
      label: v.label,
      kind: 'mcp',
      ...(v.note ? { note: v.note } : {}),
      server: { ...c.serverInfo, protocolVersion: c.protocolVersion },
      toolCount: tools.length,
      bytes: s.bytes,
      tokens: s.tokens,
      rawListBytes: bytes(JSON.stringify(tools)),
      instructionsBytes: bytes(c.instructions ?? ''),
      instructionsTokens: tokens(c.instructions ?? ''),
      largest: [...s.perTool].sort((a, b) => b.tokens - a.tokens).slice(0, 5),
      perTool: s.perTool,
    };
  } catch (e) {
    return { id: v.id, label: v.label, kind: 'mcp', toolCount: 0, bytes: 0, tokens: 0, error: (e as Error).message + (c.stderr ? ` | ${c.stderr.slice(-300)}` : '') };
  } finally {
    await c.close();
    if (v.id === 'agent-browser-mcp') spawnSync(BIN.agentBrowser, ['--session', abSession, 'close'], { env: { ...process.env, ...AGENT_BROWSER_ENV }, timeout: 20_000 });
  }
}

function stripFrontmatter(md: string): { front: string; body: string } {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? { front: m[1], body: md.slice(m[0].length) } : { front: '', body: md };
}

function part(what: string, when: string, text: string) {
  return { what, when, bytes: bytes(text), tokens: tokens(text) };
}

function cliEntries(saveDir: string): SchemaEntry[] {
  const out: SchemaEntry[] = [];
  for (const t of CLI_TOOLS) {
    const skill = readFileSync(join(t.skillDir, 'SKILL.md'), 'utf8');
    const { front, body } = stripFrontmatter(skill);
    const desc = front.match(/^description:\s*(.*)$/m)?.[1] ?? '';
    const parts = [part('skill description (frontmatter)', 'always, in the skill listing', `${t.skillName}: ${desc}`), part('SKILL.md body', 'when the skill is loaded', body)];
    if (t.id === 'agent-browser') {
      // The stub tells the agent to load this before the first command.
      const r = spawnSync(BIN.agentBrowser, ['skills', 'get', 'core'], { env: { ...process.env, ...AGENT_BROWSER_ENV }, encoding: 'utf8' });
      const core = (r.stdout ?? '') + (r.stderr ?? '');
      writeFileSync(join(saveDir, `agent-browser.skills-get-core.txt`), core);
      parts.push(part('`agent-browser skills get core` output', 'first use (the stub says to run it)', core));
    }
    writeFileSync(join(saveDir, `${t.id}.SKILL.md`), skill);
    const loaded = parts.slice(1);
    out.push({
      id: t.id,
      label: t.label,
      kind: 'cli',
      note: 'no tool schema of its own; the agent uses a shell tool (Bash) plus the skill text',
      server: { version: VERSIONS[t.id === 'agent-browser' ? 'agent-browser' : '@playwright/cli'] },
      toolCount: 0,
      bytes: loaded.reduce((a, p) => a + p.bytes, 0),
      tokens: loaded.reduce((a, p) => a + p.tokens, 0),
      parts,
    });
  }
  return out;
}

export function schemaTable(entries: SchemaEntry[]): string {
  const hasClaude = entries.some((e) => e.claudeDeltaTokens !== undefined);
  const header = ['Tool', 'Version', 'Tools', 'Schema bytes', 'Schema tokens (proxy)', 'Instructions tokens', ...(hasClaude ? ['Claude Δ input tokens (measured)'] : []), 'Largest tool (tokens)'];
  const rows = entries.map((e) => [
    e.label + (e.note ? ' †' : ''),
    e.server?.version ?? '',
    e.kind === 'cli' ? 'Bash' : e.error ? 'FAIL' : e.toolCount,
    fmtInt(e.bytes),
    fmtInt(e.tokens) + (e.kind === 'cli' ? ' (skill text)' : ''),
    e.kind === 'mcp' ? fmtInt(e.instructionsTokens) : '–',
    ...(hasClaude ? [e.claudeDeltaTokens === undefined ? '–' : fmtInt(e.claudeDeltaTokens)] : []),
    e.largest?.[0] ? `${e.largest[0].name} (${fmtInt(e.largest[0].tokens)})` : '–',
  ]);
  return mdTable(header, rows, ['l', 'l', 'r', 'r', 'r', 'r', ...(hasClaude ? (['r'] as const) : []), 'l']);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { claude: { type: 'boolean', default: false }, model: { type: 'string', default: 'haiku' } } });
  writeMcpConfigs();
  const saveDir = join(OUT, 'tool-schemas');
  mkdirSync(saveDir, { recursive: true });
  const entries: SchemaEntry[] = [];
  for (const v of MCP_VARIANTS) {
    if (v.configOnly) continue;
    console.error(`tools/list ${v.id} …`);
    entries.push(await mcpEntry(v, saveDir));
  }
  entries.push(...cliEntries(saveDir));

  let claude: Record<string, unknown> | undefined;
  if (values.claude) {
    const base = await measureContextTokens('none', values.model);
    console.error(`claude baseline (no tools): ${base.total} input tokens`);
    claude = { model: values.model, baselineNoTools: base.total, costUsd: base.costUsd, perTool: {} as Record<string, unknown> };
    for (const e of entries) {
      const m = await measureContextTokens(e.id as ToolId, values.model);
      (claude.perTool as Record<string, unknown>)[e.id] = m;
      claude.costUsd = (claude.costUsd as number) + m.costUsd;
      if (!m.error && m.total) e.claudeDeltaTokens = m.total - base.total;
      console.error(`claude ${e.id}: ${m.total} (${m.error ?? 'ok'})`);
    }
  }

  const doc = {
    measuredAt: new Date().toISOString(),
    tokenizer: TOKENIZER_LABEL,
    method:
      'Per MCP tool: JSON.stringify({name, description, input_schema}) as a client sends it to the model. Claude Code prefixes names with mcp__<server>__ and adds its own wrapping; the measured Claude delta includes that.',
    versions: VERSIONS,
    claude,
    entries,
  };
  writeFileSync(join(OUT, 'tool-schemas.json'), JSON.stringify(doc, null, 2));
  const md = [
    `# Tool definition sizes (${doc.measuredAt})`,
    '',
    `Proxy tokens: ${TOKENIZER_LABEL}.` + (claude ? ` Claude Δ: real input tokens of \`claude -p\` (${values.model}) with the tool loaded minus ${claude.baselineNoTools} with no tools; for CLI tools this includes the Bash and Read tool definitions and the skill text in the system prompt.` : ''),
    '',
    schemaTable(entries),
    '',
    ...entries.filter((e) => e.note).map((e) => `† ${e.label}: ${e.note}`),
    '',
    ...entries
      .filter((e) => e.parts)
      .flatMap((e) => [`**${e.label}** skill text:`, '', mdTable(['Part', 'When it reaches the model', 'Bytes', 'Tokens (proxy)'], e.parts!.map((p) => [p.what, p.when, fmtInt(p.bytes), fmtInt(p.tokens)]), ['l', 'l', 'r', 'r']), '']),
  ].join('\n');
  writeFileSync(join(OUT, 'tool-schemas.md'), md + '\n');
  console.log(md);
}
