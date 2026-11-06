// CSV / TSV → a table. RFC 4180 quoting (doubled quotes, delimiters and newlines inside quotes),
// delimiter sniffing, header detection. Constant columns are said once above the table.

import type { ReadInput, ReadOutput } from '../types.ts';
import { JsonWriter, type JObj } from './json.ts';
import { Emitter, plural, titleFromUrl } from './util.ts';

const MAX_ROWS = 1000;
const MAX_COLS = 20;

/** Parse delimited text. Returns rows of raw cell strings. */
export function parseCsv(text: string, delim = ','): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  let wasQuoted = false;
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && !cell.trim() && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      cell = '';
      i++;
      continue;
    }
    if (c === delim) {
      row.push(wasQuoted ? cell : cell.trim());
      cell = '';
      wasQuoted = false;
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(wasQuoted ? cell : cell.trim());
      rows.push(row);
      row = [];
      cell = '';
      wasQuoted = false;
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell || wasQuoted || row.length) {
    row.push(wasQuoted ? cell : cell.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/** Pick the delimiter that splits the first lines into the most consistent number (>1) of fields. */
export function sniffDelimiter(text: string): string {
  const head = text.slice(0, 20_000);
  let best = ',';
  let bestScore = 0;
  for (const d of [',', '\t', ';', '|']) {
    const rows = parseCsv(head, d).slice(0, 30);
    if (rows.length > 1 && !/[\r\n]$/.test(head)) rows.pop(); // last row may be cut
    if (!rows.length) continue;
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    let mode = 0;
    let freq = 0;
    for (const [n, f] of counts) if (f > freq || (f === freq && n > mode)) [mode, freq] = [n, f];
    if (mode < 2) continue;
    const score = (freq / rows.length) * Math.log2(mode + 1);
    if (score > bestScore) [best, bestScore] = [d, score];
  }
  return best;
}

const NUMERIC = /^[-+]?[$€£¥]?\s?\d[\d,_ ]*(\.\d+)?%?$|^[-+]?\.\d+$/;

function hasHeader(rows: string[][]): boolean {
  if (rows.length < 2) return true;
  const first = rows[0];
  if (first.some((c) => !c.trim())) return first.filter((c) => c.trim()).length >= first.length - 1 && !first.some((c) => NUMERIC.test(c));
  if (first.some((c) => NUMERIC.test(c))) return false;
  return true;
}

export function csvInto(text: string, em: Emitter, delim?: string): { rows: number; cols: number; delim: string } {
  const d = delim ?? sniffDelimiter(text);
  const rows = parseCsv(text, d);
  if (!rows.length) return { rows: 0, cols: 0, delim: d };
  const width = Math.max(...rows.slice(0, 200).map((r) => r.length));
  let header: string[];
  let body: string[][];
  if (hasHeader(rows)) {
    header = rows[0].map((h, i) => h.trim() || `col${i + 1}`);
    body = rows.slice(1);
  } else {
    header = Array.from({ length: width }, (_, i) => `col${i + 1}`);
    body = rows;
  }
  for (let i = header.length; i < width; i++) header.push(`col${i + 1}`);
  // duplicate header names would collapse into one key
  const seen = new Map<string, number>();
  header = header.map((h) => {
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n > 1 ? `${h}_${n}` : h;
  });
  const objs: JObj[] = body.map((r) => {
    const o: JObj = {};
    header.forEach((h, i) => (o[h] = r[i] ?? ''));
    return o;
  });
  if (!objs.length) {
    em.row(header.map((h) => [h]), em.group(), true);
    return { rows: 0, cols: header.length, delim: d };
  }
  new JsonWriter(em, { mainRows: MAX_ROWS }).table(objs, MAX_ROWS, undefined, { maxCols: MAX_COLS, keepOrder: true });
  return { rows: objs.length, cols: header.length, delim: d };
}

export function readCsv(input: ReadInput, em = new Emitter(input.url)): ReadOutput {
  const text = input.text ?? new TextDecoder().decode(input.bytes ?? new Uint8Array());
  const tsv = /tab-separated|tsv/.test(input.contentType) || /\.tsv(\?|$)/i.test(input.url);
  const r = csvInto(text, em, tsv ? '\t' : undefined);
  const name = r.delim === '\t' ? 'TSV' : r.delim === ',' ? 'CSV' : `delimited (${r.delim})`;
  return { title: titleFromUrl(input.url), kind: 'csv', blocks: em.blocks, notes: [`${name}: ${plural(r.rows, 'row')} × ${plural(r.cols, 'column')}`, ...em.notes] };
}
