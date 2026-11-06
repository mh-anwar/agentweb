import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHtml } from '../src/parse.ts';
import { compile } from '../src/compile.ts';
import type { Act } from '../src/types.ts';

const listing = (ids: number[], csrf: string) =>
  `<main>${ids.map((id) => `<div class="card"><h3>Item ${id}</h3><form method="post" action="/cart/add"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="id" value="${id}"><button>Add to cart</button></form></div>`).join('')}</main>`;

const buttons = (html: string) =>
  compile(parseHtml(html), 'https://shop.example/list', { tier: 'wire' })
    .blocks.flatMap((b) => b.i)
    .filter((x): x is Act => typeof x !== 'string' && x.l === 'Add to cart');

test("a form's identity is what it submits, not its position, so numbers never point at another product", () => {
  const a = buttons(listing([1, 2, 3], 'tok-a'));
  const b = buttons(listing([7, 2, 9], 'tok-b'));
  assert.notEqual(a[0].f, b[0].f, 'item 1 and item 7 are different buttons');
  assert.equal(a[1].f, b[1].f, 'item 2 is the same button on both pages, despite a different CSRF token');
  assert.equal(new Set(a.map((x) => x.f)).size, 3);
});

test('icon-only buttons are named from their classes, not left as "unlabeled button"', () => {
  const html = '<main><li><span>Maple Stool</span><button class="icon-btn fav"><svg></svg></button><button class="icon-btn del"><svg></svg></button><button class="btn"><i class="fa fa-trash"></i></button><button class="css-1x2y3z4"></button></li></main>';
  const labels = compile(parseHtml(html), 'https://x.example/', { tier: 'chrome' }).blocks.flatMap((b) => b.i).filter((x): x is Act => typeof x !== 'string').map((x) => x.l);
  assert.deepEqual(labels, ['fav (icon)', 'del (icon)', 'trash (icon)', 'unlabeled button']);
});

import { resolveTarget } from '../src/session.ts';
test("near= picks the control after the named item when several cards share one line", () => {
  const html = '<main><p>Fjord Kettle $40 <button onclick="a()">Add to basket</button> Larch Toaster $55 <button onclick="b()">Add to basket</button> Opal Blender $70 <button onclick="c()">Add to basket</button></p></main>';
  const page = compile(parseHtml(html), 'https://x.example/', { tier: 'chrome' });
  const refs = { of: () => 1, numberOf: () => undefined } as any;
  const r = resolveTarget(page, refs as any, 'Add to basket', { verb: 'click', near: 'Larch Toaster' } as any) as any;
  const acts = page.blocks.flatMap((b) => b.i).filter((x): x is Act => typeof x !== 'string');
  assert.equal(r.act, acts[1]);
});

test('near= does not cross into the previous item: the button under the named heading wins', () => {
  const html = '<main><h3>Fjord Kettle</h3><p>Free delivery</p><button onclick="a()">Add to basket</button><h3>Larch Toaster</h3><p>Free delivery</p><button onclick="b()">Add to basket</button></main>';
  const page = compile(parseHtml(html), 'https://x.example/', { tier: 'chrome' });
  const refs = { of: () => 1, get: () => undefined } as any;
  const r = resolveTarget(page, refs, 'Add to basket', { verb: 'click', near: 'Larch Toaster' } as any) as any;
  const acts = page.blocks.flatMap((b) => b.i).filter((x): x is Act => typeof x !== 'string');
  assert.equal(r.act, acts[1]);
});
