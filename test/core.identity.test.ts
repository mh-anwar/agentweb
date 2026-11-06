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
