// find() when the words are not on the page: say so plainly, and when nothing follows in the program and the
// site's own search has the thing, show that instead of costing the agent another call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, type RuntimeImpl } from '../src/runtime.ts';
import { createJar, createWireEngine, encodeForm } from '../src/net/index.ts';
import { createGuard, defaultPolicy } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';
import { readBody, mineEmbedded } from '../src/readers/index.ts';
import { startFarm, type Farm } from '../bench/sites/farm.ts';

let farm: Farm;
let rt: RuntimeImpl;
let n = 0;
before(async () => {
  farm = await startFarm({ seed: 7 });
  const policy = defaultPolicy('local');
  rt = createRuntime({ store: new MemoryStore(), engines: { wire: createWireEngine({ polite: false }) }, createJar, createGuard: (s) => createGuard(policy, s), encodeForm, readBody, mineEmbedded });
});
after(async () => {
  await rt.close();
  await farm.close();
});
const run = async (p: string) => (await rt.run('f' + ++n, p.replaceAll('$U', farm.url))).text;

test('a name that is elsewhere on the site: the last find() answers from the site search', async () => {
  const text = await run("open('$U/shop/'); find('Kestrel Flux 310')");
  assert.match(text, /note: 'Kestrel Flux 310' is not on .*\/shop\/; this is the site's own search for it/);
  assert.match(text, /\[Kestrel Flux 310 Camera\]\d+ \| \$1,325\.99/);
  assert.doesNotMatch(text, /Mosaic/);
});

test('a near miss is called a miss, not "1 match"', async () => {
  const text = await run("open('$U/shop/'); find('Kestrel Flux 310'); links('Cameras')");
  assert.match(text, /no line on this page has all of 'Kestrel Flux 310'; closest:/);
  assert.doesNotMatch(text, /1 match for/);
  assert.doesNotMatch(text, /site's own search/, 'the page stays put when more steps follow');
});

test('words the site search does not have either: the answer is about this page, and the page stays', async () => {
  for (const q of ['Zzyzx Quux 999', 'return policy']) {
    const text = await run(`open('$U/shop/'); find('${q}'); links('Cameras')`.replace("; links('Cameras')", ''));
    assert.doesNotMatch(text, /site's own search/, q);
    assert.match(text, /no match for|no line on this page has all of/, q);
  }
  const s = 'f' + ++n;
  await rt.run(s, `open('${farm.url}/shop/'); find('Zzyzx Quux 999')`);
  assert.match((await rt.run(s, 'view()')).text, /Spring tech sale/);
});

test('one-word and long queries keep the plain count', async () => {
  assert.match(await run("open('$U/shop/'); find('Keyboard')"), /\d+ match(es)? for 'Keyboard'/);
});

test('a field with no label of its own answers to the words beside it', async () => {
  const s = 'f' + ++n;
  const r = await rt.run(s, `open('${farm.url}/news/login?goto=news'); fill('username', 'someone'); fill('password', 'pw'); view()`);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /\{acct="someone"\}/);
});

test("a button's number still works from another page: the session goes back to the button's page", async () => {
  const s = 'f' + ++n;
  const first = (await rt.run(s, `open('${farm.url}/shop/search?q=Kestrel+Flux+310')`)).text;
  const num = Number(/\[Kestrel Flux 310 Camera\]\d+ \|.*?\[Add to cart\](\d+)/.exec(first)![1]);
  await rt.run(s, `open('${farm.url}/shop/search?q=Lumos')`);
  const r = await rt.run(s, `click(${num})`);
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, new RegExp(`note: ${num} \\(\\[Add to cart\\]\\) is on .*q=Kestrel\\+Flux\\+310: went back to that page for it`));
  assert.match((await rt.run(s, `open('${farm.url}/shop/cart'); read()`)).text, /Kestrel Flux 310 Camera \| \$1,325\.99 \| 1/);
});

test("click('2') is the control that reads 2 (a page link), not whatever happens to be numbered 2", async () => {
  const s = 'f' + ++n;
  const first = (await rt.run(s, `open('${farm.url}/shop/'); search('Auberon'); view()`)).text;
  assert.match(first, /\[Accept all\]2 /, 'number 2 in this session is another control');
  const r = await rt.run(s, "click('2'); find('products ·')");
  assert.match(r.text, /page 2 of 2/, r.text);
  assert.match(r.text, /note: '2' was taken as the control that reads "2"/);
  // unquoted, it is the number
  const t = 'f' + ++n;
  await rt.run(t, `open('${farm.url}/shop/'); search('Auberon'); view()`);
  assert.match((await rt.run(t, "click(2); find('products ·')")).text, /Accept all/);
});

test('a config key on a docs site: the last find() answers from the docs search, value included', async () => {
  const text = await run("open('$U/docs/'); find('scheduler.trace.idle_timeout_ms')");
  assert.match(text, /this is the site's own search for it/);
  assert.match(text, /\[Configuration reference\]\d+ .*scheduler\.trace\.idle_timeout_ms integer 7847/);
});

test('word for word beats lines that only share words', async () => {
  const text = await run("open('$U/docs/configuration-reference'); find('dispatcher.audit.idle_timeout_ms')");
  assert.match(text, /^1 match for 'dispatcher\.audit\.idle_timeout_ms' \(word for word; \d+ looser matches left out\):/m);
  assert.match(text, /dispatcher\.audit\.idle_timeout_ms \| integer \| 4202/);
  assert.doesNotMatch(text, /collector\.core/);
});

test('an entry further down an endless feed: the last find() scrolls for it', async () => {
  const { createAgentweb } = await import('../src/index.ts');
  const full = await createAgentweb({ store: 'memory:', atlas: false, env: { ...process.env, AGENTWEB_ALLOW_PRIVATE: '1' } });
  try {
    const r = await full.run('feed', `open('${farm.url}/hard/infinite'); find('Feed entry 45')`);
    assert.match(r.text, /note: scrolled .* for more of the list/);
    assert.match(r.text, /45\. Feed entry 45: /);
  } finally {
    await full.close();
  }
});

test("records('price stock'): a field name that is written on no item is dropped, not a reason to match nothing", async () => {
  const { createAgentweb } = await import('../src/index.ts');
  const full = await createAgentweb({ store: 'memory:', atlas: false, env: { ...process.env, AGENTWEB_ALLOW_PRIVATE: '1' } });
  try {
    const text = (await full.run('rec', `open('${farm.url}/spa/'); click('Keyboards'); records('price stock', pages=5)`, { budget: 6000 })).text;
    assert.match(text, /no record has the word 'price' \(words filter what is written on an item\), so only the rest is used\. 25 records matching 'price stock' over 2 pages:/);
    assert.match(text, /Keyboard\]\d+ \| \$\d/);
  } finally {
    await full.close();
  }
});

test('the text of a frame the page titles or serves itself is read in under its line, without a browser', async () => {
  const text = await run("open('$U/hard/frames'); read()");
  assert.match(text, /frame: Order status\n### Order status\nVerification code: SAMEFRAME-\w+/);
  assert.match(text, /frame: Partner widget\n### Partner widget\nPartner code: CROSSFRAME-\w+/);
  // the frame's line is still a link to the frame itself
  assert.match(await run("open('$U/hard/frames'); links('frame')"), /\[frame: Order status\]\d+ http:\/\/[^\s]+\/hard\/frame-inner/);
});
