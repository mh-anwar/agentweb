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

const how = (t: TestResult) => (t.engine ? ` [${(t.engines ?? [t.engine]).join('→')}${t.emulation ? '; ' + t.emulation : ''}]` : '');

/** One test, one line: what --verbose prints, as the test ends. */
export function testLine(t: TestResult): string {
  if (!t.ok) return `✗ ${t.name}  ${t.file}${t.failure?.line ? ':' + t.failure.line : ''} (${secs(t.ms)})${how(t)}`;
  return `${t.skipped ? '-' : '✓'} ${t.name}  ${t.file} (${secs(t.ms)})${how(t)}${t.wrote?.length ? ` [snapshot written: ${t.wrote.join(', ')}]` : ''}`;
}

export function formatReport(s: Summary, o: { verbose?: boolean; streamed?: boolean } = {}): string {
  const out: string[] = [];
  if (o.verbose && !o.streamed) for (const t of s.tests) if (t.ok) out.push(testLine(t));
  // said once however many tests met it
  for (const w of new Set(s.tests.flatMap((t) => t.warnings ?? []))) out.push(`! ${w}`);
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

const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** --report: one page a person can scroll: every test, its result, and the screen it ended on. */
export function htmlReport(s: Summary): string {
  const rows = s.tests.map((t) => {
    const f = t.failure;
    return `<section class="${t.skipped ? 'skip' : t.ok ? 'ok' : 'bad'}"><h2>${t.skipped ? '–' : t.ok ? '✓' : '✗'} ${esc(t.name)}</h2>
<p class="meta">${esc(t.file)}${f?.line ? ':' + f.line : ''} · ${secs(t.ms)}${t.engine ? ' · ' + esc((t.engines ?? [t.engine]).join('→')) : ''}${t.emulation ? ' · ' + esc(t.emulation) : ''}</p>
${(t.warnings ?? []).map((w) => `<p class="warn">! ${esc(w)}</p>`).join('')}${f ? `<pre>${esc((f.step ? 'step:  ' + f.step + '\n' : '') + 'error: ' + f.message)}</pre>` : ''}
${t.shot ? `<a href="${esc(t.shot)}"><img loading="lazy" src="${esc(t.shot)}" alt="where ${esc(t.name)} ended"></a>` : t.skipped ? '' : '<p class="meta">no screenshot: this test did not end in a real browser</p>'}</section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>agentweb test report</title>
<style>body{font:15px/1.45 system-ui,sans-serif;margin:0 auto;max-width:1100px;padding:16px;color:#1b1f24;background:#fff}h1{font-size:20px}h2{font-size:16px;margin:0}
section{border:1px solid #d0d7de;border-left-width:5px;border-radius:6px;padding:12px;margin:12px 0}.ok{border-left-color:#1a7f37}.bad{border-left-color:#cf222e}.skip{border-left-color:#8c959f}
.meta{color:#57606a;margin:4px 0;font-size:13px}.warn{color:#9a6700;margin:4px 0}pre{background:#f6f8fa;padding:8px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
img{max-width:100%;max-height:520px;border:1px solid #d0d7de;display:block;margin-top:8px}
@media(prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}section{border-color:#30363d}pre{background:#161b22}.meta{color:#8b949e}img{border-color:#30363d}}</style></head><body>
<h1>${s.failed ? '✗' : '✓'} ${s.failed ? s.failed + ' failed, ' : ''}${s.passed} passed${s.skipped ? ', ' + s.skipped + ' skipped' : ''} (${secs(s.ms)})</h1>
${rows.join('\n')}
</body></html>
`;
}
