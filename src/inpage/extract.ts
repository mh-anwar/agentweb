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
// The registry lives on `win.__aw` (in Chromium this is the isolated world's global, invisible to
// the page). An engine may create `win.__aw = { ids: new WeakMap(), nodes: new Map(), next: N }`
// before the first call to make ids start at N (so ids of different documents never collide).
//
// What "hidden" means here: hidden from a sighted user. `aria-hidden` alone does not hide anything
// when there is real layout (sites put it on text that is plainly visible, with a screen-reader
// twin next to it); without layout it is still taken as a hint, like the HTTP tier does.

import type { DocMeta, LNode } from '../tree.ts';

export interface ExtractOptions {
  /** true when the engine has real layout (Chromium). Enables geometry-based hidden detection. */
  layout?: boolean;
  /** stop after this many emitted nodes (default 25000) */
  maxNodes?: number;
  /**
   * Name of a probe event. When set, elements that are not obviously interactive are sent this
   * event (cancelable); a host that knows the element has a click listener cancels it, and the
   * element is marked clickable (`p`). Chromium wires this to a listener registry in the page's
   * main world. Leave unset when nothing answers the probe.
   */
  probe?: string;
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
  const probe = (opts && opts.probe) || '';
  const ATTRS: Record<string, 1> = {};
  for (const k of ('href src alt title name value type placeholder action method enctype for id role aria-label ' +
    'aria-labelledby aria-checked aria-selected aria-expanded aria-current aria-disabled aria-pressed checked ' +
    'selected disabled readonly multiple colspan label open onclick contenteditable class target data-testid ' +
    'required maxlength form formaction formmethod tabindex datetime min max pattern draggable ondrop').split(' ')) ATTRS[k] = 1;
  const SKIP: Record<string, 1> = { script: 1, style: 1, noscript: 1, template: 1, link: 1, meta: 1, head: 1, object: 1, embed: 1, param: 1, source: 1, track: 1 };
  const NATIVE: Record<string, 1> = { a: 1, button: 1, input: 1, select: 1, textarea: 1, option: 1, label: 1, summary: 1 };
  const URL_ATTR: Record<string, 1> = { src: 1, action: 1, formaction: 1 };
  /** roles whose element is something to press: it needs a name even when it only holds an icon */
  const PRESSABLE: Record<string, 1> = { button: 1, link: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, switch: 1, checkbox: 1, radio: 1, option: 1, treeitem: 1 };
  // flags passed down the tree
  const F_POINTER = 1; // an ancestor already carries the pointer cursor
  const F_NATIVE = 2; // inside a native control (a, button, label …): the control is the target
  const F_PRE = 4; // whitespace is significant

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
  let probes = 0;

  const viewOf = (el: any): any => {
    try {
      return (el.ownerDocument && el.ownerDocument.defaultView) || win;
    } catch {
      return win;
    }
  };
  const styleOf = (el: any): any => {
    try {
      return viewOf(el).getComputedStyle(el);
    } catch {
      return null;
    }
  };
  const rectOf = (el: any): any => {
    try {
      return el.getBoundingClientRect();
    } catch {
      return null;
    }
  };
  const clipped = (v: string): boolean => v === 'hidden' || v === 'clip';

  /** 0 = visible, 1 = hidden, 2 = screen-reader-only */
  const hiddenness = (el: any, cs: any, tag: string): 0 | 1 | 2 => {
    if (el.hidden && el.getAttribute('hidden') !== 'until-found') return 1;
    if (!layout && el.getAttribute('aria-hidden') === 'true') return 1;
    if (!cs) return 0;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return 1;
    if (cs.opacity === '0') return 1;
    if (cs.fontSize === '0px') return 1;
    const clip = cs.clip || '';
    const clipPath = cs.clipPath || '';
    if (/rect\(\s*0(px)?[, ]+0(px)?[, ]+0(px)?[, ]+0(px)?\s*\)/.test(clip) || /rect\(\s*1px[, ]+1px[, ]+1px[, ]+1px\s*\)/.test(clip) || /inset\(\s*(50|100)%/.test(clipPath)) return 2;
    if (!layout) return 0;
    // closed <details>, content-visibility:hidden and friends: no box at all although display is not none
    try {
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return 1;
    } catch {}
    const indent = parseFloat(cs.textIndent);
    if (indent <= -999) return 2; // image-replacement text
    const positioned = cs.position !== 'static';
    const ox = cs.overflowX || cs.overflow;
    const oy = cs.overflowY || cs.overflow;
    const frame = tag === 'iframe' || tag === 'frame';
    if (positioned || frame || (el.firstChild && (clipped(ox) || clipped(oy)))) {
      const r = rectOf(el);
      if (r) {
        if (frame && (r.width <= 2 || r.height <= 2)) return 1; // tracking pixels
        if (cs.display !== 'contents' && ((r.width <= 1 && clipped(ox)) || (r.height <= 1 && clipped(oy)))) {
          // a 1px clipped box is the classic sr-only recipe when positioned; otherwise it is a collapsed panel
          return cs.position === 'absolute' || cs.position === 'fixed' ? 2 : 1;
        }
        if (positioned) {
          // parked off the top or left edge of the document, where no amount of scrolling reaches it
          const v = viewOf(el);
          if (r.right + (v.scrollX || 0) < -1 || r.bottom + (v.scrollY || 0) < -1) return 2;
        }
      }
    }
    return 0;
  };

  /** a hidden checkbox, radio or file input with a visible label is still operable through that label */
  const reachableByLabel = (el: any): boolean => {
    try {
      const labs = el.labels;
      for (let i = 0; labs && i < labs.length; i++) {
        const l = labs[i];
        if (typeof l.checkVisibility === 'function' ? l.checkVisibility() : true) {
          const r = rectOf(l);
          if (!layout || (r && r.width > 1 && r.height > 1)) return true;
        }
      }
    } catch {}
    return false;
  };

  /** does some script listen for clicks on exactly this element? (answered by the engine, see ExtractOptions.probe) */
  const listens = (el: any): boolean => {
    if (!probe || probes > 20000) return false;
    probes++;
    try {
      const V = viewOf(el);
      return !el.dispatchEvent(new V.Event(probe, { bubbles: true, cancelable: true, composed: true }));
    } catch {
      return false;
    }
  };

  const hasText = (n: LNode): boolean => {
    if (n.t === '#text') return !!n.x && /\S/.test(n.x);
    if (n.h) return false;
    if (n.a && (n.a.alt || (n.t === 'input' && n.a.value))) return true;
    if (n.c) for (const c of n.c) if (hasText(c)) return true;
    return false;
  };

  const words = (s: string): string => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.:/]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  const ICON_CLASS = /(?:^|\s)(?:fa[srlbdt]?|bi|mdi|icon|icons|glyphicon|ti|ri|bx|bxs|la|las|lucide|octicon|feather|ion|ph|tabler-icon|codicon|pi|uil|svg-icon|ico)-([a-z][a-z0-9-]*)/gi;
  const ICON_NOISE = /^(solid|regular|light|thin|duotone|brands|sharp|fw|lg|sm|xs|xl|\dx|\d+|spin|pulse|fill|line|outline|filled|rounded|icon|button|btn|wrapper|container|left|right|only)$/i;

  /** Best-effort name for something pressable that shows only an icon. '' when nothing sensible is found. */
  const iconName = (el: any, a: Record<string, string> | undefined): string => {
    try {
      const ids = a && a['aria-labelledby'];
      if (ids) {
        const root = el.getRootNode ? el.getRootNode() : doc;
        let s = '';
        for (const id of ids.split(/\s+/)) {
          const t = id && root.getElementById ? root.getElementById(id) : null;
          if (t) s += ' ' + (t.textContent || '');
        }
        s = s.replace(/\s+/g, ' ').trim();
        if (s) return s.slice(0, 120);
      }
      if (a && a.title) return a.title.slice(0, 120);
      const inner = el.querySelector ? el.querySelector('[aria-label],[title],img[alt]') : null;
      if (inner) {
        const s = inner.getAttribute('aria-label') || inner.getAttribute('title') || inner.getAttribute('alt') || '';
        if (s.trim()) return s.trim().slice(0, 120);
      }
      for (const attr of ['data-tooltip', 'data-title', 'data-original-title', 'data-tip', 'data-bs-original-title', 'data-balloon']) {
        const s = el.getAttribute(attr);
        if (s && s.trim()) return s.trim().slice(0, 120);
      }
      const use = el.querySelector ? el.querySelector('use') : null;
      if (use) {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        const frag = href.slice(href.lastIndexOf('#') + 1).replace(/^(icon|ic|svg|i|sprite|symbol)[-_:]/i, '');
        if (frag && frag.length < 40) return words(frag);
      }
      const marked = el.querySelector ? el.querySelector('[data-icon],[data-lucide],[data-feather],[data-testid$="Icon"]') : null;
      if (marked) {
        const s = marked.getAttribute('data-icon') || marked.getAttribute('data-lucide') || marked.getAttribute('data-feather') || (marked.getAttribute('data-testid') || '').replace(/Icon$/, '');
        if (s && s.length < 40) return words(s);
      }
      let cls = typeof el.className === 'string' ? el.className : (a && a.class) || '';
      const kids = el.querySelectorAll ? el.querySelectorAll('i,span,svg') : [];
      for (let i = 0; i < kids.length && i < 4; i++) cls += ' ' + (kids[i].getAttribute('class') || '');
      ICON_CLASS.lastIndex = 0;
      for (let m = ICON_CLASS.exec(cls); m; m = ICON_CLASS.exec(cls)) {
        const parts = m[1].split('-').filter((p: string) => !ICON_NOISE.test(p));
        if (parts.length) return parts.join(' ').toLowerCase();
      }
      const fallback = (a && (a['data-testid'] || a.name || a.id)) || '';
      if (/^[a-z][a-z _-]{2,38}$/i.test(fallback)) return words(fallback);
    } catch {}
    return '';
  };

  const conv = (el: any, depth: number, flags: number): LNode | null => {
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
        if (!ATTRS[at.name]) continue;
        let v: string = at.value;
        if (v.length > 300) {
          if (at.name === 'src' || at.name === 'href') v = /^data:/i.test(v) ? v.slice(0, v.indexOf(',') > 0 && v.indexOf(',') < 80 ? v.indexOf(',') : 40) : v.slice(0, 2000);
          else v = v.slice(0, at.name === 'class' ? 300 : 1000);
        }
        (a ||= {})[at.name] = v;
      }
    }
    if (a) {
      if (tag === 'a' && a.href) {
        try {
          a.href = el.href || a.href; // resolved against the document base
        } catch {}
      }
      for (const k in URL_ATTR) {
        if (a[k] === undefined || /^(data|javascript|blob|about):/i.test(a[k])) continue;
        try {
          a[k] = new win.URL(a[k], el.baseURI).href;
        } catch {}
      }
    }
    // content attributes describe the page as it was served; a live control has moved on
    try {
      if (tag === 'option') {
        if (el.selected) (a ||= {}).selected = '';
        else if (a) delete a.selected;
      } else if (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea') {
        if (a && a.disabled === undefined && el.matches && el.matches(':disabled')) a.disabled = '';
        else if (!a && el.matches && el.matches(':disabled')) a = { disabled: '' };
        if (tag === 'input' && a && 'checked' in a && !el.checked) delete a.checked;
      } else if (tag === 'details' || tag === 'dialog') {
        if (el.open) (a ||= {}).open = '';
        else if (a) delete a.open;
      }
    } catch {}
    if (a) node.a = a;

    const cs = styleOf(el);
    const type = tag === 'input' ? String(el.type || '').toLowerCase() : '';
    let hid = hiddenness(el, cs, tag);
    if (hid && (type === 'checkbox' || type === 'radio' || type === 'file') && reachableByLabel(el)) hid = 0;
    if (type === 'hidden') node.h = 1;
    else if (hid === 1) {
      node.h = 1;
      // keep a hidden subtree only as a size marker; its content is never shown
      const t = (el.textContent || '').length;
      if (t) node.c = [{ t: '#text', x: ' '.repeat(Math.min(t, 4000)) }];
      return node;
    } else if (hid === 2) node.sr = 1;

    const role = a ? a.role : undefined;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      node.n = idOf(el);
      try {
        if (type === 'checkbox' || type === 'radio') node.k = el.checked ? 1 : 0;
        if (type !== 'password' && type !== 'file') node.v = String(el.value ?? '').slice(0, 20000);
        else if (type === 'password') node.v = el.value ? '••••' : '';
      } catch {}
    } else if (NATIVE[tag] || (a && (role || a.onclick || a.tabindex || a.contenteditable || a.draggable === 'true' || a.ondrop !== undefined))) {
      node.n = idOf(el);
    }
    if (a && !NATIVE[tag] && (a.draggable === 'true' || a.ondrop !== undefined)) node.p = 1;
    let down = flags;
    if (NATIVE[tag] && tag !== 'option') down |= F_NATIVE;
    if (tag === 'pre' || (cs && typeof cs.whiteSpace === 'string' && cs.whiteSpace.slice(0, 3) === 'pre')) down |= F_PRE;
    else if (cs && cs.whiteSpace) down &= ~F_PRE;
    const root = tag === 'body' || tag === 'html';
    if (cs && cs.cursor === 'pointer') {
      // the outermost element with the pointer cursor is the thing to click; its children inherit the cursor
      if (!(flags & (F_POINTER | F_NATIVE)) && !NATIVE[tag] && !root) {
        node.p = 1;
        node.n = idOf(el);
      }
      down |= F_POINTER;
    } else down &= ~F_POINTER;
    if (!node.p && !node.n && !root && !(flags & F_NATIVE) && probe && listens(el)) {
      // A listener on a big container is delegation ("clicks anywhere in here"), not a button.
      let size = 0;
      try {
        size = el.getElementsByTagName('*').length;
      } catch {}
      if (size <= 60) {
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
    const pre = !!(down & F_PRE);
    const pushChildren = (list: any) => {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (c.nodeType === 3) {
          let x: string = c.nodeValue;
          if (!x) continue;
          if (!pre) {
            if (!/\S/.test(x)) {
              // whitespace between elements separates words, but one space says it all
              const last = kids[kids.length - 1];
              if (last && last.t === '#text' && last.x === ' ') continue;
              x = ' ';
            } else if (x.length > 40) x = x.replace(/\s+/g, ' ');
          }
          kids.push({ t: '#text', x });
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
            const k = conv(c, depth + 1, down);
            if (k) kids.push(k);
          }
        }
      }
    };

    if (tag === 'iframe' || tag === 'frame') {
      // same-origin frames are part of the page; a cross-origin one stays an opaque node with its src
      let inner: any = null;
      try {
        inner = el.contentDocument;
      } catch {}
      if (inner && inner.body) {
        const k = conv(inner.body, depth + 1, 0);
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

    // An icon-only button is invisible in text. Give it the best name the markup offers.
    if (node.n && !(a && a['aria-label']) && (tag === 'button' || tag === 'a' || tag === 'summary' || node.p || (role && PRESSABLE[role])) && !hasText(node)) {
      const name = iconName(el, a);
      if (name) (node.a ||= {})['aria-label'] = name;
    }
    return node;
  };

  const meta: DocMeta = { title: '', scripts: 0, json: [], links: [], noscript: '' };
  try {
    meta.title = String(doc.title || '').replace(/\s+/g, ' ').trim();
    if (!meta.title) {
      const og = doc.querySelector('meta[property="og:title"]');
      if (og) meta.title = String(og.getAttribute('content') || '').trim();
    }
    meta.base = String(doc.baseURI || '');
    meta.lang = doc.documentElement ? doc.documentElement.getAttribute('lang') || undefined : undefined;
    const d = doc.querySelector('meta[name="description"],meta[property="og:description"]');
    if (d) meta.description = d.getAttribute('content') || undefined;
    const ls = doc.querySelectorAll('link[rel="search"],link[rel="alternate"],link[rel="canonical"]');
    for (let i = 0; i < ls.length && i < 20; i++) {
      const l = ls[i];
      meta.links.push({ rel: (l.getAttribute('rel') || '').toLowerCase(), href: l.href || l.getAttribute('href') || '', type: l.getAttribute('type') || undefined, title: l.getAttribute('title') || undefined });
    }
  } catch {}
  try {
    // same rules as the HTTP tier: executable scripts are counted, JSON blobs are carried along
    const ss = doc.querySelectorAll('script');
    let total = 0;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      const type = String(s.getAttribute('type') || '').toLowerCase();
      const id = String(s.getAttribute('id') || '');
      if (type.indexOf('json') !== -1 || id === '__NEXT_DATA__') {
        const t = String(s.textContent || '');
        if (t.length > 1 && t.length < 4000000 && total + t.length < 6000000 && meta.json.length < 40) {
          total += t.length;
          meta.json.push({ id, type, text: t });
        }
      } else if (!type || type.indexOf('javascript') !== -1 || type === 'module') meta.scripts++;
    }
  } catch {}

  const root: LNode = { t: 'html', c: [] };
  if (doc.body) {
    const b = conv(doc.body, 0, 0);
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
