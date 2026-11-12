// A small animated-GIF encoder for record(): PNG frames in, one GIF out, no external programs.
//
// Frames from the browser are PNG; they are decoded here (zlib is built into Node), reduced to one
// shared 256-colour palette chosen from what the frames actually contain (a popularity histogram on
// 5 bits per channel: screens of text and flat colour have few colours, so this stays sharp), and
// written as GIF89a with LZW. After the first frame only the rectangle that changed is stored.

import { inflateSync } from 'node:zlib';

export interface Raster {
  w: number;
  h: number;
  /** RGBA, 8 bits per channel */
  px: Uint8Array;
}

/** Decode an 8-bit, non-interlaced PNG (colour types grey, RGB, palette, grey+alpha, RGBA). */
export function decodePng(buf: Uint8Array): Raster {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (b.length < 33 || b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let i = 8; i + 8 <= b.length; ) {
    const len = b.readUInt32BE(i);
    const kind = b.toString('latin1', i + 4, i + 8);
    const data = b.subarray(i + 8, i + 8 + len);
    if (kind === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    i += 12 + len;
  }
  if (depth !== 8 || interlace !== 0 || !w || !h) throw new Error(`unsupported PNG (${depth}-bit${interlace ? ', interlaced' : ''})`);
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels) throw new Error(`unsupported PNG colour type ${type}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1);
    const f = raw[o];
    for (let x = 0; x < stride; x++) {
      const v = raw[o + 1 + x];
      const a = x >= channels ? cur[x - channels] : 0;
      const up = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let r: number;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + up;
      else if (f === 3) r = v + ((a + up) >> 1);
      else {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      cur[x] = r & 255;
    }
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4;
      const s = x * channels;
      if (type === 6) {
        out[d] = cur[s];
        out[d + 1] = cur[s + 1];
        out[d + 2] = cur[s + 2];
        out[d + 3] = cur[s + 3];
      } else if (type === 2) {
        out[d] = cur[s];
        out[d + 1] = cur[s + 1];
        out[d + 2] = cur[s + 2];
        out[d + 3] = 255;
      } else if (type === 0 || type === 4) {
        out[d] = out[d + 1] = out[d + 2] = cur[s];
        out[d + 3] = type === 4 ? cur[s + 1] : 255;
      } else {
        const i = cur[s] * 3;
        out[d] = palette?.[i] ?? 0;
        out[d + 1] = palette?.[i + 1] ?? 0;
        out[d + 2] = palette?.[i + 2] ?? 0;
        out[d + 3] = trns && cur[s] < trns.length ? trns[cur[s]] : 255;
      }
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, px: out };
}

/** A 256-colour palette from the most popular colours (5 bits per channel) across the frames. */
export function buildPalette(frames: Raster[]): Uint8Array {
  const hist = new Uint32Array(32768);
  const sumR = new Uint32Array(32768);
  const sumG = new Uint32Array(32768);
  const sumB = new Uint32Array(32768);
  for (const f of frames) {
    // a sample is enough: every 3rd pixel of every frame
    for (let i = 0; i < f.px.length; i += 12) {
      const r = f.px[i];
      const g = f.px[i + 1];
      const b = f.px[i + 2];
      const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      hist[k]++;
      sumR[k] += r;
      sumG[k] += g;
      sumB[k] += b;
    }
  }
  const keys = Array.from({ length: 32768 }, (_, k) => k).filter((k) => hist[k] > 0).sort((a, b) => hist[b] - hist[a]);
  const pal = new Uint8Array(256 * 3);
  const n = Math.min(256, keys.length);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    pal[i * 3] = Math.round(sumR[k] / hist[k]);
    pal[i * 3 + 1] = Math.round(sumG[k] / hist[k]);
    pal[i * 3 + 2] = Math.round(sumB[k] / hist[k]);
  }
  return pal;
}

/** Palette index for every pixel of a frame (nearest palette colour, remembered per 5-bit colour). */
export function quantize(f: Raster, pal: Uint8Array, memo: Int16Array): Uint8Array {
  const out = new Uint8Array(f.w * f.h);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const r = f.px[i];
    const g = f.px[i + 1];
    const b = f.px[i + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let m = memo[k];
    if (m < 0) {
      // the memo is keyed by the 5-bit colour, so look for the palette entry nearest its centre
      const cr = (r & 0xf8) | 4;
      const cg = (g & 0xf8) | 4;
      const cb = (b & 0xf8) | 4;
      let best = 1e9;
      m = 0;
      for (let j = 0; j < 256; j++) {
        const dr = pal[j * 3] - cr;
        const dg = pal[j * 3 + 1] - cg;
        const db = pal[j * 3 + 2] - cb;
        const d = dr * dr * 2 + dg * dg * 4 + db * db * 3; // green matters most to the eye
        if (d < best) {
          best = d;
          m = j;
        }
      }
      memo[k] = m;
    }
    out[p] = m;
  }
  return out;
}

/** GIF's variable-width LZW over palette indices, minimum code size 8, returned as sub-blocks. */
export function lzw(indices: Uint8Array): number[] {
  const out: number[] = [];
  const MIN = 8;
  const CLEAR = 1 << MIN;
  const END = CLEAR + 1;
  let bits = 0;
  let nbits = 0;
  let size = MIN + 1;
  let next = END + 1;
  let table = new Map<number, number>();
  const bytes: number[] = [];
  const put = (code: number) => {
    bits |= code << nbits;
    nbits += size;
    while (nbits >= 8) {
      bytes.push(bits & 255);
      bits >>>= 8;
      nbits -= 8;
    }
  };
  put(CLEAR);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = (prefix << 8) | c;
    const hit = table.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    put(prefix);
    if (next < 4096) {
      table.set(key, next++);
      if (next - 1 === 1 << size && size < 12) size++;
    } else {
      put(CLEAR);
      table = new Map();
      next = END + 1;
      size = MIN + 1;
    }
    prefix = c;
  }
  put(prefix);
  put(END);
  if (nbits > 0) bytes.push(bits & 255);
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    out.push(n);
    for (let j = 0; j < n; j++) out.push(bytes[i + j]);
  }
  out.push(0);
  return out;
}

export interface GifFrame {
  png: Uint8Array;
  /** how long this frame stays on screen */
  ms: number;
}

export interface GifResult {
  gif: Buffer;
  frames: number;
  w: number;
  h: number;
  /** frames dropped because they were the same as the one before, or a different size */
  skipped: number;
}

/** PNG frames to one animated GIF. Frames that repeat the previous one add to its delay instead. */
export function encodeGif(input: GifFrame[]): GifResult {
  if (!input.length) throw new Error('no frames');
  const rasters = input.map((f) => decodePng(f.png));
  // the picture size most frames have (a frame of another size, say from a resize, is dropped)
  const count = new Map<string, number>();
  for (const r of rasters) count.set(`${r.w}x${r.h}`, (count.get(`${r.w}x${r.h}`) ?? 0) + 1);
  const [mw, mh] = [...count].sort((a, b) => b[1] - a[1])[0][0].split('x').map(Number);
  const w = mw;
  const h = mh;
  const same = rasters.filter((r) => r.w === w && r.h === h);
  const pal = buildPalette(same);
  const memo = new Int16Array(32768).fill(-1);
  const head: number[] = [];
  const le = (n: number) => [n & 255, (n >> 8) & 255];
  head.push(...Buffer.from('GIF89a'), ...le(w), ...le(h), 0xf7, 0, 0, ...pal);
  head.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0); // loop forever
  const parts: Buffer[] = [Buffer.from(head)];
  let prev: Uint8Array | undefined;
  let frames = 0;
  let skipped = 0;
  const cs = (ms: number) => Math.min(1000, Math.max(2, Math.round(ms / 10)));
  const delays: number[] = [];
  for (let k = 0; k < input.length; k++) {
    const r = rasters[k];
    if (r.w !== w || r.h !== h) {
      skipped++;
      if (delays.length) delays[delays.length - 1] += input[k].ms;
      continue;
    }
    const idx = quantize(r, pal, memo);
    // the rectangle that differs from the previous frame
    let x0 = 0;
    let y0 = 0;
    let x1 = w - 1;
    let y1 = h - 1;
    if (prev) {
      x0 = w;
      y0 = h;
      x1 = -1;
      y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (idx[y * w + x] !== prev[y * w + x]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) {
        skipped++;
        delays[delays.length - 1] += input[k].ms;
        continue;
      }
    }
    const fw = x1 - x0 + 1;
    const fh = y1 - y0 + 1;
    const sub = new Uint8Array(fw * fh);
    for (let y = 0; y < fh; y++) sub.set(idx.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + fw), y * fw);
    parts.push(Buffer.from([0x21, 0xf9, 4, 0x04, 0, 0, 0, 0])); // delay patched below; disposal 1: leave in place
    parts.push(Buffer.from([0x2c, ...le(x0), ...le(y0), ...le(fw), ...le(fh), 0, 8]));
    parts.push(Buffer.from(lzw(sub)));
    delays.push(input[k].ms);
    prev = idx;
    frames++;
  }
  // patch each frame's delay into its graphic control extension
  let gce = 0;
  for (const p of parts) {
    if (p.length === 8 && p[0] === 0x21 && p[1] === 0xf9) {
      const c = cs(delays[gce++] ?? 100);
      p[4] = c & 255;
      p[5] = c >> 8;
    }
  }
  parts.push(Buffer.from([0x3b]));
  return { gif: Buffer.concat(parts), frames, w, h, skipped };
}
