// Tabs: several pages open in one session, sharing its cookies.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentweb, type Runtime } from '../src/index.ts';

let server: Server;
let base = '';
let rt: Runtime;

const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    const send = (body: string, headers: Record<string, string> = {}) => res.writeHead(200, { 'content-type': 'text/html', ...headers }).end(body);
    if (url === '/a') send(html('Alpha', '<h1>Alpha page</h1><a href="/b">to beta</a>'));
    else if (url === '/b') send(html('Beta', '<h1>Beta page</h1>'));
    else if (url === '/counter') send(html('Counter', `<h1>Counter</h1><button onclick="document.getElementById('n').textContent='count '+(++window.c)">Add one</button><p id="n">count 0</p><script>window.c=0</script>`));
    else if (url === '/signin') send(html('Signed in', '<p>you are signed in</p>'), { 'set-cookie': 'sid=abc; Path=/' });
    else if (url === '/who') send(html('Who', `<p>cookie:[${req.headers.cookie ?? ''}]</p>`));
    else res.writeHead(404).end('no');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = await createAgentweb({ store: 'memory:', ghost: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_NO_SANDBOX: '1', AGENTWEB_USAGE_LOG: '', AGENTWEB_ATLAS: '0' } });
});

after(async () => {
  await rt.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('tabs', () => {
  it('opens, lists, switches and closes tabs; each keeps its own page and history', async () => {
    const r1 = await rt.run('t', `open('${base}/a'); tab('new', '${base}/b'); tabs()`);
    assert.ok(r1.ok, r1.text);
    assert.match(r1.text, /  tab 1: Alpha - .*\/a\n\* tab 2: Beta - .*\/b/);
    const r2 = await rt.run('t', 'tab(1)');
    assert.match(r2.text, /tab 1\n/);
    assert.match(r2.text, /Alpha page/);
    assert.doesNotMatch(r2.text, /Beta page/);
    // history belongs to the tab
    const r3 = await rt.run('t', "click('to beta'); tab(2); back()");
    assert.ok(!r3.ok, 'tab 2 has nowhere to go back to');
    const r4 = await rt.run('t', 'tab(1); back()');
    assert.ok(r4.ok, r4.text);
    assert.match(r4.text, /Alpha page/);
    const r5 = await rt.run('t', "tab('close'); tabs()");
    assert.match(r5.text, /closed tab 1; now on tab 2/);
    assert.match(r5.text, /\* tab 2: Beta/);
    assert.doesNotMatch(r5.text, /tab 1:/);
    const r6 = await rt.run('t', "tab('close')");
    assert.ok(!r6.ok);
    assert.match(r6.text, /only tab/);
    const r7 = await rt.run('t', 'tab(7)');
    assert.match(r7.text, /no tab 7/);
  });

  it('keeps a live page alive in the other tab and shares cookies between tabs', async () => {
    const a = await rt.run('live', `engine('chrome'); open('${base}/counter'); click('Add one'); click('Add one')`);
    assert.ok(a.ok, a.text);
    assert.match(a.text, /count 2/);
    const b = await rt.run('live', `tab('new', '${base}/signin'); tab(1)`);
    assert.ok(b.ok, b.text);
    assert.match(b.text, /count 2/, 'the first tab was not reloaded');
    const c = await rt.run('live', `click('Add one'); open('${base}/who')`);
    assert.match(c.text, /cookie:\[sid=abc\]/, 'the sign-in from tab 2 is visible in tab 1');
    const d = await rt.run('live', "tab('close', 2); tabs()");
    assert.ok(d.ok, d.text);
    assert.doesNotMatch(d.text, /tab 2:/);
  });
});
