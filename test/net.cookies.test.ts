import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createJar, defaultPath, parseCookieDate, parseSetCookie, pathMatch } from '../src/net/cookies.ts';

const T0 = Date.UTC(2026, 0, 1);

test('host-only vs domain cookies', () => {
  const jar = createJar();
  jar.setFromHeaders('https://www.example.com/', ['a=1', 'b=2; Domain=example.com', 'c=3; Domain=.EXAMPLE.com']);
  assert.equal(jar.header('https://www.example.com/'), 'a=1; b=2; c=3');
  assert.equal(jar.header('https://example.com/'), 'b=2; c=3');
  assert.equal(jar.header('https://api.example.com/x'), 'b=2; c=3');
  assert.equal(jar.header('https://deep.www.example.com/'), 'b=2; c=3');
  assert.equal(jar.header('https://notexample.com/'), '');
  assert.equal(jar.header('https://example.com.evil.net/'), '');
  const all = jar.all();
  assert.equal(all.find((c) => c.name === 'a')!.hostOnly, true);
  assert.equal(all.find((c) => c.name === 'b')!.hostOnly, false);
});

test('rejects Domain that does not domain-match, and public suffixes', () => {
  const jar = createJar();
  jar.setFromHeaders('https://a.example.com/', [
    'x=1; Domain=other.com',
    'y=1; Domain=com',
    'z=1; Domain=co.uk',
    'w=1; Domain=b.example.com',
  ]);
  assert.equal(jar.all().length, 0);
  jar.setFromHeaders('https://user.github.io/', ['gh=1; Domain=github.io']);
  assert.equal(jar.all().length, 0, 'shared-hosting suffix');
  jar.setFromHeaders('https://shop.example.co.uk/', ['uk=1; Domain=example.co.uk']);
  assert.equal(jar.header('https://www.example.co.uk/'), 'uk=1');
  // Domain equal to a public-suffix host becomes host-only
  jar.setFromHeaders('http://localhost/', ['lh=1; Domain=localhost']);
  assert.equal(jar.header('http://localhost/'), 'lh=1');
  assert.equal(jar.all().find((c) => c.name === 'lh')!.hostOnly, true);
});

test('IP hosts: no domain cookies except the exact IP', () => {
  const jar = createJar();
  jar.setFromHeaders('http://10.0.0.1/', ['a=1', 'b=1; Domain=0.0.1', 'c=1; Domain=10.0.0.1']);
  assert.equal(jar.header('http://10.0.0.1/'), 'a=1; c=1');
  assert.equal(jar.header('http://0.0.1/'), '');
});

test('path matching and default path', () => {
  assert.equal(defaultPath('/a/b/c'), '/a/b');
  assert.equal(defaultPath('/a'), '/');
  assert.equal(defaultPath(''), '/');
  assert.ok(pathMatch('/docs/x', '/docs'));
  assert.ok(pathMatch('/docs/', '/docs/'));
  assert.ok(!pathMatch('/docsx', '/docs'));
  const jar = createJar();
  jar.setFromHeaders('https://e.com/shop/cart/view', ['dflt=1', 'root=1; Path=/', 'shop=1; Path=/shop', 'bad=1; Path=relative']);
  assert.equal(jar.header('https://e.com/shop/cart/x'), 'dflt=1; bad=1; shop=1; root=1', 'a relative Path falls back to the default path');
  assert.equal(jar.header('https://e.com/shop'), 'shop=1; root=1');
  assert.equal(jar.header('https://e.com/other'), 'root=1');
});

test('ordering: longer paths first, then creation order; replacement keeps creation time', () => {
  const jar = createJar();
  jar.setFromHeaders('https://e.com/', ['z=1; Path=/', 'a=1; Path=/', 'm=1; Path=/a/b', 'k=1; Path=/a']);
  assert.equal(jar.header('https://e.com/a/b/c'), 'm=1; k=1; z=1; a=1');
  jar.setFromHeaders('https://e.com/', ['z=2; Path=/']);
  assert.equal(jar.header('https://e.com/a/b/c'), 'm=1; k=1; z=2; a=1');
  // same name, different path = different cookie
  jar.setFromHeaders('https://e.com/', ['z=3; Path=/a']);
  assert.equal(jar.header('https://e.com/a/'), 'k=1; z=3; z=2; a=1');
});

test('Secure: never sent over http, never set from http; loopback counts as secure', () => {
  const jar = createJar();
  jar.setFromHeaders('https://e.com/', ['s=1; Secure', 'p=1']);
  assert.equal(jar.header('http://e.com/'), 'p=1');
  assert.equal(jar.header('https://e.com/'), 's=1; p=1');
  jar.setFromHeaders('http://e.com/', ['s2=1; Secure']);
  assert.ok(!jar.all().some((c) => c.name === 's2'));
  // an insecure origin cannot shadow a secure cookie
  jar.setFromHeaders('http://e.com/', ['s=evil']);
  assert.equal(jar.header('https://e.com/'), 's=1; p=1');
  jar.setFromHeaders('http://localhost:3000/', ['ls=1; Secure']);
  assert.equal(jar.header('http://localhost:3000/'), 'ls=1');
});

test('Max-Age wins over Expires; expired cookies delete and are evicted', () => {
  let now = T0;
  const jar = createJar(undefined, { now: () => now });
  jar.setFromHeaders('https://e.com/', [
    'a=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Max-Age=10',
    'b=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT',
    'c=1; Max-Age=100; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'd=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'e=1; Max-Age=abc',
  ]);
  assert.equal(jar.header('https://e.com/'), 'a=1; b=1; c=1; e=1');
  const a = jar.all().find((c) => c.name === 'a')!;
  assert.equal(a.expires, T0 / 1000 + 10);
  const b = jar.all().find((c) => c.name === 'b')!;
  assert.equal(b.expires, T0 / 1000 + 400 * 86400, 'lifetime capped at 400 days');
  assert.equal(jar.all().find((c) => c.name === 'e')!.expires, undefined, 'bad Max-Age ignored = session cookie');
  now += 11_000;
  assert.equal(jar.header('https://e.com/'), 'b=1; c=1; e=1');
  jar.setFromHeaders('https://e.com/', ['b=x; Max-Age=0']);
  assert.equal(jar.header('https://e.com/'), 'c=1; e=1');
  jar.setFromHeaders('https://e.com/', ['c=x; Max-Age=-5']);
  assert.equal(jar.header('https://e.com/'), 'e=1');
});

test('SameSite parsing and SameSite=None requires Secure', () => {
  const jar = createJar();
  jar.setFromHeaders('https://e.com/', ['a=1; SameSite=strict', 'b=1; SameSite=LAX', 'c=1; SameSite=None; Secure', 'd=1; SameSite=bogus', 'e=1; SameSite=None']);
  const by = Object.fromEntries(jar.all().map((c) => [c.name, c.sameSite]));
  assert.deepEqual(by, { a: 'Strict', b: 'Lax', c: 'None', d: undefined });
});

test('__Host- and __Secure- prefixes', () => {
  const jar = createJar();
  jar.setFromHeaders('https://www.e.com/x/y', [
    '__Secure-ok=1; Secure',
    '__Secure-bad=1',
    '__Host-ok=1; Secure; Path=/',
    '__Host-nopath=1; Secure',
    '__Host-domain=1; Secure; Path=/; Domain=e.com',
    '__Host-insecure=1; Path=/',
    '__host-lower=1; Path=/',
    '=__Host-sneaky=1',
  ]);
  assert.deepEqual(jar.all().map((c) => c.name).sort(), ['__Host-ok', '__Secure-ok']);
});

test('HttpOnly is kept; nameless cookies; control chars rejected; size limit', () => {
  const jar = createJar();
  jar.setFromHeaders('https://e.com/', ['h=1; HttpOnly', 'justavalue', 'bad=a\x01b', `big=${'x'.repeat(5000)}`, '  spaced  =  v  ']);
  assert.equal(jar.all().find((c) => c.name === 'h')!.httpOnly, true);
  assert.equal(jar.header('https://e.com/'), 'h=1; justavalue; spaced=v');
});

test('per-domain cap evicts least recently used; total cap', () => {
  let now = T0;
  const jar = createJar(undefined, { perDomain: 3, total: 5, now: () => now++ });
  jar.setFromHeaders('https://a.e.com/', ['a=1', 'b=1', 'c=1']);
  jar.header('https://a.e.com/'); // touch all
  now += 10;
  jar.setFromHeaders('https://e.com/', ['d=1']); // same registrable domain e.com
  assert.equal(jar.all().filter((c) => c.domain.endsWith('e.com')).length, 3);
  jar.setFromHeaders('https://x.org/', ['x1=1', 'x2=1']);
  jar.setFromHeaders('https://y.net/', ['y1=1']);
  assert.equal(jar.all().length, 5);
  assert.ok(jar.all().some((c) => c.name === 'y1'), 'newest kept');
});

test('round-trip all() -> createJar() preserves cookies and order', () => {
  const jar = createJar();
  jar.setFromHeaders('https://www.e.com/p/q', ['a=1; Path=/', 'b=2; Domain=e.com; Secure; HttpOnly; SameSite=Lax; Max-Age=3600', 'c=3']);
  jar.setFromHeaders('https://other.org/', ['o=1; Expires=Thu, 01 Jan 2099 00:00:00 GMT']);
  const data = jar.all();
  const jar2 = createJar(JSON.parse(JSON.stringify(data)));
  assert.deepEqual(jar2.all(), data);
  for (const u of ['https://www.e.com/p/q', 'https://e.com/', 'http://www.e.com/', 'https://other.org/']) assert.equal(jar2.header(u), jar.header(u), u);
});

test('merge() upserts browser cookies (leading-dot domains) and has()/clear()', () => {
  const jar = createJar();
  jar.setFromHeaders('https://e.com/', ['sid=old']);
  jar.merge([
    { name: 'sid', value: 'new', domain: 'e.com', path: '/', hostOnly: true },
    { name: 'wide', value: '1', domain: '.e.com', path: '/' },
  ]);
  assert.equal(jar.header('https://e.com/'), 'sid=new; wide=1');
  assert.equal(jar.header('https://sub.e.com/'), 'wide=1');
  assert.ok(jar.has('https://sub.e.com/'));
  assert.ok(!jar.has('https://nope.com/'));
  jar.clear();
  assert.equal(jar.all().length, 0);
});

test('cookie date parsing (RFC 6265 5.1.1)', () => {
  assert.equal(parseCookieDate('Wed, 21 Oct 2015 07:28:00 GMT'), Date.UTC(2015, 9, 21, 7, 28, 0));
  assert.equal(parseCookieDate('Sunday, 06-Nov-94 08:49:37 GMT'), Date.UTC(1994, 10, 6, 8, 49, 37));
  assert.equal(parseCookieDate('Sun Nov  6 08:49:37 1994'), Date.UTC(1994, 10, 6, 8, 49, 37));
  assert.equal(parseCookieDate('Tue, 1-Jan-30 00:00:01 UTC'), Date.UTC(2030, 0, 1, 0, 0, 1));
  assert.equal(parseCookieDate('30 Feb 2025 00:00:00'), undefined);
  assert.equal(parseCookieDate('nonsense'), undefined);
  assert.equal(parseSetCookie('a=b; Expires=garbage')!.expires, undefined);
});

test('non-ASCII domains are canonicalised to punycode', () => {
  const jar = createJar();
  jar.setFromHeaders('https://www.bücher.de/', ['a=1; Domain=bücher.de']);
  assert.equal(jar.header('https://shop.xn--bcher-kva.de/'), 'a=1');
});
