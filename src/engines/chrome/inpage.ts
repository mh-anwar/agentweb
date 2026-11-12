// Code that runs INSIDE the page, in the engine's isolated world. Nothing here may reference
// anything outside its own function body: each function is injected with `toString()`.
//
// `installHelpers` defines `__awh`, the small library the engine calls for every action:
// resolving a node id, aiming a click, preparing a field for typing, choosing an option, and so
// on. Every helper returns plain JSON. Failures an agent should hear about come back as
// `{ err: <ErrCode>, msg }` instead of being thrown, so they survive the trip through CDP.

export function installHelpers(win: any): void {
  if (win.__awh) return;
  const doc = win.document;

  const node = (id: number): any => {
    const reg = win.__aw;
    if (!reg) return null;
    const ref = reg.nodes.get(id);
    const el = ref && ref.deref ? ref.deref() : ref;
    return el && el.isConnected ? el : null;
  };
  const STALE = { err: 'stale', msg: 'that element is no longer on the page' };

  const viewOf = (el: any): any => (el.ownerDocument && el.ownerDocument.defaultView) || win;
  const tagOf = (el: any): string => (el.localName || '').toLowerCase();

  const describe = (el: any): string => {
    if (!el) return 'nothing';
    let s = tagOf(el);
    if (el.id) s += '#' + String(el.id).slice(0, 30);
    else if (typeof el.className === 'string' && el.className.trim()) s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.').slice(0, 40);
    return s;
  };

  /** parent in the flat tree: through slots, shadow roots and (same-origin) frames */
  const flatParent = (n: any): any => {
    if (n.assignedSlot) return n.assignedSlot;
    if (n.parentNode) return n.parentNode.nodeType === 11 && n.parentNode.host ? n.parentNode.host : n.parentNode.nodeType === 9 ? frameOf(n.parentNode) : n.parentNode;
    return null;
  };
  const frameOf = (d: any): any => {
    try {
      return d.defaultView && d.defaultView !== win ? d.defaultView.frameElement : null;
    } catch {
      return null;
    }
  };
  const within = (inner: any, outer: any): boolean => {
    for (let n = inner, i = 0; n && i < 2000; n = flatParent(n), i++) if (n === outer) return true;
    return false;
  };

  /** offset of the element's own viewport inside the top viewport (0,0 unless it lives in a frame) */
  const frameOffset = (el: any): { x: number; y: number } | null => {
    let x = 0;
    let y = 0;
    let w = viewOf(el);
    for (let i = 0; w && w !== win && i < 20; i++) {
      let fe: any;
      try {
        fe = w.frameElement;
      } catch {
        return null;
      }
      if (!fe) return null;
      const r = fe.getBoundingClientRect();
      const cs = viewOf(fe).getComputedStyle(fe);
      x += r.left + fe.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      y += r.top + fe.clientTop + (parseFloat(cs.paddingTop) || 0);
      w = viewOf(fe);
    }
    return { x, y };
  };

  /** deepest element at a top-viewport point, looking through open shadow roots and same-origin frames */
  const deepHit = (x: number, y: number): any => {
    let root: any = doc;
    let el: any = null;
    for (let i = 0; i < 30; i++) {
      let hit: any = null;
      try {
        hit = root.elementFromPoint(x, y);
      } catch {}
      if (!hit || hit === el) break;
      el = hit;
      if (el.shadowRoot) {
        root = el.shadowRoot;
        continue;
      }
      const t = tagOf(el);
      if (t === 'iframe' || t === 'frame') {
        let inner: any = null;
        try {
          inner = el.contentDocument;
        } catch {}
        if (!inner) break;
        const r = el.getBoundingClientRect();
        const cs = viewOf(el).getComputedStyle(el);
        x -= r.left + el.clientLeft + (parseFloat(cs.paddingLeft) || 0);
        y -= r.top + el.clientTop + (parseFloat(cs.paddingTop) || 0);
        root = inner;
        continue;
      }
      break;
    }
    return el;
  };

  const scrollTo = (el: any): void => {
    try {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      try {
        el.scrollIntoView();
      } catch {}
    }
  };

  /** does a click that lands on `hit` reach `el`? */
  const reaches = (hit: any, el: any): boolean => {
    if (!hit) return false;
    if (within(hit, el)) return true;
    // a label forwards its click to the control it labels
    try {
      const lab = hit.closest ? hit.closest('label') : null;
      if (lab && lab.control === el) return true;
    } catch {}
    return false;
  };

  /**
   * Find a point inside `el` where a real click would land on it. Scrolls it into view first.
   * Returns top-viewport coordinates and whether the hit test passed; when something covers the
   * element, `by` names the culprit so the engine can say why it fell back to a scripted click.
   */
  const aimEl = (el: any): any => {
    scrollTo(el);
    const off = frameOffset(el);
    if (!off) return { ok: false, by: 'a frame that cannot be reached' };
    let rects: any[] = [];
    try {
      rects = Array.prototype.slice.call(el.getClientRects(), 0, 4);
      const b = el.getBoundingClientRect();
      rects.unshift(b);
    } catch {}
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    let first: any = null;
    let by = '';
    for (const r of rects) {
      const left = Math.max(r.left + off.x, 0);
      const top = Math.max(r.top + off.y, 0);
      const right = Math.min(r.right + off.x, vw);
      const bottom = Math.min(r.bottom + off.y, vh);
      if (right - left < 1 || bottom - top < 1) continue;
      const x = Math.round((left + right) / 2);
      const y = Math.round((top + bottom) / 2);
      if (!first) first = { x, y };
      const hit = deepHit(x, y);
      if (reaches(hit, el)) return { ok: true, x, y };
      if (!by) by = describe(hit);
    }
    if (!first) return { ok: false, by: 'nothing (it has no visible box)' };
    return { ok: false, x: first.x, y: first.y, by };
  };

  /** Links and forms that would open another tab are pointed back at this one. */
  const keepInTab = (el: any): void => {
    try {
      const own = (t: string | null) => !!t && t !== '_self' && t !== '_top' && t !== '_parent' && !frameNamed(t);
      const a = el.closest ? el.closest('a[target],area[target]') : null;
      if (a && own(a.getAttribute('target'))) a.removeAttribute('target');
      const form = el.form || (el.closest ? el.closest('form') : null);
      if (form && own(form.getAttribute('target'))) form.removeAttribute('target');
      if (el.getAttribute && own(el.getAttribute('formtarget'))) el.removeAttribute('formtarget');
      const base = el.ownerDocument.querySelector('base[target]');
      if (base && own(base.getAttribute('target'))) base.removeAttribute('target');
    } catch {}
  };
  const frameNamed = (name: string): boolean => {
    try {
      for (let i = 0; i < win.frames.length; i++) if (win.frames[i].name === name) return true;
    } catch {}
    return false;
  };

  const isDisabled = (el: any): boolean => {
    try {
      return !!el.matches && el.matches(':disabled');
    } catch {
      return !!el.disabled;
    }
  };

  const fire = (el: any, type: string): void => {
    const V = viewOf(el);
    el.dispatchEvent(new V.Event(type, { bubbles: true, composed: true }));
  };

  /** set a form control's value the way a framework will notice: native setter, then input + change */
  const setNative = (el: any, value: string): void => {
    const V = viewOf(el);
    const proto = tagOf(el) === 'textarea' ? V.HTMLTextAreaElement.prototype : tagOf(el) === 'select' ? V.HTMLSelectElement.prototype : V.HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, value);
    else el.value = value;
    fire(el, 'input');
    fire(el, 'change');
  };

  const editable = (el: any): boolean => !!el.isContentEditable;
  const norm = (s: string): string => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

  const readValue = (el: any): string => {
    const t = tagOf(el);
    if (t === 'input' || t === 'textarea' || t === 'select') return String(el.value ?? '');
    if (editable(el)) return String(el.innerText ?? el.textContent ?? '').replace(/\n$/, '');
    return String(el.textContent ?? '');
  };

  const allText = (): string => {
    let out = '';
    const visit = (root: any, depth: number): void => {
      if (depth > 6) return;
      let els: any;
      try {
        els = root.querySelectorAll('*');
      } catch {
        return;
      }
      for (let i = 0; i < els.length && i < 30000; i++) {
        const e = els[i];
        if (e.shadowRoot) {
          const kids = e.shadowRoot.children;
          for (let k = 0; k < kids.length; k++) out += ' ' + (kids[k].innerText || '');
          visit(e.shadowRoot, depth + 1);
        } else if (e.localName === 'iframe' || e.localName === 'frame') {
          let d: any = null;
          try {
            d = e.contentDocument;
          } catch {}
          if (d && d.body) {
            out += ' ' + (d.body.innerText || '');
            visit(d, depth + 1);
          }
        }
      }
    };
    out += (doc.body && doc.body.innerText) || '';
    visit(doc, 0);
    return out;
  };

  /** the element that really scrolls: the document, or the biggest scrollable box of an app shell */
  const scroller = (): any => {
    const se = doc.scrollingElement || doc.documentElement;
    if (se && se.scrollHeight > win.innerHeight + 4) return se;
    let best: any = null;
    let bestArea = 0;
    const els = doc.querySelectorAll('*');
    for (let i = 0; i < els.length && i < 8000; i++) {
      const e = els[i];
      if (e.scrollHeight <= e.clientHeight + 40 || e.clientHeight < 100) continue;
      const oy = win.getComputedStyle(e).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      const area = e.clientWidth * e.clientHeight;
      if (area > bestArea) {
        best = e;
        bestArea = area;
      }
    }
    return best || se;
  };

  // ── DOM quiet: a MutationObserver that also reaches into open shadow roots and same-origin frames
  const q = (win.__awq ||= { last: win.performance.now(), n: 0, seen: new win.WeakSet(), mo: null as any });
  const watch = (root: any): void => {
    if (!root || q.seen.has(root)) return;
    q.seen.add(root);
    try {
      q.mo.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch {}
  };
  if (!q.mo) {
    q.mo = new win.MutationObserver((recs: any[]) => {
      q.last = win.performance.now();
      q.n += recs.length;
    });
    watch(doc);
  }
  const watchDeep = (): void => {
    const visit = (root: any, depth: number): void => {
      if (depth > 6) return;
      let els: any;
      try {
        els = root.querySelectorAll('*');
      } catch {
        return;
      }
      for (let i = 0; i < els.length && i < 30000; i++) {
        const e = els[i];
        if (e.shadowRoot) {
          watch(e.shadowRoot);
          visit(e.shadowRoot, depth + 1);
        } else if (e.localName === 'iframe' || e.localName === 'frame') {
          let d: any = null;
          try {
            d = e.contentDocument;
          } catch {}
          if (d) {
            watch(d);
            visit(d, depth + 1);
          }
        }
      }
    };
    visit(doc, 0);
  };

  win.__awh = {
    /** resolves when the DOM has not changed for `quietMs` (true) or `maxMs` has passed (false) */
    quiet(quietMs: number, maxMs: number): Promise<boolean> {
      watchDeep();
      return new Promise((resolve) => {
        const t0 = win.performance.now();
        const tick = () => {
          const now = win.performance.now();
          const idle = now - q.last;
          if (idle >= quietMs) return resolve(true);
          if (now - t0 >= maxMs) return resolve(false);
          win.setTimeout(tick, Math.max(5, Math.min(quietMs - idle, 50, maxMs - (now - t0))));
        };
        tick();
      });
    },

    /** click target: where to press, or why a real press cannot reach it */
    aim(id: number, viaLabel: boolean): any {
      const el = node(id);
      if (!el) return STALE;
      const tag = tagOf(el);
      if (tag === 'option' || tag === 'optgroup') {
        const sel = el.closest ? el.closest('select') : null;
        return { option: true, select: !!sel, disabled: !!el.disabled };
      }
      if (isDisabled(el)) return { err: 'bad_request', msg: `that ${tag} is disabled` };
      keepInTab(el);
      const type = tag === 'input' ? String(el.type || '').toLowerCase() : '';
      let r = aimEl(el);
      if (!r.ok && viaLabel) {
        // a restyled checkbox is usually an invisible input under a visible label
        const labs = el.labels;
        for (let i = 0; labs && i < labs.length; i++) {
          const lr = aimEl(labs[i]);
          if (lr.ok) {
            r = lr;
            break;
          }
        }
      }
      r.tag = tag;
      r.type = type;
      r.ariaDisabled = el.getAttribute('aria-disabled') === 'true';
      return r;
    },

    /** the fallback when something covers the element: the page's own click path, no coordinates */
    scriptClick(id: number): any {
      const el = node(id);
      if (!el) return STALE;
      keepInTab(el);
      if (typeof el.click === 'function') el.click();
      else {
        const V = viewOf(el);
        for (const t of ['mousedown', 'mouseup', 'click']) el.dispatchEvent(new V.MouseEvent(t, { bubbles: true, cancelable: true, composed: true, view: V }));
      }
      return { ok: true };
    },

    /** choose the <option> that was "clicked" */
    pickOption(id: number): any {
      const el = node(id);
      if (!el) return STALE;
      const sel = el.closest ? el.closest('select') : null;
      if (!sel) return { err: 'bad_request', msg: 'that option is not inside a select' };
      if (isDisabled(sel) || el.disabled) return { err: 'bad_request', msg: 'that option is disabled' };
      if (sel.multiple) el.selected = !el.selected;
      else el.selected = true;
      fire(sel, 'input');
      fire(sel, 'change');
      return { ok: true, label: String(el.label || el.textContent || '').trim() };
    },

    hoverSynth(id: number): any {
      const el = node(id);
      if (!el) return STALE;
      const V = viewOf(el);
      for (const [t, bubbles] of [['pointerover', true], ['pointerenter', false], ['mouseover', true], ['mouseenter', false], ['pointermove', true], ['mousemove', true]] as [string, boolean][]) {
        el.dispatchEvent(new V.MouseEvent(t, { bubbles, cancelable: true, composed: true, view: V }));
      }
      return { ok: true };
    },

    /**
     * Get a field ready for typing: focus it and select what it holds, so the next inserted text
     * replaces it. Controls that cannot be typed into (dates, colours, ranges) are set directly.
     */
    prepFill(id: number, value: string): any {
      const el = node(id);
      if (!el) return STALE;
      const tag = tagOf(el);
      if (tag === 'select') return { kind: 'select' };
      if (tag === 'input' || tag === 'textarea') {
        const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : 'textarea';
        if (type === 'checkbox' || type === 'radio') return { err: 'bad_request', msg: `that is a ${type}; use check` };
        if (type === 'file') return { err: 'bad_request', msg: 'that is a file input; use upload' };
        if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image' || type === 'hidden') return { err: 'bad_request', msg: `a ${type} input cannot be filled` };
        if (isDisabled(el)) return { err: 'bad_request', msg: 'that field is disabled' };
        if (el.readOnly) return { err: 'bad_request', msg: 'that field is read-only' };
        scrollTo(el);
        const secret = type === 'password';
        if (type === 'date' || type === 'time' || type === 'datetime-local' || type === 'month' || type === 'week' || type === 'color' || type === 'range') {
          try {
            el.focus();
          } catch {}
          setNative(el, value);
          return { kind: 'set', value: secret ? '' : readValue(el), type };
        }
        try {
          el.focus();
          el.select();
        } catch {}
        const V = viewOf(el);
        let focused = false;
        try {
          focused = el.ownerDocument.activeElement === el || (el.getRootNode && el.getRootNode().activeElement === el);
        } catch {}
        return { kind: 'type', type, secret, focused, empty: !el.value, max: el.maxLength > 0 ? el.maxLength : 0, multiline: tag === 'textarea', view: !!V };
      }
      // contenteditable: the element itself, or the editing host it sits in
      let host = el;
      if (!editable(host)) {
        const inner = el.querySelector ? el.querySelector('[contenteditable]:not([contenteditable="false"])') : null;
        if (inner) host = inner;
      }
      if (!editable(host)) return { err: 'bad_request', msg: `a ${tag} cannot be filled`, hint: 'fill works on inputs, textareas and contenteditable elements' };
      scrollTo(host);
      try {
        host.focus();
        const V = viewOf(host);
        const sel = V.getSelection();
        const range = host.ownerDocument.createRange();
        range.selectNodeContents(host);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch {}
      return { kind: 'type', type: 'contenteditable', secret: false, focused: true, empty: !readValue(host), max: 0, multiline: true, host: host !== el };
    },

    /** what the field holds now (after typing), for verification */
    fieldValue(id: number): any {
      const el = node(id);
      if (!el) return STALE;
      let host = el;
      const tag = tagOf(el);
      if (tag !== 'input' && tag !== 'textarea' && !editable(el)) {
        const inner = el.querySelector ? el.querySelector('[contenteditable]:not([contenteditable="false"])') : null;
        if (inner) host = inner;
      }
      return { value: readValue(host) };
    },

    /** last resort when typing did not take: write the value and fire the events by hand */
    forceValue(id: number, value: string): any {
      const el = node(id);
      if (!el) return STALE;
      const tag = tagOf(el);
      if (tag === 'input' || tag === 'textarea') setNative(el, value);
      else {
        let host = el;
        if (!editable(host)) host = (el.querySelector && el.querySelector('[contenteditable]:not([contenteditable="false"])')) || el;
        host.textContent = value;
        fire(host, 'input');
      }
      return { value: readValue(el) };
    },

    /** choose an option by label, then by value, ignoring case and surrounding space */
    select(id: number, wanted: string): any {
      const el = node(id);
      if (!el) return STALE;
      if (tagOf(el) !== 'select') return { err: 'bad_request', msg: `that is a ${tagOf(el)}, not a select`, hint: 'click it to open the list, then click the option' };
      if (isDisabled(el)) return { err: 'bad_request', msg: 'that select is disabled' };
      const opts = el.options;
      const want = norm(wanted);
      let hit: any = null;
      for (let i = 0; i < opts.length && !hit; i++) if (norm(opts[i].label || opts[i].textContent || '') === want) hit = opts[i];
      for (let i = 0; i < opts.length && !hit; i++) if (norm(opts[i].value) === want) hit = opts[i];
      if (!hit) {
        const have: string[] = [];
        for (let i = 0; i < opts.length && have.length < 12; i++) have.push(String(opts[i].label || opts[i].textContent || '').replace(/\s+/g, ' ').trim());
        return { err: 'bad_request', msg: `no option "${String(wanted).slice(0, 60)}"`, hint: `options: ${have.join(' | ')}${opts.length > 12 ? ' | …' : ''}` };
      }
      if (hit.disabled) return { err: 'bad_request', msg: `option "${String(wanted).slice(0, 60)}" is disabled` };
      try {
        el.focus();
      } catch {}
      const changed = !hit.selected;
      if (el.multiple) hit.selected = true;
      else {
        const d = Object.getOwnPropertyDescriptor(viewOf(el).HTMLSelectElement.prototype, 'selectedIndex');
        if (d && d.set) d.set.call(el, hit.index);
        else el.selectedIndex = hit.index;
      }
      if (changed) {
        fire(el, 'input');
        fire(el, 'change');
      }
      return { ok: true, label: String(hit.label || hit.textContent || '').replace(/\s+/g, ' ').trim(), value: el.value };
    },

    /** current state of something checkable */
    checkState(id: number): any {
      const el = node(id);
      if (!el) return STALE;
      const tag = tagOf(el);
      const type = tag === 'input' ? String(el.type || '').toLowerCase() : '';
      if (type === 'checkbox' || type === 'radio') return { kind: type, on: !!el.checked, disabled: isDisabled(el) };
      // a label wrapping (or pointing at) a checkbox stands for it
      if (tag === 'label' && el.control && /^(checkbox|radio)$/.test(el.control.type || '')) return { kind: el.control.type, on: !!el.control.checked, disabled: isDisabled(el.control), viaLabel: true };
      for (const attr of ['aria-checked', 'aria-pressed', 'aria-selected']) {
        const v = el.getAttribute(attr);
        if (v === 'true' || v === 'false') return { kind: 'aria', on: v === 'true', disabled: el.getAttribute('aria-disabled') === 'true' };
      }
      return { kind: 'none', on: false, disabled: false };
    },

    forceCheck(id: number, on: boolean): any {
      const el = node(id);
      if (!el) return STALE;
      const target = tagOf(el) === 'label' && el.control ? el.control : el;
      if (!('checked' in target)) return { ok: false };
      const d = Object.getOwnPropertyDescriptor(viewOf(target).HTMLInputElement.prototype, 'checked');
      if (d && d.set) d.set.call(target, on);
      else target.checked = on;
      fire(target, 'click');
      fire(target, 'input');
      fire(target, 'change');
      return { ok: true, on: !!target.checked };
    },

    focus(id: number): any {
      const el = node(id);
      if (!el) return STALE;
      scrollTo(el);
      try {
        el.focus();
      } catch {}
      return { ok: true };
    },

    scroll(to: any): any {
      const s = scroller();
      const before = { h: s.scrollHeight, y: s.scrollTop };
      const top = to === 'bottom' ? s.scrollHeight : to === 'top' ? 0 : Math.max(0, Number(to) || 0);
      try {
        s.scrollTo({ top, behavior: 'instant' });
      } catch {
        s.scrollTop = top;
      }
      // listeners on window miss scrolls of an inner box unless they capture; nudge them
      if (s !== (doc.scrollingElement || doc.documentElement)) win.dispatchEvent(new win.Event('scroll'));
      return { h: before.h, from: before.y, y: s.scrollTop, view: s.clientHeight };
    },

    scrollInfo(): any {
      const s = scroller();
      return { h: s.scrollHeight, y: s.scrollTop, view: s.clientHeight };
    },

    hasText(text: string): boolean {
      return norm(allText()).includes(norm(text));
    },

    /** resolves true when `text` is on the page, false after `maxMs` */
    waitText(text: string, maxMs: number): Promise<boolean> {
      const want = norm(text);
      return new Promise((resolve) => {
        const t0 = win.performance.now();
        const tick = () => {
          if (norm(allText()).includes(want)) return resolve(true);
          if (win.performance.now() - t0 >= maxMs) return resolve(false);
          win.setTimeout(tick, 100);
        };
        tick();
      });
    },

    /**
     * One look at wait()'s conditions: which of `any` is on the page, whether `gone` still is, and the state of
     * target `n`. Cheap enough to run every 100 ms.
     */
    probe(spec: any): any {
      const text = spec.any || spec.gone ? norm(allText()) : '';
      let hit: string | undefined;
      if (spec.any) {
        hit = (spec.any as string[]).find((t) => text.includes(norm(t)));
        if (hit === undefined) return { ok: false };
      }
      if (spec.gone && text.includes(norm(spec.gone))) return { ok: false };
      if (spec.state) {
        const el = spec.n !== undefined ? node(spec.n) : null;
        let vis = false;
        if (el) {
          const rects = el.getClientRects();
          const cs = viewOf(el).getComputedStyle(el);
          vis = cs.visibility !== 'hidden' && cs.display !== 'none' && Array.prototype.some.call(rects, (r: any) => r.width > 0 || r.height > 0);
        }
        const ok = spec.state === 'hidden' ? !vis : spec.state === 'visible' ? vis : !!el && !isDisabled(el);
        if (!ok) return { ok: false, st: !el ? 'gone' : !vis ? 'hidden' : isDisabled(el) ? 'disabled' : 'visible' };
      }
      return { ok: true, hit };
    },

    /** the start of what the page says, for a timeout message */
    glance(): string {
      return String((doc.body && doc.body.innerText) || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    },

    /** drop files on an element: dragenter, dragover, drop with a DataTransfer that carries them */
    drop(id: number, files: { name: string; mime: string; data: string }[]): any {
      const el = node(id);
      if (!el) return STALE;
      const V = viewOf(el);
      const dt = new V.DataTransfer();
      for (const f of files) {
        const bin = V.atob(f.data);
        const bytes = new V.Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new V.File([bytes], f.name, { type: f.mime }));
      }
      scrollTo(el);
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new V.DragEvent('dragenter', init));
      // a page that allows the drop cancels dragover
      const accepted = !el.dispatchEvent(new V.DragEvent('dragover', init));
      el.dispatchEvent(new V.DragEvent('drop', init));
      return { ok: true, accepted, tag: tagOf(el) };
    },

    /** localStorage of this document's origin, bounded so a session record stays small */
    storage(): any {
      const out: Record<string, string> = {};
      let origin = '';
      try {
        origin = win.location.origin;
        const ls = win.localStorage;
        let total = 0;
        for (let i = 0; i < ls.length && i < 500; i++) {
          const k = ls.key(i);
          if (k === null) continue;
          const v = ls.getItem(k) ?? '';
          if (v.length > 262144) continue;
          total += k.length + v.length;
          if (total > 2097152) break;
          out[k] = v;
        }
      } catch {
        return { origin, items: null };
      }
      return { origin, items: out };
    },

    setStorage(items: Record<string, string>): boolean {
      try {
        const ls = win.localStorage;
        ls.clear();
        for (const k in items) ls.setItem(k, items[k]);
        return true;
      } catch {
        return false;
      }
    },

    /** rectangle of an element in page coordinates, for a clipped screenshot */
    rect(id: number): any {
      const el = node(id);
      if (!el) return STALE;
      scrollTo(el);
      const off = frameOffset(el);
      if (!off) return { err: 'bad_request', msg: 'that element is inside a frame that cannot be reached' };
      const r = el.getBoundingClientRect();
      return { x: r.left + off.x + win.scrollX, y: r.top + off.y + win.scrollY, w: r.width, h: r.height };
    },

    /** the <input type=file> an upload should go to: the element, its label's control, or one inside it */
    fileInput(id: number): any {
      const el = node(id);
      if (!el) return null;
      const isFile = (e: any) => e && tagOf(e) === 'input' && String(e.type).toLowerCase() === 'file';
      if (isFile(el)) return el;
      if (tagOf(el) === 'label' && isFile(el.control)) return el.control;
      const inner = el.querySelector ? el.querySelector('input[type=file]') : null;
      if (inner) return inner;
      const lab = el.closest ? el.closest('label') : null;
      if (lab && isFile(lab.control)) return lab.control;
      return null;
    },

    alive(id: number): boolean {
      return !!node(id);
    },

    el(id: number): any {
      return node(id);
    },
  };
}

/**
 * Runs in the page's MAIN world at document start. Remembers which elements got a click-type
 * listener, and answers the extractor's probe event by cancelling it. The extractor, in the
 * isolated world, sees only that one bit per element. Nothing here is trusted: a page that tampers
 * with it can at most make an element look clickable (or not).
 */
export function listenerProbe(win: any, eventName: string): void {
  try {
    const ET = win.EventTarget && win.EventTarget.prototype;
    if (!ET || !ET.addEventListener || typeof win.Proxy !== 'function') return;
    const marked = new win.WeakSet();
    const TYPES: Record<string, 1> = { click: 1, mousedown: 1, mouseup: 1, pointerdown: 1, pointerup: 1, touchstart: 1, touchend: 1, dblclick: 1, dragstart: 1, drop: 1 };
    const add = ET.addEventListener;
    const reflectApply = win.Reflect.apply;
    const wsAdd = win.WeakSet.prototype.add;
    const wsHas = win.WeakSet.prototype.has;
    ET.addEventListener = new win.Proxy(add, {
      apply(target: any, self: any, args: any[]) {
        try {
          if (self && self.nodeType === 1 && args[1] && TYPES[args[0]]) wsAdd.call(marked, self);
        } catch {}
        return reflectApply(target, self, args);
      },
    });
    for (const proto of [win.HTMLElement && win.HTMLElement.prototype, win.SVGElement && win.SVGElement.prototype]) {
      if (!proto) continue;
      const d = Object.getOwnPropertyDescriptor(proto, 'onclick');
      if (!d || !d.set || !d.configurable) continue;
      Object.defineProperty(proto, 'onclick', {
        get: d.get,
        set: new win.Proxy(d.set, {
          apply(target: any, self: any, args: any[]) {
            try {
              if (self && typeof args[0] === 'function') wsAdd.call(marked, self);
            } catch {}
            return reflectApply(target, self, args);
          },
        }),
        enumerable: d.enumerable,
        configurable: true,
      });
    }
    add.call(win, eventName, (e: any) => {
      try {
        const path = e.composedPath ? e.composedPath() : null;
        const t = path && path.length ? path[0] : e.target;
        if (t && wsHas.call(marked, t)) e.preventDefault();
        e.stopImmediatePropagation();
      } catch {}
    }, true);
  } catch {}
}

/** Runs in the isolated world at document start: puts back the session's localStorage for this origin. */
export function seedStorage(win: any, seeds: Record<string, Record<string, string>>): void {
  try {
    if (win !== win.top) return;
    const items = seeds[win.location.origin];
    if (!items) return;
    const ls = win.localStorage;
    for (const k in items) ls.setItem(k, items[k]);
  } catch {}
}
