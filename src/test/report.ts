// The report is the product: a passing run is one line, a failing test is four short facts.

import type { TestResult } from './runner.ts';

export interface Summary {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  ms: number;
  tests: TestResult[];
}

export function summarize(tests: TestResult[], ms: number): Summary {
  const failed = tests.filter((t) => !t.ok).length;
  const skipped = tests.filter((t) => t.skipped).length;
  return { ok: failed === 0, passed: tests.length - failed - skipped, failed, skipped, ms, tests };
}

const secs = (ms: number) => (ms < 950 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/** keep an excerpt short whatever the budget produced */
function clip(text: string, maxLines = 8, maxChars = 160): string {
  const lines = text.split('\n').filter((l) => l.trim());
  const shown = lines.slice(0, maxLines).map((l) => (l.length > maxChars ? l.slice(0, maxChars - 1) + '…' : l));
  if (lines.length > maxLines) shown.push(`… ${lines.length - maxLines} more lines`);
  return shown.map((l) => '    ' + l).join('\n');
}

export function formatReport(s: Summary, o: { verbose?: boolean } = {}): string {
  const out: string[] = [];
  if (o.verbose) for (const t of s.tests) if (t.ok) out.push(`${t.skipped ? '-' : '✓'} ${t.name}  ${t.file} (${secs(t.ms)})${t.wrote?.length ? ` [snapshot written: ${t.wrote.join(', ')}]` : ''}`);
  for (const t of s.tests) {
    if (t.ok) continue;
    const f = t.failure!;
    out.push(`✗ ${t.name}  ${t.file}${f.line ? ':' + f.line : ''}`);
    if (f.step) out.push(`  step:  ${f.step}`);
    out.push(`  error: ${f.message}`);
    if (f.excerpt.trim()) out.push('  page:', clip(f.excerpt));
  }
  const wrote = s.tests.flatMap((t) => t.wrote ?? []);
  const parts = [`${s.passed} passed`];
  if (s.failed) parts.unshift(`${s.failed} failed`);
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  out.push(`${s.failed ? '✗' : '✓'} ${parts.join(', ')} (${secs(s.ms)})${wrote.length ? `; ${wrote.length} snapshot${wrote.length > 1 ? 's' : ''} written` : ''}`);
  return out.join('\n');
}
