# Public benchmark: WebVoyager on the live web

The farm benchmark (`bench/run.ts`) grades against ground truth we control. This harness runs the
same tools on tasks someone else wrote, on real sites, so the numbers can be checked against
published work. Pass/fail comes from an LLM judge, not an exact check; read it as an estimate.

## Attribution

Tasks and reference answers are from **WebVoyager** (He et al., 2024),
<https://github.com/MinorJerry/WebVoyager>, `data/WebVoyager_data.jsonl` and
`data/reference_answer.json`, commit `5a7896738c10bfb8b9edccce6bb0e0411f8ae569`. The repository is
licensed **Apache-2.0** (checked through the GitHub license API); the license text is in
`data/LICENSE-WebVoyager.txt`. The files in `data/` are unmodified copies. The judge prompt
follows WebVoyager's evaluation criteria (full completion, answer consistent with page evidence)
but is our own text.

## Files

| File | Purpose |
|:--|:--|
| `data/` | Vendored WebVoyager files and license |
| `sample.ts` | Builds the frozen sample (run once; refuses to overwrite) |
| `sample-v1.json` | The frozen sample: 136 tasks, 95 `dev`, 41 `sealed`, plus the dropped ids and reasons |
| `run.ts` | Runner CLI |
| `judge.ts` | Blind LLM judge (`claude -p --model sonnet`, no tools) |
| `summary.ts` | `summary.md` generation (Wilson CIs, per-site, matched cells) |

## Running

```
box heavy -- node bench/public/run.ts --tools agentweb,playwright-mcp,agent-browser,browser-use \
  --split dev --limit 50 --out bench/out/public-dev50
```

Options: `--tools a,b` (any of `agentweb, playwright-mcp, playwright-mcp-vision, chrome-devtools-mcp,
chrome-devtools-mcp-slim, agent-browser-mcp, agent-browser, playwright-cli, browser-use`),
`--split dev|sealed|all` (default dev), `--limit N`, `--sites Allrecipes,ArXiv`, `--model haiku`,
`--turns 25`, `--repeats 1`, `--timeout 300` (seconds per run), `--out dir`, `--rejudge`
(re-run the judge on all saved rows and rewrite them), `--summary-only`.

Output in `--out`: `results.jsonl` (one row per tool x task x repeat, including the final answer,
the last page text the judge saw, tokens, cost, wall time, permission denials and the verdict),
`manifest.json` (fixed config, plus git HEAD, diff hash, tool versions and browser version for every
invocation), `summary.md`, `transcripts/` (full claude stream-json per run).
Finished (tool, task, repeat) triples are skipped, so an interrupted run resumes by repeating the
command. A changed sample, model, turn limit, timeout or judge model is refused (use a new `--out`).

## Protocol

1. **Sample.** Tasks that name a year, month, calendar date, holiday or relative year are dropped
   (113 of 643; Booking and Google Flights almost entirely, since their tasks are date-bound and the
   dates are in the past). Of the rest, up to K=10 per site are drawn with a seeded RNG
   (`bench/sites/rng.ts`, seed 1), and each site's picks are split 70% `dev` / 30% `sealed`.
   Booking has 5 tasks and Google Flights 1 left. "Today"-style tasks ("top story today", "latest")
   stay in; their reference answers are stale by construction.
   **Use `dev` while building. Run `sealed` rarely, for numbers you intend to report, and do not tune
   on it.**
2. **Agent.** `claude -p` with one tool allowed, same isolation as the farm benchmark
   (`bench/baselines/run-agent.ts`): empty cwd, no user settings, strict MCP config, deny by default.
   The same model drives every tool. Prompt = task text, start URL, today's date, and "When done,
   give your final answer on a line starting with ANSWER:".
3. **Order.** Task-major: all tools run on a task back to back, tool order rotated per task (and per
   repeat), tasks interleaved across sites so `--limit` still covers many sites. Strictly sequential,
   one browser at a time.
4. **Judge.** A separate Sonnet call with no tools sees: task, site, reference answer and its type
   (`golden` = must match; `possible` = an example, live data may differ), the agent's answer, and
   up to 12k chars of the last tool results. It does not see the tool's name or the transcript. It
   returns `{"verdict","reason"}`. Runs with no answer are failed without calling the judge. A judge
   call that errors twice is recorded as unjudged and excluded from pass rates (shown in the table).
5. **Summary.** Per tool: pass rate with a 95% Wilson interval, median/p90/total input tokens (uncached
   + cache read + cache write), cost, median wall time, median tool calls, errors, timeouts,
   permission denials. Then a per-site table and a matched-cells table (task x repeat pairs every
   tool ran and had judged); compare tools on the matched table.

## Tools added or changed for this harness

- **browser-use** (`browser-use` 1.0.2, PyPI, run with `uvx`, cached in `~/.cache/uv`, no system
  install). 1.x replaced the old agent MCP server. `browser-use --cli-mcp` exposes `browser_exec`
  (Python over the browser-harness CDP helpers: `new_tab`, `js`, `click_at_xy`, `page_info`, ...),
  `browser_screenshot`, `browser_login`, `browser_feedback`. None of them runs an LLM, so the same
  Claude model drives it. It is pointed at the shared Chromium: the harness starts it headless with
  `--no-sandbox` on a private debugging port and passes `BU_CDP_URL`. Telemetry is disabled by
  environment. It has no accessibility-tree or "get state" tool; the model writes JavaScript or
  Python each step, so its numbers measure that interface, not browser-use's old agent loop.
- **CLI baselines** (`agent-browser`, `playwright-cli`): the Bash allowlist now also admits
  `head tail grep sed jq wc sort uniq cut` (`CLI_PIPE_FILTERS` in `bench/baselines/tools.ts`).
  Claude Code checks each command of a pipeline, so `agent-browser snapshot | grep x` used to be
  denied. This is a convenience allowance, not a sandbox (GNU sed can write files); the cwd is
  a throwaway directory. It applies to the farm benchmark too, so older farm CLI results are not
  strictly comparable. Remaining denials seen in the smoke run came from `$` in a quoted regex
  and similar shell-expansion patterns, not from pipes.

## Limitations

- Live sites change, block headless browsers (Allrecipes returned HTTP 402 to every tool in the
  smoke run; Amazon geo/currency, Google Search and Maps may show consent walls or captchas) and
  differ by time of day and IP. A blocked task fails every tool, which lowers all rates equally but
  compresses differences. Interleaving limits drift between tools, not between runs on different days.
- The judge sees only the final answer and the last few tool results, not the whole trip, and each
  tool formats results differently, so evidence quality varies by tool. Judge agreement with humans
  is not measured here. Spot check with `results.jsonl` (`answer`, `lastPage`, `judge.reason`) and
  use `--rejudge` after any judge change.
- Reference answers marked `possible` are stale examples; many tasks have no single right answer.
- 136 tasks (95 dev) gives wide intervals; with ~50 runs per tool, differences under about 15
  points are within noise. Use `--repeats` for variance, not to shrink the interval on task choice.
- Single model (Haiku by default); results do not transfer to other models.
