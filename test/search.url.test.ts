import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUrl, hostOf, unwrap, urlKey } from '../src/search/index.ts';
import { underDomain } from '../src/search/url.ts';

test('cleanUrl table', () => {
  const cases: [string, string][] = [
    // tracking parameters
    ['https://example.com/a?utm_source=x&utm_medium=y&id=3', 'https://example.com/a?id=3'],
    ['https://example.com/a?id=3&fbclid=abc', 'https://example.com/a?id=3'],
    ['https://example.com/a?gclid=1&msclkid=2&dclid=3&gbraid=4&wbraid=5', 'https://example.com/a'],
    ['https://example.com/a?ref=hn', 'https://example.com/a'],
    ['https://example.com/a?ref_src=twsrc&_hsenc=x&__hstc=y&mc_cid=1&mc_eid=2', 'https://example.com/a'],
    ['https://example.com/a?pk_campaign=a&mtm_source=b&_ga=1.2&_gl=x&igshid=q&yclid=1', 'https://example.com/a'],
    ['https://example.com/a?UTM_Source=caps', 'https://example.com/a'],
    ['https://example.com/a?q=rust%20async&page=2', 'https://example.com/a?q=rust%20async&page=2'],
    ['https://example.com/search?q=a+b&utm_campaign=z', 'https://example.com/search?q=a+b'],
    // host-specific: si is tracking on YouTube, not elsewhere
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=AbC123&feature=shared', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=AbC123&t=42', 'https://youtu.be/dQw4w9WgXcQ?t=42'],
    ['https://example.com/a?si=keep', 'https://example.com/a?si=keep'],
    ['https://www.amazon.com/dp/B000123/ref=sr_1_1?keywords=x&qid=1&sr=8-1&tag=aff-20', 'https://www.amazon.com/dp/B000123'],
    ['https://www.google.com/search?q=x&ei=abc&ved=0ah', 'https://www.google.com/search?q=x'],
    ['https://example.com/a?ei=keep', 'https://example.com/a?ei=keep'],
    // fragments
    ['https://example.com/a#', 'https://example.com/a'],
    ['https://example.com/a#top', 'https://example.com/a'],
    ['https://example.com/a#:~:text=hello', 'https://example.com/a'],
    ['https://example.com/a#xtor=RSS-1', 'https://example.com/a'],
    ['https://example.com/docs#installation', 'https://example.com/docs#installation'],
    ['https://example.com/app#/settings/profile', 'https://example.com/app#/settings/profile'],
    ['https://example.com/app#!/item/3', 'https://example.com/app#!/item/3'],
    // ports, root slash, case, credentials
    ['https://Example.COM:443/', 'https://example.com'],
    ['http://example.com:80/x', 'http://example.com/x'],
    ['http://example.com:8080/x', 'http://example.com:8080/x'],
    ['https://example.com/', 'https://example.com'],
    ['https://example.com/?', 'https://example.com'],
    ['https://example.com/docs/', 'https://example.com/docs/'],
    ['https://user:pw@example.com/x', 'https://example.com/x'],
    ['https://example.com/?utm_source=x', 'https://example.com'],
    // valueless params survive untouched when nothing is removed, and keep their form when something is
    ['https://example.com/a?flag', 'https://example.com/a?flag'],
    ['https://example.com/a?flag&utm_source=x', 'https://example.com/a?flag'],
    // redirect wrappers are decoded first
    ['https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp%3Futm_source%3Dddg&rut=abc', 'https://example.com/p'],
    ['//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fp', 'https://example.com/p'],
    ['https://www.google.com/url?q=https://example.com/x&sa=U&ved=2ah', 'https://example.com/x'],
    // non-http input
    ['mailto:a@b.c', 'mailto:a@b.c'],
    ['not a url', 'not a url'],
    ['  https://example.com/a  ', 'https://example.com/a'],
  ];
  for (const [inp, want] of cases) assert.equal(cleanUrl(inp), want, inp);
});

test('unwrap decodes the redirect wrappers search engines use', () => {
  const bing = 'https://www.bing.com/ck/a?!&&p=6a36&ptn=3&ver=2&hsh=4&fclid=156b&u=a1aHR0cHM6Ly9ydXN0LmZhY2VwdW5jaC5jb20v&ntb=1';
  assert.equal(unwrap(bing), 'https://rust.facepunch.com/');
  const yahoo = 'https://r.search.yahoo.com/_ylt=A2RR;_ylu=Y29s/RV=2/RE=1795130620/RO=10/RU=https%3a%2f%2fgithub.com%2fsmol-rs%2fsmol/RK=2/RS=2Pjuo2-';
  assert.equal(unwrap(yahoo), 'https://github.com/smol-rs/smol');
  assert.equal(unwrap('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2F&h=AT0'), 'https://example.com/');
  assert.equal(unwrap('https://www.youtube.com/redirect?event=video&q=https%3A%2F%2Fexample.com'), 'https://example.com/');
  assert.equal(unwrap('https://nam02.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com%2Fz&data=05'), 'https://example.com/z');
  assert.equal(unwrap('https://href.li/?https://example.com/q'), 'https://example.com/q');
  // nested: google → ddg → destination
  const inner = 'https://duckduckgo.com/l/?uddg=' + encodeURIComponent('https://example.com/deep');
  assert.equal(unwrap('https://www.google.com/url?q=' + encodeURIComponent(inner)), 'https://example.com/deep');
  // not wrappers / undecodable
  assert.equal(unwrap('https://www.bing.com/ck/a?u=zzz'), 'https://www.bing.com/ck/a?u=zzz');
  assert.equal(unwrap('https://www.bing.com/search?q=x'), 'https://www.bing.com/search?q=x');
  assert.equal(unwrap('https://www.google.com/url?q=javascript:alert(1)'), 'https://www.google.com/url?q=javascript:alert(1)');
  assert.equal(unwrap('/relative/path', 'https://html.duckduckgo.com/html/'), 'https://html.duckduckgo.com/relative/path');
});

test('urlKey treats cosmetic variants as one result', () => {
  const same = [
    'https://www.example.com/docs/',
    'http://example.com/docs',
    'https://example.com/docs/index.html',
    'https://example.com/docs?utm_source=x',
    'https://example.com/docs#intro',
    'https://m.example.com/docs',
  ];
  const k = urlKey(same[0]);
  for (const u of same) assert.equal(urlKey(u), k, u);
  assert.equal(urlKey('https://example.com/a?b=2&a=1'), urlKey('https://example.com/a?a=1&b=2'));
  assert.equal(urlKey('https://en.m.wikipedia.org/wiki/Rust'), urlKey('https://en.wikipedia.org/wiki/Rust'));
  assert.equal(urlKey('https://en.wikipedia.org/wiki/The%20Brothers%20Karamazov'), urlKey('https://en.wikipedia.org/wiki/The_Brothers_Karamazov'));
  assert.equal(urlKey('https://example.com/news/story/amp'), urlKey('https://example.com/news/story'));
  // genuinely different
  assert.notEqual(urlKey('https://example.com/a?id=1'), urlKey('https://example.com/a?id=2'));
  assert.notEqual(urlKey('https://example.com/a'), urlKey('https://example.org/a'));
  assert.notEqual(urlKey('https://example.com/app#/a'), urlKey('https://example.com/app#/b'));
  assert.notEqual(urlKey('https://docs.example.com/a'), urlKey('https://example.com/a'));
});

test('hostOf and underDomain', () => {
  assert.equal(hostOf('https://www.example.com/x'), 'example.com');
  assert.equal(hostOf('garbage'), '');
  assert.ok(underDomain('docs.python.org', 'python.org'));
  assert.ok(underDomain('www.python.org', 'python.org'));
  assert.ok(underDomain('python.org', 'www.python.org'));
  assert.ok(!underDomain('notpython.org', 'python.org'));
  assert.ok(underDomain('meta.stackexchange.com', '*.stackexchange.com'));
});
