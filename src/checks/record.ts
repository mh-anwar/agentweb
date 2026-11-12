// record('name') … record(stop=1): the chrome page as an animated GIF in the session's downloads folder.

import type { Step } from '../dsl.ts';
import type { RunCtx } from '../runtime.ts';
import { AwError } from '../types.ts';
import { inChrome } from './index.ts';

const truthy = (v: unknown) => v !== undefined && v !== false && v !== 0 && !/^(0|no|false|off)$/i.test(String(v));

export async function recordVerb(rc: RunCtx, step: Step): Promise<void> {
  const first = step.args[0] === undefined ? '' : String(step.args[0]);
  if (truthy(step.opts.stop) || /^stop$/i.test(first)) {
    const p = rc.rec.page;
    if (!p || p.tier !== 'chrome' || !rc.isLive()) throw new AwError('bad_request', 'no recording is running on this page', "start one with record('name')");
    await rc.ensureLive();
    const res = await rc.live({ do: 'record', op: 'stop' });
    const r = JSON.parse(res.value ?? '{}');
    rc.emit(`saved recording: ${r.path} (${r.frames} frames, ${r.seconds} s, ${Math.max(1, Math.round(r.bytes / 1024))} KB, ${r.w}x${r.h} px${r.capped ? '; stopped at the 30 s limit' : ''})`);
    return;
  }
  await inChrome(rc, 'record()');
  await rc.ensureLive();
  const res = await rc.live({ do: 'record', op: 'start', name: first || undefined });
  rc.note(res.value ?? 'recording');
}
