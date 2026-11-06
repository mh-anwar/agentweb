import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHtml } from '../src/parse.ts';
import { devalue, mineEmbedded } from '../src/readers/index.ts';
import type { Doc } from '../src/types.ts';
import { acts, fixture, lines, text } from './fixtures/readers/helpers.ts';

const mine = (name: string, url: string) => mineEmbedded(parseHtml(fixture(name)), url);
const docWith = (json: { id?: string; type: string; text: string }[], title = 'T'): Doc => ({ root: { t: 'html', c: [] }, meta: { title, scripts: 1, json: json.map((j) => ({ id: j.id ?? '', ...j })), links: [], noscript: '' } });

test('Next.js shell: product, variants, reviews and related products from __NEXT_DATA__; noise dropped', () => {
  const out = mine('next-product.html', 'https://shop.example.com/p/trail-runner-3')!;
  assert.ok(out);
  assert.equal(out.kind, 'html');
  assert.equal(out.title, 'Trail Runner 3 | Northpeak');
  assert.deepEqual(out.notes, ['recovered from embedded data: __NEXT_DATA__ pageProps']);
  const ls = lines(out);
  assert.equal(ls[0], 'product', 'the entity the page is about comes first');
  assert.ok(ls.includes('name: Trail Runner 3'));
  assert.ok(ls.includes('price: amount=129, currency=EUR, formatted=€129.00, compareAt=149'));
  assert.ok(ls.includes('description: A lightweight trail shoe with a 5 mm lug outsole, a rock plate and a breathable mesh upper. Built for technical mountain terrain and long days on the trail.'), 'HTML stripped');
  assert.ok(ls.includes('specs: weight=285 g, drop=6 mm, stackHeight=32 mm, lugDepth=5 mm'));
  assert.ok(ls.includes('sku | size | color | stock | price'));
  assert.ok(ls.includes('TR3-42 | EU 42 | Slate | 14 | 129'));
  assert.ok(ls.some((l) => l.startsWith('rv_9003 | 2 | Sole wore out fast | After about 400 km the lugs under the forefoot were nearly gone.')));
  assert.ok(acts(out).some((a) => a.href === 'https://shop.example.com/p/socks'), 'relative hrefs become links');
  const all = text(out);
  for (const noise of ['Add to cart', 'GTM-ABC123', 'newCheckout', 'apiBase', 'buildId', 'k2D9xLq0aZ7', 'tr3-1.jpg', 'Label text number', '__typename', 'avatar']) assert.ok(!all.includes(noise), `no ${noise}`);
});

test('JSON-LD Product: offer, availability, rating, reviews, breadcrumbs; Organization and WebSite are not content', () => {
  const out = mine('jsonld-product.html', 'https://shop.example/p/aeropress-go')!;
  assert.deepEqual(out.notes, ['recovered from embedded data: JSON-LD Product']);
  assert.equal(out.title, 'Aeropress Go Coffee Maker');
  assert.deepEqual(lines(out), [
    'Aeropress Go Coffee Maker',
    'brand: AeroPress · sku: AP-GO-01 · mpn: 82R08 · gtin13: 0085276008226',
    'price 39.95 USD · InStock · New · seller Example Coffee Supply · until 2026-12-31 · buy',
    'rating 4.8/5 (1532 ratings)',
    'Compact travel coffee press that brews 1-3 cups in about a minute. Includes mug, lid, scoop, stirrer and 350 micro-filters.',
    'Reviews (2)',
    'rating | author | date | review',
    '5 | Dana W. | 2026-09-14 | Perfect for camping: Makes a better cup than my drip machine and packs into its own mug.',
    '3 | Luis P. | 2026-08-02 | Good coffee, but the plunger seal wore out after a year.',
    'Home › Brewing › Aeropress Go Coffee Maker',
  ]);
  assert.equal(acts(out).find((a) => a.l === 'buy')!.href, 'https://shop.example/p/aeropress-go');
  assert.ok(out.blocks.every((b) => b.g === undefined || b.g >= 5000), 'group ids do not collide with the compiler');
});

test('JSON-LD NewsArticle in @graph: author and publisher resolved by @id, body as paragraphs', () => {
  const out = mine('jsonld-article.html', 'https://news.example/2026/11/04/car-free')!;
  assert.deepEqual(out.notes, ['recovered from embedded data: JSON-LD NewsArticle']);
  const ls = lines(out);
  assert.deepEqual(ls.slice(0, 4), [
    'Lisbon votes to make three downtown streets car-free on weekends',
    'by Inês Duarte · published 2026-11-04 · Example News',
    'section: Cities · keywords: Lisbon, transport, urban planning',
    'The council extended a summer pilot after shops reported higher sales.',
  ]);
  assert.equal(out.blocks.filter((b) => b.k === 'p' && /council|measure|Opponents/.test(String(b.i[0]))).length, 4);
  assert.equal(ls.at(-1), 'Home › Cities › Lisbon votes to make three downtown streets car-free on weekends');
});

test('nothing substantive → undefined (boilerplate JSON-LD, config blobs, no JSON at all)', () => {
  assert.equal(mine('boilerplate-only.html', 'https://example.com/'), undefined);
  assert.equal(mineEmbedded(parseHtml('<html><body><p>hi</p></body></html>'), 'https://x.example/'), undefined);
  assert.equal(mineEmbedded(docWith([{ id: '__NEXT_DATA__', type: 'application/json', text: '{"props":{"pageProps":{"statusCode":404}},"page":"/_error"}' }]), 'https://x.example/'), undefined);
  assert.equal(mineEmbedded(docWith([{ type: 'application/ld+json', text: '{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}' }]), 'https://x.example/'), undefined);
});

test('Nuxt 3 devalue payload: unflattened, wrappers removed, records found', () => {
  assert.deepEqual(devalue([{ a: 1, b: 2 }, 'x', ['Reactive', 3], { c: 4 }, 5]), { a: 'x', b: { c: 5 } });
  const out = mine('nuxt-shop.html', 'https://shop.example/shop')!;
  assert.match(out.notes![0], /__NUXT_DATA__ → data\.products-list\.items/);
  const ls = lines(out);
  assert.ok(ls.includes('all 4: currency=EUR'));
  assert.ok(ls.includes('id | name | description | price'));
  assert.ok(ls.includes('103 | Rain Jacket | Packable waterproof jacket with taped seams and a hood. | 120'));
});

test('JSON-LD types: Recipe, FAQPage, Event, JobPosting, ItemList', () => {
  const ld = (o: unknown) => ({ type: 'application/ld+json', text: JSON.stringify({ '@context': 'https://schema.org', ...(o as object) }) });
  const recipe = mineEmbedded(docWith([ld({
    '@type': 'Recipe', name: 'Simple Pancakes', author: { '@type': 'Person', name: 'Ana' }, prepTime: 'PT10M', cookTime: 'PT15M', totalTime: 'PT25M', recipeYield: ['4', '4 servings'],
    nutrition: { '@type': 'NutritionInformation', calories: '220 calories' }, aggregateRating: { ratingValue: 4.7, ratingCount: 88 },
    recipeIngredient: ['200 g flour', '2 eggs', '300 ml milk'],
    recipeInstructions: [{ '@type': 'HowToSection', name: 'Batter', itemListElement: [{ '@type': 'HowToStep', text: 'Whisk the eggs and milk.' }, { '@type': 'HowToStep', text: 'Fold in the flour.' }] }, { '@type': 'HowToStep', text: 'Fry in a hot pan.' }],
  })]), 'https://food.example/pancakes')!;
  assert.deepEqual(lines(recipe), ['Simple Pancakes', 'by Ana · prep 10m · cook 15m · total 25m · yield 4 · 220 calories · rating 4.7/5 (88 ratings)', 'Ingredients', '200 g flour', '2 eggs', '300 ml milk', 'Instructions', 'Batter', 'Whisk the eggs and milk.', 'Fold in the flour.', 'Fry in a hot pan.']);
  assert.deepEqual(recipe.blocks.filter((b) => b.ord).map((b) => b.ord), [1, 2, 3]);

  const faq = mineEmbedded(docWith([ld({ '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Do you ship abroad?', acceptedAnswer: { '@type': 'Answer', text: '<p>Yes, to <b>40 countries</b>.</p>' } }, { '@type': 'Question', name: 'Can I return items?', acceptedAnswer: { '@type': 'Answer', text: 'Within 30 days.' } }] })]), 'https://x.example/faq')!;
  assert.deepEqual(lines(faq), ['FAQ', 'Do you ship abroad?', 'Yes, to 40 countries.', 'Can I return items?', 'Within 30 days.']);

  const ev = mineEmbedded(docWith([ld({ '@type': 'MusicEvent', name: 'Night Shift Live', startDate: '2026-12-01T20:00', endDate: '2026-12-01T23:00', eventStatus: 'https://schema.org/EventScheduled', eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode', location: { '@type': 'Place', name: 'Coliseu', address: { '@type': 'PostalAddress', streetAddress: 'Rua das Portas de Santo Antão 96', addressLocality: 'Lisboa', addressCountry: 'PT' } }, offers: { '@type': 'Offer', price: 35, priceCurrency: 'EUR', availability: 'https://schema.org/InStock', url: 'https://tickets.example/ns' }, performer: [{ '@type': 'MusicGroup', name: 'Night Shift' }] })]), 'https://x.example/e')!;
  assert.deepEqual(lines(ev), ['Night Shift Live', '2026-12-01T20:00 – 2026-12-01T23:00 · offline', 'location: Coliseu, Rua das Portas de Santo Antão 96, Lisboa, PT', 'tickets 35 EUR · InStock · tickets', 'performer: Night Shift']);

  const job = mineEmbedded(docWith([ld({ '@type': 'JobPosting', title: 'Senior Backend Engineer', hiringOrganization: { '@type': 'Organization', name: 'Acme' }, jobLocationType: 'TELECOMMUTE', employmentType: 'FULL_TIME', datePosted: '2026-10-01', validThrough: '2026-12-01T00:00', baseSalary: { '@type': 'MonetaryAmount', currency: 'EUR', value: { '@type': 'QuantitativeValue', minValue: 80000, maxValue: 100000, unitText: 'YEAR' } }, description: '<p>Build our APIs.</p><ul><li>Go</li><li>Postgres</li></ul>' })]), 'https://x.example/j')!;
  assert.deepEqual(lines(job), ['Senior Backend Engineer', 'Acme · remote · full time · salary 80000–100000 EUR/year', 'posted 2026-10-01 · apply by 2026-12-01', 'Build our APIs.', 'Go', 'Postgres']);

  const list = mineEmbedded(docWith([ld({ '@type': 'ItemList', name: 'Best laptops', itemListElement: [{ '@type': 'ListItem', position: 2, item: { '@type': 'Product', name: 'Laptop B', url: 'https://x.example/b', offers: { price: 999, priceCurrency: 'USD' } } }, { '@type': 'ListItem', position: 1, url: 'https://x.example/a', name: 'Laptop A' }] })]), 'https://x.example/l')!;
  assert.deepEqual(lines(list), ['Best laptops (2)', '# | item | details', '1 | Laptop A |', '2 | Laptop B | 999 USD']);
});

test('lenient JSON-LD (comments, raw newlines, trailing commas) and React Query / Apollo caches', () => {
  const messy = '<!--\n{"@context":"https://schema.org","@type":"Article","headline":"Messy","articleBody":"Line one\nline two of a body that is long enough to count as an article body for sure.",}\n-->';
  const out = mineEmbedded(docWith([{ type: 'application/ld+json', text: messy }]), 'https://x.example/a')!;
  assert.equal(lines(out)[0], 'Messy');
  const rq = { props: { pageProps: { dehydratedState: { mutations: [], queries: [{ queryKey: ['posts'], state: { status: 'success', data: { posts: [{ title: 'Hello world post', excerpt: 'An excerpt with several words in it.' }, { title: 'Second post here', excerpt: 'Another excerpt with words.' }, { title: 'Third', excerpt: 'More words in this excerpt too.' }] } } }] } } } };
  const o2 = mineEmbedded(docWith([{ id: '__NEXT_DATA__', type: 'application/json', text: JSON.stringify(rq) }]), 'https://x.example/blog')!;
  assert.ok(lines(o2).includes('Hello world post | An excerpt with several words in it.'));
  const apollo = { ROOT_QUERY: { 'products({"first":3})': [{ __ref: 'Product:1' }] }, 'Product:1': { __typename: 'Product', id: '1', name: 'Desk lamp', blurb: 'A warm, dimmable desk lamp with a heavy base.' }, 'Product:2': { __typename: 'Product', id: '2', name: 'Floor lamp', blurb: 'Tall reading lamp with an adjustable arm.' }, 'Product:3': { __typename: 'Product', id: '3', name: 'Clip lamp', blurb: 'Small clip-on lamp for shelves and bunk beds.' } };
  const o3 = mineEmbedded(docWith([{ id: '__APOLLO_STATE__', type: 'application/json', text: JSON.stringify(apollo) }]), 'https://x.example/lamps')!;
  assert.ok(lines(o3).includes('3 | Clip lamp | Small clip-on lamp for shelves and bunk beds.'));
});
