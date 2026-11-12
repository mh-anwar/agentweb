// Small helpers for screenshots at several widths. No decoding: the width and height of a JPEG are
// in its header, and comparing two pictures is done by the browser (see imgdiff in inpage.ts).

/** Width and height of a JPEG or PNG from its header, or undefined when it is neither. */
export function imageSize(b: Uint8Array): { w: number; h: number } | undefined {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: v.getUint32(16), h: v.getUint32(20) };
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 2; i + 9 < b.length; ) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    // start-of-frame markers carry the size (C4, C8 and CC are not frames)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: v.getUint16(i + 5), w: v.getUint16(i + 7) };
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + v.getUint16(i + 2);
  }
  return undefined;
}

/** `375,768, 1280` / `375 768` / 375 -> [375, 768, 1280]; each between 100 and 4000 px, at most 8, in the order given. */
export function parseWidths(spec: unknown): number[] {
  const out: number[] = [];
  for (const part of String(spec ?? '').split(/[\s,;|/]+/).filter(Boolean)) {
    const w = Number(part.replace(/px$/i, ''));
    if (!Number.isFinite(w) || w < 100 || w > 4000) throw new RangeError(`'${part}' is not a viewport width between 100 and 4000 px`);
    if (!out.includes(Math.round(w))) out.push(Math.round(w));
  }
  if (!out.length) throw new RangeError('no widths given');
  if (out.length > 8) throw new RangeError('at most 8 widths at once');
  return out;
}

/** One line per picture, and the line the test runner reads back: `375 px wide: /path/shot-w375.jpg (375x812 px, 31 KB)`. */
export const SHOT_LINE = /^(\d+) px wide: (.+) \((\d+)x(\d+) px, (\d+) KB\)$/;

export function shotLine(width: number, where: string, size: { w: number; h: number } | undefined, bytes: number): string {
  return `${width} px wide: ${where} (${size ? `${size.w}x${size.h}` : '?'} px, ${Math.max(1, Math.round(bytes / 1024))} KB)`;
}
