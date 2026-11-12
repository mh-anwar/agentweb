import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from '../src/setup.ts';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'aw-setup-'));
}
const base = (h: string) => ({ home: h, platform: 'linux' as const, env: {}, entry: '/opt/agentweb/dist/agentweb.mjs', node: '/usr/bin/node', useCli: false });

test('setup registers with the agents that are installed and leaves the rest alone', () => {
  const h = home();
  mkdirSync(join(h, '.cursor'));
  mkdirSync(join(h, '.codex'));
  writeFileSync(join(h, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } }, keep: 1 }));
  writeFileSync(join(h, '.codex', 'config.toml'), 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n');
  const r = setup(base(h));
  assert.deepEqual(r.changes.map((c) => [c.agent, c.action]), [['cursor', 'added'], ['codex', 'added']]);
  const cur = JSON.parse(readFileSync(join(h, '.cursor', 'mcp.json'), 'utf8'));
  assert.deepEqual(cur.mcpServers.agentweb, { command: '/usr/bin/node', args: ['/opt/agentweb/dist/agentweb.mjs', 'mcp'] });
  assert.equal(cur.mcpServers.other.command, 'x');
  assert.equal(cur.keep, 1);
  const toml = readFileSync(join(h, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /model = "gpt"/);
  assert.match(toml, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.match(toml, /\[mcp_servers\.agentweb\]\ncommand = "\/usr\/bin\/node"\nargs = \["\/opt\/agentweb\/dist\/agentweb\.mjs", "mcp"\]/);
  assert.ok(existsSync(join(h, '.cursor', 'mcp.json.agentweb-backup')));
  assert.ok(!existsSync(join(h, '.gemini')), 'agents that are not installed get no files');
  assert.match(readFileSync(join(h, '.agentweb', 'bin', 'agentweb'), 'utf8'), /exec "\/usr\/bin\/node" "\/opt\/agentweb\/dist\/agentweb\.mjs" "\$@"/);
  assert.match(r.text, /Cursor\s+added/);
});

test('setup is idempotent, updates a changed path, and removes only its own entry', () => {
  const h = home();
  mkdirSync(join(h, '.cursor'));
  mkdirSync(join(h, '.codex'));
  mkdirSync(join(h, '.gemini'));
  writeFileSync(join(h, '.codex', 'config.toml'), '[mcp_servers.agentweb]\ncommand = "old"\nargs = ["mcp"]\n\n[mcp_servers.agentweb.env]\nA = "1"\n\n[other]\nx = 1\n');
  setup(base(h));
  const again = setup(base(h));
  assert.ok(again.changes.every((c) => c.action === 'unchanged'), JSON.stringify(again.changes));
  const toml = readFileSync(join(h, '.codex', 'config.toml'), 'utf8');
  assert.ok(!toml.includes('"old"') && !toml.includes('A = "1"'));
  assert.match(toml, /\[other\]\nx = 1/);
  const moved = setup({ ...base(h), entry: '/new/agentweb.mjs' });
  assert.ok(moved.changes.every((c) => c.action === 'updated'));
  const gone = setup({ ...base(h), remove: true });
  assert.ok(gone.changes.every((c) => c.action === 'removed'));
  assert.deepEqual(JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8')).mcpServers, {});
  assert.ok(!readFileSync(join(h, '.codex', 'config.toml'), 'utf8').includes('agentweb'));
});

test('setup never rewrites a config it cannot parse; --agent picks agents; dry run writes nothing', () => {
  const h = home();
  mkdirSync(join(h, '.cursor'));
  const jsonc = '{\n  // my servers\n  "mcpServers": {}\n}\n';
  writeFileSync(join(h, '.cursor', 'mcp.json'), jsonc);
  const r = setup(base(h));
  assert.equal(r.changes[0].action, 'skipped');
  assert.equal(readFileSync(join(h, '.cursor', 'mcp.json'), 'utf8'), jsonc);
  const dry = setup({ ...base(h), agents: ['vscode', 'opencode', 'nope'], dryRun: true });
  assert.deepEqual(dry.changes.map((c) => [c.agent, c.action]), [['vscode', 'added'], ['opencode', 'added']]);
  assert.ok(!existsSync(join(h, '.config')));
  assert.match(dry.text, /Unknown agent name\(s\): nope/);
  const wet = setup({ ...base(h), agents: ['vscode', 'opencode'] });
  assert.equal(wet.changes.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(h, '.config', 'Code', 'User', 'mcp.json'), 'utf8')).servers.agentweb.type, 'stdio');
  assert.deepEqual(JSON.parse(readFileSync(join(h, '.config', 'opencode', 'opencode.json'), 'utf8')).mcp.agentweb.command, ['/usr/bin/node', '/opt/agentweb/dist/agentweb.mjs', 'mcp']);
});

test('setup started from the npx cache copies itself somewhere permanent', () => {
  const h = home();
  const cache = join(h, '.npm', '_npx', 'abc', 'node_modules');
  mkdirSync(join(cache, 'agentweb', 'dist'), { recursive: true });
  mkdirSync(join(cache, 'jsdom'), { recursive: true });
  writeFileSync(join(cache, 'agentweb', 'package.json'), '{"name":"agentweb"}');
  writeFileSync(join(cache, 'agentweb', 'dist', 'agentweb.mjs'), '// bundle');
  writeFileSync(join(cache, 'jsdom', 'index.js'), '');
  mkdirSync(join(h, '.gemini'));
  const r = setup({ ...base(h), entry: join(cache, 'agentweb', 'dist', 'agentweb.mjs') });
  const app = join(h, '.agentweb', 'app', 'node_modules');
  assert.equal(r.entry, join(app, 'agentweb', 'dist', 'agentweb.mjs'));
  assert.ok(existsSync(r.entry) && existsSync(join(app, 'jsdom', 'index.js')));
  assert.equal(JSON.parse(readFileSync(join(h, '.gemini', 'settings.json'), 'utf8')).mcpServers.agentweb.args[0], r.entry);
});
