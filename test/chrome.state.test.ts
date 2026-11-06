// chrome engine: cookies and localStorage as the source of truth, eviction and rehydration,
// concurrency, crash recovery, remote endpoints, and leaving no process behind.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChromeEngine, findBrowser, RESTORED, type ChromeEngine } from '../src/engines/chrome/index.ts';
import { AwError, type Loaded } from '../src/types.ts';
import { alive, byId, makeCtx, startSite, textOf, treePids, type Site } from './chrome.helpers.ts';

let site: Site;
const engines: ChromeEngine[] = [];
const pids = new Set<number>();

const make = (o: Parameters<typeof createChromeEngine>[0] = {}) => {
  const e = createChromeEngine({ noSandbox: true, ...o });
  engines.push(e);
  return e;
};
const remember = (e: ChromeEngine) => {
  const b = e.browser();
  if (b?.pid) for (const p of treePids(b.pid)) pids.add(p);
};
const idOf = (r: Loaded, id: string): number => {
  const n = byId(r.doc!.root, id);
  assert.ok(n && typeof n.n === 'number', `#${id} has a live node id`);
  return n.n!;
};
const textById = (r: Loaded, id: string) => textOf(byId(r.doc!.root, id) ?? { t: 'x' });
const host = () => new URL(site.base).hostname;

before(async () => {
  site = await startSite();
});

after(async () => {
  for (const e of engines) await e.close();
  await site.close();
  const left = [...pids].filter(alive);
  for (const p of left) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {}
  }
  assert.deepEqual(left, [], 'no browser process may survive close()');
});

describe('chrome cookies', () => {
  it('round-trips jar -> browser -> jar, including httpOnly, script-set and deleted cookies', async () => {
    const e = make();
    const ctx = makeCtx('cookies');
    ctx.jar.set({ name: 'sid', value: 'alice-token', domain: host(), path: '/', hostOnly: true });
    let r = await e.open(ctx, { url: site.base + '/me' });
    remember(e);
    assert.equal(textById(r, 'who'), 'Signed in as alice-token', 'the jar cookie reached the server');

    r = await e.open(ctx, { url: site.base + '/login?u=bob' });
    assert.equal(r.url, site.base + '/me');
    assert.equal(textById(r, 'who'), 'Signed in as bob-token');
    const sid = ctx.jar.get('sid');
    assert.equal(sid?.value, 'bob-token', 'Set-Cookie from a redirect came back to the jar');
    assert.equal(sid?.httpOnly, true);
    assert.ok(sid?.expires && sid.expires > Date.now() / 1000 + 3000);

    r = await e.act(ctx, { do: 'click', n: idOf(r, 'jscookie') });
    assert.equal(ctx.jar.get('js')?.value, '1', 'a cookie set by script came back to the jar');

    // the site deletes a cookie: it disappears from the jar
    await e.open(ctx, { url: site.base + '/logout' });
    assert.equal(ctx.jar.get('sid'), undefined);

    // the jar is the truth: a cookie the jar drops is dropped in the browser too
    ctx.jar.set({ name: 'sid', value: 'carol-token', domain: host(), path: '/', hostOnly: true });
    r = await e.open(ctx, { url: site.base + '/me' });
    assert.equal(textById(r, 'who'), 'Signed in as carol-token');
    ctx.jar.clear();
    r = await e.open(ctx, { url: site.base + '/me' });
    assert.equal(textById(r, 'who'), 'Signed out');
  });

  it('keeps sessions isolated from each other', async () => {
    const e = make();
    const a = makeCtx('iso-a');
    const b = makeCtx('iso-b');
    await e.open(a, { url: site.base + '/login?u=ann' });
    remember(e);
    const rb = await e.open(b, { url: site.base + '/me' });
    assert.equal(textById(rb, 'who'), 'Signed out');
    assert.equal(b.jar.get('sid'), undefined);
  });
});

describe('chrome eviction and rehydration', () => {
  it('evicts the least recently used context and rehydrates it with cookies and localStorage', async () => {
    const e = make({ maxContexts: 2 });
    const a = makeCtx('evict-a');
    let r = await e.open(a, { url: site.base + '/login?u=dora' });
    remember(e);
    r = await e.act(a, { do: 'click', n: idOf(r, 'setls') });
    assert.equal(textById(r, 'ls'), 'theme=dark');
    assert.deepEqual(a.storage[new URL(site.base).origin], { theme: 'dark' }, 'localStorage came back to the session');
    a.url = r.url;

    await e.open(makeCtx('evict-b'), { url: site.base + '/' });
    await e.open(makeCtx('evict-c'), { url: site.base + '/' });
    assert.equal(e.live('evict-a'), false, 'a was evicted');
    assert.ok(e.stats().evictions >= 1);

    const t0 = performance.now();
    r = await e.snapshot(a);
    const ms = performance.now() - t0;
    assert.ok(r.events?.includes(RESTORED), JSON.stringify(r.events));
    assert.equal(r.url, site.base + '/me');
    assert.equal(textById(r, 'who'), 'Signed in as dora-token', 'the login cookie survived');
    assert.equal(textById(r, 'ls'), 'theme=dark', 'localStorage was in place before the page script ran');
    assert.equal(e.live('evict-a'), true);
    console.log(`# rehydration (snapshot of an evicted session): ${ms.toFixed(0)} ms`);

    // an action on an evicted session rehydrates too, then acts
    await e.release('evict-a');
    assert.equal(e.live('evict-a'), false);
    r = await e.act(a, { do: 'wait', ms: 1 });
    assert.ok(r.events?.includes(RESTORED));
    assert.equal(textById(r, 'who'), 'Signed in as dora-token');
  });

  it('a rehydration the guard now refuses is AwError(policy)', async () => {
    const e = make();
    const ctx = makeCtx('rehyd-guard', { url: site.base + '/me' });
    ctx.guard.deny = () => 'no longer allowed';
    await assert.rejects(e.snapshot(ctx), (err: AwError) => err.code === 'policy');
  });

  it('disposes contexts left idle', async () => {
    const e = make({ idleMs: 400 });
    await e.open(makeCtx('idle'), { url: site.base + '/' });
    remember(e);
    assert.equal(e.live('idle'), true);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(e.live('idle'), false);
    assert.ok(e.stats().expired >= 1);
  });
});

describe('chrome concurrency and recovery', () => {
  it('serves 20 concurrent sessions from one browser', async () => {
    const e = make({ maxContexts: 24 });
    const ctxs = Array.from({ length: 20 }, (_, i) => makeCtx('c' + i));
    const t0 = performance.now();
    const rs = await Promise.all(ctxs.map((c) => e.open(c, { url: site.base + '/spa' })));
    const ms = performance.now() - t0;
    remember(e);
    for (const r of rs) assert.match(textOf(r.doc!.root), /Green scarf/);
    const s = e.stats();
    assert.equal(s.contexts, 20);
    assert.equal(s.launches, 1);
    console.log(`# 20 concurrent opens of the client-rendered page: ${ms.toFixed(0)} ms wall, rss ${(s.rssBytes / 1e6).toFixed(0)} MB in ${s.processes} processes`);
    // one session's calls are serialised; different sessions' are not
    const one = ctxs[0];
    const [x, y] = await Promise.all([e.open(one, { url: site.base + '/' }), e.open(one, { url: site.base + '/next' })]);
    assert.equal(x.url, site.base + '/');
    assert.equal(y.url, site.base + '/next');
  });

  it('recovers after the browser process is killed', async () => {
    const e = make();
    const ctx = makeCtx('crash');
    let r = await e.open(ctx, { url: site.base + '/login?u=eve' });
    remember(e);
    ctx.url = r.url;
    const b = e.browser()!;
    const old = b.pid!;
    b.kill();
    for (let i = 0; i < 100 && b.alive(); i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(b.alive(), false);
    assert.equal(e.live('crash'), false);
    r = await e.snapshot(ctx);
    remember(e);
    assert.notEqual(e.browser()?.pid, old, 'a new browser was launched');
    assert.ok(r.events?.includes(RESTORED));
    assert.equal(textById(r, 'who'), 'Signed in as eve-token');
    const s = e.stats();
    assert.equal(s.launches, 2);
    assert.equal(s.crashes, 1);
  });

  it('retries a navigation the dying browser was in the middle of', async () => {
    const e = make();
    await e.open(makeCtx('warm'), { url: site.base + '/' });
    remember(e);
    const b = e.browser()!;
    const p = e.open(makeCtx('midflight'), { url: site.base + '/slow' });
    setTimeout(() => b.kill(), 300);
    const r = await p;
    remember(e);
    assert.match(textOf(r.doc!.root), /Finally here/);
    assert.ok(e.stats().retries >= 1);
  });

  it('close() leaves no browser process behind and later calls fail cleanly', async () => {
    const e = make();
    await e.open(makeCtx('closing'), { url: site.base + '/' });
    const tree = treePids(e.browser()!.pid!);
    assert.ok(tree.length >= 2, `browser tree: ${tree}`);
    await e.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(tree.filter(alive), []);
    await assert.rejects(e.open(makeCtx('closing'), { url: site.base + '/' }), (err: AwError) => err.code === 'gone');
  });
});

describe('chrome remote endpoint', () => {
  it('drives a browser it did not launch over WebSocket and leaves it running on close', async () => {
    const exe = findBrowser();
    assert.ok(exe);
    const dir = mkdtempSync(join(tmpdir(), 'aw-remote-test-'));
    const child = spawn(exe, ['--headless', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true });
    try {
      let port = '';
      for (let i = 0; i < 200 && !port; i++) {
        try {
          port = readFileSync(join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0];
        } catch {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      assert.ok(port, 'remote browser published its port');
      const e = make({ endpoint: `http://127.0.0.1:${port}` });
      assert.equal(await e.available(), true);
      assert.equal(await createChromeEngine({ endpoint: 'http://127.0.0.1:1' }).available(), false);
      const r = await e.open(makeCtx('remote'), { url: site.base + '/spa' });
      assert.match(textOf(r.doc!.root), /Blue hat/);
      await e.close();
      assert.ok(alive(child.pid!), 'the remote browser is not ours to shut down');
    } finally {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
