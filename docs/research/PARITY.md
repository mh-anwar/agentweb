# Capability parity: can agentweb replace its competitors?

Compared: Playwright MCP (tools + CLI flags + caps), agent-browser (33 MCP tools), Chrome DevTools MCP (33 tools),
browser-use, Stagehand. Status: HAS (file), PARTIAL, MISSING, N/A (reason). Verified by reading the code and running
`agentweb run` against a local fixture (see `test/chrome.parity.test.ts`). "Fixed" marks gaps closed in this branch.

## Matrix

### Navigation
| Capability | Competitors | Status |
|:--|:--|:--|
| open URL, back, reload | all | HAS (`runtime.ts` open/back/reload) |
| forward | PW, AB, CDT | FIXED (`forward()`, live: `engine.ts forward`, HTTP tier: `rec.forward`) |
| wait for text / time / load | all | HAS (`wait`); URL, any-of texts, text gone, element state: FIXED (`wait(url=)`, `wait('a','b')`, `wait(gone=)`, `wait(n, state=)`; `netcontrol.ts`, `chrome.netcontrol.test.ts`) |
| init script on navigate | CDT | FIXED (`init('js')`, `chrome/page.ts applyNet`; `chrome.netcontrol.test.ts`). Ignore cache, beforeunload: MISSING (low) |
| search the web / site search | browser-use | HAS (`search`) |

### Tabs and sessions
| Capability | Competitors | Status |
|:--|:--|:--|
| list/switch/close tabs, new tab | PW `browser_tabs`, AB tab_*, CDT pages, browser-use | PARTIAL: one page per session by design; `session` parameter = independent tab (own cookies), `fork` copies a session; popups/`target=_blank` are followed in place (`pool.ts`, `page.ts windowOpen`). Shared-cookie multi-tab in one session: MISSING (medium, by design, see remaining) |
| isolated vs persistent profile | PW `--isolated/--user-data-dir` | PARTIAL: every session is isolated; persistence is the session store + `profile()` |

### Input
| Capability | Competitors | Status |
|:--|:--|:--|
| click, fill, type, select, check, press, hover, scroll, fill_form, upload | all | HAS (`runtime.ts`, `chrome/engine.ts`) |
| double click, right click | PW (`doubleClick`, `button`), AB | FIXED (`click(t, double=1)`, `button='right'`, `dblclick`/`rightclick` aliases; previously `dblclick` silently single-clicked) |
| drag and drop (element to element, HTML5 DnD) | PW, CDT, AB | FIXED (`drag(a, b)`; draggable/ondrop elements are now numbered) |
| drop files / data onto element (`browser_drop`) | PW | FIXED (`drop(target, path)`, `netcontrol.ts` + `inpage.ts drop`; `chrome.netcontrol.test.ts`) |
| keyboard chords | all | HAS (`keys.ts`) |
| mouse by coordinates (`--caps vision`) | PW | N/A: agentweb is text-first; targets are numbered elements. Low value |
| key typing with delay | AB `type delayMs` | N/A |

### Dialogs, downloads, files
| Capability | Competitors | Status |
|:--|:--|:--|
| JS dialogs: report and answer | PW, CDT `handle_dialog` | FIXED: reported before; now `dialog('dismiss' / 'accept', 'prompt text')` sets the answer (`page.ts javascriptDialogOpening`) |
| downloads | PW (saved to output dir) | FIXED: files are saved per session under `AGENTWEB_DOWNLOADS` (default `~/.agentweb/downloads`), path and size reported, 250 MB cap; before they were refused |
| file upload | all | HAS (`upload`) |

### Frames, shadow DOM
| Capability | Status |
|:--|:--|
| iframes (same and cross origin), open shadow roots appear in the view and are clickable | HAS (verified with srcdoc iframe and shadow root; `inpage/extract.ts`) |

### Auth and state
| Capability | Competitors | Status |
|:--|:--|:--|
| load saved sign-in (storageState) | PW `--storage-state`, `browser_set_storage_state` | HAS (`profile('name')`, `profiles.ts`) |
| save sign-in | PW `browser_storage_state` | HAS (`profile('x', save=1)`) |
| cookies get/set/clear | PW caps storage | HAS (`cookies` verb) |
| localStorage/sessionStorage get/set | PW caps storage | PARTIAL: synced into the session automatically; direct read/write via `js()` |
| secrets never shown to the model | PW `--secrets` | HAS (`{{secret:name}}`, guard) |

### Network and console inspection
| Capability | Competitors | Status |
|:--|:--|:--|
| console messages | PW, CDT, AB | FIXED: `console()` (`console('words', errors=1)`) since the page loaded; page errors already surfaced as notes |
| list network requests, failures, response body | PW, CDT | FIXED: `network('words', failed=1, n=40)`, `network('api', body=1)` |
| mock/route requests, offline, throttle | PW caps network, CDT emulate | FIXED: `route()`/`routes()` (`netcontrol.ts`, `chrome/page.ts onPaused`), `emulate(offline=1, throttle=, cpu=)`; `chrome.netcontrol.test.ts` |
| extra HTTP headers, basic-auth credentials | CDT emulate, PW `httpCredentials`, AB `set headers/credentials` | FIXED: `headers()`, `auth()` on wire, ghost and chrome (`net/http.ts`, `ghost/net.ts`, `chrome/page.ts`; `netcontrol.wire.test.ts`, `chrome.netcontrol.test.ts`) |
| HAR recording | PW devtools | FIXED: `network(har='name')` writes HAR 1.2 (`chrome/page.ts har`, `netcontrol.ts buildHar`; `chrome.netcontrol.test.ts`). Trace/video: MISSING (low) |

### JavaScript
| Capability | Competitors | Status |
|:--|:--|:--|
| evaluate in page | PW evaluate/run_code, AB eval, CDT evaluate_script, browser-use | FIXED: `js('code')` (expression, statements, `return`, arrow function, await); refused in read-only mode; the result is redacted and counted against the budget |
| init script on every page | PW `--init-script` | FIXED (`init('js')`; `chrome.netcontrol.test.ts`) |
| set logpoints, heap snapshot, CSS styles, Lighthouse, performance trace | CDT | MISSING / out of scope: developer-debugging tools, rarely wanted by a browsing agent. `js('performance.getEntries()')` covers basic timing |

### Emulation
| Capability | Competitors | Status |
|:--|:--|:--|
| viewport size | PW `--viewport-size`, `browser_resize`, CDT resize | FIXED: `emulate(390, 844)` / `resize()`; env `AGENTWEB_VIEWPORT`; kept with the session |
| device presets | PW `--device`, `--mobile` | FIXED: `emulate('iPhone 15')`, env `AGENTWEB_DEVICE` (`devices.ts`, 13 presets; others via width/height/mobile=1) |
| user agent | PW `--user-agent` | HAS (`AGENTWEB_USER_AGENT`) + FIXED per session `emulate(ua=)` |
| geolocation, locale, timezone | PW config, CDT | FIXED: `emulate(geo='lat,lon', locale=, tz=)` (grants the geolocation permission) |
| color scheme, reduced motion, forced colors, contrast | PW emulate_media, CDT | FIXED: `dark=1`, `motion='reduce'`, `contrast='more'`, `forced_colors=1` (`chrome/page.ts emulate`; `chrome.netcontrol.test.ts`) |
| permissions grant | PW `--grant-permissions` | FIXED: `emulate(permissions='clipboard-read,notifications')` (skipped in shared-profile mode); `chrome.netcontrol.test.ts` |

### Screenshots and PDF
| Capability | Competitors | Status |
|:--|:--|:--|
| screenshot viewport / full page / element | all | FIXED: engine supported it, the verb did not expose it: `shot(full=1)`, `shot(12)`, `shot(save=1)` also keeps the file |
| PDF | PW `--caps pdf` | FIXED: `shot(pdf=1)` / `pdf()` saves a file and reports the path |
| screencast / video | PW, CDT | MISSING (low) |
| annotated screenshots, highlight | PW, AB | N/A |

### Attaching, endpoints, proxy
| Capability | Competitors | Status |
|:--|:--|:--|
| attach to a running browser over CDP | PW `--cdp-endpoint`, AB, CDT `--browserUrl` | PARTIAL: `AGENTWEB_CDP` works (`engine.ts`, `launch.ts`) but each session gets a new isolated context, so the user's own logged-in tabs and cookies are not visible. Using the default context: MISSING (medium) |
| CDP headers/timeouts | PW | MISSING (low) |
| browser extension mode | PW `--extension` | N/A in design; the same need is served by `profile()` (import a storageState) |
| custom executable, headless, no-sandbox | PW | HAS (`AGENTWEB_CHROME`, `AGENTWEB_NO_SANDBOX`); headed mode MISSING (low) |
| proxy | PW `--proxy-server`, `--proxy-bypass` | FIXED: `AGENTWEB_PROXY` (HTTP tiers and Chrome); SOCKS is browser-only (HTTP tiers are pinned to Chrome, `search` still goes direct); proxy credentials in the URL work for the HTTP tiers only; bypass list MISSING (low) |
| ignore HTTPS errors | PW `--ignore-https-errors` | FIXED for the browser: `AGENTWEB_IGNORE_HTTPS_ERRORS=1` |
| allowed/blocked origins | PW | HAS (`AGENTWEB_ALLOW/DENY`, stronger: a security boundary) |
| Firefox/WebKit/Edge | PW `--browser` | OTHER WORKSTREAM (hill-xbrowser) |

### Agent-level features
| Capability | Competitors | Status |
|:--|:--|:--|
| natural-language act/extract/observe | Stagehand | N/A: the calling agent is the model; `extract`, `collect`, `records` give structured data without a model |
| structured extraction | Stagehand, browser-use | HAS and stronger (`collect`, verified coverage) |
| flows / record and replay | AB flow_* | PARTIAL: programs are plain data and replayable; no recorder |
| test generation, codegen, test runner | PW | OTHER WORKSTREAM / N/A |
| token cost | all | HAS: single tool, ~590 tokens for the description (was 508) |

## Ranked gap list (how often an agent user hits it)

1. Saved sign-in: fixed earlier (`profile`).
2. **Downloads** (reports, CSV, invoices) - FIXED.
3. **JS escape hatch** (`js`) for anything the verbs miss, reading storage/DOM state - FIXED.
4. **Console/network readout** to debug why a page failed - FIXED.
5. **Dialog answers** (confirm "Delete?", prompt) - FIXED.
6. **Viewport/device/locale/timezone/geo/dark** (mobile layouts, region sites) - FIXED.
7. **Screenshot options and PDF** - FIXED.
8. **Proxy** and **ignore HTTPS errors** - FIXED (see limits above).
9. forward, double/right click, drag and drop - FIXED.
10. Attach to the user's own running Chrome with its logins (default context) - REMAINING (needs the pool to adopt the default browser context and not dispose it; privacy implications: agent would see all the user's cookies, so it deserves an explicit opt-in design).
11. Shared-cookie multiple tabs in one session - REMAINING (breaks the "one page per session, session = small JSON record" scaling design; sessions plus `profile()` cover most flows).
12. Request mocking/routing, extra headers, throttling, init scripts, HAR - FIXED (`netcontrol.ts`). Trace/video, Lighthouse, heap snapshots - REMAINING (low; developer tools, not browsing).
13. Drop files onto an element - FIXED (`drop`). Coordinate mouse, headed mode, CDP headers - REMAINING (low).
