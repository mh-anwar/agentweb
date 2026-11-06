// Token cost of the raw input versus the text of the produced blocks (o200k proxy: gpt-tokenizer).
// Prints a table; asserts the readers never cost more than the minified input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode } from 'gpt-tokenizer';
import { parseHtml } from '../src/parse.ts';
import { mineEmbedded, readJson } from '../src/readers/index.ts';
import { fixture, text } from './fixtures/readers/helpers.ts';

const tok = (s: string) => encode(s).length;
const rows: string[] = [];
const report = (name: string, raw: number, min: number | string, out: number) =>
  rows.push(`${name.padEnd(26)} ${String(raw).padStart(7)} ${String(min).padStart(9)} ${String(out).padStart(7)} ${((1 - out / (typeof min === 'number' ? min : raw)) * 100).toFixed(0).padStart(5)}%`);

const JSON_FIXTURES: [string, string][] = [
  ['github-repo.json', 'https://api.github.com/repos/octocat/Hello-World'],
  ['github-search.json', 'https://api.github.com/search/repositories?q=react'],
  ['npm-package.json', 'https://registry.npmjs.org/tiny-glob-walker'],
  ['graphql-issues.json', 'https://api.github.com/graphql'],
  ['github-events.json', 'https://api.github.com/repos/octocat/Hello-World/events'],
  ['k8s-deployment.json', 'https://k8s.example/apis/apps/v1/namespaces/shop/deployments/checkout-api'],
];

test('JSON fixtures: blocks cost fewer tokens than even minified JSON', () => {
  for (const [f, url] of JSON_FIXTURES) {
    const raw = fixture(f);
    const out = readJson({ url, contentType: 'application/json', text: raw });
    const t = tok(text(out));
    const min = tok(JSON.stringify(JSON.parse(raw)));
    report(f, tok(raw), min, t);
    assert.ok(t < min, `${f}: ${t} >= ${min}`);
  }
});

const HTML_FIXTURES: [string, string][] = [
  ['next-product.html', 'https://shop.example.com/p/trail-runner-3'],
  ['jsonld-product.html', 'https://shop.example/p/aeropress-go'],
  ['jsonld-article.html', 'https://news.example/2026/11/04/car-free'],
  ['nuxt-shop.html', 'https://shop.example/shop'],
];

test('embedded-data fixtures: recovered blocks versus the raw HTML and the embedded JSON', () => {
  for (const [f, url] of HTML_FIXTURES) {
    const html = fixture(f);
    const doc = parseHtml(html);
    const out = mineEmbedded(doc, url)!;
    const t = tok(text(out));
    const json = doc.meta.json.reduce((a, j) => a + tok(j.text), 0);
    report(f, tok(html), json, t);
    assert.ok(t < json, f);
  }
});

test.after(() => {
  console.log('\nfixture                      raw tok  json/min  blocks  saved (vs min)');
  for (const r of rows) console.log(r);
});
