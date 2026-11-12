// chrome engine: the browser tells one consistent story (user agent, client hints, webdriver), and
// the opt-in "shared" mode that opens pages in a running browser's own profile.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChromeEngine, findBrowser, type ChromeEngine } from '../src/engines/chrome/index.ts';
import { chromeArgs } from '../src/engines/chrome/launch.ts';
import { connect } from '../src/engines/chrome/cdp.ts';
import { uaMetadata } from '../src/engines/chrome/page.ts';
import { alive, makeCtx, textOf } from './chrome.helpers.ts';

let server: Server;
let base = '';
const seen: { ua: string; chUa: string; chPlatform: string; cookie: string }[] = [];
const engines: ChromeEngine[] = [];

const PROBE = `<!doctype html><html><head><title>probe</title></head><body><pre id="o">loading</pre><script>
(async () => {
  const d = navigator.userAgentData;
  const hi = d ? await d.getHighEntropyValues(['fullVersionList', 'platform', 'platformVersion', 'architecture']) : null;
  document.getElementById('o').textContent = JSON.stringify({ webdriver: navigator.webdriver, ua: navigator.userAgent, brands: d && d.brands, mobile: d && d.mobile, platform: d && d.platform, full: hi && hi.fullVersionList });
})();
</script></body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const h = req.headers;
    if (u.pathname === '/probe') seen.push({ ua: String(h['user-agent']), chUa: String(h['sec-ch-ua']), chPlatform: String(h['sec-ch-ua-platform']), cookie: '' });
    if (u.pathname === '/set') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'owner=me; Path=/; Max-Age=600' });
      return void res.end('<title>set</title><p>set</p>');
    }
    if (u.pathname === '/who') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return void res.end(`<title>who</title><p id="c">cookie:[${h.cookie ?? ''}]</p>`);
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PROBE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await Promise.all(engines.map((e) => e.close().catch(() => {})));
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const make = (o: Parameters<typeof createChromeEngine>[0] = {}) => {
  const e = createChromeEngine({ noSandbox: true, ...o });
  engines.push(e);
  return e;
};

const probe = async (e: ChromeEngine, ctx = makeCtx('fp')) => {
  const r = await e.open(ctx, { url: base + '/probe' });
  // the probe fills its text asynchronously: read it from the live page
  for (let i = 0; i < 20; i++) {
    const v = await e.act(ctx, { do: 'js', code: "document.getElementById('o').textContent" });
    if (v.value && v.value !== 'loading' && v.value !== '"loading"') return JSON.parse(JSON.parse(v.value) as string);
    await new Promise((x) => setTimeout(x, 50));
  }
  void r;
  throw new Error('probe did not finish');
};

describe('uaMetadata', () => {
  it('builds Chrome brands with the real major version and a Linux, desktop platform', () => {
    const m = uaMetadata('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36', '156.0.8078.4') as any;
    assert.deepEqual(m.brands.map((b: any) => b.brand), ['Not=A?Brand', 'Chromium', 'Google Chrome']);
    assert.equal(m.brands[2].version, '156');
    assert.equal(m.fullVersionList[2].version, '156.0.8078.4');
    assert.equal(m.platform, 'Linux');
    assert.equal(m.mobile, false);
  });
  it('follows a mobile or Windows UA and leaves non-Chrome UAs to the browser', () => {
    const a = uaMetadata('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/156.0.0.0 Mobile Safari/537.36') as any;
    assert.equal(a.platform, 'Android');
    assert.equal(a.mobile, true);
    assert.equal((uaMetadata('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/156.0.0.0 Safari/537.36') as any).platform, 'Windows');
    assert.equal(uaMetadata('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1'), undefined);
  });
});

describe('chrome fingerprint consistency', () => {
  it('webdriver is false and the client hints match the user agent (pipe launch)', async () => {
    assert.ok(chromeArgs('/tmp/x', {}).includes('--disable-blink-features=AutomationControlled'));
    const e = make();
    const v = await probe(e);
    assert.equal(v.webdriver, false);
    assert.doesNotMatch(v.ua, /Headless/);
    const major = /Chrome\/(\d+)/.exec(v.ua)![1];
    const names = v.brands.map((b: any) => b.brand);
    assert.ok(names.includes('Google Chrome') && names.includes('Chromium') && names.some((n: string) => /Not.*Brand/.test(n)), names.join());
    assert.equal(v.brands.find((b: any) => b.brand === 'Google Chrome').version, major);
    assert.equal(v.platform, 'Linux');
    assert.equal(v.mobile, false);
    const full = v.full.find((b: any) => b.brand === 'Google Chrome').version as string;
    assert.ok(full.startsWith(major + '.') && full !== major + '.0.0.0', `full version ${full}`);
    const real = /Chrome\/([\d.]+)/.exec(e.browser()!.product)![1];
    assert.equal(full, real);
    // the request headers agree with the script-visible values
    const h = seen[seen.length - 1];
    assert.match(h.chUa, new RegExp(`"Google Chrome";v="${major}"`));
    assert.match(h.chPlatform, /Linux/);
    assert.equal(h.ua, v.ua);
  });

  it('an emulate()-set user agent keeps working and its hints follow it', async () => {
    const e = make();
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.0.0 Safari/537.36';
    const v = await probe(e, makeCtx('fp-win', { userAgent: ua }));
    assert.match(v.ua, /Windows NT 10\.0/);
    assert.equal(v.platform, 'Windows');
    assert.equal(v.webdriver, false);
    const major = /Chrome\/(\d+)/.exec(v.ua)![1];
    assert.notEqual(major, '99', 'the Chrome version is made to agree with the real browser');
    assert.equal(v.brands.find((b: any) => b.brand === 'Google Chrome').version, major);
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const w = await probe(e, makeCtx('fp-ios', { userAgent: iphone }));
    assert.match(w.ua, /iPhone/);
  });
});

describe('chrome shared profile (AGENTWEB_CDP_SHARED)', () => {
  it('sees the browser\'s own cookies, closes only its own tabs, and leaves the browser running', async () => {
    const exe = findBrowser();
    assert.ok(exe);
    const dir = mkdtempSync(join(tmpdir(), 'aw-shared-test-'));
    const child = spawn(exe, ['--headless', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true });
    const warned: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    try {
      let port = '';
      for (let i = 0; i < 200 && !port; i++) {
        try {
          port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        } catch {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      assert.ok(port, 'browser published its port');
      const endpoint = `http://127.0.0.1:${port}`;

      // "the user" signs in: a tab of their own in the default context receives a cookie and stays open
      const user = await connect(endpoint);
      const { targetId: userTab } = await user.send<{ targetId: string }>('Target.createTarget', { url: base + '/set' });
      for (let i = 0; i < 100; i++) {
        const { cookies } = await user.send<{ cookies: { name: string }[] }>('Storage.getCookies');
        if (cookies.some((c) => c.name === 'owner')) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const tabs = async () => (await user.send<{ targetInfos: { targetId: string; type: string }[] }>('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').map((t) => t.targetId);
      const before = await tabs();
      assert.ok(before.includes(userTab));

      // an isolated session does not see it
      const iso = make({ endpoint });
      const a = await iso.open(makeCtx('iso'), { url: base + '/who' });
      assert.match(textOf(a.doc!.root), /cookie:\[\]/);
      await iso.close();

      process.stderr.write = ((s: any) => (warned.push(String(s)), true)) as any;
      const shared = make({ endpoint, shared: true });
      const ctx = makeCtx('shared');
      const b = await shared.open(ctx, { url: base + '/who' });
      process.stderr.write = write;
      assert.match(textOf(b.doc!.root), /cookie:\[owner=me\]/);
      assert.ok(warned.some((w) => /AGENTWEB_CDP_SHARED/.test(w) && /your own|YOUR/i.test(w)), 'start-up warning: ' + warned.join('|'));
      assert.ok(b.events?.some((n) => /own browser profile/.test(n)), "page note: " + JSON.stringify(b.events));
      // nothing of the user's jar was copied into the session
      assert.equal(ctx.jar.all().length, 0);
      const during = await tabs();
      assert.equal(during.length, before.length + 1, 'one tab opened by agentweb');
      await shared.close();
      const after = await tabs();
      assert.deepEqual(after.sort(), before.sort(), 'only the tab agentweb opened was closed');
      assert.ok(alive(child.pid!), 'the browser is still running');
      user.close('done');
    } finally {
      process.stderr.write = write;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
