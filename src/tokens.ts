// A fast token estimate with no tokenizer dependency. Budgets are enforced with this.
//
// The constants were fitted (scripts/fit.ts) against o200k_base on agentweb's own rendered output
// for 20 real pages: +4% in total, between -4% and +19% per page. Prose and link-dense lines
// estimate closely; source code over-estimates, which errs on the side of the budget.

const SHORT_WORD = 7; // letters that fit in one token
const EXTRA_PER = 6; // letters per additional token beyond that
const MIXED_PER = 3.5; // letters per token for mixed-case identifiers and acronyms

function raw(s: string): number {
  let t = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) {
      i++; // spaces attach to the following token
      continue;
    }
    if (c === 10 || c === 13) {
      t += 1; // a newline, with any indentation after it
      i++;
      while (i < n) {
        const d = s.charCodeAt(i);
        if (d === 10 || d === 13 || d === 32) i++;
        else break;
      }
      continue;
    }
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) {
      let j = i + 1;
      let upper = c <= 90 ? 1 : 0;
      while (j < n) {
        const d = s.charCodeAt(j);
        if (d >= 97 && d <= 122) j++;
        else if (d >= 65 && d <= 90) {
          upper++;
          j++;
        } else break;
      }
      const len = j - i;
      if (upper <= 1) t += len <= SHORT_WORD ? 1 : 1 + (len - SHORT_WORD) / EXTRA_PER;
      else t += Math.max(1, len / MIXED_PER);
      i = j;
      continue;
    }
    if (c >= 48 && c <= 57) {
      let j = i + 1;
      while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
      t += Math.ceil((j - i) / 3);
      i = j;
      continue;
    }
    if (c < 128) {
      // ASCII punctuation: about one token each; long runs of one character compress
      let j = i + 1;
      while (j < n && s.charCodeAt(j) === c) j++;
      t += j - i > 2 ? 1.5 : j - i;
      i = j;
      continue;
    }
    if (c >= 0x00c0 && c <= 0x024f) {
      t += 0.7; // accented Latin letters
      i++;
      continue;
    }
    t += 1; // CJK, symbols, emoji: about a token per character
    i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
  }
  return t;
}

export function estimateTokens(s: string): number {
  return Math.ceil(raw(s));
}

/** Cut `s` so its estimate fits in `max` tokens, on a word boundary where possible. */
export function clipToTokens(s: string, max: number): string {
  if (max <= 0) return '';
  if (estimateTokens(s) <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (estimateTokens(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  const cut = s.lastIndexOf(' ', lo);
  return s.slice(0, cut > lo * 0.6 ? cut : lo);
}
