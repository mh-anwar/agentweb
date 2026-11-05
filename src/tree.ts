// The one intermediate representation every tier produces. The HTTP tier builds it
// from parsed HTML; the browser tier builds it from the live DOM with an injected
// script. Everything downstream (compile, render, find) only ever sees this.

export interface LNode {
  /** lower-case tag name, or "#text" */
  t: string;
  /** attributes (already filtered to the ones the compiler reads) */
  a?: Record<string, string>;
  c?: LNode[];
  /** text, for #text nodes */
  x?: string;
  /** hidden from a sighted user (static guess in the HTTP tier, computed in the browser tier) */
  h?: 1;
  /** visually hidden but meant for assistive tech (sr-only): usable as a label, never as content */
  sr?: 1;
  /** live node id (browser tier only) */
  n?: number;
  /** live value / checked state (browser tier only) */
  v?: string;
  k?: 0 | 1;
  /** looks clickable although it is not a native control (browser tier: cursor:pointer etc.) */
  p?: 1;
}

export interface DocMeta {
  title: string;
  base?: string;
  description?: string;
  lang?: string;
  /** <meta http-equiv=refresh> target, if any */
  refresh?: string;
  /** number of executable <script> tags */
  scripts: number;
  /** embedded JSON blobs: JSON-LD, __NEXT_DATA__, application/json script tags */
  json: { id: string; type: string; text: string }[];
  /** <link rel=search|alternate ...> */
  links: { rel: string; href: string; type?: string; title?: string }[];
  /** text found inside <noscript> (used for "needs JavaScript" detection) */
  noscript: string;
}

export interface Doc {
  root: LNode;
  meta: DocMeta;
}

export const ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'name', 'value', 'type', 'placeholder', 'action', 'method', 'enctype',
  'for', 'id', 'role', 'aria-label', 'aria-labelledby', 'aria-checked', 'aria-selected', 'aria-expanded',
  'aria-current', 'aria-disabled', 'aria-pressed', 'checked', 'selected', 'disabled', 'readonly', 'multiple',
  'colspan', 'label', 'open', 'onclick', 'contenteditable', 'class', 'target', 'data-testid', 'required',
  'maxlength', 'form', 'formaction', 'formmethod', 'tabindex', 'datetime', 'srcdoc', 'min', 'max', 'pattern',
]);

export function text(n: LNode): string {
  if (n.t === '#text') return n.x ?? '';
  if (n.h) return '';
  let s = '';
  if (n.c) for (const c of n.c) s += text(c);
  return s;
}

export function* walk(n: LNode): Generator<LNode> {
  yield n;
  if (n.c) for (const c of n.c) yield* walk(c);
}

export function find(n: LNode, pred: (n: LNode) => boolean): LNode | undefined {
  for (const x of walk(n)) if (pred(x)) return x;
  return undefined;
}

/** FNV-1a 32-bit, base36. Used for block hashes, fingerprints and form keys. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
