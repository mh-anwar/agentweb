// Code that runs INSIDE the page, in the engine's isolated world: layout overflow, the built-in
// accessibility rules, element labels for screenshots, and the pixel comparison of two images.
// Nothing here may reference anything outside `pageChecks`: it is injected with `toString()`.
//
// Hard rule: no persistent change to the page. The only nodes ever added are the screenshot labels,
// and they are removed again by `unlabel` in the same call that took the picture. Nothing is focused,
// scrolled or clicked. Every method returns plain JSON.

export interface OverflowOptions {
  /** also report text cut off by its own box */
  clipped?: boolean;
  /** offenders to return per report (the rest are only counted) */
  max?: number;
}

export interface Hit {
  /** `<tag#id>` or `<tag.class>` */
  tag: string;
  /** a few words of the element's own text, when it has some */
  text?: string;
  /** live node id (the page's own registry), when the element is one the page view numbered */
  n?: number;
  /** what is wrong with this one, ready to print */
  d?: string;
  /** overflow: how far past the viewport, and the box */
  by?: number;
  w?: number;
  /** clipped text: the text's width and the box's width */
  need?: number;
  have?: number;
}

export interface OverflowReport {
  /** the viewport width the page was measured at (clientWidth: without a scrollbar) */
  vw: number;
  /** the widest content the document has (scrollWidth) */
  scrollW: number;
  /** the document scrolls sideways */
  scrolls: boolean;
  /** overflow-x is hidden or clip on html or body: the content is cut off, not scrollable */
  locked: string;
  total: number;
  hits: Hit[];
  clipped?: { total: number; hits: Hit[] };
}

export interface RuleResult {
  count: number;
  items: Hit[];
}

export interface AuditReport {
  rules: Record<string, RuleResult>;
  /** contrast: elements not checked because their background is an image or gradient */
  skipped: number;
  /** contrast: elements that were checked */
  checkedText: number;
}

/** The ids of every rule, in report order. Kept next to the code that implements them. */
export const RULE_IDS = ['alt', 'labels', 'placeholder', 'buttons', 'links', 'lang', 'title', 'ids', 'headings', 'main', 'tabindex', 'contrast', 'target', 'aria-hidden'] as const;

export function pageChecks(win: any): any {
  const doc = win.document;
  const de = doc.documentElement;
  const reg = win.__aw;
  const MAX_ELEMENTS = 25000;

  const cs = (el: any): any => win.getComputedStyle(el);
  const low = (s: any): string => String(s == null ? '' : s).toLowerCase();
  const tagOf = (el: any): string => low(el.localName);
  const squash = (s: any): string => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const nodeId = (el: any): number | undefined => {
    try {
      const id = reg && reg.ids.get(el);
      return typeof id === 'number' ? id : undefined;
    } catch {
      return undefined;
    }
  };

  /** `<tag#id>`, else `<tag.firstclass>`, else `<tag>` */
  const tagLabel = (el: any): string => {
    let s = tagOf(el);
    const id = el.id && String(el.id).trim();
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : '';
    if (id && !/\s/.test(id)) s += '#' + clip(id, 30);
    else if (cls) s += '.' + clip(cls, 30);
    return '<' + s + '>';
  };

  /** a few words that identify the element: its text, an image's file name, a field's placeholder */
  const words = (el: any): string => {
    const t = tagOf(el);
    let s = '';
    if (t === 'img') s = el.getAttribute('alt') || String(el.getAttribute('src') || '').split('?')[0].split('/').pop() || '';
    else if (t === 'input' || t === 'textarea' || t === 'select') s = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || '';
    else s = el.innerText || el.textContent || '';
    s = squash(s);
    const w = s.split(' ').slice(0, 3).join(' ');
    return clip(w, 26);
  };

  const hit = (el: any, extra: Partial<Hit> = {}): Hit => {
    const h: Hit = { tag: tagLabel(el) };
    const w = el === de ? '' : words(el);
    if (w) h.text = w;
    const n = nodeId(el);
    if (n !== undefined) h.n = n;
    return Object.assign(h, extra);
  };

  const rendered = (el: any): boolean => {
    try {
      return el.getClientRects().length > 0 && cs(el).visibility !== 'hidden';
    } catch {
      return false;
    }
  };
  /** hidden from assistive technology: aria-hidden on it or an ancestor, or not rendered */
  const hiddenFromAT = (el: any): boolean => {
    try {
      return !!(el.closest && el.closest('[aria-hidden="true"]')) || !rendered(el);
    } catch {
      return true;
    }
  };

  const all = (sel: string): any[] => {
    try {
      return Array.prototype.slice.call(doc.querySelectorAll(sel), 0, MAX_ELEMENTS);
    } catch {
      return [];
    }
  };

  // ───────────────────────────── overflow ─────────────────────────────

  const overflow = (o: OverflowOptions): OverflowReport => {
    const max = Math.max(1, Math.min(o.max ?? 5, 20));
    const body = doc.body;
    const vw = de.clientWidth;
    const scrollW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0);
    const rootX = low(cs(de).overflowX);
    const bodyX = body ? low(cs(body).overflowX) : '';
    const hides = (v: string) => v === 'hidden' || v === 'clip';
    const locked = hides(rootX) ? 'html' : rootX === 'visible' && hides(bodyX) ? 'body' : '';
    const scrolls = scrollW > vw + 0.5 && !locked;
    const sx = win.scrollX || 0;
    const els: any[] = all('body *');

    // is this element inside something that scrolls or clips on its own (a table wrapper, a carousel), or fixed to the screen?
    const shielded = (el: any): boolean => {
      for (let p = el.parentElement, i = 0; p && p !== body && p !== de && i < 200; p = p.parentElement, i++) {
        const st = cs(p);
        if (st.overflowX !== 'visible' && low(st.display) !== 'contents') return true;
        if (st.position === 'fixed') return true;
      }
      return cs(el).position === 'fixed';
    };

    const offenders: { el: any; by: number; w: number; left: number }[] = [];
    for (const el of els) {
      if (el.ownerSVGElement) continue; // the <svg> itself is measured, not its parts
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const right = r.right + sx;
      const by = Math.max(right - vw, r.width - vw);
      if (by <= 0.5) continue;
      if (shielded(el)) continue;
      offenders.push({ el, by, w: r.width, left: r.left + sx });
    }
    // keep the outermost offenders: the descendants of an offender are mostly its own contents
    const set = new Set(offenders.map((x) => x.el));
    const top = offenders.filter((x) => {
      for (let p = x.el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
      return true;
    });
    top.sort((a, b) => b.by - a.by);
    const rep: OverflowReport = {
      vw,
      scrollW,
      scrolls,
      locked,
      total: top.length,
      hits: top.slice(0, max).map((x) => hit(x.el, { by: Math.round(x.by), w: Math.round(x.w) })),
    };

    if (o.clipped) {
      const found: { el: any; need: number; have: number }[] = [];
      for (const el of els) {
        if (el.ownerSVGElement) continue;
        const st = cs(el);
        const ell = st.textOverflow === 'ellipsis';
        const cut = st.overflowX === 'hidden' || st.overflowX === 'clip';
        if (!ell && !cut) continue;
        if (!el.clientWidth || el.scrollWidth <= el.clientWidth + 1) continue;
        if (!squash(el.textContent)) continue;
        if (!rendered(el)) continue;
        if (!ell && !/[^\s]/.test(el.innerText || '')) continue;
        // a box that only holds other boxes (a carousel, a slider track) is laid out to scroll or slide
        if (!ell && el.children.length > 0 && !Array.prototype.some.call(el.childNodes, (c: any) => c.nodeType === 3 && squash(c.nodeValue))) continue;
        found.push({ el, need: el.scrollWidth, have: el.clientWidth });
      }
      rep.clipped = { total: found.length, hits: found.slice(0, max).map((x) => hit(x.el, { need: x.need, have: x.have })) };
    }
    return rep;
  };

  // ───────────────────────────── accessibility ─────────────────────────────

  /** the text a node contributes to a name: its text, images by alt, svg by title, skipping what is hidden */
  const contentName = (el: any, depth: number): string => {
    if (depth > 8) return '';
    let s = '';
    for (const c of Array.prototype.slice.call(el.childNodes, 0, 400)) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1) {
        if (c.getAttribute('aria-hidden') === 'true' || c.hidden) continue;
        const t = tagOf(c);
        if (t === 'img') s += ' ' + (c.getAttribute('alt') || c.getAttribute('aria-label') || '') + ' ';
        else if (t === 'svg') s += ' ' + (c.getAttribute('aria-label') || (c.querySelector && c.querySelector('title') ? c.querySelector('title').textContent : '')) + ' ';
        else if (t === 'script' || t === 'style') continue;
        else s += ' ' + (c.getAttribute('aria-label') || contentName(c, depth + 1)) + ' ';
      }
    }
    return squash(s);
  };

  const idsText = (ids: string): string => {
    const parts: string[] = [];
    for (const id of squash(ids).split(' ')) {
      const t = id ? doc.getElementById(id) : null;
      if (t) parts.push(squash(t.textContent) || squash(t.getAttribute('aria-label')));
    }
    return squash(parts.join(' '));
  };

  /** the control's accessible name (aria-labelledby, aria-label, label, content, title) and whether only a placeholder names it */
  const nameOf = (el: any, fromContent: boolean): { name: string; weak: boolean } => {
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = idsText(by);
      if (t) return { name: t, weak: false };
    }
    const al = squash(el.getAttribute('aria-label'));
    if (al) return { name: al, weak: false };
    const t = tagOf(el);
    if (t === 'input') {
      const ty = low(el.getAttribute('type') || 'text');
      if (ty === 'image') {
        const a = squash(el.getAttribute('alt'));
        if (a) return { name: a, weak: false };
      }
      if (ty === 'submit' || ty === 'reset') return { name: squash(el.value) || ty, weak: false };
      if (ty === 'button') {
        const v = squash(el.value);
        if (v) return { name: v, weak: false };
      }
    }
    try {
      if (el.labels && el.labels.length) {
        const l = squash(Array.prototype.map.call(el.labels, (x: any) => contentName(x, 0)).join(' '));
        if (l) return { name: l, weak: false };
      }
    } catch {}
    if (fromContent) {
      const c = contentName(el, 0);
      if (c) return { name: c, weak: false };
    }
    const title = squash(el.getAttribute('title'));
    if (title) return { name: title, weak: false };
    const ph = squash(el.getAttribute('placeholder'));
    if (ph) return { name: ph, weak: true };
    return { name: '', weak: false };
  };

  // colour: resolved computed colours composited over their backgrounds
  let cv: any = null;
  const cache: Record<string, number[]> = {};
  const parseColor = (str: string): number[] => {
    const hit = cache[str];
    if (hit) return hit;
    let out: number[] | null = null;
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(str);
    if (m) out = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4]];
    else {
      // lab(), oklch(), color(display-p3 …): the canvas converts any colour the browser understands to sRGB
      try {
        cv = cv || doc.createElement('canvas');
        cv.width = cv.height = 1;
        const c = cv.getContext('2d', { willReadFrequently: true });
        c.clearRect(0, 0, 1, 1);
        c.fillStyle = '#000';
        c.fillStyle = str;
        c.fillRect(0, 0, 1, 1);
        const d = c.getImageData(0, 0, 1, 1).data;
        out = [d[0], d[1], d[2], d[3] / 255];
      } catch {}
    }
    return (cache[str] = out || [0, 0, 0, 1]);
  };
  const over = (top: number[], bot: number[]): number[] => {
    const a = top[3] + bot[3] * (1 - top[3]);
    if (a <= 0) return [255, 255, 255, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bot[i] * bot[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = (c: number[]): number => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: number[], b: number[]): number => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const hex = (c: number[]): string => '#' + [0, 1, 2].map((i) => Math.round(c[i]).toString(16).padStart(2, '0')).join('').replace(/^(.)\1(.)\2(.)\3$/, '$1$2$3');

  /** the opaque colour behind an element, or null when an image or gradient is in the way */
  const backdrop = (el: any): number[] | null => {
    let acc: number[] = [0, 0, 0, 0];
    for (let p = el, i = 0; p && p.nodeType === 1 && i < 60; p = p.parentElement, i++) {
      const st = cs(p);
      if (st.backgroundImage && st.backgroundImage !== 'none') return null;
      const bg = parseColor(st.backgroundColor);
      if (bg[3] > 0) acc = over(acc, bg);
      if (acc[3] >= 0.99) return acc;
    }
    return over(acc, [255, 255, 255, 1]);
  };

  const FOCUSABLE = 'a[href],area[href],button,input:not([type=hidden]),select,textarea,summary,iframe,[contenteditable=""],[contenteditable="true"],[tabindex]';
  const focusable = (el: any): boolean => {
    if (el.disabled) return false;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && Number(ti) < 0) return false;
    if (tagOf(el) === 'a' && !el.hasAttribute('href') && ti === null) return false;
    return rendered(el);
  };

  const ACTIONABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option]';

  const audit = (o: { rules: string[] }): AuditReport => {
    const want = new Set(o.rules);
    const rules: Record<string, RuleResult> = {};
    const add = (rule: string, el: any, d: string | undefined, extra: Partial<Hit> = {}) => {
      const r = rules[rule] || (rules[rule] = { count: 0, items: [] });
      r.count++;
      if (r.items.length < 3) r.items.push(hit(el, Object.assign(d ? { d } : {}, extra)));
    };
    const rep: AuditReport = { rules, skipped: 0, checkedText: 0 };

    if (want.has('alt')) {
      for (const el of all('img,input[type=image],[role=img],area[href]')) {
        if (hiddenFromAT(el)) continue;
        const role = low(el.getAttribute('role'));
        if (role === 'presentation' || role === 'none') continue;
        const t = tagOf(el);
        const named = squash(el.getAttribute('aria-label')) || (el.getAttribute('aria-labelledby') && idsText(el.getAttribute('aria-labelledby'))) || squash(el.getAttribute('title'));
        if (t === 'img') {
          if (el.getAttribute('alt') === null && !named) add('alt', el, 'no alt attribute');
        } else if (t === 'svg' || role === 'img') {
          if (!named && !(el.querySelector && el.querySelector('title'))) add('alt', el, 'role=img without a name');
        } else if (!named && !squash(el.getAttribute('alt'))) add('alt', el, 'no alt text');
      }
    }

    if (want.has('labels') || want.has('placeholder')) {
      for (const el of all('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]),select,textarea,[role=textbox],[role=combobox],[role=listbox],[role=searchbox],[role=slider],[role=spinbutton]')) {
        if (hiddenFromAT(el)) continue;
        const nm = nameOf(el, false);
        if (nm.name && !nm.weak) continue;
        if (nm.weak) {
          if (want.has('placeholder')) add('placeholder', el, 'only a placeholder names it');
        } else if (want.has('labels')) add('labels', el, 'no label');
      }
    }

    if (want.has('buttons')) {
      for (const el of all('button,input[type=button],input[type=submit],input[type=reset],input[type=image],[role=button],summary')) {
        if (hiddenFromAT(el)) continue;
        if (!nameOf(el, true).name) add('buttons', el, 'button has no name');
      }
    }

    if (want.has('links')) {
      for (const el of all('a[href],area[href],[role=link]')) {
        if (hiddenFromAT(el)) continue;
        if (!nameOf(el, true).name) add('links', el, 'link has no name', { text: clip(String(el.getAttribute('href') || ''), 30) });
      }
    }

    if (want.has('lang') && !squash(de.getAttribute('lang'))) add('lang', de, 'has no lang attribute');
    if (want.has('title') && !squash(doc.title)) add('title', de, doc.querySelector('title') ? '<title> is empty' : 'no <title>');

    if (want.has('ids')) {
      const seen: Record<string, number> = {};
      for (const el of all('[id]')) {
        const id = el.id;
        if (id) seen[id] = (seen[id] || 0) + 1;
      }
      const dup = Object.keys(seen).filter((k) => seen[k] > 1);
      if (dup.length) {
        const used: Record<string, 1> = {};
        for (const el of all('label[for],[aria-labelledby],[aria-describedby],[aria-controls],[aria-owns],[aria-activedescendant],[aria-errormessage],[aria-details],[aria-flowto],input[list]')) {
          const refs = [el.getAttribute('for'), el.getAttribute('aria-labelledby'), el.getAttribute('aria-describedby'), el.getAttribute('aria-controls'), el.getAttribute('aria-owns'), el.getAttribute('aria-activedescendant'), el.getAttribute('aria-errormessage'), el.getAttribute('aria-details'), el.getAttribute('aria-flowto'), el.getAttribute('list')];
          for (const r of refs) if (r) for (const id of squash(r).split(' ')) used[id] = 1;
        }
        for (const id of dup) if (used[id]) add('ids', doc.getElementById(id) || de, `id="${clip(id, 30)}" used ${seen[id]}×, referenced by a label or aria attribute`);
      }
    }

    if (want.has('headings')) {
      let prev = 0;
      for (const el of all('h1,h2,h3,h4,h5,h6,[role=heading]')) {
        if (hiddenFromAT(el)) continue;
        const lv = /^h[1-6]$/.test(tagOf(el)) ? Number(tagOf(el)[1]) : Number(el.getAttribute('aria-level')) || 2;
        if (prev && lv > prev + 1) add('headings', el, `h${prev} → h${lv}`);
        prev = lv;
      }
    }

    if (want.has('main')) {
      const mains = all('main,[role=main]').filter((m: any) => rendered(m));
      if (!mains.length) add('main', de, 'no <main>');
      else if (mains.length > 1) for (const m of mains.slice(1)) add('main', m, `${mains.length} <main> on the page`);
    }

    if (want.has('tabindex')) for (const el of all('[tabindex]')) if (Number(el.getAttribute('tabindex')) > 0) add('tabindex', el, `tabindex=${el.getAttribute('tabindex')}`);

    if (want.has('contrast')) {
      const SKIP: Record<string, 1> = { script: 1, style: 1, noscript: 1, template: 1, title: 1, head: 1, option: 1, textarea: 1, svg: 1 };
      let n = 0;
      const walker = doc.createTreeWalker(doc.body || de, 4 /* NodeFilter.SHOW_TEXT */);
      const seen = new Set<any>();
      for (let node = walker.nextNode(); node && n < 4000; node = walker.nextNode()) {
        if (!/\S/.test(node.nodeValue)) continue;
        const el = node.parentElement;
        if (!el || seen.has(el) || SKIP[tagOf(el)] || el.closest('svg,[disabled],[aria-disabled="true"]')) continue;
        seen.add(el);
        if (!rendered(el)) continue;
        const st = cs(el);
        const size = parseFloat(st.fontSize) || 16;
        if (size < 1 || st.display === 'none' || Number(st.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 1 && r.height <= 1) continue; // visually hidden text for screen readers
        n++;
        const bg = backdrop(el);
        if (!bg) {
          rep.skipped++;
          continue;
        }
        rep.checkedText++;
        let alpha = 1;
        for (let p = el, i = 0; p && p.nodeType === 1 && i < 60; p = p.parentElement, i++) {
          const op = Number(cs(p).opacity);
          if (op < 1) alpha *= op;
        }
        const fg0 = parseColor(st.color);
        const fg = over([fg0[0], fg0[1], fg0[2], fg0[3] * alpha], bg);
        const ink = fg.slice(0, 3).concat(1);
        const big = size >= 24 || (size >= 18.66 && Number(st.fontWeight) >= 700);
        const need = big ? 3 : 4.5;
        const got = ratio(ink, bg);
        if (got + 0.005 < need) add('contrast', el, `${got.toFixed(1)}:1 (needs ${need}) ${hex(ink)} on ${hex(bg)}`);
      }
    }

    if (want.has('target')) {
      const els = all(ACTIONABLE).filter((el: any) => rendered(el));
      const boxes: { el: any; r: any; small: boolean }[] = [];
      for (const el of els) {
        let r = el.getBoundingClientRect();
        if (r.width <= 1 && r.height <= 1) continue; // skip links and visually hidden controls
        if (r.right < 0 || r.bottom < 0) continue;
        const ty = low(el.getAttribute('type'));
        void ty;
        if (r.width < 23.5 || r.height < 23.5) {
          // a small control is fine when a label of at least 24 px is the thing people tap: its own label (a checkbox,
          // a radio, a switch) or the label it sits in
          const own: any[] = el.labels && el.labels.length ? Array.prototype.slice.call(el.labels) : [];
          const around = el.closest ? el.closest('label') : null;
          if (around && own.indexOf(around) < 0) own.push(around);
          const lr = own.map((l: any) => l.getBoundingClientRect()).find((b: any) => b.width >= 24 && b.height >= 24);
          if (lr) r = lr;
        }
        boxes.push({ el, r, small: r.width < 23.5 || r.height < 23.5 });
      }
      const small = boxes.filter((b) => b.small);
      for (const b of small) {
        // WCAG 2.5.8 exceptions: a link inside a sentence, and a target with enough space around it
        const el = b.el;
        if (tagOf(el) === 'a' && low(cs(el).display) === 'inline' && el.parentElement && squash(el.parentElement.textContent).length > squash(el.textContent).length + 12) continue;
        const cx = b.r.left + b.r.width / 2;
        const cy = b.r.top + b.r.height / 2;
        let crowded = false;
        for (const o of boxes) {
          if (o === b || el.contains(o.el) || o.el.contains(el)) continue;
          const dx = Math.max(o.r.left - cx, 0, cx - o.r.right);
          const dy = Math.max(o.r.top - cy, 0, cy - o.r.bottom);
          if (Math.sqrt(dx * dx + dy * dy) < 12) {
            crowded = true;
            break;
          }
        }
        if (!crowded && small.length) {
          // an undersized neighbour's own 24 px circle also counts, centre to centre
          for (const o of small) if (o !== b && Math.hypot(o.r.left + o.r.width / 2 - cx, o.r.top + o.r.height / 2 - cy) < 24) crowded = true;
        }
        if (crowded) add('target', el, `${Math.round(b.r.width)}x${Math.round(b.r.height)} px`);
      }
    }

    if (want.has('aria-hidden')) {
      const marked = all('[aria-hidden="true"]');
      const set = new Set(marked);
      for (const el of marked) {
        let nested = false;
        for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) nested = true;
        if (nested) continue;
        const inner = Array.prototype.slice.call(el.querySelectorAll(FOCUSABLE), 0, 50).concat(el.matches(FOCUSABLE) ? [el] : []).filter(focusable);
        if (inner.length) add('aria-hidden', el, `hides ${inner.length} focusable (${tagLabel(inner[0])})`);
      }
    }
    return rep;
  };

  // ───────────────────────────── screenshots ─────────────────────────────

  /** Put the page view's element numbers on the page for one screenshot. `unlabel` takes them off again. */
  const label = (items: { n: number; num: number }[], region: { x: number; y: number; w: number; h: number }): number => {
    unlabel();
    const host = doc.createElement('div');
    host.setAttribute('data-agentweb-labels', '');
    host.style.cssText = 'all:initial;position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    const sx = win.scrollX || 0;
    const sy = win.scrollY || 0;
    let n = 0;
    for (const it of items) {
      if (n >= 200) break;
      let el: any = null;
      try {
        const ref = reg && reg.nodes.get(it.n);
        el = ref && ref.deref ? ref.deref() : ref;
      } catch {}
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const x = r.left + sx;
      const y = r.top + sy;
      if (x + r.width < region.x || y + r.height < region.y || x > region.x + region.w || y > region.y + region.h) continue;
      const b = doc.createElement('span');
      b.textContent = String(it.num);
      b.style.cssText = `all:initial;position:absolute;left:${Math.max(0, x)}px;top:${Math.max(0, y)}px;box-sizing:border-box;min-width:14px;padding:0 3px;font:bold 11px/14px monospace;color:#fff;background:#d11;border:1px solid #fff;border-radius:3px;text-align:center;`;
      const ring = doc.createElement('span');
      ring.style.cssText = `all:initial;position:absolute;left:${x}px;top:${y}px;width:${r.width}px;height:${r.height}px;box-sizing:border-box;border:1px solid rgba(221,17,17,.7);`;
      host.appendChild(ring);
      host.appendChild(b);
      n++;
    }
    (doc.body || de).appendChild(host);
    win.__awLabels = host;
    return n;
  };
  const unlabel = (): void => {
    const h = win.__awLabels;
    if (h && h.parentNode) h.parentNode.removeChild(h);
    win.__awLabels = null;
  };

  /** Compare two images (base64 JPEG or PNG) pixel by pixel in the browser, without touching the page. */
  const imgdiff = async (a: string, b: string): Promise<any> => {
    const load = async (b64: string) => {
      const bin = win.atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const bmp = await win.createImageBitmap(new win.Blob([bytes]));
      const c = doc.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      const out = { w: bmp.width, h: bmp.height, px: g.getImageData(0, 0, bmp.width, bmp.height).data };
      if (bmp.close) bmp.close();
      return out;
    };
    const x = await load(a);
    const y = await load(b);
    if (x.w !== y.w || x.h !== y.h) return { same: false, resized: true, w: x.w, h: x.h, w2: y.w, h2: y.h, ratio: 1 };
    let differ = 0;
    const n = x.w * x.h;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      // JPEG noise stays under this; a changed pixel of text or colour does not
      if (Math.abs(x.px[o] - y.px[o]) + Math.abs(x.px[o + 1] - y.px[o + 1]) + Math.abs(x.px[o + 2] - y.px[o + 2]) > 48) differ++;
    }
    return { same: differ === 0, w: x.w, h: x.h, ratio: n ? differ / n : 0, differ };
  };

  return { overflow, audit, label, unlabel, imgdiff };
}
