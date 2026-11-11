import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractRow } from '../src/extract/collect.ts';
import { textBlock } from '../src/blocks.ts';
import type { Page } from '../src/types.ts';
const page = { url: 'https://test.example/' } as Page;

test('unsafe integers and decimals never silently round', () => {
  for (const value of ['9007199254740993', '9007199254740992', '1.00000000000000001', '0.1234567890123456789', '9999999999999999.99', '0.' + '0'.repeat(325) + '1']) {
    for (const rule of ['number', 'money'] as const) {
      const row = extractRow(page, textBlock((rule === 'money' ? '$' : '') + value), { amount: rule });
      assert.equal(row.values.amount, null, value + '/' + rule);
      assert.ok(row.errors?.amount);
    }
  }
});

test('exact decimal round trips and safe integer boundaries remain usable', () => {
  for (const value of ['9007199254740991', '-9007199254740991', '0.1', '1.2500', '0.0000001', '-0.00', '0001.00']) {
    const row = extractRow(page, textBlock(value), { amount: 'number' });
    assert.equal(row.values.amount, Number(value), value);
  }
});

test('money retains observed currency and refuses conflicting currencies', () => {
  for (const currency of ['$', '£', '€', 'USD', 'GBP', 'EUR']) {
    const row = extractRow(page, textBlock(currency + ' 10.00'), { amount: 'money' });
    assert.equal(row.values.amount, 10);
    assert.equal(row.currencies?.amount, currency);
  }
  const row = extractRow(page, textBlock('$10 or €10'), { amount: 'money' });
  assert.equal(row.values.amount, null);
  assert.equal(row.errors?.amount, 'ambiguous');
});


test('refund signs and qualified dollar symbols are preserved', () => {
  for (const price of ['-$5.00', '$-5.00', '−$5.00', '- CA$5.00']) {
    const row = extractRow(page, textBlock(price), { amount: 'money' });
    assert.equal(row.values.amount, -5, price);
    assert.equal(row.evidence.amount, price);
  }
  for (const currency of ['CA$', 'A$', 'NZ$', 'HK$', 'US$']) {
    const row = extractRow(page, textBlock(currency + '12.00'), { amount: 'money' });
    assert.equal(row.values.amount, 12);
    assert.equal(row.currencies?.amount, currency);
    assert.equal(row.evidence.amount, currency + '12.00');
  }
});

test('unsupported numeric notation is rejected as a whole token', () => {
  for (const price of ['€1 250,00', '€1\u202f250,00', '€1\u00a0250,00', '$1e3', '($5.00)', '-$-5']) {
    const row = extractRow(page, textBlock(price), { amount: 'money' });
    assert.equal(row.values.amount, null, price);
    assert.ok(row.errors?.amount, price);
  }
});
