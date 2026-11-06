// PDF → blocks with unpdf (PDF.js), loaded lazily so a missing package is a note, not a crash.
// Text items are grouped into lines by baseline, lines into paragraphs by spacing and font size.
// Larger fonts become headings, page boundaries become headings, hyphenated line breaks are
// repaired, and lines that repeat at the top or bottom of most pages (running headers, footers,
// page numbers) are removed.

import { squash } from '../tree.ts';
import type { ReadInput, ReadOutput } from '../types.ts';
import { Emitter, titleFromUrl } from './util.ts';
import { emitParagraph } from './text.ts';

const PAGE_CAP = 50;
const EDGE = 3; // lines at the top and bottom of a page that may be running headers/footers
const ZONE = 0.1; // … and only if they sit in the top or bottom tenth of the page

interface Line {
  text: string;
  y: number;
  x: number;
  size: number;
  width: number;
}

function lines(items: any[]): Line[] {
  const out: Line[] = [];
  let cur: Line | undefined;
  let lastEnd = 0;
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const [a, b, c, d, x, y] = it.transform as number[];
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 10;
    if (it.str === '') {
      if (it.hasEOL && cur) cur = undefined;
      continue;
    }
    if (cur && Math.abs(cur.y - y) <= Math.max(cur.size, size) * 0.5) {
      const gap = x - lastEnd;
      if (gap > size * 0.15 && !cur.text.endsWith(' ') && !it.str.startsWith(' ')) cur.text += ' ';
      cur.text += it.str;
      cur.size = Math.max(cur.size, size);
      cur.width = x + it.width - cur.x;
    } else {
      cur = { text: it.str, y, x, size, width: it.width };
      out.push(cur);
    }
    lastEnd = x + (it.width ?? 0);
    if (it.hasEOL) cur = undefined;
  }
  for (const l of out) l.text = squash(l.text.replace(/­/g, ''));
  return out.filter((l) => l.text);
}

const PAGE_NO = /^(page\s*)?[-–—(]?\s*\d{1,4}\s*[-–—)]?(\s*(of|\/)\s*\d{1,4})?$|^[ivxlc]{1,6}$/i;
const norm = (s: string) => s.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/** Remove running headers/footers and page numbers from the edges of each page. */
function stripRepeats(pages: Line[][], heights: number[]): number {
  let removed = 0;
  const count = new Map<string, number>();
  const inZone = (l: Line, h: number) => !h || l.y > h * (1 - ZONE) || l.y < h * ZONE;
  const edges = pages.map((p, i) => {
    const n = p.length;
    return new Set(p.filter((l, j) => (j < EDGE || j >= n - EDGE) && inZone(l, heights[i])));
  });
  for (const e of edges) for (const k of new Set([...e].map((l) => norm(l.text)))) count.set(k, (count.get(k) ?? 0) + 1);
  const need = Math.max(2, Math.ceil(pages.length * 0.5));
  for (let i = 0; i < pages.length; i++) {
    const edge = edges[i];
    pages[i] = pages[i].filter((l) => {
      if (!edge.has(l)) return true;
      const drop = (pages.length >= 2 && (count.get(norm(l.text)) ?? 0) >= need) || PAGE_NO.test(l.text);
      if (drop) removed++;
      return !drop;
    });
  }
  return removed;
}

const BULLET = /^([•●▪◦‣∙·\-–*]|\d{1,3}[.)]|[a-z][.)])\s+/;

function bodySize(pages: Line[][]): number {
  const w = new Map<number, number>();
  for (const p of pages) for (const l of p) w.set(Math.round(l.size * 2) / 2, (w.get(Math.round(l.size * 2) / 2) ?? 0) + l.text.length);
  let best = 10;
  let n = 0;
  for (const [s, c] of w) if (c > n) [best, n] = [s, c];
  return best;
}

function pageInto(ls: Line[], body: number, em: Emitter): void {
  let para = '';
  let paraKind: 'p' | 'li' = 'p';
  let prev: Line | undefined;
  const maxW = Math.max(1, ...ls.map((l) => l.width));
  const flush = () => {
    if (para) {
      if (paraKind === 'li') em.text(para, 'li', { lv: 1 });
      else emitParagraph(em, para);
    }
    para = '';
    paraKind = 'p';
  };
  for (const l of ls) {
    const heading = l.size >= body * 1.15 && l.text.length < 120;
    if (heading) {
      flush();
      // consecutive heading lines of the same size are one heading
      const last = em.blocks[em.blocks.length - 1];
      if (prev && prev.size === l.size && last?.k === 'h' && Math.abs(prev.y - l.y) < l.size * 1.6) {
        em.blocks[em.blocks.length - 1] = em.remake(last, [String(last.i[0]) + ' ' + l.text]);
      } else em.h(l.text, l.size >= body * 1.5 ? 3 : 4);
      prev = l;
      continue;
    }
    const bullet = BULLET.exec(l.text);
    const gap = prev ? prev.y - l.y : 0;
    const newPara =
      !prev ||
      (prev.size >= body * 1.15) ||
      gap > l.size * 1.75 ||
      gap < -l.size || // jumped up: new column
      Math.abs(prev.size - l.size) > 1 ||
      (/[.!?:]["')\]]?$/.test(prev.text) && prev.width < maxW * 0.75) ||
      !!bullet;
    if (newPara) {
      flush();
      if (bullet) {
        paraKind = 'li';
        para = l.text.slice(bullet[0].length);
      } else para = l.text;
    } else if (/[a-z]-$/.test(para) && /^[a-z]/.test(l.text)) para = para.slice(0, -1) + l.text; // hyphenation
    else para += ' ' + l.text;
    prev = l;
  }
  flush();
}

export async function readPdf(input: ReadInput, em = new Emitter(input.url)): Promise<ReadOutput> {
  const title0 = titleFromUrl(input.url);
  const bytes = input.bytes ?? (input.text ? new Uint8Array(Buffer.from(input.text, 'latin1')) : undefined);
  if (!bytes?.length) return { title: title0, kind: 'pdf', blocks: [], notes: ['empty PDF'] };
  let mod: any;
  try {
    mod = await import('unpdf');
  } catch {
    return { title: title0, kind: 'pdf', blocks: [], notes: [`PDF (${bytes.length} bytes): text extraction unavailable (the unpdf package is not installed)`] };
  }
  let pdf: any;
  try {
    // PDF.js may detach the buffer it is given: pass a copy
    pdf = await mod.getDocumentProxy(new Uint8Array(bytes));
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    const enc = /password/i.test(msg);
    return { title: title0, kind: 'pdf', blocks: [], notes: [enc ? 'PDF is password-protected' : `PDF could not be parsed: ${msg.slice(0, 120)}`] };
  }
  try {
    const total: number = pdf.numPages;
    const n = Math.min(total, PAGE_CAP);
    let title = '';
    try {
      const meta = await mod.getMeta(pdf);
      title = squash(String(meta?.info?.Title ?? ''));
    } catch {}
    const pages: Line[][] = [];
    const heights: number[] = [];
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      try {
        heights.push(page.getViewport({ scale: 1 }).height);
      } catch {
        heights.push(0);
      }
      const tc = await page.getTextContent();
      pages.push(lines(tc.items));
      page.cleanup?.();
    }
    const removed = stripRepeats(pages, heights);
    const body = bodySize(pages);
    const notes: string[] = [`PDF, ${total} page${total === 1 ? '' : 's'}`];
    const chars = pages.reduce((a, p) => a + p.reduce((b, l) => b + l.text.length, 0), 0);
    if (!chars) notes.push('no text layer (scanned or image-only PDF?)');
    pages.forEach((ls, i) => {
      if (total > 1) em.h(`Page ${i + 1}`, 2);
      pageInto(ls, body, em);
    });
    if (removed) notes.push(`removed ${removed} running header/footer lines`);
    if (total > n) {
      notes.push(`showing pages 1–${n} of ${total}`);
      em.text(`… ${total - n} more pages not extracted`);
    }
    if (!title) title = em.blocks.find((b) => b.k === 'h' && b.lv !== 2)?.i.join('') ?? title0;
    return { title: title || title0, kind: 'pdf', blocks: em.blocks, notes };
  } finally {
    try {
      await pdf.destroy?.();
    } catch {}
  }
}
