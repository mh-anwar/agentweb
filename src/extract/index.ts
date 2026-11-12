// Verb pack: records and fan-out. Both exist to save turns, which is where agents spend most tokens.
//
//   records('words'?, pages=N)            the page's repeated items (cards, rows, results), one line each,
//                                         filtered by words, following "next" up to N pages
//   each('link words', find='q', n=8)     open up to n matching links at once (plain HTTP, shared cache)
//                                         and show the lines of each that match q

import { collect } from './collect.ts';
import { blockText } from '../blocks.ts';
import { rank, renderLine, terms } from '../render.ts';
import { flagInjections, normalizeUrl, type RunCtx, type RuntimeImpl } from '../runtime.ts';
import type { Step } from '../dsl.ts';
import type { Act, Block, Page } from '../types.ts';
import { AwError } from '../types.ts';
import { estimateTokens } from '../tokens.ts';

const CONTENT = new Set(['main', 'other', 'dialog']);
// Words that name a kind of field or the list itself, not something written on an item ("price", "rating", "all"):
// compared after terms() has stemmed them
const GENERIC_FIELDS = new Set([
  'price', 'prices', 'name', 'names', 'product', 'products', 'record', 'records', 'result', 'results', 'item', 'items',
  'cost', 'rating', 'review', 'title', 'link', 'url', 'detail', 'description', 'availability', 'all', 'every', 'list', 'row', 'entry', 'entrie',
  'article', 'story', 'storie', 'post', 'date', 'author', 'field',
]);
const NEXT = /^(?:next(?: page)?|older(?: posts| entries)?|more|load more|›|»|→|next ›|next »|next →)$/i;

const str = (a: unknown) => (a === undefined || a === null ? '' : String(a));
const num = (a: unknown, d: number) => (typeof a === 'number' && Number.isFinite(a) ? a : d);

export function register(rt: RuntimeImpl): void {
  rt.register('records', records);
  rt.register('collect', collect);
  rt.register('each', each);
}

// ───────────────────────────── records ─────────────────────────────

/** Main repeated structures. min=1 retains every recognized group, including short final pages. */
export function recordBlocks(page: Page, min = 3): Block[] {
  const groups = new Map<number, Block[]>();
  for (const b of page.blocks) {
    if (b.g === undefined || !CONTENT.has(b.r) || b.k === 'pre') continue;
    let g = groups.get(b.g);
    if (!g) groups.set(b.g, (g = []));
    g.push(b);
  }
  const big = [...groups.values()].filter((g) => g.length >= min).sort((a, b) => b.length - a.length);
  if (!big.length) return [];
  // keep every group at least half the size of the largest (e.g. two product grids), in page order
  const keep = new Set(big.filter((g) => min === 1 || g.length * 2 >= big[0].length).flat());
  return page.blocks.filter((b) => keep.has(b));
}

/**
 * A ranked list whose items take two rows ("1. Title (site)" then "92 points by x | 32 comments", as on Hacker News):
 * each numbered row and the row or two under it are one item. Other lists: one row, one item.
 */
export function rankedItems(recs: Block[]): Block[][] {
  const ranked = (b: Block) => /^\s*\d{1,4}\.(?:\s|$)/.test(blockText(b));
  const n = recs.filter(ranked).length;
  if (n < 5 || n === recs.length) return recs.map((b) => [b]);
  const out: Block[][] = [];
  let open: Block[] | undefined;
  for (const b of recs) {
    if (ranked(b)) out.push((open = [b]));
    else if (open && open.length < 3) open.push(b);
    else {
      out.push([b]);
      open = undefined;
    }
  }
  return out;
}

function matches(b: Block, q: string[]): boolean {
  if (!q.length) return true;
  const t = new Set(terms(blockText(b)));
  return q.every((w) => t.has(w));
}

export function nextLink(page: Page): Act | undefined {
  let best: Act | undefined;
  const first = page.blocks.indexOf(recordBlocks(page)[0]);
  for (const [index, b] of page.blocks.entries()) {
    // Before the list, accept a pager-only block but not a mixed site menu that
    // happens to include a page called "Load more" or "Next".
    if (index < first) {
      const links = b.i.filter((x): x is Act => typeof x !== 'string' && x.k === 'link');
      if (!links.length || links.some(x => !NEXT.test(x.l.trim()) && !/^(?:next\b.*|previous(?: page)?|prev|first|last|\d+|«|‹|←)$/i.test(x.l.trim()))) continue;
    }
    if (b.r === 'footer') continue;
    for (const x of b.i) {
      if (typeof x === 'string' || x.k !== 'link' || !x.href) continue;
      const l = x.l.trim();
      if (NEXT.test(l) || /^next\b/i.test(l)) {
        // prefer the last one (pagers usually sit after the list)
        best = x;
      }
    }
  }
  return best;
}

/** A "Next" that is a button rather than a link, and can be pressed. */
function nextButton(page: Page): Act | undefined {
  let best: Act | undefined;
  for (const b of page.blocks) {
    if (b.r === 'footer') continue;
    for (const x of b.i) {
      if (typeof x === 'string' || (x.k !== 'button' && x.k !== 'click') || x.dis) continue;
      const l = x.l.trim();
      if (NEXT.test(l) || /^next\b/i.test(l)) best = x;
    }
  }
  return best;
}

async function records(rc: RunCtx, step: Step): Promise<void> {
  let q = [...new Set(terms(str(step.args[0])))];
  let dropped = '';
  if (q.length) {
    // Generic field requests like "price" mean show the data. Specific queries remain
    // filters across all pages, even when the first page has no match.
    const first = recordBlocks(rc.page, 1);
    if (first.length && q.some((word) => GENERIC_FIELDS.has(word)) && !first.some((b) => matches(b, q))) {
      const kept = q.filter((word) => !GENERIC_FIELDS.has(word));
      dropped = kept.length ? `no record has the word${q.length - kept.length > 1 ? 's' : ''} ${q.filter((w) => GENERIC_FIELDS.has(w)).map((w) => `'${w}'`).join(', ')} (words filter what is written on an item), so only the rest is used. ` : `no record mentions '${str(step.args[0])}', so all are shown. `;
      q = kept;
    }
  }
  const pages = Math.max(1, Math.min(10, num(step.opts.pages, 1)));
  const seen = new Set<string>();
  const lines: string[] = [];
  let total = 0;
  let left = rc.remaining - 60;
  let more = 0;
  let visited = 0;
  for (;;) {
    const page = rc.page;
    visited++;
    const recs = recordBlocks(page, 1).filter(b => !b.hd);
    for (const item of rankedItems(recs)) {
      const b = item[0];
      if (seen.has(b.hx) || !(item.length === 1 ? matches(b, q) : matches({ i: item.flatMap((x) => [...x.i, ' ']) } as Block, q))) continue;
      seen.add(b.hx);
      total++;
      const line = item.map((x) => renderLine(x, rc.refs, { maxWords: 60 })).join(' — ');
      const est = estimateTokens(line) + 1;
      if (est > left) {
        more++;
        continue;
      }
      left -= est;
      lines.push(line);
    }
    if (visited >= pages || left < 80) break;
    const next = nextLink(page);
    if (next?.href && next.href !== page.url) {
      await rc.navigate({ url: next.href, referer: page.url });
      continue;
    }
    if (!page.stats.scripts && !rc.isLive()) break;
    const before = new Set(recordBlocks(rc.page, 1).map((b) => b.hx));
    // a pager made of buttons (a single-page app): press its Next
    const button = nextButton(page);
    if (button) {
      try {
        await rc.verb('click', [rc.refs.of(button)]);
      } catch {
        break;
      }
      if (!recordBlocks(rc.page, 1).some((b) => !before.has(b.hx))) break;
      continue;
    }
    // no pager: an infinite feed loads more as it scrolls
    try {
      await rc.verb('scroll', ['bottom']);
    } catch {
      break;
    }
    // Engine escalation can regroup the first batch, and virtualized feeds replace rows
    // without growing the DOM. Progress is new content, rather than a larger row count.
    if (!recordBlocks(rc.page, 1).some((b) => !before.has(b.hx))) break;
  }
  const head = `${dropped}${total} record${total === 1 ? '' : 's'}${q.length ? ` matching '${str(step.args[0])}'` : ''}${visited > 1 ? ` over ${visited} pages` : ''}`;
  if (!total) {
    rc.emit(`${head}. ${seen.size || q.length ? `No records matched across ${visited} page${visited === 1 ? '' : 's'}; search('exact item name') uses this site's search when available.` : `No repeated items found here; try find('words') or view().`}`);
    return;
  }
  rc.emit([head + ':', ...lines, ...(more ? [`… +${more} more (raise budget, or narrow with words)`] : [])].join('\n'));
}

// ───────────────────────────── each ─────────────────────────────

export function pickLinks(page: Page, words: string, n: number): Act[] {
  const q = [...new Set(terms(words))];
  const out: Act[] = [];
  const seen = new Set<string>();
  for (const b of page.blocks) {
    if (!CONTENT.has(b.r)) continue;
    for (const x of b.i) {
      if (typeof x === 'string' || x.k !== 'link' || !x.href || !/^https?:/.test(x.href)) continue;
      const href = x.href.split('#')[0];
      if (seen.has(href) || href === page.url.split('#')[0]) continue;
      if (q.length) {
        // match the link's own text and URL, or the line it sits on (e.g. "Add to cart" rows)
        const hay = new Set(terms(`${x.l} ${x.href} ${blockText(b)}`));
        if (!q.every((w) => hay.has(w))) continue;
      }
      seen.add(href);
      out.push(x);
      if (out.length >= n) return out;
    }
  }
  return out;
}

/** The lines of `page` that best match `query`, within `budget` tokens (no refs: these pages are not open). */
export function bestLines(page: Page, query: string, budget: number, max = 6): string[] {
  const out: string[] = [];
  let left = budget;
  const take = (b: Block) => {
    const line = renderLine(b, null, { maxWords: 50 });
    const est = estimateTokens(line) + 1;
    if (est > left) return false;
    left -= est;
    out.push(line);
    return true;
  };
  if (query) {
    for (const h of rank(page, query)) {
      if (out.length >= max) break;
      if (!take(page.blocks[h.index])) break;
    }
  } else {
    // no question: the first lines of real content
    for (const b of page.blocks) {
      if (out.length >= Math.min(max, 3)) break;
      if (!CONTENT.has(b.r) || b.k === 'pre') continue;
      if (blockText(b).split(/\s+/).length < 4) continue;
      if (!take(b)) break;
    }
  }
  return out;
}

async function each(rc: RunCtx, step: Step): Promise<void> {
  const words = str(step.args[0]);
  const query = str(step.opts.find ?? step.args[1]);
  const n = Math.max(1, Math.min(20, num(step.opts.n, 8)));
  const page = rc.page;
  const links = pickLinks(page, words, n);
  if (!links.length) {
    rc.emit(words ? `no links on this page match '${words}'` : 'no links on this page');
    return;
  }
  const per = Math.max(60, Math.floor((rc.remaining - 40) / links.length));
  const wire = rc.engine('wire');
  const results: string[] = new Array(links.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= links.length) return;
      const a = links[i];
      const ref = rc.refs.of(a);
      try {
        const url = normalizeUrl(a.href!);
        const v = await rc.guard.checkStep({ verb: 'open', origin: new URL(page.url).origin, dest: url, method: 'GET' });
        if (!v.ok) throw new AwError('policy', v.reason ?? 'refused');
        const loaded = await wire.open({ ...rc.ctx }, { url, referer: page.url, read: true });
        rc.fetches++;
        const p = await rc.toPage(loaded, 'wire');
        flagInjections(p, rc.rt.deps.scoreInjection);
        const title = p.title || a.l;
        if (p.shell || loaded.escalate) {
          results[i] = `## [${a.l}]${ref} ${title}\n(needs JavaScript; click(${ref}) to open it in a browser)`;
          continue;
        }
        const ls = bestLines(p, query, per - estimateTokens(title) - 8);
        const status = p.status >= 400 ? ` (HTTP ${p.status})` : '';
        results[i] = `## [${a.l}]${ref} ${title}${status}\n${ls.length ? ls.join('\n') : query ? `no match for '${query}'` : '(no text)'}`;
        // what the agent sees from that page counts for data-flow tracking under that page's origin
        rc.guard.observe(new URL(p.url).origin, ls.join('\n'), rc.jar.has(p.url));
      } catch (e) {
        results[i] = `## [${a.l}]${ref}\n✗ ${(e as Error).message}`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, links.length) }, worker));
  const body = results.join('\n');
  rc.emit(`${links.length} page${links.length === 1 ? '' : 's'}${query ? `, lines matching '${query}'` : ''}:\n${body}`);
}
