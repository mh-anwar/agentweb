# Competitor parity, second pass

(This worktree did not contain the ranked top-15 list; only the "added" notes of the saved-programs, scheduling,
site-map and doc-reading workstream are here. Merge them under the list's items 9, 10, 13 and 15.)

## Added: named saved programs (Claude in Chrome "shortcuts", agent-browser `flow`)

`program('name', save="…{key}…")`, `program('name', key='v')`, `programs()`, `program('name', show=1|delete=1)`; command line
`agentweb program list|show|save|run|delete`. Stored as `NAME.aw` in `AGENTWEB_PROGRAMS` (default `~/.agentweb/programs`), the
`agentweb test` file format, so `agentweb test --record` output saves as a program (`program save NAME --from out.aw`) and a
program without placeholders runs as a test. Runs inside the caller's run with its guard and budget; nesting limited to 3;
saving refuses a stored secret value. Not done: a program cannot declare default values for placeholders; no versioning.
Compared with agent-browser `flow`: same idea, but the format is the test format and parameters are plain `{name}` text.

## Added: scheduled programs (Claude in Chrome scheduled tasks)

`agentweb schedule add|list|run|log|remove|daemon`, `agentweb serve --schedules`, and a read-only `schedule()` in the tool.
Entries in `~/.agentweb/schedules.json`; runs append `{at, ok, ms, text}` to `~/.agentweb/schedule-logs/NAME.jsonl`; `--on-change`
records only differing runs. Dependency-free cron (5 fields, lists, ranges, steps, names, local time) plus `every 6h`,
`daily 09:00`, `weekdays 08:30`, `weekly mon 09:00`. Deliberately different from Claude in Chrome: an agent can read results
but cannot create or remove schedules; they are only added from the command line, by the user. Limits: one entry at a time, a
missed slot runs once after downtime, no run-history UI, no notifications (an agent or script reads `schedule()` / the log).

## Added: site map and crawl (Firecrawl `map` / `crawl`)

`map(url?, depth=2, max=200, match='/docs/', save=1, fetches=100)` reads robots.txt sitemaps (indexes, `.gz`) else walks
same-origin links breadth-first; prints a count, a path-prefix tree, the first URLs, exclusions and notes. `each(..., crawl=1)`
and `collect(..., crawl=1)` visit the saved map with a coverage receipt (visited/total, skipped by reason, complete).
Respects the guard for every fetch, robots.txt (nothing disallowed is fetched or listed), a fetch cap and a time limit.
Unlike Firecrawl there is no hosted crawl queue or JavaScript rendering of the walk (pages that need scripts are reported as
skipped, not rendered), and the output is a bounded text summary, not a dump of page contents.

## Added: cheap doc reading (agent-browser `read --llms` / `--outline`)

`read(url, outline=1)` and `outline()` show headings with section sizes in tokens; `read('llms')` / `read('llms-full')` open a
site's `/llms.txt` / `/llms-full.txt`; on documentation pages `open` / `read(url)` add a one-line note when the site publishes
one, probed once per origin and remembered a week (kept in the store beside the atlas's records; off when the atlas is off).
