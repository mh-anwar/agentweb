import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCollection } from '../src/extract/compare.ts';
import type { CollectedRow } from '../src/extract/collect.ts';

const fields = { id: 'url', price: 'money' } as const;
const row = (id: string, price = 1, source = 'https://shop.test/'): CollectedRow => ({ values: { id, price }, evidence: { id, price: `$${price}` }, source: { url: source, block: 'hash' } });

test('semantic comparison reports additions, removals and changed fields', () => {
  const previous = compareCollection([row('a'), row('b')], fields, 'id', 'scope').snapshot;
  const next = compareCollection([row('b', 3), row('c')], fields, 'id', 'scope', previous);
  assert.deepEqual(next.changes, { status: 'compared', added: ['c'], removed: ['a'], updated: [{ key: 'b', fields: ['price'] }] });
});

test('row order, markup hashes and evidence locations do not create changes', () => {
  const previous = compareCollection([row('a'), row('b')], fields, 'id', 'scope').snapshot;
  const next = compareCollection([row('b', 1, 'https://new.test/'), row('a')], fields, 'id', 'scope', previous);
  assert.deepEqual(next.changes, { status: 'compared', added: [], removed: [], updated: [] });
});

test('schema, key, or source changes reset comparisons', () => {
  const previous = compareCollection([row('a')], fields, 'id', 'scope').snapshot;
  assert.equal(compareCollection([row('a')], fields, 'id', 'new scope', previous).changes.status, 'reset');
  assert.equal(compareCollection([row('a')], { id: 'url' }, 'id', 'scope', previous).changes.status, 'reset');
});

test('ambiguous keys and oversized snapshots cannot become baselines', () => {
  for (const rows of [[row('a'), row('a')], [row('x'.repeat(3000))], Array.from({length: 257}, (_, i) => row(String(i)))]) {
    const r = compareCollection(rows, fields, 'id', 'scope');
    assert.equal(r.changes.status, 'withheld');
    assert.equal(r.snapshot, undefined);
  }
});
