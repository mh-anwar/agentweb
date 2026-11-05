// Small constructors and accessors for the page model. Readers and the compiler both use these,
// so block hashes and fingerprints are computed in exactly one place.

import { hash, squash } from './tree.ts';
import type { Act, Block, BlockKind, Inline, Region } from './types.ts';

/** Plain text of an actionable, including the state an agent can see (value, checked). */
export function actText(a: Act): string {
  let s = a.l;
  if (a.val) s += '=' + a.val;
  if (a.on) s += '✓';
  return s;
}

/** Plain text of a block: what `find` indexes and what the content hash covers. */
export function blockText(b: { i: Inline[] }): string {
  let s = '';
  for (const x of b.i) s += typeof x === 'string' ? x : ' ' + actText(x) + ' ';
  return squash(s);
}

export function mkBlock(k: BlockKind, i: Inline[], extra?: Partial<Omit<Block, 'k' | 'i' | 'hx'>>): Block {
  const b: Block = { k, r: extra?.r ?? 'main', i, hx: '' };
  if (extra) Object.assign(b, extra);
  b.hx = blockHash(b);
  return b;
}

export function blockHash(b: Omit<Block, 'hx'> | Block): string {
  let s = b.k + (b.lv ?? '') + '|';
  for (const x of b.i) s += typeof x === 'string' ? x : '\u0001' + x.f + '\u0002' + (x.val ?? '') + (x.on ? '1' : '') + (x.dis ? 'd' : '');
  return hash(s);
}

/** A link actionable. Two links with the same target and label are the same action, so they share a fingerprint. */
export function linkAct(label: string, href: string): Act {
  const l = squash(label).slice(0, 160);
  return { f: 'L' + hash(href + '\n' + l), k: 'link', l, href };
}

/** Convenience for readers: a block of plain text in the main region. */
export function textBlock(s: string, k: BlockKind = 'p', extra?: Partial<Omit<Block, 'k' | 'i' | 'hx'>>): Block {
  return mkBlock(k, [s], { r: 'main' as Region, ...extra });
}

export function words(s: string): number {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < s.length; i++) {
    const ws = s.charCodeAt(i) <= 32;
    if (!ws && !inWord) n++;
    inWord = !ws;
  }
  return n;
}
