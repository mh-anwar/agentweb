import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCsv, readBody, readCsv, sniffDelimiter } from '../src/readers/index.ts';
import { fixture, lines } from './fixtures/readers/helpers.ts';

test('RFC 4180: quoted delimiters, doubled quotes, CRLF and newlines inside quotes', () => {
  const rows = parseCsv(fixture('customers.csv'));
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[1], ['1', 'Smith, Jane', 'Lisbon', 'Prefers email.\r\nCall only after 5pm, "urgent" only', '2026-01-04', 'pro']);
  assert.equal(rows[3][1], 'Ana "Nana" Silva');
  assert.equal(rows[4][3], 'multi\nline\nnote');
  assert.deepEqual(parseCsv('a,b\n1,\n,2'), [['a', 'b'], ['1', ''], ['', '2']]);
  assert.deepEqual(parseCsv('"x"\n'), [['x']]);
});

test('CSV → header and rows; a constant column is said once', () => {
  const out = readCsv({ url: 'https://x.example/customers.csv', contentType: 'text/csv', text: fixture('customers.csv') });
  assert.equal(out.kind, 'csv');
  assert.deepEqual(out.notes, ['CSV: 4 rows × 6 columns']);
  assert.deepEqual(lines(out), [
    'all 4: plan=pro',
    'id | name | city | notes | signup_date',
    '1 | Smith, Jane | Lisbon | Prefers email. Call only after 5pm, "urgent" only | 2026-01-04',
    '2 | Bob Lee | Porto | | 2026-02-11',
    '3 | Ana "Nana" Silva | Lisbon | VIP | 2026-03-09',
    '4 | Chen Wei | Braga | multi line note | 2026-03-30',
  ]);
  assert.ok(out.blocks[1].hd);
});

test('delimiter sniffing: tab, semicolon, pipe', async () => {
  assert.equal(sniffDelimiter(fixture('stock.tsv')), '\t');
  assert.equal(sniffDelimiter('a;b;c\n1;2,5;3\n4;5,5;6\n'), ';');
  assert.equal(sniffDelimiter('a|b\n1|2\n'), '|');
  assert.equal(sniffDelimiter('name,quote\n"Smith; J","a; b; c"\n"Lee; K","d; e"\n'), ',');
  const out = await readBody({ url: 'https://x.example/stock', contentType: 'text/tab-separated-values', text: fixture('stock.tsv') });
  assert.deepEqual(lines(out), ['sku | product | price | stock', 'TR3-42 | Trail Runner 3 (EU 42) | 129.00 | 14', 'RS-M | Rain Shell, medium | 89.50 | 0', 'SK-01 | Wool socks | 12.00 | 230']);
  assert.deepEqual(out.notes, ['TSV: 3 rows × 4 columns']);
});

test('headerless numeric CSV, ragged rows, duplicate header names, BOM', () => {
  const nums = readCsv({ url: 'https://x.example/d.csv', contentType: 'text/csv', text: '1,2,3\n4,5,6\n7,8,9\n' });
  assert.equal(lines(nums)[0], 'col1 | col2 | col3');
  assert.equal(lines(nums)[1], '1 | 2 | 3');
  const ragged = readCsv({ url: 'https://x.example/d.csv', contentType: 'text/csv', text: '﻿a,a,b\n1,2\n3,4,5,6\n' });
  assert.equal(lines(ragged)[0], 'a | a_2 | b | col4');
  assert.equal(lines(ragged)[1], '1 | 2 | |');
});

test('wide CSV is capped at 20 columns in original order', () => {
  const head = Array.from({ length: 30 }, (_, i) => `c${i}`).join(',');
  const row = (r: number) => Array.from({ length: 30 }, (_, i) => `${r}-${i}`).join(',');
  const out = readCsv({ url: 'https://x.example/w.csv', contentType: 'text/csv', text: [head, row(1), row(2), row(3)].join('\n') });
  const hd = lines(out).find((l) => l.startsWith('c0 | '))!;
  assert.equal(hd.split(' | ').length, 20);
  assert.match(lines(out).find((l) => l.startsWith('not shown'))!, /^not shown: c20, c21/);
});
