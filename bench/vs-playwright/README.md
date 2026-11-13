# agentweb vs Playwright

The question this answers: is `agentweb test` better than Playwright Test for a real app's browser tests, and
by how much? Results: [RESULTS.md](RESULTS.md). Rerun:

```bash
cd bench/vs-playwright && npm install
node run.mjs                         # 5 clean runs per tool, every benign variant, every planted bug (~25 min)
node run.mjs --runs 1 --mutants none --benign none     # a quick look
AGENTWEB_CLI=~/.local/share/agentweb/current/dist/agentweb.mjs node run.mjs   # the installed build instead of ../../dist
```

## What is compared

- **The app** (`app/server.mjs`): a small staff app shaped like the Clockwork journeys. Sign-in with an error
  message, a "Report a problem" dialog (focus, toast, dialog closes, instructor reads it), a students form
  (validation, a table row, a count, persisted after reload), a setting that changes another page, a parent sign-up
  with a code sent by email (a Mailpit-shaped API), a photo upload, a role menu, phone and desktop widths. Pages
  render a skeleton and fill it from script, as a hydrating React app does.
- **The suites**: the same 9 journeys written idiomatically in each tool. `playwright/` follows Clockwork's
  `e2e/` style (role locators, a `checkDesign` helper with axe, overflow, tap targets, console and failed requests);
  `agentweb/journeys.aw` uses the built-in equivalents. Shared infrastructure (`app/world.mjs`: a fresh center and
  two signed-in users per test) is used by both and not counted in either's size.
- **Planted bugs** (`mutants.mjs`, 24): each is one realistic defect, switched on with `MUTANT=name`: security
  (wrong password accepted, sign-out keeps the session, staff can open an instructor page), behaviour (no toast,
  dialog stays open, report not saved, no validation, count off by one, not persisted, API 500 hidden by an
  optimistic UI, setting lost, wrong code emailed, no email, upload ignored), and design (sideways scroll on a phone,
  an 18 px tap target, a script error, a missing stylesheet, no main heading, an unnamed icon button, a page with a
  different menu, a dialog that does not focus its text box). A suite that passes on a planted bug missed it.
- **Benign variants** (5): the app is correct but awkward: every API call takes 1.2 s, random latency, every class
  name changed plus extra wrappers, a dialog animation, toasts that vanish after 1.5 s. A failure here is a false alarm
  (a flaky or brittle test).

## Metrics

| Metric | How |
|:--|:--|
| Wall time, CPU time, peak memory | the whole process tree of the tool (runner, browsers, renderers), sampled from `/proc` every 50 ms; median of the clean runs; the app server is not counted |
| Pass rate, flaky tests | clean runs: a test that passed in some runs and failed in others is flaky |
| False alarms | benign variants where the tool failed |
| Bugs caught | planted bugs where the tool failed |
| Cause named | the failure output (the terminal, nothing opened) matches a pattern for that bug's cause, e.g. `overflow\|sideways` or `Name is required` |
| Failure output | characters printed on a failing run |
| Test code | non-blank, non-comment lines and characters of the test files (Playwright: specs, harness and config) |

Both tools run with the same number of workers (2), headless Chromium, a fresh app per run, and tool order
alternating between runs. agentweb runs with `AGENTWEB_TEST_MEMORY=0` (no engine memory carried between runs), which
is its slowest setting. Clockwork's own suite is the real-world half: its numbers come from the Clockwork thread
(`scripts/agentweb/compare.mjs` there) and are copied into RESULTS.md with the date and build.

## Honest limits

- The journeys and the bugs were written by the same author (agentweb's developer). The Playwright suite follows
  Clockwork's real specs closely to keep it idiomatic, and every planted bug is something those specs check for.
- 24 bugs is a small sample; "caught" depends on what the journeys assert, which is the same in both suites by design,
  so this measures whether each tool can express and reliably run those assertions, not test design.
- Single machine, shared with other users: wall time is noisy; compare medians and ranges, not single runs.
