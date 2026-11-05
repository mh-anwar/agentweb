// Runs INSIDE a page (Chromium isolated world, or the ghost engine's DOM) and serialises the
// live DOM into the same LNode tree the HTTP tier produces from HTML text.
//
// RULES FOR THIS FILE
//  - `extractPage` must be fully self-contained: no imports used at runtime, no references to
//    anything outside its own body. It is injected with `(${extractPage.toString()})(window, opts)`.
//  - Only erasable TypeScript syntax (it is type-stripped, then stringified).
//  - It must not throw on hostile pages: every DOM access that can throw is guarded.
//
// Node identity: every element that is emitted gets a numeric id that stays the same for as long
// as that element object lives (WeakMap), so refs survive re-extraction without re-matching.
// The registry lives on `win.__aw` (in Chromium this is the isolated world's global, invisible to the page).

import type { DocMeta, LNode } from '../tree.ts';

export interface ExtractOptions {
  /** true when the engine has real layout (Chromium). Enables geometry-based hidden detection. */
  layout?: boolean;
  /** stop after this many emitted nodes (default 25000) */
  maxNodes?: number;
}

export interface Extracted {
  root: LNode;
  meta: DocMeta;
  nodes: number;
  truncated: boolean;
  url: string;
}

export function extractPage(win: any, opts?: ExtractOptions): Extracted {
  const doc = win.document;
  const layout = !!(opts && opts.layout);
  const maxNodes = (opts && opts.maxNodes) || 25000;
  const ATTRS: Record<string, 1> = {};
  for (const k of ('href src alt title name value type placeholder action method enctype for id role aria-label ' +
    'aria-labelledby aria-checked aria-selected aria-expanded aria-current aria-disabled aria-pressed checked ' +
    'selected disabled readonly multiple colspan label open onclick contenteditable class target data-testid ' +
    'required maxlength form formaction formmethod tabindex datetime min max pattern').split(' ')) ATTRS[k] = 1;
  const SKIP: Record<string, 1> = { script: 1, style: 1, noscript: 1, template: 1, link: 1, meta: 1, head: 1, object: 1, embed: 1, param: 1, source: 1, track: 1 };
  const NATIVE: Record<string, 1> = { a: 1, button: 1, input: 1, select: 1, textarea: 1, option: 1, label: 1, summary: 1 };

  const reg = (win.__aw ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  // drop registry entries whose element has left the document
  for (const [id, ref] of reg.nodes) {
    const el = ref.deref ? ref.deref() : ref;
    if (!el || !el.isConnected) reg.nodes.delete(id);
  }
  const idOf = (el: any): number => {
    let id = reg.ids.get(el);
    if (!id) {
      id = reg.next++;
      reg.ids.set(el, id);
    }
    if (!reg.nodes.has(id)) reg.nodes.set(id, typeof win.WeakRef === 'function' ? new win.WeakRef(el) : el);
    return id;
  };

  let count = 0;
  let truncated = false;

  const styleOf = (el: any): any => {
    try {
      return win.getComputedStyle(el);
    } catch {
      return null;
    }
  };

  /** 0 = visible, 1 = hidden, 2 = screen-reader-only */
  const hiddenness = (el: any, cs: any): 0 | 1 | 2 => {
    if (el.hidden && el.getAttribute('hidden') !== 'until-found') return 1;
    if (el.getAttribute('aria-hidden') === 'true') return 1;
    if (!cs) return 0;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return 1;
    if (cs.opacity === '0') return 1;
    if (cs.fontSize === '0px') return 1;
    const clip = cs.clip || '';
    const clipPath = cs.clipPath || '';
    if (/rect\(\s*0(px)?[, ]+0(px)?[, ]+0(px)?[, ]+0(px)?\s*\)/.test(clip) || /rect\(\s*1px[, ]+1px[, ]+1px[, ]+1px\s*\)/.test(clip) || /inset\(\s*(50|100)%/.test(clipPath)) return 2;
    if (layout && cs.position !== 'static') {
      let r: any;
      try {
        r = el.getBoundingClientRect();
      } catch {
        r = null;
      }
      if (r) {
        if ((r.width <= 1 || r.height <= 1) && (cs.overflow === 'hidden' || cs.overflow === 'clip')) return 2;
        if (r.right < -500 || r.bottom < -500) return 2;
      }
    }
    return 0;
  };

  const conv = (el: any, depth: number, parentPointer: boolean): LNode | null => {
    const tag = (el.localName || '').toLowerCase();
    if (!tag || SKIP[tag]) return null;
    if (count >= maxNodes) {
      truncated = true;
      return null;
    }
    count++;
    const node: LNode = { t: tag };
    let a: Record<string, string> | undefined;
    const attrs = el.attributes;
    if (attrs) {
      for (let i = 0; i < attrs.length; i++) {
        const at = attrs[i];
        if (ATTRS[at.name]) (a ||= {})[at.name] = at.value;
      }
    }
    if (tag === 'a' && a && a.href) {
      try {
        a.href = el.href || a.href; // resolved against the document base
      } catch {}
    }
    if (a) node.a = a;

    const cs = styleOf(el);
    const hid = hiddenness(el, cs);
    if (tag === 'input' && (el.type || '').toLowerCase() === 'hidden') node.h = 1;
    else if (hid === 1) {
      node.h = 1;
      // keep a hidden subtree only as a size marker; its content is never shown
      const t = (el.textContent || '').length;
      if (t) node.c = [{ t: '#text', x: ' '.repeat(Math.min(t, 4000)) }];
      return node;
    } else if (hid === 2) node.sr = 1;

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      node.n = idOf(el);
      try {
        const type = (el.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') node.k = el.checked ? 1 : 0;
        if (type !== 'password' && type !== 'file') node.v = String(el.value ?? '');
        else if (type === 'password') node.v = el.value ? '••••' : '';
      } catch {}
    } else if (NATIVE[tag] || (a && (a.role || a.onclick || a.tabindex || a.contenteditable))) {
      node.n = idOf(el);
    }
    let pointer = false;
    if (cs && cs.cursor === 'pointer') {
      pointer = true;
      if (!parentPointer && !NATIVE[tag]) {
        node.p = 1;
        node.n = idOf(el);
      }
    }
    if (tag === 'svg') {
      const t = el.querySelector ? el.querySelector('title') : null;
      const name = (t && t.textContent) || el.getAttribute('aria-label') || '';
      if (name) node.c = [{ t: '#text', x: name }];
      return node;
    }
    if (tag === 'canvas' || tag === 'video' || tag === 'audio') return node;

    const kids: LNode[] = [];
    const pushChildren = (list: any) => {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.nodeType === 3) {
          const x = c.nodeValue;
          if (x) kids.push({ t: '#text', x });
        } else if (c.nodeType === 1) {
          if ((c.localName || '') === 'slot') {
            let assigned: any[] = [];
            try {
              assigned = c.assignedNodes({ flatten: true });
            } catch {}
            pushChildren(assigned.length ? assigned : c.childNodes);
            continue;
          }
          if (depth < 500) {
            const k = conv(c, depth + 1, pointer);
            if (k) kids.push(k);
          }
        }
      }
    };

    if (tag === 'iframe' || tag === 'frame') {
      let inner: any = null;
      try {
        inner = el.contentDocument;
      } catch {}
      if (inner && inner.body) {
        const k = conv(inner.body, depth + 1, false);
        if (k) kids.push(k);
      }
    } else if (el.shadowRoot) {
      pushChildren(el.shadowRoot.childNodes);
    } else if (tag === 'textarea') {
      // value is carried in node.v
    } else {
      pushChildren(el.childNodes);
    }
    if (kids.length) node.c = kids;
    return node;
  };

  const meta: DocMeta = { title: '', scripts: 0, json: [], links: [], noscript: '' };
  try {
    meta.title = String(doc.title || '');
    meta.base = String(doc.baseURI || '');
    meta.lang = doc.documentElement ? doc.documentElement.getAttribute('lang') || undefined : undefined;
    const d = doc.querySelector('meta[name="description"],meta[property="og:description"]');
    if (d) meta.description = d.getAttribute('content') || undefined;
    meta.scripts = doc.querySelectorAll('script').length;
    const ls = doc.querySelectorAll('link[rel="search"],link[rel="alternate"],link[rel="canonical"]');
    for (let i = 0; i < ls.length && i < 20; i++) {
      const l = ls[i];
      meta.links.push({ rel: l.getAttribute('rel') || '', href: l.href || l.getAttribute('href') || '', type: l.getAttribute('type') || undefined, title: l.getAttribute('title') || undefined });
    }
  } catch {}

  const root: LNode = { t: 'html', c: [] };
  if (doc.body) {
    const b = conv(doc.body, 0, false);
    if (b) root.c!.push(b);
  }
  let url = '';
  try {
    url = String(win.location.href);
  } catch {}
  return { root, meta, nodes: count, truncated, url };
}

/** Resolve a node id from the last extraction to its element (or null if it is gone). Self-contained. */
export function nodeById(win: any, id: number): any {
  const reg = win.__aw;
  if (!reg) return null;
  const ref = reg.nodes.get(id);
  const el = ref && ref.deref ? ref.deref() : ref;
  return el && el.isConnected ? el : null;
}
