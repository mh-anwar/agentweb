// Search results → page blocks: one `row` per result in a shared group. Each row is the title as
// a link, the host, and a snippet trimmed to ~30 words around the query terms.

import { linkAct, mkBlock } from '../blocks.ts';
import type { Block, SearchResult } from '../types.ts';
import { squash } from '../tree.ts';
import { parseQuery } from './search.ts';
import { hostOf } from './url.ts';

const STOP = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'do', 'does', 'i', 'can', 'vs']);

/** Lower-case content words of a query (operators and stop words removed). */
export function queryTerms(q: string): string[] {
  const t = parseQuery(q).text.toLowerCase().replace(/(^|\s)-\S+/g, ' ').replace(/\b(intitle|inurl|filetype|lang):\S+/g, ' ');
  const out = new Set<string>();
  for (const w of t.split(/[^\p{L}\p{N}+#.]+/u)) {
    const x = w.replace(/^\.+|\.+$/g, '');
    if (x.length >= 2 && !STOP.has(x)) out.add(x);
  }
  return [...out];
}

const norm = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, '');

/**
 * Trim `text` to about `max` words, choosing the window with the most query-term hits (earliest
 * on ties) and marking cuts with "…".
 */
export function trimSnippet(text: string, terms: string[], max = 30): string {
  const words = squash(text).split(' ').filter(Boolean);
  if (words.length <= max) return words.join(' ');
  const hit = words.map((w) => {
    const x = norm(w);
    return x && terms.some((t) => x === t || (t.length >= 4 && x.startsWith(t)) || (x.length >= 4 && t.startsWith(x))) ? 1 : 0;
  });
  let best = 0;
  let bestScore = -1;
  let score = 0;
  for (let i = 0; i < words.length; i++) {
    score += hit[i];
    if (i >= max) score -= hit[i - max];
    if (i >= max - 1 && score > bestScore) {
      bestScore = score;
      best = i - max + 1;
    }
  }
  // re-centre on the hits in that window: a short lead-in, the rest after (so the term reads in context)
  if (bestScore > 0) {
    let lo = best;
    while (!hit[lo]) lo++;
    let hi = best + max - 1;
    while (!hit[hi]) hi--;
    const slack = max - (hi - lo + 1);
    best = Math.max(0, Math.min(lo - Math.min(Math.floor(slack / 3), 8), words.length - max));
  }
  // snap a start near the beginning back to the beginning
  if (best <= 3) best = 0;
  const end = Math.min(words.length, best + max);
  return (best > 0 ? '…' : '') + words.slice(best, end).join(' ') + (end < words.length ? ' …' : '');
}

export interface ToBlocksOptions {
  /** group id shared by the rows (default 1) */
  g?: number;
  /** snippet length in words (default 30) */
  words?: number;
}

export function toBlocks(results: SearchResult[], q: string, opts: ToBlocksOptions = {}): Block[] {
  const g = opts.g ?? 1;
  const terms = queryTerms(q);
  return results.map((r) => {
    const host = hostOf(r.url);
    const snip = r.snippet ? trimSnippet(r.snippet, terms, opts.words ?? 30) : '';
    const tail = ' · ' + host + (snip ? ' · ' + snip : '');
    return mkBlock('row', [linkAct(r.title || host || r.url, r.url), tail], { r: 'main', g });
  });
}
