// `agentweb setup`: one command that makes agentweb available to every coding agent on the machine.
//
// It finds the agents that are installed (by their config directories), adds an `agentweb` MCP
// server entry to each one's config, and writes a small launcher at ~/.agentweb/bin/agentweb for
// agents without MCP. When it was started from a throw-away place (the npx cache), it first copies
// itself to ~/.agentweb/app so the registered path keeps working.
//
// Config files belong to the user: a file is only touched when it parses, every other key is kept,
// a backup is written before the first change, and running setup twice changes nothing.

import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';

export interface SetupOptions {
  home?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** the script that is running (dist/agentweb.mjs or src/cli.ts) */
  entry?: string;
  /** the node binary to register */
  node?: string;
  /** only these agents (ids or 'all'); default: every agent found on the machine */
  agents?: string[];
  dryRun?: boolean;
  remove?: boolean;
  /** use an agent's own command line to register when it has one (off in tests) */
  useCli?: boolean;
  /** extra environment variables to put into the server entry */
  serverEnv?: Record<string, string>;
}

export interface SetupChange {
  agent: string;
  name: string;
  file: string;
  action: 'added' | 'updated' | 'unchanged' | 'removed' | 'absent' | 'skipped';
  note?: string;
}

export interface SetupResult {
  entry: string;
  command: string[];
  launcher: string;
  changes: SetupChange[];
  text: string;
}

interface Target {
  id: string;
  name: string;
  /** directory whose presence means the agent is installed */
  detect: string[];
  file: string;
  kind: 'json' | 'toml';
  /** path of the object that holds servers, e.g. ['mcpServers'] */
  key?: string[];
  entry?: (cmd: string[], env?: Record<string, string>) => unknown;
  cli?: (cmd: string[], remove: boolean) => string[] | undefined;
  /** what the user has to do for the change to take effect */
  reload: string;
}

const SERVER = 'agentweb';

function targets(home: string, platform: NodeJS.Platform, env: Record<string, string | undefined>): Target[] {
  const appData = platform === 'darwin' ? join(home, 'Library', 'Application Support') : platform === 'win32' ? env.APPDATA ?? join(home, 'AppData', 'Roaming') : env.XDG_CONFIG_HOME ?? join(home, '.config');
  const xdg = platform === 'win32' ? join(home, '.config') : env.XDG_CONFIG_HOME ?? join(home, '.config');
  const std = (cmd: string[], e?: Record<string, string>) => ({ command: cmd[0], args: cmd.slice(1), ...(e && Object.keys(e).length ? { env: e } : {}) });
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      detect: [join(home, '.claude'), join(home, '.claude.json')],
      file: join(home, '.claude.json'),
      kind: 'json',
      key: ['mcpServers'],
      entry: (c, e) => ({ type: 'stdio', ...std(c, e) }),
      cli: (c, remove) => (remove ? ['claude', 'mcp', 'remove', '--scope', 'user', SERVER] : ['claude', 'mcp', 'add', '--scope', 'user', SERVER, '--', ...c]),
      reload: 'start a new Claude Code session (or run /mcp)',
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      detect: [join(appData, 'Claude')],
      file: join(appData, 'Claude', 'claude_desktop_config.json'),
      kind: 'json',
      key: ['mcpServers'],
      entry: std,
      reload: 'quit and reopen Claude Desktop',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      detect: [join(home, '.cursor')],
      file: join(home, '.cursor', 'mcp.json'),
      kind: 'json',
      key: ['mcpServers'],
      entry: std,
      reload: 'Cursor picks it up on its own; check Settings > MCP',
    },
    {
      id: 'codex',
      name: 'Codex',
      detect: [join(env.CODEX_HOME ?? join(home, '.codex'))],
      file: join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml'),
      kind: 'toml',
      reload: 'start a new Codex session',
    },
    {
      id: 'vscode',
      name: 'VS Code (Copilot)',
      detect: [join(appData, 'Code', 'User')],
      file: join(appData, 'Code', 'User', 'mcp.json'),
      kind: 'json',
      key: ['servers'],
      entry: (c, e) => ({ type: 'stdio', ...std(c, e) }),
      reload: 'run "MCP: List Servers" in VS Code and start agentweb',
    },
    {
      id: 'windsurf',
      name: 'Windsurf',
      detect: [join(home, '.codeium', 'windsurf')],
      file: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      kind: 'json',
      key: ['mcpServers'],
      entry: std,
      reload: 'press refresh in the Windsurf MCP panel',
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      detect: [join(home, '.gemini')],
      file: join(home, '.gemini', 'settings.json'),
      kind: 'json',
      key: ['mcpServers'],
      entry: std,
      reload: 'start a new Gemini CLI session',
    },
    {
      id: 'opencode',
      name: 'opencode',
      detect: [join(xdg, 'opencode')],
      file: join(xdg, 'opencode', 'opencode.json'),
      kind: 'json',
      key: ['mcp'],
      entry: (c, e) => ({ type: 'local', command: c, enabled: true, ...(e && Object.keys(e).length ? { environment: e } : {}) }),
      reload: 'start a new opencode session',
    },
    {
      id: 'copilot-cli',
      name: 'GitHub Copilot CLI',
      detect: [join(home, '.copilot')],
      file: join(home, '.copilot', 'mcp-config.json'),
      kind: 'json',
      key: ['mcpServers'],
      entry: (c, e) => ({ type: 'local', ...std(c, e), tools: ['*'] }),
      reload: 'start a new Copilot CLI session',
    },
  ];
}

export function agentIds(): string[] {
  return targets('/', 'linux', {}).map((t) => t.id);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function backup(file: string): void {
  const bak = file + '.agentweb-backup';
  if (existsSync(file) && !existsSync(bak)) copyFileSync(file, bak);
}

function editJson(t: Target, cmd: string[], o: SetupOptions): SetupChange {
  const base = { agent: t.id, name: t.name, file: t.file };
  let root: Record<string, any> = {};
  let had = false;
  if (existsSync(t.file)) {
    const raw = readFileSync(t.file, 'utf8');
    had = raw.trim().length > 0;
    if (had) {
      try {
        root = JSON.parse(raw);
      } catch {
        return { ...base, action: 'skipped', note: 'the file has comments or is not valid JSON, so it was left alone; add the entry by hand (see below)' };
      }
      if (!root || typeof root !== 'object' || Array.isArray(root)) return { ...base, action: 'skipped', note: 'unexpected file contents' };
    }
  }
  const keys = t.key!;
  let holder: Record<string, any> = root;
  for (const k of keys) {
    if (holder[k] === undefined) {
      if (o.remove) return { ...base, action: 'absent' };
      holder[k] = {};
    }
    if (!holder[k] || typeof holder[k] !== 'object') return { ...base, action: 'skipped', note: `"${k}" is not an object` };
    holder = holder[k];
  }
  const want = t.entry!(cmd, o.serverEnv);
  const have = holder[SERVER];
  let action: SetupChange['action'];
  if (o.remove) {
    if (have === undefined) return { ...base, action: 'absent' };
    delete holder[SERVER];
    action = 'removed';
  } else if (have !== undefined && same(have, want)) return { ...base, action: 'unchanged' };
  else {
    action = have === undefined ? 'added' : 'updated';
    holder[SERVER] = want;
  }
  if (!o.dryRun) {
    mkdirSync(dirname(t.file), { recursive: true });
    if (had) backup(t.file);
    writeFileSync(t.file, JSON.stringify(root, null, 2) + '\n');
  }
  return { ...base, action };
}

const tomlStr = (s: string) => JSON.stringify(s);

/** Codex keeps servers as [mcp_servers.<name>] tables. Only our own table is written or replaced. */
function editToml(t: Target, cmd: string[], o: SetupOptions): SetupChange {
  const base = { agent: t.id, name: t.name, file: t.file };
  const raw = existsSync(t.file) ? readFileSync(t.file, 'utf8') : '';
  const lines = raw.split('\n');
  const head = `[mcp_servers.${SERVER}]`;
  const start = lines.findIndex((l) => l.trim() === head);
  let end = start;
  if (start >= 0) {
    end = start + 1;
    // the table runs to the next table that is not one of its own sub-tables
    while (end < lines.length && !(/^\s*\[/.test(lines[end]) && !lines[end].trim().startsWith(`[mcp_servers.${SERVER}.`))) end++;
  }
  const block = [head, `command = ${tomlStr(cmd[0])}`, `args = [${cmd.slice(1).map(tomlStr).join(', ')}]`];
  const envPairs = Object.entries(o.serverEnv ?? {});
  if (envPairs.length) block.push(`env = { ${envPairs.map(([k, v]) => `${k} = ${tomlStr(v)}`).join(', ')} }`);
  let action: SetupChange['action'];
  let next: string[];
  if (o.remove) {
    if (start < 0) return { ...base, action: 'absent' };
    next = [...lines.slice(0, start), ...lines.slice(end)];
    action = 'removed';
  } else if (start >= 0) {
    const cur = lines.slice(start, end).map((l) => l.trim()).filter(Boolean);
    if (same(cur, block)) return { ...base, action: 'unchanged' };
    next = [...lines.slice(0, start), ...block, '', ...lines.slice(end)];
    action = 'updated';
  } else {
    const body = raw.replace(/\s+$/, '');
    next = [...(body ? [body, ''] : []), ...block, ''];
    action = 'added';
  }
  if (!o.dryRun) {
    mkdirSync(dirname(t.file), { recursive: true });
    if (raw) backup(t.file);
    writeFileSync(t.file, next.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '\n'));
  }
  return { ...base, action };
}

function packageRoot(entry: string): string | undefined {
  let d = dirname(entry);
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'package.json'))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return undefined;
}

/** Started from the npx cache or a temp directory: that path will not be there tomorrow. */
function ephemeral(entry: string): boolean {
  const p = entry.split(sep).join('/');
  const tmp = realSafe(tmpdir()).split(sep).join('/');
  return /\/_npx\//.test(p) || /\/npm-cache\/|\/\.npm\/_cacache\//.test(p) || p.startsWith(tmp + '/');
}

function realSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Copy the running package (and the packages installed beside it) to ~/.agentweb/app. Returns the new entry. */
function settle(entry: string, appDir: string, dryRun: boolean): string {
  const root = packageRoot(entry);
  if (!root) return entry;
  const rel = entry.slice(root.length + 1);
  const parent = dirname(root);
  const dest = join(appDir, 'node_modules', basename(root));
  if (dryRun) return join(dest, rel);
  rmSync(appDir, { recursive: true, force: true });
  mkdirSync(join(appDir, 'node_modules'), { recursive: true });
  if (basename(parent) === 'node_modules') {
    // our dependencies were installed next to us: take the whole directory
    cpSync(parent, join(appDir, 'node_modules'), { recursive: true, dereference: true });
  } else {
    cpSync(root, dest, { recursive: true, dereference: true, filter: (src) => !/[\\/](\.git|bench|test)([\\/]|$)/.test(src.slice(root.length)) });
  }
  return join(dest, rel);
}

function writeLauncher(home: string, platform: NodeJS.Platform, cmd: string[], dryRun: boolean): string {
  const bin = join(home, '.agentweb', 'bin');
  const file = join(bin, platform === 'win32' ? 'agentweb.cmd' : 'agentweb');
  if (dryRun) return file;
  mkdirSync(bin, { recursive: true });
  if (platform === 'win32') writeFileSync(file, `@echo off\r\n"${cmd[0]}" "${cmd[1]}" %*\r\n`);
  else {
    writeFileSync(file, `#!/bin/sh\nexec "${cmd[0]}" "${cmd[1]}" "$@"\n`);
    chmodSync(file, 0o755);
  }
  return file;
}

export function setup(o: SetupOptions = {}): SetupResult {
  const home = o.home ?? homedir();
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const node = o.node ?? process.execPath;
  let entry = realSafe(o.entry ?? process.argv[1] ?? '');
  const notes: string[] = [];
  if (!o.remove && entry && ephemeral(entry)) {
    entry = settle(entry, join(home, '.agentweb', 'app'), !!o.dryRun);
    notes.push(`copied to ${dirname(dirname(entry))} so it stays installed`);
  }
  // a TypeScript entry (a source checkout that was not built) runs as is on current Node
  const command = [node, entry, 'mcp'];
  const launcher = o.remove ? '' : writeLauncher(home, platform, command, !!o.dryRun);

  const all = targets(home, platform, env);
  const asked = (o.agents ?? []).map((a) => a.toLowerCase()).filter(Boolean);
  const everything = asked.includes('all');
  const unknown = asked.filter((a) => a !== 'all' && !all.some((t) => t.id === a));
  const chosen = all.filter((t) => (asked.length && !everything ? asked.includes(t.id) : everything || t.detect.some((d) => existsSync(d))));
  const changes: SetupChange[] = [];
  for (const t of chosen) {
    let change: SetupChange | undefined;
    const viaCli = o.useCli !== false && !o.dryRun && t.cli?.(command, !!o.remove);
    if (viaCli) {
      // the agent's own command knows where its config lives and does not race with a running copy
      if (!o.remove) spawnSync(viaCli[0], ['mcp', 'remove', '--scope', 'user', SERVER], { stdio: 'ignore', timeout: 20_000 });
      const r = spawnSync(viaCli[0], viaCli.slice(1), { stdio: 'ignore', timeout: 20_000 });
      if (!r.error && r.status === 0) change = { agent: t.id, name: t.name, file: `${viaCli[0]} mcp`, action: o.remove ? 'removed' : 'added' };
    }
    try {
      change ??= t.kind === 'toml' ? editToml(t, command, o) : editJson(t, command, o);
    } catch (e) {
      change = { agent: t.id, name: t.name, file: t.file, action: 'skipped', note: (e as Error).message };
    }
    changes.push(change);
  }

  const out: string[] = [];
  const verb = o.dryRun ? 'would be ' : '';
  if (o.remove) out.push('agentweb: removing the MCP server entry');
  else {
    out.push(`agentweb is installed: ${entry}`);
    for (const n of notes) out.push(`  ${n}`);
  }
  if (!changes.length) out.push('No coding agent was found on this machine' + (asked.length ? ` matching: ${asked.join(', ')}` : '') + '.');
  for (const c of changes) {
    const what = c.action === 'unchanged' ? 'already registered' : c.action === 'absent' ? 'was not registered' : c.action === 'skipped' ? 'NOT changed' : `${verb}${c.action}`;
    out.push(`  ${c.name.padEnd(20)} ${what}  (${c.file})${c.note ? `\n      ${c.note}` : ''}`);
  }
  if (unknown.length) out.push(`Unknown agent name(s): ${unknown.join(', ')}. Known: ${all.map((t) => t.id).join(', ')}`);
  if (!o.remove) {
    const done = changes.filter((c) => c.action === 'added' || c.action === 'updated');
    if (done.length) {
      out.push('', 'To start using it:');
      for (const c of done) out.push(`  ${c.name}: ${all.find((t) => t.id === c.agent)!.reload}`);
    }
    out.push(
      '',
      'Any other MCP client: add this server (stdio):',
      '  ' + JSON.stringify({ mcpServers: { [SERVER]: { command: command[0], args: command.slice(1) } } }),
      '',
      'No MCP, or before the restart: the same programs run from a shell:',
      `  ${launcher} run "open('news.ycombinator.com'); find('agent')"`,
      '',
      'Then use the `web` tool for every web task: reading pages, searching, signing in, filling forms, testing a site.',
      "Put several steps in one call, for example  open('example.com'); click('Pricing'); find('per month')",
    );
  }
  return { entry, command, launcher, changes, text: out.join('\n') };
}
