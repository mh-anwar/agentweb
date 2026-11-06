// Plain text → blocks: paragraphs (hard-wrapped lines joined), list items, underlined headings,
// and indented or code-looking runs kept verbatim as `pre`.

import type { ReadInput, ReadOutput } from '../types.ts';
import { Emitter, titleFromUrl } from './util.ts';

const PARA_MAX = 1500;
const LIST = /^\s*([-*•‣◦]|\d{1,3}[.)]|[a-z][.)])\s+(.*)$/;
const CODEY = /[;{}]\s*$|^\s*(def |class |function |import |from |return |if \(|for \(|#include|\$ |>>> )/;

/** Emit a long paragraph as several blocks split at sentence ends, each under PARA_MAX characters. */
export function emitParagraph(em: Emitter, s: string, k: 'p' | 'q' = 'p'): void {
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return;
  while (s.length > PARA_MAX) {
    let cut = -1;
    const re = /[.!?。][)"'”’]?\s/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) && m.index < PARA_MAX) cut = m.index + m[0].length;
    if (cut < PARA_MAX * 0.3) cut = s.lastIndexOf(' ', PARA_MAX);
    if (cut <= 0) cut = PARA_MAX;
    em.text(s.slice(0, cut), k);
    s = s.slice(cut).trim();
  }
  if (s) em.text(s, k);
}

export function textInto(src: string, em: Emitter): void {
  const lines = src.replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n').map((l) => l.replace(/\t/g, '    ').trimEnd());
  // indentation common to the whole document is not structure
  const ind = (l: string) => /^ */.exec(l)![0].length;
  const nonBlank = lines.filter((l) => l.trim());
  const common = nonBlank.length ? Math.min(...nonBlank.map(ind)) : 0;
  const ls = lines.map((l) => l.slice(common));

  let i = 0;
  while (i < ls.length) {
    if (!ls[i].trim()) {
      i++;
      continue;
    }
    // a paragraph = run of non-blank lines
    const start = i;
    while (i < ls.length && ls[i].trim()) i++;
    const para = ls.slice(start, i);

    // underlined heading
    if (para.length >= 2 && /^(=+|-+)$/.test(para[1].trim()) && para[0].trim().length < 120) {
      em.h(para[0], para[1].trim()[0] === '=' ? 1 : 2);
      if (para.length > 2) textInto(para.slice(2).join('\n'), em);
      continue;
    }
    // code: indented by 4+, or several lines that look like code with varied indentation
    const indented = para.every((l) => ind(l) >= 4);
    const codey = para.length >= 2 && para.filter((l) => CODEY.test(l)).length >= para.length / 2 && new Set(para.map(ind)).size > 1;
    if (indented || codey) {
      // following indented paragraphs belong to the same code block
      let end = i;
      while (indented) {
        let j = end;
        while (j < ls.length && !ls[j].trim()) j++;
        if (j >= ls.length || ind(ls[j]) < 4) break;
        end = j;
        while (end < ls.length && ls[end].trim()) end++;
      }
      const block = ls.slice(start, Math.max(i, end));
      i = Math.max(i, end);
      const m = Math.min(...block.filter((l) => l.trim()).map(ind));
      em.text(block.map((l) => l.slice(m)).join('\n').replace(/\n+$/, ''), 'pre');
      continue;
    }
    // lists: each marker line starts an item, other lines continue it
    if (LIST.test(para[0]) && para.filter((l) => LIST.test(l)).length >= Math.min(2, para.length)) {
      const base = ind(para[0]);
      let cur = '';
      let lv = 1;
      const flush = () => {
        if (cur) em.text(cur, 'li', { lv });
        cur = '';
      };
      for (const l of para) {
        const m = LIST.exec(l);
        if (m) {
          flush();
          lv = 1 + Math.max(0, Math.round((ind(l) - base) / 2));
          cur = m[2];
        } else cur += ' ' + l.trim();
      }
      flush();
      continue;
    }
    // a single short title-like line before a paragraph
    if (para.length === 1 && para[0].length < 70 && /^[A-Z0-9][A-Z0-9 .:&/-]{2,}$/.test(para[0].trim()) && /[A-Z]{3}/.test(para[0])) {
      em.h(para[0].trim().replace(/:$/, ''), 2);
      continue;
    }
    // hard-wrapped prose: join, repairing hyphenation at line ends
    let s = '';
    for (const l of para) {
      const t = l.trim();
      if (s.endsWith('-') && /[a-z]-$/.test(s) && /^[a-z]/.test(t)) s = s.slice(0, -1) + t;
      else s += (s ? ' ' : '') + t;
    }
    emitParagraph(em, s);
  }
}

export function readText(input: ReadInput, em = new Emitter(input.url)): ReadOutput {
  const text = input.text ?? new TextDecoder().decode(input.bytes ?? new Uint8Array());
  textInto(text, em);
  const first = em.blocks.find((b) => b.k === 'h' || b.k === 'p');
  const t = first && typeof first.i[0] === 'string' && first.i[0].length < 100 ? first.i[0] : titleFromUrl(input.url);
  return { title: t, kind: 'text', blocks: em.blocks, notes: em.notes.length ? em.notes : undefined };
}
