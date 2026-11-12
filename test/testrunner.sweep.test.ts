// What a page sweep needs from `agentweb test` (reported by a project moving its Playwright sweep over): a table of
// cases, soft assertions, a sign-in made by setup, no approval prompts for the file's own steps, a separate wait for
// one assertion, a heading check, allowed statuses, the same menu on every page, a report to look at.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCommand } from '../src/test/cli.ts';
import { parseTestFile } from '../src/test/parse.ts';

process.env.AGENTWEB_TEST_MEMORY = '0';

let server: Server;
let base = '';
let port = 0;
let dir = '';
let n = 0;
const nav = (extra = '') => `<nav><a data-menu href="/a">Alpha</a> <a data-menu href="/b">Beta</a>${extra}</nav>`;
const page = (title: string, body: string, h = 'h1') => `<!doctype html><html lang="en"><head><title>${title}</title></head><body>${body.includes('<nav') ? '' : nav()}<main><${h}>${title}</${h}>${body}</main></body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const send = (html: string, status = 200) => res.writeHead(status, { 'content-type': 'text/html' }).end(html);
    if (u.pathname === '/a') return send(page('Alpha', '<p>First page.</p>'));
    if (u.pathname === '/b') return send(page('Beta', '<p>Second page.</p>'));
    if (u.pathname === '/c') return send(page('Gamma', nav(' <a data-menu href="/c">Gamma</a>') + '<p>Third page, with one more menu item.</p>'));
    if (u.pathname === '/aria') return send(`<!doctype html><html lang="en"><head><title>Reset</title></head><body><main><div data-slot="card-title" role="heading" aria-level="1">Reset your password</div><div role="heading">Sub part</div><p>Enter your email.</p></main></body></html>`);
    if (u.pathname === '/h2only') return send(page('Small', '<p>No main heading.</p>', 'h2'));
    if (u.pathname === '/delete-account') return send(page('Delete account', '<p>How to delete your account: write to us.</p>'));
    if (u.pathname === '/me') return send(page('Account', /sid=ok/.test(req.headers.cookie ?? '') ? '<p>Signed in as Maya.</p>' : '<p>Signed out.</p>'));
    if (u.pathname === '/api401') return res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
    if (u.pathname === '/with401') return send(page('Probe', '<p id="o">…</p><script>fetch("/api401").then(function(r){document.getElementById("o").textContent="answered "+r.status})</script>'));
    send(page('Not found', ''), 404);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  dir = mkdtempSync(join(tmpdir(), 'aw-sweep-'));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function run(files: Record<string, string>, args: string[] = []) {
  const d = join(dir, 'c' + ++n);
  mkdirSync(d, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text.replaceAll('$BASE', base));
  const out: string[] = [];
  const err: string[] = [];
  const code = await testCommand([d, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n'), d };
}

test('# each: one body, one test per value, the value in the name and the steps', async () => {
  const cases = parseTestFile("# each: path in /a, /b\n## page ${path} loads\nopen('${path}'); expect(role='heading', level=1)\n## other\n# each: who in x\nopen('/a')\n", 'f.aw');
  assert.deepEqual(cases.map((c) => c.name), ['page /a loads', 'page /b loads', 'other [/a]', 'other [/b]'].slice(0, 2).concat(['other [x]']));
  assert.equal(cases[1].steps[0].src, "open('/b')");
  const r = await run({ 'each.aw': "# base: $BASE\n# each: path in /a, /b, /delete-account\n## ${path} is a page\nopen('${path}'); expect(not='Not found'); expect(role='heading', level=1)\n" }, ['--verbose']);
  assert.equal(r.code, 0, r.out);
  // each test's line as it ends, then the summary; a page called "delete" is opened without asking for approval
  assert.match(r.out, /✓ \/a is a page .*\n✓ \/b is a page .*\n✓ \/delete-account is a page .*\n(agentweb .*\n)?(resources.*\n)?✓ 3 passed/);
});

test("expect(role='heading', level=1) says which headings there are when there is none", async () => {
  const r = await run({ 'h.aw': "# base: $BASE\nopen('/h2only'); expect(role='heading', level=1)\n" });
  assert.equal(r.code, 1);
  assert.match(r.out, /error: no level 1 heading on the page \(headings: h2 "Small"\)/);
});

test('soft assertions: every failure of the test is reported together, and the steps after a failure still run', async () => {
  const r = await run({ 'soft.aw': "# base: $BASE\n# soft: on\n# expect-timeout: 0.3\nopen('/a')\nexpect('Nope one')\nexpect('First page')\nexpect(title='Wrong')\nopen('/b'); expect('Second page')\n" });
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ soft .*soft\.aw:5.*\n  step:  expect\('Nope one'\)\n  error: 'Nope one' is not on the page\n {9}also line 7: expect\(title='Wrong'\) — the title is 'Alpha', expected 'Wrong'/, r.out);
  const one = await run({ 'soft1.aw': "# base: $BASE\n# expect-timeout: 0.3\nopen('/a'); expect('Nope', soft=1); expect('Alpha'); expect('Also nope')\n" });
  assert.match(one.out, /error: 'Also nope' is not on the page\n {9}also line 3: expect\('Nope', soft=1\) — 'Nope' is not on the page/, one.out);
});

test('# expect-timeout: is the wait of one assertion; # timeout: stays the limit of the test', async () => {
  const t0 = Date.now();
  const r = await run({ 'wait.aw': "# base: $BASE\n# timeout: 60\n# expect-timeout: 1\nopen('/a'); expect('Never there')\n" });
  assert.equal(r.code, 1);
  assert.ok(Date.now() - t0 < 15_000, `waited ${Date.now() - t0} ms`);
});

test('a sign-in made by the setup command: it prints profile=/path and the test uses # profile: ${profile}', async () => {
  const d = join(dir, 'signin');
  mkdirSync(d, { recursive: true });
  const state = (domain: string) => JSON.stringify({ cookies: [{ name: 'sid', value: 'ok', domain, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] });
  writeFileSync(join(d, 'mint.mjs'), `import { writeFileSync } from 'node:fs';\nconst f = ${JSON.stringify(join(d, 'state.json'))};\nwriteFileSync(f, ${JSON.stringify(state('127.0.0.1'))});\nconsole.log('profile=' + f);\n`);
  const r = await run({ 'signin.aw': `# base: $BASE\n# setup: node ${join(d, 'mint.mjs')}\n# profile: \${profile}\n## account page\nopen('/me'); expect('Signed in as Maya')\n## signed out when asked\n# profile:\nopen('/me'); expect('Signed out')\n` });
  assert.equal(r.code, 0, r.out);
  // a sign-in saved for another host does nothing, and the report says so in one line
  writeFileSync(join(d, 'other.json'), state('0.0.0.0'));
  const w = await run({ 'wrong.aw': `# base: $BASE\n# expect-timeout: 0.3\n## a\nopen('/me'); expect('Signed in as Maya')\n## b\nopen('/me'); expect('Signed in as Maya')\n`.replace('# expect', `# profile: ${join(d, 'other.json')}\n# expect`) });
  assert.equal(w.code, 1);
  assert.equal(w.out.match(/^! profile '.*other\.json' has no cookies for 127\.0\.0\.1 \(it has 0\.0\.0\.0\): pages here open signed out$/gm)?.length, 1, w.out);
});

test("requests: allow_status lets an expected 401 through; without it the check fails", async () => {
  const bad = await run({ 'r.aw': "# base: $BASE\n# engine: chrome\nopen('/with401'); expect('answered 401'); expect(requests=0)\n" });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /1 request failed/);
  const ok = await run({ 'r.aw': "# base: $BASE\n# engine: chrome\n# console: clean, allow=401\nopen('/with401'); expect('answered 401'); expect(requests=0, allow_status='401')\n" });
  assert.equal(ok.code, 0, ok.out);
});

test("expect(same='menu', of=…): the same in every test of the run; --report writes a page with a screenshot per test", async () => {
  // the odd page comes FIRST and the selector has double quotes in it: neither may matter
  const body = "# base: $BASE\n# engine: chrome\n# each: path in /c, /a, /b\n## menu on ${path}\nopen('${path}'); expect(same='menu', of='nav [data-menu]:not([href=\"/zzz\"] *)')\n";
  const r = await run({ 'menu.aw': body }, ['--workers', '2', '--report', join(dir, 'report')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ menu on \/c .*\n  step:  expect\(same='menu', of='nav \[data-menu\]:not\(\[href="\/zzz"\] \*\)'\)\n  error: 'menu' is different here: 1 of 3 tests differ from the other 2 \(- the others, \+ here\)\n {9}\+ Gamma/, r.out);
  assert.match(r.out, /✗ 1 failed, 2 passed/);
  const html = readFileSync(join(dir, 'report', 'index.html'), 'utf8');
  assert.match(html, /<h1>✗ 1 failed, 2 passed/);
  const shots = readdirSync(join(dir, 'report')).filter((f) => /\.(jpe?g|png)$/.test(f));
  assert.equal(shots.length, 3, shots.join(' '));
  for (const s of shots) assert.ok(html.includes(`src="${s}"`) && existsSync(join(dir, 'report', s)));
  assert.match(html, /menu on \/c<\/h2>[\s\S]*is different here/);
});

test("shot(attach='label') puts a named picture in the report; without --report the step does nothing", async () => {
  const body = "# base: $BASE\n# engine: chrome\nopen('/a'); shot(full=1, attach='first page'); open('/b'); expect('Second page')\n";
  assert.equal((await run({ 'pics.aw': body })).code, 0);
  const out = join(dir, 'report2');
  const r = await run({ 'pics.aw': body }, ['--report', out]);
  assert.equal(r.code, 0, r.out);
  const html = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(html, /<figcaption>first page<\/figcaption>/);
  assert.equal(readdirSync(out).filter((f) => /\.(jpe?g|png)$/.test(f)).length, 2);
});

test('a heading by ARIA is a heading: role="heading" with aria-level (level 2 when none is given)', async () => {
  // in the real browser too, where attributes are read by the in-page extractor
  const chrome = await run({ 'aria.aw': "# base: $BASE\n# engine: chrome\nopen('/aria'); expect('Reset your password', role='heading', level=1)\n" });
  assert.equal(chrome.code, 0, chrome.out);
  const ok = await run({ 'aria.aw': "# base: $BASE\nopen('/aria'); expect(role='heading', level=1); expect('Reset your password', role='heading', level=1); expect('Sub part', role='heading', level=2)\n" });
  assert.equal(ok.code, 0, ok.out);
  const bad = await run({ 'aria.aw': "# base: $BASE\nopen('/aria'); expect(role='heading', level=3)\n" });
  assert.match(bad.out, /no level 3 heading on the page \(headings: h1 "Reset your password", h2 "Sub part"\)/);
});

test('--grep-test selects by the title as written; # each: feeds numbers into steps', async () => {
  const body = "# base: $BASE\n## employee pages\n# each: path in /a, /b\nopen('${path}'); expect(not='Not found')\n## instructor pages\n# each: path in /a/employees\nopen('/a'); expect('Alpha')\n## widths\n# each: width in 390, 768\nemulate(${width}, 900); open('/a'); expect('Alpha')\n";
  const r = await run({ 'g.aw': body }, ['--grep-test', 'employee', '--verbose']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ 2 passed/);
  assert.doesNotMatch(r.out, /instructor/);
  const w = await run({ 'g.aw': body }, ['--grep-test', 'widths', '--json']);
  const tests = JSON.parse(w.out).tests;
  assert.match(JSON.parse(w.out).agentweb, /^\d+\.\d+\.\d+/, 'the result says which build ran it');
  assert.deepEqual(tests.map((t: { name: string }) => t.name), ['widths [390]', 'widths [768]']);
  assert.match(tests[0].emulation, /390/);
});

test('--setup and --teardown run once for the whole run; their variables and ${worker} reach every file', async () => {
  const d = join(dir, 'world');
  mkdirSync(d, { recursive: true });
  const log = join(d, 'log.txt');
  writeFileSync(join(d, 'up.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'up workers=' + process.env.AW_WORKERS + '\\n');\nconsole.log('page=/a');\n`);
  writeFileSync(join(d, 'down.mjs'), `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(log)}, 'down page=' + process.env.AW_PAGE + '\\n');\n`);
  const one = "# base: $BASE\n## uses the world\nopen('${page}'); expect('Alpha'); exec('echo w=${worker}'); expect('worker number ${w}', soft=1)\n";
  const r = await run({ 'one.aw': one, 'two.aw': one.replace('uses the world', 'again') }, ['--workers', '2', '--setup', `node ${join(d, 'up.mjs')}`, '--teardown', `node ${join(d, 'down.mjs')}`]);
  assert.equal(readFileSync(log, 'utf8'), 'up workers=2\ndown page=/a\n');
  // the worker number is 0 or 1: neither is on the page, so both tests fail softly, each naming its own number
  assert.match(r.out, /'worker number [01]' is not on the page/);
  const failing = await run({ 'one.aw': one }, ['--setup', 'echo nope >&2; exit 3']);
  assert.equal(failing.code, 1);
  assert.match(failing.out, /error: run setup failed \(echo nope >&2; exit 3\): nope/);
});

test("mail(to=…): the newest message of a local mailbox; its link and code are variables", async () => {
  let asked = 0;
  const box = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/api/v1/search') return res.end(JSON.stringify(++asked < 3 || !u.searchParams.get('query')!.includes('to:maya@example.com') ? { messages: [] } : { messages: [{ ID: 'm1' }] }));
    if (u.pathname === '/api/v1/message/m1') return res.end(JSON.stringify({ Subject: 'Your sign-in link', Text: `Hello. Your code is 482913. Or open ${base}/b now.`, HTML: `<p>Your code is <b>482913</b></p><a href="${base}/b?x=1&amp;y=2">Sign in</a>` }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => box.listen(0, '127.0.0.1', r));
  process.env.AGENTWEB_MAILPIT = `http://127.0.0.1:${(box.address() as AddressInfo).port}`;
  try {
    const r = await run({ 'mail.aw': "# base: $BASE\nopen('/a'); mail(to='maya@example.com', wait=10); open('${mail.link}'); expect('Second page'); expect(url='/b?x=1&y=2'); exec('echo got=${mail.code}/${mail.subject}'); expect(title='Beta')\n" });
    assert.equal(r.code, 0, r.out);
    assert.ok(asked >= 3, 'it waited for the message to arrive');
    const none = await run({ 'mail.aw': "# base: $BASE\nopen('/a'); mail(to='nobody@example.com', wait=1)\n" });
    assert.match(none.out, /error: no message arrived for nobody@example\.com within 1 s/);
  } finally {
    delete process.env.AGENTWEB_MAILPIT;
    box.close();
  }
  const off = await run({ 'mail.aw': "# base: $BASE\nopen('/a'); mail(to='a@b.co')\n" });
  assert.match(off.out, /no mailbox is configured: set AGENTWEB_MAILPIT=/);
});
