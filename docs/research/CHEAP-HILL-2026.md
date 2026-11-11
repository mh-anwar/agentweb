# Cheap-Haiku hill-climb trial, 2026 (checkout 104a157)

Result: **12 of 12 matched cells completed and passed** (0 harness errors, 0 grader failures). All three tools solved both tasks in both repeats, so this run separates the tools on cost and turns, not on pass rate.

## Command and selection

```
box heavy -- node bench/run.ts --tools agentweb,agent-browser,playwright-cli \
  --tasks shop-out-of-stock,shop-cart-edit --model haiku --turns 15 --repeats 2 \
  --seed 2026 --port 0 --out bench/out/cheap-hill-2026-104a157
```

- `--turns 15` is the harness flag for `claude --max-turns 15`.
- **Task selection method:** the seeded generator in `bench/sites/rng.ts` (`new Rng(2026)`, mulberry32), with one draw per group in order. Group A `[shop-five-cheapest-rated, shop-out-of-stock, hard-infinite-scroll]` drew index 1, giving `shop-out-of-stock`. Group B `[shop-cart-edit, forms-wizard, news-login-vote]` drew index 0, giving `shop-cart-edit`. The draw is reproducible from the seed; I did not check it against a second implementation.
- Repeat 2 rotates tool order, as `run.ts` does by design.

## Results (per cell)

| Task | Tool | Repeat | Pass | Tool calls | Turns | Input tokens (total) | Tool-result tokens | Cost (USD) |
|:--|:--|--:|:--:|--:|--:|--:|--:|--:|
| shop-out-of-stock | agentweb | 1 | ✓ | 5 | 6 | 46,618 | 3,052 | 0.0032 |
| shop-out-of-stock | agentweb | 2 | ✓ | 5 | 6 | 45,376 | 2,542 | 0.0027 |
| shop-out-of-stock | agent-browser | 1 | ✓ | 8 | 9 | 115,326 | 9,726 | 0.0059 |
| shop-out-of-stock | agent-browser | 2 | ✓ | 4 | 5 | 70,326 | 6,399 | 0.0043 |
| shop-out-of-stock | playwright-cli | 1 | ✓ | 7 | 8 | 116,671 | 11,032 | 0.0072 |
| shop-out-of-stock | playwright-cli | 2 | ✓ | 7 | 8 | 133,453 | 13,709 | 0.0081 |
| shop-cart-edit | agentweb | 1 | ✓ | 9 | 10 | 112,547 | 5,719 | 0.0044 |
| shop-cart-edit | agentweb | 2 | ✓ | 14 | 15 | 200,923 | 6,784 | 0.0065 |
| shop-cart-edit | agent-browser | 1 | ✓ | 15 | 16 | 228,406 | 5,310 | 0.0072 |
| shop-cart-edit | agent-browser | 2 | ✓ | 13 | 14 | 203,242 | 5,833 | 0.0071 |
| shop-cart-edit | playwright-cli | 1 | ✓ | 14 | 15 | 279,988 | 7,247 | 0.0081 |
| shop-cart-edit | playwright-cli | 2 | ✓ | 12 | 13 | 209,191 | 7,010 | 0.0072 |

Per tool (recomputed from unchanged raw rows; even-sized medians average the middle pair):

| Tool | Passed | Median calls | Median input tokens | Total input tokens | Median wall | Cost | Permission denials |
|:--|--:|--:|--:|--:|--:|--:|--:|
| agentweb | 4/4 | 7 | 79,582.5 | 405,464 | 12.0 s | $0.017 | 0 |
| agent-browser | 4/4 | 10.5 | 159,284 | 617,300 | 16.9 s | $0.024 | 2 |
| playwright-cli | 4/4 | 9.5 | 171,322 | 739,303 | 16.4 s | $0.031 | 1 |

**Total benchmark cost: $0.072** (sum of the 12 `total_cost_usd` values, list prices, including auxiliary calls). Each tool has n=4 (2 tasks × 2 repeats), so these are small samples.

Permission denials are all Bash pipelines the harness rule did not allow (e.g. `agent-browser ... | grep ... | head`, `playwright-cli --raw snapshot | grep ... | sed ...`). They were refused, not prompted, and the agents recovered.

## Raw evidence

All under `bench/out/cheap-hill-2026-104a157/` (gitignored, local to this box):

- `results.jsonl`: one row per cell, with the grader's `why` and answer
- `summary.md`, `manifest.json` (git HEAD, versions, browser, seed)
- `transcripts/<task>--<tool>--r<n>.jsonl`: full stream-json transcripts; `.stderr.txt` files are all empty
- `bench/out/cheap-hill-2026-104a157.log`: the run log

## Provenance and limitations

- Start state: `git status` was clean at 104a157. The manifest's `diffSha256` is the SHA-256 of an empty `git diff HEAD`.
- **Baseline versions are older than the lockfile.** The shared `node_modules` (symlinked into `bench/baselines/node_modules`, not installed or upgraded by me) contains `agent-browser` **0.41.2** and `@playwright/mcp` **0.0.84**. `bench/baselines/package.json` and `package-lock.json` pin **0.42.0** and **0.0.85**. The run used what is installed, and the manifest records that. `@playwright/cli` 0.1.23 matches the pin, and `playwright-mcp` was not part of this run. These are pinned older versions, not the latest releases, and I did not reinstall to match the lock.
- Browser: Google Chrome for Testing 156.0.8078.4 (`~/.cache/ms-playwright/chromium-1248`), `--no-sandbox`.
- Farm: local, `--port 0`, seed 2026. No public sites and no external transactions.
- **Concurrent edits, not part of this run.** `git status` now shows modifications to `src/compile.ts`, `src/extract/index.ts`, `src/tooldoc.ts`, and `test/extract.test.ts`, plus `test/e2e.mcp.test.ts` in `git diff`. Their mtimes are 05:30:29, after the benchmark ended (~05:28, log at 05:27:56). The trials therefore ran against clean 104a157 code. I did not make these edits and did not touch them.
- Matching-comparison caveats: the same farm seed, prompts, grader, and 15-turn limit for all tools; tool order rotated across repeats; the agentweb tool description (which is sent on every turn) is counted in input tokens for all tools; agent-browser and playwright-cli load their skill text by system prompt, also counted. The agentweb server ran from `src/cli.ts` with an in-memory store. Haiku only, 2 tasks, n=2 per cell, so the cost gaps are directional.

## Where the call overhead goes (measured)

Input tokens are the sum over every API turn of the whole context, so a large tool result is re-sent on each later turn. Cost follows turns × context size. The per-cell trace shows two effects:

1. **Full-page snapshots dominate competitor results.** Single largest results: `playwright-cli snapshot` = 6,268 tokens (Backpacks category page, identical in both repeats), 3,758 (page 2), 3,146 (shop index); `agent-browser snapshot` = 4,193 and 3,414. Tool-result tokens per run: agentweb 2.5k–6.8k, agent-browser 5.3k–9.7k, playwright-cli 7.0k–13.7k. Totals over four runs each: agentweb 18,097 across 33 calls; agent-browser 27,268 across 40; playwright-cli 38,998 across 40.
2. **For agentweb, the largest results are its own multi-page `records`/`find` calls.** `records('Juno 42 Ionic 506', pages=5)` returned 2,155 tokens, and `records('Brightwell Juno Ostrava Ionic', pages=6)` returned 2,123. These are the biggest single results agentweb produced.

Both call counts and result sizes contribute to context growth; this small run does not isolate their causal contributions.

## agentweb failures in this trace

agentweb had **3 errored calls out of 33**, all in the two `shop-cart-edit` runs. Each cost one full turn, and the error results totalled 2,330 tokens (12.9% of agentweb's result tokens). A `run` batch stops at the first error, and every later step is listed as `not run:`.

1. **Bare ambiguous target**, `shop-cart-edit--agentweb--r1`, call 5. Input:
   `click('Add to cart'); find('Cart'); search('Brightwell Juno 42'); click('Brightwell Juno 42 Camera'); click('Add to cart'); find('Cart')`
   Result (263 tokens): `'Add to cart' matches 5 things; use the number, or near='text on the same line'`, followed by `[Add to cart]134 in "Quantity=1"` and four related-product buttons. The page was the Ostrava Ionic 506 product page. The agent's next call, `click(134); find('Cart')`, succeeded (22 tokens). The product's own button was numbered 134 and labelled by its quantity control; the other four were related-product cards.
2. **near= text that fails**, `shop-cart-edit--agentweb--r2`, call 6. Input included `click('Add to cart', near='Brightwell Juno 42 Camera')` and later `click('Add to cart', near='Ostrava Ionic 506 Keyboard')`. Result (1,545 tokens): `'Add to cart' matches 19 things and none is near 'Ostrava Ionic 506 Keyboard'`, with 19 candidate lines and the page header and nav repeated.
3. **Guessed label**, `shop-cart-edit--agentweb--r2`, call 11: `click('Keywords')` → `nothing clickable matches 'Keywords'` (522 tokens). The agent guessed a filter name that was not on the page.

Failure 1 and failure 2 are the same mechanism. Both agentweb cart-edit runs (2 of 2) hit an ambiguous add-to-cart resolution.

Source: `src/session.ts:228–260`. After the exact-text match, `resolve` returns a unique match, a `nth` match, or a `near` match with a distance rule. If there is no `near` and more than one match remains, it throws at line 260. The `near` path on line 258 also throws when the distance rule rejects every candidate.

## Chosen next fix (one)

**On an ambiguous bare target, prefer the control in the page's primary block.** On a product page, the buying control (`Add to cart` under the product's own title and `Quantity` field) should win over related-product cards, which sit under a later heading. Concretely, in `resolve` (`src/session.ts`, before the throw at line 260): when there is no `near` and several candidates remain, pick the single candidate whose nearest preceding heading is the page's main title (the `h1`, or the first heading if none). Act on it only when exactly one candidate satisfies that. Otherwise keep the existing error.

- Evidence: failure 1 above, reproduced by both cart-edit runs (2 of 2 agentweb cart runs). The fix turns that call from an error into a success, which saves one turn and the 263-token error reply, and it also avoids the batch abort.
- Expected effect on this trace: about one turn saved in the cart-edit runs. Small on this sample, and it needs a check on more product pages before it counts as a win.
- To verify before merging: run the cart-edit task with the same seed and check that `click('Add to cart')` resolves to the product's own button in both repeats, and that the farm's other tasks that use ambiguous targets (`bench/sites/tasks.ts`) still pass. Not run here; this note is research only.

**Overhead, measured but not chosen:** the biggest per-call overhead is multi-page `records` results (2.1k tokens) in agentweb and full-page snapshots (up to 6.3k) in the competitors. A possible follow-up is a smaller default page budget for `records(..., pages=N)` when N is large. That is a hypothesis; this trace does not show the quality cost of a smaller budget.

## Not done

- No commit, push, or release. No code, grader, prompt, permission rule, harness limit, or baseline was changed.
- The full test suite was not run. The benchmark ran as a single sequential job under `box heavy`.
- No subagents were spawned.


## Parent audit and next increment

The original run summary used the upper middle observation for even-sized samples. The table
above now uses ordinary medians; `bench/run.ts` is fixed for future runs. Original summary and
unchanged raw rows/manifest are preserved in `bench/reports/cheap-hill-2026-104a157/`. No graders
or pass/fail verdicts were changed. Selected tool call traces are saved there as `agentweb-calls.json`.

Parent chose to fix two earlier causes in those same traces before attempting automatic action
preferences: one-item semantic article cards now remain actionable records, and specific filters
survive first-page misses instead of silently returning unrelated products. Queries that match
nothing explain that site search locates exact item names. The one-result path is checked through
the built MCP server. The full regression suite passed 921 tests with 14 skips and zero failures.
The proposed implicit primary-control preference remains unimplemented; explicit targets are
retained. A fresh same-seed cart-task run will measure whether these changes reduce wasted calls.
