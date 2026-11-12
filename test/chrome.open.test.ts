// chrome engine: open, settle, extraction, guard, non-HTML documents.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeEngine, type ChromeEngine } from '../src/engines/chrome/index.ts';
import { AwError } from '../src/types.ts';
import { byId, byText, chromePids, makeCtx, nodes, startSite, textOf, type Site } from './chrome.helpers.ts';

let site: Site;
let engine: ChromeEngine;
let pid: number | undefined;

before(async () => {
  site = await startSite();
  engine = createChromeEngine({ noSandbox: true });
});

after(async () => {
  await engine.close();
  await site.close();
  if (pid) assert.ok(!chromePids().includes(pid), 'browser process survived close()');
});

describe('chrome open', () => {
  it('is available on this machine', async () => {
    assert.equal(engine.tier, 'chrome');
    assert.equal(await engine.available(), true);
    assert.equal(await createChromeEngine({ executable: '/nonexistent/chrome' }).available(), false);
  });

  it('opens a trivial page with url, status, method, bytes, ms', async () => {
    const ctx = makeCtx('trivial');
    const r = await engine.open(ctx, { url: site.base + '/' });
    pid = engine.browser()?.pid;
    assert.equal(r.url, site.base + '/');
    assert.equal(r.status, 200);
    assert.equal(r.method, 'GET');
    assert.equal(r.contentType, 'text/html');
    assert.ok(r.bytes > 100, `bytes ${r.bytes}`);
    assert.ok(r.ms > 0);
    assert.ok(r.doc);
    assert.equal(r.doc.meta.title, 'Home');
    assert.equal(r.doc.meta.lang, 'en');
    assert.match(textOf(r.doc.root), /Hello\s*A trivial page/);
    const link = byText(r.doc.root, 'Next page');
    assert.ok(link && link.t === 'a' && typeof link.n === 'number');
    assert.equal(link.a?.href, site.base + '/next');
    assert.ok(engine.live('trivial'));
    assert.ok(!engine.live('nobody'));
  });

  it('waits for a client-rendered page to finish rendering', async () => {
    const r = await engine.open(makeCtx('spa'), { url: site.base + '/spa' });
    const t = textOf(r.doc!.root);
    assert.match(t, /Products/);
    assert.match(t, /Red shoe.*Blue hat.*Green scarf/);
    assert.doesNotMatch(t, /Loading/);
  });

  it('reads open shadow DOM and same-origin iframes', async () => {
    const r = await engine.open(makeCtx('shadow'), { url: site.base + '/shadow' });
    const t = textOf(r.doc!.root);
    assert.match(t, /Shadow text/);
    assert.match(t, /Inside the frame/);
    assert.ok(byText(r.doc!.root, 'Shadow button')?.n);
    assert.ok(byText(r.doc!.root, 'Frame button')?.n);
  });

  it('marks stylesheet-hidden text hidden, sr-only text sr, and cursor:pointer divs clickable', async () => {
    const r = await engine.open(makeCtx('hidden'), { url: site.base + '/hidden' });
    const root = r.doc!.root;
    assert.match(textOf(root), /Visible text/);
    assert.doesNotMatch(textOf(root), /Secret instructions/);
    const gone = [...nodes(root)].find((n) => n.a?.class === 'gone');
    assert.ok(gone && gone.h === 1, 'the .gone paragraph is marked hidden');
    const sr = [...nodes(root)].find((n) => n.a?.class === 'sr');
    assert.ok(sr && sr.sr === 1 && !sr.h, 'the sr-only span is marked sr');
    const card = byId(root, 'card');
    assert.ok(card && card.p === 1 && typeof card.n === 'number', 'the cursor:pointer div is clickable');
  });

  it('settles a page that never goes quiet within the cap and says so', async () => {
    const t0 = Date.now();
    const r = await engine.open(makeCtx('ticker'), { url: site.base + '/ticker' });
    assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
    assert.ok(r.events?.some((e) => /keeps changing/.test(e)), JSON.stringify(r.events));
  });

  it('hands a JSON document over as a body, not a viewer DOM', async () => {
    const r = await engine.open(makeCtx('json'), { url: site.base + '/json' });
    assert.equal(r.contentType, 'application/json');
    assert.equal(r.doc, undefined);
    assert.equal(r.body?.text, '{"ok":true,"n":3}');
  });

  it('refuses a download', async () => {
    await assert.rejects(engine.open(makeCtx('dl'), { url: site.base + '/download' }), (e: AwError) => e.code === 'unsupported' && /download/.test(e.message));
  });

  it('sends a POST navigation and reports the method', async () => {
    const r = await engine.open(makeCtx('post'), { url: site.base + '/echo', method: 'POST', body: 'a=1&b=two', contentType: 'application/x-www-form-urlencoded' });
    assert.equal(r.method, 'POST');
    assert.match(textOf(r.doc!.root), /POST a=1&b=two/);
  });

  it('turns a guard refusal of the navigation into AwError(policy) before anything loads', async () => {
    const ctx = makeCtx('guard1');
    ctx.guard.deny = (u) => (u.includes('/next') ? 'next is off limits' : undefined);
    const before = site.hits.length;
    await assert.rejects(engine.open(ctx, { url: site.base + '/next' }), (e: AwError) => e.code === 'policy' && /off limits/.test(e.message));
    assert.ok(!site.hits.slice(before).includes('/next'), 'the refused URL was never fetched');
  });

  it('asks the guard about every redirect hop and refuses a bad one', async () => {
    const ctx = makeCtx('guard2');
    ctx.guard.deny = (u, why) => (why === 'redirect' && new URL(u).pathname === '/next' ? 'redirect target refused' : undefined);
    const before = site.hits.length;
    await assert.rejects(engine.open(ctx, { url: `${site.base}/redirect?to=/redirect%3Fto%3D/next` }), (e: AwError) => e.code === 'policy' && /redirect target refused/.test(e.message));
    const hops = ctx.guard.seen.filter((s) => s.why === 'redirect').map((s) => new URL(s.url).pathname);
    assert.deepEqual(hops, ['/redirect', '/next']);
    assert.ok(!site.hits.slice(before).includes('/next'), 'the refused hop was never fetched');
    // an allowed redirect lands on its target
    const ok = makeCtx('guard3');
    const r = await engine.open(ok, { url: `${site.base}/redirect?to=/next` });
    assert.equal(r.url, site.base + '/next');
    assert.ok(ok.guard.seen.some((s) => s.why === 'redirect' && s.url.endsWith('/next')));
  });

  it('reports a connection failure as AwError(net)', async () => {
    await assert.rejects(engine.open(makeCtx('net'), { url: 'http://127.0.0.1:1/' }), (e: AwError) => e.code === 'net');
  });

  it('reports pool stats', () => {
    const s = engine.stats();
    assert.ok(s.contexts >= 1);
    assert.equal(s.launches, 1);
    assert.ok(s.rssBytes > 0);
  });
});

it('the session user agent keeps its words but takes the real browser version', async () => {
  const { consistentUa } = await import('../src/engines/chrome/page.ts');
  const real = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36';
  assert.equal(consistentUa('Mozilla/5.0 Chrome/141.0.0.0 Safari/537.36 agentweb/0.1', real), 'Mozilla/5.0 Chrome/158.0.8127.18 Safari/537.36 agentweb/0.1');
  assert.equal(consistentUa(undefined, real), real);
  assert.equal(consistentUa('curl/8', real), 'curl/8');
});
