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
