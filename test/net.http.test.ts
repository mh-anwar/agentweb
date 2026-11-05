import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createWireEngine, type WireEngine } from '../src/net/http.ts';
import { text } from '../src/tree.ts';
import { AwError } from '../src/types.ts';
import { fakeGuard, makeCtx } from './fixtures/net/helpers.ts';
import { GBK_TEXT, SJIS_TEXT, startFixture, type Fixture } from './fixtures/net/server.ts';

let fx: Fixture;
let eng: WireEngine;
const resolve = async (host: string) => {
  if (host === 'localhost' || host.endsWith('.example.test') || host === 'example.test' || host === 'rebind.test') return [{ address: '127.0.0.1', family: 4 as const }];
  throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
};

before(async () => {
  fx = await startFixture();
  eng = createWireEngine({ resolve, retryAfterCapMs: 2000 });
});
after(async () => {
  await eng.close();
  await fx.close();
});

const open = (path: string, over: Parameters<typeof makeCtx>[0] = {}, req: Partial<Parameters<WireEngine['open']>[1]> = {}) =>
  eng.open(makeCtx(over), { url: path.startsWith('http') ? path : fx.base + path, ...req });
const isErr = (code: string, re?: RegExp) => (e: unknown) => e instanceof AwError && e.code === code && (!re || re.test(e.message));

describe('basics', () => {
  test('HTML is parsed into a Doc with metadata', async () => {
    const r = await open('/hello');
    assert.equal(r.status, 200);
    assert.equal(r.contentType, 'text/html');
    assert.equal(r.method, 'GET');
    assert.equal(r.doc!.meta.title, 'Hello');
    assert.match(text(r.doc!.root), /Hello world/);
    assert.equal(r.headers!['content-type'], 'text/html; charset=utf-8');
    assert.ok(r.bytes > 0 && r.ms >= 0);
    assert.equal(r.escalate, undefined);
  });

  test('request headers: UA from ctx, Accept-Language, Accept by intent, merged extras', async () => {
    const a = JSON.parse((await open('/echo', {}, { headers: { 'X-Thing': '1', Host: 'evil' } })).body!.text!);
    assert.equal(a.headers['user-agent'], 'agentweb-test/1.0');
    assert.match(a.headers['accept-language'], /^en-US/);
    assert.match(a.headers.accept, /^text\/html/);
    assert.match(a.headers['accept-encoding'], /gzip/);
    assert.equal(a.headers['x-thing'], '1');
    assert.equal(a.host, '127.0.0.1', 'Host cannot be overridden');
    const b = JSON.parse((await open('/echo', {}, { read: true })).body!.text!);
    assert.equal(b.headers.accept, 'text/markdown, text/html;q=0.9, application/json;q=0.8, */*;q=0.5');
  });

  test('markdown negotiation with read intent', async () => {
    const md = await open('/doc', {}, { read: true });
    assert.equal(md.contentType, 'text/markdown');
    assert.equal(md.body!.text, '# Doc\n\nMarkdown body.\n');
    assert.equal(md.doc, undefined);
    const html = await open('/doc');
    assert.equal(html.contentType, 'text/html');
    assert.equal(html.doc!.meta.title, 'Doc');
  });

  test('invalid and non-http URLs', async () => {
    await assert.rejects(eng.open(makeCtx(), { url: 'not a url' }), isErr('bad_request'));
    await assert.rejects(eng.open(makeCtx(), { url: 'ftp://x/' }), isErr('unsupported'));
  });

  test('userinfo in the URL becomes Basic auth and is stripped', async () => {
    const r = await open(`http://u%40x:p%3Aw@127.0.0.1:${fx.port}/echo`);
    const j = JSON.parse(r.body!.text!);
    assert.equal(j.headers.authorization, 'Basic ' + Buffer.from('u@x:p:w').toString('base64'));
    assert.ok(!r.url.includes('@'));
  });
});

describe('redirects', () => {
  test('follows a chain of 10 but not 11', async () => {
    const r = await open('/chain/10');
    assert.equal(r.url, fx.base + '/chain/0');
    assert.equal(r.doc!.meta.title, 'end of chain');
    await assert.rejects(open('/chain/11'), isErr('net', /too many redirects/));
  });

  test('detects loops, but a cookie-setting self-redirect is not a loop', async () => {
    await assert.rejects(open('/loop/a'), isErr('net', /redirect loop/));
    await assert.rejects(open('/self-loop'), isErr('net', /redirect loop/));
    const r = await open('/self-cookie');
    assert.equal(r.doc!.meta.title, 'ok');
  });

  test('303 turns POST into GET and drops the body', async () => {
    const r = await open('/post-303', {}, { method: 'POST', body: 'a=1', contentType: 'application/x-www-form-urlencoded' });
    const j = JSON.parse(r.body!.text!);
    assert.equal(j.method, 'GET');
    assert.equal(j.body, '');
    assert.equal(j.headers['content-type'], undefined);
    assert.equal(r.method, 'GET');
    assert.equal(fx.last.get('/post-303')!.body, 'a=1');
  });

  test('302 POST becomes GET; 307 and 308 preserve method and body', async () => {
    const r302 = JSON.parse((await open('/post-302', {}, { method: 'POST', body: 'x=1', contentType: 'text/plain' })).body!.text!);
    assert.equal(r302.method, 'GET');
    for (const p of ['/post-307', '/post-308']) {
      const r = await open(p, {}, { method: 'POST', body: new TextEncoder().encode('payload=1'), contentType: 'application/x-www-form-urlencoded' });
      const j = JSON.parse(r.body!.text!);
      assert.equal(j.method, 'POST', p);
      assert.equal(j.body, 'payload=1', p);
      assert.equal(j.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(r.method, 'POST');
    }
  });

  test('Referer: same-origin full URL, cross-origin origin only, none on downgrade', async () => {
    const j = JSON.parse((await open('/goto?to=/echo')).body!.text!);
    assert.equal(j.headers.referer, `${fx.base}/goto?to=/echo`);
    const cross = JSON.parse((await open(`/goto?to=${encodeURIComponent(`http://a.example.test:${fx.port}/echo`)}`)).body!.text!);
    assert.equal(cross.headers.referer, `${fx.base}/`);
    const init = JSON.parse((await open('/echo', {}, { referer: 'https://secure.example/page#frag' })).body!.text!);
    assert.equal(init.headers.referer, undefined, 'https → http sends no Referer');
  });

  test('fragment is inherited across a redirect', async () => {
    const r = await open('/frag#sec');
    assert.equal(r.url, fx.base + '/hello#sec');
  });

  test('redirect to a non-http scheme is refused', async () => {
    await assert.rejects(open('/goto?to=' + encodeURIComponent('javascript:alert(1)')), isErr('unsupported'));
  });

  test('guard is consulted for every hop and can refuse a redirect', async () => {
    const guard = fakeGuard((url, why) => (why === 'redirect' && url.includes('/chain/1') ? 'internal path' : undefined));
    const before = fx.hit('/chain/1');
    await assert.rejects(open('/chain/3', { guard }), isErr('policy', /internal path/));
    assert.deepEqual(guard.calls.map((c) => c.why), ['open', 'redirect', 'redirect']);
    assert.equal(fx.hit('/chain/1'), before, 'refused hop was never requested');
    const g2 = fakeGuard((_u, why) => (why === 'open' ? 'nope' : undefined));
    await assert.rejects(open('/hello', { guard: g2 }), isErr('policy', /nope/));
  });
});

describe('cookies', () => {
  test('set on a redirect hop, sent on the next hop, across subdomains', async () => {
    const ctx = makeCtx();
    const r = await eng.open(ctx, { url: `http://a.example.test:${fx.port}/login` });
    const j = JSON.parse(r.body!.text!);
    assert.equal(j.host, 'b.example.test');
    // the host-only cookie for a. is not sent to b.; the Domain=example.test cookie is
    assert.equal(j.headers.cookie, 'wide=yes');
    const names = ctx.jar.all().map((c) => c.name).sort();
    assert.deepEqual(names, ['host', 'wide'], 'Secure cookie from http refused; Max-Age=0 not stored');
    assert.equal(ctx.jar.header(`http://a.example.test:${fx.port}/`), 'host=only; wide=yes');
    // and the jar's cookies go out on later requests
    const again = JSON.parse((await eng.open(ctx, { url: `http://a.example.test:${fx.port}/echo` })).body!.text!);
    assert.equal(again.headers.cookie, 'host=only; wide=yes');
  });

  test('cookies for a bare public suffix are rejected', async () => {
    const ctx = makeCtx();
    await eng.open(ctx, { url: `http://a.example.test:${fx.port}/suffix-cookie` });
    assert.deepEqual(ctx.jar.all().map((c) => c.name), ['ok']);
  });

  test('Cookie header from req.headers is merged with the jar and dropped cross-origin', async () => {
    const ctx = makeCtx();
    ctx.jar.setFromHeaders(fx.base + '/', ['j=1']);
    const r = JSON.parse((await eng.open(ctx, { url: fx.base + '/echo', headers: { cookie: 'x=2', authorization: 'Bearer t' } })).body!.text!);
    assert.equal(r.headers.cookie, 'j=1; x=2');
    const cross = JSON.parse((await eng.open(ctx, { url: `${fx.base}/goto?to=${encodeURIComponent(`http://a.example.test:${fx.port}/echo`)}`, headers: { cookie: 'x=2', authorization: 'Bearer t' } })).body!.text!);
    assert.equal(cross.headers.cookie, undefined);
    assert.equal(cross.headers.authorization, undefined);
  });
});

describe('charsets', () => {
  const T = 'Café “quoted” €5 naïve';
  for (const [path, expect] of [
    ['/cs/header-latin1', T],
    ['/cs/meta-1252', T],
    ['/cs/http-equiv', T],
    ['/cs/utf16le', T],
    ['/cs/utf16be-wrong-header', T],
    ['/cs/undeclared-1252', T],
    ['/cs/utf8', T],
    ['/cs/sjis', SJIS_TEXT],
    ['/cs/sjis-meta', SJIS_TEXT],
    ['/cs/gbk', GBK_TEXT],
  ] as const) {
    test(path, async () => {
      const r = await open(path);
      assert.equal(r.doc!.meta.title, expect);
    });
  }
  test('json with a header charset', async () => {
    const r = await open('/cs/json-latin1');
    assert.equal(r.contentType, 'application/json');
    assert.equal(JSON.parse(r.body!.text!).t, T);
  });
});

describe('content encodings', () => {
  for (const k of ['gzip', 'br', 'deflate', 'deflate-raw', 'zstd', 'gzip-br']) {
    test(k, async () => {
      const r = await open(`/z/${k}`);
      assert.equal(r.doc!.meta.title, `compressed ${k}`);
      assert.ok(r.bytes > 2000);
    });
  }
  test('truncated gzip still yields the decoded prefix', async () => {
    const r = await open('/z/gzip-truncated');
    assert.equal(r.doc!.meta.title, 'compressed gzip-truncated');
  });
  test('corrupt gzip is a net error', async () => {
    await assert.rejects(open('/z/gzip-corrupt'), isErr('net', /corrupt gzip/));
  });
  test('decompression bomb is capped at the body limit', async () => {
    const e = createWireEngine({ resolve, maxBodyBytes: 1024 * 1024 });
    try {
      const r = await e.open(makeCtx(), { url: fx.base + '/bomb' });
      assert.equal(r.bytes, 1024 * 1024);
      assert.ok(r.events!.some((x) => /truncated at 1 MB/.test(x)));
      await assert.rejects(e.open(makeCtx(), { url: fx.base + '/bomb?type=application/json' }), isErr('too_large'));
    } finally {
      await e.close();
    }
  });
});

describe('size limits', () => {
  test('HTML over the limit is truncated with an event', async () => {
    const r = await open('/big?n=9000000');
    assert.equal(r.bytes, 8 * 1024 * 1024);
    assert.ok(r.events!.some((x) => /truncated at 8 MB/.test(x)));
    assert.ok(r.doc);
  });
  test('non-HTML over the limit throws too_large (by Content-Length, and when chunked)', async () => {
    await assert.rejects(open('/big?n=9000000&type=application/json'), isErr('too_large', /8\.6 MB/));
    await assert.rejects(open('/big?n=9000000&type=application/pdf&chunked'), isErr('too_large'));
  });
  test('under the limit is fine; binary types come back as bytes', async () => {
    const r = await open('/big?n=5000&type=application/pdf');
    assert.equal(r.body!.bytes!.length, 5000);
    assert.equal(r.body!.text, undefined);
  });
});

describe('timeouts, aborts and network failures', () => {
  test('total timeout', async () => {
    const t0 = Date.now();
    await assert.rejects(open('/slow?ms=3000', { timeoutMs: 200 }), isErr('timeout', /timed out after 200 ms/));
    assert.ok(Date.now() - t0 < 1000);
  });
  test('timeout while the body stalls', async () => {
    await assert.rejects(open('/stall', { timeoutMs: 300 }), isErr('timeout'));
  });
  test('caller abort', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(open('/slow?ms=3000', { signal: ac.signal }), isErr('timeout', /aborted/));
  });
  test('connection refused', async () => {
    await assert.rejects(open('http://127.0.0.1:1/'), isErr('net', /connection refused/));
  });
  test('DNS failure', async () => {
    await assert.rejects(open('http://nope.invalid/'), isErr('net', /DNS lookup failed for nope\.invalid/));
  });
  test('reset before headers', async () => {
    await assert.rejects(open('/reset'), isErr('net', /reset|closed/));
  });
  test('connection cut mid-body: HTML keeps the prefix, JSON fails', async () => {
    const r = await open('/cut');
    assert.equal(r.doc!.meta.title, 'cut');
    assert.ok(r.events!.some((x) => /showing the first/.test(x)));
    await assert.rejects(open('/cut?type=application/json'), isErr('net'));
  });
});

describe('connect-time address check', () => {
  test('refuses a hostname that resolves to a disallowed address at connect time', async () => {
    // the guard (policy check) allows the URL; the address is only known at connect time
    const seen: string[] = [];
    const e = createWireEngine({ resolve, checkAddress: (ip, host) => { seen.push(`${host}=${ip}`); return !ip.startsWith('127.'); } });
    try {
      await assert.rejects(e.open(makeCtx(), { url: `http://rebind.test:${fx.port}/hello` }), isErr('policy', /rebind\.test resolves to a disallowed address \(127\.0\.0\.1\)/));
      await assert.rejects(e.open(makeCtx(), { url: `${fx.base}/hello` }), isErr('policy', /127\.0\.0\.1/), 'IP literal hosts are checked too');
      assert.ok(seen.includes('rebind.test=127.0.0.1'));
      assert.equal(e.stats().addressRefused, 2);
    } finally {
      await e.close();
    }
  });
  test('DNS rebinding: the address checked is the address connected to', async () => {
    let n = 0;
    // first answer public (what a policy check would see), every later answer private
    const flip = async () => [{ address: n++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 as const }];
    const e = createWireEngine({ resolve: flip, dnsCacheMs: 0, checkAddress: (ip) => !ip.startsWith('127.') });
    try {
      await flip(); // simulate the guard's own lookup consuming the "public" answer
      const before = fx.hit('/hello');
      await assert.rejects(e.open(makeCtx(), { url: `http://flip.test:${fx.port}/hello` }), isErr('policy'));
      assert.equal(fx.hit('/hello'), before, 'nothing reached the private address');
    } finally {
      await e.close();
    }
  });
  test('allowed addresses connect normally', async () => {
    const e = createWireEngine({ resolve, checkAddress: () => true });
    try {
      assert.equal((await e.open(makeCtx(), { url: `http://a.example.test:${fx.port}/hello` })).status, 200);
    } finally {
      await e.close();
    }
  });
});

describe('TLS', () => {
  test('self-signed certificate is a short TLS error; a trusted CA works', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-net-tls-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
    } catch {
      t.skip('openssl not available');
      return;
    }
    const cert = readFileSync(join(dir, 'c.pem'));
    const srv = https.createServer({ key: readFileSync(join(dir, 'k.pem')), cert }, (_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<title>tls ok</title>'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    t.after(() => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }));
    await assert.rejects(open(`https://localhost:${port}/`), isErr('net', /TLS error with localhost:\d+: self-signed certificate/));
    const e = createWireEngine({ resolve, tls: { ca: cert } });
    try {
      const r = await e.open(makeCtx(), { url: `https://localhost:${port}/` });
      assert.equal(r.doc!.meta.title, 'tls ok');
    } finally {
      await e.close();
    }
  });
});

describe('sniffing and classification', () => {
  const cases: [string, string, 'doc' | 'text' | 'bytes'][] = [
    ['/sniff/html-noct', 'text/html', 'doc'],
    ['/sniff/html-octet', 'text/html', 'doc'],
    ['/sniff/json-noct', 'application/json', 'text'],
    ['/sniff/pdf-octet', 'application/pdf', 'bytes'],
    ['/sniff/pdf-plain', 'application/pdf', 'bytes'],
    ['/sniff/xhtml-xml', 'application/xhtml+xml', 'doc'],
    ['/sniff/xhtml', 'application/xhtml+xml', 'doc'],
    ['/sniff/rss', 'application/rss+xml', 'text'],
    ['/sniff/csv', 'text/csv', 'text'],
    ['/sniff/md.md', 'text/markdown', 'text'],
    ['/sniff/png', 'image/png', 'bytes'],
    ['/sniff/weird-ct', 'text/html', 'doc'],
  ];
  for (const [p, ct, where] of cases) {
    test(p, async () => {
      const r = await open(p);
      assert.equal(r.contentType, ct);
      if (where === 'doc') assert.ok(r.doc && !r.body);
      if (where === 'text') assert.ok(typeof r.body?.text === 'string' && !r.doc);
      if (where === 'bytes') assert.ok(r.body?.bytes instanceof Uint8Array && r.body.text === undefined);
    });
  }
});

describe('bot walls', () => {
  const walls: [string, string | undefined][] = [
    ['cloudflare', 'cloudflare'],
    ['cloudflare-body', 'cloudflare'],
    ['datadome', 'datadome'],
    ['perimeterx', 'perimeterx'],
    ['akamai', 'akamai'],
    ['imperva', 'imperva'],
    ['captcha', 'captcha'],
    ['google-sorry', 'captcha'],
    ['js-403', '403 challenge'],
    ['contact-form', undefined],
    ['plain-403', undefined],
  ];
  for (const [k, vendor] of walls) {
    test(k, async () => {
      const r = await open(`/wall/${k}`);
      assert.equal(r.escalate, vendor ? `bot wall (${vendor})` : undefined);
      assert.ok(r.doc, 'the response is still returned');
    });
  }
});

describe('Retry-After', () => {
  test('429 with a short Retry-After is retried once', async () => {
    const t0 = Date.now();
    const r = await open('/busy?k=a&ra=1');
    assert.equal(r.status, 200);
    assert.equal(r.doc!.meta.title, 'finally');
    assert.ok(Date.now() - t0 >= 900);
    assert.equal(fx.hit('/busy'), 2);
  });
  test('503 with an HTTP-date Retry-After', async () => {
    const r = await open(`/busy?k=b&s=503&ra=${encodeURIComponent(new Date(Date.now() + 500).toUTCString())}`);
    assert.equal(r.status, 200);
  });
  test('a long Retry-After is not waited for', async () => {
    const t0 = Date.now();
    const r = await open('/busy?k=c&ra=120');
    assert.equal(r.status, 429);
    assert.equal(r.escalate, 'bot wall (rate limited 429)');
    assert.ok(Date.now() - t0 < 500);
  });
  test('POST is never retried', async () => {
    const r = await open('/busy?k=d&ra=1', {}, { method: 'POST', body: 'x' });
    assert.equal(r.status, 429);
  });
});

describe('politeness', () => {
  test('engine holds a slot per origin request (cap 2)', async () => {
    const e = createWireEngine({ resolve, polite: { perOrigin: 2 } });
    try {
      const t0 = Date.now();
      await Promise.all(Array.from({ length: 6 }, () => e.open(makeCtx(), { url: fx.base + '/slow?ms=100' })));
      const dt = Date.now() - t0;
      assert.ok(dt >= 290, `6 requests at 2 concurrent x 100 ms take >= 300 ms (took ${dt})`);
      assert.equal(e.stats().polite_granted, 6);
      assert.equal(e.stats().polite_waited, 4);
    } finally {
      await e.close();
    }
  });
});

describe('stats', () => {
  test('counters are exposed', async () => {
    const s = eng.stats();
    for (const k of ['opens', 'hops', 'redirects', 'originRequests', 'bytesIn', 'errors', 'botWalls', 'retries', 'polite_granted']) assert.equal(typeof s[k], 'number', k);
    assert.ok(s.opens > 10 && s.redirects > 10 && s.botWalls >= 8);
  });
});
