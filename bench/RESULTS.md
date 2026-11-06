# First measurements: what one "open this page" costs

Measured 2026-11-05/06 on this machine with `bench/baselines/snapshots.ts`, same 10 live URLs, same
tokenizer for every tool (o200k_base via gpt-tokenizer, a proxy for Claude's tokenizer; Claude's own
count for MCP outputs runs higher). Cell: tokens the model receives / wall seconds.

- Browser tools: navigate + snapshot, 3 s settle between the two (not counted).
- agentweb: one call, `web({run: "open('URL')"})`. `agentweb` uses the default 2000-token budget;
  `agentweb-full` raises it to 40,000 to show the whole compiled page (its times are warm: same
  page from the shared cache). agentweb rows were measured about 40 minutes after the others, so
  live pages had changed slightly.
- `[chrome]` pages: quotes-toscrape-com-js and saucedemo-com are empty without JavaScript; agentweb
  detected that and re-opened them in Chromium on its own. agent-browser-read and the fetch pipeline
  returned almost nothing for them.

| Page | agentweb | agentweb-full | playwright-mcp | chrome-devtools-mcp | agent-browser | agent-browser-i | agent-browser-read | fetch-readability |
|:--|--:|--:|--:|--:|--:|--:|--:|--:|
| news-ycombinator-com | 1,837 / 1.7s | 1,837 / 0.2s | 12,337 / 0.7s | 9,941 / 0.6s | 7,158 / 0.6s | 5,122 / 0.2s | 1,085 / 1.0s | 5,019 / 0.7s |
| en-wikipedia-org-wiki-web-browser | 1,803 / 0.3s | 6,264 / 0.1s | 37,866 / 1.1s | 34,798 / 1.5s | 19,648 / 1.2s | 7,498 / 0.7s | 9,344 / 0.4s | 12,969 / 1.1s |
| github-com-microsoft-playwright-mcp | 1,815 / 0.7s | 14,066 / 0.1s | 22,660 / 2.6s | 38,989 / 2.3s | 17,339 / 1.5s | 9,577 / 1.2s | 13,872 / 1.1s | 17,380 / 2.2s |
| developer-mozilla-org-en-us-docs-web-api | 1,156 / 0.1s | 1,156 / 0.0s | 32,837 / 2.3s | 13,318 / 2.5s | 21,448 / 2.1s | 12,385 / 1.0s | 1,400 / 1.4s | 1,194 / 0.5s |
| books-toscrape-com | 947 / 0.3s | 947 / 0.1s | 8,793 / 1.4s | 6,458 / 1.0s | 5,429 / 0.7s | 1,983 / 0.3s | 649 / 0.4s | 2,782 / 0.7s |
| quotes-toscrape-com-js | 489 / 1.2s | 489 / 0.8s | 1,198 / 0.6s | 1,288 / 0.5s | 706 / 0.5s | 98 / 0.2s | 28 / 0.4s | 37 / 0.3s |
| saucedemo-com | 66 / 1.0s | 66 / 0.9s | 336 / 0.4s | 289 / 0.5s | 225 / 0.4s | 121 / 0.1s | 1 / 0.1s | FAIL |
| docs-python-org-3-library-asyncio-html | 1,003 / 0.1s | 1,003 / 0.0s | 5,820 / 0.4s | 5,594 / 0.4s | 4,821 / 0.3s | 2,443 / 0.2s | 946 / 0.2s | 858 / 0.2s |
| arxiv-org-abs-2410-16464 | 1,388 / 0.1s | 1,385 / 0.0s | 4,383 / 0.4s | 3,301 / 0.4s | 2,454 / 0.4s | 1,327 / 0.1s | 1,184 / 0.5s | 598 / 0.2s |
| bbc-com-news | 1,540 / 0.1s | 1,778 / 0.0s | 13,407 / 1.5s | 11,146 / 4.7s | 8,867 / 4.3s | 6,442 / 2.2s | 2,294 / 0.2s | 6,160 / 1.3s |
| **median (ok runs)** | 1,272 / 0.3s | 1,271 / 0.1s | 10,565 / 0.9s | 8,200 / 0.8s | 6,294 / 0.6s | 3,783 / 0.3s | 1,135 / 0.4s | 2,782 / 0.7s |

Tool definition cost (proxy tokens, from `bench/out/baselines/tool-schemas.md`): agentweb 445 (one tool),
Chrome DevTools MCP --slim 210 (3 tools, no page snapshot tool), Playwright MCP 3,917 (25 tools),
Chrome DevTools MCP 6,216 (32 tools), agent-browser MCP 18,026 (29 tools).

Not measured yet: whole tasks end to end (turns, total tokens, success rate) with the same model and
harness. That is the next benchmark, over the local fixture web in `bench/sites`.

## First agent runs (n = 1 each, live sites, not yet a benchmark)

Same harness for every tool (`bench/baselines/run-agent.ts`): `claude -p` on Haiku 5.5, no other
tools, no user settings. "Input tokens" is everything the model read over the whole task
(tool definitions + every turn's context). All answers below were correct except where noted.

| Task | Tool | Turns | Tool calls | Input tokens | Wall |
|:--|:--|--:|--:|--:|--:|
| HN top story title | **agentweb** | 2 | 1 | **10,618** | 3.7s |
| | agent-browser | 3 | 2 | 23,844 | 6.3s |
| | Playwright MCP | 4 | 3 | 34,479 | 7.5s |
| | Chrome DevTools MCP | 3 | 2 | 46,711 | 6.3s |
| Saucedemo: log in, price of an item | **agentweb** | 2 | 1 | **10,394** | 5.3s |
| | Playwright MCP | 5 | 4 | 47,054 | 6.7s |
| | agent-browser | 3 | 2 | 27,393 | 7.2s (failed: harness denied a shell variable) |
| Books: three cheapest in Poetry | **agentweb** | 3 | 2 | **16,273** | 5.6s |
| | Playwright MCP | 4 | 3 | 35,825 | 8.5s |
| | agent-browser | 8 | 7 | 93,333 | 16.4s |

The agentweb rows are after three fixes found by reading the first agentweb transcripts: a `find()`
that misses now shows where the page starts; `records('words')` whose words match nothing shows all
items; the tool description mentions `{{secret:…}}` only when secrets are configured (the agent had
copied the example). Before those fixes the same tasks took 2, 2 and 3 calls (16.8k, 16.3k, 22.3k
input tokens): still the lowest, but those were wasted calls.

## Task benchmark on the farm (local fixture web, `node bench/run.ts`)

Haiku 5.5, `claude -p`, same harness for both tools, n = 1 per task. Each task is graded on the
answer and on the server's own record of what happened (orders, transfers, requests to the
second origin). Input tokens = everything the model read over the whole task.

**Core set (40 tasks).** agentweb was fixed twice against these tasks after reading its failing
transcripts (see the commits of 2026-11-06), so this number flatters it:

| Tool | Passed | Median tool calls | Median input tokens | Total input tokens | Median wall | Cost |
|:--|--:|--:|--:|--:|--:|--:|
| agentweb (3rd run) | 39/40 | 3 | 22,461 | 1,350,580 | 8.0s | $0.091 |
| Playwright MCP | 39/40 | 5 | 64,188 | 3,363,343 | 10.4s | $0.148 |

First run, before any fixes: agentweb 35/40 with 1,380,750 input tokens.

**Held-out set (21 tasks agentweb had never been run on):**

| Tool | Passed | Median tool calls | Median input tokens | Total input tokens | Median wall | Cost |
|:--|--:|--:|--:|--:|--:|--:|
| agentweb | 17/21 → 18/21 regraded | 2 | 15,697 | 818,462 | 5.7s | $0.048 |
| Playwright MCP | 20/21 → 21/21 regraded | 4 | 48,162 | 1,401,741 | 9.3s | $0.064 |

"Regraded": the `shop-top-rated` check failed both tools for also naming the runners-up; the check
was wrong and is fixed. agentweb's three other held-out failures were real: `near=` clicked the
previous item's button on a shadow-DOM page; `find()` could not see past the 6,000-block cap of a
5 MB page; and agentweb does not send conditional requests (ETag/304) when a page is re-opened.
The first two are fixed (commit `2f3c435`; a re-run of those tasks passed), the third is not.
Since the held-out set has now been looked at, it is no longer held out.

**Known open issue:** `records(…, pages=N)` on an infinite-scroll feed stops after the first batch
when it has to switch engines first; `scroll()` and `press('End')` work.
