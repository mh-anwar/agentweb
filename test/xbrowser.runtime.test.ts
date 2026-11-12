// Firefox / WebKit as runtime engines: engine('firefox'|'webkit'|'safari'), a configured escalation
// browser, and the fallback to another browser when a real browser is shown a bot wall.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { browserWall, createRuntime, type RuntimeImpl } from '../src/runtime.ts';
import { createJar, createWireEngine, encodeForm } from '../src/net/index.ts';
import { createGuard, defaultPolicy } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';
import { readBody, mineEmbedded } from '../src/readers/index.ts';
import { parseHtml } from '../src/parse.ts';
import { browserPath, createPlaywrightEngine } from '../src/engines/playwright/index.ts';
import type { Engine, Loaded, NavRequest, SessionCtx, Tier } from '../src/types.ts';
import { startSite, type TestSite } from './core.site.ts';

const policy = defaultPolicy('local');
const base = { createJar, createGuard: (state: unknown) => createGuard(policy, state), encodeForm, readBody, mineEmbedded };

/** a "chrome" that is shown a bot wall on every page */
function walledChrome(): Engine & { opens: number } {
  const e = {
    tier: 'chrome' as Tier,
    opens: 0,
    async available() {
      return true;
    },
    async open(_ctx: SessionCtx, req: NavRequest): Promise<Loaded> {
      e.opens++;
      const html = '<html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing the site.</p></body></html>';
      return { url: req.url, status: 403, method: 'GET', contentType: 'text/html', doc: parseHtml(html), bytes: html.length, ms: 1 };
    },
    async release() {},
    async close() {},
  };
  return e;
}

describe('browserWall', () => {
  const doc = (title: string, body = '<p>x</p>') => parseHtml(`<html><head><title>${title}</title></head><body>${body}</body></html>`);
  const L = (url: string, status: number, title: string, body?: string): Loaded => ({ url, status, method: 'GET', contentType: 'text/html', doc: doc(title, body), bytes: 0, ms: 0 });
  it("recognises Google's /sorry page, challenge titles and short 403 challenge pages", () => {
    assert.equal(browserWall(L('https://www.google.com/sorry/index?continue=x', 200, 'https://www.google.com/search?q=test')), 'google /sorry');
    assert.ok(browserWall(L('https://example.com/', 403, 'Just a moment...')));
    assert.ok(browserWall(L('https://example.com/', 403, 'Example', '<p>We detected unusual traffic from your computer network.</p>')));
  });
  it('leaves ordinary pages alone, including a 403 and a page that embeds a captcha', () => {
    assert.equal(browserWall(L('https://example.com/', 200, 'Example Domain')), undefined);
    assert.equal(browserWall(L('https://example.com/admin', 403, 'Forbidden', '<p>You do not have access.</p>')), undefined);
    assert.equal(browserWall(L('https://example.com/contact', 200, 'Contact us', '<form><div class="g-recaptcha"></div></form>')), undefined);
  });
});

for (const name of ['firefox', 'webkit'] as const) {
  const skip = (await browserPath(name)) ? false : `${name} is not installed`;

  describe(`runtime with ${name}`, { skip }, () => {
    let site: TestSite;
    let rt: RuntimeImpl;
    let walled: RuntimeImpl;
    let chrome: ReturnType<typeof walledChrome>;
    let n = 0;
    const fresh = () => `${name}-s${++n}`;

    before(async () => {
      site = await startSite();
      rt = createRuntime({ store: new MemoryStore(), engines: { wire: createWireEngine({ polite: false }), [name]: createPlaywrightEngine({ browser: name }) }, ...base });
      chrome = walledChrome();
      walled = createRuntime({
        store: new MemoryStore(),
        engines: { wire: createWireEngine({ polite: false }), chrome, [name]: createPlaywrightEngine({ browser: name }) },
        ...base,
      });
    });
    after(async () => {
      await rt?.close();
      await walled?.close();
      await site?.close();
    });

    it(`engine('${name}') opens, fills and submits in ${name}`, async () => {
      const s = fresh();
      const r = await rt.run(s, `engine('${name}'); open('${site.url}/login'); fill('Username', 'bob'); fill('Password', 'hunter2'); submit(); expect('Welcome back')`);
      assert.equal(r.ok, true, r.text);
      assert.equal(r.stats.tier, name);
      assert.match(r.text, /Welcome back, bob/);
      // the sign-in cookie is in the session record: a plain HTTP open is signed in too
      const again = await rt.run(s, `engine('wire'); open('${site.url}/account')`);
      assert.equal(again.stats.url, `${site.url}/account`, 'not sent back to the login page');
      assert.equal(again.stats.tier, 'wire');
    });

    it('takes a screenshot in the pinned browser', async () => {
      const r = await rt.run(fresh(), `engine('${name}'); open('${site.url}/'); shot()`);
      assert.equal(r.ok, true, r.text);
      assert.equal(r.images?.[0]?.mime, 'image/jpeg');
      assert.equal(r.stats.tier, name);
    });

    if (name === 'webkit') {
      it("engine('safari') is WebKit, and says so", async () => {
        const r = await rt.run(fresh(), "engine('safari')");
        assert.equal(r.ok, true, r.text);
        assert.match(r.text, /WebKit, Safari's engine \(not Safari itself\)/);
      });
    }

    it('an unknown engine lists the browsers', async () => {
      const r = await rt.run(fresh(), "engine('lynx')");
      assert.equal(r.ok, false);
      assert.match(r.text, /firefox, webkit/);
    });

    it(`a chrome bot wall is retried once in ${name}`, async () => {
      const before = chrome.opens;
      // shot() moves the page to the real browser (chrome here), which is walled
      const s = fresh();
      const r2 = await walled.run(s, `open('${site.url}/'); shot()`);
      assert.equal(r2.ok, true, r2.text);
      assert.match(r2.text, new RegExp(`chrome was shown a bot wall \\(Just a moment\\.\\.\\.\\); retried in ${name}`));
      assert.equal(r2.stats.tier, name);
      assert.ok(chrome.opens > before);
      // pinned to chrome: no fallback, the wall is what the agent sees
      const pinned = await walled.run(fresh(), `engine('chrome'); open('${site.url}/')`);
      assert.match(pinned.text, /Just a moment/);
      assert.doesNotMatch(pinned.text, /retried in/);
    });

    it(`a runtime configured with browser: '${name}' escalates there instead of chrome`, async () => {
      const own = createRuntime({
        store: new MemoryStore(),
        engines: { wire: createWireEngine({ polite: false }), chrome: walledChrome(), [name]: createPlaywrightEngine({ browser: name }) },
        ...base,
        options: { browser: name },
      });
      try {
        assert.deepEqual(own.ladder, ['wire', 'ghost', name]);
        const r = await own.run(fresh(), `open('${site.url}/'); shot()`);
        assert.equal(r.ok, true, r.text);
        assert.equal(r.stats.tier, name);
        assert.doesNotMatch(r.text, /bot wall/);
      } finally {
        await own.close();
      }
    });
  });
}
