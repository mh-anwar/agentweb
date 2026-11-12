// Regressions reported from real use (a Next.js app tested with agentweb):
//  - a display:contents wrapper has no box of its own; everything inside it was dropped from the view
//  - a click that does nothing in the light script engine is made again in the real browser

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentweb, type Runtime } from '../src/index.ts';

let server: Server;
let base = '';
let clicks = 0;
const env = { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_NO_SANDBOX: '1', AGENTWEB_USAGE_LOG: '', AGENTWEB_ATLAS: '0' };

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html><head><title>App</title></head><body>${body}</body></html>`);
    if (url === '/contents')
      send(`<nav><a href="/x">Dashboard</a></nav><main style="display:flex"><div><div style="display:contents"><h1>Today</h1><button onclick="document.getElementById('o').textContent='dialog open'">Sign in by hand</button><p id="o">closed</p></div></div></main>`);
    else if (url === '/trusted')
      // opens only for a real pointer: what dialogs and menus built on pointer events amount to
      send(`<main><h1>Visits</h1><p>${'Students appear here when they are scanned or signed in by hand. '.repeat(6)}</p><ul><li><a href="/a">Alpha student</a></li><li><a href="/b">Beta student</a></li><li><a href="/c">Gamma student</a></li></ul><button id="b">Open dialog</button><p id="o">closed</p></main><script>document.getElementById('b').addEventListener('click', (e) => { if (e.isTrusted) document.getElementById('o').textContent = 'dialog open'; });</script>`);
    else if (url === '/pings')
      send(`<h1>Likes</h1><button id="b">Like</button><script>document.getElementById('b').addEventListener('click', () => fetch('/ping', { method: 'POST' }));</script>`);
    else if (url === '/ping') {
      clicks++;
      res.writeHead(204).end();
    } else res.writeHead(404).end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('reported regressions', () => {
  it('shows and clicks content inside a display:contents wrapper (chrome)', async () => {
    const rt: Runtime = await createAgentweb({ store: 'memory:', ghost: false, env });
    try {
      const r = await rt.run('c', `engine('chrome'); open('${base}/contents'); click('Sign in by hand')`);
      assert.ok(r.ok, r.text);
      assert.match(r.text, /Today/);
      assert.match(r.text, /dialog open/);
      assert.doesNotMatch(r.text, /hidden text block/);
    } finally {
      await rt.close();
    }
  });

  it('a click that does nothing in the script engine is retried in the real browser, once', async () => {
    const rt: Runtime = await createAgentweb({ store: 'memory:', env });
    try {
      const r = await rt.run('g', `open('${base}/trusted'); click('Open dialog')`);
      assert.ok(r.ok, r.text);
      assert.match(r.text, /dialog open/);
      assert.match(r.text, /did nothing without a real browser/);
      assert.match(r.text, /\[chrome\]/);
      // the site is remembered: the next page there starts in the browser
      const again = await rt.run('g', `open('${base}/trusted')`);
      assert.match(again.text, /\[chrome\]/);
    } finally {
      await rt.close();
    }
  });

  it('a click that reached a server is never repeated', async () => {
    const rt: Runtime = await createAgentweb({ store: 'memory:', env });
    try {
      clicks = 0;
      const r = await rt.run('p', `open('${base}/pings'); click('Like')`);
      assert.ok(r.ok, r.text);
      await new Promise((res) => setTimeout(res, 300));
      assert.equal(clicks, 1, r.text);
    } finally {
      await rt.close();
    }
  });
});

describe('cross-origin requests from the script engine', () => {
  it('passes a CORS preflight on a server that echoes the requested headers; a refused one is redone in the real browser with the fields filled again', async () => {
    const calls: string[] = [];
    let echo = true;
    let refusals = 0;
    const api = createServer((req, res) => {
      calls.push(`${req.method} ${req.headers['access-control-request-headers'] ?? ''}`);
      const asked = req.headers['access-control-request-headers'];
      // like Supabase's gateway: the allowed headers are the ones the preflight named. With echo off, the first
      // preflight is refused (as one this engine could not pass would be) and later ones are let through.
      const cors: Record<string, string> = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,OPTIONS' };
      const refuse = req.method === 'OPTIONS' && !echo && refusals++ === 0;
      if (asked && !refuse) cors['access-control-allow-headers'] = String(asked);
      if (req.method === 'OPTIONS') return void res.writeHead(200, cors).end();
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        calls.push('body ' + body);
        res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const site = createServer((_q, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end(
        `<!doctype html><title>Login</title><main><h1>Sign in</h1><p>${'Use the email on your account. '.repeat(8)}</p><input aria-label="Email" id="e"><button id="b">Email me a sign-in link</button><p id="o">idle</p></main><script>document.getElementById('b').addEventListener('click', async () => { try { const r = await fetch('${apiUrl}/otp', { method: 'POST', headers: { 'content-type': 'application/json', apikey: 'k', 'x-client-info': 'c' }, body: JSON.stringify({ email: document.getElementById('e').value }) }); document.getElementById('o').textContent = r.ok ? 'link sent' : 'failed'; } catch (e) { document.getElementById('o').textContent = 'could not send'; } });</script>`,
      ),
    );
    await new Promise<void>((r) => site.listen(0, 'localhost', r));
    const page = `http://localhost:${(site.address() as AddressInfo).port}/`;
    const rt: Runtime = await createAgentweb({ store: 'memory:', env });
    try {
      const a = await rt.run('cors1', `open('${page}'); fill('Email', 'a@b.co'); click('Email me a sign-in link')`);
      assert.ok(a.ok, a.text);
      assert.match(a.text, /link sent/);
      assert.match(a.text, /\[ghost\]/, 'the script engine was enough');
      assert.ok(calls.some((c) => /^OPTIONS .*apikey/.test(c)), 'the preflight names the headers: ' + calls.join(' | '));
      assert.equal(calls.filter((c) => c.startsWith('body')).length, 1);

      echo = false;
      calls.length = 0;
      const b = await rt.run('cors2', `open('${page}'); fill('Email', 'c@d.co'); click('Email me a sign-in link')`);
      assert.ok(b.ok, b.text);
      assert.match(b.text, /refused before it was sent/);
      assert.match(b.text, /\[chrome\]/);
      assert.match(b.text, /link sent/);
      assert.deepEqual(calls.filter((c) => c.startsWith('body')), ['body {"email":"c@d.co"}'], 'sent once, with the typed value');
    } finally {
      await rt.close();
      await new Promise<void>((r) => api.close(() => r()));
      await new Promise<void>((r) => site.close(() => r()));
    }
  });
});
