// route / headers / auth / init / wait variants / emulation additions / drop / HAR, in real Chromium
// against a tiny local site. The wire-tier half (headers, auth, parsers) is in netcontrol.wire.test.ts.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentweb } from '../src/index.ts';

const USER = 'alice';
const PASS = 'correct horse';

const HOME = `<title>Shop</title><h1>Shop</h1>
<button onclick="load()">Load cart</button><div id=o>idle</div>
<a href="http://blocked.test/x">Blocked link</a>
<div id=t></div>
<script>
function load(){fetch('/api/cart').then(r=>r.text().then(t=>{document.getElementById('o').textContent=r.status+':'+t})).catch(e=>{document.getElementById('o').textContent='failed:'+e.message})}
function tryBlocked(){fetch('http://blocked.test/api').then(r=>r.text()).then(t=>{document.getElementById('o').textContent='got:'+t}).catch(()=>{document.getElementById('o').textContent='failed:blocked'})}
document.getElementById('t').textContent='test='+window.__TEST__;
</script><button onclick="tryBlocked()">Try blocked</button>`;

const LATE = `<title>Late</title><h1>Late</h1><div id=s></div><div id=l>Loading</div>
<button id=e disabled>Go</button><button id=h>Hide me</button><button id=v style="display:none">Later</button>
<script>
setTimeout(()=>{s.textContent='Saved';l.remove();e.disabled=false;h.style.display='none';v.style.display=''},1400);
setTimeout(()=>{history.pushState({},'','/dashboard')},2400);
</script>`;

const DROP = `<title>Drop</title><h1>Drop</h1><div id=z style="width:200px;height:80px;border:1px solid">drop zone</div><div id=out>nothing</div>
<script>
z.addEventListener('dragover',e=>e.preventDefault());
z.addEventListener('drop',e=>{e.preventDefault();const f=e.dataTransfer.files[0];const r=new FileReader();r.onload=()=>{out.textContent='dropped:'+f.name+':'+f.size+':'+r.result};r.readAsText(f)});
</script>`;

let server: Server;
let base = '';
let dir = '';
let rt: Awaited<ReturnType<typeof createAgentweb>>;
let denyRt: Awaited<ReturnType<typeof createAgentweb>>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aw-netctl-'));
  writeFileSync(join(dir, 'report.csv'), 'a,b\n1,2\n');
  server = createServer((q, s) => {
    const url = q.url ?? '/';
    if (url === '/api/cart') {
      s.writeHead(200, { 'content-type': 'text/plain' });
      return void s.end('real-cart');
    }
    if (url === '/api/user') {
      s.writeHead(200, { 'content-type': 'application/json' });
      return void s.end('{"name":"real"}');
    }
    if (url === '/echo') {
      s.writeHead(200, { 'content-type': 'application/json' });
      return void s.end(JSON.stringify({ debug: q.headers['x-debug'] ?? 'none', lang: q.headers['accept-language'] }));
    }
    if (url.startsWith('/secret')) {
      const ok = q.headers.authorization === 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
      if (!ok) {
        s.writeHead(401, { 'www-authenticate': 'Basic realm="lab"', 'content-type': 'text/html' });
        return void s.end('<title>Denied</title><p>login required</p>');
      }
      s.writeHead(200, { 'content-type': 'text/html' });
      return void s.end('<title>Vault</title><h1>welcome alice</h1>');
    }
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end(url === '/late' ? LATE : url === '/drop' ? DROP : url === '/two' ? '<title>Two</title><h1>real two</h1>' : url === '/dashboard' ? '<title>Dash</title><h1>dash</h1>' : HOME);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = {
    AGENTWEB_ALLOW_PRIVATE: '1',
    AGENTWEB_DOWNLOADS: dir,
    AGENTWEB_NO_SANDBOX: '1',
    AGENTWEB_USAGE_LOG: '',
    AGENTWEB_ATLAS: '0',
    AGENTWEB_SECRET_LAB_PW: PASS,
    AGENTWEB_SECRET_LAB_PW_ORIGINS: base,
  };
  rt = await createAgentweb({ store: 'memory:', ghost: false, env });
  denyRt = await createAgentweb({ store: 'memory:', ghost: false, env: { ...env, AGENTWEB_DENY: 'blocked.test' } });
});

after(async () => {
  await rt.close?.();
  await denyRt.close?.();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const go = (session: string, program: string) => rt.run(session, program).then((r) => r.text);
const open = (path = '/') => `open('${base}${path}'); engine('chrome')`;
const evict = (session: string) => (rt as any).deps.engines.chrome.release(session) as Promise<void>;

describe('route', { concurrency: false }, () => {
  it('mocks a status and body, and routes() lists it with hit counts', async () => {
    const t = await go('r1', `${open()}; route('*/api/cart*', status=500, body='boom'); click('Load cart'); find('500:')`);
    assert.match(t, /500:boom/);
    const list = await go('r1', 'routes()');
    assert.match(list, /\*\/api\/cart\* → 500 "boom" · 1 hit/);
  });

  it('answers JSON with the right content type, for the page and for a program that reads it', async () => {
    const t = await go('r2', `${open()}; route('*/api/user', json='{"name":"x"}'); js('const r = await fetch("/api/user"); const j = await r.json(); return [r.headers.get("content-type"), j.name]')`);
    assert.match(t, /\["application\/json; charset=utf-8","x"\]/);
  });

  it('a mock is readable by a page on another origin (CORS and preflight are answered)', async () => {
    const other = base.replace('127.0.0.1', 'localhost');
    const t = await go('r2b', `${open()}; route('${other}/api/*', json='{"n":2}'); js('const r = await fetch("${other}/api/user", {headers: {"x-t": "1"}}); return await r.text()')`);
    assert.match(t, /\{\\"n\\":2\}|\{"n":2\}/);
  });

  it('aborts a request', async () => {
    const t = await go('r3', `${open()}; route('*/api/cart*', abort=1); click('Load cart'); find('failed')`);
    assert.match(t, /failed:/);
    assert.match(await go('r3', 'network(failed=1)'), /FAILED/);
  });

  it('removes one route, then all', async () => {
    await go('r4', `${open()}; route('*/api/cart*', status=500); route('*/api/user', status=404)`);
    await go('r4', "route('*/api/cart*', off=1)");
    assert.match(await go('r4', "click('Load cart'); find('200:')"), /200:real-cart/);
    assert.match(await go('r4', 'routes()'), /\/api\/user/);
    await go('r4', 'route(off=1)');
    assert.match(await go('r4', 'routes()'), /no routes/);
    assert.match(await go('r4', "route('*/nothing', off=1)"), /there is no route/);
  });

  it('the newest matching route wins, and a method filter applies', async () => {
    const t = await go('r5', `${open()}; route('*/api/*', status=500, body='old'); route('*/api/cart', status=201, body='new'); click('Load cart'); find('201:')`);
    assert.match(t, /201:new/);
    const m = await go('r5', `route('*/api/cart', status=418, method='POST'); click('Load cart'); find(':')`);
    assert.match(m, /201:new/);
  });

  it('survives the page being evicted and re-created', async () => {
    await go('r6', `${open()}; route('*/api/cart*', status=503, body='gone')`);
    await evict('r6');
    assert.match(await go('r6', "click('Load cart'); find('503:')"), /503:gone/);
  });

  it('pins the session to chrome and says so, for a page already open on the wire tier', async () => {
    const r = await rt.run('r7', `open('${base}'); route('*/api/cart*', status=500, body='boom')`);
    assert.match(r.text, /routes need the chrome engine/);
    assert.equal(r.stats.tier, 'chrome');
    assert.match(await go('r7', "click('Load cart'); find('500:')"), /500:boom/);
    // lifting the last route lifts the pin it set
    await go('r7', 'route(off=1)');
    const rec: any = await (rt as any).deps.store.get('session', 'r7');
    assert.equal(rec.engine, undefined);
    assert.equal(rec.net, undefined);
  });

  it('can mock a navigation', async () => {
    const t = await go('r8', `route('*/two', body='<title>Mocked</title><h1>Mocked two</h1>'); open('${base}/two')`);
    assert.match(t, /Mocked two/);
    assert.doesNotMatch(t, /real two/);
  });

  it('a mocked answer still passes the guard: a denied host stays denied', async () => {
    const run = (p: string) => denyRt.run('d1', p).then((r) => r.text);
    // navigation
    const nav = await run(`route('*://blocked.test/*', body='<h1>mocked</h1>'); open('http://blocked.test/x')`);
    assert.match(nav, /deny list/);
    assert.doesNotMatch(nav, /# mocked/);
    // a link followed from a page, and a subresource request
    await run(`open('${base}'); engine('chrome')`);
    const link = await run("click('Blocked link')");
    assert.match(link, /deny list|policy|refus/i);
    assert.doesNotMatch(link, /# mocked/);
    const sub = await run("click('Try blocked'); find('failed')");
    assert.match(sub, /failed:blocked/);
  });

  it('explains what a route needs', async () => {
    assert.match(await go('r9', "route('*/api/*')"), /does nothing: give it status=, body=, json= or abort=1/);
    assert.match(await go('r9', "route('*/api/*', json='{nope')"), /json= is not valid JSON/);
    assert.match(await go('r9', "route('*/api/*', status=99)"), /status must be an HTTP status code/);
    assert.match(await go('r9', 'route()'), /route needs a URL pattern/);
  });
});

describe('headers and auth in chrome', { concurrency: false }, () => {
  it('headers() reach the browser, including the language, and outlive the page', async () => {
    const t = await go('h1', `headers('X-Debug: 7', 'Accept-Language: fr'); open('${base}/echo'); engine('chrome'); open('${base}/echo'); find('debug'); find('lang')`);
    assert.match(t, /debug: 7/);
    assert.match(t, /lang: fr/);
    await evict('h1');
    assert.match(await go('h1', `open('${base}/echo'); find('debug')`), /debug: 7/);
    await go('h1', 'headers(off=1)');
    assert.match(await go('h1', `open('${base}/echo'); find('debug')`), /debug: none/);
  });

  it('auth() answers the challenge, never prints the password, and is kept with the session', async () => {
    const r = await rt.run('a1', `auth('${USER}', '${PASS}'); engine('chrome'); open('${base}/secret')`);
    assert.match(r.text, /welcome alice/);
    assert.doesNotMatch(r.text, new RegExp(PASS));
    await evict('a1');
    assert.match(await go('a1', `open('${base}/secret/2')`), /welcome alice/);
  });

  it('accepts a secret handle, and a wrong password is reported instead of looping', async () => {
    assert.match(await go('a2', `auth('${USER}', '{{secret:lab_pw}}'); engine('chrome'); open('${base}/secret')`), /welcome alice/);
    const bad = await go('a3', `auth('${USER}', 'nope'); engine('chrome'); open('${base}/secret')`);
    assert.match(bad, /login required|rejected the credentials/);
    assert.doesNotMatch(bad, /welcome/);
  });

  it('credentials are only for the origin named by origin=', async () => {
    const t = await go('a4', `auth('${USER}', '${PASS}', origin='https://example.org'); engine('chrome'); open('${base}/secret')`);
    assert.doesNotMatch(t, /welcome/);
  });
});

describe('init scripts', { concurrency: false }, () => {
  it('run before the page scripts of every new document, and are removed by off=1', async () => {
    const t = await go('i1', `init('window.__TEST__ = "yes"'); open('${base}'); find('test=')`);
    assert.match(t, /test=yes/);
    // a second document of the same session
    assert.match(await go('i1', `open('${base}/two'); open('${base}'); find('test=')`), /test=yes/);
    await evict('i1');
    assert.match(await go('i1', `open('${base}'); find('test=')`), /test=yes/);
    await go('i1', 'init(off=1)');
    assert.match(await go('i1', `open('${base}'); find('test=')`), /test=undefined/);
  });

  it('keeps regex backslashes and quotes of the code as written', async () => {
    const t = await go('i2', `init("window.__TEST__ = /\\d+/.test('a1') ? 'digits' : 'none'"); open('${base}'); find('test=')`);
    assert.match(t, /test=digits/);
  });

  it('is refused in read-only mode, like js()', async () => {
    const ro = await createAgentweb({ store: 'memory:', ghost: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_READ_ONLY: '1', AGENTWEB_NO_SANDBOX: '1', AGENTWEB_USAGE_LOG: '', AGENTWEB_ATLAS: '0' } });
    try {
      assert.match((await ro.run('x', `open('${base}'); init('1')`)).text, /read-only/);
      assert.match((await ro.run('y', `open('${base}/drop'); engine('chrome'); drop('drop zone', text='x', name='a.txt')`)).text, /read-only/);
    } finally {
      await ro.close?.();
    }
  });
});

describe('wait variants', { concurrency: false }, () => {
  it('plain wait keeps working', async () => {
    assert.match(await go('w0', `open('${base}/late'); engine('chrome'); wait('Saved'); find('Saved')`), /Saved/);
    assert.match(await go('w0b', `${open()}; wait(0.3)`), /Shop/);
  });

  it('wait(url=) until the page URL contains or matches it', async () => {
    const probe = "js('location.pathname + \":\" + document.getElementById(\"s\").textContent')";
    assert.match(await go('w1', `open('${base}/late'); engine('chrome'); wait(url='/dashboard'); ${probe}`), /\/dashboard:Saved/);
    assert.match(await go('w1b', `open('${base}/late'); engine('chrome'); wait(url='**/dashboard'); ${probe}`), /\/dashboard:Saved/);
  });

  it('wait with several texts returns when any appears and says which', async () => {
    const t = await go('w2', `open('${base}/late'); engine('chrome'); wait('Failed', 'Saved')`);
    assert.match(t, /note: wait: "Saved" appeared/);
  });

  it('wait(gone=) until text disappears', async () => {
    const t = await go('w3', `open('${base}/late'); engine('chrome'); wait(gone='Loading'); find('Loading')`);
    assert.doesNotMatch(t, /\bLoading\b.*\n.*Loading/s);
    assert.match(t, /Saved|no match|nothing/i);
  });

  it('wait(target, state=) for a named and a numbered target', async () => {
    assert.match(await go('w4', `open('${base}/late'); engine('chrome'); wait('Go', state='enabled'); click('Go')`), /Late/);
    assert.match(await go('w5', `open('${base}/late'); engine('chrome'); wait('Hide me', state='hidden'); find('Saved')`), /Saved/);
    assert.match(await go('w6', `open('${base}/late'); engine('chrome'); wait('Later', state='visible'); find('Saved')`), /Saved/);
    const first = await go('w7', `open('${base}/late'); engine('chrome')`);
    const n = /\[Hide me\](\d+)/.exec(first);
    assert.ok(n, first);
    assert.match(await go('w7', `wait(${n[1]}, state='hidden'); find('Saved')`), /Saved/);
  });

  it('a timeout says what was awaited and what the page shows instead', async () => {
    const t = await go('w8', `${open()}; wait('Never appears', timeout=1)`);
    assert.match(t, /✗/);
    assert.match(t, /"Never appears" did not appear within|waited \d+ s for/);
    assert.match(t, /The page shows .*Shop/);
    const t2 = await go('w9', `${open()}; wait('Nope', 'Neither', url='/zzz', timeout=1)`);
    assert.match(t2, /any of "Nope", "Neither" to appear and the URL to match \/zzz/);
    assert.match(t2, /The page shows/);
  });

  it('works on the wire tier too (the page model is polled)', async () => {
    const t = await go('w10', `open('${base}/two'); wait('real two', 'zzz'); wait(gone='nothing here'); wait(url='/two')`);
    assert.doesNotMatch(t, /✗/);
    const bad = await go('w11', `open('${base}/two'); wait(url='/elsewhere', timeout=1)`);
    assert.match(bad, /the URL to match \/elsewhere/);
    assert.match(bad, /The page shows/);
  });
});

describe('emulation additions', { concurrency: false }, () => {
  it('motion, contrast and forced colors reach the media queries and persist', async () => {
    const q = "js('[matchMedia(\"(prefers-reduced-motion: reduce)\").matches, matchMedia(\"(prefers-contrast: more)\").matches, matchMedia(\"(forced-colors: active)\").matches]')";
    assert.match(await go('e1', `${open()}; ${q}`), /\[false,false,false\]/);
    assert.match(await go('e1', `emulate(motion='reduce', contrast='more', forced_colors=1); ${q}`), /\[true,true,true\]/);
    assert.match(await go('e1', q), /\[true,true,true\]/);
    assert.match(await go('e1', `emulate('reset'); ${q}`), /\[false,false,false\]/);
  });

  it('throttle slows requests down and cpu slows scripts', async () => {
    const fetchMs = "js('const t = performance.now(); await fetch(\"/api/cart\", {cache: \"no-store\"}); return Math.round(performance.now() - t)')";
    const fast = Number(/(?:^|\n)(\d+)\n/.exec(await go('e2', `${open()}; ${fetchMs}`))?.[1]);
    const slow = Number(/(?:^|\n)(\d+)\n/.exec(await go('e2', `emulate(throttle='slow3g'); ${fetchMs}`))?.[1]);
    assert.ok(slow > 1500 && slow > fast * 5, `fast ${fast} ms, slow3g ${slow} ms`);
    const off = Number(/(?:^|\n)(\d+)\n/.exec(await go('e2', `emulate(throttle='off'); ${fetchMs}`))?.[1]);
    assert.ok(off < 1000, `throttle off: ${off} ms`);

    const t = await go('e3', `${open()}; emulate(cpu=6); js('(()=>{let n=0;const t=performance.now();while(performance.now()-t<80){for(let i=0;i<2e4;i++)n++}return n})()')`);
    const slowN = Number(/(?:^|\n)(\d+)\n/.exec(t)?.[1]);
    const t0 = await go('e3', `emulate(cpu=1); js('(()=>{let n=0;const t=performance.now();while(performance.now()-t<80){for(let i=0;i<2e4;i++)n++}return n})()')`);
    const fastN = Number(/(?:^|\n)(\d+)\n/.exec(t0)?.[1]);
    assert.ok(fastN > slowN * 2, `iterations in 80 ms: cpu=1 ${fastN}, cpu=6 ${slowN}`);
  });

  it('permissions are granted to the session, and unknown ones are explained', async () => {
    const q = "js('const out = []; for (const n of [\"notifications\", \"clipboard-read\"]) out.push((await navigator.permissions.query({name: n})).state); return out')";
    assert.match(await go('e4', `${open()}; ${q}`), /\["prompt","prompt"\]|\["denied"/);
    assert.match(await go('e4', `emulate(permissions='clipboard-read,notifications'); ${q}`), /\["granted","granted"\]/);
    assert.match(await go('e4', "emulate(permissions='teleport')"), /unknown permission 'teleport'/);
    assert.match(await go('e4', `emulate(permissions='off'); ${q}`), /\["prompt","prompt"\]|\["denied"/);
  });

  it('says what it applied', async () => {
    const t = await go('e5', `${open()}; emulate(throttle='fast4g', cpu=2, motion='reduce')`);
    assert.match(t, /emulating .*fast4g.*cpu 2x slower.*reduced motion/);
    assert.match(await go('e5', "emulate(cpu=99)"), /cpu is a slowdown factor/);
    assert.match(await go('e5', "emulate(throttle='warp')"), /unknown network speed/);
  });
});

describe('drop and HAR', { concurrency: false }, () => {
  it('drop(target, path) drops a file from an allowed folder onto an element', async () => {
    const t = await go('dr1', `open('${base}/drop'); engine('chrome'); drop('drop zone', '${join(dir, 'report.csv')}'); find('dropped')`);
    assert.match(t, /dropped:report\.csv:8:a,b/);
    assert.match(t, /dropped report\.csv \(8 bytes\)/);
  });

  it('drop with inline text', async () => {
    assert.match(await go('dr2', `open('${base}/drop'); engine('chrome'); drop('drop zone', 'note.txt', text='hello'); find('dropped')`), /dropped:note\.txt:5:hello/);
  });

  it('refuses files outside the allowed folders and hidden files', async () => {
    assert.match(await go('dr3', `open('${base}/drop'); engine('chrome'); drop('drop zone', '/etc/hostname')`), /outside the folders/);
    writeFileSync(join(dir, '.env'), 'SECRET=1');
    assert.match(await go('dr3', `drop('drop zone', '${join(dir, '.env')}')`), /outside the folders/);
    assert.match(await go('dr3', `drop('drop zone', '${join(dir, 'missing.txt')}')`), /no such file/);
  });

  it('network(har=) writes a HAR 1.2 file under the downloads folder', async () => {
    const t = await go('har1', `${open()}; click('Load cart'); network(har='trace')`);
    const m = /saved HAR \((\d+) requests?\): (\S+\.har)/.exec(t);
    assert.ok(m, t);
    assert.ok(m[2].startsWith(dir));
    const har = JSON.parse(readFileSync(m[2], 'utf8'));
    assert.equal(har.log.version, '1.2');
    const urls = har.log.entries.map((e: any) => e.request.url);
    assert.ok(urls.some((u: string) => u.endsWith('/api/cart')), urls.join(' '));
    const cart = har.log.entries.find((e: any) => e.request.url.endsWith('/api/cart'));
    assert.equal(cart.response.status, 200);
    assert.equal(cart.request.method, 'GET');
  });
});
