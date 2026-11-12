// record('name') … record(stop=1): the page as an animated GIF. Frames come from Page.startScreencast
// (at most ~10 a second, 800 px wide); the GIF is made by src/checks/gif.ts when the recording stops.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeGif, type GifFrame } from '../../checks/gif.ts';
import { AwError } from '../../types.ts';
import type { PageDriver } from './page.ts';

const MAX_MS = 30_000;
const MIN_GAP_MS = 90; // ~10 frames a second
const MAX_BYTES = 80 * 1024 * 1024;

interface Rec {
  name: string;
  t0: number;
  frames: { png: Buffer; at: number }[];
  bytes: number;
  off: () => void;
  capped: boolean;
}

const running = new WeakMap<PageDriver, Rec>();

export const isRecording = (d: PageDriver) => running.has(d);

export async function recordStart(d: PageDriver, name: string | undefined): Promise<string> {
  if (running.has(d)) throw new AwError('bad_request', 'a recording is already running on this page', 'record(stop=1) saves it');
  const rec: Rec = { name: (name || 'recording').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'recording', t0: Date.now(), frames: [], bytes: 0, capped: false, off: () => {} };
  rec.off = d.s.on('Page.screencastFrame', (p) => {
    // every frame must be acknowledged or the browser stops sending
    void d.s.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    const at = Date.now();
    if (at - rec.t0 > MAX_MS || rec.bytes > MAX_BYTES) {
      rec.capped = true;
      return;
    }
    const last = rec.frames[rec.frames.length - 1];
    if (last && at - last.at < MIN_GAP_MS) return;
    const png = Buffer.from(String(p.data), 'base64');
    rec.bytes += png.length;
    rec.frames.push({ png, at });
  });
  running.set(d, rec);
  try {
    await d.s.send('Page.startScreencast', { format: 'png', maxWidth: 800, maxHeight: 2000, everyNthFrame: 1 });
    // a page that is not changing sends no frames: take the first one ourselves
    await still(d, rec);
  } catch (e) {
    rec.off();
    running.delete(d);
    throw e;
  }
  return `recording '${rec.name}': record(stop=1) saves it as a GIF (at most ${MAX_MS / 1000} s)`;
}

/** One picture of the page now, the size a screencast frame has, as a frame (a different size is dropped by the encoder). */
async function still(d: PageDriver, rec: Rec): Promise<void> {
  const v = d.viewport;
  const png = await d.s
    .send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: v.width, height: v.height, scale: Math.min(1, 800 / v.width) } })
    .then((r) => Buffer.from(r.data, 'base64'))
    .catch(() => undefined);
  if (png) rec.frames.push({ png, at: Date.now() });
}

/** Stop, encode, save next to the session's downloads; the answer is JSON for the verb. */
export async function recordStop(d: PageDriver): Promise<string> {
  const rec = running.get(d);
  if (!rec) throw new AwError('bad_request', 'no recording is running on this page', "start one with record('name'); it is lost when the page is closed or idle for long");
  running.delete(d);
  await still(d, rec); // how the page ended up, even if nothing changed since the last frame
  rec.off();
  await d.s.send('Page.stopScreencast').catch(() => {});
  const end = Math.min(Date.now(), rec.t0 + MAX_MS);
  if (rec.frames.length < 1) throw new AwError('bad_request', 'the page did not change while recording, so there are no frames', 'do something on the page between record() and record(stop=1)');
  const frames: GifFrame[] = rec.frames.map((f, i) => ({ png: f.png, ms: (rec.frames[i + 1]?.at ?? Math.max(end, f.at + 500)) - f.at }));
  const r = encodeGif(frames);
  const dir = d.downloadDir || mkdtempSync(join(tmpdir(), 'agentweb-files-'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${rec.name}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}.gif`);
  writeFileSync(path, r.gif);
  return JSON.stringify({ path, frames: r.frames, seconds: Math.round((end - rec.t0) / 100) / 10, bytes: r.gif.length, w: r.w, h: r.h, capped: rec.capped });
}
