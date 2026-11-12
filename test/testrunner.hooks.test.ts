// agentweb test: engine receipts and flags, setup/teardown hooks, exec(), in-page redirects.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCommand } from '../src/test/cli.ts';
import { parseTestFile } from '../src/test/parse.ts';
import { varsFrom } from '../src/test/runner.ts';

// runs here must not read or leave an engine memory file in the repository
process.env.AGENTWEB_TEST_MEMORY = '0';

let server: Server;
let base = '';
let dir = '';

const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    if (url === '/plain') send(html('Plain', '<main><h1>Plain page</h1><p>Server rendered, nothing to run.</p></main>'));
    else if (url === '/home') send(html('Home', '<main><h1>Home page</h1></main>'));
    // what Next.js streams when a server component redirects after the response has started
    else if (url === '/gated') send(html('Gated', '<main><h1>Loading</h1></main><meta id="__next-page-redirect" http-equiv="refresh" content="1;url=/home"/>'));
    else if (url === '/app') send(html('App', `<main><h1>App</h1><p>${'Some words to read on this page. '.repeat(8)}</p><p id="o">waiting</p></main><script>document.getElementById('o').textContent = 'scripts ran';</script>`));
    else if (url.startsWith('/code')) send(html('Code', `<main><h1>Code</h1><p>code is ${new URL(url, 'http://x').searchParams.get('c')}</p></main>`));
    else res.writeHead(404).end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'aw-hooks-'));
  process.env.AGENTWEB_ALLOW_PRIVATE = '1';
  process.env.AGENTWEB_NO_SANDBOX = '1';
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function run(file: string, text: string, args: string[] = []): Promise<{ code: number; out: string; err: string }> {
  const p = join(dir, file);
  writeFileSync(p, text);
  const out: string[] = [];
  const err: string[] = [];
  const code = await testCommand([p, '--base', base, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('agentweb test: receipts, flags, hooks', () => {
  it('headers parse: engine, file-level and test-level hooks', () => {
    const cases = parseTestFile('# engine: chrome\n# setup: seed\n# teardown: clean\n## a\n# setup: one\nopen("/x")\n## b\n# engine: ghost\nopen("/y")\n', 't.aw');
    assert.deepEqual(cases.map((c) => [c.name, c.engine, c.setup, c.fileSetup, c.fileTeardown]), [
      ['a', 'chrome', ['one'], ['seed'], ['clean']],
      ['b', 'ghost', undefined, ['seed'], ['clean']],
    ]);
    assert.deepEqual(varsFrom('noise\nuser_id=42\nemail=a@b.co\n'), { user_id: '42', email: 'a@b.co' });
    assert.deepEqual(varsFrom('{"otp":"123456","n":7}'), { otp: '123456', n: '7' });
  });

  it('says which engine ran each test, in the summary, --verbose and --json', async () => {
    const text = "## plain\nopen('/plain'); expect('Plain page')\n## scripted\nopen('/app'); expect('scripts ran')\n";
    const r = await run('receipt.aw', text);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^✓ 2 passed \(.*; (wire 1, ghost 1|ghost 1, wire 1)\)$/m);
    const v = await run('receipt.aw', text, ['--verbose']);
    assert.match(v.out, /✓ plain .*\[wire\]/);
    assert.match(v.out, /✓ scripted .*\[wire→ghost\]/);
    const j = await run('receipt.aw', text, ['--json']);
    const parsed = JSON.parse(j.out);
    assert.equal(parsed.passed, 2);
    assert.deepEqual(parsed.engines, { wire: 1, ghost: 1 });
    assert.deepEqual(parsed.tests.map((t: any) => t.engine), ['wire', 'ghost']);
    assert.deepEqual(parsed.tests[1].engines, ['wire', 'ghost']);
  });

  it('--no-ghost is honoured, --engine and "# engine:" pin the engine, unknown options are refused', async () => {
    const text = "## scripted\nopen('/app'); expect('scripts ran')\n";
    const noGhost = JSON.parse((await run('flags.aw', text, ['--json', '--no-ghost'])).out);
    assert.equal(noGhost.tests[0].engine, 'chrome');
    const pinned = JSON.parse((await run('flags.aw', "## plain\nopen('/plain'); expect('Plain page')\n", ['--json', '--engine', 'ghost'])).out);
    assert.equal(pinned.tests[0].engine, 'ghost');
    const header = JSON.parse((await run('flags.aw', "# engine: ghost\n## plain\nopen('/plain'); expect('Plain page')\n", ['--json'])).out);
    assert.equal(header.tests[0].engine, 'ghost');
    const bad = await run('flags.aw', text, ['--no-gost']);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /unknown option --no-gost/);
  });

  it('follows a redirect written into the page, so every engine ends on the same URL', async () => {
    const r = await run('redirect.aw', "## gated page sends you home\nopen('/gated'); expect(url='/home'); expect('Home page')\n", ['--verbose']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /\[wire\]/);
    const wrong = await run('redirect.aw', "## stays\nopen('/gated'); expect(url='/gated')\n");
    assert.equal(wrong.code, 1, 'a test that expects to stay on the gated page fails on the HTTP tier too');
  });

  it('setup and teardown commands run, and what they print becomes ${variables}; exec() captures output', async () => {
    const mark = join(dir, 'mark.txt');
    const text = [
      `# setup: echo code=4711; echo started > ${mark}`,
      `# teardown: echo done >> ${mark}`,
      '## uses the seeded value',
      "open('/code?c=${code}'); expect('code is 4711')",
      '## reads a one-time code',
      "exec('echo 9921', as='otp'); open('/code?c=${otp}'); expect('code is 9921')",
      '## an unset variable is a clear failure',
      "open('/code?c=${nope}')",
      '## a failing command fails the test',
      "exec('echo boom >&2; exit 3')",
    ].join('\n');
    const r = await run('hooks.aw', text, ['--workers', '1']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /2 failed, 2 passed/);
    assert.match(r.out, /\$\{nope\} is not set/);
    assert.match(r.out, /the command failed: boom/);
    assert.ok(existsSync(mark));
    assert.equal(readFileSync(mark, 'utf8'), 'started\ndone\n', 'file setup ran once, teardown once at the end');
    const off = await run('hooks.aw', text, ['--no-exec']);
    assert.match(off.out, /switched off \(--no-exec\)/);
  });
});

describe('dev-server sockets', () => {
  it('recognises hot-reload sockets and leaves real ones alone', async () => {
    const { isDevSocket } = await import('../src/engines/chrome/page.ts');
    for (const u of ['ws://localhost:3987/_next/webpack-hmr', 'ws://localhost:3000/_next/hmr?id=1', 'ws://localhost:5173/?token=abc', 'ws://127.0.0.1:8080/ws', 'wss://example.com/sockjs-node/123/abc/websocket']) assert.ok(isDevSocket(u), u);
    for (const u of ['wss://example.com/ws', 'wss://chat.example.com/socket', 'wss://www.wolframalpha.com/n/v1/api/fetcher/results', 'not a url']) assert.ok(!isDevSocket(u), u);
  });
});
