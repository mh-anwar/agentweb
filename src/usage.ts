// Opt-in usage log for dogfooding: what agents did with agentweb and how it went, never what they saw or typed.
//
// AGENTWEB_USAGE_LOG=<file> turns it on (one JSON line per run). Each line has the site's host, the step verbs
// (open, find, click, ...; never their arguments), whether it worked, the engine tier, size and time. A failure
// keeps only the error's wording with quoted text and numbers masked. No page text, no URLs past the host, no
// form values: agents use it on logged-in pages.
//
// `agentweb report "<site> | <task> | <why>"` appends to reports.jsonl next to it: what an agent writes when it
// gives up on agentweb and uses another browser. `agentweb usage` sums both up.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseProgram } from './dsl.ts';
import type { RunEvent } from './types.ts';

export interface UsageLine {
  at: string;
  host: string;
  verbs: string[];
  ok: boolean;
  tier?: string;
  tokens: number;
  ms: number;
  fetches: number;
  steps: number;
  error?: string;
}

export function usagePath(): string | undefined {
  const p = process.env.AGENTWEB_USAGE_LOG;
  return p && p.trim() ? p.trim() : undefined;
}

export function reportsPath(usage: string): string {
  return join(dirname(usage), 'reports.jsonl');
}

function hostOf(url?: string): string {
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** The failure's wording without what the agent typed or the page said: quoted text and numbers masked. */
export function scrubError(text: string): string | undefined {
  const line = text.split('\n').find((l) => l.startsWith('✗ '));
  if (!line) return undefined;
  let msg = line.slice(2);
  const dash = msg.indexOf(' — ');
  if (dash >= 0) msg = msg.slice(dash + 3); // drop the step as written (it carries the arguments)
  msg = msg
    .replace(/(["'`‘“])(?:(?!\1).)*\1/g, '…')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\d+/g, 'N');
  return msg.slice(0, 120);
}

export function usageLine(ev: RunEvent): UsageLine {
  let verbs: string[] = [];
  try {
    verbs = parseProgram(ev.program).map((s) => s.verb);
  } catch {
    verbs = ['<unparsed>'];
  }
  const line: UsageLine = {
    at: new Date(ev.at).toISOString(),
    host: hostOf(ev.stats.url),
    verbs: verbs.slice(0, 30),
    ok: ev.ok,
    tokens: ev.stats.tokens,
    ms: ev.stats.ms,
    fetches: ev.stats.fetches,
    steps: ev.stats.steps,
  };
  if (ev.stats.tier) line.tier = ev.stats.tier;
  if (!ev.ok) {
    const e = scrubError(ev.preview);
    if (e) line.error = e;
  }
  return line;
}

function append(path: string, obj: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(obj) + '\n', { mode: 0o600 });
  } catch {
    // logging must never break browsing
  }
}

/** Subscribe a runtime's run events to the usage log, if it is turned on. */
export function attachUsageLog(rt: { subscribe(fn: (e: RunEvent) => void): () => void }): void {
  const p = usagePath();
  if (p) rt.subscribe((ev) => append(p, usageLine(ev)));
}

export function writeReport(usage: string, text: string): void {
  const [site = '', task = '', ...why] = text.split('|').map((s) => s.trim());
  append(reportsPath(usage), { at: new Date().toISOString(), site: site.slice(0, 200), task: task.slice(0, 300), why: why.join(' | ').slice(0, 600) });
}

function readLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as T);
    } catch {}
  }
  return out;
}

/** Plain-text summary of the last `days` days. */
export function summary(usage: string, days = 7): string {
  const since = Date.now() - days * 86400_000;
  const runs = readLines<UsageLine>(usage).filter((r) => Date.parse(r.at) >= since);
  const reports = readLines<{ at: string; site: string; task: string; why: string }>(reportsPath(usage)).filter((r) => Date.parse(r.at) >= since);
  const out: string[] = [`agentweb usage, last ${days} days`];
  if (!runs.length && !reports.length) return out.concat('no runs logged').join('\n');
  const failed = runs.filter((r) => !r.ok);
  const tiers: Record<string, number> = {};
  for (const r of runs) tiers[r.tier ?? '-'] = (tiers[r.tier ?? '-'] ?? 0) + 1;
  const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
  out.push(
    `runs: ${runs.length}, failed: ${failed.length} (${runs.length ? Math.round((100 * failed.length) / runs.length) : 0}%), fallbacks reported: ${reports.length}`,
    `median tokens per run: ${median(runs.map((r) => r.tokens))}, median time: ${median(runs.map((r) => r.ms))} ms`,
    `engine: ${Object.entries(tiers).map(([k, v]) => `${k} ${v}`).join(', ')}`,
  );
  const count = (xs: string[]) => Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const sites = count(failed.map((r) => r.host || '(no page)')).slice(0, 10);
  if (sites.length) out.push('', 'failing sites:', ...sites.map(([h, n]) => `  ${n}  ${h}`));
  const errs = count(failed.map((r) => r.error ?? '(no message)')).slice(0, 10);
  if (errs.length) out.push('', 'failure messages:', ...errs.map(([e, n]) => `  ${n}  ${e}`));
  if (reports.length) out.push('', 'fallbacks (agent gave up on agentweb):', ...reports.slice(-15).map((r) => `  ${r.at.slice(0, 10)}  ${r.site} | ${r.task} | ${r.why}`));
  return out.join('\n');
}
