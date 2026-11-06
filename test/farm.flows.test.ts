import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFarm } from '../bench/sites/farm.ts';
import type { Farm } from '../bench/sites/farm.ts';
import { quote } from '../bench/sites/truth.ts';
import { money } from '../bench/sites/rng.ts';
import { Client, hidden, shopCheckout, bankLogin, bankTransfer, textOf, count } from './farm.helpers.ts';

let farm: Farm;
before(async () => { farm = await startFarm(); });
after(async () => { await farm.close(); });

const inStock = () => farm.truth.shop.products.filter((p) => p.stock >= 3);

test('shop: cart add redirects (POST/redirect/GET), remove, out of stock refused', async () => {
  farm.reset();
  const c = new Client(farm.url);
  const p = inStock()[0]!;
  const r = await c.post('/shop/cart/add', { product_id: String(p.id), qty: '2' }, false);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/shop/cart');
  assert.ok(c.jar.has('shop_sid'));
  const cart = await c.get('/shop/cart');
  assert.ok(cart.text.includes(p.name));
  assert.match(textOf(cart.text), new RegExp(`Subtotal: ${money(p.priceCents * 2).replace('$', '\\$')}`));
  await c.post('/shop/cart/remove', { product_id: String(p.id) });
  assert.match((await c.get('/shop/cart')).text, /Your cart is empty/);
  const oos = farm.truth.shop.products.find((x) => x.stock === 0)!;
  const r2 = await c.post('/shop/cart/add', { product_id: String(oos.id) });
  assert.match(r2.text, /out of stock/);
  assert.deepEqual(farm.state().cartEvents.map((e) => e.op), ['add', 'remove']);
  // a different client has its own cart
  assert.match((await new Client(farm.url).get('/shop/cart')).text, /Your cart is empty/);
});

test('shop: checkout needs a CSRF token and re-renders validation errors in the form', async () => {
  farm.reset();
  const c = new Client(farm.url);
  const p = inStock()[1]!;
  await c.post('/shop/cart/add', { product_id: String(p.id), qty: '1' });
  const noToken = await c.post('/shop/checkout/shipping', { name: 'A B', email: 'a@b.co', address: '1 St', city: 'X', state: 'OR', zip: '97201' });
  assert.equal(noToken.status, 403);
  assert.match(noToken.text, /CSRF/);
  const csrf = hidden((await c.get('/shop/checkout/shipping')).text, 'csrf_token');
  const bad = await c.post('/shop/checkout/shipping', { csrf_token: csrf, name: 'Zed Quill', email: 'not-an-email', address: '', city: 'Austin', state: '', zip: '123' });
  assert.equal(bad.status, 200);
  assert.match(bad.text, /Enter a valid email address\./);
  assert.match(bad.text, /ZIP code must be 5 digits\./);
  assert.match(bad.text, /Choose a state\./);
  assert.match(bad.text, /value="Zed Quill"/, 'good values stay in the form');
  assert.match(bad.text, /value="not-an-email"/);
  assert.equal(farm.state().orders.length, 0);
  // payment step cannot be skipped
  const skip = await new Client(farm.url).get('/shop/checkout/review');
  assert.match(skip.url, /\/shop\/cart$/);
  const good = await c.post('/shop/checkout/shipping', { csrf_token: csrf, name: 'Zed Quill', email: 'z@q.io', address: '5 Elm', city: 'Austin', state: 'TX', zip: '78701' });
  assert.match(good.url, /checkout\/payment$/);
  const badCard = await c.post('/shop/checkout/payment', { csrf_token: hidden(good.text, 'csrf_token'), method: 'standard', card_name: 'Zed', card_number: '4242 4242 4242 4241', card_expiry: '01/20', card_cvc: '12' });
  assert.match(badCard.text, /Enter a valid 16-digit card number\./);
  assert.match(badCard.text, /Enter a future expiry date as MM\/YY\./);
  assert.match(badCard.text, /CVC must be 3 or 4 digits\./);
});

test('shop: full purchase produces an order with the right totals', async () => {
  farm.reset();
  const c = new Client(farm.url);
  const p = inStock()[2]!;
  const done = await shopCheckout(c, { productId: p.id, qty: 2 });
  assert.match(done.url, /\/shop\/order\/ORD-[A-F0-9]{8}$/);
  const qt = quote([{ priceCents: p.priceCents, qty: 2 }]);
  const text = textOf(done.text);
  assert.match(text, /Thank you for your order/);
  assert.ok(text.includes(money(qt.total)), `${money(qt.total)} not in confirmation`);
  const st = farm.state();
  assert.equal(st.orders.length, 1);
  assert.equal(st.orders[0]!.totalCents, qt.total);
  assert.equal(st.orders[0]!.cardLast4, '4242');
  assert.ok(text.includes(st.orders[0]!.id));
  // cart is empty afterwards and a replayed "place" does nothing
  assert.match((await c.get('/shop/cart')).text, /Your cart is empty/);
  // express adds its own shipping line
  const e = await shopCheckout(new Client(farm.url), { productId: p.id, qty: 1, method: 'express' });
  assert.equal(farm.state().orders[1]!.shippingCents, 1499);
  assert.ok(textOf(e.text).includes(money(quote([{ priceCents: p.priceCents, qty: 1 }], 'express').total)));
  // order ids are deterministic per seed and counter
  const f2 = await startFarm({ seed: farm.truth.seed });
  try {
    await shopCheckout(new Client(f2.url), { productId: p.id, qty: 2 });
    assert.equal(f2.state().orders[0]!.id, st.orders[0]!.id);
  } finally { await f2.close(); }
  farm.reset();
  assert.equal(farm.state().orders.length, 0);
  assert.match((await c.get('/shop/cart')).text, /Your cart is empty/);
});

test('news: voting needs a login; login by POST; a vote counts once', async () => {
  farm.reset();
  const t = farm.truth.news;
  const c = new Client(farm.url);
  const front = await c.get('/news/');
  const m = /<a id="up_(\d+)" href="(vote\?[^"]+)"/.exec(front.text)!;
  const anon = await c.get('/news/' + m[2]!.replace(/&amp;/g, '&'), false);
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get('location')!, /^\/news\/login\?goto=/);
  const bad = await c.post('/news/login', { acct: t.account.user, pw: 'wrong', goto: 'news' });
  assert.match(bad.text, /Bad login\./);
  const ok = await c.post('/news/login', { acct: t.account.user, pw: t.account.password, goto: 'news' });
  assert.match(ok.text, new RegExp(`href="/news/user\\?id=${t.account.user}"`));
  const logged = await c.get('/news/');
  const link = /<a id="up_(\d+)" href="(vote\?[^"]+)"/.exec(logged.text)!;
  const id = Number(link[1]);
  const before = Number(new RegExp(`id="score_${id}">(\\d+) point`).exec(logged.text)![1]);
  const after1 = await c.get('/news/' + link[2]!.replace(/&amp;/g, '&'));
  assert.equal(Number(new RegExp(`id="score_${id}">(\\d+) point`).exec(after1.text)![1]), before + 1);
  assert.ok(!new RegExp(`id="up_${id}"`).test(after1.text), 'arrow is hidden after voting');
  await c.get('/news/' + link[2]!.replace(/&amp;/g, '&'));
  assert.deepEqual(farm.state().votes, [{ user: t.account.user, storyId: id }]);
  assert.deepEqual(farm.state().logins.map((l) => l.ok), [false, true]);
  // a token for another user does not work
  const forged = await c.get(`/news/vote?id=${id}&how=up&auth=deadbeef&goto=news`, false);
  assert.equal(forged.status, 403);
});

test('bank: transfer needs CSRF, checks funds, moves money, and is recorded', async () => {
  farm.reset();
  const b = farm.truth.bank;
  const c = new Client(farm.url);
  assert.equal((await bankLogin(c, b.user, 'nope')).status, 401);
  await bankLogin(c, b.user, b.password);
  const dash = await c.get('/bank/');
  assert.ok(textOf(dash.text).includes(money(b.accounts[0]!.balanceCents)));
  const noCsrf = await c.post('/bank/transfer', { from: b.accounts[0]!.number, to: b.payees[0]!.number, amount: '10', confirm: 'yes' });
  assert.equal(noCsrf.status, 403);
  const tooMuch = await bankTransfer(c, { from: b.accounts[0]!.number, to: b.payees[0]!.number, amount: String(b.accounts[0]!.balanceCents / 100 + 1), memo: '' });
  assert.match(tooMuch.text, /Insufficient funds/);
  assert.equal(farm.state().transfers.length, 0);
  const ok = await bankTransfer(c, { from: b.accounts[0]!.number, to: b.payees[0]!.number, amount: '125.50', memo: 'October rent' });
  assert.match(ok.text, /Transfer complete/);
  const st = farm.state();
  assert.equal(st.transfers.length, 1);
  assert.equal(st.transfers[0]!.amountCents, 12550);
  assert.ok(ok.text.includes(st.transfers[0]!.ref));
  assert.ok(textOf((await c.get('/bank/')).text).includes(money(b.accounts[0]!.balanceCents - 12550)));
  farm.reset();
  const c2 = new Client(farm.url);
  await bankLogin(c2, b.user, b.password);
  assert.ok(textOf((await c2.get('/bank/')).text).includes(money(b.accounts[0]!.balanceCents)), 'reset restores balances');
});

test('forms: registration validates, accepts multipart with a file, never records the password', async () => {
  farm.reset();
  const c = new Client(farm.url);
  const fd = (over: Record<string, string | string[]> = {}, withFile = true) => {
    const f = new FormData();
    const v: Record<string, string | string[]> = { form_id: 'registration-v2', full_name: 'Maya Lindqvist', email: 'maya@example.com', password: 'longenough1', age: '34', birthdate: '1991-07-14', country: 'Norway', interests: ['chess', 'hiking'], plan: 'pro', days: ['tue', 'thu'], bio: 'Hello', newsletter: 'yes', terms: 'accepted', ...over };
    for (const [k, x] of Object.entries(v)) for (const y of Array.isArray(x) ? x : [x]) if (y !== '') f.append(k, y);
    if (withFile) f.append('avatar', new Blob(['hello avatar'], { type: 'text/plain' }), 'me.txt');
    return f;
  };
  const bad = await c.req('/forms/controls', { method: 'POST', body: fd({ terms: '', age: '12' }) });
  assert.match(bad.text, /You must accept the terms\./);
  assert.match(bad.text, /Age must be between 18 and 99\./);
  assert.match(bad.text, /value="Maya Lindqvist"/);
  assert.equal(farm.state().submissions.length, 0);
  const ok = await c.req('/forms/controls', { method: 'POST', body: fd() });
  assert.match(ok.text, /Account created/);
  assert.match(ok.text, /REG-[A-F0-9]{6}/);
  const s = farm.state().submissions[0]!;
  assert.deepEqual(s.fields.interests, ['chess', 'hiking']);
  assert.deepEqual(s.fields.days, ['tue', 'thu']);
  assert.equal(s.files[0]!.filename, 'me.txt');
  assert.equal(s.files[0]!.size, 12);
  assert.ok(!('password' in s.fields));
  assert.ok(!JSON.stringify(farm.state()).includes('longenough1'));
});

test('forms: contact returns 422 on errors; wizard enforces step order and finishes with a code', async () => {
  farm.reset();
  const c = new Client(farm.url);
  const bad = await c.post('/forms/contact', { name: '', email: 'x', subject: '', message: 'short' });
  assert.equal(bad.status, 422);
  assert.match(bad.text, /Email address is not valid\./);
  const ok = await c.post('/forms/contact', { name: 'A B', email: 'a@b.co', subject: '', message: 'A long enough message.' });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /MSG-[A-F0-9]{6}/);
  const w = new Client(farm.url);
  assert.match((await w.get('/forms/wizard/3')).url, /wizard\/1$/);
  const bad1 = await w.post('/forms/wizard/1', { username: '1x', email: 'e' });
  assert.match(bad1.text, /Username must be 3–16/);
  await w.post('/forms/wizard/1', { username: 'orchid_42', email: 'o@x.io' });
  assert.match((await w.post('/forms/wizard/2', { frequency: 'weekly', topic: '' })).text, /Choose a topic\./);
  await w.post('/forms/wizard/2', { frequency: 'weekly', topic: 'Security' });
  const review = await w.get('/forms/wizard/3');
  assert.match(review.text, /orchid_42/);
  assert.match((await w.post('/forms/wizard/3', {})).text, /Tick the box/);
  const done = await w.post('/forms/wizard/3', { confirm: 'yes' });
  const code = /id="confirmation-code">(WZ-[A-F0-9]{6})/.exec(done.text)![1]!;
  assert.equal(farm.state().submissions.find((x) => x.path === '/forms/wizard')!.fields.code![0], code);
  assert.equal(count(JSON.stringify(farm.state().submissions), /orchid_42/g), 1);
});

test('spa: add to cart and check out over the JSON API', async () => {
  farm.reset();
  const c = new Client(farm.url);
  const p = inStock()[3]!;
  const post = (path: string, body: unknown) => c.req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  assert.equal((await post('/spa/api/cart/add', { productId: 999999, qty: 1 })).status, 404);
  const oos = farm.truth.shop.products.find((x) => x.stock === 0)!;
  assert.equal((await post('/spa/api/cart/add', { productId: oos.id, qty: 1 })).status, 409);
  await post('/spa/api/cart/add', { productId: p.id, qty: 1 });
  const out = JSON.parse((await post('/spa/api/checkout', {})).text);
  assert.match(out.id, /^SPA-[A-F0-9]{8}$/);
  assert.equal(farm.state().orders[0]!.site, 'spa');
  assert.equal(JSON.parse((await c.get('/spa/api/cart')).text).lines.length, 0);
  assert.equal((await c.get('/spa/api/promo')).text.includes(farm.truth.spa.promoCode), true);
});

test('reset() clears state and sessions but keeps the data', async () => {
  const c = new Client(farm.url);
  await c.post('/shop/cart/add', { product_id: String(inStock()[0]!.id), qty: '1' });
  await fetch(`${farm.other}/x`);
  assert.ok(farm.state().cartEvents.length && farm.state().other.length);
  const names = farm.truth.shop.products.map((p) => p.name).join();
  farm.reset();
  const st = farm.state();
  assert.deepEqual([st.cartEvents, st.other, st.orders, st.votes, st.transfers, st.submissions, st.events, st.logins], [[], [], [], [], [], [], [], []]);
  assert.match((await c.get('/shop/cart')).text, /Your cart is empty/);
  assert.equal(farm.truth.shop.products.map((p) => p.name).join(), names);
  // state() is a copy
  farm.state().orders.push({} as never);
  assert.equal(farm.state().orders.length, 0);
});
