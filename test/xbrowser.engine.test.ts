// Firefox and WebKit engines (Playwright-driven): the essential chrome engine tests, run against
// each browser that is installed. A browser that is not installed is skipped, not failed.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { browserPath, createPlaywrightEngine, pwKey, RESTORED, type BrowserName, type PlaywrightEngine } from '../src/engines/playwright/index.ts';
import { parseChord } from '../src/engines/chrome/keys.ts';
import { AwError, type Loaded } from '../src/types.ts';
import type { LNode } from '../src/tree.ts';
import { byId, byText, makeCtx, nodes, startSite, textOf, type Site } from './chrome.helpers.ts';

const root = (r: Loaded): LNode => r.doc!.root;
const idOf = (r: Loaded, id: string): number => {
  const n = byId(root(r), id);
  assert.ok(n && typeof n.n === 'number', `#${id} has a live node id`);
  return n.n!;
};
const textById = (r: Loaded, id: string): string => textOf(byId(root(r), id) ?? { t: 'x' });

describe('playwright key names', () => {
  it('maps chords to Playwright key strings', () => {
    assert.equal(pwKey(parseChord('Enter')), 'Enter');
    assert.equal(pwKey(parseChord('ctrl+a')), 'Control+a');
    assert.equal(pwKey(parseChord('Shift+b')), 'Shift+B');
    assert.equal(pwKey(parseChord('space')), 'Space');
    assert.equal(pwKey(parseChord('A')), 'Shift+A');
  });
});

for (const name of ['firefox', 'webkit'] as BrowserName[]) {
  const installed = await browserPath(name);
  const skip = installed ? false : `${name} is not installed (npx playwright-core install ${name})`;

  describe(`${name} engine`, { skip }, () => {
    let site: Site;
    let engine: PlaywrightEngine;
    const ctxs: string[] = [];
    const ctx = (id: string, over = {}) => {
      ctxs.push(id);
      return makeCtx(`${name}-${id}`, over);
    };

    before(async () => {
      site = await startSite();
      engine = createPlaywrightEngine({ browser: name });
    });

    after(async () => {
      await engine?.close();
      await site?.close();
    });

    describe('open', () => {
      it('is available, and not with a missing binary', async () => {
        assert.equal(engine.tier, name);
        assert.equal(await engine.available(), true);
        assert.equal(await createPlaywrightEngine({ browser: name, executable: '/nonexistent/browser' }).available(), false);
      });

      it('opens a page with url, status, method, title and live ids', async () => {
        const c = ctx('trivial');
        const r = await engine.open(c, { url: site.base + '/' });
        assert.equal(r.url, site.base + '/');
        assert.equal(r.status, 200);
        assert.equal(r.method, 'GET');
        assert.equal(r.contentType, 'text/html');
        assert.ok(r.doc);
        assert.equal(r.doc.meta.title, 'Home');
        assert.match(textOf(r.doc.root), /Hello\s*A trivial page/);
        const link = byText(r.doc.root, 'Next page');
        assert.ok(link && link.t === 'a' && typeof link.n === 'number');
        assert.equal(link.a?.href, site.base + '/next');
        assert.ok(engine.live(c.id));
        assert.ok(!engine.live('nobody'));
        assert.ok(engine.version());
      });

      it('waits for a client-rendered page', async () => {
        const r = await engine.open(ctx('spa'), { url: site.base + '/spa' });
        const t = textOf(r.doc!.root);
        assert.match(t, /Red shoe.*Blue hat.*Green scarf/);
        assert.doesNotMatch(t, /Loading/);
      });

      it('reads open shadow DOM and same-origin iframes', async () => {
        const r = await engine.open(ctx('shadow'), { url: site.base + '/shadow' });
        const t = textOf(r.doc!.root);
        assert.match(t, /Shadow text/);
        assert.match(t, /Inside the frame/);
        assert.ok(byText(r.doc!.root, 'Shadow button')?.n);
      });

      it('marks hidden, sr-only and cursor:pointer elements like chrome does', async () => {
        const r = await engine.open(ctx('hidden'), { url: site.base + '/hidden' });
        const rt = r.doc!.root;
        assert.doesNotMatch(textOf(rt), /Secret instructions/);
        const sr = [...nodes(rt)].find((n) => n.a?.class === 'sr');
        assert.ok(sr && sr.sr === 1 && !sr.h, 'the sr-only span is marked sr');
        const card = byId(rt, 'card');
        assert.ok(card && card.p === 1 && typeof card.n === 'number', 'the cursor:pointer div is clickable');
      });

      it('settles a page that never goes quiet and says so', async () => {
        const t0 = Date.now();
        const r = await engine.open(ctx('ticker'), { url: site.base + '/ticker' });
        assert.ok(Date.now() - t0 < 8000, `took ${Date.now() - t0} ms`);
        assert.ok(r.events?.some((e) => /keeps changing/.test(e)), JSON.stringify(r.events));
      });

      it('hands a JSON document over as a body', async () => {
        const r = await engine.open(ctx('json'), { url: site.base + '/json' });
        assert.equal(r.contentType, 'application/json');
        assert.equal(r.doc, undefined);
        assert.equal(r.body?.text, '{"ok":true,"n":3}');
      });

      it('refuses a download', async () => {
        await assert.rejects(engine.open(ctx('dl'), { url: site.base + '/download' }), (e: AwError) => e.code === 'unsupported' && /download/.test(e.message));
      });

      it('sends a POST navigation and reports the method', async () => {
        const r = await engine.open(ctx('post'), { url: site.base + '/echo', method: 'POST', body: 'a=1&b=two', contentType: 'application/x-www-form-urlencoded' });
        assert.equal(r.method, 'POST');
        assert.match(textOf(r.doc!.root), /POST a=1&b=two/);
      });

      it('a guard refusal of the navigation is AwError(policy) before anything loads', async () => {
        const c = ctx('guard1');
        c.guard.deny = (u) => (u.includes('/next') ? 'next is off limits' : undefined);
        const before = site.hits.length;
        await assert.rejects(engine.open(c, { url: site.base + '/next' }), (e: AwError) => e.code === 'policy' && /off limits/.test(e.message));
        assert.ok(!site.hits.slice(before).includes('/next'));
      });

      it('asks the guard about redirect hops and refuses a bad one', async () => {
        const c = ctx('guard2');
        c.guard.deny = (u, why) => (why === 'redirect' && new URL(u).pathname === '/next' ? 'redirect target refused' : undefined);
        await assert.rejects(engine.open(c, { url: `${site.base}/redirect?to=/next` }), (e: AwError) => e.code === 'policy' && /redirect target refused/.test(e.message));
        assert.equal(engine.live(c.id), false, 'a page that followed a refused hop is not kept');
        const ok = ctx('guard3');
        const r = await engine.open(ok, { url: `${site.base}/redirect?to=/next` });
        assert.equal(r.url, site.base + '/next');
        assert.ok(ok.guard.seen.some((s) => s.why === 'redirect' && s.url.endsWith('/next')));
      });

      it('reports a connection failure as AwError(net)', async () => {
        await assert.rejects(engine.open(ctx('net'), { url: 'http://127.0.0.1:1/' }), (e: AwError) => e.code === 'net');
      });
    });

    describe('actions', () => {
      let c: ReturnType<typeof makeCtx>;
      let page: Loaded;
      before(async () => {
        c = ctx('actions');
        page = await engine.open(c, { url: site.base + '/actions' });
      });

      it('click sends trusted mouse events', async () => {
        const r = await engine.act(c, { do: 'click', n: idOf(page, 'inc') });
        assert.equal(textById(r, 'out'), 'clicked 1 trusted=true');
      });

      it('click falls back to a scripted click when covered, and says so', async () => {
        const r = await engine.act(c, { do: 'click', n: idOf(page, 'covered') });
        assert.equal(textById(r, 'out'), 'covered clicked');
        assert.ok(r.events?.some((e) => /covered by div#cover.*scripted click/.test(e)), JSON.stringify(r.events));
      });

      it('fill types, replaces, clears, and handles multi-line', async () => {
        let r = await engine.act(c, { do: 'fill', n: idOf(page, 'name'), value: 'Ada Lovelace' });
        assert.equal(byId(root(r), 'name')?.v, 'Ada Lovelace');
        assert.equal(textById(r, 'mirror'), 'model:Ada Lovelace');
        r = await engine.act(c, { do: 'fill', n: idOf(r, 'name'), value: 'Grace' });
        assert.equal(byId(root(r), 'name')?.v, 'Grace');
        r = await engine.act(c, { do: 'fill', n: idOf(r, 'name'), value: '' });
        assert.equal(byId(root(r), 'name')?.v, '');
        r = await engine.act(c, { do: 'fill', n: idOf(r, 'ta'), value: 'line one\nline two' });
        assert.equal(byId(root(r), 'ta')?.v, 'line one\nline two');
      });

      it('select chooses by label and by value', async () => {
        let r = await engine.act(c, { do: 'select', n: idOf(page, 'color'), value: 'green' });
        assert.equal(byId(root(r), 'color')?.v, 'g');
        assert.equal(textById(r, 'chosen'), 'chose g');
        r = await engine.act(c, { do: 'select', n: idOf(page, 'color'), value: 'b' });
        assert.equal(byId(root(r), 'color')?.v, 'b');
      });

      it('check sets and clears a checkbox', async () => {
        let r = await engine.act(c, { do: 'check', n: idOf(page, 'agree'), on: true });
        assert.equal(textById(r, 'agreed'), 'yes');
        r = await engine.act(c, { do: 'check', n: idOf(page, 'agree'), on: false });
        assert.equal(textById(r, 'agreed'), 'no');
      });

      it('press sends keys and chords', async () => {
        await engine.act(c, { do: 'press', key: 'a', n: idOf(page, 'keys') });
        await engine.act(c, { do: 'press', key: 'Shift+b' });
        const r = await engine.act(c, { do: 'press', key: 'Enter' });
        assert.equal(textById(r, 'pressed').trim(), 'a S-B Enter');
        assert.equal(byId(root(r), 'keys')?.v, 'aB');
        await assert.rejects(engine.act(c, { do: 'press', key: 'Hyper+x' }), (e: AwError) => e.code === 'bad_request');
      });

      it('hover moves the mouse over the element', async () => {
        const r = await engine.act(c, { do: 'hover', n: idOf(page, 'hov') });
        assert.equal(textById(r, 'hovered'), 'hovering');
      });

      it('upload puts files into a file input', async () => {
        const r = await engine.act(c, {
          do: 'upload',
          n: idOf(page, 'file'),
          files: [
            { name: 'a.txt', mime: 'text/plain', data: Buffer.from('hello').toString('base64') },
            { name: '../../b.bin', mime: 'application/octet-stream', data: Buffer.from([1, 2, 3]).toString('base64') },
          ],
        });
        assert.equal(textById(r, 'files'), 'a.txt:5,b.bin:3');
      });

      it('scroll to the bottom lets lazy content load', async () => {
        const r = await engine.act(c, { do: 'scroll', to: 'bottom' });
        assert.ok(byId(root(r), 'lazy'), 'lazy paragraph appeared');
        assert.ok(r.events?.some((e) => /more content loaded/.test(e)), JSON.stringify(r.events));
      });

      it('shot returns a JPEG of the viewport, the full page, or one element', async () => {
        for (const a of [{ do: 'shot' as const }, { do: 'shot' as const, full: true }, { do: 'shot' as const, n: idOf(page, 'inc') }]) {
          const r = await engine.act(c, a);
          assert.equal(r.image?.mime, 'image/jpeg');
          const bytes = Buffer.from(r.image!.data, 'base64');
          assert.equal(bytes[0], 0xff);
          assert.equal(bytes[1], 0xd8);
          assert.ok(r.doc);
        }
      });

      it('wait for text, and for a fixed time', async () => {
        const w = ctx('waiter');
        await engine.open(w, { url: site.base + '/later' });
        const r = await engine.act(w, { do: 'wait', text: 'ready now' });
        assert.match(textOf(root(r)), /It is ready now/);
        await assert.rejects(engine.act(w, { do: 'wait', text: 'never shows up', ms: 400 }), (e: AwError) => e.code === 'timeout');
      });

      it('a removed node, or one from another document, is AwError(stale)', async () => {
        const s = ctx('stale');
        const r = await engine.open(s, { url: site.base + '/remove' });
        const gone = idOf(r, 'gone');
        await engine.act(s, { do: 'click', n: gone });
        await assert.rejects(engine.act(s, { do: 'click', n: gone }), (e: AwError) => e.code === 'stale');
        const stay = idOf(r, 'stay');
        await engine.open(s, { url: site.base + '/remove' });
        await assert.rejects(engine.act(s, { do: 'click', n: stay }), (e: AwError) => e.code === 'stale');
      });

      it('acting on a session without a page is AwError(gone)', async () => {
        await assert.rejects(engine.act(makeCtx(`${name}-nobody`), { do: 'click', n: 1 }), (e: AwError) => e.code === 'gone');
      });
    });

    describe('navigation and page events', () => {
      it('clicking a link navigates and back returns', async () => {
        const c = ctx('nav');
        const r = await engine.open(c, { url: site.base + '/nav1' });
        const r2 = await engine.act(c, { do: 'click', n: idOf(r, 'go') });
        assert.equal(r2.url, site.base + '/nav2');
        const r3 = await engine.act(c, { do: 'back' });
        assert.equal(r3.url, site.base + '/nav1');
        assert.ok(byId(root(r3), 'go'));
        // the first page of the tab has nothing before it
        const first = ctx('nav-first');
        await engine.open(first, { url: site.base + '/nav1' });
        await assert.rejects(engine.act(first, { do: 'back' }), (e: AwError) => e.code === 'bad_request');
      });

      it('pressing a form button posts it', async () => {
        const c = ctx('form');
        const r = await engine.open(c, { url: site.base + '/form' });
        await engine.act(c, { do: 'fill', n: idOf(r, 'q'), value: 'hello world' });
        const r2 = await engine.act(c, { do: 'click', n: idOf(r, 'send') });
        assert.equal(r2.method, 'POST');
        assert.match(textOf(root(r2)), /POST q=hello\+world/);
      });

      it('a target=_blank link and window.open land in the same page', async () => {
        const c = ctx('tabs');
        let r = await engine.open(c, { url: site.base + '/nav1' });
        r = await engine.act(c, { do: 'click', n: idOf(r, 'blank') });
        assert.equal(r.url, site.base + '/nav2?tab=1');
        r = await engine.open(c, { url: site.base + '/nav1' });
        r = await engine.act(c, { do: 'click', n: idOf(r, 'pop') });
        assert.equal(r.url, site.base + '/nav2?pop=1');
        assert.ok(r.events?.some((e) => /new tab was opened/.test(e)), JSON.stringify(r.events));
      });

      it('a guard refusal of a clicked link is AwError(policy) and the page stays', async () => {
        const c = ctx('navguard');
        c.guard.deny = (u) => (new URL(u).pathname === '/nav2' ? 'nav2 refused' : undefined);
        const r = await engine.open(c, { url: site.base + '/nav1' });
        await assert.rejects(engine.act(c, { do: 'click', n: idOf(r, 'go') }), (e: AwError) => e.code === 'policy' && /nav2 refused/.test(e.message));
        const s = await engine.snapshot(c);
        assert.equal(s.url, site.base + '/nav1');
      });

      it('answers alert, confirm and prompt, and reports page errors', async () => {
        const c = ctx('dialogs');
        const page = await engine.open(c, { url: site.base + '/dialogs' });
        let r = await engine.act(c, { do: 'click', n: idOf(page, 'a') });
        assert.ok(r.events?.includes('alert "Hi there"'), JSON.stringify(r.events));
        r = await engine.act(c, { do: 'click', n: idOf(page, 'c') });
        assert.equal(textById(r, 'r'), 'confirm=true');
        r = await engine.act(c, { do: 'click', n: idOf(page, 'p') });
        assert.equal(textById(r, 'r'), 'prompt=""');
        r = await engine.act(c, { do: 'click', n: idOf(page, 'e') });
        assert.ok(r.events?.some((e) => /page error: .*kaboom/.test(e)), JSON.stringify(r.events));
      });

      it('clicks inside open shadow DOM and same-origin iframes', async () => {
        const c = ctx('shadowact');
        const r = await engine.open(c, { url: site.base + '/shadow' });
        let r2 = await engine.act(c, { do: 'click', n: byText(root(r), 'Shadow button')!.n! });
        assert.match(textOf(root(r2)), /shadow clicked/);
        r2 = await engine.act(c, { do: 'click', n: byText(root(r), 'Frame button')!.n! });
        assert.match(textOf(root(r2)), /frame clicked/);
      });
    });

    describe('session state', () => {
      const host = () => new URL(site.base).hostname;

      it('round-trips cookies jar -> browser -> jar, including httpOnly, script-set and deleted ones', async () => {
        const c = ctx('cookies');
        c.jar.set({ name: 'sid', value: 'alice-token', domain: host(), path: '/', hostOnly: true });
        let r = await engine.open(c, { url: site.base + '/me' });
        assert.equal(textById(r, 'who'), 'Signed in as alice-token');
        r = await engine.open(c, { url: site.base + '/login?u=bob' });
        assert.equal(r.url, site.base + '/me');
        assert.equal(textById(r, 'who'), 'Signed in as bob-token');
        const sid = c.jar.get('sid');
        assert.equal(sid?.value, 'bob-token');
        assert.equal(sid?.httpOnly, true);
        r = await engine.act(c, { do: 'click', n: idOf(r, 'jscookie') });
        assert.equal(c.jar.get('js')?.value, '1');
        await engine.open(c, { url: site.base + '/logout' });
        assert.equal(c.jar.get('sid'), undefined);
        c.jar.set({ name: 'sid', value: 'carol-token', domain: host(), path: '/', hostOnly: true });
        r = await engine.open(c, { url: site.base + '/me' });
        assert.equal(textById(r, 'who'), 'Signed in as carol-token');
        c.jar.clear();
        r = await engine.open(c, { url: site.base + '/me' });
        assert.equal(textById(r, 'who'), 'Signed out');
      });

      it('keeps sessions isolated', async () => {
        const a = ctx('iso-a');
        const b = ctx('iso-b');
        await engine.open(a, { url: site.base + '/login?u=ann' });
        const rb = await engine.open(b, { url: site.base + '/me' });
        assert.equal(textById(rb, 'who'), 'Signed out');
      });

      it('a released session comes back with its cookies and localStorage', async () => {
        const a = ctx('evict');
        let r = await engine.open(a, { url: site.base + '/login?u=dora' });
        r = await engine.act(a, { do: 'click', n: idOf(r, 'setls') });
        assert.equal(textById(r, 'ls'), 'theme=dark');
        assert.deepEqual(a.storage[new URL(site.base).origin], { theme: 'dark' });
        a.url = r.url;
        await engine.release(a.id);
        assert.equal(engine.live(a.id), false);
        r = await engine.snapshot(a);
        assert.ok(r.events?.includes(RESTORED), JSON.stringify(r.events));
        assert.equal(textById(r, 'who'), 'Signed in as dora-token');
        assert.equal(textById(r, 'ls'), 'theme=dark', 'localStorage was in place before the page script ran');
      });

      it('evicts the least recently used context past the limit, and closes idle ones', async () => {
        const e = createPlaywrightEngine({ browser: name, maxContexts: 1, idleMs: 400, browserIdleMs: 0 });
        try {
          await e.open(makeCtx(`${name}-lru-a`), { url: site.base + '/' });
          await e.open(makeCtx(`${name}-lru-b`), { url: site.base + '/' });
          assert.equal(e.live(`${name}-lru-a`), false);
          assert.ok(e.stats().evictions >= 1);
          await new Promise((r) => setTimeout(r, 1500));
          assert.equal(e.live(`${name}-lru-b`), false);
          assert.ok(e.stats().expired >= 1);
        } finally {
          await e.close();
        }
      });
    });
  });
}
