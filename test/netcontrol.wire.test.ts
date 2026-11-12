// Session headers and basic-auth credentials on the HTTP tiers (wire, ghost), plus the pure helpers
// behind route(), wait() and the program parser. No browser needed.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentweb } from '../src/index.ts';
import { parseProgram } from '../src/dsl.ts';
import { buildHar, globToRegExp, matchRoute, normalizePattern, parseHeaderLine, parsePermissions, parseThrottle, urlMatcher } from '../src/netcontrol.ts';

const USER = 'alice';
const PASS = 'correct horse';

let server: Server;
let base = '';
let challenges = 0;
let rt: Awaited<ReturnType<typeof createAgentweb>>;
let ghostRt: Awaited<ReturnType<typeof createAgentweb>>;

before(async () => {
  server = createServer((q, s) => {
    if (q.url === '/echo') {
      s.writeHead(200, { 'content-type': 'application/json' });
      return void s.end(JSON.stringify({ debug: q.headers['x-debug'] ?? null, lang: q.headers['accept-language'], auth: q.headers.authorization ?? null, ua: q.headers['user-agent'] }));
    }
    if (q.url?.startsWith('/secret')) {
      const ok = q.headers.authorization === 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
      if (!ok) {
        challenges++;
        s.writeHead(401, { 'www-authenticate': 'Basic realm="lab"', 'content-type': 'text/html' });
        return void s.end('<title>Denied</title><p>login required</p>');
      }
      s.writeHead(200, { 'content-type': 'text/html' });
      return void s.end('<title>Vault</title><h1>welcome alice</h1>');
    }
    if (q.url === '/ghostpage') {
      s.writeHead(200, { 'content-type': 'text/html' });
      return void s.end(`<title>G</title><div id=o>loading</div><script>fetch('/echo').then(r=>r.json()).then(j=>{document.getElementById('o').textContent='debug='+j.debug+' auth='+j.auth})</script>`);
    }
    s.writeHead(200, { 'content-type': 'text/html' });
    s.end('<title>Home</title><h1>Home</h1>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const env = {
    AGENTWEB_ALLOW_PRIVATE: '1',
    AGENTWEB_NO_SANDBOX: '1',
    AGENTWEB_USAGE_LOG: '',
    AGENTWEB_ATLAS: '0',
    AGENTWEB_SECRET_LAB_PW: PASS,
    AGENTWEB_SECRET_LAB_PW_ORIGINS: base,
    AGENTWEB_SECRET_ELSEWHERE: PASS,
    AGENTWEB_SECRET_ELSEWHERE_ORIGINS: 'https://example.org',
  };
  rt = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, cache: false, env });
  ghostRt = await createAgentweb({ store: 'memory:', ghost: true, chrome: false, cache: false, env });
});

after(async () => {
  await rt.close?.();
  await ghostRt.close?.();
  server.close();
});

describe('headers() on the wire tier', () => {
  it('adds headers to every request and keeps them with the session', async () => {
    const r = await rt.run('h1', `headers('X-Debug: 1', 'Accept-Language: fr'); open('${base}/echo')`);
    assert.match(r.text, /\ndebug: 1\n/);
    assert.match(r.text, /\nlang: fr\n/);
    // a later call of the same session still sends them
    assert.match((await rt.run('h1', `open('${base}/echo'); find('debug')`)).text, /debug: 1/);
    // another session does not
    assert.doesNotMatch((await rt.run('h2', `open('${base}/echo')`)).text, /debug:/);
  });

  it('lists them with sensitive values masked, removes one, removes all', async () => {
    await rt.run('h3', "headers('X-Debug: 1', 'Authorization: Bearer abc123')");
    const t = (await rt.run('h3', 'headers()')).text;
    assert.match(t, /x-debug: 1|X-Debug: 1/i);
    assert.match(t, /Authorization: ••••/);
    assert.doesNotMatch(t, /abc123/);
    await rt.run('h3', "headers('X-Debug', off=1)");
    assert.doesNotMatch((await rt.run('h3', `open('${base}/echo')`)).text, /debug:/);
    await rt.run('h3', 'headers(off=1)');
    assert.match((await rt.run('h3', 'headers()')).text, /no extra headers/);
  });

  it('a second value for the same name replaces the first, and a bad header is explained', async () => {
    await rt.run('h4', "headers('X-Debug: 1'); headers('x-debug: 2')");
    assert.match((await rt.run('h4', `open('${base}/echo')`)).text, /\ndebug: 2\n/);
    assert.match((await rt.run('h4', "headers('no colon here')")).text, /not a header/);
    assert.match((await rt.run('h4', "headers('Host: evil.example')")).text, /cannot be overridden/);
    assert.match((await rt.run('h4', "headers('X-A: {{secret:lab_pw}}')")).text, /secret handles are not supported in headers/);
  });

  it('Playwright spellings parse', () => {
    assert.equal(parseProgram("setExtraHTTPHeaders({'X-A': 'b'})")[0].verb, 'headers');
    assert.equal(parseProgram("setExtraHTTPHeaders({'X-A': 'b'})")[0].opts['x-a'], 'b');
  });
});

describe('auth() on the wire tier', () => {
  it('answers a 401 challenge and never shows the password', async () => {
    const before = challenges;
    const r = await rt.run('a1', `auth('${USER}', '${PASS}'); open('${base}/secret')`);
    assert.match(r.text, /welcome alice/);
    assert.equal(challenges - before, 1, 'one challenge, then credentials');
    assert.doesNotMatch(r.text, new RegExp(PASS));
    assert.match(r.text, /basic credentials for alice/);
  });

  it('without credentials the 401 page is shown as it is', async () => {
    const r = await rt.run('a2', `open('${base}/secret')`);
    assert.match(r.text, /login required/);
  });

  it('wrong credentials: one retry, then the page and a note', async () => {
    const r = await rt.run('a3', `auth('${USER}', 'nope'); open('${base}/secret')`);
    assert.match(r.text, /login required/);
    assert.match(r.text, /rejected the credentials from auth\(\)/);
  });

  it('accepts a {{secret:name}} handle: revealed for its origin, still never shown', async () => {
    const r = await rt.run('a4', `auth('${USER}', '{{secret:lab_pw}}'); open('${base}/secret')`);
    assert.match(r.text, /welcome alice/);
    assert.doesNotMatch(r.text, new RegExp(PASS));
  });

  it('a handle bound to another origin is refused, not sent', async () => {
    const r = await rt.run('a5', `open('${base}/'); auth('${USER}', '{{secret:elsewhere}}')`);
    assert.match(r.text, /not allowed on/);
    const r2 = await rt.run('a6', `auth('${USER}', '{{secret:elsewhere}}'); open('${base}/secret')`);
    assert.match(r2.text, /login required|not allowed on/);
    assert.doesNotMatch(r2.text, /welcome/);
  });

  it('auth(origin=…) limits where the credentials go', async () => {
    const r = await rt.run('a7', `auth('${USER}', '${PASS}', origin='https://example.org'); open('${base}/secret')`);
    assert.match(r.text, /login required/, 'this origin was not named, so it does not get the password');
  });

  it('auth(off=1) forgets them', async () => {
    const r = await rt.run('a8', `auth('${USER}', '${PASS}'); auth(off=1); open('${base}/secret')`);
    assert.match(r.text, /login required/);
  });

  it('Playwright spelling parses', () => {
    assert.equal(parseProgram("setHTTPCredentials({username: 'u', password: 'p'})")[0].verb, 'auth');
  });
});

describe('headers() and auth() on the ghost tier', () => {
  it('page scripts fetch with the session headers and credentials', async () => {
    const r = await ghostRt.run('g1', `headers('X-Debug: ghost'); auth('${USER}', '${PASS}'); engine('ghost'); open('${base}/secret'); open('${base}/ghostpage'); find('debug=')`);
    assert.match(r.text, /debug=ghost/);
    assert.match(r.text, /welcome alice|debug=ghost auth=Basic /);
  });

  it('the document itself answers a challenge', async () => {
    const r = await ghostRt.run('g2', `auth('${USER}', '${PASS}'); engine('ghost'); open('${base}/secret')`);
    assert.match(r.text, /welcome alice/);
  });
});

describe('helpers', () => {
  it('globs match on the full URL', () => {
    assert.ok(globToRegExp('*/api/cart*').test('http://h:1/api/cart?x=1'));
    assert.ok(!globToRegExp('*/api/cart*').test('http://h:1/api/user'));
    assert.ok(globToRegExp('*.{png,jpg}').test('https://cdn.x/a/b.JPG'));
    assert.ok(!globToRegExp('*.png').test('https://cdn.x/a.png?v=1'));
    assert.ok(globToRegExp('**/v?/items').test('https://x/api/v2/items'));
    assert.equal(normalizePattern('/api/*'), '*/api/*');
    assert.equal(normalizePattern('api.example.com/x'), '*://api.example.com/x');
    assert.equal(normalizePattern('localhost:3000/api'), '*://localhost:3000/api');
    assert.ok(matchRoute([{ pattern: '/api/*', hits: 0, status: 500 }], 'http://x/api/a#frag', 'GET'));
  });

  it('the newest matching route wins and a method filter applies', () => {
    const routes = [
      { pattern: '*/api/*', status: 500, hits: 0 },
      { pattern: '*/api/user', status: 200, hits: 0 },
      { pattern: '*/api/*', method: 'POST', status: 201, hits: 0 },
    ];
    assert.equal(matchRoute(routes, 'http://x/api/user', 'GET')?.status, 200);
    assert.equal(matchRoute(routes, 'http://x/api/user', 'POST')?.status, 201);
    assert.equal(matchRoute(routes, 'http://x/api/other', 'GET')?.status, 500);
    assert.equal(matchRoute(routes, 'http://x/other', 'GET'), undefined);
  });

  it('url waits are substrings, or globs with *', () => {
    assert.ok(urlMatcher('/dashboard')('http://x/app/dashboard?a=1'));
    assert.ok(urlMatcher('**/dashboard')('http://x/app/dashboard'));
    assert.ok(!urlMatcher('**/dashboard')('http://x/app/dashboard/x'));
  });

  it('parsers', () => {
    assert.deepEqual(parseHeaderLine('X-Debug:  1 '), ['X-Debug', '1']);
    assert.equal(parseThrottle('Slow 3G'), 'slow3g');
    assert.equal(parseThrottle('off'), undefined);
    assert.throws(() => parseThrottle('warp'), /unknown network speed/);
    assert.deepEqual(parsePermissions('clipboard-read, notifications'), ['clipboard-read', 'notifications']);
    assert.throws(() => parsePermissions('teleport'), /unknown permission/);
  });

  it('a HAR has the fields tools expect', () => {
    const har = JSON.parse(buildHar('http://x/', 'T', [{ method: 'GET', url: 'http://x/a?b=1', type: 'Fetch', status: 200, failed: '', wall: 1_700_000_000_000, ms: 12.4, resHeaders: { 'content-type': 'text/plain' }, mime: 'text/plain', size: 5 }]));
    assert.equal(har.log.version, '1.2');
    assert.equal(har.log.entries.length, 1);
    assert.equal(har.log.entries[0].request.queryString[0].name, 'b');
    assert.equal(har.log.entries[0].response.content.mimeType, 'text/plain');
    assert.equal(har.log.entries[0].time, 12);
  });

  it('new verbs and aliases parse; init keeps its code verbatim', () => {
    assert.equal(parseProgram("mock('*/api/*', status=500)")[0].verb, 'route');
    assert.equal(parseProgram("unroute('*/api/*')")[0].opts.off, 1);
    assert.equal(parseProgram("addInitScript('window.a = /\\d+/.test(\"1\")')")[0].args[0], 'window.a = /\\d+/.test("1")');
    assert.equal(parseProgram("init('window.__TEST__ = true')")[0].verb, 'init');
    assert.equal(parseProgram('init(off=1)')[0].opts.off, 1);
    const w = parseProgram("wait(url='/dashboard'); wait('Saved', 'Failed'); wait(gone='Loading'); wait(12, state='hidden'); waitForURL('**/x')");
    assert.equal(w[0].opts.url, '/dashboard');
    assert.deepEqual(w[1].args, ['Saved', 'Failed']);
    assert.equal(w[2].opts.gone, 'Loading');
    assert.equal(w[3].opts.state, 'hidden');
    assert.equal(w[4].opts.url, '**/x');
    assert.equal(parseProgram("har('trace')")[0].opts.har, 'trace');
  });
});
