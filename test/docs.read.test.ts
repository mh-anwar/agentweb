// Cheap doc reading: read(url, outline=1), outline() with section sizes, read('llms') and the llms.txt note.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentweb, type Runtime } from '../src/index.ts';

let withLlms: Server;
let without: Server;
let soft: Server;
let a = '';
let b = '';
let c = '';
let rt: Runtime;
let noAtlas: Runtime;
const hits: string[] = [];

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const guide = `<!doctype html><html><head><title>Guide</title></head><body><nav><a href="/">Home</a></nav><main>
<p>Intro text before any heading ${words(10)}</p>
<h1>Getting started</h1><p>${words(40)}</p>
<h2>Install</h2><p>${words(120)}</p>
<h2>Configure</h2><p>${words(300)}</p><h3>Advanced options</h3><p>${words(200)}</p>
<h1>Reference</h1><p>${words(900)}</p>
</main></body></html>`;

before(async () => {
  withLlms = createServer((req, res) => {
    hits.push('A ' + req.url);
    if (req.url === '/llms.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('# Example docs\n\n- [Guide](/docs/guide): how to start\n- [Reference](/docs/ref): all options\n');
    if (req.url === '/llms-full.txt') return void res.writeHead(200, { 'content-type': 'text/markdown' }).end('# Example docs, in full\n\nEverything in one file.\n');
    res.writeHead(200, { 'content-type': 'text/html' }).end(guide);
  });
  without = createServer((req, res) => {
    hits.push('B ' + req.url);
    if (req.url === '/llms.txt' || req.url === '/llms-full.txt') return void res.writeHead(404, { 'content-type': 'text/plain' }).end('no');
    res.writeHead(200, { 'content-type': 'text/html' }).end(guide);
  });
  soft = createServer((req, res) => {
    hits.push('C ' + req.url);
    res.writeHead(200, { 'content-type': 'text/html' }).end(guide); // an HTML page for every path, llms.txt included
  });
  const set = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
  [a, b, c] = await Promise.all([set(withLlms), set(without), set(soft)]);
  const env = { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_USAGE_LOG: '' };
  rt = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: true, cache: false, env });
  noAtlas = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, cache: false, env });
});

after(async () => {
  await rt.close();
  await noAtlas.close();
  for (const s of [withLlms, without, soft]) await new Promise<void>((r) => s.close(() => r()));
});

let n = 0;
const sid = () => `d${++n}`;

describe('outline with sizes', () => {
  it("read(url, outline=1) prints headings with section sizes and does not read the page", async () => {
    const r = await rt.run(sid(), `read('${b}/docs/guide', outline=1)`, { budget: 1500 });
    assert.ok(r.ok, r.text);
    const lines = r.text.split('\n');
    assert.match(lines[0], /^Guide — http:\/\/127\.0\.0\.1:\d+\/docs\/guide$/);
    assert.match(lines[1], /tokens in all, .* before the first heading; read\('Heading'\) reads one section/);
    const section = (name: string) => {
      const l = lines.find((x) => x.trim().startsWith(name));
      assert.ok(l, `${name} in ${r.text}`);
      return { indent: l.length - l.trimStart().length, tok: l.match(/\((\d+(?:\.\d)?k?) tok\)/)![1] };
    };
    const num = (s: string) => (s.endsWith('k') ? parseFloat(s) * 1000 : Number(s));
    const start = section('Getting started');
    const install = section('Install');
    const adv = section('Advanced options');
    const ref = section('Reference');
    assert.equal(start.indent, 0);
    assert.equal(install.indent, 2);
    assert.equal(adv.indent, 4);
    assert.ok(num(ref.tok) > num(start.tok), 'Reference is the long one'); // 900 words vs 40+120+300+200
    assert.ok(num(start.tok) > num(install.tok) + num(adv.tok), 'a section includes its subsections');
    assert.doesNotMatch(r.text, /word10\b/); // no body text
  });

  it('read(outline=1) and outline() work on the open page; read(\'Heading\') then reads the section', async () => {
    const s = sid();
    const r = await rt.run(s, `open('${b}/docs/guide'); outline()`, { budget: 1500 });
    assert.match(r.text, /Install \(\d+ tok\)/);
    const same = await rt.run(s, 'read(outline=1)', { budget: 1500 });
    assert.match(same.text, /Install \(\d+ tok\)/);
    const sec = await rt.run(s, "read('Install')", { budget: 1500 });
    assert.ok(sec.ok, sec.text);
    assert.match(sec.text, /word0 word1/);
    assert.doesNotMatch(sec.text, /Reference/);
  });

  it('a page with no headings says how big it is; a text label with outline=1 is refused with a hint', async () => {
    const s = sid();
    const plain = await rt.run(s, `open('${b}/docs/guide'); read('Install', outline=1)`);
    assert.equal(plain.ok, false);
    assert.match(plain.text, /outline=1 goes with an address or nothing/);
  });

  it('the outline fits the budget by dropping the deepest headings first', async () => {
    const r = await rt.run(sid(), `read('${b}/docs/guide', outline=1)`, { budget: 200 });
    assert.ok(r.ok, r.text);
    assert.ok(r.stats.tokens <= 260, `used ${r.stats.tokens}`);
  });
});

describe('llms.txt', () => {
  it("a docs page on a site with /llms.txt gets one note; the site is probed once, and told once per session", async () => {
    hits.length = 0;
    const s = sid();
    const r = await rt.run(s, `open('${a}/docs/guide')`);
    assert.ok(r.ok, r.text);
    assert.match(r.text, /note: this site publishes \/llms\.txt and \/llms-full\.txt .*read\('llms'\) opens it, read\('llms-full'\)/);
    assert.deepEqual(hits.filter((h) => h.includes('llms')).sort(), ['A /llms-full.txt', 'A /llms.txt']);
    // second page of the same session: no second note, no second probe
    hits.length = 0;
    const again = await rt.run(s, `open('${a}/docs/guide?x=2')`);
    assert.doesNotMatch(again.text, /llms/);
    assert.deepEqual(hits.filter((h) => h.includes('llms')), []);
    // another session: told again, still no probe (learned per origin)
    const other = await rt.run(sid(), `read('${a}/docs/guide')`);
    assert.match(other.text, /note: this site publishes \/llms\.txt/);
    assert.deepEqual(hits.filter((h) => h.includes('llms')), []);
  });

  it("read('llms') opens it; read('llms-full') the full one", async () => {
    const s = sid();
    const r = await rt.run(s, `open('${a}/docs/guide'); read('llms')`);
    assert.ok(r.ok, r.text);
    assert.match(r.text, /Example docs/);
    assert.match(r.text, /how to start/);
    const full = await rt.run(s, "read('llms-full')");
    assert.match(full.text, /in full/);
    const nope = await rt.run(sid(), "read('llms')");
    assert.equal(nope.ok, false);
    assert.match(nope.text, /needs a site/);
  });

  it('no note when the site has none: 404, or an HTML page answering every path', async () => {
    for (const site of [b, c]) {
      const r = await rt.run(sid(), `open('${site}/docs/guide')`);
      assert.ok(r.ok, r.text);
      assert.doesNotMatch(r.text, /llms/);
    }
    const miss = await rt.run(sid(), `open('${b}/docs/guide'); read('llms')`);
    assert.equal(miss.ok, false);
    assert.match(miss.text, /has no \/llms\.txt/);
    // and the miss is remembered: no probe for a site that said no
  });

  it('only documentation pages are probed, and not at all with the atlas off', async () => {
    hits.length = 0;
    await rt.run(sid(), `open('${a}/shop/item')`);
    assert.deepEqual(hits.filter((h) => h.includes('llms')), [], 'a shop page is not a docs page');
    await noAtlas.run(sid(), `open('${a}/docs/other')`);
    assert.deepEqual(hits.filter((h) => h.includes('llms')), [], 'learning is off');
  });

  it('a heading called "LLMs" on the page wins over the keyword', async () => {
    const own = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>t</title><main><h1>LLMs</h1><p>about language models</p><h1>Other</h1><p>x</p></main>'));
    await new Promise<void>((r) => own.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(own.address() as AddressInfo).port}`;
      const r = await rt.run(sid(), `open('${url}/docs/x'); read('LLMs')`);
      assert.ok(r.ok, r.text);
      assert.match(r.text, /language models/);
    } finally {
      await new Promise<void>((r) => own.close(() => r()));
    }
  });
});
