import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readBody, readPdf } from '../src/readers/index.ts';
import { fixtureBytes, lines } from './fixtures/readers/helpers.ts';
import { makePdf, samplePdf } from './fixtures/readers/make-pdf.ts';

test('hand-built PDF fixture on disk matches the generator', () => {
  assert.deepEqual(fixtureBytes('report.pdf'), samplePdf());
});

test('PDF: page headings, font-size headings, hyphenation repaired, running headers and page numbers removed', async () => {
  const out = await readBody({ url: 'https://x.example/files/report.pdf', contentType: 'application/pdf', bytes: fixtureBytes('report.pdf') });
  assert.equal(out.kind, 'pdf');
  assert.equal(out.title, 'ACME Q3 Report');
  assert.deepEqual(out.notes, ['PDF, 3 pages', 'removed 6 running header/footer lines']);
  assert.deepEqual(
    out.blocks.map((b) => [b.k + (b.lv ?? ''), lines({ blocks: [b] })[0]]),
    [
      ['h2', 'Page 1'],
      ['h3', 'Quarterly Results'],
      ['p', 'Revenue grew strongly this quarter, driven by the new subscription plans and by expansion into three new regional markets. Operating costs were flat.'],
      ['p', 'Headcount rose to 412 people across all offices.'],
      ['h2', 'Page 2'],
      ['h4', 'Outlook'],
      ['p', 'We expect the following next quarter:'],
      ['li1', 'Continued growth in subscriptions'],
      ['li1', 'A new office in Lisbon'],
      ['h2', 'Page 3'],
      ['p', 'Appendix tables are available on request.'],
    ],
  );
});

test('PDF sniffed from bytes without a content type; single page has no page heading', async () => {
  const one = makePdf([[[72, 700, 12, 'Just one page of text.']]]);
  const out = await readBody({ url: 'https://x.example/download?id=7', contentType: 'application/octet-stream', bytes: one });
  assert.equal(out.kind, 'pdf');
  assert.deepEqual(lines(out), ['Just one page of text.']);
  assert.equal(out.title, 'download');
});

test('page cap: only the first 50 pages are extracted, with a note', async () => {
  const pages = Array.from({ length: 53 }, (_, i) => [[72, 700, 12, `Body text on sheet ${i + 1} differs.`] as [number, number, number, string]]);
  const out = await readPdf({ url: 'https://x.example/long.pdf', contentType: 'application/pdf', bytes: makePdf(pages) });
  assert.ok(out.notes!.includes('showing pages 1–50 of 53'));
  assert.equal(out.blocks.filter((b) => b.k === 'h').length, 50);
  assert.ok(lines(out).includes('Body text on sheet 50 differs.'), 'similar body lines are not running headers');
  assert.equal(out.notes!.length, 2);
  assert.equal(lines(out).at(-1), '… 3 more pages not extracted');
});

test('corrupt PDF becomes a note, not a crash', async () => {
  const out = await readPdf({ url: 'https://x.example/bad.pdf', contentType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-1.4\nthis is not really a pdf') });
  assert.equal(out.kind, 'pdf');
  assert.equal(out.blocks.length, 0);
  assert.match(out.notes![0], /PDF could not be parsed|no text layer/);
});
