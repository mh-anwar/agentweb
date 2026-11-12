// screenshot('name', widths='375,768', threshold=0.01) in a test file: the picture at each width is
// compared with `__aw_screenshots__/<file>/<test>.<name>.<width>.jpg` next to the test file, the way
// snapshot('name') compares text. The pixel comparison runs in the browser (see imgdiff in
// src/checks/inpage.ts), so nothing here decodes an image.

import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { registerImgdiff } from '../checks/index.ts';
import { SHOT_LINE } from '../checks/shots.ts';
import type { Step } from '../dsl.ts';
import type { RuntimeImpl } from '../runtime.ts';
import { baseName, type TestCase } from './parse.ts';

/** `screenshot('name'…)`, `screenshot()`, `screenshot(widths=…)`: a comparison. `screenshot(12)` is a plain shot. */
export const SCREENSHOT = /^\s*(?:await\s+)?screenshot\s*\(\s*(?:['"`]|\)|[a-z_]+\s*=)/i;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'test';

export function screenshotPath(tc: TestCase, name: string, width: number, actual = false): string {
  return join(dirname(tc.file), '__aw_screenshots__', baseName(tc.file), `${slug(tc.name)}.${slug(name)}.${width}${actual ? '.actual' : ''}.jpg`);
}

/** the message of a failed run: "✗ step — message" */
const errorOf = (text: string) => {
  const first = text.split('\n')[0] ?? '';
  const m = /^✗ .*? — (.*)$/.exec(first);
  return m ? m[1] : first || 'step failed';
};

export async function compareScreenshot(
  rt: RuntimeImpl,
  sid: string,
  tc: TestCase,
  step: Step,
  o: { update?: boolean; ci?: boolean; excerptTokens: number },
  signal?: AbortSignal,
): Promise<{ wrote?: string[]; failure?: string }> {
  registerImgdiff(rt);
  const name = typeof step.args[0] === 'string' && step.args[0] ? step.args[0] : 'page';
  const threshold = step.opts.threshold === undefined ? 0.01 : Number(step.opts.threshold);
  if (!(threshold >= 0 && threshold <= 1)) return { failure: `threshold is a share of pixels between 0 and 1 (0.01 is 1%), not '${step.opts.threshold}'` };
  const widths = step.opts.widths === undefined ? 'now' : String(step.opts.widths);
  const full = step.opts.full !== undefined && step.opts.full !== 0 && step.opts.full !== false && !/^(0|no|false|off)$/i.test(String(step.opts.full));
  const r = await rt.run(sid, `shot(widths=${JSON.stringify(widths)}, save=1${full ? ', full=1' : ''})`, { budget: o.excerptTokens, signal });
  if (!r.ok) return { failure: errorOf(r.text) };
  const shots = r.text.split('\n').flatMap((l) => {
    const m = SHOT_LINE.exec(l);
    return m ? [{ w: Number(m[1]), file: m[2] }] : [];
  });
  if (!shots.length) return { failure: `no screenshot was taken: ${r.text.split('\n')[0]}` };

  const wrote: string[] = [];
  const failures: string[] = [];
  for (const { w, file } of shots) {
    const base = screenshotPath(tc, name, w);
    const actual = screenshotPath(tc, name, w, true);
    const rel = (p: string) => (p.startsWith(dirname(tc.file) + '/') ? p.slice(dirname(tc.file).length + 1) : p);
    const accept = () => {
      mkdirSync(dirname(base), { recursive: true });
      copyFileSync(file, base);
      if (existsSync(actual)) unlinkSync(actual);
      wrote.push(`${name}@${w}`);
    };
    if (!existsSync(base)) {
      if (!o.update && o.ci) {
        failures.push(`no baseline for screenshot '${name}' at ${w} px (run without --ci, or with --update, to write it)`);
        continue;
      }
      accept();
      continue;
    }
    const d = await rt.run(sid, `imgdiff(${JSON.stringify(base)}, ${JSON.stringify(file)})`, { budget: o.excerptTokens, signal });
    const json = d.text.split('\n').find((l) => l.startsWith('{'));
    if (!d.ok || !json) {
      failures.push(`could not compare screenshot '${name}' at ${w} px: ${errorOf(d.text)}`);
      continue;
    }
    const diff = JSON.parse(json) as { resized?: boolean; w: number; h: number; w2?: number; h2?: number; ratio: number };
    if (!diff.resized && diff.ratio <= threshold) {
      if (existsSync(actual)) unlinkSync(actual);
      continue;
    }
    if (o.update) {
      accept();
      continue;
    }
    mkdirSync(dirname(actual), { recursive: true });
    copyFileSync(file, actual);
    const pct = (diff.ratio * 100).toFixed(diff.ratio < 0.001 ? 3 : 1);
    failures.push(
      diff.resized
        ? `screenshot '${name}' at ${w} px changed size: ${diff.w}x${diff.h} in the baseline, ${diff.w2}x${diff.h2} now (the new picture is ${rel(actual)}; --update accepts it)`
        : `screenshot '${name}' at ${w} px differs from the baseline in ${pct}% of pixels (limit ${+(threshold * 100).toFixed(2)}%); the new picture is ${rel(actual)}; --update accepts it`,
    );
  }
  return { wrote: wrote.length ? wrote : undefined, failure: failures.length ? failures.join('\n') : undefined };
}
