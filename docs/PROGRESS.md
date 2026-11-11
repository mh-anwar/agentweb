# Agentweb progress

Updated 2026-11-11. This iteration was developed on `t3/agent-browser-differentiation` and
integrates the owner’s logging and auto-release commits through `3de280b`. Green work lands on
`build/agentweb-v0`, the box’s live release branch. Branches are preserved in the local bare git
repository `/home/pippin/git/agentweb.git`; there is no external backup or public release yet.

## Recovered state

The November 8 progress thread started a three-way 61-task baseline and stopped before delivering
it. Its saved run contains 157 of 183 cells. The recovered report compares the 52 tasks completed
by all three tools, preserves raw rows, and labels browser startup errors and harness limitations.
See [the historical report](../bench/reports/recovered-2026-11-08/README.md).

## This hill-climb iteration

- Ordinary HTTP navigation now sends conditional requests and reports 304 revalidation while
  retaining the document body. Navigations still reach the origin individually, even when they
  overlap, so GET action links are not silently skipped by cache hits or request coalescing.
- Private, no-store and otherwise uncacheable replacement responses invalidate an old public
  cache entry, including a private 304 response.
- Multi-page record extraction recognizes new content when engines regroup rows or virtualized
  feeds replace rows without increasing DOM size. Global menu links before the collection no
  longer masquerade as its pagination; legitimate pagers above the list remain supported.
- Benchmarks support repeated trials, rotating tool order, immutable source/version manifests,
  permission-denial counts, and matched-cell summaries. The native CLI is checked directly;
  a missing execute permission cannot silently select a different binary on PATH.
- Each CLI trial namespaces explicit session names and closes all sessions it created, including
  names chosen by the model. An initial batch affected by the old launcher was invalidated.
- Answer-format graders accept explanatory prose about an excluded runner-up and an entry
  number stated outside the quoted content. They still reject a sixth recommended product,
  incorrect ordering, a neighboring entry or an incorrect verification suffix. Both corrections
  are applied equally to every tool; raw verdicts remain available.

Final combined verification: `npm test` ran 892 tests, with 878 passed, 14 skipped and zero
failed. Public-provider checks are opt-in; the normal suite uses two workers. The typecheck,
build, and packaged JavaScript/PDF smoke checks also passed. Two existing timing flakes were
fixed by testing VM interruption behavior and waiting for Chromium child exits with a deadline.
The [54-trial comparison](../bench/reports/hill-2026-11-11/README.md) preserves raw and corrected
scores: agentweb 18/18 corrected (17/18 raw), Playwright MCP 18/18, agent-browser 16/18.
Aggregate input was 633,193 / 2,506,543 / 3,348,364 tokens respectively.

## Competitive direction

[Research and ranked opportunities](research/DIFFERENTIATION.md) favor complete structured
collection, shared work across sessions, drift-aware reusable recipes, and traceable actions.
Current competitor documentation already covers many attractive individual features. The
advantage must be demonstrated in task outcomes and resource cost, not inferred from features.

## Still unproven or unfinished

The farm has been inspected and is development data. It is not a fresh held-out evaluation.
Fleet-scale capacity, end-to-end resource efficiency, durable watches and the inspector remain
unproven or unfinished. A fake-runtime server throughput result would not prove browser scale.
A later evaluation should include optimized CLI/batch/read paths, alternate engines, fresh task
variants and independent task authorship.

The installed dogfood build logged one successful HTTP-tier documentation lookup, zero failures
and zero fallbacks during this handoff. No recurring usage failures exist yet. The
[dogfood-to-benchmark loop](research/DOGFOOD-LOOP.md) describes how to turn them into tasks.
No independent edits were made to `src/cli.ts`; the owner’s CLI changes were merged intact.
