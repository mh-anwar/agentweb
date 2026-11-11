// Independently authored trials for collect(): seeded local fixtures, truth generated on the fixture
// server, ephemeral HTTP server closed in finally. Assertions follow the README contract; a failing
// assertion here is a candidate product defect, not a reason to weaken the check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentweb } from '../src/index.ts';
import type { RuntimeImpl } from '../src/runtime.ts';
import { defaultPolicy } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';

// ---------- seeded randomness (mulberry32) ----------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function int(r: () => number, lo: number, hi: number): number { return lo + Math.floor(r() * (hi - lo + 1)); }
function pick<T>(r: () => number, xs: T[]): T { return xs[Math.floor(r() * xs.length)]; }
function shuffle<T>(r: () => number, xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const ADJ = ['Oak', 'Pine', 'Birch', 'Maple', 'Cedar', 'Walnut', 'Ash', 'Willow'];
const NOUN = ['Desk', 'Chair', 'Shelf', 'Lamp', 'Stool', 'Table', 'Bench', 'Cabinet'];
const SEEDS = [3, 11, 2026];

// ---------- truth model ----------
interface Item { id: number; name: string; cents: number }
function catalog(r: () => number, n: number): Item[] {
  const used = new Set<number>();
  const out: Item[] = [];
  while (out.length < n) {
    const id = int(r, 1000, 9999);
    if (used.has(id)) continue;
    used.add(id);
    out.push({ id, name: `${pick(r, ADJ)} ${pick(r, NOUN)} ${id}`, cents: int(r, 100, 250000) });
  }
  return out;
}
/** US-punctuated dollars, the only format the README promises. */
function usd(cents: number): string {
  const whole = String(Math.trunc(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`;
}
function href(id: number): string { return `/p/${id}`; }
function truthRow(base: string, it: Item) {
  return { name: it.name, price: it.cents / 100, href: `${base}${href(it.id)}` };
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function page(title: string, body: string, scripts = false): string {
  return `<html><head><title>${title}</title>${scripts ? '<script src="/app.js"></script>' : ''}</head>` +
    `<body><main><h1>${title}</h1>${body}</main></body></html>`;
}
function cardList(items: Item[], next: string | null): string {
  const lis = items.map(it => `<li><a href="${href(it.id)}">${esc(it.name)}</a> Price: ${usd(it.cents)}</li>`).join('');
  return `<ul>${lis}</ul>${next ? `<a href="${next}">Next</a>` : ''}`;
}

// ---------- fixture plumbing ----------
type Route = (u: URL, base: string) => { status?: number; html: string };
interface World {
  base: string;
  rt: RuntimeImpl;
  run(session: string, program: string, budget?: number): Promise<{ ok: boolean; text: string }>;
  parse(r: { ok: boolean; text: string }): any;
}
async function world(route: Route, body: (w: World) => Promise<void>): Promise<void> {
  let server: ReturnType<typeof createServer> | undefined;
  let rt: RuntimeImpl | undefined;
  try {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const { status = 200, html } = route(u, base);
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end(html);
    });
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const policy = defaultPolicy('local');
    rt = await createAgentweb({ store: new MemoryStore(), policy, ghost: false, chrome: false, cache: false, atlas: false });
    const w: World = {
      base,
      rt,
      run: (session, program, budget = 10000) => rt!.run(session, program, { budget }) as Promise<{ ok: boolean; text: string }>,
      parse: (r) => {
        const i = r.text.indexOf('{"schema"');
        assert.ok(i >= 0, `no collection JSON in output: ${r.text.slice(0, 300)}`);
        return JSON.parse(r.text.slice(i));
      },
    };
    await body(w);
  } finally {
    await rt?.close();
    await new Promise<void>(r => (server ? server.close(() => r()) : r()));
  }
}

const SCHEMA = "name='link', price='money', href='url'";

// ---------- Trial 1: seeded product cards across pages, exact truth ----------
for (const seed of SEEDS) {
  test(`trial 1 [seed ${seed}]: product cards across 3 pages match server truth exactly`, async () => {
    const r = rng(seed);
    const size = int(r, 4, 6);
    const total = size * 3 - int(r, 0, size - 1); // last page partial
    const items = catalog(r, total);
    await world((u, base) => {
      const p = Number(u.searchParams.get('page') ?? 1);
      const slice = items.slice((p - 1) * size, p * size);
      const next = p * size < items.length ? `/catalog?page=${p + 1}` : null;
      return { html: page('Catalogue', cardList(slice, next)) };
    }, async w => {
      const out = w.parse(await w.run(`t1-${seed}`, `open('${w.base}/catalog?page=1'); collect(${SCHEMA}, pages=3)`));
      assert.equal(out.coverage.complete, true, JSON.stringify(out.coverage));
      assert.equal(out.coverage.stop, 'end');
      assert.equal(out.coverage.pages, 3);
      assert.equal(out.coverage.found, total);
      assert.equal(out.coverage.duplicates, 0);
      assert.equal(out.coverage.invalid, 0);
      assert.deepEqual(out.rows.map((x: any) => x.values), items.map(it => truthRow(w.base, it)));
      for (const [i, row] of out.rows.entries()) {
        assert.equal(row.evidence.price, usd(items[i].cents), `evidence for row ${i}`);
        assert.equal(row.source.url, `${w.base}/catalog?page=${Math.floor(i / size) + 1}`);
      }
    });
  });
}

// ---------- Trial 2: pagination limits, cycles, HTTP errors, and budget ----------
test('trial 2: page limit, cycle, HTTP 503 and budget overflow are explicit and keep partial rows', async () => {
  const r = rng(SEEDS[0]);
  const items = catalog(r, 15);
  const size = 5;
  // (a) page limit: 3 pages exist, collect only 2 -> incomplete with a next link pointing at page 3
  await world((u) => {
    const p = Number(u.searchParams.get('page') ?? 1);
    return { html: page('Catalogue', cardList(items.slice((p - 1) * size, p * size), p * size < items.length ? `/catalog?page=${p + 1}` : null)) };
  }, async w => {
    const out = w.parse(await w.run('t2a', `open('${w.base}/catalog?page=1'); collect(${SCHEMA}, pages=2)`));
    assert.equal(out.coverage.complete, false);
    assert.equal(out.coverage.stop, 'page_limit');
    assert.equal(out.coverage.pages, 2);
    assert.equal(out.rows.length, 10);
    assert.equal(out.coverage.next, `${w.base}/catalog?page=3`);
    // limits are enforced at the schema boundary
    const bad = await w.run('t2a-bad', `open('${w.base}/catalog?page=1'); collect(${SCHEMA}, pages=11)`);
    assert.equal(bad.ok, false, 'pages=11 must be rejected');
    const bad0 = await w.run('t2a-bad0', `open('${w.base}/catalog?page=1'); collect(${SCHEMA}, pages=0)`);
    assert.equal(bad0.ok, false, 'pages=0 must be rejected');
  });
  // (b) HTTP 503 on page 2 -> partial page 1 kept, stop=http_error, incomplete
  await world((u) => {
    const p = Number(u.searchParams.get('page') ?? 1);
    if (p === 2) return { status: 503, html: 'Unavailable' };
    return { html: page('Catalogue', cardList(items.slice(0, size), '/catalog?page=2')) };
  }, async w => {
    const out = w.parse(await w.run('t2b', `open('${w.base}/catalog?page=1'); collect(${SCHEMA}, pages=3)`));
    assert.equal(out.coverage.complete, false);
    assert.equal(out.coverage.stop, 'http_error');
    assert.deepEqual(out.rows.map((x: any) => x.values.href), items.slice(0, size).map(it => `${w.base}${href(it.id)}`));
  });
  // (c) cycle: page 2 links back to page 1
  await world((u) => {
    const p = Number(u.searchParams.get('page') ?? 1);
    const slice = p === 1 ? items.slice(0, size) : items.slice(size, 2 * size);
    return { html: page('Catalogue', cardList(slice, p === 1 ? '/catalog?page=2' : '/catalog?page=1')) };
  }, async w => {
    const out = w.parse(await w.run('t2c', `open('${w.base}/catalog?page=1'); collect(${SCHEMA}, pages=5)`));
    assert.equal(out.coverage.stop, 'cycle');
    assert.equal(out.coverage.complete, false);
    assert.equal(out.rows.length, 10);
  });
  // (d) budget overflow: rows are omitted explicitly, kept rows are a truthful prefix
  await world(() => ({ html: page('Catalogue', cardList(items, null)) }), async w => {
    const out = w.parse(await w.run('t2d', `open('${w.base}/catalog'); collect(${SCHEMA}, pages=1)`, 1200));
    assert.equal(out.coverage.complete, false);
    assert.equal(out.coverage.stop, 'budget');
    assert.ok(out.coverage.returned < items.length, 'expected some rows to be omitted');
    assert.deepEqual(out.rows.map((x: any) => x.values), items.slice(0, out.rows.length).map(it => truthRow(w.base, it)));
    assert.equal(out.coverage.found, items.length);
  });
  // (e) JavaScript-driven list with no Next link must not claim completeness
  await world(() => ({ html: page('Catalogue', cardList(items.slice(0, 5), null), true) }), async w => {
    const out = w.parse(await w.run('t2e', `open('${w.base}/catalog'); collect(${SCHEMA}, pages=2)`));
    assert.equal(out.coverage.complete, false);
    assert.equal(out.coverage.stop, 'dynamic_unverified');
  });
});

// ---------- Trial 3: table rows with seeded order ----------
for (const seed of SEEDS) {
  test(`trial 3 [seed ${seed}]: table rows keep server order and typed values`, async () => {
    const r = rng(seed);
    const items = catalog(r, int(r, 5, 9));
    const rows = items.map(it => `<tr><td><a href="${href(it.id)}">${esc(it.name)}</a></td><td>${usd(it.cents)}</td></tr>`).join('');
    await world(() => ({ html: page('Stock', `<table><thead><tr><th>Item</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>`) }), async w => {
      const out = w.parse(await w.run(`t3-${seed}`, `open('${w.base}/stock'); collect(${SCHEMA}, pages=1)`));
      assert.equal(out.coverage.complete, true, JSON.stringify(out.coverage));
      assert.deepEqual(out.rows.map((x: any) => x.values), items.map(it => truthRow(w.base, it)));
    });
  });
}

// ---------- Trial 4: duplicate rows across pages and within a page ----------
test('trial 4: overlap and same-page repeats are deduplicated; distinct twins with different links are kept', async () => {
  const r = rng(SEEDS[1]);
  const items = catalog(r, 8);
  // a twin: identical name and price, different product link
  const twin: Item = { id: 99999, name: items[2].name, cents: items[2].cents };
  const p1 = [...items.slice(0, 4), items[1]]; // items[1] repeated on the same page
  const p2 = [items[2], items[3], ...items.slice(4), twin]; // overlap of items[2..3] with page 1
  await world((u) => {
    const p = Number(u.searchParams.get('page') ?? 1);
    return { html: page('Catalogue', cardList(p === 1 ? p1 : p2, p === 1 ? '/catalog?page=2' : null)) };
  }, async w => {
    const out = w.parse(await w.run('t4', `open('${w.base}/catalog?page=1'); collect(${SCHEMA}, pages=3)`));
    // unique by (text, links): 8 catalog items + 1 twin
    assert.equal(out.coverage.returned, 9, JSON.stringify(out.coverage));
    assert.equal(out.coverage.found, 9);
    assert.equal(out.coverage.duplicates, 3, 'same-page repeat + two overlapping rows');
    assert.equal(out.coverage.complete, true, JSON.stringify(out.coverage));
    const hrefs = out.rows.map((x: any) => x.values.href);
    assert.ok(hrefs.includes(`${w.base}/p/99999`), 'distinct twin must not be deduplicated away');
  });
});

// ---------- Trial 5: malformed and ambiguous money values ----------
type Check = (row: any) => string | null; // returns a failure message or null
const MALFORMED: { label: string; raw: string; check: Check }[] = [
  { label: 'plain', raw: '$12.50', check: r => r.values.price === 12.5 ? null : `expected 12.5 got ${r.values.price}` },
  { label: 'thousands', raw: '$1,250.50', check: r => r.values.price === 1250.5 ? null : `expected 1250.5 got ${r.values.price}` },
  { label: 'currency code', raw: 'USD 12.00', check: r => r.values.price === 12 && r.evidence.price === 'USD 12.00' ? null : `got ${r.values.price} evidence ${r.evidence.price}` },
  { label: 'comma decimal', raw: '$12,50', check: r => r.values.price === null && r.errors?.price ? null : `expected null+error got ${r.values.price}` },
  { label: 'two prices', raw: '$12.50 then $14.00', check: r => r.values.price === null && r.errors?.price === 'ambiguous' ? null : `expected ambiguous null got ${r.values.price}` },
  { label: 'was/now', raw: 'Sale $10 (was $12)', check: r => r.values.price === null ? null : `expected null got ${r.values.price}` },
  { label: 'no price', raw: 'Call for price', check: r => r.values.price === null && r.errors?.price ? null : `expected null got ${r.values.price}` },
  // Negative sign before the currency symbol: "-$5.00" is a refund or discount, not +5.
  { label: 'negative sign before symbol', raw: '-$5.00', check: r => r.values.price === -5 || r.values.price === null ? null : `SIGN LOST: got ${r.values.price} (evidence ${r.evidence.price})` },
  // Currency-qualified symbols: CA$ is not US $; the README says evidence must distinguish currencies.
  { label: 'Canadian dollar symbol', raw: 'CA$12.00', check: r => r.values.price === null || (r.evidence.price ?? '').includes('CA') ? null : `CURRENCY LOST: value ${r.values.price} evidence "${r.evidence.price}"` },
  // Space-grouped thousands (common in FR/NO/SE): "€1 250,00" must not silently become 1.
  { label: 'space-grouped euro amount', raw: '€1 250,00', check: r => r.values.price === null || r.values.price !== 1 ? null : `TRUNCATED: got ${r.values.price} evidence "${r.evidence.price}"` },
  // Trailing sentence period: either the value or an explicit error is acceptable.
  { label: 'trailing period', raw: 'Now $12.', check: r => r.values.price === 12 || r.values.price === null ? null : `got ${r.values.price}` },
];
test('trial 5: malformed money values are typed correctly or refused with an explicit error', async () => {
  const r = rng(SEEDS[2]);
  const rows = shuffle(r, MALFORMED).map((c, i) => ({ ...c, name: `Item ${i} ${pick(r, ADJ)}`, id: 5000 + i }));
  await world(() => ({
    html: page('Catalogue', `<ul>${rows.map(c => `<li><a href="${href(c.id)}">${esc(c.name)}</a> ${esc(c.raw)}</li>`).join('')}</ul>`),
  }), async w => {
    const out = w.parse(await w.run('t5', `open('${w.base}/catalog'); collect(${SCHEMA}, pages=1)`));
    assert.equal(out.coverage.complete, false, 'rows with validation errors must make coverage incomplete');
    assert.equal(out.coverage.returned, rows.length, `expected ${rows.length} rows; coverage=${JSON.stringify(out.coverage)}`);
    const failures: string[] = [];
    for (const [i, c] of rows.entries()) {
      const row = out.rows.find((x: any) => x.values.href === `${w.base}${href(c.id)}`) ?? out.rows[i];
      const msg = c.check(row);
      if (msg) failures.push(`[${c.label}] raw=${JSON.stringify(c.raw)}: ${msg}`);
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });
});

// ---------- Trial 6: link selector with an image-only link before the title link ----------
test('trial 6: an empty-label image link does not make the title link ambiguous', async () => {
  const r = rng(SEEDS[0]);
  const items = catalog(r, 4);
  const cards = items.map(it => `<li><a href="${href(it.id)}"><img src="/i/${it.id}.png" alt=""></a><a href="${href(it.id)}">${esc(it.name)}</a> Price: ${usd(it.cents)}</li>`).join('');
  await world(() => ({ html: page('Catalogue', `<ul>${cards}</ul>`) }), async w => {
    const out = w.parse(await w.run('t6', `open('${w.base}/catalog'); collect(${SCHEMA}, pages=1)`));
    assert.deepEqual(out.rows.map((x: any) => x.values.name), items.map(it => it.name), JSON.stringify(out.rows.map((x: any) => x.errors)));
    assert.equal(out.coverage.complete, true);
  });
});

// ---------- Trial 7: semantic diffs against a session baseline ----------
test('trial 7: diff reports added/removed/updated keys, ignores order and markup, withholds on incomplete runs', async () => {
  const r = rng(SEEDS[2]);
  let items = catalog(r, 10);
  let decorated = false;
  const size = 5;
  const route: Route = (u, base) => {
    const p = Number(u.searchParams.get('page') ?? 1);
    const slice = items.slice((p - 1) * size, p * size);
    const cards = slice.map(it => {
      const badge = decorated ? `<span class="badge" data-v="${it.id % 7}">Stock</span>` : '';
      return `<li class="card ${decorated ? 'x' : ''}"><a href="${href(it.id)}">${esc(it.name)}</a>${badge} Price: ${usd(it.cents)}</li>`;
    }).join('');
    const next = p * size < items.length ? `/catalog?page=${p + 1}` : null;
    return { html: page('Catalogue', `<ul>${cards}</ul>${next ? `<a href="${next}">Next</a>` : ''}`) };
  };
  await world(route, async w => {
    const S = `name='link', price='money', href='url', diff='catalog', key='href'`;
    const run = async (opts: string, session = 't7') => w.parse(await w.run(session, `open('${w.base}/catalog?page=1'); collect(${S}${opts})`));
    const k = (it: Item) => `${w.base}${href(it.id)}`;

    // baseline
    const base = await run(', pages=2');
    assert.equal(base.coverage.complete, true, JSON.stringify(base.coverage));
    assert.equal(base.changes.status, 'created');

    // reorder + decorate markup only: no semantic change
    items = shuffle(r, items);
    decorated = true;
    const reorder = await run(', pages=2');
    assert.equal(reorder.changes.status, 'compared');
    assert.deepEqual([reorder.changes.added, reorder.changes.removed, reorder.changes.updated], [[], [], []], JSON.stringify(reorder.changes));

    // real semantic edits: reprice one, rename one, remove one, add one
    const priced = items[0];
    priced.cents += 100;
    const renamed = items[1];
    const oldName = renamed.name;
    renamed.name = `${renamed.name} Mk2`;
    const removed = items[items.length - 1];
    items = items.slice(0, -1);
    const added: Item = { id: 7777, name: 'Brand New 7777', cents: 4200 };
    items.push(added); // 10 items still -> 2 pages
    const semantic = await run(', pages=2');
    assert.equal(semantic.changes.status, 'compared');
    assert.deepEqual(semantic.changes.added, [k(added)]);
    assert.deepEqual(semantic.changes.removed, [k(removed)]);
    const updated = [...semantic.changes.updated].sort((a: any, b: any) => a.key.localeCompare(b.key));
    const expected = [
      { key: k(priced), fields: ['price'] },
      { key: k(renamed), fields: ['name'] },
    ].sort((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(updated, expected, JSON.stringify(semantic.changes));
    void oldName;

    // a fresh removal, then an incomplete run: it must withhold and must NOT advance the baseline,
    // so the complete run afterwards still reports that removal
    const gone = items[0];
    items = items.slice(1);
    const partial = await run(', pages=1');
    assert.equal(partial.coverage.complete, false);
    assert.equal(partial.changes.status, 'withheld');
    assert.equal(partial.changes.removed, undefined, 'incomplete runs must not report removals');
    const after = await run(', pages=2');
    assert.equal(after.changes.status, 'compared');
    assert.deepEqual(after.changes.removed, [k(gone)], 'baseline must not advance on incomplete runs');
    assert.deepEqual(after.changes.added, [], 'no additions since the last complete run');
    assert.deepEqual(after.changes.updated, [], 'no field edits since the last complete run');

    // schema change resets the baseline
    const reset = w.parse(await w.run('t7', `open('${w.base}/catalog?page=1'); collect(name='link', price='money', href='url', diff='catalog', key='href', pages=2)`));
    assert.equal(reset.changes.status, 'compared', 'same schema should compare');
    const schemaChange = w.parse(await w.run('t7', `open('${w.base}/catalog?page=1'); collect(name='link', href='url', diff='catalog', key='href', pages=2)`));
    assert.equal(schemaChange.changes.status, 'reset');
  });
});

// ---------- Trial 8: duplicate diff keys must withhold, not guess ----------
test('trial 8: two different rows sharing one key withhold the diff instead of guessing', async () => {
  const r = rng(SEEDS[1]);
  const items = catalog(r, 4);
  const extra = `<li><a href="${href(items[0].id)}">${esc(items[0].name)} review</a> Price: $1.00</li>`;
  const cards = items.map(it => `<li><a href="${href(it.id)}">${esc(it.name)}</a> Price: ${usd(it.cents)}</li>`).join('');
  await world(() => ({ html: page('Catalogue', `<ul>${cards}${extra}</ul>`) }), async w => {
    const out = w.parse(await w.run('t8', `open('${w.base}/catalog'); collect(name='link', price='money', href='url', diff='catalog', key='href', pages=1)`));
    assert.equal(out.coverage.complete, true, JSON.stringify(out.coverage));
    assert.equal(out.changes.status, 'withheld');
    assert.match(out.changes.reason, /duplicate/);
  });
});
