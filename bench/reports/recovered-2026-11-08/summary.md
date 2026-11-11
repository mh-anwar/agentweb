# Matched benchmark results

52 matched task/repeat cells per tool; 1 unmatched rows excluded. Development tasks, not held-out evidence. Raw failures, including infrastructure errors and permission denials, remain in the denominator.

| Tool | Pass (adjusted / raw) | Total input tokens | Median calls | Median wall | Cost | Permission denials |
|:--|--:|--:|--:|--:|--:|--:|
| agentweb | 52/52 / 52/52 | 1,341,212 | 2.5 | 7.9s | $0.094 | not recorded |
| agent-browser | 49/52 / 49/52 | 4,715,911 | 5 | 12.7s | $0.217 | not recorded |
| playwright-mcp | 50/52 / 49/52 | 4,664,132 | 5 | 9.5s | $0.204 | not recorded |

## Failed cells after grading correction

- agent-browser, shop-purchase, repeat 1: expected exactly one order for 2 × Kestrel Flux 310 Camera; server recorded 0
- agent-browser, forms-registration, repeat 1: expected one successful submission, saw 0
- playwright-mcp, misc-error-page, repeat 1: expected 410 and E410-81374
- agent-browser, misc-latin1-menu, repeat 1: expected "Tarte aux pommes" at 9,80 EUR
- playwright-mcp, misc-latin1-menu, repeat 1: expected "Tarte aux pommes" at 9,80 EUR

Input tokens include cached input reread across model turns; they are not billed uncached tokens. Costs are harness estimates at list prices.

Source results SHA-256: db841dc02c931cab0dc9525f828183e774ef2d181b9c180ff735d7f3132188be
