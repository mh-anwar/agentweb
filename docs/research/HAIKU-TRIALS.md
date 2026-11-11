# collect() Haiku trials

Independently authored, seeded local-fixture trials for `collect(name='link', price='money', href='url', pages=…)`.
Test file: `test/collect.haiku-trials.test.ts`. Run: `node --test --test-concurrency=1 test/collect.haiku-trials.test.ts`.

## Setup

- Target: `createAgentweb` from `src/index.ts` (the `dist/agentweb.mjs` bundle is CLI-only and does not export the API).
- Each test starts its own ephemeral `127.0.0.1` HTTP fixture and closes it, and the runtime, in `finally`. Nothing persists.
- Randomness is seeded (mulberry32, seeds 3, 11, 2026). Truth (names, cents, IDs, row order) is generated on the fixture side and asserted exactly; expectations are never read back from the output.
- Assertions follow the README contract. Failing assertions were left failing, not weakened.
- Box: `box status` was calm (load 2.2/8, ~24G RAM free). Work was one focused test file, about 0.5 s runtime, no heavy jobs.

## Results

Two trees were run: the requested commit `1e72bcb` (exported to a scratch dir) and the checkout HEAD `8af8c1e`
("Reject lossy numeric extraction and compare observed currencies"), which landed in the shared checkout during this trial.

| Trial | Scenario | Attempts | 1e72bcb | 8af8c1e |
|---|---|---|---|---|
| 1 | product cards, 3 pages, seeded sizes and partial last page, exact truth | 3 seeds | pass 3/3 | pass 3/3 |
| 2 | page limit, bad `pages`, HTTP 503 mid-run, Next cycle, budget overflow, JS-only list | 5 sub-cases | pass | pass |
| 3 | table rows, seeded order and prices | 3 seeds | pass 3/3 | pass 3/3 |
| 4 | overlap across pages, same-page repeat, distinct twin with a different link | 1 | pass | pass |
| 5 | malformed money values (11 cases) | 11 cases | **8 pass / 3 fail** | **8 pass / 3 fail** |
| 6 | image-only empty-label link before title link | 1 | pass | pass |
| 7 | diff: reorder-only, reprice, rename, remove, add, decoration, incomplete run withholds, baseline not advanced, schema reset | 1 | pass | pass |
| 8 | two rows sharing one diff key | 1 | pass | pass |

Totals: **12 tests, 11 pass, 1 fail** on both trees. The single failing test (trial 5) contains 3 failing sub-cases.

## Product defects found (trial 5)

All three reproduce identically on `1e72bcb` and `8af8c1e`. The `8af8c1e` commit does not fix them.

1. **Negative sign is dropped.** The money regex requires the symbol before the minus, so the sign is lost.
   - Repro row: `<li><a href="/p/1">Refund</a> -$5.00</li>` with `collect(name='link', price='money', href='url', pages=1)`
   - Actual: `price: 5`, evidence `$5.00`. Expected: `-5` or an explicit `null` error.
   - Cause: `src/extract/collect.ts`, money regex `/(?:[$£€]\s*-?\d[\d.,]*|…)/`. A leading `-` before `$` is not matched.
   - Severity: silent wrong value; a refund becomes a charge.

2. **Currency-qualified symbol is flattened to `$`.** `CA$` (and by the same path `A$`, `NZ$`) is recorded as US `$`.
   - Repro row: `<li><a href="/p/1">Item</a> CA$12.00</li>`
   - Actual: `price: 12`, evidence `$12.00`. The README says evidence should "distinguish currencies", and this does not.
   - Cause: the `8af8c1e` currency tag comes from `/^(?:[$£€]|USD|GBP|EUR)/`, so `CA$` becomes `$`. The commit comment states this is deliberate, but it means two different currencies collapse to the same value and evidence.
   - Severity: silent currency mislabel. This is a judgment call, so flagging it for the owner rather than asserting it is a clear bug.

3. **Space-grouped thousands truncate silently.** Common in FR/NO/SE formats.
   - Repro row: `<li><a href="/p/1">Item</a> €1 250,00</li>`
   - Actual: `price: 1`, evidence `€1`. Expected: `null` with an error, or `1250`.
   - Cause: the money regex's character class `[\d.,]*` does not include a space, so the match ends at `1` and the rest is ignored.
   - Severity: silent wrong value by a factor of 1000.

Not counted as defects (documented contract, noted for the owner): European dot-thousands (`€1.250`) parses as `1.25` because the README says money uses US/UK punctuation. Trailing period (`$12.`) is tolerated and passes either way.

## What held up

- Exact typed values, evidence and source URLs across seeded multi-page runs, including partial last pages.
- Page limit, `pages` bounds, HTTP 503 mid-run (partial rows kept, `stop=http_error`), Next cycles (`stop=cycle`), budget overflow (explicit `stop=budget`, truthful prefix), JS-only lists (`dynamic_unverified`).
- Dedup: same-page repeats and overlap are removed while a same-text twin with a different link is kept.
- Ambiguous (`$12.50 then $14.00`, `Sale $10 (was $12)`) and malformed (`$12,50`, `Call for price`) money become `null` with errors, and coverage is incomplete.
- Diff: reorder and markup changes produce no changes; reprice/rename/add/remove reported exactly; incomplete runs withhold and do not advance the baseline; duplicate keys withhold; schema change resets.

## Caveats

- Not a blind held-out benchmark: the author could read the implementation. The assertions were derived from the README contract and seeded truth, then checked against the code.
- Two harness mistakes were fixed during the run: truth rows used `link` instead of the schema field `name`, and trial 7 expected a removal that the earlier complete run had already recorded. Both were corrected in the test, not by weakening product checks.
- The shared checkout moved from `1e72bcb` to `8af8c1e` during the trial by another session. Results are reported for both.
- No commits, no push, no new persistent servers. Only the two files above were added.


## Parent follow-up

The original failures above are preserved as historical evidence. The parent fixed all three:
leading refund signs are retained; currency-qualified symbols retain their full marker and quote;
space-grouped amounts are rejected as unsupported whole tokens instead of truncated. Added
regressions also cover Unicode minus, nonbreaking/narrow spaces, accounting parentheses and
exponent notation. After these fixes all **12 Haiku-authored tests pass**, without weakening their
assertions. The complete focused collection suite passes **35/35**. Tests exercise source API;
the separate packaged MCP integration test exercises the built artifact.

Next evaluation runs actual Haiku task attempts against pinned optimized competitor CLIs,
with explicit farm seeds in the benchmark manifest. The farm remains development data; seeded
variants are useful hill-climbing inputs, not a claim of generalization or dominance.
