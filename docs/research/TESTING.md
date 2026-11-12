# agentweb test vs Playwright: what a failing test costs an agent

Question: when an agent writes web tests and one fails, how much context does the failure cost, and how long
does it take to learn about it?

## Method

* Target: the local farm (`node bench/sites/serve.ts --port 4611`), `/shop`.
* Playwright: `@playwright/test` 1.59, `list` reporter, chromium 1248 headless, 1 worker, ANSI colour removed.
  Default settings, so the 5 s `expect` timeout and the 30 s test timeout apply.
* agentweb: `agentweb test shop.aw --workers 1` (default 200-token page excerpt).
* Tokens: `gpt-tokenizer` (o200k) over the exact text printed. For Playwright the `error-context.md` it writes and
  names in every failure ("Error Context: …") is counted separately, since an agent is meant to read it.
* One passing test and two failing ones, written identically in both tools (sources below).

```ts
// Playwright
test('search finds keyboards', async ({ page }) => {
  await page.goto('/shop');
  await page.getByPlaceholder('Search products').fill('keyboard');
  await page.getByRole('button', { name: 'Go' }).click();
  await expect(page).toHaveURL(/search/);
  await expect(page.getByText('keyboard').first()).toBeVisible();
});
test('A: expected text missing', async ({ page }) => {
  await page.goto('/shop/cart');
  await expect(page.getByText('Order placed')).toBeVisible();
});
test('B: ambiguous click', async ({ page }) => {
  await page.goto('/shop/products');
  await page.getByRole('button', { name: 'Add to cart' }).click();
});
```

```
# agentweb: shop.aw
# base: http://127.0.0.1:4611
## search finds keyboards
open('/shop'); fill('Search', 'keyboard'); click('Go')
expect(url='search'); expect('keyboard')
## A: expected text missing
open('/shop/cart')
expect('Order placed')
## B: ambiguous click
open('/shop/products')
click('Add to cart')
```

Test source: 11 lines / 3 tests of Playwright TypeScript against 7 lines of agentweb program.

## Results

| | Playwright | agentweb |
|:--|--:|--:|
| failure A, text missing: report | 279 tokens | **81** |
| failure B, ambiguous click: report | 666 tokens | **262** |
| whole failing run printed | 1,088 tokens (3,774 chars) | **356** (1,311 chars) |
| plus the file the failure points the agent to | `error-context.md`: 1,981 (A) + 7,125 (B) = 9,106 | none, the page excerpt is in the report |
| time to report failure A | 5.2 s (waits out the expect timeout) | instant (no polling on server-rendered pages) |
| 1 passing test, wall time incl. start-up | 5.4 s (`1.9 s` in the test) | 1.7 s (433 ms) |

Why the reports differ:

* Playwright's failure shows the call log, a 7-line code frame with the file path and column, the timeout and a
  pointer to a file. The agent usually has to open that file to see the page, and the ARIA snapshot in it is the
  whole page (7k tokens on a product list).
* agentweb prints the test name, `file:line`, the step, the one-line error and the *main content region* of the page
  (site header, nav, cookie banner and footer omitted) in about 200 tokens, clipped to 8 lines.
* On an assertion that cannot become true (server-rendered page, text absent) agentweb answers immediately.
  Playwright cannot know the page is final, so it waits for the timeout; B's click waited for nothing but still
  printed 18 candidate buttons as raw HTML.

## Honest limits of the comparison

* One target site and three tests, not a sample. The ratios depend on how large the excerpt is; `--excerpt N`
  trades tokens for context.
* Playwright drives a real browser with real layout, timing, network interception, multiple tabs, iframes, file
  downloads, and visual diffs. agentweb tests check what an agent (or a screen reader) can read and do; for
  server-rendered pages that is the whole page, for script-driven pages the runtime escalates to its script or
  chrome engine. Pixel-level and layout assertions are out of scope.
* Playwright's `getByPlaceholder('Search products')` worked where agentweb's `fill('Search products', …)` did not:
  the farm's field is labelled "Search" with a placeholder. agentweb's failure said `Closest: [Search]5`, so the
  fix cost one line, but placeholder text is not yet a target.
