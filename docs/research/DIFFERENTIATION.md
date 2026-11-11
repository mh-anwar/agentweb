# Where agentweb can win

Research checked 2026-11-11. These are product bets and acceptance criteria, not claims of measured superiority.

Position agentweb as a web task runtime: reliable answers and verified actions for a given token,
latency, and compute budget. The first target should be research, monitoring, and structured
collection across many pages. Broad interactive QA, pixel fidelity, and developer debugging
already have strong tools.

## What competitors already cover

- agent-browser supports HTTP article reads without starting Chrome, alternate engines,
  command batches, snapshot diffs, persistent authentication, domain policies, and action
  controls. Those capabilities alone are not differentiators. Its own documentation is the
  source: [commands](https://agent-browser.dev/commands),
  [engines](https://agent-browser.dev/engines/lightpanda),
  [diffs](https://agent-browser.dev/diffing),
  [security](https://agent-browser.dev/security), and
  [sessions](https://agent-browser.dev/sessions).
- Playwright offers a CLI alongside MCP and explicitly recommends considering the CLI for
  token efficiency. Beating an untuned MCP snapshot loop is a useful result, but not a
  sufficient competitive moat. [Playwright's comparison](https://github.com/microsoft/playwright-mcp#playwright-mcp-vs-playwright-cli).
- The old local report's claim that agent-browser `read` starts Chrome should be treated as
  version-specific historical behavior. Current docs explicitly describe a browser-free URL read.

## Ranked opportunities

| Priority | User outcome | Existing foundation | Work that would create an advantage | Proof required |
|---|---|---|---|---|
| 1 | Get a complete, correct collection in a few turns | `records`, `each`, budgets, automatic engine escalation | Schema-shaped extraction, field provenance, deduplication across engine changes, and explicit coverage/stop reasons | Cross-page joins, virtualized lists, filters and pagination; report exact-match accuracy and incomplete answers, not just output size |
| 2 | Run large fleets without paying for an idle renderer per session | Store-backed sessions, shared public cache, single-flight reads, tier routing | Durable wake-up/eviction, bounded resource admission, shared validated fetch work, measured cold and warm behavior | Real runtime at bounded concurrency; total process-tree RSS, CPU, p95 latency, origin requests and failure rate; include authenticated isolation |
| 3 | Repeat useful workflows without rediscovering every page | Atlas hints, programs, expectations, stable action fingerprints | Versioned task recipes with preconditions, success receipts, drift detection, and automatic fallback | Change markup and business state between repetitions; measure recovery and duplicate side effects |
| 4 | Delegate sensitive work with evidence of what happened | Secret handles, SSRF checks, observed-origin flow tracking, injection flags | Per-step provenance and policy receipts; test encoded and cross-origin leaks; clear allow/deny explanations | Measure attack success and false blocks separately across unseen attacks; never describe heuristic injection scoring as a security guarantee |
| 5 | Hear only when something relevant changes | Diff rendering, conditional requests, session store | Durable semantic watches: subscribe to a field or condition, sleep, revalidate cheaply, notify once | Long-running change detection, missed/duplicate events, wake-up cost and bytes fetched |

The combined advantage would be amortization: each successful public fetch and site observation
helps subsequent tasks, while private state stays isolated. This is a hypothesis to test, not an
assertion that competitors cannot implement it. A smaller schema or another engine is easy to copy;
a reliable recipe corpus, drift recovery, and trusted benchmark history are harder to reproduce.

## Immediate sequence

1. Repair correctness defects before increasing compression. This iteration fixes conditional
   navigation and feed continuation, including a site menu that masqueraded as a pager.
2. Compare against current pinned competitors, rotate order, and repeat trials. Record permission
   denials and infrastructure errors. Keep raw results when fixing a grader; regrade every tool
   using the same rule, and publish both counts.
3. Add collection coverage and schema validation next. An answer that silently misses a page
   is worse than an explicit incomplete result, even if its token count looks excellent.
4. Build a separate evaluation set with independently authored task variants and fresh seeds.
   Do not call the inspected farm held out. Include Playwright CLI, optimized agent-browser
   reads/batches, and alternate-engine configurations in a later comparison.
5. Measure resource efficiency against actual workloads before making fleet-scale claims.
   The existing server throughput benchmark uses a fake runtime; it cannot demonstrate browser
   capacity. Run bounded local experiments rather than stressing the shared machine.

## Decision rule

Keep a change only when it improves cost or latency without a repeatable correctness regression.
Compare matched task/repeat cells, preserve failures, and show uncertainty. A target for a future
release is equal-or-better completion with substantially lower tokens and compute on fresh tasks.
No current evidence supports “dominates all existing solutions” or “millions of agents.”

## Implemented increment: verified collection and semantic baselines

Checked the current agent-browser command documentation and Rust implementation in
[`cli/src/read.rs`](https://github.com/vercel-labs/agent-browser/blob/main/cli/src/read.rs).
Its URL reader already tries direct markdown, a `.md` alternative, and ancestor `llms.txt`
links, and can filter and outline output. This is capable browser-free reading; adding another
fast URL reader would not establish an advantage. Read source for design comparison; no code
was copied into this increment.

Also checked [Firecrawl Extract](https://docs.firecrawl.dev/features/extract), which already
accepts schemas/prompts and multiple URLs or domains, and the current
[Playwright MCP guidance](https://github.com/microsoft/playwright-mcp#playwright-mcp-vs-playwright-cli)
on using CLI skills for token efficiency. Schema extraction by itself is established functionality.
These sources do not establish that competitors lack coverage or provenance capabilities.

This increment adds `collect`: deterministic field rules, source evidence, explicit validation
failures, cross-page deduplication and an output-budget-aware coverage receipt. It also adds
session-private semantic baselines: key additions/removals and changed field names, independent
of markup and row order. Incomplete collections never advance a baseline or infer removals.
Baseline state is bounded to four snapshots of 256 rows / 64KB each; there are no resident watchers.

Limits are deliberate and visible: recognized repeated structures, observable Next links, at
most ten pages; dynamic feeds remain unverified; numeric punctuation is US/UK. No claim of
competitive superiority follows from the local tests. Next evaluation should measure field
accuracy, false completeness, missed changes, and end-to-end task cost on independently authored
sites against the competitors' optimized paths. Replace this extraction strategy if it cannot
reach useful accuracy without accumulating site-specific rules.
