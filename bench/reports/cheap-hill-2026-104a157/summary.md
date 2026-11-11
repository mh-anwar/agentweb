# Matched benchmark results

4 matched task/repeat cells per tool; 0 unmatched rows excluded. Development tasks, not held-out evidence. Raw failures, including infrastructure errors and permission denials, remain in the denominator.

| Tool | Pass (adjusted / raw) | Total input tokens | Median calls | Median wall | Cost | Permission denials |
|:--|--:|--:|--:|--:|--:|--:|
| agentweb | 4/4 / 4/4 | 405,464 | 7 | 12.0s | $0.017 | 0 |
| agent-browser | 4/4 / 4/4 | 617,300 | 10.5 | 16.9s | $0.024 | 2 |
| playwright-cli | 4/4 / 4/4 | 739,303 | 9.5 | 16.4s | $0.031 | 1 |

## Failed cells after grading correction


Input tokens include cached input reread across model turns; they are not billed uncached tokens. Costs are harness estimates at list prices.

Source results SHA-256: bcf4ba71f93ed2d563ffb973c0ab3fd3e27da8978b378bb894de6024f5b87cfe
