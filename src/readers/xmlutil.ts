// Small helpers over htmlparser2's DOM in XML mode.

import { parseDocument } from 'htmlparser2';

export interface XEl {
  type: string;
  name: string;
  attribs: Record<string, string>;
  children: XNode[];
}
export type XNode = XEl | { type: string; data?: string; children?: XNode[] };

export function parseXml(text: string): XEl[] {
  const dom = parseDocument(text.replace(/^﻿/, ''), { xmlMode: true, decodeEntities: true });
  return (dom.children as unknown as XNode[]).filter(isEl);
}

export const isEl = (n: XNode): n is XEl => n.type === 'tag' || n.type === 'script' || n.type === 'style';
/** Local name without namespace prefix, lower-cased. */
export const local = (n: XEl) => n.name.slice(n.name.indexOf(':') + 1).toLowerCase();
export const kids = (n: XEl) => n.children.filter(isEl);

/** First child element whose qualified name (lower-case) is one of `names`; a bare name also matches any prefix. */
export function child(n: XEl, ...names: string[]): XEl | undefined {
  for (const nm of names) {
    for (const c of kids(n)) {
      const q = c.name.toLowerCase();
      if (q === nm || (!nm.includes(':') && local(c) === nm && !q.includes(':'))) return c;
    }
  }
  return undefined;
}
export const children = (n: XEl, name: string) => kids(n).filter((c) => c.name.toLowerCase() === name || (local(c) === name && !c.name.includes(':')));

/** All text inside, CDATA included. */
export function xtext(n: XNode | undefined): string {
  if (!n) return '';
  if (n.type === 'text') return (n as { data?: string }).data ?? '';
  let s = '';
  for (const c of n.children ?? []) s += xtext(c);
  return s;
}

/** Direct text of an element (not its descendants'). */
export function ownText(n: XEl): string {
  let s = '';
  for (const c of n.children) {
    if (c.type === 'text') s += (c as { data?: string }).data ?? '';
    else if (c.type === 'cdata') s += xtext(c);
  }
  return s;
}

export function rootOf(text: string): XEl | undefined {
  return parseXml(text)[0];
}
