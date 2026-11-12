// Deterministic, evidence-carrying collection. No model calls, inferred fields, or hidden retries.
import { compareCollection, type CollectionChanges, type CollectionSnapshot } from './compare.ts';
import { actText, blockText } from '../blocks.ts';
import { squash } from '../tree.ts';
import { TRUNCATED } from '../compile.ts';
import type { Step } from '../dsl.ts';
import type { RunCtx } from '../runtime.ts';
import { estimateTokens } from '../tokens.ts';
import { AwError, type Act, type Block, type Page } from '../types.ts';
import { nextLink, recordBlocks } from './index.ts';

export type Selector = 'text' | 'link' | 'url' | 'money' | 'number';
export interface CollectedRow {
  values: Record<string, string | number | null>;
  evidence: Record<string, string>;
  /** Observed currency marker; $ stays $ because the symbol alone is not an ISO currency. */
  currencies?: Record<string, string>;
  source: { url: string; block: string };
  errors?: Record<string, string>;
}
interface CollectionResult {
  schema: Record<string, Selector>;
  rows: CollectedRow[];
  coverage: {
    complete: boolean;
    scope: string;
    stop: string;
    pages: number;
    found: number;
    returned: number;
    duplicates: number;
    invalid: number;
    omitted: number;
    truncated: boolean;
    next: string | null;
    sources: { url: string; records: number }[];
  };
  changes?: CollectionChanges;
}
const SELECTORS = new Set(['text', 'link', 'url', 'money', 'number']);

// Compare decimal digits, not a rounded floating-point approximation. Exponents are needed
// only for Number.toString(), since input selectors accept ordinary decimal notation.
function decimalIdentity(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value)!;
  let digits = (match[2] + (match[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  const tail = /0*$/.exec(digits)![0].length;
  digits = digits.slice(0, digits.length - tail);
  return `${match[1]}${digits}:${Number(match[4] ?? 0) - (match[3]?.length ?? 0) + tail}`;
}

/** Ambiguous fields are errors, not guesses. Currency numbers use explicit US/UK punctuation. */
export function extractRow(page: Page, block: Block, fields: Record<string, Selector>): CollectedRow {
  const row: CollectedRow = { values: {}, evidence: {}, source: { url: page.url, block: block.hx } };
  const text = blockText(block);
  const links = block.i.filter((x): x is Act => typeof x !== 'string' && x.k === 'link' && !!x.href);
  for (const [name, selector] of Object.entries(fields)) {
    let choices: { value: string | number; quote: string; currency?: string }[] = [];
    const plain: typeof choices = [];
    const named: typeof choices = [];
    const amounts: typeof choices = [];
    if (selector === 'text' && text) choices = [{ value: text, quote: text }];
    if (selector === 'link' || selector === 'url') {
      choices = links.map(a => ({ value: selector === 'url' ? a.href! : a.l, quote: a.l }));
    }
    if (selector === 'money' || selector === 'number') {
      const re = selector === 'money'
        ? /(?<![\p{L}\p{N}])(?<before>[+−-]?)\s*(?<currency>[A-Z]{1,3}\$|[$£€]|USD|GBP|EUR|CAD|AUD|NZD|HKD|SGD)\s*(?<after>[+−-]?)\s*(?<amount>\d[\d., \u00a0\u202f]*)/gu
        : /-?\d[\d.,]*/g;
      // a number in a link's label is part of a name ("Kite 902 Camera"), not a figure about the item
      const hay = selector === 'number' ? squash(block.i.map((x) => (typeof x === 'string' ? x : x.k === 'link' ? ' · ' : ' ' + actText(x) + ' ')).join('')) : text;
      for (const m of hay.matchAll(re)) {
        const quote = m[0].trim();
        if (selector === 'number') {
          const pre = hay.slice(0, m.index);
          const post = hay.slice(m.index! + m[0].length);
          // an amount of money, or the "5" of "4.2 out of 5", is not the figure asked for
          const money = /(?:[$£€]|\b(?:USD|GBP|EUR|CAD|AUD|NZD|HKD|SGD))\s*$/.test(pre);
          if (/(?:out of|\/)\s*$/i.test(pre)) continue;
          const raw = quote.replace(/[.,]+$/, '');
          if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) { choices = []; plain.length = 0; named.length = 0; amounts.length = 0; break; }
          const value = Number(raw.replaceAll(',', ''));
          if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || decimalIdentity(raw.replaceAll(',', '')) !== decimalIdentity(String(value))) { choices = []; plain.length = 0; named.length = 0; amounts.length = 0; break; }
          const choice = { value, quote: raw };
          if (money) {
            amounts.push(choice);
            continue;
          }
          // "3 reviews", "Rating: 4.5": the word on a number says what it counts
          const unit = /^\s*([\p{L}]{3,})/u.exec(post)?.[1]?.toLowerCase();
          const label = /([\p{L}]{3,})\s*:?\s*$/u.exec(pre)?.[1]?.toLowerCase();
          const key = name.toLowerCase();
          const same = (w?: string) => !!w && (w.startsWith(key.slice(0, 4)) || key.startsWith(w.slice(0, 4)));
          if (same(unit) || same(label)) named.push(choice);
          else if (!unit) plain.push(choice);
          choices.push(choice);
          continue;
        }
        const currency = m.groups?.currency;
        const before = m.groups?.before ?? '';
        const after = m.groups?.after ?? '';
        const raw = selector === 'money' ? ((before || after).replace('−', '-') + m.groups!.amount.trim()) : quote;
        // Consume the whole numeric token before validating it. Unsupported grouping and
        // accounting/exponent notation must not turn a partial match into a positive price.
        const prefix = text.slice(0, m.index).trimEnd();
        const suffix = text.slice(m.index! + m[0].length);
        if ((before && after) || (selector === 'money' && (prefix.endsWith('(') || (!/\s$/.test(m[0]) && /^[\p{L}\p{N}]/u.test(suffix))))) {
          choices = [];
          break;
        }
        // Reject locale ambiguity (e.g. 12,50), malformed grouping, and multiple values.
        if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) { choices = []; break; }
        const decimal = raw.replaceAll(',', '');
        const value = Number(decimal);
        if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER || decimalIdentity(decimal) !== decimalIdentity(String(value))) {
          choices = [];
          break;
        }
        choices.push({ value, quote, currency });
      }
    }
    // several numbers on the row: the one the field's name is written on wins, then the one that counts nothing else
    if (selector === 'number' && choices.length > 1) choices = named.length ? named : plain.length ? plain : choices;
    if (selector === 'number' && !choices.length) choices = amounts;
    const unique = [...new Map(choices.map(c => [JSON.stringify([c.value, c.currency]), c])).values()];
    if (unique.length === 1) {
      row.values[name] = unique[0].value;
      row.evidence[name] = unique[0].quote;
      if (unique[0].currency) (row.currencies ??= {})[name] = unique[0].currency;
    } else {
      row.values[name] = null;
      (row.errors ??= {})[name] = unique.length ? 'ambiguous' : 'missing or unsupported format';
    }
  }
  return row;
}

/** Coverage means exhausted observable pagination, never a claim about the site's hidden database. */
export async function collect(rc: RunCtx, step: Step): Promise<void> {
  const fields: Record<string, Selector> = Object.create(null);
  for (const [key, value] of Object.entries(step.opts)) {
    if (['pages', 'diff', 'key'].includes(key)) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key) || !SELECTORS.has(String(value))) {
      throw new AwError('bad_request', `invalid collection field '${key}': use text, link, url, money, or number`);
    }
    fields[key] = value as Selector;
  }
  if (step.args.length || !Object.keys(fields).length || Object.keys(fields).length > 12) {
    throw new AwError('bad_request', "collect needs 1–12 named fields, e.g. collect(name='link', price='money', pages=3)");
  }
  const diff = step.opts.diff;
  const key = step.opts.key;
  if (diff !== undefined || key !== undefined) {
    if (typeof diff !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(diff) || typeof key !== 'string' || !Object.hasOwn(fields, key)) {
      throw new AwError('bad_request', "collection diff needs a name and a schema key, e.g. diff='catalog', key='href'");
    }
  }
  const scope = rc.page.url;
  const limit = step.opts.pages ?? 1;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new AwError('bad_request', 'collect pages must be an integer from 1 to 10');
  }
  const rows: CollectedRow[] = [];
  const sources: { url: string; records: number }[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  let duplicates = 0;
  let invalid = 0;
  let omitted = 0;
  let stop = 'end';
  let next: string | null = null;
  let truncated = false;
  // Reserve room for coverage and page URLs. Rows are never sliced into invalid JSON.
  let left = Math.max(0, rc.remaining - 600);
  for (;;) {
    const page = rc.page;
    if (visited.has(page.url)) { stop = 'cycle'; break; }
    visited.add(page.url);
    const blocks = recordBlocks(page, 1).filter(b => !b.hd);
    sources.push({ url: page.url, records: blocks.length });
    truncated ||= page.notes.includes(TRUNCATED);
    if (page.status >= 400 || page.shell) {
      stop = page.shell ? 'javascript_required' : 'http_error';
      break;
    }
    if (!blocks.length) {
      stop = 'no_records';
      break;
    }
    for (const block of blocks) {
      const row = extractRow(page, block, fields);
      // Redact before JSON escaping: a secret containing quotes must not survive serialization.
      for (const key of Object.keys(row.values)) {
        const value = row.values[key];
        if (typeof value === 'string') row.values[key] = rc.guard.redact(value);
        else if (typeof value === 'number' && rc.guard.redact(String(value)) !== String(value)) {
          row.values[key] = null;
          (row.errors ??= {})[key] = 'redacted';
        }
        if (row.evidence[key]) row.evidence[key] = rc.guard.redact(row.evidence[key]);
      }
      row.source.url = rc.guard.redact(row.source.url);
      // Ignore engine-specific action fingerprints, but preserve distinct linked records.
      const identity = JSON.stringify([blockText(block), block.i.flatMap(x => typeof x !== 'string' && x.k === 'link' ? [x.href] : [])]);
      if (seen.has(identity)) { duplicates++; continue; }
      seen.add(identity);
      if (row.errors) invalid++;
      const cost = estimateTokens(JSON.stringify(row)) + 2;
      if (cost > left) { omitted++; continue; }
      left -= cost;
      rows.push(row);
      rc.guard.observe(new URL(page.url).origin, rc.guard.redact(JSON.stringify(row)), rc.jar.has(page.url));
    }
    next = nextLink(page)?.href ?? null;
    if (omitted) { stop = 'budget'; break; }
    if (!next) {
      // Scripts can hide infinite feeds. Absence of a Next link is insufficient evidence.
      stop = page.stats.scripts || rc.isLive() ? 'dynamic_unverified' : 'end';
      break;
    }
    if (visited.has(next)) { stop = 'cycle'; break; }
    if (sources.length >= limit) { stop = 'page_limit'; break; }
    try {
      await rc.navigate({ url: next, referer: page.url });
    } catch (e) {
      // Preserve partial results while letting the caller distinguish policy and network failure.
      if (rc.ctx.signal?.aborted) throw e;
      stop = e instanceof AwError && e.code === 'policy' ? 'policy' : 'navigation_error';
      break;
    }
  }
  const result: CollectionResult = {
    schema: fields,
    rows,
    coverage: {
      complete: stop === 'end' && !truncated && !invalid && !omitted,
      scope: 'observable pagination', stop, pages: sources.length,
      found: seen.size, returned: rows.length, duplicates, invalid, omitted, truncated, next, sources,
    },
  };
  // Long URLs and quotes can exceed the metadata reserve; shed whole rows and keep the receipt.
  while (estimateTokens(JSON.stringify(result)) > rc.remaining && rows.length) {
    rows.pop();
    result.coverage.returned = rows.length;
    result.coverage.omitted++;
    result.coverage.complete = false;
    result.coverage.stop = 'budget';
  }
  let snapshot: CollectionSnapshot | undefined;
  if (typeof diff === 'string' && typeof key === 'string') {
    if (!result.coverage.complete) result.changes = { status: 'withheld', reason: 'incomplete collection' };
    else {
      const compared = compareCollection(rows, fields, key, scope, rc.rec.collections?.find(([name]) => name === diff)?.[1]);
      result.changes = compared.changes;
      snapshot = compared.snapshot;
      if (estimateTokens(JSON.stringify(result)) > rc.remaining) {
        result.changes = { status: 'withheld', reason: 'diff exceeds output budget' };
        snapshot = undefined;
      }
    }
  }
  const output = JSON.stringify(result, (_key, value) => typeof value === 'string' ? rc.guard.redact(value) : value);
  if (estimateTokens(output) > rc.remaining) throw new AwError('bad_request', 'collection coverage exceeds the output budget; raise budget');
  rc.emit(output);
  // Advance a baseline only after its complete result fits and has been emitted.
  if (snapshot && typeof diff === 'string') {
    rc.rec.collections = [...(rc.rec.collections ?? []).filter(([name]) => name !== diff), [diff, snapshot]].slice(-4) as [string, CollectionSnapshot][];
  }
}
