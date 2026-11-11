// Store hashes of selected values, not copies of scraped pages. Comparison ignores row order,
// markup and evidence locations; only explicit schema fields determine a semantic change.
import { createHash } from 'node:crypto';
import type { CollectedRow, Selector } from './collect.ts';

export interface CollectionSnapshot {
  scope: string;
  rows: [string, [string, string][]][];
}
export interface CollectionChanges {
  status: 'created' | 'compared' | 'reset' | 'withheld';
  reason?: string;
  added?: string[];
  removed?: string[];
  updated?: { key: string; fields: string[] }[];
}

export function compareCollection(rows: CollectedRow[], fields: Record<string, Selector>, key: string, scope: string, previous?: CollectionSnapshot): { changes: CollectionChanges; snapshot?: CollectionSnapshot } {
  const ids = rows.map(row => row.values[key]);
  if (ids.some(id => id === null || id === undefined || String(id).length > 2048) || new Set(ids.map(String)).size !== rows.length) {
    return { changes: { status: 'withheld', reason: 'missing, duplicate, or oversized keys' } };
  }
  const names = Object.keys(fields).sort();
  const snapshot: CollectionSnapshot = {
    scope: JSON.stringify(['currency-v2', scope, key, names.map(name => [name, fields[name]])]),
    rows: rows.map((row, i) => [String(ids[i]), names.map(name => [name, createHash('sha256').update(JSON.stringify(fields[name] === 'money' ? [row.values[name], row.currencies?.[name] ?? /^(?:[$£€]|USD|GBP|EUR)/.exec(row.evidence[name] ?? '')?.[0] ?? null] : row.values[name])).digest('hex')])]),
  };
  if (rows.length > 256 || JSON.stringify(snapshot).length > 64000) {
    return { changes: { status: 'withheld', reason: 'snapshot limit (256 rows / 64KB)' } };
  }
  if (!previous || previous.scope !== snapshot.scope) {
    return { snapshot, changes: { status: previous ? 'reset' : 'created' } };
  }
  const old = new Map(previous.rows);
  const current = new Map(snapshot.rows);
  const added = [...current.keys()].filter(id => !old.has(id));
  const removed = [...old.keys()].filter(id => !current.has(id));
  const updated: { key: string; fields: string[] }[] = [];
  for (const [id, values] of current) {
    const before = old.get(id);
    if (!before) continue;
    const hashes = new Map(before);
    const changed = values.filter(([name, hash]) => hashes.get(name) !== hash).map(([name]) => name);
    if (changed.length) updated.push({ key: id, fields: changed });
  }
  return { snapshot, changes: { status: 'compared', added, removed, updated } };
}
