# Task benchmark (2026-11-11, model haiku, 2 tasks, n=2 per cell)

| Tool | Passed | Median tool calls | Median input tokens | Total input tokens | Median wall | Cost | Permission denials |
|:--|--:|--:|--:|--:|--:|--:|--:|
| agentweb | 4/4 | 9 | 112,547 | 405,464 | 12.2s | $0.017 | 0 |
| agent-browser | 4/4 | 13 | 203,242 | 617,300 | 22.6s | $0.024 | 2 |
| playwright-cli | 4/4 | 12 | 209,191 | 739,303 | 20.0s | $0.031 | 1 |

## Passed by tag

| Tag | agentweb | agent-browser | playwright-cli |
|:--|--:|--:|--:|
| cart | 2/2 | 2/2 | 2/2 |
| extraction | 2/2 | 2/2 | 2/2 |
| multi-page | 2/2 | 2/2 | 2/2 |
| multi-step | 2/2 | 2/2 | 2/2 |
| transaction | 2/2 | 2/2 | 2/2 |

## Every run

| Task | agentweb (pass · calls · input) | agent-browser (pass · calls · input) | playwright-cli (pass · calls · input) |
|:--|:--|:--|:--|
| shop-out-of-stock | ✓ · 5 · 46,618 / ✓ · 5 · 45,376 | ✓ · 8 · 115,326 / ✓ · 4 · 70,326 | ✓ · 7 · 116,671 / ✓ · 7 · 133,453 |
| shop-cart-edit | ✓ · 9 · 112,547 / ✓ · 14 · 200,923 | ✓ · 15 · 228,406 / ✓ · 13 · 203,242 | ✓ · 14 · 279,988 / ✓ · 12 · 209,191 |
