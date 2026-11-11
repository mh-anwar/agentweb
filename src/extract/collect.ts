// Deterministic, evidence-carrying collection. No model calls, inferred fields, or hidden retries.
import { compareCollection, type CollectionChanges, type CollectionSnapshot } from './compare.ts';
import { blockText } from '../blocks.ts';
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

/** Ambiguous fields are errors, not guesses. Currency numbers use explicit US/UK punctuation. */
export function extractRow(page: Page, block: Block, fields: Record<string, Selector>): CollectedRow {
  const row: CollectedRow = { values: {}, evidence: {}, source: { url: page.url, block: block.hx } };
  const text = blockText(block);
  const links = block.i.filter((x): x is Act => typeof x !== 'string' && x.k === 'link' && !!x.href);
  for (const [name, selector] of Object.entries(fields)) {
    let choices: { value: string | number; quote: string }[] = [];
    if (selector === 'text' && text) choices = [{ value: text, quote: text }];
    if (selector === 'link' || selector === 'url') {
      choices = links.map(a => ({ value: selector === 'url' ? a.href! : a.l, quote: a.l }));
    }
    if (selector === 'money' || selector === 'number') {
      const re = selector === 'money'
        ? /(?:[$£€]\s*-?\d[\d.,]*|\b(?:USD|GBP|EUR)\s+-?\d[\d.,]*)/g
        : /-?\d[\d.,]*/g;
      for (const m of text.matchAll(re)) {
        const raw = m[0].replace(/^(?:[$£€]\s*|(?:USD|GBP|EUR)\s+)/, '');
        // Reject locale ambiguity (e.g. 12,50), malformed grouping, and multiple values.
        if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) { choices = []; break; }
        const value = Number(raw.replaceAll(',', ''));
        if (Number.isFinite(value)) choices.push({ value, quote: m[0] });
      }
    }
    const unique = [...new Map(choices.map(c => [JSON.stringify(c.value), c])).values()];
    if (unique.length === 1) {
      row.values[name] = unique[0].value;
      row.evidence[name] = unique[0].quote;
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
