// One place that says how every baseline tool is launched on this machine.
//
// Every browser-based tool is pointed at the same local Chromium build so that differences
// come from the tool, not the browser. `--no-sandbox` is required on this kernel
// (unprivileged user namespaces are restricted by AppArmor); it is passed to every tool.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import type { McpServerSpec } from './mcp-client.ts';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
export const OUT = join(REPO, 'bench', 'out', 'baselines');
export const NM = join(HERE, 'node_modules');

export const CHROME =
  process.env.AW_BASELINE_CHROME ?? join(homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');

const pkgVersion = (name: string): string =>
  JSON.parse(readFileSync(join(NM, name, 'package.json'), 'utf8')).version as string;

export const VERSIONS = {
  '@playwright/mcp': pkgVersion('@playwright/mcp'),
  'chrome-devtools-mcp': pkgVersion('chrome-devtools-mcp'),
  'agent-browser': pkgVersion('agent-browser'),
  '@playwright/cli': pkgVersion('@playwright/cli'),
  'playwright-core (bundled with @playwright/mcp and @playwright/cli)': pkgVersion('playwright-core'),
  '@mozilla/readability': pkgVersion('@mozilla/readability'),
  turndown: pkgVersion('turndown'),
  jsdom: pkgVersion('jsdom'),
  'gpt-tokenizer': pkgVersion('gpt-tokenizer'),
};

export const BIN = {
  playwrightMcp: join(NM, '@playwright/mcp/cli.js'),
  chromeDevtoolsMcp: join(NM, 'chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'),
  // The npm package ships native binaries; bin/agent-browser.js only picks one and execs it.
  agentBrowser: join(NM, 'agent-browser/bin/agent-browser-linux-x64'),
  playwrightCli: join(NM, '@playwright/cli/playwright-cli.js'),
};

/** Directory holding `agent-browser` and `playwright-cli` shims, put first on PATH for CLI runs. */
export const CLI_BIN_DIR = join(NM, '.bin');

export const AGENT_BROWSER_ENV: Record<string, string> = {
  AGENT_BROWSER_EXECUTABLE_PATH: CHROME,
  AGENT_BROWSER_ARGS: '--no-sandbox',
};

/** Playwright CLI reads `.playwright/cli.config.json` from the working directory. */
export const PLAYWRIGHT_CLI_CONFIG = {
  browser: {
    browserName: 'chromium',
    launchOptions: { executablePath: CHROME, chromiumSandbox: false },
  },
};

export function writePlaywrightCliConfig(cwd: string): void {
  mkdirSync(join(cwd, '.playwright'), { recursive: true });
  writeFileSync(join(cwd, '.playwright', 'cli.config.json'), JSON.stringify(PLAYWRIGHT_CLI_CONFIG, null, 2));
}

export interface McpVariant {
  /** Key used in file names and tables. */
  id: string;
  /** Name the server gets in an MCP config, so its tools are mcp__<server>__*. */
  server: string;
  label: string;
  spec: McpServerSpec;
  /** Documented mode that is not the default; say so in tables. */
  note?: string;
  /** Do not launch (agentweb itself, not built yet). */
  configOnly?: boolean;
}

const node = process.execPath;

export const MCP_VARIANTS: McpVariant[] = [
  {
    id: 'playwright-mcp',
    server: 'playwright',
    label: 'Playwright MCP (default)',
    spec: {
      command: node,
      // --isolated: in-memory profile, so runs do not share cookies through a profile on disk.
      args: [BIN.playwrightMcp, '--headless', '--isolated', '--no-sandbox', '--executable-path', CHROME],
    },
  },
  {
    id: 'playwright-mcp-vision',
    server: 'playwright',
    label: 'Playwright MCP --caps vision',
    note: 'documented opt-in: adds coordinate tools (browser_mouse_*_xy) for screenshot-driven agents',
    spec: {
      command: node,
      args: [BIN.playwrightMcp, '--headless', '--isolated', '--no-sandbox', '--executable-path', CHROME, '--caps', 'vision'],
    },
  },
  {
    id: 'chrome-devtools-mcp',
    server: 'chrome-devtools',
    label: 'Chrome DevTools MCP (default)',
    spec: {
      command: node,
      args: [
        BIN.chromeDevtoolsMcp,
        '--headless',
        '--isolated',
        '--executablePath',
        CHROME,
        '--chromeArg=--no-sandbox',
      ],
      // Opt out of Google's usage statistics for benchmark runs (documented env switch).
      env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
    },
  },
  {
    id: 'chrome-devtools-mcp-slim',
    server: 'chrome-devtools',
    label: 'Chrome DevTools MCP --slim',
    note: 'documented token-saving mode: 3 tools (navigate, evaluate, screenshot), no a11y snapshot tool',
    spec: {
      command: node,
      args: [
        BIN.chromeDevtoolsMcp,
        '--headless',
        '--isolated',
        '--slim',
        '--executablePath',
        CHROME,
        '--chromeArg=--no-sandbox',
      ],
      env: { CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' },
    },
  },
  {
    id: 'agent-browser-mcp',
    server: 'agent-browser',
    label: 'agent-browser mcp',
    note: 'agent-browser also ships an MCP server; its primary documented interface is the CLI + skill',
    spec: { command: BIN.agentBrowser, args: ['mcp'], env: { ...AGENT_BROWSER_ENV } },
  },
  {
    id: 'agentweb',
    server: 'agentweb',
    label: 'agentweb',
    // fresh in-memory store per run (no carry-over between runs); the local farm is on 127.0.0.1
    spec: { command: 'node', args: [join(REPO, 'src/cli.ts'), 'mcp'], env: { AGENTWEB_STORE: 'memory:', AGENTWEB_ALLOW_PRIVATE: '1' } },
  },
];

export function variant(id: string): McpVariant {
  const v = MCP_VARIANTS.find((x) => x.id === id);
  if (!v) throw new Error(`unknown MCP variant ${id}`);
  return v;
}

/** The JSON Claude Code takes for --mcp-config. */
export function mcpConfigJson(v: McpVariant): { mcpServers: Record<string, { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }> } {
  return {
    mcpServers: {
      [v.server]: {
        type: 'stdio',
        command: v.spec.command,
        args: v.spec.args ?? [],
        ...(v.spec.env ? { env: v.spec.env } : {}),
      },
    },
  };
}

export const MCP_CONFIG_DIR = join(HERE, 'mcp-configs');

export function mcpConfigPath(id: string): string {
  return join(MCP_CONFIG_DIR, `${id}.json`);
}

/** Regenerate bench/baselines/mcp-configs/*.json from MCP_VARIANTS. */
export function writeMcpConfigs(): string[] {
  mkdirSync(MCP_CONFIG_DIR, { recursive: true });
  const written: string[] = [];
  for (const v of MCP_VARIANTS) {
    const p = mcpConfigPath(v.id);
    writeFileSync(p, JSON.stringify(mcpConfigJson(v), null, 2) + '\n');
    written.push(p);
  }
  return written;
}

// ---- CLI tools: their skill files, as their docs tell you to install them -------------------

export interface CliTool {
  id: 'agent-browser' | 'playwright-cli';
  label: string;
  bin: string;
  /** Files to place under <cwd>/.claude/skills/<name>/ (what `npx skills add` / `install --skills` produce). */
  skillDir: string;
  skillName: string;
  /** Bash permission rule, e.g. Bash(agent-browser:*) */
  bashRule: string;
}

export const CLI_TOOLS: CliTool[] = [
  {
    id: 'agent-browser',
    label: 'agent-browser CLI + skill',
    bin: 'agent-browser',
    // The stub skill that `npx skills add vercel-labs/agent-browser` installs; it tells the
    // agent to run `agent-browser skills get core` for the real guide.
    skillDir: join(NM, 'agent-browser/skills/agent-browser'),
    skillName: 'agent-browser',
    bashRule: 'Bash(agent-browser:*)',
  },
  {
    id: 'playwright-cli',
    label: 'Playwright CLI + skill',
    bin: 'playwright-cli',
    // What `playwright-cli install --skills` copies to .claude/skills/playwright-cli.
    skillDir: join(NM, '@playwright/cli/skills/playwright-cli'),
    skillName: 'playwright-cli',
    bashRule: 'Bash(playwright-cli:*)',
  },
];

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const p of writeMcpConfigs()) console.log('wrote', p);
}
