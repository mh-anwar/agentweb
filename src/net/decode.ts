// Content-Type parsing, MIME sniffing and charset decoding for the wire tier.

export interface Mime {
  /** lower-case type/subtype, '' when missing or unparseable */
  mime: string;
  charset?: string;
}

export function parseContentType(ct: string | undefined): Mime {
  if (!ct) return { mime: '' };
  // a server sending several Content-Type values joined by ', ': the last valid one wins (Fetch)
  const parts = ct.split(/,(?=\s*[a-z0-9!#$%&'*+.^_`|~-]+\/)/i);
  const last = parts[parts.length - 1];
  const semi = last.indexOf(';');
  const mime = (semi < 0 ? last : last.slice(0, semi)).trim().toLowerCase();
  if (!/^[a-z0-9!#$%&'*+.^_`|~-]+\/[a-z0-9!#$%&'*+.^_`|~-]+$/.test(mime)) return { mime: '' };
  const m = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(last);
  const charset = m ? (m[1] ?? m[2] ?? '').trim().toLowerCase() : undefined;
  return charset ? { mime, charset } : { mime };
}

export const isHtml = (m: string) => m === 'text/html' || m === 'application/xhtml+xml';

const TEXT_APP = new Set([
  'application/json', 'application/ld+json', 'application/xml', 'application/javascript', 'application/ecmascript',
  'application/x-javascript', 'application/x-ndjson', 'application/ndjson', 'application/csv', 'application/x-yaml',
  'application/yaml', 'application/toml', 'application/x-www-form-urlencoded', 'application/graphql',
  'application/sql', 'application/x-sh', 'application/x-httpd-php', 'application/markdown', 'application/rtf',
  'application/x-subrip', 'application/problem+json', 'application/manifest+json', 'application/feed+json',
  'application/rss+xml', 'application/atom+xml', 'application/xhtml+xml', 'application/jsonl', 'application/x-tex',
]);

export function isTextual(m: string): boolean {
  if (m.startsWith('text/')) return true;
  if (TEXT_APP.has(m)) return true;
  return m.endsWith('+json') || m.endsWith('+xml');
}

/** Content-Types that say nothing useful: sniff instead. */
const GENERIC = new Set([
  '', 'application/octet-stream', 'binary/octet-stream', 'application/unknown', 'unknown/unknown', '*/*',
  'application/x-unknown', 'application/x-download', 'application/force-download', 'application/binary',
  'application/x-unknown-content-type',
]);

export const isGeneric = (m: string) => GENERIC.has(m);

const EXT: Record<string, string> = {
  md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', csv: 'text/csv', tsv: 'text/tab-separated-values',
  pdf: 'application/pdf', xml: 'application/xml', rss: 'application/rss+xml', atom: 'application/atom+xml', txt: 'text/plain',
  html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', yaml: 'application/x-yaml', yml: 'application/x-yaml',
  ndjson: 'application/x-ndjson', jsonl: 'application/x-ndjson', js: 'application/javascript', mjs: 'application/javascript',
  css: 'text/css', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', zip: 'application/zip', gz: 'application/gzip',
};

function ext(url: string): string {
  try {
    const p = new URL(url).pathname;
    const m = /\.([a-z0-9]{1,9})$/i.exec(p);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);

function magic(b: Uint8Array): string | undefined {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'application/zip';
  if (startsWith(b, [0x1f, 0x8b])) return 'application/gzip';
  if (startsWith(b, [0x00, 0x61, 0x73, 0x6d])) return 'application/wasm';
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) return 'application/octet-stream';
  return undefined;
}

function looksBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 1024);
  // UTF-16 text has NULs; a BOM says it is text
  if (startsWith(b, [0xff, 0xfe]) || startsWith(b, [0xfe, 0xff])) return false;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c <= 0x08 || c === 0x0b || (c >= 0x0e && c <= 0x1a) || (c >= 0x1c && c <= 0x1f)) return true;
  }
  return false;
}

const HTML_START = /^<(?:!doctype\s+html|html|head|body|script|iframe|h1|div|font|table|a|style|title|b|br|p|meta|link|!--)[\s>/]/i;

/** Text prefix for sniffing: skip BOM and whitespace, decode as latin-1 (or utf-16 if BOM'd). */
function prefix(b: Uint8Array, n = 1024): string {
  if (startsWith(b, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(b.subarray(2, 2 + n * 2)).trimStart();
  if (startsWith(b, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(b.subarray(2, 2 + n * 2)).trimStart();
  const start = startsWith(b, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  return Buffer.from(b.buffer, b.byteOffset + start, Math.min(n, b.length - start)).toString('latin1').trimStart();
}

/**
 * Decide the effective MIME type. Declared specific types are trusted (except an HTML document
 * served as XML, and binary served as text/plain); generic or missing types are sniffed from
 * magic bytes, the leading markup, JSON shape and finally the URL extension.
 */
export function sniff(declared: string, b: Uint8Array, url: string): string {
  const d = declared.toLowerCase();
  if (d === 'text/plain') {
    const m = magic(b);
    if (m) return m;
    if (looksBinary(b)) return 'application/octet-stream';
    const e = ext(url);
    if (e === 'md' || e === 'markdown') return 'text/markdown';
    if (e === 'csv') return 'text/csv';
    return d;
  }
  if ((d === 'text/xml' || d === 'application/xml') && /^(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)*(?:<!doctype\s+html|<html[\s>])/i.test(prefix(b))) {
    return 'application/xhtml+xml';
  }
  if (!isGeneric(d)) return d;
  const m = magic(b);
  if (m) return m;
  const p = prefix(b);
  if (HTML_START.test(p)) return 'text/html';
  if (p.startsWith('<?xml')) {
    if (/<html[\s>]/i.test(p) && /xhtml/i.test(p)) return 'application/xhtml+xml';
    if (/<rss[\s>]/i.test(p)) return 'application/rss+xml';
    if (/<feed[\s>]/i.test(p)) return 'application/atom+xml';
    return 'application/xml';
  }
  if (/^<rss[\s>]/i.test(p)) return 'application/rss+xml';
  if (/^<feed[\s>]/i.test(p)) return 'application/atom+xml';
  const e = ext(url);
  if ((p[0] === '{' || p[0] === '[') && !looksBinary(b)) {
    try {
      JSON.parse(new TextDecoder().decode(b));
      return 'application/json';
    } catch {
      /* not JSON */
    }
  }
  if (e && EXT[e]) {
    const fromExt = EXT[e];
    if (!isTextual(fromExt) || !looksBinary(b)) return fromExt;
  }
  if (!b.length) return d || 'text/plain';
  if (looksBinary(b)) return 'application/octet-stream';
  return d === '' ? (/<[a-z][^>]*>/i.test(p) && /<\/(?:p|div|a|span|li|td)>/i.test(p) ? 'text/html' : 'text/plain') : 'application/octet-stream';
}

// ───────────────────────────── charset ─────────────────────────────

function label(l: string | undefined): string | undefined {
  if (!l) return undefined;
  try {
    return new TextDecoder(l.trim().toLowerCase()).encoding;
  } catch {
    return undefined;
  }
}

function bom(b: Uint8Array): { enc: string; skip: number } | undefined {
  if (startsWith(b, [0xef, 0xbb, 0xbf])) return { enc: 'utf-8', skip: 3 };
  if (startsWith(b, [0xff, 0xfe])) return { enc: 'utf-16le', skip: 2 };
  if (startsWith(b, [0xfe, 0xff])) return { enc: 'utf-16be', skip: 2 };
  return undefined;
}

/** WHATWG-ish prescan of the first 1024 bytes for <meta charset> / http-equiv / XML declaration. */
export function sniffMetaCharset(b: Uint8Array): string | undefined {
  const head = Buffer.from(b.buffer, b.byteOffset, Math.min(b.length, 1024)).toString('latin1');
  const noComments = head.replace(/<!--[^]*?-->/g, '');
  const re = /<meta\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noComments))) {
    const attrs = m[1];
    const cs = /\bcharset\s*=\s*["']?\s*([a-z0-9_:.()-]+)/i.exec(attrs);
    if (cs && !/\bcontent\s*=/i.test(attrs.slice(0, cs.index))) {
      const l = label(cs[1]);
      if (l) return fixMeta(l);
    }
    if (/http-equiv\s*=\s*["']?\s*content-type/i.test(attrs)) {
      const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const inner = c ? (c[1] ?? c[2] ?? c[3]) : '';
      const ic = /charset\s*=\s*["']?([a-z0-9_:.()-]+)/i.exec(inner);
      const l = label(ic?.[1]);
      if (l) return fixMeta(l);
    }
    if (cs) {
      const l = label(cs[1]);
      if (l) return fixMeta(l);
    }
  }
  const xml = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([a-z0-9_.:-]+)["']/i.exec(head);
  if (xml) {
    const l = label(xml[1]);
    if (l) return fixMeta(l);
  }
  return undefined;
}

// a meta tag in an ASCII-compatible prefix cannot really mean UTF-16; x-user-defined means windows-1252
const fixMeta = (l: string) => (l.startsWith('utf-16') ? 'utf-8' : l === 'x-user-defined' ? 'windows-1252' : l);

export interface Decoded {
  text: string;
  /** encoding actually used */
  encoding: string;
  /** where the encoding came from */
  source: 'bom' | 'header' | 'meta' | 'default' | 'fallback';
}

/**
 * Decode a body. Order: BOM, Content-Type charset, then (HTML/XML only) a meta/XML-declaration
 * prescan, then UTF-8. Undeclared bytes that are not valid UTF-8 fall back to windows-1252,
 * which is what legacy pages without a declaration almost always are.
 */
export function decodeBody(b: Uint8Array, headerCharset: string | undefined, markup: boolean): Decoded {
  const bm = bom(b);
  if (bm) return { text: new TextDecoder(bm.enc).decode(b.subarray(bm.skip)), encoding: bm.enc, source: 'bom' };
  const h = label(headerCharset);
  if (h) return { text: new TextDecoder(h).decode(b), encoding: h, source: 'header' };
  if (markup) {
    const m = sniffMetaCharset(b);
    if (m) return { text: new TextDecoder(m).decode(b), encoding: m, source: 'meta' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8', source: 'default' };
  } catch {
    // a body cut at the size limit may end inside a multi-byte sequence: that is still UTF-8
    const tail = trimPartialUtf8(b);
    if (tail !== b.length) {
      try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, tail)), encoding: 'utf-8', source: 'default' };
      } catch { /* fall through */ }
    }
    return { text: new TextDecoder('windows-1252').decode(b), encoding: 'windows-1252', source: 'fallback' };
  }
}

function trimPartialUtf8(b: Uint8Array): number {
  let i = b.length;
  for (let k = 0; k < 3 && i > 0; k++) {
    const c = b[i - 1];
    if ((c & 0xc0) === 0x80) { i--; continue; }
    if ((c & 0xc0) === 0xc0) return i - 1;
    break;
  }
  return b.length;
}
