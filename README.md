<img src="assets/icon.svg" width="64" height="64" alt="">

# agentweb

A browser built for agents rather than people. It is one MCP tool, `web`, which takes a short
program instead of one click per call:

```
open('shop.example/login'); fill('Email', 'a@b.co'); fill('Password', 'pw'); submit(); find('order status')
```

It answers with a compact text view of the page, bounded by a token budget (2,000 by default), in
which every link and field carries a number for the next step.

- **Cheap:** the median page view is 1.3k tokens. On the same 10 live pages Playwright MCP returns
  10.6k, Chrome DevTools MCP 8.2k and agent-browser 6.3k. The current tool definition is about 730 estimated tokens,
  against 3.9k for Playwright MCP (25 tools) and 6.2k for Chrome DevTools MCP (32 tools).
- **Few turns:** a login-and-look-up task took 1 call and 10.4k input tokens in total, against 4
  calls and 47k for Playwright MCP, with the same model and harness. See [bench/RESULTS.md](bench/RESULTS.md).
- **Fast:** most pages need no browser at all. agentweb fetches them over HTTP and reaches for
  JavaScript only when a page is empty without it (a JS engine without pixels, then real
  Chromium). It escalates on its own and says so in the page header.
- **Scales:** a session is a small JSON record in a store (memory, file, SQLite, Redis), not a
  browser process, so any worker can serve any HTTP-tier session. A shared page cache and a shared
  per-site "atlas" (which engine a site needs, where its search box sends you) mean that what one
  agent learns, all of them reuse.
- **Guarded:** SSRF protection, secrets the model never sees (`{{secret:name}}`), a check that
  stops data read on one site being sent to another, confirmation tokens for purchases and
  transfers, and page lines that read like prompt injections marked with ⚠.

## Install

Needs Node 22.6 or later. Chromium is optional: without it, pages that need JavaScript are shown
from the data embedded in the HTML where possible, and the tool says what it could not do.

```bash
git clone <this repo> agentweb && cd agentweb
npm install
npm run build            # → dist/agentweb.mjs, a single file
node dist/agentweb.mjs doctor
```

**Claude Code**

```bash
claude mcp add agentweb -- node /path/to/agentweb/dist/agentweb.mjs mcp
```

**Claude Desktop, Cursor, Windsurf, any MCP client** (`mcpServers` in the client's config):

```json
{ "mcpServers": { "agentweb": { "command": "node", "args": ["/path/to/agentweb/dist/agentweb.mjs", "mcp"] } } }
```

**Any other agent or tool-calling API:** `agentweb tool --format openai` (or `anthropic`, `mcp`)
prints the tool definition, and `agentweb serve` takes calls over HTTP (below).

**From a shell:** `agentweb run "open('news.ycombinator.com'); find('rust')"`.

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
| `expect('text')` | stop here unless the page contains it |
| `view()` · `links('words')` · `shot()` | whole page again, URLs, screenshot (`full=1`, `pdf=1`, or a target) |
| `js('code')` · `console()` · `network('words', failed=1, body=1)` | run JavaScript in the page; what the page logged and requested |
| `click(t, double=1)` · `click(t, button='right')` · `drag(a, b)` · `forward()` · `dialog('dismiss')` | more input; how alert/confirm boxes are answered |
| `emulate('iPhone 15')` · `emulate(390, 844, locale='fr-FR', tz='Europe/Paris', geo='48.8,2.3', dark=1)` | device, viewport, locale, timezone, location, dark mode; `emulate()` resets |

In the view, `[label]12` is clickable, `{label="value"}13` is fillable, `{label: *A|B}14` is a select and
`{[x] label}15` is a checkbox. Numbers stay valid for the whole session. Calling again on the same page shows only
what changed.

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
| `AGENTWEB_PROFILES=/dir` or `off` | where saved sign-ins live (default `~/.config/agentweb/profiles`): `profile('instructor')` loads `instructor.json`, a Playwright `storageState` file, so files your test suite already writes work as they are; `profile('x', save=1)` saves the session's current sign-in. Values are never shown to the model |
| `AGENTWEB_PROXY=http://host:port` (or `socks5://…`), `AGENTWEB_VIEWPORT=1280x800`, `AGENTWEB_DEVICE='iPhone 15'`, `AGENTWEB_IGNORE_HTTPS_ERRORS=1`, `AGENTWEB_DOWNLOADS=/dir` or `off` | proxy for every engine, default window size and device, accept bad certificates, where downloaded files are kept (default `~/.agentweb/downloads`; the path is shown to the agent) |
| `AGENTWEB_STORE`, `AGENTWEB_BUDGET`, `AGENTWEB_USER_AGENT` | store URL, default budget, user agent |

## How it works

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes the layers. In short: three engines (`wire` HTTP, `ghost` JS without pixels,
`chrome` over CDP) each produce the same light tree; a compiler turns it into flat blocks with inline
actions; a renderer prints a budgeted view with session-stable numbers, collapsing navigation and
boilerplate; readers handle JSON, feeds, CSV, PDF and markdown directly.

Status: v0, under active development. All three engines are implemented. See
[progress and remaining gaps](docs/PROGRESS.md), the [latest benchmark](bench/reports/hill-2026-11-11/README.md),
and [competitive research](docs/research/DIFFERENTIATION.md). Broad reliability and fleet-scale
capacity still need independent validation.

`npm test` runs the local suite with two test workers. Public-provider checks are opt-in with
`npm run test:live`. Chromium is required for the browser integration tests.

---

Created in [T3 Code](https://t3.codes).
