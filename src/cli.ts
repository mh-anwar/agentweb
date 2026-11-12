#!/usr/bin/env node
// agentweb command line.
//
//   agentweb                 MCP server on stdio (what an agent harness launches)
//   agentweb run "<program>" run one program and print the result (sessions persist between calls)
//   agentweb test [paths]    run *.aw end-to-end tests; failures in a few lines
//   agentweb serve           MCP over HTTP + REST, for many agents
//   agentweb tool            print the tool definition (mcp | openai | anthropic)
//   agentweb doctor          what works on this machine
//   agentweb report "<site> | <task> | <why>"   log that an agent gave up on agentweb (needs AGENTWEB_USAGE_LOG)
//   agentweb usage [--days N] summary of the usage log

import { createAgentweb, type AgentwebConfig } from './index.ts';
import { TOOL } from './tooldoc.ts';
import { attachUsageLog, summary, usagePath, writeReport } from './usage.ts';

const VERSION = '0.1.0';

interface Flags {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Flags {
  const f: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      f._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) f[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) f[a.slice(2)] = argv[++i];
      else f[a.slice(2)] = true;
    } else if (a.length === 2 && a[0] === '-') {
      const k = { s: 'session', b: 'budget', p: 'port', h: 'help', v: 'version' }[a[1]] ?? a[1];
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && k !== 'help' && k !== 'version') f[k] = argv[++i];
      else f[k] = true;
    } else f._.push(a);
  }
  return f;
}

const HELP = `agentweb ${VERSION} - a browser for agents

  agentweb setup                 register agentweb with every coding agent on this machine (Claude Code, Codex,
                                 Cursor, VS Code, Windsurf, Gemini CLI, opencode, Copilot CLI, Claude Desktop)
        --agent NAME[,NAME]      only these (or "all")     --dry-run     --remove
  agentweb [mcp]                 MCP server on stdio
  agentweb run "<program>"       run a program, print the result
        -s, --session NAME       session to use (default "cli"; sessions persist in ~/.agentweb)
        -b, --budget N           max tokens of output (default 2000)
        --json                   print the full result as JSON
  agentweb serve                 MCP (Streamable HTTP) at /mcp and REST at /v1/run
        -p, --port N             default 4455        --host H   default 127.0.0.1
        --workers N              processes (default 1)
        --keys k1=tenant1,k2=…   bearer API keys (also AGENTWEB_KEYS)
  agentweb test [paths] [--base URL] [--json] [--update] [--record out.aw "program"]   end-to-end tests (agentweb test --help)
  agentweb extension             where the browser extension is and how to load it (lets agents use your own Chrome)
  agentweb bridge                run the extension bridge by itself and show who is connected
  agentweb tool [--format mcp|openai|anthropic]
  agentweb doctor
  agentweb report "<site> | <task> | <what went wrong>"   report a bug or a page agentweb could not handle
  agentweb usage [--days N]      summary of the usage log (AGENTWEB_USAGE_LOG)

  Common options: --store URL (memory: | file:/dir | sqlite:/file | redis://host)  --no-chrome  --no-ghost  --no-cache
                  --browser chrome|firefox|webkit   the real browser pages escalate to (also AGENTWEB_BROWSER)

  Program example:  agentweb run "open('news.ycombinator.com'); find('rust')"
`;

function config(f: Flags): AgentwebConfig {
  const c: AgentwebConfig = {};
  if (typeof f.store === 'string') c.store = f.store;
  if (f['no-chrome']) c.chrome = false;
  if (f['no-ghost']) c.ghost = false;
  if (f['no-cache']) c.cache = false;
  if (typeof f.cdp === 'string') c.cdp = f.cdp;
  if (typeof f.budget === 'string') c.budget = Number(f.budget);
  if (typeof f.browser === 'string') {
    const b = f.browser.toLowerCase() === 'safari' ? 'webkit' : f.browser.toLowerCase();
    if (b === 'chrome' || b === 'firefox' || b === 'webkit') c.browser = b;
  }
  return c;
}

async function main() {
  const argv = process.argv.slice(2);
  const f = parseArgs(argv);
  const cmd = f._[0] ?? (process.stdin.isTTY ? 'help' : 'mcp');
  if (cmd === 'test') {
    const { testCommand } = await import('./test/cli.ts');
    process.exitCode = await testCommand(argv.slice(argv.indexOf('test') + 1));
    return;
  }

  if (f.version || cmd === 'version') return void console.log(VERSION);
  if (f.help || cmd === 'help') return void console.log(HELP);

  if (cmd === 'setup' || cmd === 'install' || cmd === 'uninstall') {
    const { setup } = await import('./setup.ts');
    const agents = typeof f.agent === 'string' ? f.agent.split(',') : typeof f.agents === 'string' ? f.agents.split(',') : undefined;
    const r = setup({ agents, dryRun: !!f['dry-run'], remove: cmd === 'uninstall' || !!f.remove });
    return void console.log(r.text);
  }

  if (cmd === 'extension') {
    const { extensionDir, EXTENSION_HELP } = await import('./setup.ts');
    const dir = extensionDir();
    return void console.log(dir ? EXTENSION_HELP(dir) : 'agentweb: the extension folder is missing from this install');
  }

  if (cmd === 'bridge') {
    const { bridgeEndpoint, ownHub } = await import('./bridge/hub.ts');
    await bridgeEndpoint();
    const hub = await ownHub();
    if (!hub) return void console.log('agentweb: a bridge is already running on this machine (another agentweb process owns it)');
    console.error(`agentweb bridge listening on 127.0.0.1:${hub.port}; waiting for the browser extension (Ctrl-C to stop)`);
    let last = '';
    const tick = setInterval(() => {
      const st = hub.status();
      const line = st.extension ? `extension connected (${st.browser}); ${st.clients} agent process(es), ${st.tabs.length} tab(s) in use, ${st.offered.length} shared by the user` : 'extension not connected';
      if (line !== last) console.error((last = line));
    }, 1000);
    const stop = async () => {
      clearInterval(tick);
      await hub.close().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (cmd === 'tool') {
    const fmt = typeof f.format === 'string' ? f.format : 'mcp';
    const out =
      fmt === 'openai'
        ? { type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.inputSchema } }
        : fmt === 'anthropic'
          ? { name: TOOL.name, description: TOOL.description, input_schema: TOOL.inputSchema }
          : TOOL;
    return void console.log(JSON.stringify(out, null, 2));
  }

  if (cmd === 'report' || cmd === 'usage') {
    // reports need no setup: without a usage log they go to ~/.agentweb/reports.jsonl
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const p = usagePath() ?? (cmd === 'report' ? join(process.env.AGENTWEB_HOME ?? join(homedir(), '.agentweb'), 'usage.jsonl') : undefined);
    if (!p) {
      console.error('agentweb: set AGENTWEB_USAGE_LOG=<file> to keep a usage log');
      process.exitCode = 2;
      return;
    }
    if (cmd === 'usage') return void console.log(summary(p, typeof f.days === 'string' ? Number(f.days) || 7 : 7));
    const text = f._.slice(1).join(' ').trim();
    if (!text) {
      console.error('usage: agentweb report "<site> | <what you were doing> | <what went wrong>"');
      process.exitCode = 2;
      return;
    }
    writeReport(p, text);
    const { reportsPath } = await import('./usage.ts');
    console.log(`reported (${reportsPath(p)})`);
    console.log('To reach the maintainers too: gh issue create -R mh-anwar/agentweb --title "<site>: <problem>" --body "<the same line, no secrets or personal data>"');
    return;
  }

  if (cmd === 'run') {
    const program = f._.slice(1).join(' ') || (process.stdin.isTTY ? '' : await readStdin());
    if (!program.trim()) {
      console.error('usage: agentweb run "<program>"');
      process.exitCode = 2;
      return;
    }
    const rt = await createAgentweb(config(f));
    attachUsageLog(rt);
    try {
      const r = await rt.run(typeof f.session === 'string' ? f.session : 'cli', program, { budget: typeof f.budget === 'string' ? Number(f.budget) : undefined });
      if (f.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(r.text);
        if (r.images?.length) console.error(`(${r.images.length} image(s) omitted; use --json)`);
        if (f.stats) console.error(`[${r.stats.steps} steps, ${r.stats.fetches} fetches, ${r.stats.ms} ms, ~${r.stats.tokens} tokens, ${r.stats.tier ?? '-'}]`);
      }
      if (!r.ok) process.exitCode = 1;
    } finally {
      await rt.close();
    }
    return;
  }

  if (cmd === 'mcp') {
    const { serveStdio } = await import('./server/index.ts');
    const rt = await createAgentweb(config(f));
    attachUsageLog(rt);
    const server = serveStdio(rt, { stdin: process.stdin, stdout: process.stdout });
    const done = (server as { closed?: Promise<void> }).closed;
    const stop = async () => {
      await rt.close().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    if (done) await done.then(stop);
    return;
  }

  if (cmd === 'serve') {
    const { createHttpServer } = await import('./server/index.ts');
    const rt = await createAgentweb(config(f));
    const keysArg = typeof f.keys === 'string' ? f.keys : process.env.AGENTWEB_KEYS;
    const keys = keysArg ? Object.fromEntries(keysArg.split(',').map((kv) => kv.split('=').map((x) => x.trim()) as [string, string])) : undefined;
    const port = Number(f.port ?? process.env.PORT ?? 4455);
    const host = typeof f.host === 'string' ? f.host : '127.0.0.1';
    const server = createHttpServer(rt, { keys, secret: process.env.AGENTWEB_SECRET, workers: f.workers ? Number(f.workers) : undefined } as never);
    const { url } = await server.listen(port, host);
    console.error(`agentweb listening on ${url}  (MCP: ${url}/mcp  REST: ${url}/v1/run  metrics: ${url}/metrics)`);
    const stop = async () => {
      await server.close().catch(() => {});
      await rt.close().catch(() => {});
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    return;
  }

  if (cmd === 'doctor') {
    const rt = await createAgentweb(config(f));
    const lines: string[] = [`agentweb ${VERSION} on node ${process.version}`];
    for (const t of ['wire', 'ghost', 'chrome', 'firefox', 'webkit'] as const) lines.push(`${t.padEnd(7)} ${(await rt.available(t)) ? 'available' : 'not available'}${t === rt.ladder[2] ? ' (browser tier)' : ''}`);
    const r = await rt.run('doctor', "open('https://example.com')").catch((e) => ({ ok: false, text: String(e) }));
    lines.push(`network ${r.ok ? 'ok' : 'failed: ' + r.text.split('\n')[0]}`);
    console.log(lines.join('\n'));
    await rt.close();
    return;
  }

  console.error(`unknown command '${cmd}'\n\n${HELP}`);
  process.exitCode = 2;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (s += c));
    process.stdin.on('end', () => resolve(s));
  });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
