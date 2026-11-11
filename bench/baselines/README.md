# bench/baselines: other agent browsers, measured the same way

This directory installs the existing agent-browser tools and wraps them, so agentweb can be
compared with them using the same method. It has its own `package.json` (`npm install` here, never
in the repo root). Outputs go to `bench/out/baselines/`, which is git-ignored.

```bash
cd bench/baselines && npm install
node tools.ts                       # regenerate mcp-configs/*.json (absolute paths for this machine)
node schemas.ts [--claude]          # tool-definition sizes → out/tool-schemas.{json,md}
node snapshots.ts [--urls f] [--tools a,b] [--out d] [--settle 3000]   # → out/snapshots.{json,md}
node run-agent.ts <tool> "<prompt>" [model] [maxTurns]                 # one headless agent run
node smoke.ts all|<id…>             # the six smoke runs → out/smoke/
```

| File | What it is |
|---|---|
| `mcp-client.ts` | Minimal MCP stdio client on Node built-ins: `McpClient` (`start`, `listTools`, `callTool`, `close`) and `withMcp`. Answers `ping` and `roots/list` the way a normal client does, kills the server's whole process group on close. |
| `tools.ts` | The one place that says how each tool is launched here: `MCP_VARIANTS`, `CLI_TOOLS`, `VERSIONS`, `writeMcpConfigs()`. |
| `measure.ts` | `tokens()` (o200k proxy), `bytes()`, image size and token estimate, markdown tables. |
| `schemas.ts` | `tools/list` for every MCP server, plus each CLI tool's skill text. With `--claude` it also measures the real Claude input-token cost of loading each tool. |
| `snapshots.ts` | `runSnapshots()`: the text each tool returns for "open URL" (+ "snapshot"), saved raw. |
| `run-agent.ts` | `runAgentTask({tool, prompt, model, maxTurns, timeoutMs, cwd})` and `parseStream()`. |
| `smoke.ts` | The six smoke runs. |
| `mcp-configs/` | `--mcp-config` files for each MCP tool, and one for agentweb (`node src/cli.ts mcp`, not run yet). |

## Versions (comparison tools refreshed 2026-11-11)

| Tool | npm package | Version | Engine |
|---|---|---|---|
| Playwright MCP | `@playwright/mcp` | 0.0.85 | playwright-core 1.65.0-alpha-2026-10-30 |
| Chrome DevTools MCP | `chrome-devtools-mcp` | 1.12.0 | puppeteer |
| agent-browser (Vercel) | `agent-browser` | 0.42.0 | native Rust binary over CDP |
| Playwright CLI | `@playwright/cli` | 0.1.23 | playwright-core 1.65.0-alpha-2026-10-30 |
| fetch baseline | `@mozilla/readability` 0.6.0, `turndown` 7.2.5, `jsdom` 31.0.0 | | Node 24 `fetch` |
| Browser (all tools) | Chromium 156.0.8078.4 (`~/.cache/ms-playwright/chromium-1248`) | | |
| Agent | Claude Code 2.1.318, model alias `haiku` = `claude-haiku-5-5` | | |

`playwright-cli` on npm is a deprecated alias; the real package is `@playwright/cli`.

## Launch commands (exactly what the configs run)

- **Playwright MCP**: `node node_modules/@playwright/mcp/cli.js --headless --isolated --no-sandbox --executable-path $CHROME`.
  Vision mode adds `--caps vision`.
- **Chrome DevTools MCP**: `node node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js --headless --isolated --executablePath $CHROME --chromeArg=--no-sandbox`,
  with env `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`. `--slim` is the documented 3-tool mode.
- **agent-browser**: the native binary `node_modules/agent-browser/bin/agent-browser-linux-x64`, with env
  `AGENT_BROWSER_EXECUTABLE_PATH=$CHROME AGENT_BROWSER_ARGS=--no-sandbox`. Each run gets its own `--session`.
  `agent-browser mcp` is its MCP server, measured for schema size only.
- **Playwright CLI**: `node node_modules/@playwright/cli/playwright-cli.js …` with
  `.playwright/cli.config.json` in the working directory:
  `{"browser":{"browserName":"chromium","launchOptions":{"executablePath":$CHROME,"chromiumSandbox":false}}}`.
- **browser-use** (not wrapped): `uvx --from browser-use browser-use` installs in seconds
  (browser-use 0.13.14, which ships the browser-harness 0.1.13 CLI). Its interface is Python
  snippets piped to a daemon that attaches to a running Chrome over CDP (`BU_CDP_URL`), so there is
  no single "snapshot" call to measure. Wrapping it for agent runs is possible: launch Chromium
  with `--remote-debugging-port`, set `BU_CDP_URL`, and limit Bash to `browser-use`. Not done yet.

## Quirks of this machine, and what each tool needed

- Chromium must run with `--no-sandbox`: AppArmor restricts unprivileged user namespaces. Every tool gets it.
- The Playwright packages expect chromium-1252 (157), but 1248 (156) is installed. Every tool is pointed
  at 1248 with its executable-path option, so all tools use the same browser. Playwright MCP's
  default `--browser chrome` would look for Google Chrome, which is not installed.
- agent-browser: npm 11 blocks its postinstall script. That doesn't matter: the package ships every
  platform binary, and the binary only needs `chmod +x` (done by npm). After launching Chromium 156
  it prints an outdated-Chrome warning to stderr (~70 tokens), which a Bash-tool agent sees once.
  `agent-browser read` starts a session daemon (with a browser) even for HTTP-only reads, and
  leaves it running for an hour unless closed. The scripts close every session they open.
- Playwright CLI checks npm for updates on `open`. `NO_UPDATE_NOTIFIER=1` turns that off.
- Chrome DevTools MCP sends Google usage statistics unless `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS` is set.

## How the measurements are made

**Tool schemas.** Each tool definition is measured as `JSON.stringify({name, description, input_schema})`,
which is what an MCP client hands the model. Tokens are o200k_base (`gpt-tokenizer`), labelled as a
proxy for Claude's tokenizer. `--claude` also runs `claude -p "Reply with the single word ok"` with
the tool loaded and subtracts the same call with no tools. That gives real Claude tokens, including
Claude Code's own per-tool wrapping. For MCP tools it comes out about 1.9× the proxy.

**Snapshots.** Each tool keeps one browser session for the whole run. URLs are processed in order,
and every tool visits a URL back to back, so live pages change as little as possible between tools.
Each mode records exactly the text the call returns: MCP text content, or CLI stdout+stderr as a
Bash tool shows them. Images are recorded with dimensions, bytes and `w×h/750` (an estimate).
Two-call modes wait `--settle` ms (default 3000, the same for every tool, not counted in the time)
between navigation and snapshot. Without that wait, pages that keep loading after `load` (MDN, BBC)
favoured whichever tool snapshotted first, by up to 4×.
- Playwright MCP 0.0.84 writes the snapshot it takes after an action to a file
  (`.playwright-mcp/page-*.yml`) and returns only a link. Only an explicit `browser_snapshot`
  returns the tree inline. So its mode is navigate + snapshot.
- Chrome DevTools MCP needs a `pageId`, which comes from `list_pages` during warm-up.
- `agent-browser-i` does its own `open` of the URL, so its navigation time benefits from a warm
  HTTP cache.
- These are raw tool outputs. A client may truncate very large results before the model sees them;
  Claude Code does this for long Bash output and large MCP results.

**Agent runs.** `claude -p` runs in a fresh empty temp directory with
`--setting-sources project --strict-mcp-config --no-session-persistence --permission-mode dontAsk --output-format stream-json --verbose`.
- MCP tools: `--tools ""` (no built-in tools at all, which also means no ToolSearch, so MCP schemas are
  never deferred) and `--allowedTools mcp__<server>`.
- CLI tools: `--tools Bash,Read`, `--allowedTools "Bash(<cli>:*)" Read`. The tool's skill directory
  is copied to `.claude/skills/<name>/`, where its installer would put it. Its SKILL.md body goes
  into `--append-system-prompt`, with one sentence stating which shell commands are permitted.
  The Skill tool is not used, because it would also list Claude Code's bundled skills (~3k extra tokens, measured).
  agent-browser's skill is the official stub, which tells the agent to run `agent-browser skills get core`.
- Without these flags, the user's CLAUDE.md, plugins and claude.ai connectors add about 34k input tokens per call.
- Parsed from the stream: turns (`num_turns`), tool calls, characters and proxy tokens of every tool
  result, agent-loop usage (`result.usage`), all-call usage (`result.modelUsage`), cost
  (`total_cost_usd`, list prices, covering all calls) and permission denials.

`claude -p --output-format json` fields seen (2.1.318): `total_cost_usd`, `duration_ms`, `duration_api_ms`, `num_turns`,
`usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation.{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}, iterations[], server_tool_use, service_tier}`,
`modelUsage.<model>.{inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, thinkingTokens, costUSD, contextWindow, costBasis}`,
`permission_denials`, `terminal_reason`, `ttft_ms`, `is_error`, `subtype`, `result`. A saved sample is at `bench/out/baselines/claude-json-probe.json`.

## Repeated trials and launcher checks (2026-11-11)

`bench/run.ts --repeats 3` rotates tool order per repetition and gives every transcript a distinct
repeat suffix. Results record actual model identifiers, errors and permission-denial counts.
The run manifest pins source revision/diff, package versions, actual native CLI version and browser
version. Resuming with a different manifest fails; select a new output directory.

The native agent-browser binary must be executable. Some installs with scripts disabled leave it
without execute permission; fix the mode before running. The harness now fails visibly instead
of letting a non-executable PATH symlink fall through to an older global binary. Its launcher
namespaces explicit sessions per run and closes every session it creates, including names chosen
by the model. This prevents test browsers from accumulating and contaminating later runs.

The first batch at `bench/out/hill-866acf0` is invalid: agent-browser commands fell through to the
older global binary while the recorded package version said 0.42.0. Do not use it for comparisons.

`node bench/summarize.ts <results.jsonl> <directory>` compares only matched task/repeat cells.
`node bench/regrade-five.ts <run-directory> <new-results.jsonl>` preserves raw evidence while
correcting the inspected five-product-list grader for all tools. That correction accepts a
runner-up mentioned in explanatory prose, while rejecting a sixth recommended list item.
The regrader is scoped to the original seed-7 farm and records its input and grader hashes.

These trials use a constrained CLI harness: shell assignments and arbitrary helper programs are
denied. Keep permission-denial counts visible; failures influenced by this harness are not clean
estimates of the CLI's unrestricted capability. No result on the inspected farm is held out.
