# Matched benchmark results

18 matched task/repeat cells per tool; 0 unmatched rows excluded. Development tasks, not held-out evidence. Raw failures, including infrastructure errors and permission denials, remain in the denominator.

| Tool | Pass (adjusted / raw) | Total input tokens | Median calls | Median wall | Cost | Permission denials |
|:--|--:|--:|--:|--:|--:|--:|
| agentweb | 18/18 / 17/18 | 633,193 | 3 | 7.0s | $0.038 | 0 |
| agent-browser | 16/18 / 16/18 | 3,348,364 | 9.5 | 19.2s | $0.119 | 7 |
| playwright-mcp | 18/18 / 18/18 | 2,506,543 | 6 | 12.2s | $0.090 | 0 |

## Failed cells after grading correction

- agent-browser, forms-registration, repeat 2: answer lacks the registration reference REG-CF96E3 (error_max_turns)
- agent-browser, forms-registration, repeat 3: expected one successful submission, saw 0 (error_max_turns)

Input tokens include cached input reread across model turns; they are not billed uncached tokens. Costs are harness estimates at list prices.

Source results SHA-256: 5aa7c97002d7be2d51d3f1e5215b8b077a8ed62f47b25b952cc9fe8672d0be4c
