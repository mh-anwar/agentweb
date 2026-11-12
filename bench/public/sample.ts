// Build the frozen WebVoyager sample.
//
//   node bench/public/sample.ts [--k 10] [--seed 1] [--force]
//
// Writes bench/public/sample-v1.json. The runner only ever reads that file; this script refuses to
// overwrite it without --force so a sample is never regenerated silently.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { Rng } from '../sites/rng.ts';

export const HERE = import.meta.dirname;
export const SAMPLE_PATH = join(HERE, 'sample-v1.json');
const CUTOFF = '2026-12'; // tasks naming a date/year before this are stale

export interface PublicTask {
  id: string;
  site: string;
  split: 'dev' | 'sealed';
  ques: string;
  web: string;
  ref: string;
  /** "golden": the answer must match. "possible": an example; live data may differ. */
  refType: 'golden' | 'possible';
}
export interface Sample {
  version: 1;
  source: string;
  k: number;
  seed: number;
  cutoff: string;
  createdFor: string;
  counts: Record<string, { total: number; stale: number; picked: number; dev: number; sealed: number }>;
  dropped: { id: string; reason: string }[];
  tasks: PublicTask[];
}

const MONTHS = 'January|February|March|April|June|July|August|September|October|November|December';
const MON_ABBR = 'Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

/** Why a task text is (conservatively) stale, or undefined. Months and years are matched case-sensitively. */
export function staleReason(ques: string): string | undefined {
  let m = ques.match(/\b(19|20)\d\d\b/);
  if (m) return `names year ${m[0]} (before ${CUTOFF})`;
  m = ques.match(new RegExp(`\\b(${MONTHS})\\b`)) ?? ques.match(/\bMay\s+\d/) ?? ques.match(/\b\d{1,2}(st|nd|rd|th)?\s+May\b/);
  if (m) return `names a month/date "${m[0]}"`;
  m = ques.match(new RegExp(`\\b(${MON_ABBR})\\.?\\s+\\d`));
  if (m) return `names a date "${m[0]}"`;
  m = ques.match(/\b\d{1,2}\/\d{1,2}\b/);
  if (m) return `numeric date "${m[0]}"`;
  m = ques.match(/Valentine|Christmas|New Year|year before last|last year|next year|weekend of/i);
  if (m) return `time-bound phrase "${m[0]}"`;
  return undefined;
}

export function build(k: number, seed: number): Sample {
  const rows = readFileSync(join(HERE, 'data/WebVoyager_data.jsonl'), 'utf8')
    .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { web_name: string; id: string; ques: string; web: string });
  const refs = JSON.parse(readFileSync(join(HERE, 'data/reference_answer.json'), 'utf8')) as Record<string, { answers: { id: number; type: string; ans: string }[] }>;
  const sites = [...new Set(rows.map((r) => r.web_name))].sort();
  const dropped: Sample['dropped'] = [];
  const tasks: PublicTask[] = [];
  const counts: Sample['counts'] = {};
  for (const site of sites) {
    const mine = rows.filter((r) => r.web_name === site);
    const keep: typeof mine = [];
    for (const r of mine) {
      const why = staleReason(r.ques);
      if (why) dropped.push({ id: r.id, reason: why });
      else keep.push(r);
    }
    const picks = new Rng(`wv-sample:${seed}:${site}`).shuffle(keep.sort((a, b) => a.id.localeCompare(b.id))).slice(0, k);
    const nSealed = picks.length < 2 ? 0 : Math.max(1, Math.round(picks.length * 0.3));
    picks.forEach((r, i) => {
      const idx = Number(r.id.split('--').pop());
      const ref = refs[site]?.answers.find((a) => a.id === idx);
      if (!ref) throw new Error(`no reference answer for ${r.id}`);
      tasks.push({
        id: r.id, site, split: i < picks.length - nSealed ? 'dev' : 'sealed', ques: r.ques, web: r.web,
        ref: ref.ans, refType: ref.type === 'golden' ? 'golden' : 'possible',
      });
    });
    counts[site] = { total: mine.length, stale: mine.length - keep.length, picked: picks.length, dev: picks.length - nSealed, sealed: nSealed };
  }
  return { version: 1, source: 'MinorJerry/WebVoyager data/ @ 5a7896738c10bfb8b9edccce6bb0e0411f8ae569 (Apache-2.0)', k, seed, cutoff: CUTOFF, createdFor: new Date().toISOString().slice(0, 10), counts, dropped, tasks };
}

export function loadSample(): Sample {
  return JSON.parse(readFileSync(SAMPLE_PATH, 'utf8')) as Sample;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { k: { type: 'string', default: '10' }, seed: { type: 'string', default: '1' }, force: { type: 'boolean', default: false } } });
  if (existsSync(SAMPLE_PATH) && !values.force) {
    console.error(`${SAMPLE_PATH} exists; the sample is frozen. Use --force only to start a new version (and rename the file).`);
    process.exit(1);
  }
  const s = build(Number(values.k), Number(values.seed));
  writeFileSync(SAMPLE_PATH, JSON.stringify(s, null, 2) + '\n');
  console.log(`${s.tasks.length} tasks (${s.tasks.filter((t) => t.split === 'dev').length} dev, ${s.tasks.filter((t) => t.split === 'sealed').length} sealed); dropped ${s.dropped.length} stale`);
  for (const [site, c] of Object.entries(s.counts)) console.log(site.padEnd(22), JSON.stringify(c));
}
