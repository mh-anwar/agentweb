// Real framework apps (React 19, Vue 3, Preact) bundled with esbuild and driven through the
// ghost engine. Everything is asserted through extractPage output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGhostEngine } from '../src/engines/ghost/index.ts';
import type { Engine, Loaded, SessionCtx } from '../src/types.ts';
import { serve, html, makeCtx, textOf, byId, byTag, findNode, squash, bundle, json } from './ghost.helpers.ts';

const APPS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/ghost/apps');
let srv: Awaited<ReturnType<typeof serve>>;
let eng: Engine;
const timings: Record<string, number> = {};

before(async () => {
  const react = await bundle(path.join(APPS, 'react-app.jsx'), { format: 'iife' });
  const vue = await bundle(path.join(APPS, 'vue-app.js'), { format: 'esm', alias: { vue: 'vue/dist/vue.esm-bundler.js' } });
  const preact = await bundle(path.join(APPS, 'preact-app.jsx'), { format: 'esm', splitting: true });
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(react)) files['/react-assets/' + k] = v;
  for (const [k, v] of Object.entries(vue)) files['/vue-assets/' + k] = v;
  for (const [k, v] of Object.entries(preact)) files['/preact-assets/' + k] = v;
  const reactPage = html('<div id="root"></div><script src="/react-assets/main.js"></script>', '<title>React fixture</title>');
  srv = await serve({
    ...files,
    '/react/': reactPage,
    '/react/about': reactPage,
    '/api/items': json({ items: [{ id: 1, name: 'Widget', price: 9 }, { id: 2, name: 'Gadget', price: 25 }] }),
    '/vue/': html('<div id="app"></div><script type="module" src="/vue-assets/main.js"></script>', '<title>Vue fixture</title>'),
    '/api/todos': json({ todos: [{ id: 1, text: 'Buy milk', done: false }, { id: 2, text: 'Walk dog', done: true }, { id: 3, text: 'Write tests', done: false }] }),
    '/preact/': html('<div id="app"></div><script type="module">import("/preact-assets/main.js")</script>', '<title>Preact fixture</title>'),
  });
  eng = createGhostEngine({});
});

after(async () => {
  await eng?.close();
  await srv?.close();
  console.log('ghost app timings (ms):', JSON.stringify(timings));
});

const nodeId = (l: Loaded, pred: Parameters<typeof findNode>[1]) => {
  const n = findNode(l.doc!.root, pred);
  assert.ok(n && n.n, 'target node not found in the extracted page');
  return n.n!;
};
const inputNamed = (l: Loaded, name: string) => nodeId(l, (n) => (n.t === 'input' || n.t === 'select') && n.a?.name === name);
const buttonText = (l: Loaded, t: string) => nodeId(l, (n) => n.t === 'button' && textOf(n).includes(t));
const linkText = (l: Loaded, t: string) => nodeId(l, (n) => n.t === 'a' && textOf(n).includes(t));

test('React: effect fetch, state, controlled form, hover, pushState routing and back', async () => {
  const ctx: SessionCtx = makeCtx();
  const t0 = performance.now();
  let l = await eng.open(ctx, { url: srv.url + '/react/' });
  timings.react = Math.round(performance.now() - t0);
  assert.equal(l.status, 200);
  assert.equal(l.escalate, undefined);
  assert.equal(l.doc!.meta.title, 'React fixture');
  assert.match(squash(textOf(byId(l.doc!.root, 'items'))), /Widget — \$9.*Gadget — \$25/);

  l = await eng.act!(ctx, { do: 'click', n: buttonText(l, 'Increment') });
  l = await eng.act!(ctx, { do: 'click', n: buttonText(l, 'Increment') });
  assert.equal(textOf(byId(l.doc!.root, 'count')), 'Count: 2');

  l = await eng.act!(ctx, { do: 'fill', n: inputNamed(l, 'name'), value: 'Ada' });
  assert.equal(textOf(byId(l.doc!.root, 'echo')), 'typed: Ada');
  assert.equal(findNode(l.doc!.root, (n) => n.a?.name === 'name')!.v, 'Ada');
  l = await eng.act!(ctx, { do: 'check', n: inputNamed(l, 'agree'), on: true });
  assert.equal(findNode(l.doc!.root, (n) => n.a?.name === 'agree')!.k, 1);
  l = await eng.act!(ctx, { do: 'select', n: inputNamed(l, 'plan'), value: 'Pro' });
  l = await eng.act!(ctx, { do: 'click', n: buttonText(l, 'Greet') });
  assert.equal(textOf(byId(l.doc!.root, 'greeting')), 'Hello, Ada! plan=pro agree=true');
  assert.equal(l.url, srv.url + '/react/', 'onSubmit preventDefault keeps the page');

  l = await eng.act!(ctx, { do: 'hover', n: nodeId(l, (n) => n.a?.id === 'hover') });
  assert.equal(textOf(byId(l.doc!.root, 'hover')), 'hovering');

  l = await eng.act!(ctx, { do: 'click', n: linkText(l, 'About') });
  assert.equal(l.url, srv.url + '/react/about');
  assert.ok(byTag(l.doc!.root, 'h1', 'About this app'));
  assert.match(textOf(l.doc!.root), /path is \/react\/about/);

  l = await eng.act!(ctx, { do: 'back' });
  assert.equal(l.url, srv.url + '/react/');
  assert.ok(byTag(l.doc!.root, 'h1', 'React fixture'));
});

test('React: press Enter in a controlled input submits its form', async () => {
  const ctx = makeCtx();
  let l = await eng.open(ctx, { url: srv.url + '/react/' });
  l = await eng.act!(ctx, { do: 'fill', n: inputNamed(l, 'name'), value: 'Grace' });
  l = await eng.act!(ctx, { do: 'press', key: 'Enter', n: inputNamed(l, 'name') });
  assert.equal(textOf(byId(l.doc!.root, 'greeting')), 'Hello, Grace! plan=free agree=false');
});

test('Vue 3 (ES module, runtime template compiler): fetch, v-model checkbox, form', async () => {
  const ctx = makeCtx();
  const t0 = performance.now();
  let l = await eng.open(ctx, { url: srv.url + '/vue/' });
  timings.vue = Math.round(performance.now() - t0);
  assert.equal(l.escalate, undefined, String(l.escalate));
  assert.equal(textOf(byId(l.doc!.root, 'remaining')), '2 of 3 remaining');
  const box = nodeId(l, (n) => n.t === 'input' && n.a?.type === 'checkbox');
  l = await eng.act!(ctx, { do: 'check', n: box, on: true });
  assert.equal(textOf(byId(l.doc!.root, 'remaining')), '1 of 3 remaining');
  l = await eng.act!(ctx, { do: 'fill', n: inputNamed(l, 'draft'), value: 'Ship it' });
  l = await eng.act!(ctx, { do: 'press', key: 'Enter' });
  assert.equal(textOf(byId(l.doc!.root, 'remaining')), '2 of 4 remaining');
  assert.match(textOf(l.doc!.root), /Ship it/);
  assert.equal(findNode(l.doc!.root, (n) => n.a?.name === 'draft')!.v ?? '', '');
});

test('Preact (dynamic import of a split ESM bundle): timers on virtual time, onInput filter', async () => {
  const ctx = makeCtx();
  const t0 = performance.now();
  let l = await eng.open(ctx, { url: srv.url + '/preact/' });
  timings.preact = Math.round(performance.now() - t0);
  assert.equal(l.escalate, undefined, String(l.escalate));
  assert.equal(textOf(byId(l.doc!.root, 'tick')), 'timer fired');
  l = await eng.act!(ctx, { do: 'click', n: buttonText(l, 'Click me') });
  assert.equal(textOf(byId(l.doc!.root, 'n')), 'Clicked 1 times');
  l = await eng.act!(ctx, { do: 'fill', n: inputNamed(l, 'q'), value: 'an' });
  assert.equal(findNode(l.doc!.root, (n) => n.a?.name === 'q')!.v, 'an');
  const items = [...(byTag(l.doc!.root, 'ul')!.c || [])].map(textOf).filter(Boolean);
  assert.deepEqual(items, ['banana']);
});
