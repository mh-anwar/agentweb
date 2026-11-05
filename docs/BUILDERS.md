# Rules for module builders

You are building one module of **agentweb** in a checkout that several other agents are editing at
the same time. Read `docs/ARCHITECTURE.md`, `src/types.ts`, `src/tree.ts` and `src/blocks.ts` before
writing anything (and `src/inpage/extract.ts` if your module touches a live DOM).

## Hard rules

- Edit **only** the paths your brief lists under "You own". Never edit `src/types.ts`,
  `src/tree.ts`, `src/blocks.ts`, `package.json`, `tsconfig.json`, or another module's files. If a
  contract is wrong or missing something, work around it inside your module and list the change you
  want in your final report.
- No git commands that change state (no `add`, `commit`, `stash`, `checkout`, `reset`, `clean`).
  The lead commits.
- Do not run `npm install` in the repo root. Everything you may use is already installed:
  `htmlparser2`, `undici`, `jsdom`, `happy-dom`, `unpdf`, `react`, `react-dom`, `vue`, `preact`,
  `esbuild`, `gpt-tokenizer`, `typescript`. Node built-ins are always fine. Ask in your report if
  you need something else. (`bench/baselines` has its own `package.json` and may install freely.)
- TypeScript is run directly by Node 24 (type stripping). Erasable syntax only: no `enum`, no
  constructor parameter properties, no namespaces. ESM; relative imports end in `.ts`;
  `import type` for types.
- Do not start subagents.

## Testing

- `node:test`, files named `test/<module>.<topic>.test.ts`. Run only your own:
  `node --test test/<module>.*.test.ts`. Other modules' tests may be broken mid-build; ignore them.
- Typecheck with `npx tsc --noEmit 2>&1 | grep -E "^(src/<your dir>|test/<your prefix>)"`; that
  must print nothing. Errors in other modules' files are not yours to fix.
- Servers in tests listen on port `0`. Tests must not need the public internet unless the file is
  named `*.live.test.ts`.
- Tests must clean up: close servers, kill child processes, remove temp dirs (`os.tmpdir()`).

## This machine

- Shared box, no sudo, 8 cores, a 20 GB soft memory limit shared with other users. Keep test
  parallelism modest and do not leave processes running.
- Never `pkill -f <pattern>` (it kills your own shell). Stop processes by PID.
- Chromium: `~/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`; headless shell:
  `~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`.
  Always pass `--no-sandbox` on this machine.
- If the machine or its setup costs you time (missing library, permission denied, port in use,
  killed process, registry error), log one line and keep going:
  `box issue --kind <slow|broken|missing|limit|confusing|other> "<what happened> | <workaround> | <cost>"`.
  Do not log bugs in project code.

## Quality bar

The lead wants depth: production-quality code with real edge cases handled and tested, not a
stub. Prefer a smaller surface that works on hostile real-world input over a wide one that works
only on the happy path. Measure things where the brief asks, and report the numbers you actually
observed. If something does not work, say so plainly in the report.

## Final report (at most 350 words)

1. What you built: files and the public API (signatures).
2. Tests: the command, and pass/fail counts.
3. Measured numbers, if the brief asked for any.
4. Known gaps and anything that does not work.
5. Contract changes you want.
