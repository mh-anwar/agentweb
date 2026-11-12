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
  assert.match(r.out, /✓ \/a is a page .*\n✓ \/b is a page .*\n✓ \/delete-account is a page .*\n(resources.*\n)?✓ 3 passed/);
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
  const body = "# base: $BASE\n# engine: chrome\n# each: path in /a, /b, /c\n## menu on ${path}\nopen('${path}'); expect(same='menu', of='[data-menu]')\n";
  const r = await run({ 'menu.aw': body }, ['--workers', '1', '--report', join(dir, 'report')]);
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ menu on \/c .*\n  step:  expect\(same='menu', of='\[data-menu\]'\)\n  error: 'menu' differs from the test "menu on \/a" \(- there, \+ here\)\n {9}\+ Gamma/, r.out);
  assert.match(r.out, /✗ 1 failed, 2 passed/);
  const html = readFileSync(join(dir, 'report', 'index.html'), 'utf8');
  assert.match(html, /<h1>✗ 1 failed, 2 passed/);
  const shots = readdirSync(join(dir, 'report')).filter((f) => /\.(jpe?g|png)$/.test(f));
  assert.equal(shots.length, 3, shots.join(' '));
  for (const s of shots) assert.ok(html.includes(`src="${s}"`) && existsSync(join(dir, 'report', s)));
  assert.match(html, /menu on \/c<\/h2>[\s\S]*differs from the test/);
});
