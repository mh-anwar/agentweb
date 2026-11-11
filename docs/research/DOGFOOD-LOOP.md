# Turn real failures into reproducible tasks

The owner maintains usage logging, fallback reports, MCP registration and auto-release separately.
This work does not duplicate that tooling or change `src/cli.ts`.

Inputs, once deployed:

- `~/.local/state/agentweb/usage.jsonl`: aggregate by host, step names, tier and outcome. Track
  repeated failures and unexpected escalation; a low token count by itself is not success.
- `~/.local/state/agentweb/reports.jsonl`: use the reported task and fallback reason to find a
  reproducible failure. The usage log deliberately cannot reconstruct typed text or page content.

The log was created during this handoff. A lookup of the official agent-browser command
reference through the installed build succeeded on the HTTP tier: one logged run, zero failures,
zero fallbacks. There are no recurring failures to turn into telemetry-derived tasks yet.

For each recurring issue, reproduce it once, then add a synthetic local fixture under
`bench/sites` with the same relevant behavior and randomized values. Give it an outcome check:
exact extracted facts, recorded request, submitted form, or forbidden side effect. Do not copy
private page content into fixtures. Preserve the original report category and a minimal
reproduction description so the task remains understandable after the website changes.

Run the reproduction before fixing, make a focused regression check, then run the same task
against agentweb and the pinned competitor tools. Repeat trials, retain permission denials and
infrastructure failures, and compare matched cells. A task used to make a fix is development data;
reserve fresh variants for later validation. Report baseline and fixed results separately.

Before landing on `build/agentweb-v0`, integrate its latest committed changes and run `npm test`
and the build. Public-provider checks are explicitly opt-in with `npm run test:live`; the normal
suite uses at most two test workers. Chromium integration checks still require the installed
browser. Baseline-launch checks skip in a clean release copy without optional baseline packages.
The release hook and deployment symlink remain the owner's responsibility.

Deployment detail for the auto-release owner: `scripts/build.mjs` deliberately keeps `jsdom`
and `unpdf` external. Retain the clean build's dependency tree where each release can resolve
those packages; copying only the two `.mjs` files loses optional engine/reader capabilities.
The `scripts/smoke-build.mjs` check exercises a JavaScript page and a PDF through the packaged
CLI, complementing tests that import TypeScript source. Keep `ghost-child.mjs` beside `agentweb.mjs`.
