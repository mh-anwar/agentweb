import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentweb } from '../src/index.ts';
import type { RuntimeImpl } from '../src/runtime.ts';
import { defaultPolicy } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';

let server: Server;
let rt: RuntimeImpl;
let url: string;
let seq = 0;
let monitorPhase = 0;
const hits: string[] = [];
const products = [
  { id: 1, name: 'Oak Office Desk', price: '$1,250.50' },
  { id: 2, name: 'Pine Office Chair', price: '£90.00' },
  { id: 3, name: 'Birch Storage Shelf', price: '$52.00' },
  { id: 4, name: 'Maple Reading Lamp', price: '$33.00' },
  { id: 5, name: 'Cedar Garden Stool', price: '$60.00' },
];

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    hits.push(u.pathname + u.search);
    const n = Number(u.searchParams.get('page') ?? 1);
    if (u.pathname === '/failure' && n === 2) { res.writeHead(503); res.end('Unavailable'); return; }
    if (u.pathname === '/redirect-cycle' && n === 2) { res.writeHead(302, { location: '/redirect-cycle' }); res.end(); return; }
    let items = n === 1 ? products.slice(0, 3) : products.slice(2);
    if (u.pathname === '/short' && n === 2) items = products.slice(3);
    if (u.pathname === '/invalid') items = products.slice(0, 3).map(p => ({ ...p, price: p.id === 1 ? '$12.50 then $14.00' : p.id === 2 ? 'unknown' : '$12,50' }));
    if (u.pathname === '/secret') items = products.slice(0, 3).map(p => ({ ...p, name: p.name + ' hidden-password' }));
    if (u.pathname === '/monitor') items = monitorPhase === 1 ? [{ ...products[1], price: '$100.00' }, ...products.slice(2, 4)] : products.slice(0, 3);
    const cards = items.map(p => `<li><a href="/product/${p.id}">${p.name}</a> Price: ${p.price}</li>`).join('');
    const pager = u.pathname === '/cycle' ? `<a href="/cycle">Next</a>`
      : n === 1 && !['/invalid', '/secret', '/dynamic', '/empty', '/monitor'].includes(u.pathname) ? `<a href="${u.pathname}?page=2">Next</a>` : '';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Catalogue</title>${u.pathname === '/dynamic' ? '<script src="/app.js"></script>' : ''}</head><body><main><h1>Catalogue</h1><ul>${u.pathname === '/empty' ? '' : cards}</ul>${pager}</main></body></html>`);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const policy = defaultPolicy('local');
  policy.secrets = [{ name: 'test', value: 'hidden-password', origins: [url] }];
  rt = await createAgentweb({ store: new MemoryStore(), policy, ghost: false, chrome: false, cache: false, atlas: false });
});
after(async () => { await rt?.close(); await new Promise<void>(r => server.close(() => r())); });

async function run(path = '/list', opts = ", pages=3", budget = 10000) {
  const result = await rt.run(`collect-${++seq}`, `open('${url}${path}'); collect(name='link', price='money', href='url'${opts})`, { budget });
  assert.ok(result.ok, result.text);
  const data = JSON.parse(result.text.slice(result.text.indexOf('{"schema"')));
  return { result, ...data };
}

test('collect returns exact typed values, field evidence, source URLs and cross-page deduplication', async () => {
  const r = await run();
  assert.equal(r.coverage.complete, true);
  assert.equal(r.coverage.stop, 'end');
  assert.equal(r.coverage.pages, 2);
  assert.equal(r.coverage.found, 5);
  assert.equal(r.coverage.duplicates, 1);
  assert.deepEqual(r.rows.map((x: any) => x.values.price), [1250.5, 90, 52, 33, 60]);
  assert.deepEqual(r.rows.map((x: any) => x.values.name), products.map(p => p.name));
  for (const [i, row] of r.rows.entries()) {
    assert.equal(row.values.href, `${url}/product/${i + 1}`);
    assert.equal(row.evidence.price, products[i].price);
    assert.equal(row.evidence.name, products[i].name);
    assert.equal(row.source.url, url + (i < 3 ? '/list' : '/list?page=2'));
    assert.ok(row.source.block);
  }
});

test('page limit returns a continuation and never claims completeness', async () => {
  const r = await run('/list', ', pages=1');
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.stop, 'page_limit');
  assert.equal(r.coverage.next, `${url}/list?page=2`);
  assert.equal(r.rows.length, 3);
});

test('malformed, absent and ambiguous numbers become null with explicit errors', async () => {
  const r = await run('/invalid');
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.invalid, 3);
  assert.deepEqual(r.rows.map((x: any) => x.values.price), [null, null, null]);
  assert.equal(r.rows[0].errors.price, 'ambiguous');
  assert.equal(r.rows[1].errors.price, 'missing or unsupported format');
});

test('pagination cycle stops before issuing a duplicate request', async () => {
  const before = hits.length;
  const r = await run('/cycle');
  assert.equal(r.coverage.stop, 'cycle');
  assert.equal(r.coverage.complete, false);
  assert.equal(hits.length - before, 1);
});

test('HTTP errors preserve previous rows and identify incomplete coverage', async () => {
  const r = await run('/failure');
  assert.equal(r.coverage.stop, 'http_error');
  assert.equal(r.coverage.complete, false);
  assert.equal(r.rows.length, 3);
});

test('dynamic lists cannot silently assert they reached the end', async () => {
  const r = await run('/dynamic');
  assert.ok(['dynamic_unverified', 'javascript_required'].includes(r.coverage.stop));
  assert.equal(r.coverage.complete, false);
});

test('absence of recognized records is explicit', async () => {
  const r = await run('/empty');
  assert.equal(r.coverage.stop, 'no_records');
  assert.equal(r.coverage.complete, false);
  assert.equal(r.rows.length, 0);
});

test('budget cuts whole JSON rows, reports omitted records and stays bounded', async () => {
  const r = await run('/list', ', pages=3', 650);
  assert.equal(r.coverage.stop, 'budget');
  assert.equal(r.coverage.complete, false);
  assert.ok(r.coverage.omitted > 0);
  assert.equal(r.rows.length + r.coverage.omitted, r.coverage.found);
  assert.ok(r.result.stats.tokens <= 650, r.result.text);
});

test('secrets are redacted in values AND evidence', async () => {
  const r = await run('/secret');
  assert.doesNotMatch(r.result.text, /hidden-password/);
  assert.match(r.rows[0].evidence.name, /secret:test/);
});

test('unknown rules, empty schemas, and invalid limits fail before traversal', async () => {
  for (const command of ["collect(name='magic')", 'collect()', "collect(name='link', pages=1.5)", "collect(name='link', pages=11)"]) {
    const r = await rt.run(`invalid-${++seq}`, `open('${url}/list'); ${command}`);
    assert.equal(r.ok, false, r.text);
    assert.match(r.text, /invalid collection field|collect needs|integer from 1 to 10/);
  }
});


test('redirects back to a visited page are detected without repeated traversal', async () => {
  const r = await run('/redirect-cycle');
  assert.equal(r.coverage.stop, 'cycle');
  assert.equal(r.coverage.complete, false);
  assert.equal(r.coverage.pages, 1);
});

test('short final lists keep both row boundaries and all records', async () => {
  const r = await run('/short');
  assert.equal(r.coverage.complete, true);
  assert.equal(r.coverage.found, 5);
  assert.equal(r.rows.length, 5);
});


test('semantic baselines persist across calls, isolate sessions and survive incomplete runs', async () => {
  const command = `open('${url}/monitor'); collect(name='link', price='money', href='url', diff='catalog', key='href', pages=3)`;
  const call = async (session: string, budget = 10000) => {
    const r = await rt.run(session, command, { budget });
    assert.ok(r.ok, r.text);
    return JSON.parse(r.text.slice(r.text.indexOf('{"schema"')));
  };
  monitorPhase = 0;
  const initial = await call('monitor');
  assert.equal(initial.changes.status, 'created');
  monitorPhase = 1;
  const partial = await call('monitor', 650);
  assert.equal(partial.changes.status, 'withheld');
  const changed = await call('monitor');
  assert.deepEqual(changed.changes, {
    status: 'compared', added: [url + '/product/4'], removed: [url + '/product/1'],
    updated: [{ key: url + '/product/2', fields: ['price'] }],
  });
  const unchanged = await call('monitor');
  assert.deepEqual(unchanged.changes, { status: 'compared', added: [], removed: [], updated: [] });
  const isolated = await call('other-monitor');
  assert.equal(isolated.changes.status, 'created');
});
