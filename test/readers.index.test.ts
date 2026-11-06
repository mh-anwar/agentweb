import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBody } from '../src/readers/index.ts';
import { fixture, lines } from './fixtures/readers/helpers.ts';

const enc = (s: string) => new TextEncoder().encode(s);

test('dispatch by content type, including +json vendor types and parameters', async () => {
  const cases: [string, string, string][] = [
    ['application/vnd.github+json', '{"a":1}', 'json'],
    ['application/problem+json; charset=utf-8', '{"title":"Not found","status":404}', 'json'],
    ['application/x-ndjson', '{"a":1}\n{"a":2}\n', 'json'],
    ['text/csv', 'a,b\n1,2\n', 'csv'],
    ['text/markdown; charset=utf-8', '# Hi\n\ntext', 'markdown'],
    ['application/atom+xml', fixture('atom.xml'), 'feed'],
    ['application/xml', fixture('rss.xml'), 'feed'],
    ['text/xml', fixture('sitemap.xml'), 'feed'],
  ];
  for (const [ct, body, kind] of cases) {
    const out = await readBody({ url: 'https://x.example/r', contentType: ct, text: body });
    assert.equal(out.kind, kind, ct);
    assert.ok(out.blocks.length > 0, ct);
  }
});

test('sniffing when the type says text/plain or nothing', async () => {
  const j = await readBody({ url: 'https://x.example/api', contentType: 'text/plain', text: ' {"ok": true, "items": [1,2]}' });
  assert.equal(j.kind, 'json');
  const hijack = await readBody({ url: 'https://x.example/api', contentType: '', text: ")]}'\n{\"ok\":true}" });
  assert.equal(hijack.kind, 'json');
  const llms = await readBody({ url: 'https://docs.example/llms.txt', contentType: 'text/plain', text: '# Example\n\n> Summary\n\n- [Guide](/guide): how to' });
  assert.equal(llms.kind, 'markdown');
  assert.deepEqual(lines(llms), ['Example', 'Summary', 'Guide : how to']);
  const mdish = await readBody({ url: 'https://x.example/README', contentType: 'text/plain', text: '# Title\n\nSee [docs](https://x.example/docs).\n\n```sh\nnpm i\n```\n' });
  assert.equal(mdish.kind, 'markdown');
  const prose = await readBody({ url: 'https://x.example/robots.txt', contentType: 'text/plain', text: 'User-agent: *\nDisallow: /admin\n' });
  assert.equal(prose.kind, 'text');
  const py = await readBody({ url: 'https://x.example/a.py', contentType: 'text/x-python', text: '# comment\n# another\nprint("[x](y)")\n' });
  assert.equal(py.kind, 'text');
  const rss = await readBody({ url: 'https://x.example/feed', contentType: 'text/plain', text: fixture('rss.xml') });
  assert.equal(rss.kind, 'feed');
});

test('bytes: decoded with the declared charset, sniffed when the type is generic', async () => {
  const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x6f, 0x69, 0x72]); // "café noir" in windows-1252
  const t = await readBody({ url: 'https://x.example/a.txt', contentType: 'text/plain; charset=windows-1252', bytes: latin });
  assert.deepEqual(lines(t), ['café noir']);
  const bad = await readBody({ url: 'https://x.example/a.txt', contentType: 'text/plain', bytes: latin });
  assert.deepEqual(lines(bad), ['café noir'], 'invalid UTF-8 falls back to windows-1252');
  const j = await readBody({ url: 'https://x.example/data', contentType: 'application/octet-stream', bytes: enc('[{"a":1,"b":"x"},{"a":2,"b":"y"}]') });
  assert.equal(j.kind, 'json');
  assert.deepEqual(lines(j), ['a | b', '1 | x', '2 | y']);
});

test('binary content becomes kind binary with type and size', async () => {
  const png = new Uint8Array(2048);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out = await readBody({ url: 'https://x.example/logo.png', contentType: 'image/png', bytes: png });
  assert.deepEqual(out, { title: 'logo.png', kind: 'binary', blocks: [], notes: ['binary content: image/png, 2.0 KB'] });
  const rnd = new Uint8Array(500).map((_, i) => (i * 37) % 256);
  const r2 = await readBody({ url: 'https://x.example/blob', contentType: 'application/x-thing', bytes: rnd });
  assert.equal(r2.kind, 'binary');
  assert.deepEqual(r2.notes, ['binary content: application/x-thing, 500 B']);
  const zip = await readBody({ url: 'https://x.example/f', contentType: '', bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) });
  assert.deepEqual(zip.notes, ['binary content: application/zip, 7 B']);
});

test('HTML handed to readBody is read as text, never as markup', async () => {
  const out = await readBody({ url: 'https://x.example/', contentType: 'text/html', text: '<!doctype html><title>x</title><script>var a=1</script><h1>Hello</h1><p>World &amp; more</p>' });
  assert.equal(out.kind, 'text');
  assert.ok(lines(out).join(' ').includes('Hello'));
  assert.ok(!lines(out).join(' ').includes('var a'));
});

test('empty bodies do not crash', async () => {
  for (const ct of ['application/json', 'text/csv', 'text/markdown', 'text/plain', 'application/xml', 'application/rss+xml']) {
    const out = await readBody({ url: 'https://x.example/e', contentType: ct, text: '' });
    assert.ok(Array.isArray(out.blocks), ct);
  }
});
