# agentweb vs Playwright: scoreboard

Rerun: `cd bench/vs-playwright && npm install && node run.mjs` (about 25 minutes; `--runs 1 --mutants none --benign none` for a quick look).
What is compared and how: [README.md](README.md). Newest first; losses are reported as losses.

### Corrections after the first full run (2026-11-13 00:50 UTC, same builds)

Four rows of the table below were caused by mistakes in the benchmark, not by either tool. After fixing them, the
affected variants were rerun once per tool:

| Variant | First run | Cause | Rerun: agentweb | Rerun: Playwright |
|:--|:--|:--|:--|:--|
| benign `slow`, `jitter` | Playwright false alarm | my Playwright harness counted requests cancelled by navigation (`net::ERR_ABORTED`) as failures | pass | pass |
| `signout-broken` | both missed | the planted bug still cleared the cookie, so no browser test could see it | caught | caught |
| `axe-unnamed-button` | both missed | the "unnamed" button still had text (⇅), so it had a name | caught | caught |
| `console-error` | agentweb missed | my agentweb suite checked the console only at the end of the test, after a `profile()` switch (Playwright's checked each page); now `console=0` on each page. The end-of-test check losing earlier pages' errors after `profile()` is an agentweb bug to fix | caught | caught |
| `tap-small` | agentweb missed | **a real difference**: agentweb's `audit='target'` applies WCAG 2.5.8's spacing exception (an 18 px button with empty space around it passes); Clockwork's and this Playwright harness flag anything under 24 px. Needs a strict rule in agentweb | missed | caught |

**Corrected totals: bugs caught agentweb 23/24, Playwright 24/24; false alarms 0/5 both.** Wall time is still a loss
for agentweb (8.4 s vs 6.6 s median); CPU (−16%), memory (−52%), failure output (−57%) and test code (−70% lines)
are wins.

### 2026-11-13 00:21 UTC · 5 clean runs per tool · 2 workers · 24 planted bugs · 5 benign variants

| Metric | agentweb (0.1.0+037b68c) | Playwright 1.65.0 |
|:--|--:|--:|
| Wall time, median (s) | 8.4 (7.6–8.6) | 6.6 (6.6–6.8) ✓ |
| CPU time, median (s) | 11.8 ✓ | 14.0 |
| Peak memory, median (MB) | 861.5 ✓ | 1801.2 |
| Clean runs passed | 5/5 | 5/5 |
| Flaky tests (pass and fail across runs) | 0/9 | 0/9 |
| False alarms on benign variants | 0/5 ✓ | 2/5 |
| Planted bugs caught | 20/24 | 22/24 ✓ |
| …with the cause named in the output | 19/24 | 20/24 ✓ |
| Failure output, median (chars) | 1274.0 ✓ | 2966.5 |
| Test code (lines) | 63 ✓ | 212 |
| Test code (characters) | 3739 ✓ | 10298 |

- agentweb test: missed signout-broken, tap-small, console-error, axe-unnamed-button; false alarms none; flaky none.
- Playwright Test: missed signout-broken, axe-unnamed-button; false alarms slow, jitter; flaky none.
- Raw data: `results/raw/2026-11-13T00-21-30.json`. ✓ marks the better value.
