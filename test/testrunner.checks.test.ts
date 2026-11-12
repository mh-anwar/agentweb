// agentweb test: `# console: clean`, expect(overflow/audit/console/requests=…), screenshot() baselines.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCommand } from '../src/test/cli.ts';
import { parseConsoleRule, parseTestFile } from '../src/test/parse.ts';

let server: Server;
let base = '';
let dir = '';
/** what /look draws: the screenshot tests change it between runs */
let look = { color: '#2a6', width: 120 };

const html = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0}</style></head><body>${body}</body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    if (url === '/clean') send(html('Clean', '<main><h1>Clean</h1><p>All good.</p></main><script>console.log("fine")</script>'));
    else if (url === '/noisy') send(html('Noisy', '<main><h1>Noisy</h1></main><script>console.error("checkout exploded");fetch("/api/missing")</script>'));
    else if (url === '/wide') send(html('Wide', '<main><h1>Wide</h1><table class="grid" style="width:900px"><tr><td>x</td></tr></table></main>'));
    else if (url === '/bad') res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><head><title>Bad</title></head><body><img src="/x.png"><h1>Bad</h1></body></html>');
    else if (url === '/look') send(html('Look', `<main><h1>Look</h1><div style="width:${look.width}px;height:80px;background:${look.color}"></div></main>`));
    else res.writeHead(404, { 'content-type': 'text/plain' }).end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'aw-tchecks-'));
  process.env.AGENTWEB_ALLOW_PRIVATE = '1';
  process.env.AGENTWEB_NO_SANDBOX = '1';
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

async function run(file: string, text: string, args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const p = join(dir, file);
  writeFileSync(p, text);
  const out: string[] = [];
  const err: string[] = [];
  const code = await testCommand([p, '--base', base, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('headers', () => {
  it('# console: parses clean, warn and allow', () => {
    assert.deepEqual(parseConsoleRule('clean'), {});
    assert.deepEqual(parseConsoleRule('clean, allow=favicon'), { allow: 'favicon' });
    assert.deepEqual(parseConsoleRule('Clean, warn, allow=favicon,hot-update'), { warn: true, allow: 'favicon,hot-update' });
    assert.equal(parseConsoleRule('off'), undefined);
    const cases = parseTestFile('# console: clean, allow=x\n## a\nopen("/a")\n## b\n# console: off\nopen("/b")\n', 't.aw');
    assert.deepEqual(cases.map((c) => [c.name, c.console]), [['a', { allow: 'x' }], ['b', undefined]]);
  });
});

describe('# console: clean', { concurrency: false }, () => {
  it('passes a clean page, fails a noisy one with the messages, and honours allow and off', async () => {
    const ok = await run('con1.aw', "# console: clean\n## clean\nopen('/clean'); expect('All good')\n");
    assert.equal(ok.code, 0, ok.out);
    const bad = await run('con2.aw', "# console: clean\n## noisy\nopen('/noisy'); expect('Noisy')\n");
    assert.equal(bad.code, 1);
    assert.match(bad.out, /step:  # console: clean/);
    assert.match(bad.out, /error: console has 2 errors in this test:\n {9}error: checkout exploded \[\/noisy\]\n {9}error: Failed to load resource: the server responded with a status of 404 \(Not Found\) \(\/api\/missing\) \[\/noisy\]/, bad.out);
    const allowed = await run('con3.aw', "# console: clean, allow=exploded,missing\n## noisy\nopen('/noisy'); expect('Noisy')\n");
    assert.equal(allowed.code, 0, allowed.out);
    const off = await run('con4.aw', "# console: clean\n## noisy but fine here\n# console: off\nopen('/noisy'); expect('Noisy')\n## still checked\nopen('/noisy')\n");
    assert.match(off.out, /1 failed, 1 passed/, off.out);
  });

  it('looks at every page of the test, not just the last one', async () => {
    const r = await run('con5.aw', "# console: clean\n## wanders\nopen('/noisy'); open('/clean')\n");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /checkout exploded \[\/noisy\]/);
  });

  it('runs in chrome (the console is the browser\'s), as the receipt says', async () => {
    const r = JSON.parse((await run('con6.aw', "# console: clean\n## clean\nopen('/clean')\n", ['--json'])).out);
    assert.equal(r.tests[0].engine, 'chrome');
  });
});

describe('expect(…) checks in test files', { concurrency: false }, () => {
  it('overflow, audit, console and requests fail with their lines under the error', async () => {
    const text = [
      '## overflow',
      "viewport('600x800'); open('/wide'); expect(overflow=0)",
      '## audit',
      "open('/bad'); expect(audit='alt,lang')",
      '## console',
      "open('/noisy'); expect(console=0)",
      '## requests',
      "open('/noisy'); expect(requests=0)",
      '## fine',
      "open('/clean'); expect(overflow=0, audit=0, console=0, requests=0)",
    ].join('\n');
    const r = await run('chk1.aw', text, ['--workers', '1']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /4 failed, 1 passed/, r.out);
    assert.match(r.out, /error: the page scrolls sideways: 900 px of content in a 600 px viewport \(300 px too wide\)\n {9}overflows by 300 px: <table\.grid> "x" 900 px wide in a 600 px viewport/, r.out);
    assert.match(r.out, /error: audit: 2 of 2 rules failed, 2 elements \(built-in WCAG 2\.2 AA subset, not axe-core\)\n {9}alt \(1\.1\.1\) ×1: <img> "x\.png" no alt attribute\n {9}lang \(3\.1\.1\) ×1: <html> has no lang attribute/, r.out);
    assert.match(r.out, /error: console has 2 errors since the page loaded:\n {9}error: checkout exploded/, r.out);
    assert.match(r.out, /error: 1 request failed \(4xx, 5xx or a network error\) since the page loaded:\n {9}GET 404 \/api\/missing/, r.out);
  });
});

describe('screenshot(…) baselines', { concurrency: false }, () => {
  const shots = () => readdirSync(join(dir, '__aw_screenshots__', 'shot')).sort();
  const test = "## look\nopen('/look'); screenshot('box', widths='375,768')\n";

  it('writes a baseline, passes against it, fails on a visible change, accepts with --update', async () => {
    const ci = await run('shot.aw', test, ['--ci']);
    assert.equal(ci.code, 1);
    assert.match(ci.out, /no baseline for screenshot 'box' at 375 px \(run without --ci, or with --update, to write it\)/);

    const first = await run('shot.aw', test, ['--verbose']);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /snapshot written: box@375, box@768/);
    assert.deepEqual(shots(), ['look.box.375.jpg', 'look.box.768.jpg']);

    assert.equal((await run('shot.aw', test, ['--ci'])).code, 0, 'the same page matches its baseline');

    look = { color: '#c33', width: 360 };
    const changed = await run('shot.aw', test);
    assert.equal(changed.code, 1, changed.out);
    assert.match(changed.out, /error: screenshot 'box' at 375 px differs from the baseline in \d+(\.\d+)?% of pixels \(limit 1%\); the new picture is __aw_screenshots__\/shot\/look\.box\.375\.actual\.jpg; --update accepts it/, changed.out);
    assert.ok(existsSync(join(dir, '__aw_screenshots__', 'shot', 'look.box.375.actual.jpg')));

    const loose = await run('shot.aw', "## look\nopen('/look'); screenshot('box', widths='375,768', threshold=0.9)\n");
    assert.equal(loose.code, 0, 'a looser threshold lets the change through');

    const upd = await run('shot.aw', test, ['--update']);
    assert.equal(upd.code, 0, upd.out);
    assert.deepEqual(shots(), ['look.box.375.jpg', 'look.box.768.jpg'], 'accepting removes the .actual pictures');
    assert.equal((await run('shot.aw', test, ['--ci'])).code, 0);
  });

  it('a change in size is its own message; the default width is the current viewport', async () => {
    const a = await run('shot2.aw', "## plain\nopen('/look'); screenshot('page')\n");
    assert.equal(a.code, 0, a.out);
    assert.ok(readdirSync(join(dir, '__aw_screenshots__', 'shot2')).some((f) => /^plain\.page\.1280\.jpg$/.test(f)), 'the file is named after the 1280 px viewport');
    const full = await run('shot2.aw', "## plain\nopen('/look'); screenshot('page', full=1)\n");
    assert.equal(full.code, 0, full.out);
  });
});
