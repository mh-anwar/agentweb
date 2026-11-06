// chrome engine: every Action variant, navigation by click, dialogs, popups, stale ids.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeEngine, type ChromeEngine } from '../src/engines/chrome/index.ts';
import { AwError, type Loaded } from '../src/types.ts';
import type { LNode } from '../src/tree.ts';
import { byId, byText, makeCtx, startSite, textOf, type Site } from './chrome.helpers.ts';

let site: Site;
let engine: ChromeEngine;

before(async () => {
  site = await startSite();
  engine = createChromeEngine({ noSandbox: true });
});

after(async () => {
  await engine.close();
  await site.close();
});

const root = (r: Loaded): LNode => r.doc!.root;
const idOf = (r: Loaded, id: string): number => {
  const n = byId(root(r), id);
  assert.ok(n && typeof n.n === 'number', `#${id} has a live node id`);
  return n.n!;
};
const textById = (r: Loaded, id: string): string => textOf(byId(root(r), id) ?? { t: 'x' });

describe('chrome actions', () => {
  const ctx = makeCtx('actions');
  let page: Loaded;

  before(async () => {
    page = await engine.open(ctx, { url: site.base + '/actions' });
  });

  it('click sends real (trusted) mouse events', async () => {
    const r = await engine.act(ctx, { do: 'click', n: idOf(page, 'inc') });
    assert.equal(textById(r, 'out'), 'clicked 1 trusted=true');
    const r2 = await engine.act(ctx, { do: 'click', n: idOf(r, 'inc') });
    assert.equal(textById(r2, 'out'), 'clicked 2 trusted=true');
  });

  it('click falls back to a scripted click when the target is covered, and says so', async () => {
    const r = await engine.act(ctx, { do: 'click', n: idOf(page, 'covered') });
    assert.equal(textById(r, 'out'), 'covered clicked');
    assert.ok(r.events?.some((e) => /covered by div#cover.*scripted click/.test(e)), JSON.stringify(r.events));
  });

  it('fill types into a field and fires the listeners a framework relies on', async () => {
    const r = await engine.act(ctx, { do: 'fill', n: idOf(page, 'name'), value: 'Ada Lovelace' });
    assert.equal(byId(root(r), 'name')?.v, 'Ada Lovelace');
    assert.equal(textById(r, 'mirror'), 'model:Ada Lovelace');
    // a second fill replaces, it does not append
    const r2 = await engine.act(ctx, { do: 'fill', n: idOf(r, 'name'), value: 'Grace' });
    assert.equal(byId(root(r2), 'name')?.v, 'Grace');
    assert.equal(textById(r2, 'mirror'), 'model:Grace');
    // clearing
    const r3 = await engine.act(ctx, { do: 'fill', n: idOf(r, 'name'), value: '' });
    assert.equal(byId(root(r3), 'name')?.v, '');
    // multi-line into a textarea
    const r4 = await engine.act(ctx, { do: 'fill', n: idOf(r, 'ta'), value: 'line one\nline two' });
    assert.equal(byId(root(r4), 'ta')?.v, 'line one\nline two');
  });

  it('select chooses by label, then by value, and lists options when nothing matches', async () => {
    let r = await engine.act(ctx, { do: 'select', n: idOf(page, 'color'), value: 'green' });
    assert.equal(byId(root(r), 'color')?.v, 'g');
    assert.equal(textById(r, 'chosen'), 'chose g');
    r = await engine.act(ctx, { do: 'select', n: idOf(page, 'color'), value: 'b' });
    assert.equal(byId(root(r), 'color')?.v, 'b');
    await assert.rejects(engine.act(ctx, { do: 'select', n: idOf(page, 'color'), value: 'purple' }), (e: AwError) => e.code === 'bad_request' && /Red \| Green \| Blue/.test(e.hint ?? ''));
  });

  it('check sets and clears a checkbox', async () => {
    let r = await engine.act(ctx, { do: 'check', n: idOf(page, 'agree'), on: true });
    assert.equal(byId(root(r), 'agree')?.k, 1);
    assert.equal(textById(r, 'agreed'), 'yes');
    r = await engine.act(ctx, { do: 'check', n: idOf(page, 'agree'), on: true }); // already on: nothing changes
    assert.equal(textById(r, 'agreed'), 'yes');
    r = await engine.act(ctx, { do: 'check', n: idOf(page, 'agree'), on: false });
    assert.equal(byId(root(r), 'agree')?.k, 0);
    assert.equal(textById(r, 'agreed'), 'no');
  });

  it('press sends keys and chords to the focused element', async () => {
    const keys = idOf(page, 'keys');
    await engine.act(ctx, { do: 'press', key: 'a', n: keys });
    await engine.act(ctx, { do: 'press', key: 'Shift+b' });
    await engine.act(ctx, { do: 'press', key: 'Control+a' });
    const r = await engine.act(ctx, { do: 'press', key: 'Enter' });
    assert.equal(textById(r, 'pressed').trim(), 'a S-B C-a Enter');
    assert.equal(byId(root(r), 'keys')?.v, 'aB');
    await assert.rejects(engine.act(ctx, { do: 'press', key: 'Hyper+x' }), (e: AwError) => e.code === 'bad_request');
  });

  it('hover moves the mouse over the element', async () => {
    const r = await engine.act(ctx, { do: 'hover', n: idOf(page, 'hov') });
    assert.equal(textById(r, 'hovered'), 'hovering');
  });

  it('upload puts files into a file input', async () => {
    const r = await engine.act(ctx, {
      do: 'upload',
      n: idOf(page, 'file'),
      files: [
        { name: 'a.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') },
        { name: '../../b.bin', mime: 'application/octet-stream', data: Buffer.from([1, 2, 3]).toString('base64') },
      ],
    });
    assert.equal(textById(r, 'files'), 'a.txt:5,b.bin:3');
  });

  it('scroll to the bottom lets lazy content load and reports it', async () => {
    const r = await engine.act(ctx, { do: 'scroll', to: 'bottom' });
    assert.ok(byId(root(r), 'lazy'), 'lazy paragraph appeared');
    assert.ok(r.events?.some((e) => /more content loaded/.test(e)), JSON.stringify(r.events));
    const r2 = await engine.act(ctx, { do: 'scroll', to: 'top' });
    assert.ok(r2.doc);
  });

  it('shot returns a JPEG of the viewport, the full page, or one element', async () => {
    for (const a of [{ do: 'shot' as const }, { do: 'shot' as const, full: true }, { do: 'shot' as const, n: idOf(page, 'inc') }]) {
      const r = await engine.act(ctx, a);
      assert.equal(r.image?.mime, 'image/jpeg');
      const bytes = Buffer.from(r.image!.data, 'base64');
      assert.equal(bytes[0], 0xff);
      assert.equal(bytes[1], 0xd8);
      assert.ok(r.doc, 'a shot still returns the document');
    }
  });

  it('wait for text, and for a fixed time', async () => {
    const c = makeCtx('waiter');
    await engine.open(c, { url: site.base + '/later' });
    const r = await engine.act(c, { do: 'wait', text: 'ready now' });
    assert.match(textOf(root(r)), /It is ready now/);
    const t0 = Date.now();
    await engine.act(c, { do: 'wait', ms: 300 });
    assert.ok(Date.now() - t0 >= 300);
    await assert.rejects(engine.act(c, { do: 'wait', text: 'never shows up', ms: 400 }), (e: AwError) => e.code === 'timeout');
  });

  it('a removed node id throws AwError(stale); an id from another document too', async () => {
    const c = makeCtx('stale');
    const r = await engine.open(c, { url: site.base + '/remove' });
    const gone = idOf(r, 'gone');
    await engine.act(c, { do: 'click', n: gone });
    await assert.rejects(engine.act(c, { do: 'click', n: gone }), (e: AwError) => e.code === 'stale');
    const stay = idOf(r, 'stay');
    await engine.open(c, { url: site.base + '/remove' }); // a new document: old ids must not resolve
    await assert.rejects(engine.act(c, { do: 'click', n: stay }), (e: AwError) => e.code === 'stale');
    await assert.rejects(engine.act(c, { do: 'fill', n: 123, value: 'x' }), (e: AwError) => e.code === 'stale');
  });

  it('acting on a session without a page is AwError(gone)', async () => {
    await assert.rejects(engine.act(makeCtx('nobody'), { do: 'click', n: 1 }), (e: AwError) => e.code === 'gone');
  });
});

describe('chrome navigation by action', () => {
  it('clicking a link navigates and back returns', async () => {
    const ctx = makeCtx('nav');
    const r = await engine.open(ctx, { url: site.base + '/nav1' });
    const r2 = await engine.act(ctx, { do: 'click', n: idOf(r, 'go') });
    assert.equal(r2.url, site.base + '/nav2');
    assert.match(textOf(root(r2)), /Page two/);
    const r3 = await engine.act(ctx, { do: 'back' });
    assert.equal(r3.url, site.base + '/nav1');
    assert.ok(byId(root(r3), 'go'));
  });

  it('submitting a form by pressing its button posts it', async () => {
    const ctx = makeCtx('form');
    const r = await engine.open(ctx, { url: site.base + '/form' });
    await engine.act(ctx, { do: 'fill', n: idOf(r, 'q'), value: 'hello world' });
    const r2 = await engine.act(ctx, { do: 'click', n: idOf(r, 'send') });
    assert.equal(r2.method, 'POST');
    assert.match(textOf(root(r2)), /POST q=hello\+world/);
  });

  it('a target=_blank link and window.open land in the same page', async () => {
    const ctx = makeCtx('tabs');
    let r = await engine.open(ctx, { url: site.base + '/nav1' });
    r = await engine.act(ctx, { do: 'click', n: idOf(r, 'blank') });
    assert.equal(r.url, site.base + '/nav2?tab=1');
    assert.match(textOf(root(r)), /Page two\?tab=1/);
    r = await engine.open(ctx, { url: site.base + '/nav1' });
    r = await engine.act(ctx, { do: 'click', n: idOf(r, 'pop') });
    assert.equal(r.url, site.base + '/nav2?pop=1');
    assert.ok(r.events?.some((e) => /new tab was opened/.test(e)), JSON.stringify(r.events));
  });

  it('a guard refusal of a clicked link is AwError(policy) and the page stays', async () => {
    const ctx = makeCtx('navguard');
    ctx.guard.deny = (u) => (new URL(u).pathname === '/nav2' ? 'nav2 refused' : undefined);
    const r = await engine.open(ctx, { url: site.base + '/nav1' });
    await assert.rejects(engine.act(ctx, { do: 'click', n: idOf(r, 'go') }), (e: AwError) => e.code === 'policy' && /nav2 refused/.test(e.message));
    const s = await engine.snapshot(ctx);
    assert.equal(s.url, site.base + '/nav1');
  });
});

describe('chrome dialogs and page events', () => {
  const ctx = makeCtx('dialogs');
  let page: Loaded;
  before(async () => {
    page = await engine.open(ctx, { url: site.base + '/dialogs' });
  });

  it('answers alert, confirm and prompt and reports them', async () => {
    let r = await engine.act(ctx, { do: 'click', n: idOf(page, 'a') });
    assert.ok(r.events?.includes('alert "Hi there"'), JSON.stringify(r.events));
    r = await engine.act(ctx, { do: 'click', n: idOf(page, 'c') });
    assert.equal(textById(r, 'r'), 'confirm=true');
    assert.ok(r.events?.some((e) => /confirm "Delete it\?" accepted/.test(e)));
    r = await engine.act(ctx, { do: 'click', n: idOf(page, 'p') });
    assert.equal(textById(r, 'r'), 'prompt=""');
    assert.ok(r.events?.some((e) => /prompt "Your name\?"/.test(e)));
  });

  it('reports uncaught page errors', async () => {
    const r = await engine.act(ctx, { do: 'click', n: idOf(page, 'e') });
    assert.ok(r.events?.some((e) => /page error: .*kaboom/.test(e)), JSON.stringify(r.events));
  });

  it('clicks inside open shadow DOM and same-origin iframes', async () => {
    const c = makeCtx('shadowact');
    const r = await engine.open(c, { url: site.base + '/shadow' });
    let r2 = await engine.act(c, { do: 'click', n: byText(root(r), 'Shadow button')!.n! });
    assert.match(textOf(root(r2)), /shadow clicked/);
    r2 = await engine.act(c, { do: 'click', n: byText(root(r), 'Frame button')!.n! });
    assert.match(textOf(root(r2)), /frame clicked/);
    assert.ok(!r2.events?.some((e) => /scripted click/.test(e)), 'a real click reached the frame');
  });

  it('clicks a cursor:pointer div', async () => {
    const c = makeCtx('card');
    const r = await engine.open(c, { url: site.base + '/hidden' });
    const r2 = await engine.act(c, { do: 'click', n: idOf(r, 'card') });
    assert.equal(textById(r2, 'cardout'), 'card opened');
  });
});
