#!/usr/bin/env node
// The agentweb-vs-Playwright scoreboard. One command:
//
//   node run.mjs                      everything: 5 clean runs per tool, every benign variant, every planted bug
//   node run.mjs --runs 3 --only aw   options: --runs N, --workers N, --only aw|pw, --mutants a,b (or none), --benign a,b (or none)
//
// Both tools run the same journeys (playwright/*.spec.ts and agentweb/*.aw) against the fixture app
// (app/server.mjs), started fresh for every run, with the same number of workers. Writes
// results/raw/<stamp>.json and rewrites the "Latest" section of RESULTS.md (older runs stay below it).
//
// Wall time, CPU seconds and peak memory are measured on the whole process tree of the tool (runner,
// browsers, renderers) by sampling /proc every 50 ms; the fixture server is not counted.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BENIGN, MUTANTS } from './mutants.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i < 0 ? d : args[i + 1];
};
const RUNS = Number(opt('runs', 5));
const WORKERS = Number(opt('workers', 2));
const ONLY = opt('only', '');
const AW_CLI = process.env.AGENTWEB_CLI ?? join(HERE, '..', '..', 'dist', 'agentweb.mjs');
const pick = (list, v) => (v === undefined ? list : v === 'none' ? [] : list.filter((m) => v.split(',').includes(m.name)));
const mutants = pick(MUTANTS, opt('mutants'));
const benign = pick(BENIGN, opt('benign'));

// ── process-tree measurement ──
const TICK = 100; // clock ticks per second (getconf CLK_TCK on Linux)
const PAGE = 4096;
function children() {
  const kids = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = readFileSync(`/proc/${d}/stat`, 'utf8');
      const rest = st.slice(st.lastIndexOf(')') + 2).split(' ');
      kids.set(Number(d), { ppid: Number(rest[1]), cpu: Number(rest[11]) + Number(rest[12]), rss: Number(rest[21]) * PAGE });
    } catch {}
  }
  return kids;
}
function tree(root, all) {
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, p] of all) if (!out.has(pid) && out.has(p.ppid)) (out.add(pid), (grew = true));
  }
  return out;
}

function measure(cmd, argv, env) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(cmd, argv, { cwd: HERE, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const cpuBy = new Map();
    let peak = 0;
    const seen = new Set();
    const sample = () => {
      const all = children();
      let rss = 0;
      for (const pid of tree(child.pid, all)) {
        const p = all.get(pid);
        if (!p) continue;
        seen.add(pid);
        rss += p.rss;
        cpuBy.set(pid, Math.max(cpuBy.get(pid) ?? 0, p.cpu));
      }
      peak = Math.max(peak, rss);
    };
    const timer = setInterval(sample, 50);
    sample();
    child.on('close', (code) => {
      clearInterval(timer);
      const cpu = [...cpuBy.values()].reduce((a, b) => a + b, 0) / TICK;
      resolve({ code, wall: (performance.now() - t0) / 1000, cpu, peakMB: peak / 1024 / 1024, procs: seen.size, out });
    });
  });
}

// ── the app ──
const freePort = () =>
  new Promise((r) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => r(port));
    });
  });
async function startApp(mutant) {
  const port = await freePort();
  const p = spawn(process.execPath, [join(HERE, 'app', 'server.mjs'), String(port)], { env: { ...process.env, MUTANT: mutant ?? '' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/login`)).ok) return { base, stop: () => p.kill() };
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  p.kill();
  throw new Error('the fixture app did not start');
}

// ── the tools ──
const TOOLS = {
  pw: {
    label: 'Playwright Test',
    run: (base) => measure(process.execPath, [join(HERE, 'node_modules', '@playwright', 'test', 'cli.js'), 'test', '-c', 'playwright/playwright.config.ts'], { BASE: base, WORKERS: String(WORKERS), PW_OUT: `/tmp/vsp-pw-${process.pid}`, FORCE_COLOR: '0' }),
    // "  ✘  3 journeys.spec.ts:28:1 › report a problem ..." / "✓  1 journeys.spec.ts:5:1 › sign in ..."
    tests: (out) => {
      const t = {};
      for (const m of out.matchAll(/^\s+(✓|✘|-)\s+\d+ (?:\[\w+\] › )?\S+:\d+:\d+ › (.+?)(?: \(\d+(?:\.\d+)?m?s\))?$/gm)) t[m[2].trim()] = m[1] === '✓' ? 'pass' : m[1] === '✘' ? 'fail' : 'skip';
      return t;
    },
  },
  aw: {
    label: 'agentweb test',
    run: (base) => measure(process.execPath, [AW_CLI, 'test', 'agentweb', '--base', base, '--workers', String(WORKERS), '--verbose', '--quiet'], { AGENTWEB_TEST_MEMORY: '0', NO_COLOR: '1' }),
    // "✓ sign in, wrong password, sign out  agentweb/journeys.aw:4 [chrome] 1.2s" / "✗ name  file:line ..."
    tests: (out) => {
      const t = {};
      for (const m of out.matchAll(/^(✓|✗|-) (.+?)  \S+\.aw\b/gm)) t[m[2].trim()] = m[1] === '✓' ? 'pass' : m[1] === '✗' ? 'fail' : 'skip';
      return t;
    },
  },
};
const toolNames = ONLY ? [ONLY] : ['aw', 'pw'];

// ── code size: the test code a person writes and keeps (shared app/world.mjs not counted) ──
function size(dir, isComment) {
  let lines = 0, chars = 0;
  for (const f of readdirSync(join(HERE, dir))) {
    if (!/\.(ts|aw)$/.test(f)) continue;
    for (const l of readFileSync(join(HERE, dir, f), 'utf8').split('\n')) {
      const s = l.trim();
      if (!s || isComment(s)) continue;
      lines++;
      chars += s.length;
    }
  }
  return { lines, chars };
}
const codeSize = {
  pw: size('playwright', (s) => s.startsWith('//') || s.startsWith('/*') || s.startsWith('*')),
  aw: size('agentweb', (s) => s.startsWith('#') && !s.startsWith('##') && !/^#\s*[a-z-]+:/i.test(s)),
};

// ── run ──
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const log = (s) => process.stderr.write(s + '\n');
const raw = { stamp: new Date().toISOString(), runs: RUNS, workers: WORKERS, host: process.env.HOSTNAME ?? '', agentweb: '', playwright: '', clean: {}, benign: {}, mutants: {} };
try {
  raw.agentweb = (await measure(process.execPath, [AW_CLI, '--version'], {})).out.trim().split('\n')[0];
  raw.playwright = JSON.parse(readFileSync(join(HERE, 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version;
} catch {}

async function once(tool, mutant) {
  const app = await startApp(mutant);
  try {
    const r = await TOOLS[tool].run(app.base);
    const tests = TOOLS[tool].tests(r.out);
    return { ...r, tests, ok: r.code === 0 };
  } finally {
    app.stop();
  }
}

for (let i = 0; i < RUNS; i++) {
  // alternate which tool goes first, so neither always gets the warmer machine
  for (const tool of i % 2 ? [...toolNames].reverse() : toolNames) {
    const r = await once(tool, '');
    (raw.clean[tool] ??= []).push({ ok: r.ok, wall: r.wall, cpu: r.cpu, peakMB: r.peakMB, procs: r.procs, tests: r.tests, out: r.ok ? '' : r.out.slice(-4000) });
    log(`clean ${i + 1}/${RUNS} ${tool}: ${r.ok ? 'pass' : 'FAIL'} ${r.wall.toFixed(1)}s wall, ${r.cpu.toFixed(1)}s cpu, ${r.peakMB.toFixed(0)} MB`);
  }
}
for (const b of benign) {
  for (const tool of toolNames) {
    const r = await once(tool, b.name);
    (raw.benign[b.name] ??= {})[tool] = { ok: r.ok, wall: r.wall, tests: r.tests, out: r.ok ? '' : r.out.slice(-3000) };
    log(`benign ${b.name} ${tool}: ${r.ok ? 'pass' : 'FALSE ALARM'} ${r.wall.toFixed(1)}s`);
  }
}
for (const m of mutants) {
  for (const tool of toolNames) {
    const r = await once(tool, m.name);
    const caught = !r.ok;
    const named = caught && m.cause.test(r.out);
    (raw.mutants[m.name] ??= {})[tool] = { caught, named, wall: r.wall, outChars: r.out.length, failed: Object.entries(r.tests).filter(([, v]) => v === 'fail').map(([k]) => k), out: r.out.slice(-3000) };
    log(`mutant ${m.name} ${tool}: ${caught ? (named ? 'caught, cause named' : 'caught') : 'MISSED'} ${r.wall.toFixed(1)}s`);
  }
}

mkdirSync(join(HERE, 'results', 'raw'), { recursive: true });
const stamp = raw.stamp.replace(/[:.]/g, '-').slice(0, 19);
writeFileSync(join(HERE, 'results', 'raw', `${stamp}.json`), JSON.stringify(raw, null, 1));

// ── the table ──
function summary(tool) {
  const runs = raw.clean[tool] ?? [];
  const names = new Set(runs.flatMap((r) => Object.keys(r.tests)));
  const flaky = [...names].filter((n) => {
    const v = runs.map((r) => r.tests[n] ?? 'missing');
    return v.includes('pass') && v.some((x) => x !== 'pass');
  });
  const testRuns = runs.reduce((a, r) => a + Object.keys(r.tests).length, 0);
  const testFails = runs.reduce((a, r) => a + Object.values(r.tests).filter((v) => v !== 'pass').length, 0);
  const bad = Object.values(raw.benign).filter((b) => b[tool] && !b[tool].ok).length;
  const ms = Object.values(raw.mutants).map((m) => m[tool]).filter(Boolean);
  return {
    runs: runs.length,
    passRuns: runs.filter((r) => r.ok).length,
    tests: names.size,
    flaky: flaky.length,
    flakyNames: flaky,
    testFailRate: testRuns ? testFails / testRuns : NaN,
    wall: median(runs.map((r) => r.wall)),
    wallMin: Math.min(...runs.map((r) => r.wall)),
    wallMax: Math.max(...runs.map((r) => r.wall)),
    cpu: median(runs.map((r) => r.cpu)),
    peakMB: median(runs.map((r) => r.peakMB)),
    falseAlarms: bad,
    benign: Object.values(raw.benign).filter((b) => b[tool]).length,
    caught: ms.filter((m) => m.caught).length,
    named: ms.filter((m) => m.named).length,
    mutants: ms.length,
    outChars: median(ms.filter((m) => m.caught).map((m) => m.outChars)),
  };
}
const S = Object.fromEntries(toolNames.map((t) => [t, summary(t)]));
const better = (a, b, lower = true) => (a === b || Number.isNaN(a) || Number.isNaN(b) ? '' : (lower ? a < b : a > b) ? ' ✓' : '');
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '–');
const rows = [];
const row = (label, fmt, key, lower = true) => {
  if (toolNames.length < 2) return rows.push(`| ${label} | ${fmt(S[toolNames[0]], key)} |`);
  const a = S.aw, p = S.pw;
  rows.push(`| ${label} | ${fmt(a, key)}${better(a[key], p[key], lower)} | ${fmt(p, key)}${better(p[key], a[key], lower)} |`);
};
row('Wall time, median (s)', (s) => `${f1(s.wall)} (${f1(s.wallMin)}–${f1(s.wallMax)})`, 'wall');
row('CPU time, median (s)', (s) => f1(s.cpu), 'cpu');
row('Peak memory, median (MB)', (s) => f1(s.peakMB), 'peakMB');
row('Clean runs passed', (s) => `${s.passRuns}/${s.runs}`, 'passRuns', false);
row('Flaky tests (pass and fail across runs)', (s) => `${s.flaky}/${s.tests}`, 'flaky');
row('False alarms on benign variants', (s) => `${s.falseAlarms}/${s.benign}`, 'falseAlarms');
row('Planted bugs caught', (s) => `${s.caught}/${s.mutants}`, 'caught', false);
row('…with the cause named in the output', (s) => `${s.named}/${s.mutants}`, 'named', false);
row('Failure output, median (chars)', (s) => f1(s.outChars), 'outChars');
const sz = (t, k) => codeSize[t][k];
if (toolNames.length === 2) {
  rows.push(`| Test code (lines) | ${sz('aw', 'lines')}${better(sz('aw', 'lines'), sz('pw', 'lines'))} | ${sz('pw', 'lines')}${better(sz('pw', 'lines'), sz('aw', 'lines'))} |`);
  rows.push(`| Test code (characters) | ${sz('aw', 'chars')}${better(sz('aw', 'chars'), sz('pw', 'chars'))} | ${sz('pw', 'chars')}${better(sz('pw', 'chars'), sz('aw', 'chars'))} |`);
}
const missed = (t) => Object.entries(raw.mutants).filter(([, m]) => m[t] && !m[t].caught).map(([k]) => k);
const alarms = (t) => Object.entries(raw.benign).filter(([, b]) => b[t] && !b[t].ok).map(([k]) => k);
const head = toolNames.length === 2 ? `| Metric | agentweb (${raw.agentweb}) | Playwright ${raw.playwright} |\n|:--|--:|--:|` : `| Metric | ${toolNames[0]} |\n|:--|--:|`;
const section = `### ${raw.stamp.slice(0, 16).replace('T', ' ')} UTC · ${RUNS} clean runs per tool · ${WORKERS} workers · ${mutants.length} planted bugs · ${benign.length} benign variants

${head}
${rows.join('\n')}

${toolNames.map((t) => `- ${TOOLS[t].label}: missed ${missed(t).join(', ') || 'none'}; false alarms ${alarms(t).join(', ') || 'none'}; flaky ${S[t].flakyNames.join(', ') || 'none'}.`).join('\n')}
- Raw data: \`results/raw/${stamp}.json\`. ✓ marks the better value.
`;
const file = join(HERE, 'RESULTS.md');
const intro = `# agentweb vs Playwright: scoreboard

Rerun: \`cd bench/vs-playwright && npm install && node run.mjs\` (about 25 minutes; \`--runs 1 --mutants none --benign none\` for a quick look).
What is compared and how: [README.md](README.md). Newest first; losses are reported as losses.

`;
const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
const history = old.includes('### ') ? old.slice(old.indexOf('### ')) : '';
writeFileSync(file, intro + section + (history ? '\n' + history : ''));
log('\n' + section);
