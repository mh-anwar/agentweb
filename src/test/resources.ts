// What a test run cost, measured on the process tree: this process and everything under it (the
// browser, its renderers, script-engine children). Sampled from /proc, so it needs no helper process
// and counts a browser that is killed rather than waited for, which getrusage(RUSAGE_CHILDREN) misses.
// Linux only; elsewhere the run reports nothing rather than a guess.

import { readdirSync, readFileSync } from 'node:fs';

export interface Resources {
  /** user + system CPU of every process seen in the tree, milliseconds */
  cpuMs: number;
  /** highest sum of resident memory over the tree at one sample, MiB (shared pages are counted per process) */
  peakRssMb: number;
  /** most processes alive at one sample */
  processes: number;
  samples: number;
}

const TICK_MS = 10; // USER_HZ is 100 on every mainstream Linux
const PAGE_KB = 4;

interface Proc {
  ppid: number;
  cpuMs: number;
  rssKb: number;
}

function snapshot(): Map<number, Proc> {
  const procs = new Map<number, Proc>();
  let names: string[] = [];
  try {
    names = readdirSync('/proc');
  } catch {
    return procs;
  }
  for (const name of names) {
    if (name.charCodeAt(0) < 48 || name.charCodeAt(0) > 57) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'latin1');
      // the command name is in parentheses and may contain spaces: fields are counted after the last ')'
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      procs.set(Number(name), { ppid: Number(f[1]), cpuMs: (Number(f[11]) + Number(f[12])) * TICK_MS, rssKb: Number(f[21]) * PAGE_KB });
    } catch {}
  }
  return procs;
}

export function watchResources(rootPid: number = process.pid, everyMs = 200): { stop(): Resources | undefined } {
  if (process.platform !== 'linux') return { stop: () => undefined };
  const cpu = new Map<number, number>();
  let peakKb = 0;
  let most = 0;
  let samples = 0;
  const sample = () => {
    const procs = snapshot();
    const kids = new Map<number, number[]>();
    for (const [pid, p] of procs) {
      const list = kids.get(p.ppid);
      if (list) list.push(pid);
      else kids.set(p.ppid, [pid]);
    }
    let rss = 0;
    let n = 0;
    const stack = [rootPid];
    while (stack.length) {
      const pid = stack.pop()!;
      const p = procs.get(pid);
      if (!p) continue;
      n++;
      rss += p.rssKb;
      if ((cpu.get(pid) ?? 0) < p.cpuMs) cpu.set(pid, p.cpuMs);
      for (const k of kids.get(pid) ?? []) stack.push(k);
    }
    if (rss > peakKb) peakKb = rss;
    if (n > most) most = n;
    samples++;
  };
  const base = snapshot().get(rootPid)?.cpuMs ?? 0;
  sample();
  const timer = setInterval(sample, everyMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      sample();
      let total = -base;
      for (const v of cpu.values()) total += v;
      return { cpuMs: Math.max(0, Math.round(total)), peakRssMb: Math.round(peakKb / 1024), processes: most, samples };
    },
  };
}
