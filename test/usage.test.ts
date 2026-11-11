import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubError, summary, usageLine, writeReport } from '../src/usage.ts';
import type { RunEvent } from '../src/types.ts';

const ev = (over: Partial<RunEvent> = {}): RunEvent => ({
  at: Date.parse('2026-11-11T10:00:00Z'),
  session: 's',
  program: "open('https://shop.example/login?token=abc'); fill('Password', 'hunter2'); submit()",
  ok: true,
  stats: { steps: 3, ms: 420, tokens: 1300, fetches: 2, tier: 'wire', url: 'https://shop.example/account?id=42' },
  preview: 'Account page for Jane Doe, card ending 4242',
  ...over,
});

test('a usage line keeps verbs and the host, never arguments, paths or page text', () => {
  const line = usageLine(ev());
  assert.deepEqual(line.verbs, ['open', 'fill', 'submit']);
  assert.equal(line.host, 'shop.example');
  const raw = JSON.stringify(line);
  for (const secret of ['hunter2', 'Password', 'token=abc', 'id=42', 'Jane', '4242', '/login', '/account']) {
    assert.ok(!raw.includes(secret), `leaked ${secret}`);
  }
});

test('a failure keeps the error wording with quoted text and numbers masked', () => {
  const line = usageLine(ev({ ok: false, preview: "page\n✗ fill('Password', 'hunter2') — no field matches \"Password\" among 12 fields" }));
  assert.equal(line.error, 'no field matches … among N fields');
  assert.equal(scrubError('all good'), undefined);
});

test('reports and the summary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awusage-'));
  try {
    const usage = join(dir, 'usage.jsonl');
    const lines = [usageLine(ev({ at: Date.now() })), usageLine(ev({ at: Date.now(), ok: false, preview: '✗ x — timed out after 30 s' }))];
    writeFileSync(usage, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeReport(usage, 'maps.example | find a route | the map is a canvas');
    const rep = JSON.parse(readFileSync(join(dir, 'reports.jsonl'), 'utf8'));
    assert.equal(rep.site, 'maps.example');
    assert.equal(rep.why, 'the map is a canvas');
    const s = summary(usage, 7);
    assert.match(s, /runs: 2, failed: 1 \(50%\), fallbacks reported: 1/);
    assert.match(s, /timed out after N s/);
    assert.match(s, /maps\.example \| find a route/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
