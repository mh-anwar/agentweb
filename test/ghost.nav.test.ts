// Navigation and session state: server-rendered forms (POST + login cookie), links, GET forms,
// location assignment, meta refresh, history across documents, cookies, storage, re-opening.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createGhostEngine, REOPENED } from '../src/engines/ghost/index.ts';
import type { Engine, Loaded } from '../src/types.ts';
import { serve, html, makeCtx, textOf, byId, findNode, TestGuard } from './ghost.helpers.ts';

let srv: Awaited<ReturnType<typeof serve>>;
let eng: Engine;

const user = (cookie: string | undefined) => /(?:^|;\s*)sid=([^;]+)/.exec(cookie || '')?.[1];

before(async () => {
  srv = await serve({
    'GET /login': html(`<h1>Sign in</h1>
      <form method="post" action="/login"><label>User <input name="user" required></label>
      <label>Password <input name="pass" type="password" required></label><button>Sign in</button></form>
      <script>document.cookie = 'seen=1; path=/'; document.getElementById('x');</script>`),
    'POST /login': (req, res, body) => {
      const p = new URLSearchParams(body);
      if (p.get('pass') !== 'hunter2') {
        res.writeHead(401, { 'content-type': 'text/html' });
        res.end(html('<h1>Wrong password</h1><a href="/login">Try again</a>'));
        return;
      }
      res.writeHead(303, { location: '/account', 'set-cookie': `sid=${p.get('user')}; Path=/; HttpOnly; SameSite=Lax` });
      res.end();
    },
    '/account': (req, res) => {
      const who = user(req.headers.cookie);
      res.writeHead(who ? 200 : 302, who ? { 'content-type': 'text/html' } : { location: '/login' });
      res.end(
        who
          ? html(`<h1>Account of ${who}</h1><p id="cookies"></p><a href="/orders?page=2">Orders</a>
              <form action="/search"><input name="q"><button>Search</button></form>
              <script>document.getElementById('cookies').textContent = 'js sees: ' + document.cookie;
              localStorage.setItem('last', 'account'); sessionStorage.setItem('tab', 'one');</script>`)
          : '',
      );
    },
    '/orders': (req, res) => {
      const u = new URL(req.url!, 'http://x');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html(`<h1>Orders page ${u.searchParams.get('page')} for ${user(req.headers.cookie)}</h1><p>referer ${req.headers.referer ? new URL(req.headers.referer).pathname : '-'}</p>`));
    },
    '/search': (req, res) => {
      const u = new URL(req.url!, 'http://x');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html(`<h1>Results for ${u.searchParams.get('q')}</h1><button id="b" onclick="history.back()">Go back</button>`));
    },
    '/assign': html(`<p>moving</p><script>setTimeout(() => location.assign('/landed?via=assign'), 500)</script>`),
    '/landed': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html(`<h1>Landed ${new URL(req.url!, 'http://x').search}</h1>`));
    },
    '/refresh': html('<p>old page</p>', '<meta http-equiv="refresh" content="2; url=/landed?via=refresh">'),
    '/store': html(`<p id="v"></p><script>
      const n = +(localStorage.getItem('visits') || 0) + 1; localStorage.setItem('visits', String(n));
      document.getElementById('v').textContent = 'visits ' + n + ' session ' + (sessionStorage.getItem('tab') || 'none');
    </script>`),
    '/data.json': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    '/tojson': html(`<a id="j" href="/data.json">json</a>`),
  });
  eng = createGhostEngine({});
});

after(async () => {
  await eng?.close();
  await srv?.close();
});

const n = (l: Loaded, pred: Parameters<typeof findNode>[1]) => {
  const x = findNode(l.doc!.root, pred);
  assert.ok(x?.n, 'node not found');
  return x.n!;
};
const field = (l: Loaded, name: string) => n(l, (x) => x.t === 'input' && x.a?.name === name);

test('server-rendered login: form POST, HttpOnly cookie, 303, cookies kept across pages', async () => {
  const ctx = makeCtx();
  let l = await eng.open(ctx, { url: srv.url + '/login' });
  assert.equal(textOf(findNode(l.doc!.root, (x) => x.t === 'h1')), 'Sign in');
  // required fields block submission, and the agent is told why
  l = await eng.act!(ctx, { do: 'click', n: n(l, (x) => x.t === 'button') });
  assert.equal(l.url, srv.url + '/login');
  assert.ok((l.events || []).some((e) => /not submitted.*user/.test(e)), JSON.stringify(l.events));

  l = await eng.act!(ctx, { do: 'fill', n: field(l, 'user'), value: 'ada' });
  l = await eng.act!(ctx, { do: 'fill', n: field(l, 'pass'), value: 'hunter2' });
  l = await eng.act!(ctx, { do: 'press', key: 'Enter', n: field(l, 'pass') });
  assert.equal(l.url, srv.url + '/account');
  assert.equal(l.method, 'GET');
  assert.equal(textOf(findNode(l.doc!.root, (x) => x.t === 'h1')), 'Account of ada');
  // the jar holds the server's HttpOnly cookie and the script's cookie; scripts see only the latter
  assert.match(ctx.jar.header(srv.url + '/'), /sid=ada/);
  assert.match(ctx.jar.header(srv.url + '/'), /seen=1/);
  assert.equal(textOf(byId(l.doc!.root, 'cookies')), 'js sees: seen=1');
  assert.ok(srv.hits.includes('POST /login'));

  // a link, with the cookie and a referer
  l = await eng.act!(ctx, { do: 'click', n: n(l, (x) => x.t === 'a' && textOf(x) === 'Orders') });
  assert.equal(l.url, srv.url + '/orders?page=2');
  assert.equal(textOf(findNode(l.doc!.root, (x) => x.t === 'h1')), 'Orders page 2 for ada');
  assert.match(textOf(l.doc!.root), /referer \/account/);

  // back across documents (a GET, so it is fetched again), then a GET form
  l = await eng.act!(ctx, { do: 'back' });
  assert.equal(l.url, srv.url + '/account');
  l = await eng.act!(ctx, { do: 'fill', n: field(l, 'q'), value: 'blue shoes' });
  l = await eng.act!(ctx, { do: 'click', n: n(l, (x) => x.t === 'button') });
  assert.equal(l.url, srv.url + '/search?q=blue+shoes');
  assert.equal(textOf(findNode(l.doc!.root, (x) => x.t === 'h1')), 'Results for blue shoes');

  // history.back() called by the page itself leaves the document
  l = await eng.act!(ctx, { do: 'click', n: n(l, (x) => x.a?.id === 'b') });
  assert.equal(l.url, srv.url + '/account');
  // localStorage reached the session record
  assert.equal(ctx.storage[srv.url]?.last, 'account');
});

test('a wrong password shows the 401 page (POST result) and back returns to the form', async () => {
  const ctx = makeCtx();
  let l = await eng.open(ctx, { url: srv.url + '/login' });
  l = await eng.act!(ctx, { do: 'fill', n: field(l, 'user'), value: 'bob' });
  l = await eng.act!(ctx, { do: 'fill', n: field(l, 'pass'), value: 'nope' });
  l = await eng.act!(ctx, { do: 'click', n: n(l, (x) => x.t === 'button') });
  assert.equal(l.status, 401);
  assert.equal(l.method, 'POST');
  assert.equal(textOf(findNode(l.doc!.root, (x) => x.t === 'h1')), 'Wrong password');
  l = await eng.act!(ctx, { do: 'back' });
  assert.equal(l.url, srv.url + '/login');
});

test('location.assign from a timer and <meta http-equiv=refresh> navigate the session', async () => {
  const ctx = makeCtx();
  let l = await eng.open(ctx, { url: srv.url + '/assign' });
  assert.equal(l.url, srv.url + '/landed?via=assign');
  assert.equal(textOf(findNode(l.doc!.root, (x) => x.t === 'h1')), 'Landed ?via=assign');
  l = await eng.open(ctx, { url: srv.url + '/refresh' });
  assert.equal(l.url, srv.url + '/landed?via=refresh');
  assert.ok((l.events || []).some((e) => e.includes('refresh')));
});

test('storage persists in ctx.storage; an evicted page is re-opened from cookies and URL', async () => {
  const ctx = makeCtx();
  let l = await eng.open(ctx, { url: srv.url + '/store' });
  assert.equal(textOf(byId(l.doc!.root, 'v')), 'visits 1 session none');
  l = await eng.open(ctx, { url: srv.url + '/store' });
  assert.equal(textOf(byId(l.doc!.root, 'v')), 'visits 2 session none');
  assert.equal(ctx.storage[srv.url].visits, '2');
  const oldIds = [...(function* walk(x: any): any { if (x.n) yield x.n; for (const c of x.c || []) yield* walk(c); })(l.doc!.root)];

  await eng.release(ctx.id);
  assert.equal(eng.live!(ctx.id), false);
  ctx.url = srv.url + '/store';
  l = await eng.snapshot!(ctx);
  assert.equal(l.events?.[0], REOPENED);
  assert.equal(textOf(byId(l.doc!.root, 'v')), 'visits 3 session none');
  assert.equal(eng.live!(ctx.id), true);
  // node ids never repeat within a session, so an old id cannot hit a new element
  const newIds = [...(function* walk(x: any): any { if (x.n) yield x.n; for (const c of x.c || []) yield* walk(c); })(l.doc!.root)];
  assert.ok(Math.min(...newIds) > Math.max(...oldIds));
  await assert.rejects(eng.act!(ctx, { do: 'click', n: oldIds[0] }), (e: any) => e.code === 'stale');

  // act on an evicted page re-opens it; a node-targeted action then asks for a re-read
  await eng.release(ctx.id);
  await assert.rejects(eng.act!(ctx, { do: 'click', n: newIds[0] }), (e: any) => e.code === 'stale');
  assert.equal(eng.live!(ctx.id), true);
  // without a URL there is nothing to re-open
  await eng.release(ctx.id);
  await assert.rejects(eng.snapshot!({ ...ctx, url: undefined }), (e: any) => e.code === 'gone');
});

test('a link to a non-HTML resource returns its bytes for a reader', async () => {
  const ctx = makeCtx();
  let l = await eng.open(ctx, { url: srv.url + '/tojson' });
  l = await eng.act!(ctx, { do: 'click', n: n(l, (x) => x.a?.id === 'j') });
  assert.equal(l.contentType, 'application/json');
  assert.equal(l.body?.text, '{"ok":true}');
  assert.equal(eng.live!(ctx.id), false);
});

test('the guard is asked for the document and every hop; a refusal is AwError(policy)', async () => {
  const guard = new TestGuard();
  const ctx = makeCtx({ guard });
  await eng.open(ctx, { url: srv.url + '/account' }); // 302 → /login
  assert.deepEqual(guard.seen.slice(0, 2).map((s) => s.why), ['open', 'redirect']);
  guard.deny = /\/orders/;
  await assert.rejects(eng.open(ctx, { url: srv.url + '/orders?page=1' }), (e: any) => e.code === 'policy');
});
