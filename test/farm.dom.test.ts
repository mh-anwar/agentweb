// Drives the client-side pages in jsdom (scripts on, real fetch against the farm) the way the
// ghost tier would: clicks, modals, timers, tabs, shadow DOM.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { startFarm } from '../bench/sites/farm.ts';
import type { Farm } from '../bench/sites/farm.ts';
import { picks } from '../bench/sites/tasks.ts';
import { money } from '../bench/sites/rng.ts';

let farm: Farm;
before(async () => { farm = await startFarm(); });
after(async () => { await farm.close(); });

async function load(path: string): Promise<{ dom: JSDOM; doc: Document; errors: string[]; q: (s: string) => Element | null; qa: (s: string) => Element[]; until: (f: () => boolean, ms?: number) => Promise<void> }> {
  const jar = new Map<string, string>();
  const errors: string[] = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message)));
  const dom = await JSDOM.fromURL(farm.url + path, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      (w as unknown as { fetch: unknown }).fetch = async (u: string, o: RequestInit = {}) => {
        const r = await fetch(new URL(u, farm.url), { ...o, headers: { ...(o.headers as Record<string, string>), Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
        for (const sc of r.headers.getSetCookie()) { const [pair] = sc.split(';'); const i = pair!.indexOf('='); jar.set(pair!.slice(0, i), pair!.slice(i + 1)); }
        return r;
      };
    },
  });
  const doc = dom.window.document;
  const until = async (f: () => boolean, ms = 4000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for the page'); await new Promise((r) => setTimeout(r, 25)); } };
  return { dom, doc, errors, q: (s) => doc.querySelector(s), qa: (s) => [...doc.querySelectorAll(s)], until };
}
const click = (el: Element | null) => { assert.ok(el, 'element to click'); (el as HTMLElement).click(); };

test('react SPA: listing, filter, sort, add to cart via fetch, modal, product page', async () => {
  farm.reset();
  const p = picks(farm.truth);
  const { dom, q, qa, until, errors } = await load(`/spa/c/${p.addCat}`);
  await until(() => qa('.product-card').length > 0);
  assert.equal(q('#root')!.children.length > 0, true);
  // client-side sort: select price ascending and read prices
  const sel = q('.filters select') as HTMLSelectElement;
  sel.value = 'price_asc';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await until(() => /sort=price_asc/.test(dom.window.location.search));
  const prices = qa('.product-card .price').map((e) => Number(e.textContent!.replace(/[$,]/g, '')));
  assert.deepEqual(prices, prices.slice().sort((a, b) => a - b));
  // quick view modal
  click(qa('.product-card button').find((b) => b.textContent === 'Quick view')!);
  await until(() => !!q('[role=dialog]'));
  assert.ok(q('[role=dialog]')!.textContent!.includes('Add to cart'));
  click(q('[aria-label="Close dialog"]'));
  await until(() => !q('[role=dialog]'));
  // add the cheapest in-stock product (first with an enabled button)
  const card = qa('.product-card').find((c) => !(c.querySelector('button.primary') as HTMLButtonElement).disabled)!;
  const id = Number(card.getAttribute('data-product-id'));
  click(card.querySelector('button.primary'));
  await until(() => !!q('[role=dialog]') && q('[role=dialog]')!.textContent!.includes('Added to cart'));
  assert.deepEqual(farm.state().cartEvents, [{ site: 'spa', op: 'add', productId: id, qty: 1 }]);
  assert.equal(q('#cart-count')!.textContent, '1');
  assert.deepEqual(errors, []);
  dom.window.close();
});

test('react SPA: the weekly-deal section appears only after the 2.5 s timer', async () => {
  const { dom, q, until } = await load('/spa/');
  await until(() => !!q('.categories'));
  assert.equal(q('#weekly-deal'), null);
  await until(() => !!q('#weekly-deal'), 5000);
  assert.ok(q('#weekly-deal')!.textContent!.includes(farm.truth.spa.promoCode));
  dom.window.close();
});

test('vue, preact and vanilla SPAs render, route and add to cart', async () => {
  const p = picks(farm.truth);
  for (const kind of ['vue', 'preact', 'vanilla']) {
    farm.reset();
    const { dom, q, qa, until, errors } = await load(`/spa-${kind}/c/${p.addCat}`);
    await until(() => qa('.product-card').length > 0);
    const sel = q('select') as HTMLSelectElement;
    sel.value = 'price_asc';
    sel.dispatchEvent(new dom.window.Event(kind === 'vue' ? 'change' : 'change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    const prices = qa('.product-card .price').map((e) => Number(e.textContent!.replace(/[$,\s]/g, '')));
    assert.deepEqual(prices, prices.slice().sort((a, b) => a - b), kind);
    const btn = qa('.product-card button').find((b) => !(b as HTMLButtonElement).disabled)!;
    const id = Number(btn.closest('.product-card')!.getAttribute('data-product-id'));
    click(btn);
    await until(() => farm.state().cartEvents.length === 1);
    assert.equal(farm.state().cartEvents[0]!.productId, id, kind);
    await until(() => /Added/.test(q('.notice')?.textContent ?? ''));
    // client-side routing to a product page without a page load
    const link = qa('.product-card a')[0] as HTMLAnchorElement;
    const before = dom.window.document;
    click(link);
    await until(() => /\/p\/\d+$/.test(dom.window.location.pathname));
    await until(() => !!q('table.specs'));
    assert.equal(dom.window.document, before, 'same document: pushState routing');
    assert.deepEqual(errors, [], kind);
    dom.window.close();
  }
});

test('hard: shadow DOM + slots, icon buttons, divs with handlers, tabs, accordion, load more', async () => {
  farm.reset();
  const t = farm.truth.hard;
  {
    const { dom, qa, until } = await load('/hard/shadow');
    await until(() => qa('product-card').length === 4);
    const card = qa('product-card')[0] as HTMLElement;
    assert.ok(card.shadowRoot, 'open shadow root');
    assert.equal(card.shadowRoot!.querySelector('.price')!.textContent, money(t.shadow[0]!.priceCents));
    assert.equal(card.querySelector('[slot=title]')!.textContent, t.shadow[0]!.name);
    click(card.shadowRoot!.querySelector('.add'));
    await until(() => farm.state().events.length === 1);
    assert.equal(farm.state().events[0]!.detail, t.shadow[0]!.sku);
    assert.match(dom.window.document.getElementById('status')!.textContent!, /^Added /);
    dom.window.close();
  }
  {
    const { dom, q, qa, until } = await load('/hard/icons');
    const fav3 = qa('.item[data-id="3"] .fav')[0]!;
    assert.equal(fav3.textContent!.trim(), '', 'icon-only: no text');
    assert.equal(fav3.getAttribute('aria-label'), null);
    click(fav3);
    await until(() => farm.state().events.some((e) => e.name === 'wishlist'));
    assert.equal(q('#last-action')!.textContent, 'Wishlisted Maple Stool');
    assert.equal(q('#wishlist-count')!.textContent, '1');
    click(qa('.share')[0]!);
    await until(() => farm.state().events.some((e) => e.name === 'share'));
    dom.window.close();
  }
  {
    const { dom, q, qa, until } = await load('/hard/tabs');
    assert.ok((q('#panel-pricing') as HTMLElement).hidden);
    click(q('#tab-pricing'));
    await until(() => /Team plan/.test(q('#panel-pricing')!.textContent ?? ''));
    assert.ok(!(q('#panel-pricing') as HTMLElement).hidden);
    const head = qa('.acc-head')[0]!;
    assert.ok((q('#acc-0') as HTMLElement).hidden);
    click(head);
    assert.equal(head.getAttribute('aria-expanded'), 'true');
    assert.ok(!(q('#acc-0') as HTMLElement).hidden);
    assert.ok(q('#acc-0')!.textContent!.includes('days'));
    dom.window.close();
  }
  {
    const { dom, q, qa, until } = await load('/hard/more');
    assert.equal(qa('#list li').length, 10);
    for (let i = 0; i < 4; i++) { click(q('#load-more')); await until(() => qa('#list li').length === 20 + i * 10); }
    await until(() => !q('#load-more'));
    assert.equal(qa('#list li').length, 50);
    assert.equal(qa('#list li')[49]!.textContent, t.more[49]);
    dom.window.close();
  }
});

test('hard: the canvas chart is drawn by script and its numbers are in no text node', async () => {
  const { dom, doc, q } = await load('/hard/chart');
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(q('canvas#chart'));
  const clone = doc.body.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script').forEach((x) => x.remove());
  const text = clone.textContent!.replace(/\s+/g, ' ');
  for (const v of farm.truth.hard.chart.values) assert.ok(!new RegExp(`(?<![\\d.])${v}(?!\\d)`).test(text.replace(/© 2026/g, '')), `value ${v} appears in the text`);
  dom.window.close();
});
