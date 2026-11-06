import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRuntime, type RuntimeImpl } from '../src/runtime.ts';
import { createJar, createWireEngine, encodeForm } from '../src/net/index.ts';
import { createGuard, defaultPolicy, scoreInjection } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';
import { readBody } from '../src/readers/index.ts';
import { register } from '../src/extract/index.ts';

// 25 products, 10 per page, each with a detail page carrying a weight and a review
const P = Array.from({ length: 25 }, (_, i) => ({
  id: i + 1,
  name: `${['Oak', 'Pine', 'Birch', 'Maple', 'Cedar'][i % 5]} ${['Desk', 'Chair', 'Shelf', 'Lamp', 'Stool'][Math.floor(i / 5)]}`,
  price: 20 + ((i * 37) % 180),
  weight: 2 + ((i * 7) % 30),
}));

let server: Server;
let url = '';
let rt: RuntimeImpl;
let hits = 0;

const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title><script src="/a.js"></script></head><body>
  <header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/cart">Cart</a></nav></header>
  <main>${body}</main><footer><p>© Wood Co. <a href="/terms">Terms</a> <a href="/privacy">Privacy</a></p></footer></body></html>`;

before(async () => {
  server = createServer((req, res) => {
    hits++;
    const u = new URL(req.url ?? '/', 'http://x');
    const send = (html: string, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    if (u.pathname === '/list') {
      const n = Number(u.searchParams.get('page') ?? 1);
      const items = P.slice((n - 1) * 10, n * 10);
      const cards = items
        .map((p) => `<div class="card"><h3><a href="/p/${p.id}">${p.name}</a></h3><span>$${p.price}.00</span> <button>Add to cart</button></div>`)
        .join('');
      const pager = `<nav class="pager">${n > 1 ? `<a href="/list?page=${n - 1}">Previous</a>` : ''} Page ${n} of 3 ${n < 3 ? `<a href="/list?page=${n + 1}">Next</a>` : ''}</nav>`;
      return send(page(`Catalogue page ${n}`, `<h1>Catalogue</h1><p>Solid wood furniture, made to order.</p><div class="grid">${cards}</div>${pager}`));
    }
    if (u.pathname.startsWith('/p/')) {
      const p = P.find((x) => x.id === Number(u.pathname.slice(3)));
      if (!p) return send(page('Not found', '<h1>Not found</h1>'), 404);
      return send(
        page(
          p.name,
          `<h1>${p.name}</h1><p>Price: $${p.price}.00</p><table><tr><th>Weight</th><td>${p.weight} kg</td></tr><tr><th>Finish</th><td>Oiled</td></tr></table>
           <p>Ships in 2 weeks. Free returns within 30 days.</p><h2>Reviews</h2><p>Sturdy and beautiful, five stars from me.</p>`,
        ),
      );
    }
    if (u.pathname === '/js-only') return send('<html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>');
    send(page('Home', '<h1>Wood Co.</h1><p><a href="/list">Catalogue</a> <a href="/js-only">Configurator</a></p>'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const policy = defaultPolicy('local');
  rt = createRuntime({
    store: new MemoryStore(),
    engines: { wire: createWireEngine({ polite: false }) },
    createJar,
    createGuard: (st) => createGuard(policy, st),
    encodeForm,
    readBody,
    scoreInjection: (t) => scoreInjection(t).score,
  });
  register(rt);
});

after(async () => {
  await rt.close();
  await new Promise((r) => server.close(r));
});

let n = 0;
const fresh = () => 'x' + ++n;

test('records lists the repeated items one per line, without the page chrome', async () => {
  const r = await rt.run(fresh(), `open('${url}/list'); records()`);
  assert.ok(r.ok, r.text);
  const out = r.text.slice(r.text.indexOf('10 records'));
  assert.match(out, /^10 records:/);
  assert.match(out, /\[Oak Desk\]\d+ \| \$20\.00/);
  assert.doesNotMatch(out, /Privacy|Terms/);
});

test('records follows Next across pages and filters by words', async () => {
  const r = await rt.run(fresh(), `open('${url}/list'); records('chair', pages=3)`);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /5 records matching 'chair' over 3 pages:/);
  for (const w of ['Oak', 'Pine', 'Birch', 'Maple', 'Cedar']) assert.match(r.text, new RegExp(`${w} Chair`));
  assert.doesNotMatch(r.text, /Desk/);
  assert.equal(r.stats.fetches, 3);
});

test('each opens several links at once and shows the matching lines of each', async () => {
  hits = 0;
  const r = await rt.run(fresh(), `open('${url}/list?page=2'); each('lamp', find='weight', n=5)`);
  assert.ok(r.ok, r.text);
  assert.equal(hits, 1 + 5, 'the list page and five detail pages: ' + r.text);
  const sections = r.text.split('\n## ').slice(1);
  assert.equal(sections.length, 5);
  for (const s of sections) assert.match(s, /Lamp\]\d+ .*Lamp[\s\S]*Weight \| \d+ kg/);
  // the links keep their session numbers, so the agent can click one next
  const num = /\[(\w+ Lamp)\](\d+)/.exec(r.text)!;
  const r2 = await rt.run('x' + n, `click(${num[2]})`);
  assert.match(r2.text, new RegExp(`# ${num[1]}`));
});

test('each says when a page needs JavaScript instead of showing an empty page', async () => {
  const r = await rt.run(fresh(), `open('${url}/'); each('configurator')`);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /needs JavaScript; click\(\d+\)/);
});

test('each without matches, and records without repeated items, say so', async () => {
  const r = await rt.run(fresh(), `open('${url}/'); each('sofa')`);
  assert.match(r.text, /no links on this page match 'sofa'/);
  const r2 = await rt.run(fresh(), `open('${url}/p/3'); records()`);
  assert.match(r2.text, /No repeated items found here/);
});
