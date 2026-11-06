// Isolation and failure: pages that never yield, run out of memory or throw while booting;
// requests the page may not make (policy, CORS); crash containment; clean shutdown.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createGhostEngine, GhostEngine } from '../src/engines/ghost/index.ts';
import type { Loaded } from '../src/types.ts';
import { serve, html, makeCtx, textOf, byId, findNode, TestGuard } from './ghost.helpers.ts';

let srv: Awaited<ReturnType<typeof serve>>;
let other: Awaited<ReturnType<typeof serve>>;
let eng: GhostEngine;

before(async () => {
  other = await serve({
    '/open': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end('{"v":"open"}');
    },
    '/closed': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'leak=1' });
      res.end('{"v":"secret"}');
    },
    '/creds': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': req.headers.origin || '', 'access-control-allow-credentials': 'true' });
      res.end('cookie=' + (req.headers.cookie || ''));
    },
    'OPTIONS /put': (req, res) => {
      res.writeHead(204, {});
      res.end();
    },
    'PUT /put': (req, res) => {
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      res.end('changed');
    },
  });
  srv = await serve({
    '/spin': html(`<p id="a">before</p><script>while (true) {}</script><p id="b">after</p><script>document.getElementById('b').textContent = 'still ran';</script>`),
    '/spin-timer': html(`<p id="a">ok</p><script>setTimeout(() => { for (;;) {} }, 100); setTimeout(() => { document.getElementById('a').textContent = 'later timer ran'; }, 200);</script>`),
    '/microloop': html(`<p>spinning</p><script>setTimeout(() => { (function f() { Promise.resolve().then(f); })(); }, 10)</script>`),
    '/oom': html(`<script>const keep = []; for (;;) keep.push(new Array(1 << 20).fill(Math.random()));</script>`),
    '/throws': html(`<div id="app"></div><script>window.__start = 1; throw new TypeError('cannot read the config');</script>`),
    '/throws-ok': html(`<h1>Article</h1><p>${'Plenty of server-rendered words here. '.repeat(10)}</p><script>undefinedFunction()</script>`),
    '/empty': html(`<div id="root"></div><script>/* renders nothing */</script>`),
    '/badmodule': html(`<div id="root"></div><script type="module">import { x } from './missing.js'; document.getElementById('root').textContent = x;</script>`),
    '/bare': html(`<div id="root"></div><script type="module">import React from 'react';</script>`),
    '/mapped': html(`<script type="importmap">{"imports":{"lib":"/lib.js","lib/":"/libdir/"}}</script><div id="root"></div>
      <script type="module">import { v } from 'lib'; import { w } from 'lib/w.js'; const j = await import('/data.mjs'); document.getElementById('root').textContent = v + w + j.default;</script>
      <script nomodule>document.body.insertAdjacentHTML('beforeend', '<p id="legacy">legacy bundle ran</p>')</script>`),
    '/lib.js': 'export const v = "V";',
    '/libdir/w.js': 'export const w = "W";',
    '/data.mjs': 'export default "J";',
    '/webgl': html(`<canvas id="c"></canvas><script>const gl = document.getElementById('c').getContext('webgl'); if (!gl) throw new Error('WebGL not supported');</script>`),
    '/cors': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html(`<p id="r"></p><script>
        const out = [];
        const put = (k, v) => { out.push(k + '=' + v); document.getElementById('r').textContent = out.sort().join(' '); };
        fetch('${other.url}/open').then(r => r.json()).then(d => put('open', d.v), e => put('open', 'ERR'));
        fetch('${other.url}/closed').then(r => r.json()).then(d => put('closed', d.v), e => put('closed', 'ERR'));
        fetch('${other.url}/creds', { credentials: 'include' }).then(r => r.text()).then(t => put('creds', t), e => put('creds', 'ERR'));
        fetch('${other.url}/put', { method: 'PUT', headers: { 'x-custom': '1' } }).then(r => r.text()).then(t => put('put', t), e => put('put', 'ERR'));
        fetch('/same', { method: 'POST', body: 'x' }).then(r => r.text()).then(t => put('same', t));
      </script>`));
    },
    'POST /same': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('cookie:' + (req.headers.cookie || ''));
    },
    '/evil-sub': html(`<p id="r">no script</p><script src="/evil.js"></script>`),
    '/evil.js': `document.getElementById('r').textContent = 'evil ran'`,
    '/escape': html(`<p id="r"></p><script>
      let r;
      try { r = typeof (function(){ return this })().process + ' ' + Function('return typeof process')() + ' ' + typeof require; } catch (e) { r = 'threw ' + e.message; }
      document.getElementById('r').textContent = r;
    </script>`),
    '/fine': html(`<h1>Fine</h1><button disabled>Off</button><select name="s"><option>One</option><option>Two</option></select>`),
  });
  eng = createGhostEngine({ limits: { cpuMs: 300 } }) as GhostEngine;
});

after(async () => {
  await eng?.close();
  await srv?.close();
  await other?.close();
});

const h = (l: Loaded, id: string) => textOf(byId(l.doc!.root, id));

test('while(true) in a script is stopped by the CPU budget; the rest of the page still runs', async () => {
  const ctx = makeCtx();
  const t0 = performance.now();
  const l = await eng.open(ctx, { url: srv.url + '/spin' });
  assert.ok(performance.now() - t0 < 3000);
  assert.equal(h(l, 'b'), 'still ran');
  assert.match(l.escalate || '', /ran longer than 300 ms/);
  const l2 = await eng.open(ctx, { url: srv.url + '/spin-timer' });
  assert.equal(h(l2, 'a'), 'later timer ran');
  assert.match(l2.escalate || '', /ran longer/);
});

test('a page that never yields (microtask loop) is killed at the deadline; other sessions keep working', async () => {
  const a = makeCtx({ timeoutMs: 2500 });
  const b = makeCtx();
  await eng.open(b, { url: srv.url + '/fine' });
  const kills = eng.stats!().kills;
  const t0 = performance.now();
  await assert.rejects(eng.open(a, { url: srv.url + '/microloop' }), (e: any) => e.code === 'timeout');
  assert.ok(performance.now() - t0 < 6000, 'killed promptly: ' + Math.round(performance.now() - t0));
  assert.equal(eng.stats!().kills, kills + 1);
  assert.equal(eng.live!(a.id), false);
  const s = await eng.snapshot!(b);
  assert.equal(textOf(findNode(s.doc!.root, (x) => x.t === 'h1')), 'Fine');
  // the killed session can open again
  const again = await eng.open(a, { url: srv.url + '/fine' });
  assert.equal(again.status, 200);
});

test('a page over its memory cap becomes AwError(too_large) without taking the engine down', async () => {
  const small = createGhostEngine({ memoryMb: 96, spare: 0 }) as GhostEngine;
  try {
    const ctx = makeCtx();
    await assert.rejects(small.open(ctx, { url: srv.url + '/oom' }), (e: any) => e.code === 'too_large' && /96 MB/.test(e.message));
    const ok = await small.open(ctx, { url: srv.url + '/fine' });
    assert.equal(ok.status, 200);
  } finally {
    await small.close();
  }
});

test('uncaught errors while booting, empty bodies, unloadable modules and WebGL escalate', async () => {
  const ctx = makeCtx();
  let l = await eng.open(ctx, { url: srv.url + '/throws' });
  assert.match(l.escalate || '', /script error while booting: .*cannot read the config/);
  l = await eng.open(ctx, { url: srv.url + '/throws-ok' });
  assert.equal(l.escalate, undefined, 'a page with real content and a stray error worked');
  assert.ok((l.events || []).some((e) => /undefinedFunction/.test(e)), JSON.stringify(l.events));
  l = await eng.open(ctx, { url: srv.url + '/empty' });
  assert.match(l.escalate || '', /empty/);
  l = await eng.open(ctx, { url: srv.url + '/badmodule' });
  assert.match(l.escalate || '', /module could not be loaded: .*missing\.js.*404/);
  l = await eng.open(ctx, { url: srv.url + '/bare' });
  assert.match(l.escalate || '', /module could not be loaded: .*bare specifier/);
  l = await eng.open(ctx, { url: srv.url + '/webgl' });
  assert.match(l.escalate || '', /WebGL/);
});

test('import maps, top-level await with dynamic import(), and nomodule fallbacks are skipped', async () => {
  const ctx = makeCtx();
  const l = await eng.open(ctx, { url: srv.url + '/mapped' });
  assert.equal(l.escalate, undefined, String(l.escalate));
  assert.equal(h(l, 'root'), 'VWJ');
  assert.equal(byId(l.doc!.root, 'legacy'), undefined);
});

test('page requests follow CORS: unreadable cross-origin answers and refused preflights fail', async () => {
  const ctx = makeCtx();
  ctx.jar.setFromHeaders(srv.url + '/', ['own=1; Path=/']);
  ctx.jar.setFromHeaders(other.url + '/', ['theirs=2; Path=/; SameSite=None; Secure']);
  const before = other.hits.length;
  const l = await eng.open(ctx, { url: srv.url + '/cors' });
  const r = h(l, 'r');
  assert.match(r, /open=open/);
  assert.match(r, /closed=ERR/);
  // cookies are not port-specific (RFC 6265): both go to the other port when credentials are included
  assert.match(r, /creds=cookie=.*theirs=2/);
  assert.match(r, /put=ERR/);
  assert.match(r, /same=cookie:own=1/);
  const hits = other.hits.slice(before);
  assert.ok(hits.includes('OPTIONS /put') && !hits.includes('PUT /put'), 'the preflight was refused, so the PUT was never sent: ' + hits);
  assert.ok(!ctx.jar.header(other.url + '/').includes('leak'), 'a credential-less request stores no cookies');
  assert.ok((l.events || []).some((e) => e.startsWith('blocked by CORS')), JSON.stringify(l.events));
});

test('the guard is asked for subresources; a refused script is reported, not fetched', async () => {
  const guard = new TestGuard();
  guard.deny = /evil\.js/;
  const ctx = makeCtx({ guard });
  const before = srv.hits.filter((x) => x.includes('evil.js')).length;
  const l = await eng.open(ctx, { url: srv.url + '/evil-sub' });
  assert.equal(h(l, 'r'), 'no script');
  assert.ok(guard.seen.some((s) => s.why === 'sub' && s.url.endsWith('/evil.js')));
  assert.equal(srv.hits.filter((x) => x.includes('evil.js')).length, before);
  assert.ok((l.events || []).some((e) => e.startsWith('blocked by policy')), JSON.stringify(l.events));
});

test('page code sees no Node globals', async () => {
  const l = await eng.open(makeCtx(), { url: srv.url + '/escape' });
  assert.equal(h(l, 'r'), 'undefined undefined undefined');
});

test('unsupported and invalid actions', async () => {
  const ctx = makeCtx();
  const l = await eng.open(ctx, { url: srv.url + '/fine' });
  await assert.rejects(eng.act!(ctx, { do: 'shot' }), (e: any) => e.code === 'unsupported');
  await assert.rejects(eng.act!(ctx, { do: 'upload', n: 1, files: [] }), (e: any) => e.code === 'unsupported');
  await assert.rejects(eng.act!(ctx, { do: 'click', n: 999999 }), (e: any) => e.code === 'stale');
  const off = findNode(l.doc!.root, (x) => x.t === 'button')!.n!;
  await assert.rejects(eng.act!(ctx, { do: 'click', n: off }), (e: any) => e.code === 'bad_request' && /disabled/.test(e.message));
  const sel = findNode(l.doc!.root, (x) => x.t === 'select')!.n!;
  await assert.rejects(eng.act!(ctx, { do: 'select', n: sel, value: 'Three' }), (e: any) => e.code === 'bad_request' && /one, two/.test(e.hint));
  const ok = await eng.act!(ctx, { do: 'select', n: sel, value: 'two' });
  assert.equal(findNode(ok.doc!.root, (x) => x.t === 'select')!.v, 'Two');
});

test('close() leaves no page process behind', async () => {
  const e2 = createGhostEngine({}) as GhostEngine;
  await e2.open(makeCtx(), { url: srv.url + '/fine' });
  await e2.open(makeCtx(), { url: srv.url + '/fine' });
  await new Promise((r) => setTimeout(r, 50));
  const pids = e2.pids();
  assert.ok(pids.length >= 2, 'pids ' + pids);
  await e2.close();
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'process ' + pid + ' still exists');
});
