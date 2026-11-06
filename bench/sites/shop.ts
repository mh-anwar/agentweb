// /shop/ — a server-rendered store: listings with query-string sort/filter, product pages, a cookie
// session cart (POST then redirect), and a three-step checkout with CSRF tokens and re-rendered
// validation errors.
import type { Ctx, Order } from './core.ts';
import { intParam } from './core.ts';
import { esc, shell, stars, pager, infoPage } from './html.ts';
import type { Chrome } from './html.ts';
import { money, hashHex } from './rng.ts';
import type { Product, Truth } from './truth.ts';
import { quote, SHIPPING } from './truth.ts';

const PAGE_SIZE = 20;

export interface ListQuery { category?: string; q?: string; sort?: string; minRating?: number; maxPriceCents?: number; brands?: string[]; inStock?: boolean }

export function listProducts(t: Truth, f: ListQuery): Product[] {
  let xs = t.shop.products.slice();
  if (f.category) xs = xs.filter((p) => p.category === f.category);
  if (f.q) {
    const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (p: Product) => `${p.name} ${p.brand} ${p.category.replace(/-/g, ' ')} ${p.specs.map((s) => s[1]).join(' ')}`.toLowerCase();
    xs = xs.filter((p) => { const h = hay(p); return terms.every((w) => h.includes(w)); });
  }
  if (f.minRating) xs = xs.filter((p) => p.rating >= f.minRating!);
  if (f.maxPriceCents) xs = xs.filter((p) => p.priceCents <= f.maxPriceCents!);
  if (f.brands?.length) xs = xs.filter((p) => f.brands!.includes(p.brand));
  if (f.inStock) xs = xs.filter((p) => p.stock > 0);
  switch (f.sort) {
    case 'price_asc': xs.sort((a, b) => a.priceCents - b.priceCents); break;
    case 'price_desc': xs.sort((a, b) => b.priceCents - a.priceCents); break;
    case 'rating': xs.sort((a, b) => b.rating - a.rating || b.reviews.length - a.reviews.length || a.id - b.id); break;
    case 'name': xs.sort((a, b) => a.name.localeCompare(b.name)); break;
    default: break; // featured = catalogue order
  }
  return xs;
}

export function queryFromParams(q: URLSearchParams, category?: string): ListQuery {
  const minRating = Number.parseFloat(q.get('min_rating') ?? '');
  const maxPrice = Number.parseFloat(q.get('max_price') ?? '');
  return {
    category: category ?? (q.get('category') || undefined), q: q.get('q')?.trim() || undefined, sort: q.get('sort') || undefined,
    minRating: Number.isFinite(minRating) ? minRating : undefined, maxPriceCents: Number.isFinite(maxPrice) ? Math.round(maxPrice * 100) : undefined,
    brands: q.getAll('brand'), inStock: q.get('in_stock') === '1',
  };
}

const chrome = (c: Ctx): Chrome => {
  const cart = c.session('shop', false)?.cart as Record<string, number> | undefined;
  const n = cart ? Object.values(cart).reduce((a, b) => a + b, 0) : 0;
  return {
    base: '/shop', brand: 'Tradewind Store', tagline: 'Everyday tech, honestly reviewed',
    nav: [['Home', '/shop/'], ['All products', '/shop/products'], ...c.truth.shop.categories.slice(0, 4).map((x) => [x.name, `/shop/category/${x.slug}`] as [string, string]), ['Deals', '/shop/info/deals']],
    headerExtra: `<form action="/shop/search" method="get" role="search" style="margin-left:auto"><label for="site-search" style="display:inline;margin:0 6px 0 0">Search</label><input id="site-search" type="search" name="q" placeholder="Search products" value=""> <button type="submit">Go</button></form>
<a href="/shop/cart" class="cart-link" aria-label="Shopping cart">Cart (<span id="cart-count">${n}</span>)</a>`,
  };
};

function productUrl(p: Product) { return `/shop/product/${p.id}-${p.slug}`; }

function card(p: Product): string {
  return `<article class="product-card" data-product-id="${p.id}" style="background:#fff;border:1px solid #dde1e8;padding:12px;border-radius:6px">
<a href="${productUrl(p)}"><img src="/shop/img/${p.id}.svg" alt="${esc(p.name)}" width="160" height="120" loading="lazy"><h3 style="font-size:15px;margin:6px 0">${esc(p.name)}</h3></a>
<div class="price" style="font-weight:700">${money(p.priceCents)}</div>
<div class="rating" aria-label="Rated ${p.rating} out of 5"><span aria-hidden="true">${stars(p.rating)}</span> <span class="rating-value">${p.rating}</span> <span class="count">(${p.reviews.length} reviews)</span></div>
<div class="stock">${p.stock > 0 ? 'In stock' : '<span class="oos">Out of stock</span>'}</div>
<form method="post" action="/shop/cart/add"><input type="hidden" name="product_id" value="${p.id}"><input type="hidden" name="qty" value="1"><button type="submit" class="primary" ${p.stock > 0 ? '' : 'disabled'}>Add to cart</button></form>
</article>`;
}

function sidebar(c: Ctx, path: string, q: URLSearchParams, category?: string): string {
  const t = c.truth;
  const brands = [...new Set(t.shop.products.filter((p) => !category || p.category === category).map((p) => p.brand))].sort();
  const sel = new Set(q.getAll('brand'));
  const sort = q.get('sort') ?? '';
  const opt = (v: string, l: string) => `<option value="${v}" ${sort === v ? 'selected' : ''}>${l}</option>`;
  return `<aside class="filters" style="width:240px;flex:none">
<h2 style="font-size:16px">Categories</h2><ul>${t.shop.categories.map((x) => `<li><a href="/shop/category/${x.slug}">${esc(x.name)}</a> (${t.shop.products.filter((p) => p.category === x.slug).length})</li>`).join('')}</ul>
<form method="get" action="${path}" id="filter-form"><h2 style="font-size:16px">Filter &amp; sort</h2>
${q.get('q') ? `<input type="hidden" name="q" value="${esc(q.get('q'))}">` : ''}
<label for="sort">Sort by</label><select id="sort" name="sort">${opt('', 'Featured')}${opt('price_asc', 'Price: low to high')}${opt('price_desc', 'Price: high to low')}${opt('rating', 'Customer rating')}${opt('name', 'Name')}</select>
<label for="min_rating">Minimum rating</label><select id="min_rating" name="min_rating">${['', '3', '4', '4.5'].map((v) => `<option value="${v}" ${(q.get('min_rating') ?? '') === v ? 'selected' : ''}>${v ? v + ' stars & up' : 'Any'}</option>`).join('')}</select>
<label for="max_price">Max price ($)</label><input id="max_price" name="max_price" type="number" min="0" step="1" value="${esc(q.get('max_price') ?? '')}">
<fieldset style="margin-top:10px"><legend>Brand</legend>${brands.map((b) => `<label style="margin:2px 0"><input type="checkbox" name="brand" value="${esc(b)}" ${sel.has(b) ? 'checked' : ''}> ${esc(b)}</label>`).join('')}</fieldset>
<label><input type="checkbox" name="in_stock" value="1" ${q.get('in_stock') === '1' ? 'checked' : ''}> In stock only</label>
<button type="submit" class="primary" style="margin-top:10px">Apply filters</button></form></aside>`;
}

function listingPage(c: Ctx, heading: string, path: string, category?: string): void {
  const q = c.q;
  const items = listProducts(c.truth, queryFromParams(q, category));
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = intParam(q.get('page'), 1, 1, pages);
  const slice = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const params = new URLSearchParams(q);
  params.delete('page');
  const cat = category ? c.truth.shop.categories.find((x) => x.slug === category) : undefined;
  c.html(shell(chrome(c), {
    title: `${heading} — Tradewind Store${page > 1 ? ` (page ${page})` : ''}`,
    main: `<nav aria-label="Breadcrumb"><a href="/shop/">Home</a> › ${cat ? `<a href="/shop/products">Products</a> › ${esc(cat.name)}` : esc(heading)}</nav>
<h1>${esc(heading)}</h1>${cat ? `<p>${esc(cat.blurb)}</p>` : ''}
<div style="display:flex;gap:24px">${sidebar(c, path, q, category)}<section style="flex:1">
<p class="result-count" role="status">${items.length} products · page ${page} of ${pages}</p>
<div class="grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px">${slice.map(card).join('') || '<p>No products match your filters.</p>'}</div>
${pager(path, params, page, pages)}</section></div>`,
  }));
}

function productPage(c: Ctx, p: Product): void {
  const related = c.truth.shop.products.filter((x) => x.category === p.category && x.id !== p.id).slice(0, 4);
  const cat = c.truth.shop.categories.find((x) => x.slug === p.category)!;
  const err = c.q.get('error');
  c.html(shell(chrome(c), {
    title: `${p.name} — Tradewind Store`,
    head: `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name: p.name, sku: `TW-${p.id}`, brand: { '@type': 'Brand', name: p.brand }, offers: { '@type': 'Offer', price: (p.priceCents / 100).toFixed(2), priceCurrency: 'USD' }, aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating, reviewCount: p.reviews.length } })}</script>`,
    main: `<nav aria-label="Breadcrumb"><a href="/shop/">Home</a> › <a href="/shop/category/${cat.slug}">${esc(cat.name)}</a> › ${esc(p.name)}</nav>
${err === 'out_of_stock' ? '<p class="notice" role="alert">Sorry, that item is out of stock.</p>' : ''}
<div style="display:flex;gap:28px"><img src="/shop/img/${p.id}.svg" alt="${esc(p.name)}" width="360" height="270">
<div><h1>${esc(p.name)}</h1><p>by <a href="/shop/search?q=${encodeURIComponent(p.brand)}">${esc(p.brand)}</a> · SKU TW-${p.id}</p>
<p class="price" style="font-size:28px;font-weight:700" itemprop="price">${money(p.priceCents)}</p>
<p class="rating" aria-label="Rated ${p.rating} out of 5">${stars(p.rating)} <strong>${p.rating}</strong> out of 5 (${p.reviews.length} reviews)</p>
<p class="stock">${p.stock > 0 ? `<strong>In stock</strong> — ${p.stock} available` : '<strong class="oos">Out of stock</strong>'}</p>
<form method="post" action="/shop/cart/add"><input type="hidden" name="product_id" value="${p.id}">
<label for="qty">Quantity</label><select id="qty" name="qty">${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option>${n}</option>`).join('')}</select>
<p><button type="submit" class="primary" ${p.stock > 0 ? '' : 'disabled'}>Add to cart</button></p></form></div></div>
<section id="description"><h2>Description</h2>${p.description.map((d) => `<p>${esc(d)}</p>`).join('')}</section>
<section id="specs"><h2>Specifications</h2><table class="specs"><tbody>${p.specs.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table></section>
<section id="reviews"><h2>Customer reviews (${p.reviews.length})</h2>${p.reviews.map((r) => `<article class="review" style="border-top:1px solid #dde1e8;padding:8px 0"><h3 style="font-size:15px;margin:0">${esc(r.title)}</h3><div aria-label="${r.rating} out of 5 stars">${stars(r.rating)} <span>${r.rating}/5</span> · ${esc(r.author)} · <time>${r.date}</time></div><p>${esc(r.body)}</p></article>`).join('')}</section>
<section><h2>Customers also viewed</h2><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">${related.map(card).join('')}</div></section>`,
  }));
}

// ---------------------------------------------------------------------------------------------
// Cart and checkout

type Cart = Record<string, number>;
const cartOf = (c: Ctx): Cart => ((c.session('shop')!.cart ??= {}) as Cart);

function cartLines(c: Ctx) {
  const cart = cartOf(c);
  return Object.entries(cart).map(([id, qty]) => ({ p: c.truth.shop.products[Number(id) - 1]!, qty })).filter((l) => l.qty > 0);
}

function csrfOf(c: Ctx): string {
  const s = c.session('shop')!;
  return (s.csrf ??= hashHex(c.truth.seed, 'csrf', s.id).slice(0, 32));
}

function csrfOk(c: Ctx, f: { get(n: string): string }): boolean {
  return f.get('csrf_token') !== '' && f.get('csrf_token') === csrfOf(c);
}

function cartPage(c: Ctx): void {
  const lines = cartLines(c);
  const qt = quote(lines.map((l) => ({ priceCents: l.p.priceCents, qty: l.qty })));
  const body = lines.length === 0 ? '<p>Your cart is empty. <a href="/shop/products">Continue shopping</a>.</p>' : `
<table class="cart" style="width:100%;background:#fff"><thead><tr><th>Product</th><th>Price</th><th>Qty</th><th>Line total</th><th></th></tr></thead><tbody>
${lines.map((l) => `<tr data-product-id="${l.p.id}"><td><a href="${productUrl(l.p)}">${esc(l.p.name)}</a></td><td>${money(l.p.priceCents)}</td><td>${l.qty}</td><td>${money(l.p.priceCents * l.qty)}</td>
<td><form method="post" action="/shop/cart/remove"><input type="hidden" name="product_id" value="${l.p.id}"><button type="submit" aria-label="Remove ${esc(l.p.name)} from cart">Remove</button></form></td></tr>`).join('')}
</tbody></table>
<p class="subtotal" style="font-size:18px">Subtotal: <strong id="subtotal">${money(qt.subtotal)}</strong></p>
<p><a class="btn" href="/shop/checkout/shipping" style="text-decoration:none">Proceed to checkout</a></p>`;
  c.html(shell(chrome(c), { title: 'Your cart — Tradewind Store', main: `<h1>Shopping cart</h1>${body}` }));
}

interface Shipping { name: string; email: string; address: string; city: string; state: string; zip: string }
const STATES = ['CA', 'NY', 'TX', 'WA', 'FL', 'IL', 'MA', 'OR'];

function field(label: string, name: string, v: string, err: string | undefined, attrs = ''): string {
  return `<div class="field"><label for="${name}">${label}</label><input id="${name}" name="${name}" value="${esc(v)}" ${attrs} ${err ? `aria-invalid="true" aria-describedby="err-${name}"` : ''}>${err ? `<span class="error" id="err-${name}">${esc(err)}</span>` : ''}</div>`;
}

function stepNav(step: number): string {
  const names = ['Shipping', 'Payment', 'Review'];
  return `<ol class="steps" style="display:flex;gap:20px;list-style:none;padding:0">${names.map((n, i) => `<li ${i + 1 === step ? 'aria-current="step"><strong>' : '>'}${i + 1}. ${n}${i + 1 === step ? '</strong>' : ''}</li>`).join('')}</ol>`;
}

function errorSummary(errs: Record<string, string>): string {
  const keys = Object.keys(errs);
  return keys.length ? `<div class="errors notice" role="alert"><strong>Please fix ${keys.length} problem${keys.length > 1 ? 's' : ''}:</strong><ul>${keys.map((k) => `<li>${esc(errs[k]!)}</li>`).join('')}</ul></div>` : '';
}

function shippingForm(c: Ctx, v: Partial<Shipping>, errs: Record<string, string>, status = 200): void {
  c.html(shell(chrome(c), {
    title: 'Checkout: shipping — Tradewind Store',
    main: `<h1>Checkout</h1>${stepNav(1)}${errorSummary(errs)}
<form method="post" action="/shop/checkout/shipping" novalidate><input type="hidden" name="csrf_token" value="${csrfOf(c)}">
${field('Full name', 'name', v.name ?? '', errs.name, 'autocomplete="name"')}${field('Email', 'email', v.email ?? '', errs.email, 'type="email" autocomplete="email"')}
${field('Street address', 'address', v.address ?? '', errs.address, 'autocomplete="street-address"')}${field('City', 'city', v.city ?? '', errs.city)}
<div class="field"><label for="state">State</label><select id="state" name="state"><option value="">Choose…</option>${STATES.map((s) => `<option ${v.state === s ? 'selected' : ''}>${s}</option>`).join('')}</select>${errs.state ? `<span class="error" id="err-state">${esc(errs.state)}</span>` : ''}</div>
${field('ZIP code', 'zip', v.zip ?? '', errs.zip, 'inputmode="numeric"')}
<p><button type="submit" class="primary">Continue to payment</button></p></form>`,
  }), status);
}

function validShipping(f: { get(n: string): string }): { v: Shipping; errs: Record<string, string> } {
  const v: Shipping = { name: f.get('name').trim(), email: f.get('email').trim(), address: f.get('address').trim(), city: f.get('city').trim(), state: f.get('state'), zip: f.get('zip').trim() };
  const errs: Record<string, string> = {};
  if (v.name.length < 2) errs.name = 'Enter your full name.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) errs.email = 'Enter a valid email address.';
  if (!v.address) errs.address = 'Enter your street address.';
  if (!v.city) errs.city = 'Enter your city.';
  if (!STATES.includes(v.state)) errs.state = 'Choose a state.';
  if (!/^\d{5}$/.test(v.zip)) errs.zip = 'ZIP code must be 5 digits.';
  return { v, errs };
}

function luhn(d: string): boolean {
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

function paymentForm(c: Ctx, v: Record<string, string>, errs: Record<string, string>, status = 200): void {
  const method = v.method || 'standard';
  const lines = cartLines(c);
  const sub = quote(lines.map((l) => ({ priceCents: l.p.priceCents, qty: l.qty }))).subtotal;
  c.html(shell(chrome(c), {
    title: 'Checkout: payment — Tradewind Store',
    main: `<h1>Checkout</h1>${stepNav(2)}${errorSummary(errs)}
<form method="post" action="/shop/checkout/payment" novalidate><input type="hidden" name="csrf_token" value="${csrfOf(c)}">
<fieldset><legend>Shipping method</legend>
${(Object.keys(SHIPPING) as (keyof typeof SHIPPING)[]).map((k) => `<label><input type="radio" name="method" value="${k}" ${method === k ? 'checked' : ''}> ${SHIPPING[k].label} — ${k === 'standard' && sub >= 7500 ? 'FREE' : money(SHIPPING[k].cents)}</label>`).join('')}</fieldset>
${field('Name on card', 'card_name', v.card_name ?? '', errs.card_name)}${field('Card number', 'card_number', v.card_number ?? '', errs.card_number, 'inputmode="numeric" autocomplete="cc-number"')}
${field('Expiry (MM/YY)', 'card_expiry', v.card_expiry ?? '', errs.card_expiry, 'placeholder="MM/YY"')}${field('CVC', 'card_cvc', v.card_cvc ?? '', errs.card_cvc, 'inputmode="numeric"')}
<p><button type="submit" class="primary">Review order</button> <a href="/shop/checkout/shipping">Back</a></p></form>`,
  }), status);
}

function reviewPage(c: Ctx): void {
  const s = c.session('shop')!;
  const lines = cartLines(c);
  const method = (s.payment?.method ?? 'standard') as keyof typeof SHIPPING;
  const qt = quote(lines.map((l) => ({ priceCents: l.p.priceCents, qty: l.qty })), method);
  const ship = s.shipping as Shipping;
  c.html(shell(chrome(c), {
    title: 'Checkout: review — Tradewind Store',
    main: `<h1>Checkout</h1>${stepNav(3)}<h2>Review your order</h2>
<table><tbody>${lines.map((l) => `<tr><td>${esc(l.p.name)} × ${l.qty}</td><td>${money(l.p.priceCents * l.qty)}</td></tr>`).join('')}
<tr><td>Subtotal</td><td>${money(qt.subtotal)}</td></tr><tr><td>Shipping (${SHIPPING[method].label})</td><td>${qt.shipping ? money(qt.shipping) : 'FREE'}</td></tr>
<tr><td>Tax</td><td>${money(qt.tax)}</td></tr><tr><th>Order total</th><th id="order-total">${money(qt.total)}</th></tr></tbody></table>
<p>Ship to: ${esc(ship.name)}, ${esc(ship.address)}, ${esc(ship.city)}, ${esc(ship.state)} ${esc(ship.zip)}<br>Card ending in ${esc(s.payment.last4)}</p>
<form method="post" action="/shop/checkout/place"><input type="hidden" name="csrf_token" value="${csrfOf(c)}"><button type="submit" class="primary">Place order</button> <a href="/shop/checkout/payment">Back</a></form>`,
  }));
}

async function checkout(c: Ctx, step: string): Promise<void> {
  const s = c.session('shop')!;
  if (!cartLines(c).length && step !== 'place') return c.redirect('/shop/cart');
  if (step === 'shipping') {
    if (c.method !== 'POST') return shippingForm(c, (s.shipping ?? {}) as Partial<Shipping>, {});
    const f = await c.form();
    if (!csrfOk(c, f)) return c.html(shell(chrome(c), { title: 'Forbidden', main: '<h1>403 — Forbidden</h1><p>Invalid or missing CSRF token. Reload the form and try again.</p>' }), 403);
    const { v, errs } = validShipping(f);
    if (Object.keys(errs).length) return shippingForm(c, v, errs);
    s.shipping = v;
    return c.redirect('/shop/checkout/payment');
  }
  if (!s.shipping) return c.redirect('/shop/checkout/shipping');
  if (step === 'payment') {
    if (c.method !== 'POST') return paymentForm(c, { method: s.payment?.method ?? 'standard' }, {});
    const f = await c.form();
    if (!csrfOk(c, f)) return c.html(shell(chrome(c), { title: 'Forbidden', main: '<h1>403 — Forbidden</h1><p>Invalid or missing CSRF token. Reload the form and try again.</p>' }), 403);
    const v = { method: f.get('method'), card_name: f.get('card_name').trim(), card_number: f.get('card_number'), card_expiry: f.get('card_expiry').trim(), card_cvc: f.get('card_cvc').trim() };
    const errs: Record<string, string> = {};
    if (!(v.method in SHIPPING)) errs.method = 'Choose a shipping method.';
    if (v.card_name.length < 2) errs.card_name = 'Enter the name on the card.';
    const digits = v.card_number.replace(/[\s-]/g, '');
    if (!/^\d{16}$/.test(digits) || !luhn(digits)) errs.card_number = 'Enter a valid 16-digit card number.';
    const m = /^(0[1-9]|1[0-2])\s*\/\s*(\d{2})$/.exec(v.card_expiry);
    if (!m || Number(m[2]) < 27) errs.card_expiry = 'Enter a future expiry date as MM/YY.';
    if (!/^\d{3,4}$/.test(v.card_cvc)) errs.card_cvc = 'CVC must be 3 or 4 digits.';
    if (Object.keys(errs).length) return paymentForm(c, v, errs);
    s.payment = { method: v.method, last4: digits.slice(-4) };
    return c.redirect('/shop/checkout/review');
  }
  if (!s.payment) return c.redirect('/shop/checkout/payment');
  if (step === 'review') return reviewPage(c);
  if (step === 'place' && c.method === 'POST') {
    const f = await c.form();
    if (!csrfOk(c, f)) return c.html(shell(chrome(c), { title: 'Forbidden', main: '<h1>403 — Forbidden</h1><p>Invalid or missing CSRF token.</p>' }), 403);
    const lines = cartLines(c);
    if (!lines.length) return c.redirect('/shop/cart');
    const method = s.payment.method as keyof typeof SHIPPING;
    const qt = quote(lines.map((l) => ({ priceCents: l.p.priceCents, qty: l.qty })), method);
    const id = 'ORD-' + hashHex(c.truth.seed, 'order', ++c.rt.orderCounter).slice(0, 8).toUpperCase();
    const order: Order = {
      id, site: 'shop', lines: lines.map((l) => ({ productId: l.p.id, qty: l.qty, priceCents: l.p.priceCents })),
      subtotalCents: qt.subtotal, shippingCents: qt.shipping, taxCents: qt.tax, totalCents: qt.total, shippingMethod: method, shipTo: s.shipping, cardLast4: s.payment.last4,
    };
    c.rt.state.orders.push(order);
    s.cart = {};
    s.shipping = undefined;
    s.payment = undefined;
    return c.redirect(`/shop/order/${id}`);
  }
  c.notFound();
}

function orderPage(c: Ctx, id: string): void {
  const o = c.rt.state.orders.find((x) => x.id === id && x.site === 'shop');
  if (!o) return c.notFound('No such order.');
  c.html(shell(chrome(c), {
    title: `Order ${o.id} confirmed — Tradewind Store`,
    main: `<h1>Thank you for your order!</h1><p>Your order number is <strong id="order-id">${o.id}</strong>. A confirmation has been sent to ${esc(o.shipTo.email)}.</p>
<table><tbody>${o.lines.map((l) => `<tr><td>${esc(c.truth.shop.products[l.productId - 1]!.name)} × ${l.qty}</td><td>${money(l.priceCents * l.qty)}</td></tr>`).join('')}
<tr><td>Shipping (${o.shippingMethod})</td><td>${o.shippingCents ? money(o.shippingCents) : 'FREE'}</td></tr><tr><td>Tax</td><td>${money(o.taxCents)}</td></tr>
<tr><th>Total charged</th><th id="order-total">${money(o.totalCents)}</th></tr></tbody></table>
<p>Shipping to ${esc(o.shipTo.name)}, ${esc(o.shipTo.address)}, ${esc(o.shipTo.city)}, ${esc(o.shipTo.state)} ${esc(o.shipTo.zip)}.</p><p><a href="/shop/">Continue shopping</a></p>`,
  }));
}

// ---------------------------------------------------------------------------------------------

export async function handle(c: Ctx, rest: string): Promise<void> {
  const t = c.truth;
  if (rest === '/' || rest === '') {
    const top = t.shop.products.slice().sort((a, b) => b.rating - a.rating || a.id - b.id).slice(0, 8);
    return c.html(shell(chrome(c), {
      title: 'Tradewind Store — Everyday tech, honestly reviewed',
      main: `<section style="background:#1a56c4;color:#fff;padding:28px;border-radius:8px"><h1 style="margin:0">Spring tech sale</h1><p>Free standard shipping on orders over $75.</p><a class="btn" style="background:#fff;color:#1a56c4;text-decoration:none" href="/shop/products">Shop all products</a></section>
<h2>Shop by category</h2><ul style="columns:2">${t.shop.categories.map((x) => `<li><a href="/shop/category/${x.slug}">${esc(x.name)}</a></li>`).join('')}</ul>
<h2>Top rated</h2><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">${top.map(card).join('')}</div>`,
    }));
  }
  let m: RegExpExecArray | null;
  if (rest === '/products') return listingPage(c, 'All products', '/shop/products');
  if (rest === '/search') return listingPage(c, c.q.get('q') ? `Search results for “${c.q.get('q')}”` : 'Search', '/shop/search');
  if ((m = /^\/category\/([a-z-]+)$/.exec(rest))) {
    const cat = t.shop.categories.find((x) => x.slug === m![1]);
    return cat ? listingPage(c, cat.name, `/shop/category/${cat.slug}`, cat.slug) : c.notFound('Unknown category.');
  }
  if ((m = /^\/product\/(\d+)(?:-[a-z0-9-]*)?$/.exec(rest))) {
    const p = t.shop.products[Number(m[1]) - 1];
    return p ? productPage(c, p) : c.notFound('Unknown product.');
  }
  if ((m = /^\/img\/(\d+)\.svg$/.exec(rest))) {
    const hue = (Number(m[1]) * 47) % 360;
    return c.send(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=3600' }, `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="160" height="120" fill="hsl(${hue},45%,80%)"/><circle cx="80" cy="60" r="30" fill="hsl(${hue},50%,45%)"/></svg>`);
  }
  if (rest === '/cart' && c.method === 'GET') return cartPage(c);
  if (rest === '/cart/add' && c.method === 'POST') {
    const f = await c.form();
    const id = Number(f.get('product_id'));
    const qty = Math.max(1, Math.min(10, Number(f.get('qty') || 1) || 1));
    const p = t.shop.products[id - 1];
    if (!p) return c.notFound('Unknown product.');
    if (p.stock <= 0) return c.redirect(`${productUrl(p)}?error=out_of_stock`);
    const cart = cartOf(c);
    cart[id] = (cart[id] ?? 0) + qty;
    c.rt.state.cartEvents.push({ site: 'shop', op: 'add', productId: id, qty });
    return c.redirect('/shop/cart');
  }
  if (rest === '/cart/remove' && c.method === 'POST') {
    const f = await c.form();
    const id = Number(f.get('product_id'));
    const cart = cartOf(c);
    if (cart[id]) { c.rt.state.cartEvents.push({ site: 'shop', op: 'remove', productId: id, qty: cart[id]! }); delete cart[id]; }
    return c.redirect('/shop/cart');
  }
  if (rest === '/checkout') return c.redirect('/shop/checkout/shipping');
  if ((m = /^\/checkout\/(shipping|payment|review|place)$/.exec(rest))) return checkout(c, m[1]!);
  if ((m = /^\/order\/(ORD-[A-F0-9]+)$/.exec(rest))) return orderPage(c, m[1]!);
  if ((m = /^\/info\/([a-z-]+)$/.exec(rest))) return c.html(infoPage(c, chrome(c), m[1]!));
  c.notFound();
}
