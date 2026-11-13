import { defineConfig } from "@playwright/test";

// The same settings Clockwork's suite uses where they matter: a worker count, a 10 s expect wait,
// traces and screenshots kept on failure, Chromium headless.
export default defineConfig({
    testDir: ".",
    workers: Number(process.env.WORKERS ?? 2),
    fullyParallel: true,
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    reporter: [["list"]],
    outputDir: process.env.PW_OUT ?? "/tmp/vsp-pw-results",
    use: {
        baseURL: process.env.BASE ?? "http://127.0.0.1:4720",
        viewport: { width: 1280, height: 800 },
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        timezoneId: "America/Toronto",
        locale: "en-CA",
    },
});
