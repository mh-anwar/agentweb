// Live checks against the real providers. Needs the public internet; set AGENTWEB_OFFLINE=1 to skip.
// A provider that is rate-limiting this machine is skipped (with the reason), not failed: that is
// the situation the orchestrator's fallback exists for. The merged search must still work.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultProviders, search, SearchState, toBlocks } from '../src/search/index.ts';
import { liveFetcher } from './search.helpers.ts';

const offline = !!process.env.AGENTWEB_OFFLINE;
const QUERIES: Record<string, string> = {
  wikipedia: 'brothers karamazov',
  github: 'rust async runtime',
  stackexchange: 'python dataclass default factory',
  hackernews: 'sqlite',
};

for (const p of defaultProviders().filter((x) => x.available())) {
  test(`live: ${p.name}`, { skip: offline, timeout: 20_000 }, async (t) => {
    const q = QUERIES[p.name] ?? 'sqlite write ahead log';
    try {
      const rs = await p.search(q, { n: 10, fetch: liveFetcher() });
      assert.ok(rs.length > 0, `${p.name} returned nothing for "${q}"`);
      for (const r of rs) assert.match(r.url, /^https?:\/\//);
    } catch (e: any) {
      if (e?.code === 'blocked' || /HTTP 5\d\d/.test(e?.message ?? '')) t.skip(`${p.name} is refusing this machine: ${e.message}`);
      else throw e;
    }
  });
}

test('live: merged search returns results and says what happened', { skip: offline, timeout: 30_000 }, async () => {
  const out = await search('sqlite write ahead log', { n: 10, fetch: liveFetcher(), state: new SearchState() });
  assert.ok(out.results.length >= 5, JSON.stringify(out));
  assert.ok(out.used.length >= 1);
  assert.ok(out.results.some((r) => /sqlite\.org/.test(r.url)), 'the canonical page is found');
  const blocks = toBlocks(out.results, 'sqlite write ahead log');
  assert.equal(blocks.length, out.results.length);
});

test('live: site: search stays on the site', { skip: offline, timeout: 30_000 }, async () => {
  const out = await search('wal mode site:sqlite.org', { n: 5, fetch: liveFetcher(), state: new SearchState() });
  assert.ok(out.results.length > 0, JSON.stringify(out.failed));
  for (const r of out.results) assert.match(r.url, /^https?:\/\/([\w-]+\.)*sqlite\.org(\/|$)/);
});
