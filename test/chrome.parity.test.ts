// Features that other browser tools have and agents reach for: js, console/network logs, downloads,
// dialogs, emulation, forward, drag, double/right click, pdf. Real Chromium against a tiny local site.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentweb } from '../src/index.ts';
import { parseProgram } from '../src/dsl.ts';

const HOME = `<title>Home</title><h1>Home</h1><a href="/two">Two</a>
<button onclick="alert('hi');console.log('clicked');console.error('boom')">Alert</button>
<button onclick="document.getElementById('o').textContent=String(confirm('sure?'))">Ask</button><span id=o></span>
<a href="/dl">Get file</a>
<div draggable=true style="width:50px;height:30px" id=a>card</div>
<div style="width:90px;height:60px" ondragover="event.preventDefault()" ondrop="this.textContent='landed'">zone</div>
<button ondblclick="this.textContent='doubled'">dbl</button>
<button oncontextmenu="this.textContent='menu';return false">ctx</button>
<script>fetch('/api').catch(()=>{})</script>`;

let server: Server;
let base = '';
let dir = '';
let rt: Awaited<ReturnType<typeof createAgentweb>>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aw-parity-'));
  server = createServer((q, s) => {
    if (q.url === '/dl') {
      s.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=x.bin' });
      return void s.end('hello');
    }
    if (q.url === '/api') {
      s.writeHead(500);
      return void s.end('no');
    }
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end(q.url === '/two' ? '<title>Two</title><h1>Page two</h1>' : HOME);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = await createAgentweb({ store: 'memory:', ghost: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_DOWNLOADS: dir, AGENTWEB_NO_SANDBOX: '1', AGENTWEB_USAGE_LOG: '', AGENTWEB_ATLAS: '0' } });
});

after(async () => {
  await rt.close?.();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const go = (s: string, p: string) => rt.run(s, `open('${base}'); engine('chrome'); ${p}`).then((r) => r.text);

describe('parser', () => {
  it('keeps js code verbatim and maps aliases', () => {
    const [s] = parseProgram(`js('/\\d+/.test("a1")')`);
    assert.equal(s.verb, 'js');
    assert.equal(s.args[0], '/\\d+/.test("a1")');
    assert.equal(parseProgram("dblclick('x')")[0].opts.double, 1);
    assert.equal(parseProgram("rightclick('x')")[0].opts.button, 'right');
    assert.deepEqual(parseProgram('resize(390, 844)')[0].args, [390, 844]);
    assert.equal(parseProgram('pdf()')[0].opts.pdf, 1);
  });
});

describe('chrome parity verbs', { concurrency: false }, () => {
  it('js returns values, handles statements, arrow functions and errors', async () => {
    assert.match(await go('js1', "js('document.title')"), /"Home"/);
    assert.match(await go('js1', "js('({n: document.querySelectorAll(\"button\").length})')"), /\{"n":4\}/);
    assert.match(await go('js1', "js('return 2+3')"), /(^|\n)5\n/);
    assert.match(await go('js1', "js('() => location.pathname')"), /"\/"/);
    assert.match(await go('js1', "js('nosuch.x')"), /the script failed: ReferenceError/);
  });

  it('js is refused in read-only mode', async () => {
    const ro = await createAgentweb({ store: 'memory:', ghost: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_READ_ONLY: '1', AGENTWEB_NO_SANDBOX: '1' } });
    try {
      const r = await ro.run('x', `open('${base}'); engine('chrome'); js('1')`);
      assert.match(r.text, /read-only/);
    } finally {
      await ro.close?.();
    }
  });

  it('console and network show what the page did', async () => {
    const t = await go('log1', "click('Alert'); console(); network(failed=1)");
    assert.match(t, /log: clicked/);
    assert.match(t, /error: boom/);
    assert.match(t, /GET 500 fetch .*\/api/);
    assert.match(await go('log1', "network('api', body=1)"), /\nno/);
  });

  it('downloads are saved and the path is reported', async () => {
    const t = await go('dl1', "click('Get file')");
    const m = /downloaded x\.bin: (\S+) \(5 bytes\)/.exec(t);
    assert.ok(m, t);
    assert.equal(readFileSync(m[1], 'utf8'), 'hello');
    assert.ok(m[1].startsWith(dir));
  });

  it('dialogs can be dismissed instead of accepted', async () => {
    assert.match(await go('dlg1', "click('Ask')"), />?true|Ask.*true/s);
    const t = await go('dlg2', "dialog('dismiss'); click('Ask')");
    assert.match(t, /confirm "sure\?" dismissed/);
    assert.match(t, /false/);
  });

  it('emulate sets device, locale, timezone, geolocation and dark mode, and persists', async () => {
    const t = await go('emu1', "emulate('iPhone 15'); emulate(locale='fr-FR', tz='Europe/Paris', geo='48.85,2.35', dark=1); js('[navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone, matchMedia(\"(prefers-color-scheme: dark)\").matches, /iPhone/.test(navigator.userAgent)]')");
    assert.match(t, /\["fr-FR","Europe\/Paris",true,true\]/);
    const t2 = await rt.run('emu1', "js('devicePixelRatio')").then((r) => r.text);
    assert.match(t2, /(^|\n)3\n/);
    assert.match(await rt.run('emu1', "emulate('reset'); js('/iPhone/.test(navigator.userAgent)')").then((r) => r.text), /false/);
  });

  it('forward follows back, on a live page and on the HTTP tier', async () => {
    assert.match(await go('fw1', "click('Two'); back(); forward()"), /Page two/);
    const r = await rt.run('fw2', `open('${base}'); click('Two'); back(); forward()`);
    assert.match(r.text, /Page two/);
  });

  it('drag, double click and right click reach the page', async () => {
    assert.match(await go('drag1', "drag('card', 'zone'); find('landed')"), /landed/);
    assert.match(await go('drag1', "dblclick('dbl'); find('doubled')"), /doubled/);
    assert.match(await go('drag1', "click('ctx', button='right'); find('menu')"), /menu/);
  });

  it('pdf and screenshots can be kept as files', async () => {
    const t = await go('pdf1', "pdf(); shot(save=1)");
    const pdf = /saved PDF: (\S+\.pdf)/.exec(t);
    assert.ok(pdf, t);
    assert.ok(readFileSync(pdf[1]).subarray(0, 4).toString() === '%PDF');
    const jpg = /saved screenshot: (\S+\.jpg)/.exec(t);
    assert.ok(jpg && existsSync(jpg[1]), t);
  });
});
