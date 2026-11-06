import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from 'gpt-tokenizer';
import { createRuntime, type RuntimeImpl } from '../src/runtime.ts';
import { createJar, createWireEngine, encodeForm } from '../src/net/index.ts';
import { createGuard, defaultPolicy } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';
import { readBody, mineEmbedded } from '../src/readers/index.ts';
import { startSite, type TestSite } from './core.site.ts';

let site: TestSite;
let rt: RuntimeImpl;
let n = 0;
const fresh = () => 's' + ++n;

before(async () => {
  site = await startSite();
  const policy = defaultPolicy('local');
  rt = createRuntime({
    store: new MemoryStore(),
    engines: { wire: createWireEngine({ polite: false }) },
    createJar,
    createGuard: (state) => createGuard(policy, state),
    encodeForm,
    readBody,
    mineEmbedded,
  });
});
after(async () => {
  await rt.close();
  await site.close();
});

test('open shows a bounded view with numbered actionables', async () => {
  const r = await rt.run(fresh(), `open('${site.url}/')`);
  assert.equal(r.ok, true);
  assert.match(r.text, /^Home - Test Shop — http:\/\/127\.0\.0\.1:\d+\/$/m);
  assert.match(r.text, /nav: .*\[Products\]\d+/);
  assert.match(r.text, /\[USB-C Hub 7-in-1\]\d+ \| \$34\.99 \| \[Add to cart\]\d+/);
  assert.match(r.text, /\{Search products\}\d+/);
  assert.doesNotMatch(r.text, /Ignore previous instructions/, 'hidden text must not reach the model');
  assert.match(r.text, /1 hidden text block not shown/);
});

test('a whole login in one call, and the cookie persists in the session record', async () => {
  const s = fresh();
  const r = await rt.run(s, `open('${site.url}/login'); fill('Username', 'bob'); fill('Password', 'hunter2'); check('Remember me'); submit(); expect('Welcome back')`);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /^ok: open → fill → fill → check → submit → expect/);
  assert.match(r.text, /# Welcome back, bob/);
  assert.equal(r.stats.fetches, 2, 'two navigations: the login page, then the POST (its redirect is followed inside the engine)');
  assert.equal(site.hits['/account'], 1);
  const again = await rt.run(s, `open('${site.url}/account')`);
  assert.match(again.text, /Welcome back, bob|no visible change/);
});

test('a failed step stops the run, says why, and still shows the page', async () => {
  const r = await rt.run(fresh(), `open('${site.url}/login'); fill('Username', 'bob'); fill('Password', 'wrong'); submit(); expect('Welcome back'); click('Account')`);
  assert.equal(r.ok, false);
  assert.match(r.text, /✗ expect\('Welcome back'\) — 'Welcome back' is not on the page/);
  assert.match(r.text, /not run: click\('Account'\)/);
  assert.match(r.text, /! Invalid username or password/);
  assert.doesNotMatch(r.text, /wrong/, 'password values are never echoed');
});

test('acting on the same page returns only what changed', async () => {
  const s = fresh();
  await rt.run(s, `open('${site.url}/login'); fill('Username', 'bob'); fill('Password', 'hunter2'); submit()`);
  const r = await rt.run(s, `select('Plan', 'Team'); check('Newsletter'); click('green')`);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /same page; \d+ new or changed lines?/);
  assert.match(r.text, /\{Plan: Free\|Pro\|\*Team\}/);
  assert.match(r.text, /\{\[x\] Newsletter\}/);
  assert.match(r.text, /\{\(x\) green\}/);
  assert.doesNotMatch(r.text, /Account number/, 'unchanged lines are not repeated');
  const saved = await rt.run(s, `submit(); expect('Settings saved')`);
  assert.equal(saved.ok, true, saved.text);
  assert.match(saved.text, /\{Plan: Free\|Pro\|\*Team\}|Settings saved/);
});

test('text targets: ambiguity is an error with candidates, near= disambiguates', async () => {
  const s = fresh();
  const amb = await rt.run(s, `open('${site.url}/products'); click('Add to cart')`);
  assert.equal(amb.ok, false);
  assert.match(amb.text, /'Add to cart' matches 5 things/);
  assert.match(amb.text, /\[Add to cart\]\d+ in "USB-C Hub 7-in-1 \| \$34\.99"/);
  const ok = await rt.run(s, `click('Add to cart', near='Wireless Mouse'); expect('Your cart')`);
  assert.equal(ok.ok, true, ok.text);
  assert.match(ok.text, /Wireless Mouse \| \$24\.50/);
  assert.match(ok.text, /Total: \$24\.50/);
});

test('numbers stay valid across pages and a link ref can be followed from a later page', async () => {
  const s = fresh();
  const home = await rt.run(s, `open('${site.url}/')`);
  const cart = /\[Cart\](\d+)/.exec(home.text)![1];
  const kb = /\[Mechanical Keyboard\](\d+)/.exec(home.text)![1];
  const p = await rt.run(s, `click(${kb})`);
  assert.match(p.text, /# Mechanical Keyboard/);
  assert.match(p.text, /nav: \(as before/, 'navigation seen on the last page collapses');
  assert.match(p.text, /SKU \| SKU-200/);
  const c = await rt.run(s, `click(${cart}); expect('Your cart')`);
  assert.equal(c.ok, true, c.text);
});

test('find ranks lines without reading the page; read pages through it', async () => {
  const s = fresh();
  const r = await rt.run(s, `open('${site.url}/long'); find('refund within days')`, { budget: 600 });
  assert.equal(r.ok, true);
  assert.match(r.text, /Refunds are issued within 14 days/);
  assert.match(r.text, /## Refund policy/);
  assert.ok(encode(r.text).length <= 660, `find output over budget: ${encode(r.text).length}`);
  const sec = await rt.run(s, `read('Glossary')`, { budget: 500 });
  assert.match(sec.text, /## Glossary/);
  assert.match(sec.text, /more lines: read\(\) continues|end of section/);
});

test('output never exceeds the budget (within estimator tolerance)', async () => {
  for (const budget of [300, 800, 2000]) {
    const r = await rt.run(fresh(), `open('${site.url}/long')`, { budget });
    const real = encode(r.text).length;
    assert.ok(real <= budget * 1.1, `budget ${budget}: got ${real} tokens`);
    assert.match(r.text, /more lines|overview/);
  }
});

test('a JS shell is reported honestly when no script engine exists', async () => {
  const r = await rt.run(fresh(), `open('${site.url}/spa')`);
  assert.match(r.text, /needs JavaScript/);
  assert.match(r.text, /no script engine is available/);
});

test('a script-driven control from the wire tier fails loudly instead of pretending', async () => {
  const r = await rt.run(fresh(), `open('${site.url}/jsbutton'); click('Load more')`);
  assert.equal(r.ok, false);
  assert.match(r.text, /driven by JavaScript, and no script engine is available/);
});

test('JSON responses are rendered by a reader, not dumped', async () => {
  const r = await rt.run(fresh(), `open('${site.url}/api/items')`);
  assert.equal(r.ok, true);
  assert.match(r.text, /USB-C Hub 7-in-1/);
  assert.match(r.text, /\[json\]/);
  assert.ok(!r.text.includes('"price":'), 'no raw JSON syntax');
});

test('HTTP errors are visible in the header', async () => {
  const r = await rt.run(fresh(), `open('${site.url}/missing')`);
  assert.match(r.text, /\[HTTP 404\]/);
});

test('back returns to the previous page; sessions are isolated', async () => {
  const a = fresh();
  await rt.run(a, `open('${site.url}/'); click('Products')`);
  const b = await rt.run(a, `back(); expect('Five products')`);
  assert.equal(b.ok, true, b.text);
  const other = await rt.run(fresh(), `back()`);
  assert.equal(other.ok, false);
  assert.match(other.text, /no earlier page/);
});

test('a session is plain data: a second runtime on the same store continues it', async () => {
  const store = new MemoryStore();
  const policy = defaultPolicy('local');
  const mk = () => createRuntime({ store, engines: { wire: createWireEngine({ polite: false }) }, createJar, createGuard: (st) => createGuard(policy, st), encodeForm, readBody });
  const w1 = mk();
  const w2 = mk();
  const first = await w1.run('x', `open('${site.url}/login'); fill('Username', 'bob'); fill('Password', 'hunter2')`);
  assert.equal(first.ok, true, first.text);
  const second = await w2.run('x', `submit(); expect('Welcome back, bob')`);
  assert.equal(second.ok, true, second.text);
  const forked = await w1.run('y', `expect('Welcome back, bob'); open('${site.url}/cart')`, { fork: 'x' });
  assert.equal(forked.ok, true, forked.text);
});

test('bad programs come back with usable help, not a stack trace', async () => {
  const r = await rt.run(fresh(), `clik(3)`);
  assert.equal(r.ok, false);
  assert.match(r.text, /unknown verb 'clik'/);
  assert.match(r.text, /did you mean click\(\)/);
  const none = await rt.run(fresh(), `find('x')`);
  assert.match(none.text, /no page is open/);
});

test('a consequential step needs a confirmation token, which approves it once', async () => {
  const policy = { ...defaultPolicy('local'), confirm: 'consequential' as const };
  const r2 = createRuntime({ store: new MemoryStore(), engines: { wire: createWireEngine({ polite: false }) }, createJar, createGuard: (st) => createGuard(policy, st), encodeForm, readBody });
  const s = 'confirm-test';
  const refused = await r2.run(s, `open('${site.url}/p/1'); click('Add to cart'); click('Place order')`);
  assert.equal(refused.ok, false, refused.text);
  const token = /confirm ([0-9a-f]{8})/.exec(refused.text)?.[1];
  assert.ok(token, refused.text);
  const before = site.orders.length;
  const placed = await r2.run(s, `confirm('${token}'); click('Place order'); expect('Order placed')`);
  assert.equal(placed.ok, true, placed.text);
  assert.equal(site.orders.length, before + 1);
  await r2.close();
});

test("search(q, site=…) uses the site's own search form, learned once through the atlas", async () => {
  const { createAtlas } = await import('../src/atlas/index.ts');
  const policy = defaultPolicy('local');
  const store = new MemoryStore();
  const atlas = createAtlas(store, { flushEveryMs: 0 });
  const mk = () =>
    createRuntime({ store, engines: { wire: createWireEngine({ polite: false }) }, createJar, createGuard: (st) => createGuard(policy, st), encodeForm, readBody, atlas });
  const a = mk();
  const r1 = await a.run(fresh(), `search('keyboard', site='${site.url}')`);
  assert.ok(r1.ok, r1.text);
  assert.match(r1.text, /Results for "keyboard"/);
  assert.match(r1.text, /Mechanical Keyboard/);
  assert.equal(r1.stats.fetches, 2, 'home page, then the search URL');
  await atlas.flush();
  // a second worker on the same store goes straight to the results page
  const b = mk();
  const r2 = await b.run(fresh(), `search('mouse', site='${site.url}')`);
  assert.match(r2.text, /Wireless Mouse/);
  assert.equal(r2.stats.fetches, 1);
  await a.close();
  await b.close();
});
