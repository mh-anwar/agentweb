// The browser-extension bridge: the real extension, loaded into a real Chromium, drives tabs of the
// browser's own profile for the chrome engine through the local hub.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChromeEngine } from '../src/engines/chrome/index.ts';
import { connect } from '../src/engines/chrome/cdp.ts';
import { startHub, type Hub } from '../src/bridge/hub.ts';
import { createAgentweb } from '../src/index.ts';
import { byText, makeCtx, textOf } from './chrome.helpers.ts';

/** A full Chromium that still loads unpacked extensions from the command line (branded Chrome no longer does). */
function fullChromium(): string | undefined {
  if (process.env.AGENTWEB_TEST_CHROMIUM) return process.env.AGENTWEB_TEST_CHROMIUM;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || join(homedir(), '.cache', 'ms-playwright');
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
  } catch {}
  for (const d of dirs) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(root, d, rel);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const exe = fullChromium();
let server: Server;
let base = '';
let hub: Hub;
let child: ChildProcess;
let dir = '';
let debugPort = '';

const waitFor = async (what: string, fn: () => boolean | Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

describe('browser extension bridge', { skip: exe ? false : 'no full Chromium found (set AGENTWEB_TEST_CHROMIUM)' }, () => {
  before(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/set') {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'owner=me; Path=/' }).end('<title>set</title>cookie set');
      } else if (url === '/who') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(`<title>who</title><p>cookie:[${req.headers.cookie ?? ''}]</p><button onclick="document.getElementById('o').textContent='clicked'">Press me</button><p id="o">idle</p>`);
      } else res.writeHead(404).end('no');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), 'aw-bridge-test-'));
    hub = await startHub({ port: 0, stateFile: join(dir, 'home', 'bridge.json'), waitForExtensionMs: 500 });
    const ext = join(dir, 'ext');
    cpSync(new URL('../extension', import.meta.url), ext, { recursive: true });
    const bg = join(ext, 'background.js');
    writeFileSync(bg, readFileSync(bg, 'utf8').replace('const DEFAULT_PORT = 4466;', `const DEFAULT_PORT = ${hub.port};`));
    child = spawn(exe!, ['--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run', `--disable-extensions-except=${ext}`, `--load-extension=${ext}`, 'about:blank'], { stdio: 'ignore', detached: true });
    await waitFor('the browser to publish its port', () => {
      try {
        debugPort = readFileSync(join(dir, 'profile', 'DevToolsActivePort'), 'utf8').split('\n')[0];
      } catch {}
      return !!debugPort;
    });
  });

  after(async () => {
    await hub?.close();
    try {
      if (child?.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('refuses web pages and callers without the token', async () => {
    const WS = (globalThis as any).WebSocket;
    const fails = (url: string) =>
      new Promise<boolean>((resolve) => {
        const ws = new WS(url);
        ws.addEventListener('open', () => (ws.close(), resolve(false)));
        ws.addEventListener('error', () => resolve(true));
      });
    assert.ok(await fails(`ws://127.0.0.1:${hub.port}/cdp`), 'no token');
    assert.ok(await fails(`ws://127.0.0.1:${hub.port}/cdp?token=wrong`), 'wrong token');
    assert.ok(await fails(`ws://127.0.0.1:${hub.port}/extension`), 'not an extension');
  });

  it("opens pages in the user's own profile, acts on them, and closes only its own tabs", async () => {
    await waitFor('the extension to connect', () => hub.status().extension);
    assert.match(hub.status().browser, /^Chrome\/\d+/);

    // "the user" has a signed-in tab of their own
    const user = await connect(`http://127.0.0.1:${debugPort}`);
    const { targetId: userTab } = await user.send<{ targetId: string }>('Target.createTarget', { url: base + '/set' });
    await waitFor('the cookie', async () => (await user.send<{ cookies: { name: string }[] }>('Storage.getCookies')).cookies.some((c) => c.name === 'owner'));
    const pages = async () => (await user.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets')).targetInfos.filter((t) => t.type === 'page' && /^http/.test(t.url)).map((t) => t.targetId);
    const before = await pages();
    assert.ok(before.includes(userTab));

    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as any;
    const engine = createChromeEngine({ endpoint: hub.url, shared: true });
    try {
      const ctx = makeCtx('ext');
      const a = await engine.open(ctx, { url: base + '/who' });
      assert.match(textOf(a.doc!.root), /cookie:\[owner=me\]/, 'the profile\'s cookie is sent');
      assert.equal(ctx.jar.all().length, 0, 'the user\'s cookies are not copied into the session');
      assert.equal(hub.status().tabs.length, 1);
      assert.equal((await pages()).length, before.length + 1);

      const button = byText(a.doc!.root, 'Press me');
      assert.ok(button && typeof button.n === 'number', 'the button is actionable');
      const b = await engine.act!(ctx, { do: 'click', n: button.n! });
      assert.match(textOf(b.doc!.root), /clicked/);

      await engine.release('ext');
      await waitFor('the agent tab to close', async () => (await pages()).length === before.length);
      assert.deepEqual((await pages()).sort(), before.sort(), 'the user\'s tab is untouched');
      assert.equal(hub.status().tabs.length, 0);
    } finally {
      process.stderr.write = write;
      await engine.close();
      user.close('done');
    }
  });

  it("engine('mine') moves one session into the user's browser; other sessions stay isolated", async () => {
    await waitFor('the extension to connect', () => hub.status().extension);
    // a second agentweb process on the machine: the port is taken, so it joins the running hub through the state file
    const saved = { home: process.env.AGENTWEB_HOME, port: process.env.AGENTWEB_EXTENSION_PORT };
    process.env.AGENTWEB_HOME = join(dir, 'home');
    process.env.AGENTWEB_EXTENSION_PORT = String(hub.port);
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as any;
    const rt = await createAgentweb({ store: 'memory:', ghost: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_NO_SANDBOX: '1', AGENTWEB_USAGE_LOG: '', AGENTWEB_ATLAS: '0' } });
    try {
      const mine = await rt.run('mine', `engine('mine'); open('${base}/who'); click('Press me')`);
      assert.ok(mine.ok, mine.text);
      assert.match(mine.text, /cookie:\[owner=me\]/);
      assert.match(mine.text, /clicked/);
      assert.match(mine.text, /user's own browser/);
      assert.equal(hub.status().tabs.length, 1);

      const iso = await rt.run('iso', `engine('chrome'); open('${base}/who')`);
      assert.ok(iso.ok, iso.text);
      assert.match(iso.text, /cookie:\[\]/, 'an ordinary session has its own empty browser');
      assert.equal(hub.status().tabs.length, 1);

      const back = await rt.run('mine', `engine('chrome'); view()`);
      assert.ok(back.ok, back.text);
      assert.match(back.text, /cookie:\[\]/, 'back in the isolated browser the sign-in is gone');
      await waitFor('the tab in the user\'s browser to close', () => hub.status().tabs.length === 0);
    } finally {
      process.stderr.write = write;
      await rt.close();
      for (const [k, v] of [['AGENTWEB_HOME', saved.home], ['AGENTWEB_EXTENSION_PORT', saved.port]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('takes over a tab the user shared, hands a step to the person, and never closes their tab', async () => {
    await waitFor('the extension to connect', () => hub.status().extension);
    const user = await connect(`http://127.0.0.1:${debugPort}`);
    const evalIn = async (targetId: string, expression: string) => {
      const { sessionId } = await user.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      const r = await user.send<any>('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, { sessionId });
      await user.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      return r.result?.value;
    };
    const targets = async () => (await user.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets')).targetInfos;
    // the user opens a page of their own and presses "Share this tab with the agent" in the extension's popup
    const { targetId: theirs } = await user.send<{ targetId: string }>('Target.createTarget', { url: base + '/who?mine=1' });
    await waitFor('their page', async () => (await targets()).some((t) => t.targetId === theirs && /mine=1/.test(t.url)));
    const worker = (await targets()).find((t) => t.type === 'service_worker' && /^chrome-extension:/.test(t.url));
    assert.ok(worker, 'the extension worker is running');
    await evalIn(worker.targetId, `chrome.tabs.query({}).then(async (all) => { const t = all.find((x) => /mine=1/.test(x.url || '')); offered.add(t.id); await sendOffered(); return t.id; })`);
    await waitFor('the hub to hear about the shared tab', () => hub.status().offered.length === 1);

    const saved = { home: process.env.AGENTWEB_HOME, port: process.env.AGENTWEB_EXTENSION_PORT };
    process.env.AGENTWEB_HOME = join(dir, 'home');
    process.env.AGENTWEB_EXTENSION_PORT = String(hub.port);
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as any;
    const rt = await createAgentweb({ store: 'memory:', ghost: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_NO_SANDBOX: '1', AGENTWEB_USAGE_LOG: '', AGENTWEB_ATLAS: '0' } });
    try {
      const refused = await rt.run('iso', "tab('shared')");
      assert.ok(!refused.ok);
      assert.match(refused.text, /engine\('mine'\) first/);

      const listed = await rt.run('sh', "engine('mine'); tabs()");
      assert.match(listed.text, /shared by the user[\s\S]*who.*mine=1/);
      const took = await rt.run('sh', "tab('shared', 'mine=1'); click('Press me')");
      assert.ok(took.ok, took.text);
      assert.match(took.text, /clicked/);
      assert.match(took.text, /user's own tab/);
      assert.equal(hub.status().tabs.filter((t) => !t.owned).length, 1);

      // hand a step to the person: they press the button themselves while the agent waits
      const reset = await rt.run('sh', `open('${base}/who?mine=2')`);
      assert.match(reset.text, /idle/);
      setTimeout(() => void evalIn(theirs, `document.querySelector('button').click()`).catch(() => {}), 1200);
      const handed = await rt.run('sh', "handoff('Please press the button', wait=15)");
      assert.ok(handed.ok, handed.text);
      assert.match(handed.text, /the user was asked: "Please press the button"; the page changed/);
      assert.match(handed.text, /clicked/);

      const blind = await rt.run('iso2', `engine('chrome'); open('${base}/who'); handoff('Sign in')`);
      assert.ok(!blind.ok);
      assert.match(blind.text, /nobody can see this page/);
    } finally {
      process.stderr.write = write;
      await rt.close();
      for (const [k, v] of [['AGENTWEB_HOME', saved.home], ['AGENTWEB_EXTENSION_PORT', saved.port]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    await waitFor('the agent to let go', () => hub.status().tabs.length === 0);
    assert.ok((await targets()).some((t) => t.targetId === theirs), "the user's tab is still open");
    user.close('done');
  });
});
