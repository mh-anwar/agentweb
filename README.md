<img src="assets/icon.svg" width="64" height="64" alt="">

# agentweb

**A browser built for AI agents, not people.** One tool, a few hundred tokens per page, real
Chrome, Firefox or Safari's engine only when a page needs it. Your agent browses, signs in,
fills forms, collects data and tests your site, using 3–4x fewer tokens than Playwright MCP.

```
open('shop.example/login'); profile('alice'); search('usb hub'); click('Add to cart', near='USB-C'); expect('Cart (1)')
```

## Get started: give this to your agent

Paste this into Claude Code, Cursor, Codex or any coding agent:

```text
Install the agentweb browser for yourself and start using it for web tasks.

1. git clone https://github.com/mh-anwar/agentweb ~/agentweb
   cd ~/agentweb && npm install && npm run build
2. Check it works: node ~/agentweb/dist/agentweb.mjs doctor
3. Register it as an MCP server for yourself:
   - Claude Code: claude mcp add agentweb -- node ~/agentweb/dist/agentweb.mjs mcp
   - Other MCP clients: add {"agentweb": {"command": "node", "args": ["<home>/agentweb/dist/agentweb.mjs", "mcp"]}}
     to "mcpServers" in your MCP config.
   - No MCP? Run programs directly: node ~/agentweb/dist/agentweb.mjs run "open('example.com'); find('pricing')"
4. Try it: open news.ycombinator.com and tell me the top story.
5. From now on, use the agentweb `web` tool for any web page instead of fetching HTML or driving a browser
   by hand. Put several steps in one call. To test a web app, write *.aw files and run
   `node ~/agentweb/dist/agentweb.mjs test` (see docs/GUIDE.md, "Testing with agentweb").
```

That's it. Node 22.6+ is the only requirement; Chrome is found or used only when a page needs it.

## The numbers

All measured on the same machine, same model (Claude Haiku via `claude -p`), same harness, every tool
given only its own tools. Raw transcripts and methods are in [bench/](bench/).

**One page view** (median of 10 live pages, same tokenizer):

| | agentweb | agent-browser | Chrome DevTools MCP | Playwright MCP |
|:--|--:|--:|--:|--:|
| Tokens per page | **1.3k** | 6.3k | 8.2k | 10.6k |
| Tool definitions, paid on every turn | **0.75k** (1 tool) | 18k (29 tools) | 6.2k (32 tools) | 3.9k (25 tools) |

**Whole tasks on live sites:** [WebVoyager](https://github.com/MinorJerry/WebVoyager), the public
benchmark browser agents cite. Frozen 50-task sample across 14 sites, blind LLM judge. Run in progress
(28 of 50 tasks done, agentweb version from before the latest fixes):

| | agentweb | browser-use | Playwright MCP | agent-browser |
|:--|--:|--:|--:|--:|
| Tasks passed | 20/28 | 22/28 | 20/27 | 19/27 |
| Median input tokens per task | **56k** | 86k | 144k | 210k |
| Median tool calls | **5** | 8 | 8 | 11 |

**Repeated tasks on a local test web** (6 tasks × 3 runs, 54 trials):

| | agentweb | Playwright MCP | agent-browser |
|:--|--:|--:|--:|
| Passed | 18/18 | 18/18 | 16/18 |
| Total input tokens | **633k** | 2.51M | 3.35M |

**A failing end-to-end test, as the agent reads it:** agentweb 81 tokens, Playwright 279 tokens plus
a 9k-token error file it points the agent to ([details](docs/research/TESTING.md)).

## What it does

- **Browse cheaply.** Pages come back as compact text with numbered controls (`[Sign in]12`,
  `{Email}13`). Repeat views show only what changed. `find('words')` returns matching lines instead
  of the whole page.
- **Get fast where it can.** Most pages load over plain HTTP in under a second. A JavaScript engine
  without pixels comes next, then real Chrome, switching on its own when a page needs it.
- **Act.** Click, fill, select, upload, drag, press keys, answer dialogs, download files, run
  JavaScript, read the console and network log, emulate a phone, take screenshots and PDFs.
- **Sign in once.** `profile('instructor')` loads a saved sign-in (a Playwright `storageState` file),
  so the agent skips login flows. `profile('x', save=1)` saves the current one.
- **Collect data.** `records('price', pages=3)` and `collect(...)` return structured rows across
  pages, with coverage receipts so a partial answer is never passed off as complete.
- **Test your app.** `agentweb test` runs `*.aw` test files with no model in the loop. Assertions
  wait for late content, and failures are reported in a few lines.
- **Any browser.** Chrome by default; `engine('firefox')` or `engine('safari')` (WebKit) when you need it.
- **Guarded.** Secrets the model never sees, SSRF protection, cross-site data-flow checks,
  confirmation before purchases and transfers, and prompt-injection lines flagged with ⚠.
- **Scales.** A session is a small JSON record, not a browser process. Serve many agents over MCP
  or HTTP with a shared store (`agentweb serve`).

## Learn more

- [docs/GUIDE.md](docs/GUIDE.md): full reference (language, testing, configuration, serving many agents)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works
- [docs/research/PARITY.md](docs/research/PARITY.md): feature-by-feature comparison with Playwright MCP, agent-browser, Chrome DevTools MCP, browser-use and Stagehand
- [bench/](bench/): benchmarks, raw results and how to reproduce them
