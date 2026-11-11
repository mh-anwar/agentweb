# agentweb architecture

agentweb is a web runtime built for LLM agents rather than people. An agent sends a short
*program* ("open this, fill that, submit, find the price") and gets back a bounded, compact text
view of the result. There are no pixels anywhere in the default path.

This document is the contract every module builds against. The type definitions it refers to are
in [`src/types.ts`](../src/types.ts) and [`src/tree.ts`](../src/tree.ts).

## Why it exists

Design motivations, informed by historical measurements (sources in the README):

These are motivations, not a current feature comparison. Competing tools now include browser-free
reads, alternate engines, diffs and batch commands. See the [current competitive research](research/DIFFERENTIATION.md)
and [benchmark evidence](../bench/RESULTS.md) before making performance or feature-gap claims.

1. **Round trips dominate cost.** Every tool call makes the model re-read its context. Tools that
   are cheap per call but need 40–50 calls lose to tools that need 15.
2. **Unbounded output.** Accessibility snapshots of 45k–284k tokens from a single call.
3. **A process per agent.** ~400 MB of Chromium per page, idle most of the session while the model
   thinks. Cloud browsers cap plans at 25–250 concurrent sessions.
4. **Most pages do not need a browser**, and most that need JavaScript do not need pixels.
5. **Nothing is learned.** Every agent rediscovers every site.
6. **Unsafe by default.** Hidden text reaches the model; secrets are pasted into context; nothing
   stops data read on one origin from being sent to another.

## The six layers

| Layer | What it does | Where |
|---|---|---|
| Engines | Load a page three ways, cheapest first: `wire` (HTTP, no JS), `ghost` (JS + DOM, no pixels, virtual time), `chrome` (real Chromium over raw CDP) | `src/net`, `src/engines` |
| Compiler | Any document → a `Page`: a flat list of `Block`s with inline actionables (`Act`) | `src/parse.ts`, `src/compile.ts`, `src/readers` |
| Renderer | `Page` → bounded text. Stable numeric refs, "never show the same line twice", `find` | `src/render.ts` |
| Programs | The mini-language: several steps per call, fan-out, extraction, expectations | `src/dsl.ts`, `src/runtime.ts`, `src/extract` |
| Atlas | What the fleet has learned about each site (cheapest working tier, search templates, …) | `src/atlas` |
| Guard | URL policy and SSRF, secret handles, cross-origin data-flow checks, signed agent identity | `src/guard` |
| Fabric | Sessions as data in a `Store`, shared page cache and servers; watchers and inspector are planned | `src/store`, `src/server`, `src/watch` |

## One intermediate representation

Every engine produces the same thing: an `LNode` tree plus `DocMeta` (see `src/tree.ts`).

- `wire` parses HTML text with `parseHtml` (`src/parse.ts`).
- `ghost` and `chrome` run `extractPage` (`src/inpage/extract.ts`) inside the live document. It
  adds computed visibility (`h`, `sr`), live values (`v`, `k`), "looks clickable" (`p`) and a
  live node id (`n`) that stays the same for as long as the element exists.

`compile(doc, url, tier)` turns that into a `Page`. Nothing after the compiler knows which engine
produced the page.

## Engines

All engines implement `Engine` (`src/types.ts`).

- `open(ctx, req)` navigates and returns `Loaded`: either `doc` (HTML) or `body` (anything else).
- Stateful engines also implement `act`, `snapshot` and `live`. An `Action` names its target by
  live node id `n`. If that node is gone the engine throws `AwError('stale')`; the runtime
  re-snapshots, re-resolves the target by fingerprint and retries once.
- Engines never decide policy. They call `ctx.guard.checkUrl()` for the navigation URL and for
  every redirect hop, and throw `AwError('policy', reason)` when refused.
- **The cookie jar is the source of truth.** Engines read `ctx.jar` before a request and write
  it back after. Stateful engines also keep `ctx.storage` (per-origin localStorage) current. This
  is what lets a session move between tiers and survive eviction: only the JS heap is ever lost.
- Engines report *what happened*, not *what to do*: if a page plainly did not work at this tier
  they set `Loaded.escalate` to a reason and the runtime decides.

### Tier selection (runtime)

`open` picks the cheapest tier the Atlas believes works for the origin (default `wire`). After
loading, if the page is a shell (`Page.shell`) or the engine set `escalate`, the runtime retries
one tier up **only if the request was a GET**. A step that needs scripting (an `Act` with
`js: true`) from the wire tier re-opens the current page one tier up, again only if that page was
reached by GET. A POST result is never replayed; the runtime fails loudly instead.

## Sessions are data

A session is a JSON record in a `Store` (cookies, current `Page`, ref table, seen-set, history,
guard state). A worker loads it, runs the program, and saves it. Any worker can serve any call for
a session whose current page is in the `wire` tier. Sessions with a live `ghost`/`chrome` page
prefer the worker that holds it; if that worker is gone the page is re-opened from cookies and URL
and the agent is told that in-page state was reset.

Forking a session is copying its record.

## Conventions for all code

- TypeScript run directly by Node ≥ 22.6 (type stripping). **Erasable syntax only**: no `enum`,
  no parameter properties, no namespaces, no decorators. ESM. Relative imports carry the `.ts`
  extension. Use `import type` for types.
- No runtime dependencies unless your brief names one. Node built-ins are fine
  (`node:http`, `node:crypto`, `node:sqlite`, `fetch`, `WebSocket`, …).
- Errors that an agent should see are `AwError(code, message, hint?)`. Messages are short and say
  what to do next.
- Tests use `node:test` and live in `test/<module>.<topic>.test.ts`. Servers in tests listen on
  port `0`. Tests must not depend on the public internet unless named `*.live.test.ts`.
- Every module directory has an `index.ts` that exports its public surface.
- Do not edit files outside the directories you own. Do not edit `src/types.ts`, `src/tree.ts`,
  `src/blocks.ts`, `package.json` or `tsconfig.json`; ask for the change in your final report.

## Directory ownership

```
src/tree.ts types.ts blocks.ts parse.ts compile.ts render.ts tokens.ts dsl.ts session.ts runtime.ts cli.ts   core
src/inpage/        in-page extractor shared by ghost and chrome
src/net/           wire engine: HTTP client, cookie jar, shared page cache, politeness
src/engines/chrome CDP client, launcher, context pool, Chromium engine
src/engines/ghost  JS-without-pixels engine
src/readers/       JSON, feeds, CSV, markdown, PDF, embedded data → blocks
src/guard/         policy, SSRF, secrets, data-flow, Web Bot Auth
src/store/         memory, file, sqlite, redis stores
src/server/        MCP (stdio + streamable HTTP), REST, metrics, inspector UI
src/search/        web search providers
src/atlas/         site knowledge
src/extract/       record extraction and pagination
src/watch/         subscriptions
bench/sites/       local fixture web ("the farm") with ground truth
bench/baselines/   other tools, installed and wrapped for comparison
```
