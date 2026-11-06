// Readers: everything that is not an HTML page → the same block model.
// `readBody` picks a reader by content type, then by sniffing the content.

import type { ReadInput, ReadOutput } from '../types.ts';
import { readCsv } from './csv.ts';
import { parseJsonFeed, readFeed } from './feed.ts';
import { parseJson, readJson } from './json.ts';
import { readMarkdown } from './markdown.ts';
import { readPdf } from './pdf.ts';
import { readText } from './text.ts';
import { Emitter, htmlText, titleFromUrl } from './util.ts';
import { readXml } from './xml.ts';

export { mineEmbedded, devalue } from './embedded.ts';
export { readCsv, parseCsv, sniffDelimiter } from './csv.ts';
export { readFeed, parseFeedXml, parseJsonFeed } from './feed.ts';
export { readJson, parseJson, JsonWriter } from './json.ts';
export { readMarkdown, markdownInto } from './markdown.ts';
export { readPdf } from './pdf.ts';
export { readText, textInto } from './text.ts';
export { readXml, xmlToValue } from './xml.ts';
export { Emitter } from './util.ts';

const MAX_TEXT = 8_000_000;

type Kind = 'json' | 'feed' | 'xml' | 'csv' | 'markdown' | 'text' | 'pdf' | 'html' | 'binary';

function byType(ct: string, url: string): Kind | undefined {
  const t = ct.split(';')[0].trim().toLowerCase();
  if (t === 'application/pdf' || t === 'application/x-pdf') return 'pdf';
  if (t === 'application/feed+json') return 'feed';
  if (/^application\/(rss|atom|rdf)\+xml$/.test(t)) return 'feed';
  if (t === 'text/csv' || t === 'application/csv' || t === 'text/tab-separated-values' || t === 'text/x-csv') return 'csv';
  if (t === 'text/markdown' || t === 'text/x-markdown' || t === 'text/vnd.daringfireball.markdown') return 'markdown';
  if (/json/.test(t) || t === 'application/x-ndjson' || t === 'application/jsonl') return 'json';
  if (t === 'text/html' || t === 'application/xhtml+xml') return 'html';
  if (/xml/.test(t)) return 'xml';
  if (t === 'text/plain' || t === '') {
    if (/\.(md|markdown|mdx)(\?|#|$)|\/llms(-full)?\.txt(\?|#|$)/i.test(url)) return 'markdown';
    if (/\.(csv)(\?|#|$)/i.test(url)) return 'csv';
    if (/\.(tsv)(\?|#|$)/i.test(url)) return 'csv';
    return undefined; // sniff
  }
  if (t.startsWith('text/')) return 'text';
  return undefined;
}

// magic numbers for naming binary content
const MAGIC: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x52, 0x49, 0x46, 0x46], 'RIFF (webp/wav/avi)'],
  [[0x25, 0x50, 0x44, 0x46], 'application/pdf'],
  [[0x50, 0x4b, 0x03, 0x04], 'application/zip'],
  [[0x1f, 0x8b], 'application/gzip'],
  [[0x00, 0x61, 0x73, 0x6d], 'application/wasm'],
  [[0x7f, 0x45, 0x4c, 0x46], 'ELF executable'],
  [[0x4f, 0x67, 0x67, 0x53], 'audio/ogg'],
  [[0x49, 0x44, 0x33], 'audio/mpeg'],
  [[0x1a, 0x45, 0xdf, 0xa3], 'video/webm'],
  [[0x77, 0x4f, 0x46, 0x32], 'font/woff2'],
  [[0x77, 0x4f, 0x46, 0x46], 'font/woff'],
];

function magic(b: Uint8Array): string | undefined {
  for (const [sig, name] of MAGIC) if (sig.every((x, i) => b[i] === x)) return name;
  if (b.length > 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'video/mp4 (ISO media)';
  return undefined;
}

/** Decode bytes as text if they look like text; undefined for binary. */
function decodeText(b: Uint8Array, ct: string): string | undefined {
  const sample = b.subarray(0, 4096);
  let ctrl = 0;
  for (const x of sample) if (x === 0 || (x < 9) || (x > 13 && x < 32 && x !== 27)) ctrl++;
  if (sample.length && ctrl / sample.length > 0.02) return undefined;
  const cs = /charset=["']?([\w-]+)/i.exec(ct)?.[1];
  try {
    return new TextDecoder(cs || 'utf-8', { fatal: !cs }).decode(b);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(b);
    } catch {
      return undefined;
    }
  }
}

function fmtSize(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function sniff(text: string): Kind {
  const t = text.replace(/^﻿/, '').trimStart();
  const head = t.slice(0, 2000);
  if (/^(\)\]\}'|while\s*\(1\)|for\s*\(;;\)|\{\}&&)/.test(t) || /^[{[]/.test(t)) {
    try {
      parseJson(t);
      return 'json';
    } catch {}
  }
  if (/^<\?xml|^<(rss|feed|urlset|sitemapindex|rdf:RDF)\b/i.test(t)) {
    if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(t)) return 'feed';
    return 'xml';
  }
  if (/^<!doctype html|^<html[\s>]/i.test(t)) return 'html';
  if (t.startsWith('%PDF-')) return 'pdf';
  // markdown signals
  let md = 0;
  if (/^#{1,6} \S/m.test(head)) md++;
  if (/\[[^\]\n]+\]\([^)\s]+\)/.test(head)) md++;
  if (/^```/m.test(head)) md++;
  if (/^\s*[-*] \S/m.test(head) && /^#{1,6} /m.test(head)) md++;
  if (/^\|.*\|\s*\n\|[\s:|-]+\|/m.test(head)) md++;
  if (/^---\n[\s\S]*?\n---\n/.test(head)) md++;
  if (md >= 2) return 'markdown';
  return 'text';
}

export async function readBody(input: ReadInput): Promise<ReadOutput> {
  const ct = (input.contentType ?? '').toLowerCase();
  let kind = byType(ct, input.url);
  let text = input.text;
  const bytes = input.bytes;
  if (kind === 'pdf' || (!text && bytes && magic(bytes) === 'application/pdf')) return readPdf({ ...input, contentType: 'application/pdf' });
  if (text === undefined && bytes) {
    const m = magic(bytes);
    text = m ? undefined : decodeText(bytes, ct);
    if (text === undefined) {
      const type = m ?? (ct || 'unknown type');
      return { title: titleFromUrl(input.url), kind: 'binary', blocks: [], notes: [`binary content: ${type}, ${fmtSize(bytes.length)}`] };
    }
  }
  text ??= '';
  const notes: string[] = [];
  if (text.length > MAX_TEXT) {
    notes.push(`body truncated to ${fmtSize(MAX_TEXT)} of ${fmtSize(text.length)}`);
    text = text.slice(0, MAX_TEXT);
  }
  if (!kind) kind = sniff(text);
  else if (kind === 'text') {
    // text/* subtypes we do not know: upgrade only to structured formats that parse
    const s = sniff(text);
    if (s === 'json' || s === 'feed' || s === 'xml') kind = s;
  }
  // JSON that is a JSON Feed
  if (kind === 'json' && /jsonfeed\.org\/version/.test(text.slice(0, 500))) {
    try {
      if (parseJsonFeed(JSON.parse(text), input.url)) kind = 'feed';
    } catch {}
  }
  const inp: ReadInput = { ...input, text, bytes: undefined };
  let out: ReadOutput;
  switch (kind) {
    case 'json':
      out = readJson(inp);
      break;
    case 'feed':
      out = readFeed(inp);
      if (!out.blocks.length) out = readXml(inp);
      break;
    case 'xml':
      out = readXml(inp);
      break;
    case 'csv':
      out = readCsv(inp);
      break;
    case 'markdown':
      out = readMarkdown(inp);
      break;
    case 'html': {
      // HTML belongs to the compiler; give a readable fallback rather than markup
      const em = new Emitter(input.url);
      const t = htmlText(text.replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, ''));
      readText({ ...inp, text: t }, em);
      out = { title: titleFromUrl(input.url), kind: 'text', blocks: em.blocks, notes: ['HTML read as text (no compiler)'] };
      break;
    }
    default:
      out = readText(inp);
  }
  if (notes.length) out.notes = [...(out.notes ?? []), ...notes];
  return out;
}
