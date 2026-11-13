# Agentweb progress

## Beat Playwright (from 2026-11-12, branch `t3/beat-playwright`)

Owner's goal: Clockwork moves its browser tests to agentweb only once agentweb is measurably better than
Playwright. The scoreboard is [bench/vs-playwright](../bench/vs-playwright/README.md) (`node run.mjs`; results in
its RESULTS.md): the same 9 journeys in both tools against a fixture app with 24 switchable planted bugs and 5
benign variants, measuring wall/CPU/memory, pass and flake rate, false alarms, bugs caught, whether the output
names the cause, and test code size. Clockwork's own journeys are the real-world half (their thread runs
`scripts/agentweb/compare.mjs`).

Built for it: assertions and step targets by role, accessible name, label, test id, CSS and state, with scopes
(`src/checks/locate.ts` in the page, `src/checks/expectloc.ts`), `within()`, `as('user')` for a second browser
context, `expect(download=)`, waiting step targets and short settling in test runs, read-only probes that skip
settling, ghost clock limited to 1 s ahead after actions, `upload(t, path)`, `exec(expect=)`, readable command
failures, `${base}`, `${today+N}`. Next: close the remaining wall-time gap, then move Clockwork journeys.

### Handoff (2026-11-12 ~20:00 local; next thread continues in this worktree)

**Scoreboard so far** (bench/vs-playwright/RESULTS.md, 2 workers, 5 clean runs, 24 planted bugs, 5 benign variants):
agentweb wall 8.4 s vs Playwright 6.6 s (**loss**); CPU 11.8 vs 14.0 s; peak memory 861 vs 1801 MB; flaky 0 vs 0;
false alarms 0/5 vs 0/5; bugs caught 23/24 vs 24/24 (agentweb misses the 18 px tap target, see below); failure output
1274 vs 2967 chars; test code 63 vs 212 lines.
**Clockwork's real suite** (their numbers, build c8d73f6, before this branch's speedups): 46-page sweep 84 s vs 137 s
(38% faster), CPU 118 vs 205 s, memory 1081 vs 1918 MiB, 0 flaky both, code 1456 vs 2664 chars; planted bugs 8/8
both, failure output 599 vs 2046 chars.

**Open Clockwork items:** (5) a cookie set by a Next server action missing on a later open(): not reproduced with
a fixture (bench/vs-playwright/app/server.mjs `/cookie-lab`); they retest on the preview build with --verbose.
Their journey ports (report-problem, settings-groups, sign-in) are moving to the new locator syntax.

**Next, in priority order:**
1. Wall time on the fixture (the only lost metric). Run `AGENTWEB_TEST_TRACE=1 node dist/agentweb.mjs test
   bench/vs-playwright/agentweb --base …` for per-step ms. Suspects: page extract + compile + render after every
   action, cookie/storage sync over CDP per step, browser context creation per test, a node process per `# setup:`.
2. Strict tap-target rule (any control under 24 px, no WCAG spacing exception), as Clockwork's checkDesign does:
   e.g. `audit='target24'`; then the fixture's `tap-small` bug is caught.
3. Bug: `# console: clean` (expect(console=0, all=1) at the end of a test) loses earlier pages' errors after a
   mid-test `profile()`.
4. `--grep-test` matches titles before `# each:` values (documented; `--grep` matches the expanded name).
5. Rerun `node run.mjs` for a clean table after each win; ask the Clockwork thread for compare.sh numbers on the
   newest build; then move the next Clockwork journeys (forms + db checks via exec(expect=), mail(), as()).

### Takeover (2026-11-12 ~20:00 local, third thread, same worktree)

Clockwork's first journey run on preview 037b68c (sign-in, settings-groups) reported 4 bugs. Fixed here:
1. Actions wait up to 5 s for a control that is disabled until hydration (`liveOn` in src/runtime.ts re-reads the
   page every 100 ms), then fail with "still disabled after 5 s". Not covered: a disabled control on a wire-tier
   page (click at `if (act.dis)` in the click verb, fill on a plain HTML form) still fails at once.
2. `fill(label='Password', 'value')`: with a keyword locator (label=, testid=, css=, role=+name=) the one positional
   argument is the value (`keyedTarget` in src/checks/expectloc.ts). css= steps now go through the locator too.
3. `expect(url='/path?q#frag')` compares the fragment when the pattern has one; the failure message shows it.
Released as 7dafa57 (installed). Clockwork confirmed 1-3 on the real app: 4 of 5 journey ports pass (were 0 of 5); the
47.9 s slow failure was the #hash expect waiting and is gone (settings-groups passes in 13-16 s).

Second round (same day):
- `expect('/Bug Reports/', role='heading', level=1)` takes a pattern (checkExpect in src/runtime.ts).
- fill/select/check/uncheck narrow several locator matches to controls that fit the verb (`FITS` in
  src/checks/expectloc.ts): fill(label='Password') no longer trips on a "Show password" button.
- `js('…', as='name')` keeps the value as `${name}` and prints it with --verbose or AGENTWEB_TEST_TRACE=1
  (src/test/runner.ts; js() keeps its arguments as code, so as= is read the way exec()'s is).
- Regression test for all of the above and for fixes 1-2: test/testrunner.test.ts, "a form that is disabled until its
  script runs".
- Clockwork item 5 / A (cookie missing after a sign-in link) is **not agentweb**: their dev server on 3989 runs
  `next dev -H 0.0.0.0`, so the app redirects to http://0.0.0.0:3989 and the localhost cookie is not sent. Told them.
- Clockwork's first journeys comparison (preview 7dafa57, 2 workers, 2 runs; Playwright ran 7 tests vs 5 ports, so wall
  time is not like-for-like): agentweb 31.3 s 4/5 and 56.1 s 1/5; Playwright 43.0 s 6/7 and 40.0 s 5/7; CPU 36 vs 71 s;
  peak memory 1306 vs 3355 MiB; code 5036 vs 11248 chars; **flaky 3 vs 1 (loss)**. Their table:
  clockwork worktree docs/knowledge/agentweb-vs-playwright/2026-11-13-journeys.md. The 1/5 run was not reproduced: three
  back-to-back agentweb runs here gave 4/5 each in ~30 s (the failure is A). Suspect: local Supabase sign-in rate limit
  when alternating with Playwright; waiting for their captured errors.

**Open:** flaky count on Clockwork journeys (needs their error output); a disabled control on a wire-tier page still
fails at once; then the "Next, in priority order" list above, fixture wall time first (8.4 s vs 6.6 s).

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
