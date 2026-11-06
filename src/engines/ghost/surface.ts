// The browser surface that jsdom does not provide, or provides in a way a headless agent engine
// cannot use (real timers, real sockets, "not implemented" errors).
//
// RULES FOR THIS FILE
//  - `installSurface` is stringified and evaluated INSIDE the page realm, so that every object a
//    page sees (parsed JSON, typed arrays, errors, promises) has that realm's prototypes. A
//    `response.json()` whose result fails `x.constructor === Object` breaks real applications.
//  - It must be self-contained: no imports, no references outside its own body.
//  - `host` is the only way out. It is captured in this closure and never reachable from page
//    code. Everything that crosses it is a primitive, a byte array, or a callback.
//  - Erasable TypeScript only.

export interface SurfaceConfig {
  idBase: number;
  /** web streams classes lent from the host realm (the page has none of its own) */
  streams: Record<string, unknown>;
}

export interface SurfaceHooks {
  /** counters the engine reads to decide whether the page leaned on stubs */
  stats: Record<string, number>;
  /** tell every IntersectionObserver its targets are (still) visible; fire a scroll event */
  scrolled(y: number): void;
}

export function installSurface(win: any, host: any, cfg: SurfaceConfig): SurfaceHooks {
  const doc = win.document;
  const stats: Record<string, number> = { geom: 0, canvas: 0, draws: 0, webgl: 0, ws: 0, syncXhr: 0, beacon: 0, cs: 0 };
  const def = (obj: any, name: string, value: any) => {
    try {
      Object.defineProperty(obj, name, { value, writable: true, configurable: true, enumerable: false });
    } catch {}
  };
  const getter = (obj: any, name: string, get: () => any, set?: (v: any) => void) => {
    try {
      Object.defineProperty(obj, name, { get, set: set || (() => {}), configurable: true, enumerable: true });
    } catch {}
  };
  const later = (fn: () => void) => host.timer('port', 0, fn, false);
  const domErr = (msg: string, name: string) => new win.DOMException(msg, name);

  // ───────────── node id registry (ids never repeat within a session) ─────────────
  win.__aw = { ids: new win.WeakMap(), nodes: new win.Map(), next: cfg.idBase };

  // ───────────── clock ─────────────
  const callable = (h: any) => (typeof h === 'function' ? h : () => (0, win.eval)(String(h)));
  win.setTimeout = function setTimeout(handler: any, delay?: any) {
    const args = Array.prototype.slice.call(arguments, 2);
    const f = callable(handler);
    return host.timer('timeout', +delay || 0, () => f.apply(win, args), false);
  };
  win.setInterval = function setInterval(handler: any, delay?: any) {
    const args = Array.prototype.slice.call(arguments, 2);
    const f = callable(handler);
    return host.timer('interval', +delay || 0, () => f.apply(win, args), true);
  };
  win.clearTimeout = win.clearInterval = function clearTimer(id: any) {
    if (typeof id === 'number') host.cancel(id, 'timeout');
  };
  win.requestAnimationFrame = function requestAnimationFrame(cb: any) {
    return host.timer('frame', 16, () => cb(host.perf()), false);
  };
  win.cancelAnimationFrame = function cancelAnimationFrame(id: any) {
    if (typeof id === 'number') host.cancel(id, 'frame');
  };
  win.requestIdleCallback = function requestIdleCallback(cb: any) {
    return host.timer('idle', 1, () => cb({ didTimeout: false, timeRemaining: () => 50 }), false);
  };
  win.cancelIdleCallback = function cancelIdleCallback(id: any) {
    if (typeof id === 'number') host.cancel(id, 'idle');
  };

  const RealDate = win.Date;
  const now = function now() {
    return host.now();
  };
  const VDate: any = new Proxy(RealDate, {
    construct(t: any, args: any[], nt: any) {
      return Reflect.construct(t, args.length ? args : [host.now()], nt === VDate ? t : nt);
    },
    apply(t: any) {
      return new t(host.now()).toString();
    },
    get(t: any, k: any) {
      return k === 'now' ? now : Reflect.get(t, k, t);
    },
  });
  RealDate.prototype.constructor = VDate;
  win.Date = VDate;
  const perf = win.performance;
  if (perf) {
    def(perf, 'now', () => host.perf());
    const marks: any[] = [];
    if (!perf.mark) def(perf, 'mark', (name: string) => (marks.push({ name, entryType: 'mark', startTime: host.perf(), duration: 0 }), marks[marks.length - 1]));
    if (!perf.measure) def(perf, 'measure', (name: string) => ({ name, entryType: 'measure', startTime: 0, duration: host.perf() }));
    if (!perf.getEntriesByName) def(perf, 'getEntriesByName', (n: string) => marks.filter((m) => m.name === n));
    if (!perf.getEntriesByType) def(perf, 'getEntriesByType', (t: string) => marks.filter((m) => m.entryType === t));
    if (!perf.getEntries) def(perf, 'getEntries', () => marks.slice());
    if (!perf.clearMarks) def(perf, 'clearMarks', () => void (marks.length = 0));
    if (!perf.clearMeasures) def(perf, 'clearMeasures', () => {});
  }

  // ───────────── windows, dialogs, scrolling ─────────────
  win.alert = (m?: any) => host.note('dialog', 'alert: ' + String(m ?? ''));
  win.confirm = (m?: any) => (host.note('dialog', 'confirm (answered OK): ' + String(m ?? '')), true);
  win.prompt = (m?: any, d?: any) => (host.note('dialog', 'prompt (dismissed): ' + String(m ?? '')), d === undefined ? null : String(d));
  win.print = () => {};
  win.close = () => host.note('dialog', 'page called window.close()');
  win.open = (u?: any) => (host.note('popup', String(u ?? '')), null);
  win.focus = win.blur = win.stop = win.moveTo = win.moveBy = win.resizeTo = win.resizeBy = () => {};
  let sx = 0;
  let sy = 0;
  const fireScroll = () =>
    later(() => {
      doc.dispatchEvent(new win.Event('scroll', { bubbles: true }));
    });
  const scrollTo = (a?: any, b?: any) => {
    if (a && typeof a === 'object') {
      sx = +a.left || 0;
      sy = +a.top || 0;
    } else {
      sx = +a || 0;
      sy = +b || 0;
    }
    fireScroll();
  };
  win.scrollTo = win.scroll = scrollTo;
  win.scrollBy = (a?: any, b?: any) => (a && typeof a === 'object' ? scrollTo(sx + (+a.left || 0), sy + (+a.top || 0)) : scrollTo(sx + (+a || 0), sy + (+b || 0)));
  for (const k of ['scrollX', 'pageXOffset']) getter(win, k, () => sx);
  for (const k of ['scrollY', 'pageYOffset']) getter(win, k, () => sy);

  // ───────────── geometry: there is no layout, so everything is plausibly on screen ─────────────
  const VW = win.innerWidth || 1024;
  const VH = win.innerHeight || 768;
  const INLINE: Record<string, 1> = { A: 1, SPAN: 1, B: 1, I: 1, EM: 1, STRONG: 1, BUTTON: 1, INPUT: 1, SELECT: 1, LABEL: 1, IMG: 1, SVG: 1, CODE: 1, SMALL: 1 };
  const gone = (el: any) => {
    if (!el.isConnected) return true;
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (n.hasAttribute('hidden')) return true;
      const st = n.getAttribute('style');
      if (st && /display\s*:\s*none/i.test(st)) return true;
    }
    return false;
  };
  const box = (el: any) => {
    stats.geom++;
    if (gone(el)) return { x: 0, y: 0, w: 0, h: 0 };
    if (el === doc.documentElement || el === doc.body) return { x: 0, y: 0, w: VW, h: VH };
    return INLINE[el.tagName] ? { x: 8, y: 8, w: 120, h: 20 } : { x: 8, y: 8, w: VW - 16, h: 20 };
  };
  const rectOf = (el: any) => {
    const b = box(el);
    return new win.DOMRect(b.x, b.y, b.w, b.h);
  };
  const EP = win.Element.prototype;
  const HP = win.HTMLElement.prototype;
  def(EP, 'getBoundingClientRect', function (this: any) {
    return rectOf(this);
  });
  def(EP, 'getClientRects', function (this: any) {
    const r = rectOf(this);
    return r.width ? [r] : [];
  });
  for (const k of ['offsetWidth', 'clientWidth', 'scrollWidth'])
    getter(k === 'offsetWidth' ? HP : EP, k, function (this: any) {
      return box(this).w;
    });
  for (const k of ['offsetHeight', 'clientHeight', 'scrollHeight'])
    getter(k === 'offsetHeight' ? HP : EP, k, function (this: any) {
      return box(this).h;
    });
  for (const k of ['offsetTop', 'offsetLeft'])
    getter(HP, k, function (this: any) {
      return box(this).x;
    });
  getter(HP, 'offsetParent', function (this: any) {
    stats.geom++;
    return this === doc.body || this === doc.documentElement || gone(this) ? null : doc.body;
  });
  def(EP, 'scrollIntoView', () => {});
  def(EP, 'scrollTo', () => {});
  def(EP, 'scroll', () => {});
  def(EP, 'scrollBy', () => {});
  if (!EP.checkVisibility)
    def(EP, 'checkVisibility', function (this: any) {
      return !gone(this);
    });
  if (!EP.getAnimations) def(EP, 'getAnimations', () => []);
  if (!EP.animate)
    def(EP, 'animate', () => {
      const a: any = { playState: 'finished', currentTime: 0, effect: null, onfinish: null, oncancel: null, finished: Promise.resolve(), ready: Promise.resolve() };
      for (const k of ['cancel', 'finish', 'play', 'pause', 'reverse', 'commitStyles', 'persist', 'addEventListener', 'removeEventListener', 'updatePlaybackRate']) a[k] = () => {};
      later(() => typeof a.onfinish === 'function' && a.onfinish({ type: 'finish', target: a }));
      return a;
    });
  def(doc, 'elementFromPoint', () => doc.body);
  def(doc, 'elementsFromPoint', () => (doc.body ? [doc.body, doc.documentElement] : []));
  if (!doc.execCommand) def(doc, 'execCommand', () => false);
  if (!doc.fonts) {
    const fonts: any = { status: 'loaded', size: 0, check: () => true, load: () => Promise.resolve([]), add() {}, delete: () => false, clear() {}, forEach() {}, addEventListener() {}, removeEventListener() {} };
    fonts.ready = Promise.resolve(fonts);
    def(doc, 'fonts', fonts);
  }
  if (!win.visualViewport) {
    const vv: any = new win.EventTarget();
    Object.assign(vv, { width: VW, height: VH, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0, scale: 1 });
    def(win, 'visualViewport', vv);
  }

  // ───────────── media queries and the "everything is visible" observers ─────────────
  const px = (v: string) => {
    const m = /^(-?[\d.]+)\s*(px|em|rem)?$/.exec(v.trim());
    return m ? parseFloat(m[1]) * (m[2] === 'em' || m[2] === 'rem' ? 16 : 1) : NaN;
  };
  const FEATURES: Record<string, string> = {
    orientation: VW >= VH ? 'landscape' : 'portrait', 'prefers-color-scheme': 'light', 'prefers-reduced-motion': 'reduce',
    'prefers-contrast': 'no-preference', hover: 'hover', 'any-hover': 'hover', pointer: 'fine', 'any-pointer': 'fine',
    'display-mode': 'browser', scripting: 'enabled', 'forced-colors': 'none', 'prefers-reduced-data': 'no-preference',
  };
  const feature = (f: string): boolean => {
    f = f.trim().toLowerCase();
    let m = /^(min-|max-)?(width|height)\s*:\s*(.+)$/.exec(f);
    if (m) {
      const have = m[2] === 'width' ? VW : VH;
      const want = px(m[3]);
      return m[1] === 'min-' ? have >= want : m[1] === 'max-' ? have <= want : have === want;
    }
    m = /^(width|height)\s*(<=|>=|<|>|=)\s*(.+)$/.exec(f);
    if (m) {
      const have = m[1] === 'width' ? VW : VH;
      const want = px(m[3]);
      return m[2] === '<=' ? have <= want : m[2] === '>=' ? have >= want : m[2] === '<' ? have < want : m[2] === '>' ? have > want : have === want;
    }
    m = /^([a-z-]+)\s*(?::\s*(.+))?$/.exec(f);
    if (m && m[1] in FEATURES) return m[2] === undefined ? FEATURES[m[1]] !== 'none' : FEATURES[m[1]] === m[2].trim();
    if (m && (m[1] === 'min-resolution' || m[1] === '-webkit-min-device-pixel-ratio')) return parseFloat(m[2] || '9') <= 1;
    if (m && m[1] === 'color') return true;
    return false;
  };
  const mediaMatches = (q: string): boolean =>
    String(q)
      .split(',')
      .some((part) => {
        let s = part.trim().toLowerCase();
        if (!s) return true;
        let neg = false;
        if (s.startsWith('not ')) {
          neg = true;
          s = s.slice(4);
        }
        if (s.startsWith('only ')) s = s.slice(5);
        let ok = true;
        for (const term of s.split(/\s+and\s+/)) {
          const t = term.trim();
          if (t.startsWith('(')) ok = ok && feature(t.replace(/^\(|\)$/g, ''));
          else ok = ok && (t === 'all' || t === 'screen');
        }
        return neg ? !ok : ok;
      });
  win.matchMedia = function matchMedia(q: any) {
    const mql: any = new win.EventTarget();
    mql.media = String(q);
    mql.matches = mediaMatches(mql.media);
    mql.onchange = null;
    mql.addListener = (fn: any) => mql.addEventListener('change', fn);
    mql.removeListener = (fn: any) => mql.removeEventListener('change', fn);
    return mql;
  };

  const observers = new Set<any>();
  class IntersectionObserver {
    #cb: any;
    #targets = new Set<any>();
    #queue: any[] = [];
    #armed = false;
    root: any;
    rootMargin: string;
    thresholds: number[];
    constructor(cb: any, opts?: any) {
      if (typeof cb !== 'function') throw new TypeError('IntersectionObserver: callback is not a function');
      this.#cb = cb;
      this.root = (opts && opts.root) || null;
      this.rootMargin = (opts && opts.rootMargin) || '0px 0px 0px 0px';
      const t = opts && opts.threshold;
      this.thresholds = Array.isArray(t) ? t.slice() : [typeof t === 'number' ? t : 0];
    }
    _notify(el: any) {
      const r = rectOf(el);
      const visible = r.width > 0;
      this.#queue.push({ target: el, isIntersecting: visible, intersectionRatio: visible ? 1 : 0, boundingClientRect: r, intersectionRect: r, rootBounds: new win.DOMRect(0, 0, VW, VH), time: host.perf() });
      if (this.#armed) return;
      this.#armed = true;
      later(() => {
        this.#armed = false;
        const q = this.#queue;
        this.#queue = [];
        if (q.length) this.#cb(q, this);
      });
    }
    _again() {
      for (const el of this.#targets) if (el.isConnected) this._notify(el);
    }
    observe(el: any) {
      if (!el || el.nodeType !== 1) throw new TypeError('IntersectionObserver.observe: target is not an Element');
      if (this.#targets.has(el)) return;
      this.#targets.add(el);
      observers.add(this);
      this._notify(el);
    }
    unobserve(el: any) {
      this.#targets.delete(el);
      if (!this.#targets.size) observers.delete(this);
    }
    disconnect() {
      this.#targets.clear();
      this.#queue = [];
      observers.delete(this);
    }
    takeRecords() {
      const q = this.#queue;
      this.#queue = [];
      return q;
    }
  }
  win.IntersectionObserver = IntersectionObserver;
  win.IntersectionObserverEntry = function IntersectionObserverEntry() {};
  def(win.IntersectionObserverEntry.prototype, 'intersectionRatio', 0);
  def(win.IntersectionObserverEntry.prototype, 'isIntersecting', false);

  class ResizeObserver {
    #cb: any;
    #queue: any[] = [];
    #armed = false;
    #targets = new Set<any>();
    constructor(cb: any) {
      if (typeof cb !== 'function') throw new TypeError('ResizeObserver: callback is not a function');
      this.#cb = cb;
    }
    observe(el: any) {
      if (!el || el.nodeType !== 1 || this.#targets.has(el)) return;
      this.#targets.add(el);
      const r = rectOf(el);
      const size = [{ inlineSize: r.width, blockSize: r.height }];
      this.#queue.push({ target: el, contentRect: r, borderBoxSize: size, contentBoxSize: size, devicePixelContentBoxSize: size });
      if (this.#armed) return;
      this.#armed = true;
      later(() => {
        this.#armed = false;
        const q = this.#queue;
        this.#queue = [];
        if (q.length) this.#cb(q, this);
      });
    }
    unobserve(el: any) {
      this.#targets.delete(el);
    }
    disconnect() {
      this.#targets.clear();
      this.#queue = [];
    }
  }
  win.ResizeObserver = ResizeObserver;

  // ───────────── structured clone and message channels ─────────────
  const clone = (value: any, seen = new Map()): any => {
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol') throw domErr('value could not be cloned', 'DataCloneError');
      return value;
    }
    if (seen.has(value)) return seen.get(value);
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    let out: any;
    if (tag === 'Date') return new RealDate(value.getTime());
    if (tag === 'RegExp') return new RegExp(value.source, value.flags);
    if (tag === 'Boolean' || tag === 'Number' || tag === 'String') return Object(value.valueOf());
    if (tag === 'ArrayBuffer') return value.slice(0);
    if (ArrayBuffer.isView(value)) return tag === 'DataView' ? new DataView((value as any).buffer.slice(0), value.byteOffset, value.byteLength) : (value as any).slice();
    if (tag === 'Blob' || tag === 'File') return value;
    if (tag === 'Map') {
      out = new Map();
      seen.set(value, out);
      for (const [k, v] of value) out.set(clone(k, seen), clone(v, seen));
      return out;
    }
    if (tag === 'Set') {
      out = new Set();
      seen.set(value, out);
      for (const v of value) out.add(clone(v, seen));
      return out;
    }
    if (tag === 'Error') {
      out = new (win[value.name] && typeof win[value.name] === 'function' ? win[value.name] : Error)(value.message);
      if (value.stack) out.stack = value.stack;
      return out;
    }
    if (Array.isArray(value)) {
      out = new Array(value.length);
      seen.set(value, out);
      for (let i = 0; i < value.length; i++) if (i in value) out[i] = clone(value[i], seen);
      return out;
    }
    if (tag !== 'Object') throw domErr(tag + ' object could not be cloned', 'DataCloneError');
    out = {};
    seen.set(value, out);
    for (const k of Object.keys(value)) out[k] = clone(value[k], seen);
    return out;
  };
  win.structuredClone = function structuredClone(v: any) {
    return clone(v);
  };

  /** EventTarget with on<event> handler properties */
  const handlers = (proto: any, names: string[]) => {
    for (const n of names) {
      const slot = Symbol(n);
      Object.defineProperty(proto, 'on' + n, {
        configurable: true,
        enumerable: true,
        get(this: any) {
          return this[slot] ? this[slot].fn : null;
        },
        set(this: any, fn: any) {
          if (this[slot]) this.removeEventListener(n, this[slot].wrap);
          this[slot] = null;
          if (typeof fn !== 'function') return;
          const wrap = (e: any) => fn.call(this, e);
          this[slot] = { fn, wrap };
          this.addEventListener(n, wrap);
        },
      });
    }
  };

  class MessagePort extends win.EventTarget {
    _other: any = null;
    _closed = false;
    postMessage(data: any) {
      const other = this._other;
      if (!other || this._closed || other._closed) return;
      const d = clone(data);
      later(() => {
        if (!other._closed) other.dispatchEvent(new win.MessageEvent('message', { data: d }));
      });
    }
    start() {}
    close() {
      this._closed = true;
    }
  }
  handlers(MessagePort.prototype, ['message', 'messageerror']);
  win.MessagePort = MessagePort;
  win.MessageChannel = class MessageChannel {
    port1: any = new MessagePort();
    port2: any = new MessagePort();
    constructor() {
      this.port1._other = this.port2;
      this.port2._other = this.port1;
    }
  };
  if (!win.BroadcastChannel) {
    class BroadcastChannel extends win.EventTarget {
      name: string;
      constructor(name: any) {
        super();
        this.name = String(name);
      }
      postMessage() {}
      close() {}
    }
    handlers(BroadcastChannel.prototype, ['message', 'messageerror']);
    win.BroadcastChannel = BroadcastChannel;
  }
  for (const k of Object.keys(cfg.streams)) if (!win[k]) def(win, k, cfg.streams[k]);

  // ───────────── cookies ─────────────
  getter(
    win.Document.prototype,
    'cookie',
    () => host.getCookie(),
    (v) => host.setCookie(String(v)),
  );

  // ───────────── fetch ─────────────
  const enc = new win.TextEncoder();
  const utf8 = (s: string): any => enc.encode(s);
  const decode = (bytes: any, charset?: string) => {
    try {
      return new win.TextDecoder(charset || 'utf-8').decode(bytes);
    } catch {
      return new win.TextDecoder('utf-8').decode(bytes);
    }
  };
  const charsetOf = (type: string | null) => {
    const m = /charset\s*=\s*"?([^";\s]+)/i.exec(type || '');
    return m ? m[1] : undefined;
  };
  const concat = (parts: any[]) => {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new win.Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };
  const blobBytes = (b: any): Promise<any> =>
    typeof b.arrayBuffer === 'function'
      ? b.arrayBuffer().then((ab: any) => new win.Uint8Array(ab))
      : new Promise((res, rej) => {
          const fr = new win.FileReader();
          fr.onload = () => res(new win.Uint8Array(fr.result));
          fr.onerror = () => rej(fr.error);
          fr.readAsArrayBuffer(b);
        });
  const tagOf = (v: any) => Object.prototype.toString.call(v).slice(8, -1);
  /** body init -> bytes + default content type */
  const bodyOf = async (b: any): Promise<{ bytes: any; type: string | null }> => {
    if (b === null || b === undefined) return { bytes: null, type: null };
    if (typeof b === 'string') return { bytes: utf8(b), type: 'text/plain;charset=UTF-8' };
    const tag = tagOf(b);
    if (tag === 'URLSearchParams') return { bytes: utf8(b.toString()), type: 'application/x-www-form-urlencoded;charset=UTF-8' };
    if (tag === 'ArrayBuffer' || tag === 'SharedArrayBuffer') return { bytes: new win.Uint8Array(b.slice(0)), type: null };
    if (ArrayBuffer.isView(b)) return { bytes: new win.Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), type: null };
    if (tag === 'Blob' || tag === 'File') return { bytes: await blobBytes(b), type: b.type || null };
    if (tag === 'FormData') {
      const boundary = '----agentwebForm' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      const parts: any[] = [];
      const esc = (s: string) => String(s).replace(/\r?\n/g, '%0D%0A').replace(/"/g, '%22');
      for (const [name, value] of b.entries()) {
        if (typeof value === 'string') parts.push(utf8(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(name)}"\r\n\r\n${value.replace(/\r?\n/g, '\r\n')}\r\n`));
        else {
          parts.push(utf8(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(name)}"; filename="${esc(value.name || 'blob')}"\r\nContent-Type: ${value.type || 'application/octet-stream'}\r\n\r\n`));
          parts.push(await blobBytes(value));
          parts.push(utf8('\r\n'));
        }
      }
      parts.push(utf8(`--${boundary}--\r\n`));
      return { bytes: concat(parts), type: 'multipart/form-data; boundary=' + boundary };
    }
    if (tag === 'ReadableStream') throw new TypeError('fetch: streaming request bodies are not supported');
    return { bytes: utf8(String(b)), type: 'text/plain;charset=UTF-8' };
  };

  const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  class Headers {
    _m = new Map<string, { name: string; values: string[] }>();
    constructor(init?: any) {
      if (!init) return;
      if (init instanceof Headers) for (const [k, v] of init) this.append(k, v);
      else if (typeof init[Symbol.iterator] === 'function') for (const pair of init) this.append(pair[0], pair[1]);
      else for (const k of Object.keys(init)) this.append(k, init[k]);
    }
    append(name: any, value: any) {
      name = String(name);
      if (!TOKEN.test(name)) throw new TypeError(`Headers: invalid header name "${name}"`);
      const key = name.toLowerCase();
      const v = String(value).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
      const e = this._m.get(key);
      if (e) e.values.push(v);
      else this._m.set(key, { name, values: [v] });
    }
    set(name: any, value: any) {
      this._m.delete(String(name).toLowerCase());
      this.append(name, value);
    }
    get(name: any) {
      const e = this._m.get(String(name).toLowerCase());
      return e ? e.values.join(', ') : null;
    }
    has(name: any) {
      return this._m.has(String(name).toLowerCase());
    }
    delete(name: any) {
      this._m.delete(String(name).toLowerCase());
    }
    getSetCookie() {
      return [];
    }
    forEach(fn: any, self?: any) {
      for (const [k, v] of this) fn.call(self, v, k, this);
    }
    *entries(): Generator<[string, string]> {
      for (const k of [...this._m.keys()].sort()) yield [k, this._m.get(k)!.values.join(', ')];
    }
    *keys() {
      for (const [k] of this.entries()) yield k;
    }
    *values() {
      for (const [, v] of this.entries()) yield v;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    get [Symbol.toStringTag]() {
      return 'Headers';
    }
  }
  win.Headers = Headers;

  /** shared by Request and Response */
  class Body {
    _body: any = null; // Uint8Array | null
    _src: any = undefined; // unresolved body init (Request only)
    _used = false;
    headers: any;
    get bodyUsed() {
      return this._used;
    }
    get body() {
      if (this._body === null && this._src === undefined) return null;
      const RS = win.ReadableStream;
      if (!RS) return null;
      const self = this;
      return new RS({
        async start(c: any) {
          const bytes = await self._take();
          if (bytes.length) c.enqueue(bytes);
          c.close();
        },
      });
    }
    async _bytes(): Promise<any> {
      if (this._src !== undefined) {
        const { bytes } = await bodyOf(this._src);
        this._body = bytes;
        this._src = undefined;
      }
      return this._body || new win.Uint8Array(0);
    }
    _take(): Promise<any> {
      if (this._used) return Promise.reject(new TypeError('body stream already read'));
      this._used = true;
      return this._bytes();
    }
    arrayBuffer() {
      return this._take().then((b: any) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    }
    bytes() {
      return this._take().then((b: any) => b.slice());
    }
    text() {
      return this._take().then((b: any) => decode(b));
    }
    json() {
      return this.text().then((t: string) => JSON.parse(t));
    }
    blob() {
      return this._take().then((b: any) => new win.Blob([b], { type: this.headers.get('content-type') || '' }));
    }
    formData() {
      return this.text().then((t: string) => {
        const fd = new win.FormData();
        if (!/urlencoded/i.test(this.headers.get('content-type') || '')) throw new TypeError('formData(): only urlencoded bodies are supported');
        for (const [k, v] of new win.URLSearchParams(t)) fd.append(k, v);
        return fd;
      });
    }
  }

  class Request extends Body {
    _ctype: string | null = null;
    url: string;
    method: string;
    credentials: string;
    mode: string;
    cache: string;
    redirect: string;
    referrer: string;
    referrerPolicy: string;
    integrity: string;
    keepalive: boolean;
    signal: any;
    destination = '';
    constructor(input: any, init?: any) {
      super();
      init = init || {};
      const from = input instanceof Request ? input : null;
      this.url = from ? from.url : new win.URL(String(input), doc.baseURI).href;
      this.method = String(init.method || (from ? from.method : 'GET')).toUpperCase();
      if (/^(CONNECT|TRACE|TRACK)$/.test(this.method) || !TOKEN.test(this.method)) throw new TypeError(`'${this.method}' HTTP method is unsupported.`);
      this.headers = new Headers(init.headers || (from ? from.headers : undefined));
      this.credentials = init.credentials || (from ? from.credentials : 'same-origin');
      this.mode = init.mode || (from ? from.mode : 'cors');
      this.cache = init.cache || (from ? from.cache : 'default');
      this.redirect = init.redirect || (from ? from.redirect : 'follow');
      this.referrer = 'about:client';
      this.referrerPolicy = init.referrerPolicy || '';
      this.integrity = init.integrity || '';
      this.keepalive = !!init.keepalive;
      this.signal = init.signal || (from ? from.signal : null) || new win.AbortController().signal;
      let b = init.body;
      if (b === undefined && from) {
        b = from._src !== undefined ? from._src : from._body;
      }
      if (b !== undefined && b !== null) {
        if (this.method === 'GET' || this.method === 'HEAD') throw new TypeError('Request with GET/HEAD method cannot have body.');
        this._src = b;
        if (!this.headers.has('content-type')) {
          const tag = tagOf(b);
          const type = typeof b === 'string' ? 'text/plain;charset=UTF-8' : tag === 'URLSearchParams' ? 'application/x-www-form-urlencoded;charset=UTF-8' : tag === 'Blob' || tag === 'File' ? b.type : '';
          if (type) this.headers.set('content-type', type);
        }
      }
    }
    clone() {
      return new Request(this);
    }
    get [Symbol.toStringTag]() {
      return 'Request';
    }
  }
  win.Request = Request;

  const NULL_BODY: Record<number, 1> = { 101: 1, 204: 1, 205: 1, 304: 1 };
  class Response extends Body {
    status: number;
    statusText: string;
    ok: boolean;
    url = '';
    redirected = false;
    type = 'default';
    constructor(body?: any, init?: any) {
      super();
      init = init || {};
      this.status = init.status === undefined ? 200 : +init.status;
      if (!(this.status >= 200 && this.status <= 599) && !init._internal) throw new RangeError('Response: status must be in the range 200 to 599');
      this.statusText = init.statusText === undefined ? '' : String(init.statusText);
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new Headers(init.headers);
      if (body !== undefined && body !== null) {
        if (NULL_BODY[this.status]) throw new TypeError('Response with null body status cannot have body');
        if (ArrayBuffer.isView(body) && init._internal) this._body = body;
        else {
          this._src = body;
          const tag = tagOf(body);
          const type = typeof body === 'string' ? 'text/plain;charset=UTF-8' : tag === 'URLSearchParams' ? 'application/x-www-form-urlencoded;charset=UTF-8' : tag === 'Blob' || tag === 'File' ? body.type : '';
          if (type && !this.headers.has('content-type')) this.headers.set('content-type', type);
        }
      }
    }
    clone() {
      if (this._used) throw new TypeError('Response.clone: body has already been used');
      const r = new Response(null, { status: this.status, statusText: this.statusText, headers: this.headers, _internal: true });
      r._body = this._body;
      r._src = this._src;
      r.url = this.url;
      r.redirected = this.redirected;
      r.type = this.type;
      return r;
    }
    text() {
      return this._take().then((b: any) => decode(b, charsetOf(this.headers.get('content-type'))));
    }
    static error() {
      const r = new Response(null, { status: 0, _internal: true });
      r.type = 'error';
      return r;
    }
    static redirect(url: any, status = 302) {
      return new Response(null, { status, headers: { location: new win.URL(String(url), doc.baseURI).href } });
    }
    static json(data: any, init?: any) {
      const r = new Response(JSON.stringify(data), init);
      if (!r.headers.has('content-type') || /^text\/plain/.test(r.headers.get('content-type'))) r.headers.set('content-type', 'application/json');
      return r;
    }
    get [Symbol.toStringTag]() {
      return 'Response';
    }
  }
  win.Response = Response;

  const dataUrl = (url: string) => {
    const m = /^data:([^,]*?)(;base64)?,([\s\S]*)$/i.exec(url);
    if (!m) return null;
    const raw = decodeURIComponent(m[3]);
    let bytes: any;
    if (m[2]) {
      const bin = win.atob(raw.replace(/\s+/g, ''));
      bytes = new win.Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else bytes = utf8(raw);
    return { url, status: 200, headers: [['content-type', m[1] || 'text/plain;charset=US-ASCII']], body: bytes, redirected: false };
  };
  const abortReason = (signal: any) => (signal && signal.reason !== undefined ? signal.reason : domErr('The operation was aborted.', 'AbortError'));

  /** one network exchange: cb(err, {url,status,headers,body,redirected}) ; returns a cancel function */
  const exchange = (spec: any, cb: (err: string | null, res?: any) => void): (() => void) => {
    if (/^data:/i.test(spec.url)) {
      let live = true;
      later(() => {
        if (!live) return;
        let d: any = null;
        try {
          d = dataUrl(spec.url);
        } catch {}
        if (d) cb(null, d);
        else cb('malformed data: URL');
      });
      return () => void (live = false);
    }
    if (!/^https?:/i.test(spec.url)) {
      let live = true;
      later(() => live && cb('URL scheme is not supported'));
      return () => void (live = false);
    }
    const rid = host.fetch(spec, cb);
    return () => host.abort(rid);
  };

  win.fetch = function fetch(input: any, init?: any) {
    return new Promise((resolve, reject) => {
      const req = new Request(input, init);
      const signal = req.signal;
      if (signal.aborted) return reject(abortReason(signal));
      let cancel: (() => void) | null = null;
      let done = false;
      const onAbort = () => {
        if (done) return;
        done = true;
        if (cancel) cancel();
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', onAbort);
      req._bytes().then((body: any) => {
        if (done) return;
        if (body.length && !req.headers.has('content-type') && req._ctype) req.headers.set('content-type', req._ctype);
        cancel = exchange({ kind: 'xhr', url: req.url, method: req.method, headers: [...req.headers], body: body.length ? body : null, credentials: req.credentials, mode: req.mode }, (err, r) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', onAbort);
          if (err) return reject(new TypeError('Failed to fetch (' + err + ')'));
          const body = NULL_BODY[r.status] || req.method === 'HEAD' ? null : new win.Uint8Array(r.body);
          const res = new Response(body, { status: r.status, statusText: r.statusText || '', headers: r.headers, _internal: true });
          res.url = r.url;
          res.redirected = !!r.redirected;
          res.type = r.status === 0 ? 'opaque' : new win.URL(r.url).origin === win.location.origin ? 'basic' : 'cors';
          resolve(res);
        });
      }, reject);
    });
  };
  // FormData bodies need their boundary in the content type, which is only known once encoded
  const bytesOf = Request.prototype._bytes;
  Request.prototype._bytes = async function (this: any) {
    if (this._src !== undefined && tagOf(this._src) === 'FormData') {
      const { bytes, type } = await bodyOf(this._src);
      this._body = bytes;
      this._src = undefined;
      this._ctype = type;
      return bytes;
    }
    return bytesOf.call(this);
  };

  // ───────────── XMLHttpRequest ─────────────
  const XHR_EVENTS = ['readystatechange', 'loadstart', 'progress', 'abort', 'error', 'load', 'timeout', 'loadend'];
  class XMLHttpRequestUpload extends win.EventTarget {}
  handlers(XMLHttpRequestUpload.prototype, XHR_EVENTS.slice(1));
  class XMLHttpRequest extends win.EventTarget {
    static UNSENT = 0;
    static OPENED = 1;
    static HEADERS_RECEIVED = 2;
    static LOADING = 3;
    static DONE = 4;
    UNSENT = 0;
    OPENED = 1;
    HEADERS_RECEIVED = 2;
    LOADING = 3;
    DONE = 4;
    readyState = 0;
    status = 0;
    statusText = '';
    responseURL = '';
    timeout = 0;
    withCredentials = false;
    upload: any = new XMLHttpRequestUpload();
    _type = '';
    _method = 'GET';
    _url = '';
    _req: any = new Headers();
    _res: any = null;
    _bytes: any = null;
    _cache: any = undefined;
    _mime: string | null = null;
    _cancel: (() => void) | null = null;
    _timer = 0;
    _sent = false;
    _gen = 0;
    get responseType() {
      return this._type;
    }
    set responseType(v: string) {
      if (this.readyState >= 3) throw domErr('responseType cannot be changed now', 'InvalidStateError');
      if (['', 'text', 'json', 'arraybuffer', 'blob', 'document'].includes(v)) this._type = v;
    }
    open(method: any, url: any, async?: any) {
      method = String(method).toUpperCase();
      if (!TOKEN.test(method)) throw domErr(`'${method}' is not a valid HTTP method.`, 'SyntaxError');
      if (/^(CONNECT|TRACE|TRACK)$/.test(method)) throw domErr(`'${method}' HTTP method is unsupported.`, 'SecurityError');
      if (async === false) {
        stats.syncXhr++;
        throw domErr('Synchronous XMLHttpRequest is not supported in this engine.', 'InvalidAccessError');
      }
      this._abortSilently();
      this._method = method;
      this._url = new win.URL(String(url), doc.baseURI).href;
      this._req = new Headers();
      this._res = null;
      this._bytes = null;
      this._cache = undefined;
      this._sent = false;
      this.status = 0;
      this.statusText = '';
      this.responseURL = '';
      this._state(1);
    }
    setRequestHeader(name: any, value: any) {
      if (this.readyState !== 1 || this._sent) throw domErr('XMLHttpRequest must be OPENED.', 'InvalidStateError');
      this._req.append(name, value);
    }
    overrideMimeType(m: any) {
      this._mime = String(m);
    }
    getResponseHeader(name: any) {
      return this._res ? this._res.get(name) : null;
    }
    getAllResponseHeaders() {
      if (!this._res) return '';
      let s = '';
      for (const [k, v] of this._res) s += k + ': ' + v + '\r\n';
      return s;
    }
    send(body?: any) {
      if (this.readyState !== 1 || this._sent) throw domErr('XMLHttpRequest must be OPENED.', 'InvalidStateError');
      this._sent = true;
      const gen = ++this._gen;
      const noBody = this._method === 'GET' || this._method === 'HEAD';
      const isDoc = body && body.nodeType === 9;
      const start = (bytes: any, type: string | null) => {
        if (gen !== this._gen) return;
        if (bytes && type && !this._req.has('content-type')) this._req.set('content-type', type);
        this._fire('loadstart', 0, 0);
        if (this.timeout > 0)
          this._timer = host.timer('timeout', this.timeout, () => {
            this._timer = 0;
            this._fail('timeout');
          }, false);
        this._cancel = exchange({ kind: 'xhr', url: this._url, method: this._method, headers: [...this._req], body: bytes && bytes.length ? bytes : null, credentials: this.withCredentials ? 'include' : 'same-origin', mode: 'cors' }, (err, r) => {
          if (gen !== this._gen) return;
          this._cancel = null;
          if (err) return this._fail('error');
          this.status = r.status;
          this.statusText = r.statusText || '';
          this.responseURL = r.url;
          this._res = new Headers(r.headers);
          this._bytes = this._method === 'HEAD' ? new win.Uint8Array(0) : new win.Uint8Array(r.body);
          this._state(2);
          if (gen !== this._gen) return;
          this._state(3);
          if (gen !== this._gen) return;
          this._fire('progress', this._bytes.length, this._bytes.length);
          if (gen !== this._gen) return;
          this._finish();
          this._state(4);
          this._fire('load', this._bytes.length, this._bytes.length);
          this._fire('loadend', this._bytes.length, this._bytes.length);
        });
      };
      if (noBody || body === undefined || body === null) start(null, null);
      else if (isDoc) start(utf8(new win.XMLSerializer().serializeToString(body)), 'text/html;charset=UTF-8');
      else bodyOf(body).then((b) => start(b.bytes, b.type), () => this._fail('error'));
    }
    abort() {
      const active = this._sent && this.readyState !== 4;
      this._abortSilently();
      if (active) {
        this._finish();
        this._bytes = null;
        this.status = 0;
        this._state(4);
        this._fire('abort', 0, 0);
        this._fire('loadend', 0, 0);
      }
      this.readyState = 0;
    }
    _abortSilently() {
      this._gen++;
      if (this._cancel) this._cancel();
      this._cancel = null;
      this._finish();
    }
    _finish() {
      if (this._timer) host.cancel(this._timer, 'timeout');
      this._timer = 0;
      this._sent = false;
    }
    _fail(kind: string) {
      if (this._cancel) this._cancel();
      this._cancel = null;
      this._gen++;
      this._finish();
      this._bytes = null;
      this._res = null;
      this.status = 0;
      this.statusText = '';
      this._state(4);
      this._fire(kind, 0, 0);
      this._fire('loadend', 0, 0);
    }
    _state(n: number) {
      this.readyState = n;
      this.dispatchEvent(new win.Event('readystatechange'));
    }
    _fire(type: string, loaded: number, total: number) {
      this.dispatchEvent(new win.ProgressEvent(type, { lengthComputable: total > 0, loaded, total }));
    }
    _ctype() {
      return this._mime || (this._res && this._res.get('content-type')) || '';
    }
    get responseText() {
      if (this._type !== '' && this._type !== 'text') throw domErr("responseText is only available if responseType is '' or 'text'.", 'InvalidStateError');
      if (!this._bytes || this.readyState < 3) return '';
      if (typeof this._cache !== 'string') this._cache = decode(this._bytes, charsetOf(this._ctype()));
      return this._cache;
    }
    get response() {
      const t = this._type;
      if (t === '' || t === 'text') return this.responseText;
      if (this.readyState !== 4 || !this._bytes) return null;
      if (this._cache !== undefined) return this._cache;
      const b = this._bytes;
      if (t === 'json') {
        try {
          this._cache = JSON.parse(decode(b));
        } catch {
          this._cache = null;
        }
      } else if (t === 'arraybuffer') this._cache = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      else if (t === 'blob') this._cache = new win.Blob([b], { type: this._ctype() });
      else this._cache = this.responseXML;
      return this._cache;
    }
    get responseXML() {
      if (this.readyState !== 4 || !this._bytes) return null;
      const type = this._ctype().split(';')[0].trim().toLowerCase();
      const html = type === 'text/html';
      if (!html && !/(^|\/|\+)xml$/.test(type)) return null;
      if (html && this._type !== 'document') return null;
      try {
        return new win.DOMParser().parseFromString(decode(this._bytes, charsetOf(this._ctype())), html ? 'text/html' : 'application/xml');
      } catch {
        return null;
      }
    }
  }
  handlers(XMLHttpRequest.prototype, XHR_EVENTS);
  win.XMLHttpRequest = XMLHttpRequest;
  win.XMLHttpRequestUpload = XMLHttpRequestUpload;

  // ───────────── sockets: there are none ─────────────
  class WebSocket extends win.EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = 0;
    bufferedAmount = 0;
    extensions = '';
    protocol = '';
    binaryType = 'blob';
    url: string;
    constructor(url: any) {
      super();
      this.url = new win.URL(String(url), doc.baseURI).href;
      if (!/^wss?:/i.test(this.url)) throw domErr("The URL's scheme must be either 'ws' or 'wss'.", 'SyntaxError');
      stats.ws++;
      host.note('ws', this.url);
      later(() => {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.dispatchEvent(new win.Event('error'));
        this.dispatchEvent(new win.CloseEvent('close', { code: 1006, reason: '', wasClean: false }));
      });
    }
    send() {
      if (this.readyState === 0) throw domErr('Still in CONNECTING state.', 'InvalidStateError');
    }
    close() {
      this.readyState = 3;
    }
  }
  handlers(WebSocket.prototype, ['open', 'message', 'error', 'close']);
  win.WebSocket = WebSocket;

  // ───────────── elements whose real behaviour needs pixels or media ─────────────
  if (win.HTMLCanvasElement) {
    const CP = win.HTMLCanvasElement.prototype;
    const noop = () => {};
    def(CP, 'getContext', function (this: any, type: any) {
      if (/webgl|gpu/i.test(String(type))) {
        stats.webgl++;
        return null;
      }
      stats.canvas++;
      const canvas = this;
      const base: any = {
        canvas, fillStyle: '#000000', strokeStyle: '#000000', lineWidth: 1, font: '10px sans-serif', globalAlpha: 1, textAlign: 'start', textBaseline: 'alphabetic',
        globalCompositeOperation: 'source-over', lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0, shadowColor: 'rgba(0, 0, 0, 0)', imageSmoothingEnabled: true,
        measureText: (t: any) => ({ width: String(t).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2, actualBoundingBoxLeft: 0, actualBoundingBoxRight: String(t).length * 6, fontBoundingBoxAscent: 8, fontBoundingBoxDescent: 2 }),
        getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new win.Uint8ClampedArray(Math.min(Math.max(w * h * 4, 0), 1 << 24)) }),
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new win.Uint8ClampedArray(Math.min(Math.max(w * h * 4, 0), 1 << 24)) }),
        createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }), createConicGradient: () => ({ addColorStop: noop }),
        createPattern: () => ({ setTransform: noop }), getLineDash: () => [], isPointInPath: () => false, isPointInStroke: () => false,
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), getContextAttributes: () => ({ alpha: true }),
      };
      return new Proxy(base, {
        get(t: any, k: any) {
          if (k in t || typeof k === 'symbol') return t[k];
          return (t[k] = () => {
            stats.draws++;
          });
        },
      });
    });
    def(CP, 'toDataURL', () => 'data:,');
    def(CP, 'toBlob', (cb: any) => later(() => cb(new win.Blob([]))));
  }
  if (win.HTMLMediaElement) {
    const MP = win.HTMLMediaElement.prototype;
    def(MP, 'play', () => Promise.resolve());
    def(MP, 'pause', () => {});
    def(MP, 'load', () => {});
    def(MP, 'canPlayType', () => '');
  }
  if (win.HTMLImageElement) {
    // images are never downloaded; code that waits for them to load must still make progress
    const IP = win.HTMLImageElement.prototype;
    const src = Object.getOwnPropertyDescriptor(IP, 'src');
    if (src && src.set) {
      Object.defineProperty(IP, 'src', {
        configurable: true,
        enumerable: true,
        get: src.get,
        set(this: any, v: any) {
          src.set!.call(this, v);
          later(() => this.dispatchEvent(new win.Event('load')));
        },
      });
    }
    getter(IP, 'complete', () => true);
    getter(IP, 'naturalWidth', function (this: any) {
      return +this.getAttribute('width') || 100;
    });
    getter(IP, 'naturalHeight', function (this: any) {
      return +this.getAttribute('height') || 100;
    });
    def(IP, 'decode', () => Promise.resolve());
  }
  if (win.HTMLDialogElement) {
    const DP = win.HTMLDialogElement.prototype;
    const show = function (this: any) {
      this.setAttribute('open', '');
    };
    def(DP, 'show', show);
    def(DP, 'showModal', show);
    def(DP, 'close', function (this: any, value?: any) {
      if (!this.hasAttribute('open')) return;
      this.removeAttribute('open');
      if (value !== undefined) this.returnValue = String(value);
      this.dispatchEvent(new win.Event('close'));
    });
  }

  // ───────────── navigator and crypto ─────────────
  const nav = win.navigator;
  getter(nav, 'webdriver', () => false);
  def(nav, 'sendBeacon', () => (stats.beacon++, true));
  def(nav, 'vibrate', () => false);
  if (!nav.clipboard) def(nav, 'clipboard', { writeText: () => Promise.resolve(), readText: () => Promise.resolve(''), write: () => Promise.resolve(), read: () => Promise.resolve([]) });
  if (!nav.connection) def(nav, 'connection', { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false, addEventListener() {}, removeEventListener() {} });
  if (!nav.permissions) def(nav, 'permissions', { query: () => Promise.resolve({ state: 'denied', onchange: null, addEventListener() {}, removeEventListener() {} }) });
  if (!nav.storage) def(nav, 'storage', { estimate: () => Promise.resolve({ quota: 5e6, usage: 0 }), persist: () => Promise.resolve(false), persisted: () => Promise.resolve(false) });
  if (nav.deviceMemory === undefined) getter(nav, 'deviceMemory', () => 8);
  if (nav.maxTouchPoints === undefined) getter(nav, 'maxTouchPoints', () => 0);

  if (win.crypto && !win.crypto.subtle) {
    const fix = (v: any): any => {
      const tag = tagOf(v);
      if (tag === 'ArrayBuffer') return new win.Uint8Array(v).slice().buffer;
      if (tag === 'Object' && !('algorithm' in v && 'extractable' in v)) {
        if ('publicKey' in v && 'privateKey' in v) return { publicKey: v.publicKey, privateKey: v.privateKey };
        return JSON.parse(host.json(v));
      }
      return v;
    };
    const subtle: any = {};
    for (const m of ['digest', 'encrypt', 'decrypt', 'sign', 'verify', 'generateKey', 'importKey', 'exportKey', 'deriveKey', 'deriveBits', 'wrapKey', 'unwrapKey'])
      subtle[m] = (...args: any[]) => new Promise((res, rej) => host.subtle(m, args, (err: string | null, v: any) => (err ? rej(domErr(err, 'OperationError')) : res(fix(v)))));
    def(win.crypto, 'subtle', subtle);
  }

  return {
    stats,
    scrolled(y: number) {
      sy = y;
      doc.dispatchEvent(new win.Event('scroll', { bubbles: true }));
      for (const io of [...observers]) io._again();
    },
  };
}
