// The report is the product: a passing run is one line, a failing test is four short facts.

import type { TestResult } from './runner.ts';

export interface Summary {
  ok: boolean;
  /** tests by the engine their last page was on */
  engines?: Record<string, number>;
  /** CPU and memory of the whole process tree (runner, browser, renderers), sampled; Linux only */
  resources?: { cpuMs: number; peakRssMb: number; processes: number; samples: number };
  passed: number;
  failed: number;
  skipped: number;
  ms: number;
  tests: TestResult[];
}

export function summarize(tests: TestResult[], ms: number): Summary {
  const failed = tests.filter((t) => !t.ok).length;
  const skipped = tests.filter((t) => t.skipped).length;
  const engines: Record<string, number> = {};
  for (const t of tests) if (t.engine && !t.skipped) engines[t.engine] = (engines[t.engine] ?? 0) + 1;
  return { ok: failed === 0, engines, passed: tests.length - failed - skipped, failed, skipped, ms, tests };
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
  const how = (t: TestResult) => (t.engine ? ` [${(t.engines ?? [t.engine]).join('→')}${t.emulation ? '; ' + t.emulation : ''}]` : '');
  if (o.verbose) for (const t of s.tests) if (t.ok) out.push(`${t.skipped ? '-' : '✓'} ${t.name}  ${t.file} (${secs(t.ms)})${how(t)}${t.wrote?.length ? ` [snapshot written: ${t.wrote.join(', ')}]` : ''}`);
  for (const t of s.tests) {
    if (t.ok) continue;
    const f = t.failure!;
    out.push(`✗ ${t.name}  ${t.file}${f.line ? ':' + f.line : ''}${how(t)}`);
    if (f.step) out.push(`  step:  ${f.step}`);
    // a check that lists several things (overflow, audit, console) keeps one per line under the message
    out.push(`  error: ${f.message.split('\n').join('\n         ')}`);
    if (f.excerpt.trim()) out.push('  page:', clip(f.excerpt));
  }
  if (o.verbose && s.resources) out.push(`resources: ${(s.resources.cpuMs / 1000).toFixed(1)} s CPU, ${s.resources.peakRssMb} MiB peak memory, up to ${s.resources.processes} processes (whole process tree, sampled)`);
  const wrote = s.tests.flatMap((t) => t.wrote ?? []);
  const parts = [`${s.passed} passed`];
  if (s.failed) parts.unshift(`${s.failed} failed`);
  if (s.skipped) parts.push(`${s.skipped} skipped`);
  // which engine checked each test: a pass without a real browser is a weaker check than one in Chrome
  const tally = new Map<string, number>();
  for (const t of s.tests) if (t.engine && !t.skipped) tally.set(t.engine, (tally.get(t.engine) ?? 0) + 1);
  const engines = [...tally].sort((a, b) => b[1] - a[1]).map(([e, n]) => `${e} ${n}`).join(', ');
  out.push(`${s.failed ? '✗' : '✓'} ${parts.join(', ')} (${secs(s.ms)}${engines ? '; ' + engines : ''})${wrote.length ? `; ${wrote.length} snapshot${wrote.length > 1 ? 's' : ''} written` : ''}`);
  return out.join('\n');
}
