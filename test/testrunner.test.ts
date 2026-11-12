import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, urlMatches, type RuntimeImpl } from '../src/runtime.ts';
import { createJar, createWireEngine, encodeForm } from '../src/net/index.ts';
import { createGuard, defaultPolicy } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';
import { readBody, mineEmbedded } from '../src/readers/index.ts';
import { startSite, type TestSite } from './core.site.ts';
import { parseTestFile } from '../src/test/parse.ts';
import { testCommand } from '../src/test/cli.ts';
import { stepToSource, resolveUrl } from '../src/test/runner.ts';

let site: TestSite;
let rt: RuntimeImpl;
let dir: string;
let n = 0;

before(async () => {
  site = await startSite();
  dir = mkdtempSync(join(tmpdir(), 'awtest-'));
  const policy = defaultPolicy('local');
  rt = createRuntime({ store: new MemoryStore(), engines: { wire: createWireEngine({ polite: false }) }, createJar, createGuard: (s) => createGuard(policy, s), encodeForm, readBody, mineEmbedded });
});
after(async () => {
  await rt.close();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
});

/** run `agentweb test` in-process over files written to a fresh directory */
async function run(files: Record<string, string>, args: string[] = []) {
  const d = join(dir, 'c' + ++n);
  mkdirSync(d, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text.replaceAll('$BASE', site.url));
  const out: string[] = [];
  const err: string[] = [];
  const code = await testCommand([d, ...args], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n'), d };
}

const ex = async (program: string) => rt.run('x' + ++n, program);

// ── expect extensions ────────────────────────────────────────────────────────────────────────

test('expect: text, count, not, url, title', async () => {
  const s = 'x' + ++n;
  await rt.run(s, `open('${site.url}/products')`);
  const ok = async (p: string) => assert.equal((await rt.run(s, p)).ok, true, p);
  const bad = async (p: string, m: RegExp) => {
    const r = await rt.run(s, p);
    assert.equal(r.ok, false, p);
    assert.match(r.text.split('\n')[0], m, p);
  };
  await ok(`expect('Mechanical Keyboard')`);
  await ok(`expect(not='Internal Server Error')`);
  await ok(`expect('Webcam', not='Nope')`);
  await ok(`expect(url='/products')`);
  await ok(`expect(url='/products/')`);
  await ok(`expect(url='/prod*')`);
  await ok(`expect(url='products')`);
  await ok(`expect(title='Products')`);
  await ok(`expect('Add to cart', n=5)`);
  await ok(`expect('Add to cart', count=5)`);
  await bad(`expect('Add to cart', n=4)`, /expected 4 of 'Add to cart', found 5/);
  await bad(`expect(not='Webcam')`, /'Webcam' is on the page but should not be/);
  await bad(`expect(url='/cart')`, /the address is \/products, expected \/cart/);
  await bad(`expect(title='Cart')`, /the title is/);
  await bad(`expect('Order placed')`, /'Order placed' is not on the page/);
  await bad(`expect()`, /expect needs text/);
});

test('urlMatches', () => {
  assert.ok(urlMatches('http://h:1/a/b?x=1', '/a/b'));
  assert.ok(!urlMatches('http://h:1/a/b?x=1', '/a'));
  assert.ok(urlMatches('http://h:1/a/b?x=1', '/a/b?x=1'));
  assert.ok(!urlMatches('http://h:1/a/b?x=1', '/a/b?x=2'));
  assert.ok(urlMatches('http://h:1/a/b', '/a/*'));
  assert.ok(urlMatches('http://h:1/a/b', 'http://h:1/*'));
  assert.ok(urlMatches('http://h:1/a/b', 'h:1'));
  assert.ok(urlMatches('http://h:1/', '/'));
});

// ── file format ──────────────────────────────────────────────────────────────────────────────

test('parse: headers, sections, line numbers, ; steps, comments', () => {
  const tcs = parseTestFile(
    `# base: http://x\n# profile: parent\n\n## one\nopen('/'); click('A')\n// note\nexpect('B')\n\n## two\n# profile:\n# skip: yes\nopen('/z')\n`,
    'a/f.aw',
  );
  assert.equal(tcs.length, 2);
  assert.deepEqual(tcs[0].steps.map((s) => [s.line, s.src]), [[5, "open('/')"], [5, "click('A')"], [7, "expect('B')"]]);
  assert.equal(tcs[0].base, 'http://x');
  assert.equal(tcs[0].profile, 'parent');
  assert.equal(tcs[1].profile, '');
  assert.equal(tcs[1].skip, true);
  assert.equal(tcs[1].name, 'two');
  const single = parseTestFile(`# name: my test\n# timeout: 5\nopen('/')`, 'dir/sign-in.aw');
  assert.equal(single[0].name, 'my test');
  assert.equal(single[0].timeoutMs, 5000);
  assert.equal(parseTestFile(`open('/')`, 'dir/sign-in.aw')[0].name, 'sign-in');
});

test('steps serialize and urls resolve', () => {
  assert.equal(stepToSource({ verb: 'click', args: ['Sign "in"'], opts: {}, src: '' }), 'click("Sign \\"in\\"")');
  assert.equal(stepToSource({ verb: 'expect', args: ['x'], opts: { n: 3 }, src: '' }), 'expect("x", n=3)');
  assert.equal(resolveUrl('/a?b=1', 'http://h:2/app'), 'http://h:2/a?b=1');
  assert.equal(resolveUrl('https://x.com/a', 'http://h'), 'https://x.com/a');
  assert.equal(resolveUrl('example.com/x', 'http://h'), 'example.com/x');
  assert.throws(() => resolveUrl('/a'), /no base/);
});

// ── runner ───────────────────────────────────────────────────────────────────────────────────

test('all green: one summary line, exit 0', async () => {
  const r = await run({
    'a.aw': `# base: $BASE\n## home\nopen('/'); expect('Welcome'); expect(url='/')\n## login\nopen('/login'); fill('Username','bob'); fill('Password','hunter2'); submit()\nexpect('Welcome back, bob'); expect(url='/account')\n`,
  });
  assert.equal(r.code, 0);
  assert.match(r.out, /^✓ 2 passed \(\d+(ms|\.\ds)\)$/);
});

test('failure: name, file:line, step, error, short excerpt, exit 1', async () => {
  const r = await run({ 'f.aw': `# base: $BASE\n## checkout\nopen('/products')\n\nexpect('Order placed')\nexpect('never reached')\n` });
  assert.equal(r.code, 1);
  const lines = r.out.split('\n');
  assert.match(lines[0], /^✗ checkout {2}.*f\.aw:5$/);
  assert.equal(lines[1], "  step:  expect('Order placed')");
  assert.equal(lines[2], "  error: 'Order placed' is not on the page");
  assert.equal(lines[3], '  page:');
  assert.match(r.out, /Mechanical Keyboard/);
  assert.match(lines[lines.length - 1], /^✗ 1 failed, 0 passed/);
  assert.ok(!r.out.includes('never reached'));
  assert.ok(lines.length <= 20, `report is ${lines.length} lines`);
});

test('tests are isolated: a sign-in does not leak into the next test', async () => {
  const r = await run(
    { 'iso.aw': `# base: $BASE\n## a\nopen('/login'); fill('Username','bob'); fill('Password','hunter2'); submit(); expect('Welcome back')\n## b\nopen('/account'); expect('Welcome back')\n` },
    ['--workers', '1'],
  );
  assert.equal(r.code, 1);
  assert.match(r.out, /✗ b/);
  assert.match(r.out, /✓|1 failed, 1 passed/);
});

test('relative url without a base is an error naming the line', async () => {
  const r = await run({ 'nb.aw': `open('/')\n` });
  assert.equal(r.code, 1);
  assert.match(r.out, /nb\.aw:1/);
  assert.match(r.out, /no base/);
});

test('--base overrides the file header; AGENTWEB_BASE works too', async () => {
  const r = await run({ 'b.aw': `# base: http://127.0.0.1:1\nopen('/'); expect('Welcome')\n` }, ['--base', site.url]);
  assert.equal(r.code, 0, r.out);
});

test('--grep, --bail, skip, --json', async () => {
  const files = { 'g.aw': `# base: $BASE\n## alpha\nopen('/'); expect('nope')\n## beta\nopen('/'); expect('Welcome')\n## gamma\n# skip: 1\nopen('/')\n` };
  const g = await run(files, ['--grep', 'beta']);
  assert.equal(g.code, 0);
  assert.match(g.out, /^✓ 1 passed/);
  const s = await run(files, ['--workers', '1', '--bail']);
  assert.equal(s.code, 1);
  assert.match(s.out, /1 failed, 0 passed/);
  const j = JSON.parse((await run(files, ['--json'])).out);
  assert.equal(j.ok, false);
  assert.equal(j.failed, 1);
  assert.equal(j.skipped, 1);
  assert.equal(j.passed, 1);
  const bad = j.tests.find((t: { ok: boolean }) => !t.ok);
  assert.equal(bad.name, 'alpha');
  assert.equal(bad.failure.line, 3);
  assert.equal(bad.failure.step, "expect('nope')");
});

test('a bad verb fails at its own line, with a short message', async () => {
  const r = await run({ 'v.aw': `# base: $BASE\nopen('/')\nclikc('x')\n` });
  assert.equal(r.code, 1);
  assert.match(r.out, /v\.aw:3/);
  assert.match(r.out, /unknown verb/);
});

test('parallel workers run every test', async () => {
  const body = Array.from({ length: 8 }, (_, i) => `## t${i}\nopen('/products'); expect('Webcam')\n`).join('');
  const r = await run({ 'p.aw': `# base: $BASE\n${body}` }, ['--workers', '4']);
  assert.match(r.out, /^✓ 8 passed/);
});

test('snapshot: written, compared, diff on change, --update accepts, --ci demands a baseline', async () => {
  const files = { 's.aw': `# base: $BASE\n## products page\nopen('/products'); snapshot('list')\n` };
  const first = await run(files);
  assert.equal(first.code, 0);
  assert.match(first.out, /1 snapshot written/);
  const snap = join(first.d, '__aw_snapshots__', 's', 'products-page.list.txt');
  assert.ok(existsSync(snap));
  assert.ok(!readFileSync(snap, 'utf8').includes(site.url), 'port-free baseline');
  const again = await testCommand([first.d], { out: (s) => (first.out = s), err() {} });
  assert.equal(again, 0);
  assert.match(first.out, /^✓ 1 passed/);
  assert.ok(!/snapshot/.test(first.out));
  writeFileSync(snap, readFileSync(snap, 'utf8').replace('Mechanical Keyboard', 'Mechanical Keyboard PRO'));
  let out = '';
  assert.equal(await testCommand([first.d], { out: (s) => (out = s), err() {} }), 1);
  assert.match(out, /snapshot 'list' changed/);
  assert.match(out, /^\s+- .*PRO/m);
  assert.match(out, /^\s+\+ .*Mechanical Keyboard/m);
  assert.equal(await testCommand([first.d, '--update'], { out: (s) => (out = s), err() {} }), 0);
  assert.equal(await testCommand([first.d], { out: (s) => (out = s), err() {} }), 0);
  const ci = await run({ 'c.aw': `# base: $BASE\nopen('/'); snapshot('x')\n` }, ['--ci']);
  assert.equal(ci.code, 1);
  assert.match(ci.out, /no baseline/);
});

test('record: refs become labels, urls become relative, replay verified', async () => {
  const d = join(dir, 'rec');
  mkdirSync(d);
  const file = join(d, 'login flow.aw');
  const out: string[] = [];
  // 1 = a numbered target the recorder must turn into its label: find the number first
  const view = await ex(`open('${site.url}/login')`);
  const num = /\{Username\}(\d+)/.exec(view.text)?.[1];
  assert.ok(num);
  const prog = `open('${site.url}/login'); fill(${num}, 'bob'); fill('Password','hunter2'); submit(); expect('Welcome back, bob')`;
  const code = await testCommand(['--record', file, prog, '--base', site.url], { out: (s) => out.push(s), err: (s) => out.push(s) });
  assert.equal(code, 0, out.join('\n'));
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^# name: login flow$/m);
  assert.match(text, new RegExp(`^# base: ${site.url.replace(/[.]/g, '\\.')}$`, 'm'));
  assert.match(text, /^open\("\/login"\)$/m);
  assert.match(text, /^fill\("Username", "bob"\)$/m);
  assert.ok(!/fill\(\d/.test(text));
  const r = await testCommand([file], { out: (s) => out.push(s), err() {} });
  assert.equal(r, 0);
  // a failing program is not saved
  const f2 = join(d, 'bad.aw');
  const c2 = await testCommand(['--record', f2, `open('${site.url}/'); expect('nope')`, '--base', site.url], { out: (s) => out.push(s), err() {} });
  assert.equal(c2, 1);
  assert.ok(!existsSync(f2));
});

test('no files, bad path, help', async () => {
  const e = join(dir, 'empty');
  mkdirSync(e);
  const out: string[] = [];
  assert.equal(await testCommand([e], { out: (s) => out.push(s), err: (s) => out.push(s) }), 1);
  assert.match(out.join(), /no test files/);
  assert.equal(await testCommand([join(dir, 'nope')], { out: (s) => out.push(s), err: (s) => out.push(s) }), 2);
  assert.equal(await testCommand(['--help'], { out: (s) => out.push(s), err() {} }), 0);
});
