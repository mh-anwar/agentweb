# agentweb guide

The full reference: install options, the program language, testing, collections, running many
agents, configuration and how it works. For the quick start, see the [README](../README.md).

## Install

Needs Node 22.6 or later. Chromium is optional: without it, pages that need JavaScript are shown
from the data embedded in the HTML where possible, and the tool says what it could not do.

```bash
npx -y github:mh-anwar/agentweb setup
```

`setup` finds the coding agents on the machine by their config folders and adds an MCP server named
`agentweb` to each: Claude Code, Claude Desktop, Codex, Cursor, VS Code (Copilot), Windsurf, Gemini CLI,
opencode and GitHub Copilot CLI. It prints what it changed and what each agent needs to pick it up.

- Each config file is parsed, only the `agentweb` entry is added or replaced, and a backup
  (`<file>.agentweb-backup`) is written before the first change. A file that does not parse (comments,
  a syntax error) is left alone and the entry to add by hand is printed.
- Run from `npx`, it copies itself to `~/.agentweb/app` first, so the registered path stays valid.
- It writes a launcher, `~/.agentweb/bin/agentweb`, for agents without MCP and for shell use.
- `--agent cursor,codex` limits it (`--agent all` writes every known config even if the agent was not
  found), `--dry-run` shows what would change, `agentweb uninstall` removes the entries.

From a checkout: `git clone … && cd agentweb && npm install && node dist/agentweb.mjs setup`
(`npm install` builds `dist/`). `agentweb doctor` says which engines work on the machine.

**Any other MCP client** (`mcpServers` in the client's config):

```json
{ "mcpServers": { "agentweb": { "command": "node", "args": ["/path/to/agentweb/dist/agentweb.mjs", "mcp"] } } }
```

**Any other agent or tool-calling API:** `agentweb tool --format openai` (or `anthropic`, `mcp`)
prints the tool definition, and `agentweb serve` takes calls over HTTP (below).

**From a shell:** `agentweb run "open('news.ycombinator.com'); find('rust')"`.

### Reporting a bug

An agent that finds agentweb itself getting something wrong (a control missing from the view, a click
that does nothing, a wrong result) reports it in one step:

- in a program: `bug('expected the dialog to open | click reported no visible change')`. Alone in a
  call it reports the previous call; with other steps, that call.
- from a shell: `agentweb bug "<site> | <program> | <expected> | <got>" [--engine chrome|ghost|wire]`

Saved: the program as written, the engine, the status lines agentweb printed (errors and notes) and
the agentweb version. Never the page. Values typed into password, token, card and similar fields are
replaced, as are e-mail addresses, long random strings and URL query values. Reports go to
`bugs.jsonl` next to the usage log (`AGENTWEB_USAGE_LOG`), or `~/.agentweb/bugs.jsonl`;
`agentweb bugs [--days N] [--json]` lists them. `agentweb report "<site> | <task> | <why>"` is for the
other case: the agent gave up on agentweb for a task and used another browser.

## The language

| Step | What it does |
|:--|:--|
| `open(url)` · `back()` · `search('query')` · `search('query', site='shop.example')` | go somewhere; `site=` uses that site's own search |
| `find('words')` | only the lines of this page that match |
| `records('words', pages=3)` | the page's list items (products, results, rows), one per line, following "Next" |
| `collect(name='link', price='money', pages=3)` | JSON rows, source evidence, validation errors, deduplication and explicit coverage |
| `each('link words', find='words', n=8)` | open matching links at once; show the matching lines of each |
| `read()` · `read('Section')` · `read(url)` | full text, continuing where the view stopped |
| `click(t)` · `fill(t, 'text')` · `select(t, 'opt')` · `check(t)` · `submit()` · `press('Enter')` | act; a target `t` is a number from the page or its visible text |
| `expect('text')` · `expect('Item', n=3)` · `expect(not='Error')` · `expect(url='/cart')` · `expect(title='Cart')` | stop here unless the page matches (see Testing) |
| `view()` · `links('words')` · `shot()` | whole page again, URLs, screenshot (`full=1`, `pdf=1`, or a target) |
| `js('code')` · `console()` · `network('words', failed=1, body=1)` | run JavaScript in the page; what the page logged and requested |
| `click(t, double=1)` · `click(t, button='right')` · `drag(a, b)` · `forward()` · `dialog('dismiss')` | more input; how alert/confirm boxes are answered |
| `emulate('iPhone 15')` · `emulate(390, 844, locale='fr-FR', tz='Europe/Paris', geo='48.8,2.3', dark=1)` | device, viewport, locale, timezone, location, dark mode; `emulate()` resets |
| `tabs()` · `tab('new', url)` · `tab(2)` · `tab('close')` · `tab('close', 2)` | several pages open in one session; they share its cookies, each keeps its own page, history and live state (at most 8) |
| `engine('mine')` · `engine('auto')` | work in the user's own browser with their sign-ins (needs the browser extension, below); back to isolated browsing |
| `bug('expected \| what happened')` | report a bug in agentweb itself (see Install) |

In the view, `[label]12` is clickable, `{label="value"}13` is fillable, `{label: *A|B}14` is a select and
`{[x] label}15` is a checkbox. Numbers stay valid for the whole session. Calling again on the same page shows only
what changed.

## Testing with agentweb

`agentweb test` runs end-to-end tests written in the same tiny language, with no model and no browser
install for server-rendered pages. A passing run is one line; a failure is four facts and a few lines of
the page, never a trace.

```
# tests/shop.aw
# base: http://localhost:3000
# profile: parent                    (a saved sign-in, see profile())

## search finds keyboards
open('/shop'); fill('Search', 'keyboard'); click('Go')
expect(url='search'); expect('keyboard'); expect(not='No products found')

## cart is empty at first
open('/shop/cart'); expect('Your cart is empty')
```

The same test in Playwright, and what each prints when `expect('Order placed')` fails:

```ts
test('cart is empty at first', async ({ page }) => {
  await page.goto('/shop/cart');
  await expect(page.getByText('Order placed')).toBeVisible();
});
```

```
✗ checkout  tests/shop.aw:9                  Playwright: 25 lines, 279 tokens, 5 s wait,
  step:  expect('Order placed')              plus a 1,981-token error-context.md it tells you to read
  error: 'Order placed' is not on the page
  page:
    Your cart — Tradewind Store — http://127.0.0.1:4611/shop/cart
    # Shopping cart
    Your cart is empty. [Continue shopping]25.
```

That is 81 tokens, instantly. On an ambiguous click the numbers are 666 vs 262 (Playwright's page snapshot adds
another 7,125). Measurements and method: [docs/research/TESTING.md](research/TESTING.md).

```bash
agentweb test                          # ./tests/**/*.aw, 3 tests in parallel
agentweb test tests/shop.aw --base http://localhost:3000 --grep cart --bail --json
agentweb test --record tests/login.aw "open('/login'); fill(4,'bob'); submit(); expect('Welcome')" --base http://localhost:3000
```

* **Files.** `*.aw` / `*.awtest`; steps one per line or `;`-separated; `## name` starts a test; headers `# base:`,
  `# profile:`, `# timeout:`, `# skip:` (file level, or per test after its `##`). Relative `open('/x')` resolves
  against `--base` / `AGENTWEB_BASE` / `# base:` (in that order).
* **Isolation.** Every test starts from an empty session (no cookies, no history; a `profile` is loaded first).
  Pages are never served from the shared cache.
* **Assertions.** `expect('text')`, `expect('Item', n=3)`, `expect(not='Error')`, `expect(url='/dashboard')`
  (`/path` matches the path, `*` is a glob, anything else a substring), `expect(title='Cart')`; combine freely.
* **Auto-wait.** On a page that runs scripts, `expect` (every form) looks again every 250 ms until it holds or
  5 s pass (`expect('x', timeout=10)`, or `# timeout: 10` for a whole test), moving the page to a script engine
  first if it was fetched without one. Plain server-rendered pages are checked once, immediately.
* **Targets.** `click`/`fill` match a control's label, placeholder, `aria-label` or `title`.
* **Snapshots.** `snapshot('name')` compares the page's text view (ports and engine tags removed) with
  `__aw_snapshots__/<file>/<test>.<name>.txt`. A missing baseline is written (`--ci` fails instead); a change shows
  a few `-`/`+` lines; `--update` accepts it.
* **Record.** `--record out.aw "program"` runs the program and, if it passes and passes again in a fresh session,
  saves it with numbered targets replaced by their visible labels and URLs made relative to `--base`.
* **Engines.** A test runs on the cheapest engine that can do it: `wire` (plain HTTP, no scripts), `ghost`
  (the page's scripts, no real browser) or `chrome`. A pass without a real browser is a weaker check, so the
  summary always says which engines ran (`✓ 17 passed (5.2s; ghost 12, chrome 5)`), `--verbose` says it per test
  (`[wire→ghost]`, with any device, viewport or timezone that was emulated) and `--json` carries `engine`,
  `engines` and `emulation` for each test. `# engine: chrome` at the top of a file (or under one `##` test), or
  `--engine chrome` for a whole run, makes every page load in that engine. `emulate(...)` with a viewport, locale
  or timezone needs a real browser and moves the test to one. `--no-ghost` and `--no-chrome` switch an engine off;
  an option the runner does not know is an error, not ignored.
* **Real-browser cost.** One browser serves the whole run; each test gets its own isolated context, closed the
  moment the test ends, so a suite holds as many pages as it has workers. `--verbose` and `--json` report the CPU
  and peak memory of the whole process tree (runner, browser, renderers), sampled from `/proc` on Linux; a
  browser that is killed at the end is counted too, which `getrusage(RUSAGE_CHILDREN)` in a wrapper misses.
* **Readiness.** On a page with scripts `expect(...)` waits until it holds, so assert on something only the
  finished page shows (`expect('Visits today')`, `expect(url='/dashboard')`) before clicking; there is no separate
  "hydrated" step to get wrong. A redirect written into the page (`<meta http-equiv=refresh>`, which Next.js
  streams when a server component redirects) is followed on every engine, so `expect(url=...)` gives the same
  answer on all of them. A failing `expect` on an HTTP-only page re-opens it with scripts before giving up, which
  is why one failure can start a browser.
* **Setup, teardown and commands.** What the page language cannot express is a shell command:

  ```
  # setup: node scripts/seed.mjs            (top of the file: once before its first test)
  # teardown: node scripts/unseed.mjs       (once after its last)
  ## sign in with a one-time code
  # setup: node scripts/reset-mailbox.mjs   (under a test: before that test)
  open('/login'); fill('Email', '${email}'); submit()
  exec('node scripts/otp.mjs ${email}', as='otp', retry=10)
  fill('Code', '${otp}'); submit(); expect('Welcome')
  ```

  `name=value` lines (or one JSON object) that a setup command prints become `${name}` in the file's tests;
  `exec('cmd', as='name')` keeps a command's output, and `retry=10` runs it again for up to 10 s until it
  succeeds (a mail that has not arrived yet). Commands get `AGENTWEB_BASE`, `AGENTWEB_TEST_FILE`,
  `AGENTWEB_TEST_NAME` and every variable as `AW_<NAME>`. A failing command fails the test with its last lines.
  They exist only in `agentweb test` (files you wrote); the agent tool has no way to run a command, and
  `--no-exec` refuses them.
* **Exit code** 0 all passed, 1 a failure, 2 bad usage.

## Controlling the network (mock, headers, credentials, throttle)

Everything here is kept in the session record, so it survives the browser page being evicted and re-created, and it is a
short step in a program:

```
route('*/api/cart*', status=500, body='boom')      # the page's fetch sees a 500 "boom"
route('*/api/user', json='{"name":"x"}')           # JSON, with the right content type
route('*.png', abort=1)                            # the request fails (abort='timedout' | 'connectionrefused' | …)
route('*/api/*', off=1)  ·  route(off=1)           # remove one  ·  remove all
routes()                                           # newest first, with hit counts
headers('X-Debug: 1', 'Accept-Language: fr')       # on every request, every tier;  headers(off=1)
auth('alice', '{{secret:lab_pw}}')                 # answers HTTP basic 401 challenges;  auth(off=1)
init('window.__TEST__ = true')                     # before every new document's own scripts;  init(off=1)
emulate(throttle='slow3g', cpu=4, motion='reduce', contrast='more', forced_colors=1, permissions='clipboard-read,notifications')
wait(url='/dashboard') · wait('Saved', 'Failed') · wait(gone='Loading') · wait(12, state='hidden') · wait('Go', state='enabled')
drop('Upload area', 'report.csv')                  # dragenter, dragover, drop with the file
network(har='trace')                               # the page's network log as a HAR 1.2 file under the downloads folder
```

* **Routes** are globs on the full URL: `*` and `**` match anything, `?` one character, `{png,jpg}` alternatives; `/api/*` and
  `host/path` are completed to `*/api/*` and `*://host/path`. The newest matching route wins. Options: `status`, `body`,
  `json`, `type` (content type), `method`, `delay` (ms). Mocks add CORS headers for cross-origin pages. Routes are
  answered by the Chrome engine, so a session with routes loads its pages there (and says so in a note; removing the last
  route or init script lifts a pin that route() set). A mock replaces the network only: the guard's URL policy still decides
  first for navigations, redirects and sub-requests, so a denied host stays denied.
* **Headers** apply to the HTTP tier, the script engine and Chrome. A request's own headers win over them. `Accept-Language`
  overrides the browser's. Listing masks `Authorization`, `Cookie` and token-like names. Secret handles are not supported in
  headers (use `auth()` or `fill()`).
* **Credentials.** `auth(user, pass)` answers a `401` with `WWW-Authenticate: Basic` once, then sends the credentials at
  once to that origin. By default only the page's own origin is answered (a page cannot make a third-party sub-request ask
  for the password); `auth(user, pass, origin='https://x.example')` names the origin instead. The password may be a
  `{{secret:name}}` handle, revealed only for an origin the secret is bound to; it is never printed. A password typed
  literally is kept in the session record, so prefer a handle.
* **Waiting.** `wait('text')` and `wait(2)` are unchanged. The variants hold until all their conditions do: the URL contains
  the string (or matches it when it has a `*`), any one of several texts appears (the note says which), text is gone, a
  numbered or named target is `visible`, `hidden` (absent counts) or `enabled`. `timeout=` (seconds) caps the wait. A timeout
  names what was awaited and the start of what the page says instead.
* **Emulation** adds `throttle` (`slow3g`, `fast4g`, `off`), `cpu` (slowdown factor 1 to 20), `motion='reduce'`,
  `contrast='more'`, `forced_colors=1` and `permissions` (granted to the session's pages; skipped when attached to your own
  profile with `AGENTWEB_CDP_SHARED`). They persist like the other `emulate()` options.
* **Init scripts** run in the page's own world on every new document of the session, so a script added to a page that is
  already open applies from the next load (`reload()`). They need the same permission as `js()` and are refused in
  read-only mode.
* **Dropping files** reads from the downloads folder, `AGENTWEB_FILES` (a path list) and the working directory, never
  through hidden folders or files, at most 8 MB (`drop('zone', 'a.txt', text='inline')` needs no file).
* Not covered by headers/auth/route: the Firefox and WebKit engines, and `engine('mine')` (the user's own browser).

## Verified collections and semantic changes

```
open('shop.example/catalog'); collect(name='link', price='money', href='url', pages=5)
```

`collect` extracts repeated lists, table rows and cards without a model call. Name 1–12 fields
using `text` (whole row), `link` (link label), `url` (link destination), `money` (currency-prefixed
number), or `number`. Missing or ambiguous values are `null` with per-field errors. Every extracted
value includes the source quote; every row includes its page URL and block hash. Monetary numbers
use US/UK punctuation; `currencies` retains the observed marker ($ is not assumed to mean USD).
Numbers that exceed the safe range or fail an exact decimal round trip become invalid, rather
than silently rounding. Currency markers participate in semantic comparisons. Leading refund signs and qualified markers
such as CA$ are preserved. Unsupported space-grouped or accounting notation is rejected as a whole.

Always inspect `coverage.complete`: page limits, HTTP errors, cycles, missing records, truncation,
validation failures and token limits are explicit. Completeness covers recognized records and
observable Next links, not hidden server data. Dynamic lists are reported as unverified. A short
unrecognized card grid is incomplete rather than guessed. `pages` is an integer from 1 to 10.
Output rows are never cut mid-JSON; raise `budget` when the coverage receipt itself cannot fit.

Add `diff='catalog', key='href'` (with `href='url'` in the schema) to save a private session baseline.
Later calls report added keys, removed keys, and exactly which fields changed, ignoring row order
and markup changes. Incomplete results never advance the baseline or report removals. Schema or
starting-URL changes reset it. Duplicate keys withhold comparisons. Each session retains at most
four baselines, each bounded to 256 records / 64KB, with the session's normal expiry. There are no
background watchers or extra browser processes.

## Saved programs

```
program('price-check', save="open('shop.example'); find('{item}')")   # store it
program('price-check', item='usb hub')                                 # run it
programs()                                                             # names, placeholders, first step
program('price-check', show=1)    program('price-check', delete=1)
```

A saved program is a plain file, `NAME.aw`, in `AGENTWEB_PROGRAMS` (default `~/.agentweb/programs`), in the same
format `agentweb test` reads (`# name:`, `# base:`, `# profile:` headers, then steps one per line or `;`-separated).
`{word}` in a step is a placeholder; `program('x', word='…')` fills it, case-insensitively, and a value that contains a
quote or `;` stays one argument instead of becoming another step. A missing placeholder is an error that lists the
placeholders. `{{secret:name}}` handles are not placeholders. `# base:` makes `open('/x')` relative to a site; `# profile:`
loads a saved sign-in first.

A stored program runs inside the caller's run: same session, same guard, same budget. It gets no extra rights (a
refused address is refused inside a program too), and saving refuses text containing a stored secret value. Programs may
call programs, three deep; a program calling itself ends at that limit. A failure names the program and step.

```
agentweb program list | show NAME | delete NAME
agentweb program save NAME "open('shop.example'); find('{item}')"
agentweb program save NAME --from out.aw        # a recording from: agentweb test --record out.aw "<program>"
agentweb program run NAME item='usb hub' --session S --budget N
agentweb test ~/.agentweb/programs/NAME.aw      # a program without placeholders is also a test
```

## Scheduled programs

```
agentweb schedule add price-watch "every 6h" "price-check" --on-change      # a program name, or program text
agentweb schedule add morning "weekdays 08:30" "open('news.example'); find('outage')" --session news
agentweb schedule list | run NAME | log NAME --n 5 | remove NAME
agentweb schedule daemon              # a foreground loop that runs what is due; agentweb serve --schedules does it in the server
```

`when` is a 5-field cron expression in local time (`*`, lists, ranges, steps, month and weekday names; when both
day fields are restricted a day matches if either does), `every 30m|6h|2d`, `hourly`, `daily 09:00`, `weekdays 08:30` or
`weekly mon 09:00`. Entries live in `~/.agentweb/schedules.json`; each run appends `{at, ok, ms, text}` (text capped at
4000 characters) to `~/.agentweb/schedule-logs/NAME.jsonl`. Runs share the session's cookies, but every run starts with
no page open and nothing "already shown", so output is comparable from run to run. `--on-change` records only runs whose
output differs from the previous run's, marked `"changed": true` (the first run counts as changed). After downtime an
entry runs once, not once per missed slot, and the daemon runs one entry at a time.

In the tool, `schedule()` lists the entries and what their last run found, and `schedule('name', n=3)` shows the last runs.
An agent **cannot** add, change, run or remove a schedule: that would let it give itself standing tasks. `schedule('add', …)`
is refused with the command line to ask the user to run.

## Mapping a site and crawling it

```
map('docs.example.com')                       # or map() for the site of the current page
map('docs.example.com', match='/docs/', max=500, depth=2, save=1)
each('install', find='npm', crawl=1, n=10)    # the lines matching 'npm' on the mapped pages whose URL mentions 'install'
collect(name='link', price='money', crawl=1, max=30)
```

`map` reads `robots.txt` for `Sitemap:` lines (else `/sitemap.xml`), follows sitemap indexes and `.xml.gz` files, and
when the site has no sitemap walks same-origin links breadth-first (`depth=2` hops, at most `fetches=100` pages and 45 s,
session cookies sent). It prints a count, a tree by path prefix with counts, the first URLs, what was left out and why
(`robots`, `other_origin`, `policy`, `http_error`, `fetch_cap`, …), and notes saying whether the map is complete. URLs that
`robots.txt` disallows are neither fetched nor listed; the guard checks every request; other origins are never followed.
`max` (default 200, up to 5000) is how many URLs are kept; the count shows how many were found.

`save=1` keeps the list with the session, and `crawl=1` (or `from='map'`) makes `each` and `collect` visit those URLs instead
of the links on the current page. `each` takes `n` (up to 40) and filters URLs by words; `collect` takes `max` (up to 100) and
all of its usual fields, `pages` and `diff`. Both end with a receipt: `coverage.visited` / `total`, `skipped` by reason
(`limit`, `http_error`, `javascript_required`, `policy`, `error`, `time`) and `complete`, which is true only when every URL
of a complete map was visited and read cleanly. Pages are fetched through the same guard as any `open`.

## Reading documentation cheaply

```
read('docs.example.com/guide', outline=1)     # headings with the size of each section, nothing else
read('Configure')                              # then just that section
read('llms')                                   # this site's /llms.txt (read('llms-full') for /llms-full.txt)
```

`outline()` and `read(url, outline=1)` show each heading with its size in tokens (a section includes its subsections);
when the outline does not fit the budget the deepest headings go first. On pages that look like documentation (a `docs.` /
`developer.` host, or `/docs/`, `/guide/`, `/api/`… in the path) `open` and `read(url)` check once per origin whether the site
publishes `/llms.txt` or `/llms-full.txt` (remembered for a week; with the atlas off, `AGENTWEB_ATLAS=0`, nothing extra is
fetched) and add a one-line note saying so, once per session and site.

## Running it for many agents

```bash
agentweb serve --port 4455 --workers 8 --store redis://localhost:6379 --keys k1=team-a,k2=team-b
```

This serves MCP (Streamable HTTP) at `/mcp` and REST at `POST /v1/run` with
`{ "run": "...", "session": "..." }`. Workers share sessions and the page cache through the store.

## Configuration

| Variable | Meaning |
|:--|:--|
| `AGENTWEB_SECRET_<NAME>=value`, `AGENTWEB_SECRET_<NAME>_ORIGINS=https://site.com` | a credential the agent can type as `{{secret:name}}`, only on those origins |
| `AGENTWEB_ALLOW` / `AGENTWEB_DENY` | host patterns |
| `AGENTWEB_READ_ONLY=1` | refuse form submissions, POSTs and script-driven clicks |
| `AGENTWEB_CONFIRM=never\|consequential` | ask for a confirmation token before purchases, transfers and deletions (default `consequential`) |
| `AGENTWEB_FLOW=off\|warn\|block` | cross-site data-flow check |
| `AGENTWEB_CHROME=/path/to/chrome`, `AGENTWEB_CDP=ws://…` | use this Chromium, or attach to a running one |
| `AGENTWEB_BROWSER=chrome\|firefox\|webkit` | the real browser pages escalate to (default `chrome`). Firefox and WebKit (Safari's engine) need `npm i playwright-core` and `npx playwright-core install firefox webkit`; any session can also pick one with `engine('firefox')`, `engine('webkit')` or `engine('safari')`. When a real browser is shown a bot wall on an automatic open, the next installed browser gets one try |
| `AGENTWEB_PROFILES=/dir` or `off` | where saved sign-ins live (default `~/.config/agentweb/profiles`): `profile('instructor')` loads `instructor.json`, a Playwright `storageState` file, so files your test suite already writes work as they are; `profile('x', save=1)` saves the session's current sign-in. Values are never shown to the model |
| `AGENTWEB_PROXY=http://host:port` (or `socks5://…`), `AGENTWEB_VIEWPORT=1280x800`, `AGENTWEB_DEVICE='iPhone 15'`, `AGENTWEB_IGNORE_HTTPS_ERRORS=1`, `AGENTWEB_DOWNLOADS=/dir` or `off` | proxy for every engine, default window size and device, accept bad certificates, where downloaded files are kept (default `~/.agentweb/downloads`; the path is shown to the agent) |
| `AGENTWEB_CDP_SHARED=1` | with `AGENTWEB_CDP`: open pages in that browser's own profile, see below |
| `AGENTWEB_GOOGLE_CSE_KEY` + `AGENTWEB_GOOGLE_CSE_CX` | a Google Programmable Search API key and engine id: `search()` then uses Google's results through the official API |
| `AGENTWEB_STORE`, `AGENTWEB_BUDGET`, `AGENTWEB_USER_AGENT` | store URL, default budget, user agent |
| `AGENTWEB_HOME=/dir`, `AGENTWEB_PROGRAMS=/dir` | where state lives (default `~/.agentweb`: `schedules.json`, `schedule-logs/`, `programs/`) and where saved programs live |

## Your own browser (the extension)

The agentweb browser extension lets an agent work in the Chrome you already use, with your sign-ins,
the way Claude for Chrome or Playwright's extension bridge do. Nothing is copied out of the browser:
no cookies, no storage.

1. `agentweb extension` prints the folder. In `chrome://extensions` switch on Developer mode, press
   "Load unpacked" and choose it. (Any Chromium browser from version 125: Chrome, Edge, Brave, Arc.)
2. The agent starts a task with `engine('mine')`. That session's browser pages now open as tabs in
   your browser, in a tab group named `agentweb`. Other sessions, and this one after `engine('auto')`,
   stay in agentweb's own isolated browser. `AGENTWEB_EXTENSION=1` sends every session to your browser.

`tab('shared')` takes over a tab you shared from the toolbar button and gives it back, still open, with
`tab('close')`. `handoff('Please sign in')` is for what only you can do (a sign-in, a captcha, a two-factor
prompt): the tab comes to the front with a notification, the agent waits until the page changes, then
carries on. In agentweb's own windowless browser `handoff` says nobody can see the page and points to
`engine('mine')`.

What the agent can touch: tabs it opened, and tabs you share with the toolbar button ("Share this tab
with the agent"). The toolbar icon shows how many tabs an agent is using; "Stop the agent" takes them
all back at once and keeps the extension off until you switch it on again. Chrome shows its
"is debugging this browser" bar while a tab is in use; that is Chrome's own notice.

How it connects: the extension dials out to a small hub on `127.0.0.1:4466`
(`AGENTWEB_EXTENSION_PORT`, and the same port in the extension's popup) that the first agentweb
process to need it starts; other agentweb processes join it. The hub accepts DevTools connections only
with a token kept in `~/.agentweb/bridge.json` (readable by you alone) and refuses any connection that
carries a web page's `Origin`, so a site cannot reach it. `agentweb bridge` runs the hub by itself and
prints who is connected. The guard still applies: `AGENTWEB_ALLOW` / `AGENTWEB_DENY`, confirmations
before purchases and transfers, and the prompt-injection flags. An agent acting in your browser acts
as you, so keep the allow list as narrow as the work needs.

## Bot walls and Google

Some sites, and above all search engines, refuse automated visitors, and an address that has made many automated requests
gets flagged. Google's `/sorry` captcha is the common case: from a flagged address it is shown to every engine, agentweb's
included. agentweb detects walls and tells the agent plainly; it does not solve captchas or evade detection with stealth
patches. What does work:

- **`search('...')` never needs Google's own pages.** It asks keyed APIs first (Brave API, SearXNG, Serper, Tavily, and
  Google's Programmable Search JSON API with `AGENTWEB_GOOGLE_CSE_KEY` and `AGENTWEB_GOOGLE_CSE_CX`), then Bing, Brave,
  DuckDuckGo, Yahoo, Seznam and Mwmbl. A provider that answers with a wall (429, an anomaly page, a captcha) is skipped
  for about 15 minutes. If an agent `open()`s a Google, Bing or DuckDuckGo results URL and gets a wall, agentweb answers with
  its own `search()` results for the same query and says so on the page; if that finds nothing it reports that the engine is
  walling this address and suggests `search('...')`.
- **Your own proxy.** `AGENTWEB_PROXY=http://host:port` (or `socks5://...`) sends every engine through a proxy you supply, for
  example one on a different network. agentweb does not provide one.
- **Your own Chrome.** A browser you use every day has history, logins and a clean reputation. Start it with a debugging port
  (use a separate `--user-data-dir` if your Chrome is already running, since Chrome needs one for the port to open):

  ```sh
  google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.config/chrome-agent"
  AGENTWEB_CDP=http://127.0.0.1:9222 agentweb ...
  ```

  By default agentweb gives each session an isolated, empty context in that browser, so your logins are not visible. Add
  `AGENTWEB_CDP_SHARED=1` to open pages in the browser's default context instead: your cookies and signed-in sessions are
  live, and the agent can act as you on those sites. This is opt-in, prints a warning at start-up, and adds a note to pages.
  agentweb opens its own tabs and closes only those; it never closes the browser or your tabs. It does not copy your cookies
  or storage into the session, and downloads follow the browser's own settings. Treat it like handing someone your unlocked
  laptop, and keep `AGENTWEB_ALLOW` narrow.
- **Consistent headless browser.** The browser agentweb launches reports `navigator.webdriver` as false and sends client hints
  (`navigator.userAgentData`) that match its user agent. That removes contradictions; it is not a disguise, and strict
  bot filters can still tell.

## How it works

[docs/ARCHITECTURE.md](ARCHITECTURE.md) describes the layers. In short: three engines (`wire` HTTP, `ghost` JS without pixels,
`chrome` over CDP) each produce the same light tree; a compiler turns it into flat blocks with inline
actions; a renderer prints a budgeted view with session-stable numbers, collapsing navigation and
boilerplate; readers handle JSON, feeds, CSV, PDF and markdown directly.

Status: v0, under active development. All three engines are implemented. See
[progress and remaining gaps](PROGRESS.md), the [latest benchmark](../bench/reports/hill-2026-11-11/README.md),
and [competitive research](research/DIFFERENTIATION.md). Broad reliability and fleet-scale
capacity still need independent validation.

`npm test` runs the local suite with two test workers. Public-provider checks are opt-in with
`npm run test:live`. Chromium is required for the browser integration tests.

---

Created in [T3 Code](https://t3.codes).
