// Classic script semantics (order, defer, async, document.write, dynamic insertion), XHR,
// SameSite cookies on page-initiated navigation, and the page pool (LRU cap, idle TTL, concurrency).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createGhostEngine, GhostEngine } from '../src/engines/ghost/index.ts';
import type { Loaded } from '../src/types.ts';
import { serve, html, makeCtx, textOf, byId, findNode } from './ghost.helpers.ts';

let srv: Awaited<ReturnType<typeof serve>>;
let eng: GhostEngine;
const slow = (body: string, ms: number) => (_req: any, res: any) => {
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(body);
  }, ms);
};

before(async () => {
  srv = await serve({
    '/order': html(`<p id="log"></p>
      <script>window.log = []; const L = (s) => { log.push(s); document.getElementById('log').textContent = log.join(','); };
        document.addEventListener('DOMContentLoaded', () => L('dcl')); window.addEventListener('load', () => L('load'));</script>
      <script defer src="/d1.js"></script>
      <script async src="/a1.js"></script>
      <script src="/s1.js"></script>
      <script>L('inline2'); document.write('<p id="written">written by document.write</p>');</script>
      <script defer src="/d2.js"></script>
      <script>const s = document.createElement('script'); s.src = '/dyn.js'; document.head.appendChild(s);</script>`),
    '/d1.js': slow("L('d1')", 40),
    '/d2.js': "L('d2')",
    '/a1.js': slow("L('async')", 5),
    '/s1.js': slow("L('s1:' + !!document.getElementById('log') + ':' + !document.getElementById('written'))", 30),
    '/dyn.js': "L('dyn')",
    '/xhr': html(`<p id="r"></p><script>
      const x = new XMLHttpRequest(); x.open('POST', '/echo'); x.setRequestHeader('content-type', 'application/json');
      x.responseType = 'json';
      x.onload = () => { document.getElementById('r').textContent = x.status + ' ' + x.response.got + ' ' + x.getResponseHeader('x-echo'); };
      x.send(JSON.stringify({ a: 1 }));
    </script>`),
    'POST /echo': (req, res, body) => {
      res.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' });
      res.end(JSON.stringify({ got: JSON.parse(body).a + 1 }));
    },
    '/cross': (req, res) => {
      const port = new URL(srv.url).port;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html(`<a id="go" href="http://localhost:${port}/whoami">get</a>
        <form method="post" action="http://localhost:${port}/whoami"><button id="post">post</button></form>`));
    },
    '/whoami': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html(`<h1>${req.method} cookie=${req.headers.cookie || 'none'}</h1>`));
    },
    '/page': html('<h1>page</h1>'),
  });
  eng = createGhostEngine({}) as GhostEngine;
});

after(async () => {
  await eng?.close();
  await srv?.close();
});

test('script order: blocking, defer, async, document.write, inserted scripts, DOMContentLoaded and load', async () => {
  const l = await eng.open(makeCtx(), { url: srv.url + '/order' });
  const log = textOf(byId(l.doc!.root, 'log')).split(',');
  assert.equal(textOf(byId(l.doc!.root, 'written')), 'written by document.write');
  // the parser waited for s1 (it saw #log but not yet the written paragraph)
  assert.equal(log[0] === 'async' ? log[1] : log[0], 's1:true:true');
  const at = (s: string) => log.indexOf(s);
  assert.ok(at('inline2') > at('s1:true:true'));
  assert.ok(at('d1') > at('inline2') && at('d2') > at('d1'), 'defer scripts run in order after parsing: ' + log);
  assert.ok(at('dcl') > at('d2'), 'DOMContentLoaded after deferred scripts: ' + log);
  assert.ok(at('load') > at('dcl') && at('load') > at('dyn') && at('load') > at('async'), log.join(','));
});

test('XMLHttpRequest with a JSON body, responseType json and response headers', async () => {
  const l = await eng.open(makeCtx(), { url: srv.url + '/xhr' });
  assert.equal(textOf(byId(l.doc!.root, 'r')), '200 2 yes');
});

test('page-initiated cross-site navigation: Lax cookies go with a GET link, not with a POST', async () => {
  const port = new URL(srv.url).port;
  const ctx = makeCtx();
  ctx.jar.setFromHeaders(`http://localhost:${port}/`, ['lax=1; Path=/; SameSite=Lax', 'strict=1; Path=/; SameSite=Strict']);
  let l = await eng.open(ctx, { url: srv.url + '/cross' });
  l = await eng.act!(ctx, { do: 'click', n: findNode(l.doc!.root, (x) => x.a?.id === 'go')!.n! });
  assert.equal(textOf(findNode(l.doc!.root, (x) => x.t === 'h1')), 'GET cookie=lax=1');
  l = await eng.open(ctx, { url: srv.url + '/cross' });
  l = await eng.act!(ctx, { do: 'click', n: findNode(l.doc!.root, (x) => x.a?.id === 'post')!.n! });
  assert.equal(textOf(findNode(l.doc!.root, (x) => x.t === 'h1')), 'POST cookie=none');
  // the agent opening the URL itself is a first-party visit
  l = await eng.open(ctx, { url: `http://localhost:${port}/whoami` });
  assert.match(textOf(findNode(l.doc!.root, (x) => x.t === 'h1')), /lax=1/);
});

test('LRU cap and idle TTL evict pages; concurrent sessions run in parallel', async () => {
  const pool = createGhostEngine({ maxPages: 2, idleMs: 400, spare: 1 }) as GhostEngine;
  try {
    const ctxs = [makeCtx(), makeCtx(), makeCtx()];
    const t0 = performance.now();
    const res = await Promise.all(ctxs.map((c) => pool.open(c, { url: srv.url + '/page' })));
    const wall = performance.now() - t0;
    assert.ok(res.every((r: Loaded) => r.status === 200));
    const st = pool.stats!();
    assert.equal(st.live, 2, JSON.stringify(st));
    assert.ok(st.evictions >= 1, JSON.stringify(st));
    assert.equal(ctxs.filter((c) => pool.live!(c.id)).length, 2);
    for (let i = 0; i < 40 && pool.stats!().live > 0; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(pool.stats!().live, 0, 'idle pages were evicted');
    console.log(`3 concurrent cold opens: ${Math.round(wall)} ms`);
  } finally {
    await pool.close();
  }
});
