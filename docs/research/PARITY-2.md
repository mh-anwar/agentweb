# Parity round 2: gaps against products PARITY.md did not cover, and newer versions of those it did

Date of research: 2026-11-11. Method: primary docs fetched with agentweb itself (README / docs pages, URL given per row),
agentweb side checked by grep over `docs/GUIDE.md`, `src/tooldoc.ts`, `src/runtime.ts`, `src/dsl.ts`, `src/cli.ts`.
Items PARITY.md marks HAS or FIXED are not repeated unless a competitor goes further.
Status: MISSING, PARTIAL, N/A (reason). Priority is how often a person using an agent to browse or test would miss it.
**Not verified** is written wherever I could not open a primary source in this pass; those rows come from background
knowledge and must be re-checked before anyone builds against them. The grep for agentweb is shallow: a verb that exists
under another name could be missed.

Sources used (all fetched 2026-11-11 unless marked):
- CIC-start: https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome
- CIC-perm: https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide
- CIC-code: https://code.claude.com/docs/en/chrome
- PW: https://raw.githubusercontent.com/microsoft/playwright-mcp/main/README.md
- AB: https://agent-browser.dev/commands and https://raw.githubusercontent.com/vercel-labs/agent-browser/main/README.md
- CDT: https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/tool-reference.md
- SH: https://docs.stagehand.dev/v3/basics/agent
- BB: https://docs.browserbase.com/welcome/what-is-browserbase
- BU: https://raw.githubusercontent.com/browser-use/browser-use/main/README.md
- FC: https://docs.firecrawl.dev/introduction

## 1. Claude in Chrome (extension, side panel, Claude Code / Cowork bridge)

What it is: an extension that drives the user's own Chrome through the `debugger` permission (CIC-start), reachable from the
side panel, Claude Cowork and Claude Code (`claude --chrome`, CIC-code). Tool list: CIC-code says to see it under
`/mcp` > claude-in-chrome > View tools; I could not read that list. Only `tabs_context_mcp` (with `createIfEmpty`),
`browser_batch` and GIF recording are named in the docs I fetched. Other tool names would be from memory: not verified.

| Capability | Source | What it does for the user | agentweb | Priority |
|:--|:--|:--|:--|:--|
| Act in the user's real, signed-in Chrome, visible window | CIC-code | Claude shares login state, no re-login, user watches | PARTIAL: `AGENTWEB_CDP` + `AGENTWEB_CDP_SHARED=1` (GUIDE "Your own Chrome") works but needs a debugging port and a manual Chrome start; no extension, no one-click | high |
| Pause on login page / CAPTCHA and hand control to the user, then resume | CIC-code | Agent never gets stuck on a wall | PARTIAL: walls are detected and reported (`net/botwall.ts`); no "hand over, wait, resume" step in headed attach mode | high |
| Three permission modes: manual, automatic (classifier reviews each action), skip | CIC-perm | User chooses how much to supervise | PARTIAL: `AGENTWEB_CONFIRM` (consequential actions need a token), `AGENTWEB_READ_ONLY`; no per-session mode or action classifier | medium |
| Plan approval: Claude lists the sites and approach, user approves once | CIC-perm (classic panel) | One upfront approval instead of per-step prompts | MISSING (the host agent owns planning) | low |
| Per-site permission: allow once / always allow this site, with review and revoke UI | CIC-perm | Fine-grained trust, revocable | PARTIAL: `AGENTWEB_ALLOW/DENY` are static env patterns; no runtime grant or "allow this site for this session" | medium |
| Protected actions even when a site is always-allowed: downloads, sensitive input, authorizations | CIC-perm | Safety net | PARTIAL: confirm token covers purchases/transfers/deletions; downloads and sensitive input are not gated | medium |
| Hard-prohibited actions: purchases, account creation, trades, files from untrusted sources | CIC-perm | Policy | agentweb confirms rather than prohibits; a deliberate difference | low |
| Tab group: tabs Claude opens are grouped and coloured; user can drag tabs in to share them | CIC-start, CIC-code | Clear separation between agent tabs and personal tabs, multi-tab compile | PARTIAL: shared mode opens and closes only its own tabs; no group, no way to adopt a user tab | medium |
| Multi-tab in one session (list tabs, act on any) | CIC-start | Compare/compile across tabs | MISSING by design (PARITY.md gap 11) | medium |
| Scheduled tasks (daily/weekly/monthly/annual), via the `alarms` permission | CIC-start | Recurring checks without a person | MISSING: no scheduler; `diff='catalog'` baselines exist but need an external caller | medium |
| Shortcuts: saved prompts invoked with `/`, schedulable | CIC-start | Reuse a prompt that worked | MISSING: programs are data but there is no named, stored program library for non-test use | medium |
| Record a workflow by performing it; Claude learns it (classic panel only) | CIC-start | Teach by demonstration | PARTIAL: `agentweb test --record` runs a program and saves it; no recorder from live human actions | medium |
| Record GIF of the interaction | CIC-code | Shareable demo / bug evidence | MISSING (`screencast` appears in `dsl.ts`, only as a word; no GIF/video output) | medium |
| Console, network requests, DOM state readable | CIC-start | Debugging | HAS (`console`, `network`, `js`) | n/a |
| Save screenshots to disk and report path | CIC-code | Keep evidence | HAS (`shot(save=1)`) | n/a |
| Upload a local file into a page (10 MB cap, refuses credential-named files) | CIC-code | Attach logs, images | HAS `upload`; the credential-name refusal is a guard agentweb should confirm it has | low |
| Upload an image the user shares or a screen region as visual context | CIC-start | Point Claude at a UI detail | N/A for a text tool; the host agent sends images | low |
| Site-specific built-in knowledge (Slack, Calendar, Gmail, Docs, GitHub) | CIC-start | Fewer instructions needed | MISSING (no per-site skills). Packs could be data, see ranking | low |
| Sign in with a password manager (1Password, biometric approval, Claude never sees secret) | CIC-start | Credential without exposure | PARTIAL: `{{secret:name}}` from env and `profile()`; no password-manager provider | medium |
| Background work with desktop notifications when permission is needed or task ends | CIC-start | User can leave | MISSING (not meaningful headless; relevant for headed attach) | low |
| Contextual suggestions per website; enterprise allow/blocklists, admin controls | CIC-start / CIC-perm | Product features | N/A for agentweb (allow/deny exists) | low |
| Connection status and browser picker (`/chrome`, several browsers connected) | CIC-code | Choose which browser | MISSING; one `AGENTWEB_CDP` endpoint per process | low |
| Works in Edge and other Chromium browsers via native-messaging config | CIC-code | Coverage | PARTIAL: any Chromium over CDP; no native-messaging install | low |
| Side panel chat that continues across devices (Cowork session) | CIC-start | UI product | N/A | low |

## 2. Playwright MCP since PARITY.md (README at main)

New or changed (PW): tools `browser_find`, `browser_annotate`, `browser_highlight`, `browser_resume` (resume a paused script),
`browser_network_request`, `browser_get_config`, `browser_generate_locator`, `browser_verify_element_visible / text_visible /
list_visible / value`, `browser_drop`, route tools (`browser_route`, `browser_route_list`, `browser_unroute`), cookie tools
(list/get/set/delete/clear), localStorage tools (list/get/delete/clear, sessionStorage likely, not seen). Capability groups:
`config`, `network`, `storage`, `devtools`, `vision`, `pdf`, `testing`. Extension flags: `--extension`, `--background`,
`--no-tab-group`, `--profile-dir-name`. Others: `--secrets`, `redactUrlParams`, `--init-script`, `sharedBrowserContext`,
`cdpHeaders`, `cdpTimeout`, `remoteEndpoint`, `timeouts.idle`, `imageResponses`, `snapshot.boxes`, `testIdAttribute`, `codegen`
(ts/python/java/csharp), `saveSession`, WebMCP page tools (`webmcp`, default on). PW also recommends "CLI + SKILLS" over MCP
for coding agents (README section "Playwright MCP vs Playwright CLI"); I did not open the `playwright-cli` docs.

| Capability | Source | What it does | agentweb | Priority |
|:--|:--|:--|:--|:--|
| Extension bridge to the user's running Chrome/Edge, background mode, profile choice, tab group | PW | Same need as Claude in Chrome | PARTIAL (see section 1); PARITY.md called it N/A, newer competitors all ship it | high |
| `verify_*` tools (assert visible, text, value, list) | PW `testing` cap | Assertions inside an agent session | HAS and stronger: `expect(...)` | n/a |
| Route / mock requests, list and remove routes | PW network cap, CDT `mock_network`, AB `network route` | Test error states, block trackers | MISSING (low in PARITY.md; now in three products, raise to medium) | medium |
| Per-cookie and per-storage-key tools | PW storage cap | Read/set a single key | PARTIAL: `cookies` verb, `js()` for storage | low |
| Generate a locator / test code (`codegen`) for what the agent did | PW | Turn an agent session into a test | PARTIAL: `test --record` saves a `.aw` file; no export to Playwright code | medium |
| Pause and resume a script, step mode | PW `browser_resume` | Debugging a test | MISSING | low |
| Annotate / highlight actions for video | PW `browser_annotate`, AB `highlight` | Readable recordings | MISSING | low |
| Redact secret values and URL params (`redactUrlParams`) from tool output | PW | Keep tokens out of context | PARTIAL: `{{secret}}` redaction; no URL-parameter redaction rule | medium |
| `--init-script` / `initPage` | PW, CDT `initScript` | Script on every page | MISSING (low, PARITY.md) | low |
| Idle timeout that closes the browser and relaunches on demand | PW `timeouts.idle` | Frees RAM | N/A: sessions are JSON, browser pooled | low |
| Image-response modes (`omit`, `only`), snapshot boxes | PW | Token control | PARTIAL: `budget`; no bounding boxes in view | low |
| Shared browser context across HTTP clients | PW | Team sharing | HAS differently (shared store) | low |
| WebMCP: tools a page registers itself | PW, AB `webmcp`, CDT `list_webmcp_tools` / `execute_webmcp_tool` | Call the site's own agent API instead of clicking | MISSING (grep finds no WebMCP) | high |

## 3. agent-browser (Vercel Labs) latest

Command groups per AB README: navigate/read, interact, wait, capture (`screenshot pdf record download diff`), page and network
state, tabs/frames/dialogs, debug and performance (`console errors highlight inspect trace profiler vitals react a11y`),
sessions and auth (`session state auth profiles confirm deny`), agents (`skills mcp webmcp flow chat batch plugin`), observe
(`stream dashboard`), setup (`install upgrade doctor connect`). Engines: Chrome for Testing, Lightpanda, Obscura, Mobile
Safari in the iOS Simulator, cloud providers (Browserbase, Browserless, Browser Use, Kernel, AgentCore).

| Capability | What it does | agentweb | Priority |
|:--|:--|:--|:--|
| `read` that sends `Accept: text/markdown`, tries `.md`, finds nearest `llms.txt` / `llms-full.txt`, `--outline`, `--filter` | Cheap doc reading | PARTIAL: readers for markdown and the `Accept` header exist (`readers/markdown.ts`, `net/http.ts`); `read('Section')` is the filter; no llms.txt discovery, no outline | medium |
| `screenshot --annotate` (numbered labels on the image), `--if-changed`, `--threshold` | Vision models can match numbers to controls; skip unchanged images | MISSING (no annotated shots; numbers are text-only) | medium |
| Video recording to WebM/MP4 with cursor, contact sheet | Evidence for humans | MISSING | medium |
| HAR recording; trace; profiler | Debug artifacts | MISSING (low) | low |
| Auth vault: `auth save/login/list/show/delete`, credential-provider plugins (password managers), origin check before filling | Login by name, secret never shown | PARTIAL: `{{secret:name}}` + `profile()`; no "login by name" verb that fills a known form with origin binding | high |
| `state save/load/list/show/rename/clear/clean --older-than` | Manage saved sessions | PARTIAL: `profile()` save/load; no list/clean verbs | low |
| `profiles` list and `--profile Default` reuse of real Chrome profile login state | Use the user's Chrome profile on disk | MISSING (CDP shared mode needs a running Chrome) | medium |
| Stable tab ids and labels (`tab new --label docs`) | Several pages | MISSING in-session; `session` parameter covers separate pages | medium |
| Click fails with "covered by <div#consent-banner>" before dispatch | Honest errors, no silent miss | unknown, not checked | medium |
| Human-like mouse movement (`--human`, `--seed`) | Bot-wall evasion | N/A: agentweb states it does not evade detection | low |
| Clipboard read/write/copy/paste | Rich-text sites | MISSING (only in ghost engine surface) | low |
| `set credentials` HTTP basic auth, `set headers`, `set media`, `set offline` | Emulation | PARTIAL (`offline`, `dark`); basic auth and headers MISSING | medium |
| `find role/label/testid ... click` semantic locators | Target without a number | PARTIAL: visible text, `near=`; no role/testid targets | medium |
| Accessibility audit (axe-core) | Find a11y violations | MISSING (`parse.ts` mentions a11y only as parsing) | medium |
| React component tree, renders, Suspense, Web Vitals (`vitals`) | Frontend debugging | MISSING (low) | low |
| `stream` (WebSocket screen stream), `dashboard` (live view of sessions) | Watch the agent | MISSING | medium |
| `chat` command (natural-language control with a model inside the CLI) | CLI agent mode | N/A | low |
| `batch` (many commands in one call, pre-navigation setup) | Fewer calls | HAS: programs are batches | n/a |
| `skills get core` (version-matched instructions served by the CLI), `plugin` system | Agent onboarding, extension | PARTIAL: README paste-in prompt, tool description; no `agentweb skills` command, no plugins | medium |
| iOS Simulator / Mobile Safari | Real mobile Safari | MISSING; `engine('webkit')` plus `emulate` is the nearest | low |
| Content boundaries, `--allowed-domains`, `--max-output`, action policies, confirm/deny | Safety | HAS (stronger) | n/a |
| Daemon idle shutdown, `doctor`, `upgrade` | Ops | PARTIAL: `doctor` exists | low |

## 4. Chrome DevTools MCP latest (tool-reference.md)

Groups and counts from CDT: input (10, incl. `click_at` behind `--experimentalVision`), navigation (6), emulation (2), performance (3),
network (2), debugging (10: `evaluate_script`, `get_console_message`, `get_css_styles`, `lighthouse_audit`, `screencast_start/stop`,
`set_logpoints`, `take_snapshot`, `take_screenshot`), memory (14 heap-snapshot tools), network mocks (2), extensions (5:
install, list, reload, trigger action, uninstall), third-party developer tools (2), WebMCP (2), PWA (4: install, launch,
uninstall, `get_os_app_state`), WebAuthn (1: `configure_webauthn`).

| Capability | What it does | agentweb | Priority |
|:--|:--|:--|:--|
| `new_page(isolatedContext=name)`: named isolated contexts in one browser | Clean-slate auth tests | HAS differently: each `session` is isolated | n/a |
| `new_page(background=true)`, `bringToFront`, `list_pages` | Tab management | see tabs row | medium |
| Emulate: CPU throttling, network presets (Slow 3G, Fast 4G), extra HTTP headers, forced colors, prefers-contrast, reduced motion, `viewport` with DPR/touch/landscape | Performance and accessibility testing | PARTIAL (viewport, device, dark, offline); the rest MISSING | low |
| `wait_for` with a list of texts (any match), `visible` flag | Wait for one of several outcomes | PARTIAL: `wait('text')`; no "any of" | medium |
| `navigate_page`: `ignoreCache`, `handleBeforeUnload`, `initScript`, `timeout` | Control navigation | MISSING (low) | low |
| Performance trace, insights, Lighthouse | Page speed | MISSING (out of scope in PARITY.md) | low |
| Install / reload / trigger browser extensions in the debugged Chrome | Extension developers | MISSING | low |
| WebAuthn virtual authenticator | Test passkey login | MISSING | low |
| PWA install and launch | PWA testing | MISSING | low |
| Source-mapped console stack traces (claude.com listing of the Chrome DevTools plugin, snippet only) | Readable errors | MISSING; `console()` has no stack/source map | low |

## 5. Hosted browsers, agents and scrapers

Distinctive features, one row per product. Rows marked V were read in this pass; the rest are **not verified** (my background
knowledge, no page opened) and should be checked.

| Product | Distinctive features | V | agentweb relation |
|:--|:--|:--|:--|
| browser-use (BU) | Agent writes Python in a persistent REPL over CDP; cloud browsers with stealth, residential proxies and automatic CAPTCHA solving (`solve_captcha()`); cloud profiles that keep logins; `sensitive_data` per domain with `type_secret`; uploads and `result.downloads`; CLI (`browser-use skill install`), MCP server, hosted agent API; $0.02 per browser-hour (README) | V | no cloud, no solver (deliberate); domain-scoped secrets HAS |
| Stagehand / Browserbase | `act`/`extract`/`observe`, `agent()` in CUA, DOM and hybrid modes, custom tools, MCP tools inside the agent, streaming, structured `output`, abort signal; Browserbase: live view, session replay, Agent Identity (anti-bot/CAPTCHA partnerships), Functions, search and fetch APIs, model gateway (SH, BB). Contexts, proxies, session recording from memory | V (partly) | host agent is the model; no replay or live view |
| Firecrawl | `search`, `scrape` (markdown/html/JSON/screenshots), `interact` on a scraped page with a live view URL and CDP URL, `agent`, `map` (all URLs of a site), `crawl`, `parse` for local PDF/DOCX/XLSX, webhooks, browser sandbox, CLI that installs skills (FC) | V | PARTIAL: `search`, scrape-like `open`, readers for PDF/XML; no `map`/`crawl` of a whole site, no webhooks |
| Browser MCP (browsermcp.io) | Extension that lets an MCP client drive the user's own browser, local-only | no | same gap as the extension bridge |
| Skyvern | Vision + DOM agent, workflows, CAPTCHA and 2FA handling, cloud | no | not comparable without a model |
| Steel | Open-source browser API with sessions, CAPTCHA solving, proxies, files API, live view | no | cloud only |
| Hyperbrowser | Cloud browsers, stealth, CAPTCHA, scrape/crawl/extract, agent wrappers (browser-use, Claude computer use) | no | cloud only |
| Jina Reader | `r.jina.ai/<url>` returns markdown; `s.jina.ai` search; reader with image captions | no | PARTIAL: `open`/`read` do this locally |
| Browserless | Hosted Chrome over CDP/Playwright, `/content`, `/screenshot`, `/pdf`, `/scrape` REST, stealth, CAPTCHA, BrowserQL | no (AB lists it as a provider) | cloud |
| Notte | Agent framework, sessions with vault and personas, scraping API | no | cloud |
| Anchor Browser | Cloud browser with agent tasks, profiles, proxies | no | cloud |
| AgentQL | Query language that turns a natural-language field description into structured data and locators | no | `collect` is the model-free equivalent; no NL queries |
| Magnitude | Vision-based testing agent, natural-language test steps | no | `agentweb test` is model-free |
| Nova Act | Amazon, Python SDK, natural-language steps, workflows, human hand-off | no | not comparable |
| OpenAI ChatGPT agent / Atlas / computer-use tool | Own browser with takeover mode (user can take control), watch mode on sensitive sites, logged-in sessions, scheduled tasks, memory | no | takeover and scheduling gaps (see ranking) |
| Perplexity Comet | Browser with built-in assistant, tab context, background assistant | no | product, not a tool |
| Gemini computer use / Project Mariner | Screenshot-and-coordinate model API; Mariner runs several tasks in parallel in cloud VMs | no | N/A text-first |
| Microsoft Playwright Test Agents / Edge Copilot Mode | Planner, generator and healer agents that write and repair Playwright tests; Copilot Mode acts in Edge with permission | no | PARTIAL: `test --record`; no self-healing, no planner |

Additional gaps these imply:

| Capability | Source | agentweb | Priority |
|:--|:--|:--|:--|
| Whole-site map and crawl (list URLs, then fetch all) | FC `map`/`crawl` | MISSING (a sitemap reader exists; no verb) | medium |
| Live view / replay of a session for the human | BB, FC, AB `stream` | MISSING | medium |
| Managed CAPTCHA solving, residential proxies, stealth | BU, BB, Steel, Hyperbrowser | MISSING by policy (GUIDE "Bot walls") | low (owner decision) |
| Human takeover then resume | ChatGPT agent (not verified), CIC-code | MISSING | high |
| Convert local files (PDF, DOCX, XLSX) to text | FC `parse` | PARTIAL: PDF and CSV readers | low |

## Ranked top 15 gaps to close

Fit: one tool `web`, short programs, text-first output, sessions as JSON data.

1. **Attach to the user's own Chrome without manual setup** (Claude in Chrome, PW extension, Browser MCP). Add `connect()` that
   finds a running Chrome, or launches the user's profile with a debugging port, and keeps `AGENTWEB_CDP_SHARED` semantics;
   `doctor` prints the exact steps.
2. **Human takeover and resume** (Claude in Chrome, ChatGPT agent). A `handoff('Solve the captcha')` step that returns
   "waiting", and a later `resume()` that re-reads the page; works with the session record unchanged.
3. **WebMCP tool discovery** (PW, CDT, AB). Show page-registered tools as lines such as `tool: search_flights(q)` after `open`,
   and `call('search_flights', q='...')` to run one; cheap and removes clicking.
4. **Login by name with origin binding** (AB auth vault, BU `sensitive_data`, 1Password in CIC). `login('github')` fills the
   saved form only on its origin; secrets stay in the existing `{{secret}}` store; optional provider command for password managers.
5. **Request mocking, headers and basic auth** (PW routes, CDT `mock_network`, AB `network route`/`set headers`/`set credentials`).
   `route('*/api/*', status=500, body='...')`, `headers({...})`, `auth('user','pass')`; stored in the session record.
6. **Several tabs in one session, with stable labels** (CIC, PW `browser_tabs`, AB, CDT). Keep one page per session as the
   default; add `tab('docs', url)` / `tab('docs')` where tabs share the session's cookies, session record holds an array of
   page states.
7. **Video / GIF recording** (CIC, AB `record`, CDT `screencast`, PW). `record('out.gif')` ... `record(stop=1)` in Chrome
   engine; result is a path, not pixels in context.
8. **Annotated screenshots** (AB `--annotate`, PW `browser_annotate`). `shot(annotate=1)` draws the same numbers that the text
   view shows, so a vision model and the text agree; plus `if_changed=1`.
9. **Scheduled and repeated programs** (CIC scheduled tasks, ChatGPT agent). `agentweb schedule add name 'cron' 'program'`
   storing programs as data and results in the store, using the existing `diff=` baselines; run by `serve`.
10. **Named saved programs ("shortcuts")** (CIC shortcuts, AB `flow`). `program('checkout-check')` runs a stored program;
    lets a live recording (`--record`) become reusable outside tests.
11. **Permission modes and per-site grants at runtime** (CIC-perm). Session-level `allow('site')` and a mode
    `AGENTWEB_MODE=manual|auto|skip` mapped onto the existing confirm token; gate downloads and sensitive input too.
12. **`wait` for url / any-of / element state / text gone** (CDT `wait_for` list, AB `wait --url/--fn/--state`).
    `wait(url='/dash')`, `wait('a','b')` any-of, `wait(gone='Loading')`; PARITY.md already flags the PARTIAL.
13. **Site map and crawl verbs** (Firecrawl, Jina). `map('site')` returns URLs from sitemap/links, and `collect(... crawl=1)`
    follows internal links with coverage receipts, reusing the coverage design.
14. **Semantic targets and a11y audit** (AB `find role`, PW `generate_locator`, AB axe audit). `click(role='button',
    name='Submit')`, `click(testid='x')`; `audit()` returns axe violations as a few lines.
15. **Accessible read of docs sites via `llms.txt` and outline** (AB `read --llms`). `read(url, outline=1)` and
    `read(llms=1)`; extends the existing markdown reader.

Next just below the cut: HAR/trace export, throttling emulation, `agentweb skills`/plugin system, live view stream, export of a
recorded `.aw` to Playwright code.

## What agentweb does that none of these do

- One tool with about 750 tokens of definitions; competitors need 4k-18k (README, measured by the owner's bench).
- Verified collections: `collect` with source quotes, deduplication and an explicit `coverage.complete`, and semantic `diff=`
  between runs. No competitor read here returns coverage receipts.
- Repeat views show only what changed, with element numbers valid for the whole session.
- Sessions are small JSON records, not browser processes; one `serve` handles many agents with a shared store and page cache.
- Three-tier engines (HTTP, script engine without pixels, real Chrome) switch automatically; most pages need no browser.
- Model-free end-to-end tests (`agentweb test`) with auto-wait, snapshots and four-fact failures, no trace files.
- Guard layer: cross-site data-flow check, SSRF protection, prompt-injection lines flagged, domain-bound secrets, confirmation
  before purchases (AB has allowlists and confirm; no competitor has the flow check).
- `search()` that survives bot walls by rotating keyed APIs and engines, and answers a walled results URL with its own results.
- Honest policy on CAPTCHAs: it reports walls instead of evading them (a choice to keep, or to revisit explicitly).

## Added since this audit


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

Also closed (see `docs/GUIDE.md`): gap 1, the browser extension and `engine('mine')`; gap 5, `route` / `headers` /
`auth` / `init`; gap 6, `tabs` / `tab`; gap 12, the `wait` variants. In `agentweb test`: engine receipts, `# engine:`,
`# setup:` / `# teardown:` and `exec()`.

Closed on 2026-11-12: gap 4, `login('name')` from a stored credential bound to its site (password + `_USER`, user-name-first
forms; a password-manager command provider is still open); gap 14, role targets `click(role='button', name='Save')` (test ids
and `audit()` were already in). `agentweb test` remembers per page which engine it needed.
