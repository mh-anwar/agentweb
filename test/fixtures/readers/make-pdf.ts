// Builds small, valid PDFs by hand (correct xref offsets) for the PDF reader tests.
// Each page is a list of text runs: [x, y, fontSize, text]. Fonts: F1 = Helvetica, F2 = Helvetica-Bold.

export type Run = [x: number, y: number, size: number, text: string, bold?: boolean];

export function makePdf(pages: Run[][], info: { title?: string } = {}): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => (objs.push(s), objs.length);
  const catalog = add('');
  const pagesObj = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const runs of pages) {
    const esc = (t: string) => t.replace(/[\\()]/g, (c) => '\\' + c);
    const stream = runs.map(([x, y, sz, t, b]) => `BT /${b ? 'F2' : 'F1'} ${sz} Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const infoObj = info.title ? add(`<< /Title (${info.title}) /Producer (agentweb test) >>`) : 0;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${infoObj ? ` /Info ${infoObj} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/** The fixture used by the tests: three pages with a running header, page-number footers,
 * a heading in a larger bold font, a hyphenated line break and a bulleted list. */
export function samplePdf(): Uint8Array {
  const page = (n: number, body: Run[]): Run[] => [
    [72, 760, 9, 'ACME Corp Quarterly Report'],
    ...body,
    [300, 40, 9, `Page ${n} of 3`],
  ];
  return makePdf(
    [
      page(1, [
        [72, 700, 20, 'Quarterly Results', true],
        [72, 670, 11, 'Revenue grew strongly this quarter, driven by the new subscrip-'],
        [72, 656, 11, 'tion plans and by expansion into three new regional markets.'],
        [72, 642, 11, 'Operating costs were flat.'],
        [72, 610, 11, 'Headcount rose to 412 people across all offices.'],
      ]),
      page(2, [
        [72, 700, 15, 'Outlook', true],
        [72, 670, 11, 'We expect the following next quarter:'],
        [72, 650, 11, '\x95 Continued growth in subscriptions'],
        [72, 636, 11, '\x95 A new office in Lisbon'],
      ]),
      page(3, [[72, 700, 11, 'Appendix tables are available on request.']]),
    ],
    { title: 'ACME Q3 Report' },
  );
}
