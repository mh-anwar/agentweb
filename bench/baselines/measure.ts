// Shared measuring helpers: bytes, proxy tokens, image sizes, markdown tables.

import { encode } from 'gpt-tokenizer/encoding/o200k_base';

/**
 * Token count with OpenAI's o200k_base encoding. This is a PROXY for Claude's tokenizer, which
 * is not public; Claude's counts for the same English/markup text are typically somewhat higher.
 */
export function tokens(text: string): number {
  if (!text) return 0;
  return encode(text).length;
}

export const TOKENIZER_LABEL = 'o200k_base via gpt-tokenizer (proxy for Claude tokenizer)';

export function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export interface ImageInfo {
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  /** width*height/750: Anthropic's published approximation. An ESTIMATE. */
  tokensEst: number;
  /**
   * Same estimate after the API-side downscale Anthropic documents for images whose long edge
   * exceeds 1568 px or that exceed ~1.15 megapixels. Also an ESTIMATE.
   */
  tokensEstAfterResize: number;
}

export const IMAGE_TOKEN_LABEL =
  'estimate: width*height/750 (Anthropic published approximation); "after resize" applies the documented 1568px long-edge / ~1.15MP downscale first';

/** Read width/height from PNG, JPEG, WebP or GIF bytes. */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return undefined;
}

export function imageInfo(base64: string, mimeType: string): ImageInfo {
  const buf = Buffer.from(base64, 'base64');
  const dim = imageSize(buf) ?? { width: 0, height: 0 };
  return {
    mimeType,
    width: dim.width,
    height: dim.height,
    bytes: buf.length,
    tokensEst: Math.round((dim.width * dim.height) / 750),
    tokensEstAfterResize: imageTokensAfterResize(dim.width, dim.height),
  };
}

export function imageTokensAfterResize(w: number, h: number): number {
  if (!w || !h) return 0;
  let scale = 1;
  const longEdge = Math.max(w, h);
  if (longEdge > 1568) scale = Math.min(scale, 1568 / longEdge);
  const maxPixels = 1_150_000;
  if (w * h * scale * scale > maxPixels) scale = Math.min(scale, Math.sqrt(maxPixels / (w * h)));
  const ww = Math.floor(w * scale);
  const hh = Math.floor(h * scale);
  return Math.round((ww * hh) / 750);
}

export function mdTable(header: string[], rows: (string | number)[][], align?: ('l' | 'r')[]): string {
  const a = align ?? header.map((_, i) => (i === 0 ? 'l' : 'r'));
  const esc = (v: string | number) => String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [
    '| ' + header.map(esc).join(' | ') + ' |',
    '|' + a.map((x) => (x === 'r' ? '---:' : ':---')).join('|') + '|',
    ...rows.map((r) => '| ' + r.map(esc).join(' | ') + ' |'),
  ];
  return lines.join('\n');
}

export function fmtInt(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return '–';
  return n.toLocaleString('en-US');
}

export function slugify(url: string): string {
  const u = new URL(url);
  const s = (u.hostname.replace(/^www\./, '') + u.pathname + u.search)
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s.slice(0, 80) || 'root';
}
