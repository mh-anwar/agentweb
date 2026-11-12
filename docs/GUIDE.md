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
* **Exit code** 0 all passed, 1 a failure, 2 bad usage.

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

## Your own browser (the extension)

The agentweb browser extension lets an agent work in the Chrome you already use, with your sign-ins,
the way Claude for Chrome or Playwright's extension bridge do. Nothing is copied out of the browser:
no cookies, no storage.

1. `agentweb extension` prints the folder. In `chrome://extensions` switch on Developer mode, press
   "Load unpacked" and choose it. (Any Chromium browser from version 125: Chrome, Edge, Brave, Arc.)
2. The agent starts a task with `engine('mine')`. That session's browser pages now open as tabs in
   your browser, in a tab group named `agentweb`. Other sessions, and this one after `engine('auto')`,
   stay in agentweb's own isolated browser. `AGENTWEB_EXTENSION=1` sends every session to your browser.

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
