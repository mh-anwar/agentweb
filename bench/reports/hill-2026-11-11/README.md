# Hill-climb checkpoint: 2026-11-11

Agentweb matched Playwright MCP's completion on this development set while using substantially
less model input. This is a focused checkpoint, not a claim of broad superiority.

[Matched results](summary.md) · [chart](comparison.html) · [source/tool manifest](manifest.json) ·
[raw rows](raw-results.jsonl) · [corrected rows](results.jsonl) ·
[full answer grading audit](results.jsonl.answers.jsonl) · [grading provenance](results.jsonl.provenance.json)

## Method

Measured source: `6556ee3bf86832d3b6ab167e4dfff0cde6ded7df`, including the navigation-cache and
feed-continuation fixes from `866acf0`. Fresh memory stores and isolated sessions per agent task;
the farm resets before each cell. Seed 7, no artificial latency, same local farm, same Chromium
156.0.8078.4, Claude Haiku 5.5, shared limit of 20 model turns. Latest published packages at run
time: agent-browser 0.42.0 and Playwright MCP 0.0.85. The actual native binary was version-checked.
Tool order rotates between repetitions. Runs are sequential on the same shared machine.

Six tasks, three repetitions, three tools: 54 completed cells. The selected tasks cover product
filtering/sorting, checkout, long-document lookup, registration, infinite scroll and conditional
HTTP requests. These were chosen as inspected development cases, including prior weaknesses;
they are not a random sample or a fresh held-out set. Three repetitions measure variation on
these six tasks, not performance across 18 independent kinds of task.

```bash
node bench/run.ts --tools agentweb,agent-browser,playwright-mcp \
  --tasks shop-five-cheapest-rated,shop-purchase,forms-registration,docs-config-late,hard-infinite-scroll,misc-revalidation \
  --repeats 3 --port 4670 --out bench/out/hill-6556ee3
```

## Results and limits

| Tool | Passed, corrected (raw) | Total model input | Median calls | Median wall |
|:--|--:|--:|--:|--:|
| agentweb | 18/18 (17/18) | 633,193 | 3 | 7.0 s |
| agent-browser | 16/18 (16/18) | 3,348,364 | 9.5 | 19.2 s |
| Playwright MCP | 18/18 (18/18) | 2,506,543 | 6 | 12.2 s |

Aggregate model input was 5.29 times lower than agent-browser and 3.96 times lower than
Playwright MCP. Input includes cached context reread on later turns; these ratios are not dollar
savings. Harness list-price costs were approximately $0.038, $0.119 and $0.090 respectively.

Both agent-browser failures reached the 20-turn cap on registration. Its CLI harness also recorded
seven permission denials, including one on a failed registration trial. Assignments and arbitrary
helper programs are restricted in this harness. This limits conclusions about unrestricted CLI
performance; it also affects token counts through retries. Do not present this as an optimized
agent-browser result. Playwright CLI and alternate browser engines were not included here.

One raw agentweb failure is a grader false negative: its answer quoted the correct entry content
and stated “Entry 45” separately, while the grader required the page's whole label inside the
quote. The corrected grader still requires all unique content, including the verification suffix,
and rejects neighboring entries or altered suffixes. Every tool's applicable full answer was
regraded equally. The earlier five-product-list correction was already active in the measured
source. The audit preserves the full answers and before/after verdicts.

No incomplete cells or infrastructure failures were dropped. The first attempted batch,
`hill-866acf0`, was invalidated because an unexecutable pinned CLI silently fell through to an
older binary on PATH. It is excluded entirely. The replacement launcher fails before a trial
starts, namespaces model-selected sessions, and closes all sessions created by that trial.

A broader next evaluation needs independently authored tasks, new seeds and site behaviors,
optimized CLI read/batch paths, and real resource measurements. The current evidence does not
establish fleet-scale capacity or general dominance.
