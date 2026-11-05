import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockText } from '../src/blocks.ts';
import type { Act } from '../src/types.ts';
import { queryTerms, toBlocks, trimSnippet } from '../src/search/index.ts';

const long = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty tokio runtime appears here near the end of the text twentyone twentytwo';

test('queryTerms drops operators and stop words', () => {
  assert.deepEqual(queryTerms('what is the Tokio runtime site:docs.rs -spam'), ['tokio', 'runtime']);
  assert.deepEqual(queryTerms('c++ vs c# for node.js'), ['c++', 'c#', 'node.js']);
});

test('trimSnippet keeps short snippets whole', () => {
  assert.equal(trimSnippet('  short   snippet  ', ['x']), 'short snippet');
});

test('trimSnippet keeps query terms in view', () => {
  const s = trimSnippet(long, ['tokio', 'runtime'], 30);
  assert.match(s, /tokio runtime/);
  assert.ok(s.startsWith('…'), s);
  assert.ok(s.split(' ').length <= 32, s);
  // no hits → the beginning
  const h = trimSnippet(long, ['absent'], 30);
  assert.ok(h.startsWith('Alpha beta'));
  assert.ok(h.endsWith(' …'));
  assert.equal(h.split(' ').length, 31);
  // prefix matching on longer terms ("runtimes" for "runtime")
  assert.match(trimSnippet(long.replace('runtime', 'runtimes'), ['runtime'], 10), /runtimes/);
});

test('toBlocks: one row per result in a shared group, link act + host + snippet', () => {
  const results = [
    { title: 'Tokio - An asynchronous Rust runtime', url: 'https://tokio.rs/', snippet: long, source: 'bing+brave' },
    { title: '', url: 'https://www.example.com/a', snippet: '', source: 'ddg' },
  ];
  const blocks = toBlocks(results, 'tokio runtime', { g: 7 });
  assert.equal(blocks.length, 2);
  for (const b of blocks) {
    assert.equal(b.k, 'row');
    assert.equal(b.g, 7);
    assert.equal(b.r, 'main');
    assert.ok(b.hx);
  }
  const a = blocks[0].i[0] as Act;
  assert.equal(a.k, 'link');
  assert.equal(a.href, 'https://tokio.rs/');
  assert.equal(a.l, 'Tokio - An asynchronous Rust runtime');
  const tail = blocks[0].i[1] as string;
  assert.ok(tail.startsWith(' · tokio.rs · …'), tail);
  assert.match(tail, /tokio runtime appears/);
  // empty title falls back to the host; no dangling separator without a snippet
  assert.equal((blocks[1].i[0] as Act).l, 'example.com');
  assert.equal(blocks[1].i[1], ' · example.com');
  assert.match(blockText(blocks[1]), /^example\.com · example\.com$/);
  // stable: same input, same hashes and fingerprints
  const again = toBlocks(results, 'tokio runtime', { g: 7 });
  assert.deepEqual(again.map((b) => b.hx), blocks.map((b) => b.hx));
  assert.equal(toBlocks(results, 'q')[0].g, 1);
  assert.deepEqual(toBlocks([], 'q'), []);
});
