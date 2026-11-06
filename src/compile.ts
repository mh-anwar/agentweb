// The compiler: an LNode tree (from any engine) -> a Page.
//
// A Page is a flat list of Blocks in reading order. A block is one line of text with inline
// actionables. Everything the agent can read, search, diff or act on is a block, which is what
// makes budgets, "seen" tracking and `find` simple and uniform.
//
// What the compiler decides:
//   - which region a block belongs to (main content vs navigation vs boilerplate vs alerts)
//   - what counts as one line (table rows, list items and repeated "cards" fold into single lines)
//   - which elements are actionable and what they are called
//   - what a sighted user cannot see (dropped, and counted so the agent is told)

import { hash, squash, type Doc, type LNode } from './tree.ts';
import { blockHash, blockText, linkAct, words } from './blocks.ts';
import type { Act, Block, BlockKind, Field, FormDef, Inline, Page, Region, Tier } from './types.ts';

export interface CompileOptions {
  tier: Tier;
  /** block cap (default 6000: pages are stored with the session) */
  maxBlocks?: number;
  status?: number;
  method?: 'GET' | 'POST';
  bytes?: number;
  ms?: number;
}

const BLOCK = new Set(
  ('address article aside blockquote body caption center dd details dialog dir div dl dt fieldset figcaption figure ' +
    'footer form h1 h2 h3 h4 h5 h6 header hgroup hr html legend li main menu nav ol p pre search section summary ' +
    'table tbody td tfoot th thead tr ul optgroup').split(' '),
);
const SKIP = new Set(['head', 'script', 'style', 'template', 'datalist', 'option', 'optgroup', 'colgroup', 'col', 'wbr', 'map', 'area', 'picture', 'source']);
const FOLD_TAGS = new Set(['div', 'article', 'section', 'a', 'li', 'dd']);
const CONTROL = new Set(['input', 'select', 'textarea', 'button']);
const CLICK_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'checkbox', 'radio', 'treeitem', 'textbox', 'combobox', 'searchbox']);
const MOUNT_ID = /^(root|app|__next|__nuxt|__layout|__gatsby|___gatsby|svelte|q-app|react-root|main-app|application|app-root|ember-application|vue-app)$/i;
const ALERT_CLASS = /(?:^|\s)(alert|alert-danger|alert-success|alert-warning|alert-info|error|errors|errorlist|flash|flash-message|notice|toast|snackbar|form-error|invalid-feedback|field-error|message-error|notification|validation-summary-errors|error-message)(?:\s|$)/i;
const COOKIE_HINT = /cookie|consent|gdpr|onetrust|cc-window|cmp-container|privacy-banner/i;
const REGION_HINT: [RegExp, Region][] = [
  [/(?:^|\s)(nav|navbar|navigation|breadcrumbs?|topbar|top-bar|site-nav|main-nav|pagination-nav)(?:\s|$)/i, 'nav'],
  [/(?:^|\s)(footer|site-footer|page-footer|global-footer)(?:\s|$)/i, 'footer'],
  [/(?:^|\s)(sidebar|side-bar|site-sidebar|rightbar|leftbar)(?:\s|$)/i, 'aside'],
  [/(?:^|\s)(masthead|site-header|page-header|global-header)(?:\s|$)/i, 'header'],
];
// Present in the HTML but closed until a script opens it, in practically every CSS framework.
const COLLAPSED_MENU = /(?:^|\s)(dropdown-menu|dropdown-content|vector-dropdown-content|submenu|sub-menu|mega-menu|megamenu|menu-dropdown|nav-dropdown|flyout|popover-content)(?:\s|$)/i;
const COLLAPSED_PANEL = /(?:^|\s)(modal|modal-dialog|offcanvas|collapse|popover|tooltip|drawer|lightbox|overlay-panel)(?:\s|$)/i;
const OPENED = /(?:^|\s)(show|open|opened|active|in|visible|is-open|is-active|is-visible|expanded)(?:\s|$)/i;
const SKIP_LINK = /^(skip|jump) (to|navigation|nav|main|content)/i;
const FOOTNOTE = /^\[?\s*(\d{1,3}|[a-z]|note \d+|citation needed|edit)\s*\]?$/i;
const EMPTY: Record<string, string> = {};
const MAX_BLOCKS = 6000;
export const TRUNCATED = 'very large page: truncated (find() still searches all of it)';
const MAX_LABEL = 110;
const PUNCT_ONLY = /^[\s|·•»«›‹>\-–—*/\\,.:;()\[\]]*$/;

/** Label text without the decoration forms put around it ("Name:", "Email *"). */
function cleanLabel(s: string): string {
  return squash(s).replace(/\s*[:*]+\s*$/, '').trim();
}

export function resolveUrl(href: string, base: string): string | undefined {
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

/** Short human name for an unlabeled link, from its URL. */
function nameFromHref(href: string): string {
  try {
    const u = new URL(href);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    if (!seg) return u.hostname.replace(/^www\./, '');
    return decodeURIComponent(seg).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_+]+/g, ' ').slice(0, 40);
  } catch {
    return 'link';
  }
}

export function compile(doc: Doc, pageUrl: string, o: CompileOptions): Page {
  const meta = doc.meta;
  const maxBlocks = o.maxBlocks ?? MAX_BLOCKS;
  const live = o.tier !== 'wire';
  const base = (meta.base && resolveUrl(meta.base, pageUrl)) || pageUrl;
  const pageNoHash = pageUrl.split('#')[0];

  const blocks: Block[] = [];
  const forms: FormDef[] = [];
  const notes: string[] = [];
  let hiddenChars = 0;
  let hiddenRuns = 0;
  let actCount = 0;

  // ── pre-pass: ids, label[for], main landmark, memoised word counts ──
  const byId = new Map<string, LNode>();
  const labelFor = new Map<string, string>();
  const labelNode = new Map<string, LNode>();
  let hasMain = false;
  let hasCanvas = false;
  const wcMemo = new Map<LNode, number>();
  const interMemo = new Map<LNode, boolean>();

  const wc = (n: LNode): number => {
    if (n.t === '#text') return words(n.x ?? '');
    if (n.h) return 0;
    let v = wcMemo.get(n);
    if (v === undefined) {
      v = 0;
      if (n.c) for (const c of n.c) v += wc(c);
      wcMemo.set(n, v);
    }
    return v;
  };
  const isInteractiveTag = (n: LNode) => n.t === 'a' || CONTROL.has(n.t) || n.t === 'label' || n.t === 'summary';
  const containsInteractive = (n: LNode): boolean => {
    let v = interMemo.get(n);
    if (v === undefined) {
      v = false;
      if (n.c) {
        for (const c of n.c) {
          if (c.t === '#text' || c.h) continue;
          if (isInteractiveTag(c) || c.p || (c.a && (c.a.onclick !== undefined || (c.a.role && CLICK_ROLES.has(c.a.role)))) || containsInteractive(c)) {
            v = true;
            break;
          }
        }
      }
      interMemo.set(n, v);
    }
    return v;
  };
  const plainText = (n: LNode, skipControls = false): string => {
    if (n.t === '#text') return n.x ?? '';
    if (n.h) return '';
    if (skipControls && (n.t === 'select' || n.t === 'textarea' || n.t === 'button' || n.t === 'input')) return '';
    let s = '';
    if (n.c) for (const c of n.c) s += plainText(c, skipControls);
    return BLOCK.has(n.t) ? ' ' + s + ' ' : s;
  };

  (function scan(n: LNode, depth: number) {
    if (n.t === '#text') return;
    const a = n.a;
    if (a) {
      if (a.id && !byId.has(a.id)) byId.set(a.id, n);
      if (n.t === 'label' && a.for && !labelFor.has(a.for)) {
        labelFor.set(a.for, cleanLabel(plainText(n, true)));
        labelNode.set(a.for, n);
      }
      if (a.role === 'main') hasMain = true;
    }
    if (n.t === 'main') hasMain = true;
    if (n.t === 'canvas') hasCanvas = true;
    if (n.c && depth < 600) for (const c of n.c) scan(c, depth + 1);
  })(doc.root, 0);

  // ── walker state ──
  let region: Region = hasMain ? 'other' : 'main';
  let sectionDepth = 0; // inside main/article/section: header/footer there are not page landmarks
  let form = -1;
  let flat = 0;
  let sep = ' ';
  let listDepth = 0;
  let wrapLabel: string | null = null;
  let mute = false;
  let inLabel = 0;
  let labelAlt = '';
  let quote = 0;
  let groupSeq = 0;
  let tableG: { g: number; data: boolean; head: boolean } | null = null;
  const fpSeen = new Map<string, number>();

  let buf: Inline[] = [];
  let bufHas = false;
  let pendingSep = '';

  /** set when an element just closed: the next text starts in a different element */
  let gap = false;
  const pushText = (s: string) => {
    if (mute || !s) return;
    const blank = s.trim() === '';
    if (blank && (!bufHas || pendingSep)) return;
    if (pendingSep) {
      if (bufHas) buf.push(pendingSep);
      pendingSep = '';
    } else if (gap && bufHas) {
      // "GitHub" + "Repository hosting" in sibling elements laid out by CSS: no whitespace in the HTML
      const last = buf[buf.length - 1];
      if (typeof last === 'string' && /[a-z]$/.test(last) && /^[A-Z]/.test(s)) buf.push(' ');
    }
    gap = false;
    buf.push(s);
    if (!blank) bufHas = true;
  };
  const pushAct = (a: Act) => {
    if (pendingSep) {
      if (bufHas) buf.push(pendingSep);
      pendingSep = '';
    }
    buf.push(a);
    bufHas = true;
    actCount++;
  };

  /** Merge adjacent strings, collapse whitespace, trim the ends. */
  const normalize = (items: Inline[], keepWs = false): Inline[] => {
    const out: Inline[] = [];
    let s = '';
    for (const x of items) {
      if (typeof x === 'string') s += x;
      else {
        if (s) {
          out.push(keepWs ? s : s.replace(/\s+/g, ' '));
          s = '';
        } else if (out.length && typeof out[out.length - 1] !== 'string') out.push(' '); // adjacent controls: CSS spaced them
        out.push(x);
      }
    }
    if (s) out.push(keepWs ? s : s.replace(/\s+/g, ' '));
    if (keepWs) return out;
    if (out.length && typeof out[0] === 'string') {
      out[0] = (out[0] as string).trimStart();
      if (!out[0]) out.shift();
    }
    const lastIx = out.length - 1;
    if (lastIx >= 0 && typeof out[lastIx] === 'string') {
      out[lastIx] = (out[lastIx] as string).trimEnd();
      if (!out[lastIx]) out.pop();
    }
    return out;
  };

  const emit = (k: BlockKind, i: Inline[], extra?: Partial<Block>) => {
    if (!i.length || blocks.length >= maxBlocks) return;
    const b: Block = { k, r: region, i, hx: '' };
    if (form >= 0) b.fm = form;
    if (extra) Object.assign(b, extra);
    blocks.push(b);
  };

  const flush = (k: BlockKind = 'p', extra?: Partial<Block>) => {
    if (bufHas) {
      const i = normalize(buf, k === 'pre');
      if (quote && k === 'p') k = 'q';
      emit(k, i, extra);
    }
    buf = [];
    bufHas = false;
    pendingSep = '';
  };

  /** set after a <dt>: the definition that follows joins the term's line */
  let holdOnce = false;
  const boundary = () => {
    if (holdOnce) {
      holdOnce = false;
      return;
    }
    if (flat) {
      if (bufHas) pendingSep = sep;
    } else flush();
  };

  /** Run `fn` collecting inline content into a fresh buffer instead of emitting blocks. */
  const capture = (fn: () => void, innerSep: string): Inline[] => {
    const sBuf = buf, sHas = bufHas, sPend = pendingSep, sSep = sep, sMute = mute;
    buf = [];
    bufHas = false;
    pendingSep = '';
    sep = innerSep;
    mute = false;
    flat++;
    fn();
    flat--;
    const out = bufHas ? normalize(buf) : [];
    buf = sBuf;
    bufHas = sHas;
    pendingSep = sPend;
    sep = sSep;
    mute = sMute;
    return out;
  };

  const inlineToText = (items: Inline[]): string => {
    let s = '';
    for (const x of items) s += typeof x === 'string' ? x : x.l;
    return squash(s);
  };

  const clip = (s: string, max = MAX_LABEL) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);

  /** The name of an interactive element: visible text first, then ARIA, then image alt, then title. */
  const labelOf = (n: LNode, a: Record<string, string>): string => {
    const sAlt = labelAlt;
    labelAlt = '';
    inLabel++;
    const inner = capture(() => walkChildren(n), ' ');
    inLabel--;
    const alt = labelAlt;
    labelAlt = sAlt;
    // acts created while computing a label are not real: undo their count
    for (const x of inner) if (typeof x !== 'string') actCount--;
    let l = inlineToText(inner);
    if (!l && a['aria-labelledby']) {
      l = squash(a['aria-labelledby'].split(/\s+/).map((id) => (byId.has(id) ? plainText(byId.get(id)!) : '')).join(' '));
    }
    if (!l) l = squash(a['aria-label'] ?? '');
    if (!l) l = squash(alt);
    if (!l) l = squash(a.title ?? '');
    if (!l) {
      // a descendant's title/aria-label (icon fonts, sprite divs)
      const d = findDesc(n, (x) => !!x.a && !!(x.a.title || x.a['aria-label']));
      if (d) l = squash(d.a!.title || d.a!['aria-label'] || '');
    }
    return clip(l);
  };

  const findDesc = (n: LNode, pred: (n: LNode) => boolean, depth = 0): LNode | undefined => {
    if (!n.c || depth > 6) return undefined;
    for (const c of n.c) {
      if (c.t === '#text' || c.h) continue;
      if (pred(c)) return c;
      const r = findDesc(c, pred, depth + 1);
      if (r) return r;
    }
    return undefined;
  };

  const hasTag = (n: LNode, tags: Set<string>, depth = 0): boolean => {
    if (!n.c || depth > 40) return false;
    for (const c of n.c) {
      if (c.t === '#text' || c.h) continue;
      if (tags.has(c.t) || hasTag(c, tags, depth + 1)) return true;
    }
    return false;
  };

  const uniq = (fpBase: string): string => {
    const n = fpSeen.get(fpBase) ?? 0;
    fpSeen.set(fpBase, n + 1);
    return n ? fpBase + '.' + n : fpBase;
  };

  const controlLabel = (n: LNode, a: Record<string, string>, fallback: string): string => {
    let l = '';
    if (a['aria-labelledby']) l = squash(a['aria-labelledby'].split(/\s+/).map((id) => (byId.has(id) ? plainText(byId.get(id)!) : '')).join(' '));
    if (!l && a.id && labelFor.has(a.id)) l = labelFor.get(a.id)!;
    if (!l && wrapLabel) l = wrapLabel;
    if (!l) l = squash(a['aria-label'] ?? '');
    if (!l) l = squash(a.placeholder ?? '');
    if (!l) l = squash(a.title ?? '');
    if (!l) l = squash((a.name ?? '').replace(/[_\-\[\]]+/g, ' '));
    return clip(l || fallback, 80);
  };

  const formKeyOf = () => (form >= 0 ? forms[form].key : '');

  const addField = (f: Field): number => {
    if (form < 0) return -1;
    forms[form].fields.push(f);
    return forms[form].fields.length - 1;
  };

  /** Register fields of a hidden subtree: browsers submit them, the agent never sees them. */
  const collectHiddenFields = (n: LNode) => {
    if (n.t === '#text') return;
    const a = n.a ?? EMPTY;
    if (n.t === 'input' && a.name) {
      const type = (a.type ?? 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset' || type === 'file') return;
      const f: Field = { name: a.name, type, value: a.value ?? (type === 'checkbox' || type === 'radio' ? 'on' : '') };
      if (type === 'checkbox' || type === 'radio') f.checked = 'checked' in a;
      if ('disabled' in a) f.disabled = true;
      addField(f);
    } else if (n.t === 'textarea' && a.name) {
      addField({ name: a.name, type: 'textarea', value: plainText(n) });
    } else if (n.t === 'select' && a.name) {
      addField(selectField(n, a));
    } else if (n.c) for (const c of n.c) collectHiddenFields(c);
  };

  const selectField = (n: LNode, a: Record<string, string>): Field => {
    const options: NonNullable<Field['options']> = [];
    const gather = (x: LNode) => {
      if (!x.c) return;
      for (const c of x.c) {
        if (c.t === 'option') {
          const ca = c.a ?? EMPTY;
          const l = squash(plainText(c)) || squash(ca.label ?? '');
          const v = ca.value ?? l;
          const opt: { l: string; v: string; s?: boolean } = { l, v };
          if ('selected' in ca) opt.s = true;
          options.push(opt);
        } else if (c.t !== '#text') gather(c);
      }
    };
    gather(n);
    const multiple = 'multiple' in a;
    if (n.v !== undefined) for (const op of options) op.s = op.v === n.v ? true : undefined;
    if (!multiple && options.length && !options.some((x) => x.s)) options[0].s = true;
    const sel = options.find((x) => x.s);
    const f: Field = { name: a.name ?? '', type: 'select', value: sel ? sel.v : '', options };
    if (multiple) f.multiple = true;
    if ('disabled' in a) f.disabled = true;
    return f;
  };

  // ── element handlers ──

  const doLink = (n: LNode, a: Record<string, string>) => {
    const raw = (a.href ?? '').trim();
    const scripted = !raw || raw === '#' || /^javascript:/i.test(raw);
    if (scripted) {
      if (a.onclick !== undefined || a.role === 'button' || n.p || live) {
        const l = labelOf(n, a);
        if (l) return void pushAct(mkClick(n, a, l, 'click'));
      }
      return walkChildren(n);
    }
    if (raw.startsWith('#')) {
      // same-page anchor: text only, and not even that for skip links and footnote markers
      const t = squash(plainText(n));
      if (SKIP_LINK.test(t) || FOOTNOTE.test(t)) return;
      return walkChildren(n);
    }
    if (/^(mailto|tel|sms):/i.test(raw)) {
      walkChildren(n);
      const addr = raw.replace(/^\w+:/, '').split('?')[0];
      if (addr && !mute && !inlineToText(buf).includes(addr)) pushText(' <' + addr + '>');
      return;
    }
    const href = resolveUrl(raw, base);
    if (!href || !/^https?:/i.test(href)) return walkChildren(n);
    if (href.split('#')[0] === pageNoHash && href.includes('#')) return walkChildren(n);
    let l = labelOf(n, a);
    if (!l) l = nameFromHref(href);
    const act = linkAct(l, href);
    if (n.n !== undefined) act.n = n.n;
    if (a['aria-current'] && a['aria-current'] !== 'false') act.on = true;
    pushAct(act);
  };

  const mkClick = (n: LNode, a: Record<string, string>, l: string, k: Act['k']): Act => {
    const act: Act = { f: uniq('J' + hash(k + '\n' + l + '\n' + region + '\n' + formKeyOf())), k, l, js: true };
    if (n.n !== undefined) act.n = n.n;
    if (a['aria-disabled'] === 'true' || 'disabled' in a) act.dis = true;
    if (a['aria-selected'] === 'true' || a['aria-pressed'] === 'true' || a['aria-checked'] === 'true' || a['aria-expanded'] === 'true') act.on = true;
    return act;
  };

  const doButton = (n: LNode, a: Record<string, string>, isInput: boolean) => {
    const type = (a.type ?? (isInput ? 'text' : 'submit')).toLowerCase();
    if (type === 'reset') return;
    let l = isInput ? squash(a.value ?? '') || squash(a.alt ?? '') || squash(a['aria-label'] ?? '') || squash(a.title ?? '') : labelOf(n, a);
    if (!l) l = isInput ? (type === 'submit' ? 'Submit' : '') : squash(a.value ?? '') || squash((a.name ?? '').replace(/[_\-]+/g, ' '));
    const submits = type === 'submit' || type === 'image';
    if (!l) {
      // an icon-only button with no accessible name: useless without scripting, guessable with it
      if (!live && !(submits && form >= 0)) return;
      const hint = submits && form >= 0 ? '' : iconHint(n, a);
      l = submits && form >= 0 ? 'Submit' : hint ? hint + ' (icon)' : 'unlabeled button';
    }
    l = clip(l, 80);
    if (submits && form >= 0 && !forms[form].js) {
      const fi = addField({ name: a.name ?? '', type: 'submit', value: a.value ?? '', label: l });
      const act: Act = { f: 'S' + hash(formKeyOf() + '\n' + (a.name ?? '') + '\n' + (a.value ?? '') + '\n' + l), k: 'button', l, form, fi };
      act.f = uniq(act.f);
      if (a.formaction) act.href = resolveUrl(a.formaction, base);
      if (a.formmethod) act.type = a.formmethod.toUpperCase();
      if (n.n !== undefined) act.n = n.n;
      if ('disabled' in a) act.dis = true;
      return void pushAct(act);
    }
    pushAct(mkClick(n, a, l, 'button'));
  };

  const doInput = (n: LNode, a: Record<string, string>) => {
    const type = (a.type ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return doButton(n, a, true);
    if (type === 'hidden') return;
    const name = a.name ?? '';
    if (type === 'checkbox' || type === 'radio') {
      const on = n.k !== undefined ? n.k === 1 : 'checked' in a;
      const value = a.value ?? 'on';
      let l = controlLabel(n, a, type);
      if (type === 'radio' && name && l === squash(name.replace(/[_\-\[\]]+/g, ' '))) l = clip(l + ' ' + value, 80);
      const fi = addField({ name, type, value, checked: on, label: l, disabled: 'disabled' in a || undefined });
      const act: Act = { f: uniq('F' + hash(formKeyOf() + '\n' + name + '\n' + type + '\n' + value + '\n' + l)), k: type === 'radio' ? 'radio' : 'check', l };
      if (on) act.on = true;
      wire(act, n, a, fi);
      return void pushAct(act);
    }
    if (type === 'file') {
      const l = controlLabel(n, a, 'file');
      const act: Act = { f: uniq('F' + hash(formKeyOf() + '\n' + name + '\nfile')), k: 'file', l, js: true };
      if (n.n !== undefined) act.n = n.n;
      return void pushAct(act);
    }
    const value = n.v ?? a.value ?? '';
    const l = controlLabel(n, a, type === 'text' ? 'input' : type);
    const fi = addField({ name, type, value, label: l, disabled: 'disabled' in a || undefined });
    const act: Act = { f: uniq('F' + hash(formKeyOf() + '\n' + name + '\n' + type + '\n' + l)), k: 'input', l };
    if (type !== 'text') act.type = type;
    if (value) act.val = type === 'password' ? '••••' : clip(value, 60);
    wire(act, n, a, fi);
    pushAct(act);
  };

  /** Attach form linkage (wire tier) or the live node id, and decide whether the control needs scripting. */
  const wire = (act: Act, n: LNode, a: Record<string, string>, fi: number) => {
    if (n.n !== undefined) act.n = n.n;
    if ('disabled' in a) act.dis = true;
    if (form >= 0 && fi >= 0 && !forms[form].js) {
      act.form = form;
      act.fi = fi;
    } else act.js = true;
  };

  const doSelect = (n: LNode, a: Record<string, string>) => {
    const f = selectField(n, a);
    const l = controlLabel(n, a, 'select');
    f.label = l;
    const fi = addField(f);
    const act: Act = { f: uniq('F' + hash(formKeyOf() + '\n' + (a.name ?? '') + '\nselect\n' + l)), k: 'select', l };
    const opts = f.options ?? [];
    const sel = opts.filter((x) => x.s).map((x) => x.l);
    if (sel.length) act.val = clip(sel.join(', '), 60);
    act.opts = opts.slice(0, 14).map((x) => clip(x.l, 30));
    if (opts.length > 14) act.opts.push('…+' + (opts.length - 14));
    wire(act, n, a, fi);
    pushAct(act);
  };

  const doTextarea = (n: LNode, a: Record<string, string>) => {
    const value = n.v ?? plainText(n);
    const l = controlLabel(n, a, 'textarea');
    const fi = addField({ name: a.name ?? '', type: 'textarea', value, label: l, disabled: 'disabled' in a || undefined });
    const act: Act = { f: uniq('F' + hash(formKeyOf() + '\n' + (a.name ?? '') + '\ntextarea\n' + l)), k: 'textarea', l };
    if (value.trim()) act.val = clip(squash(value), 60);
    wire(act, n, a, fi);
    pushAct(act);
  };

  const containsControl = (n: LNode, depth = 0): boolean => {
    if (!n.c || depth > 8) return false;
    for (const c of n.c) {
      if (c.t === '#text') continue;
      if (c.t === 'input' ? (c.a?.type ?? '').toLowerCase() !== 'hidden' : c.t === 'select' || c.t === 'textarea') return true;
      if (containsControl(c, depth + 1)) return true;
    }
    return false;
  };

  const doLabel = (n: LNode, a: Record<string, string>) => {
    if (containsControl(n)) {
      const sL = wrapLabel, sM = mute;
      wrapLabel = clip(cleanLabel(plainText(n, true)), 80) || null;
      mute = true;
      walkChildren(n);
      wrapLabel = sL;
      mute = sM;
      return;
    }
    // its text is the control's label (only the first label naming a control: real pages reuse ids by mistake)
    if (a.for && labelNode.get(a.for) === n && byId.has(a.for) && CONTROL.has(byId.get(a.for)!.t)) return;
    walkChildren(n);
  };

  const doList = (n: LNode, a: Record<string, string>) => {
    boundary();
    if (flat) return walkChildren(n);
    const g = ++groupSeq;
    const ordered = n.t === 'ol';
    let ord = ordered ? Number(a.start) || 1 : 0;
    const start = blocks.length;
    listDepth++;
    if (n.c) {
      for (const c of n.c) {
        if (c.t === 'li' && !c.h) doItem(c, g, ordered ? ord++ : undefined);
        else walk(c);
      }
    }
    flush();
    listDepth--;
    if (listDepth === 0 && (region === 'main' || region === 'other') && menuTree(start)) {
      for (let i = start; i < blocks.length; i++) blocks[i].r = 'nav';
    }
    compactList(start, g);
  };

  /** A nested list in which every item is just a link is a site menu, wherever it sits in the markup. */
  const menuTree = (start: number): boolean => {
    if (blocks.length - start < 8) return false;
    let deep = false;
    for (let i = start; i < blocks.length; i++) {
      const b = blocks[i];
      if ((b.lv ?? 1) >= 2) deep = true;
      let acts = 0;
      let w = 0;
      for (const x of b.i) {
        if (typeof x === 'string') w += PUNCT_ONLY.test(x) ? 0 : words(x);
        else acts++;
      }
      if (acts < 1 || w > 1) return false;
    }
    return deep;
  };

  const NESTED = new Set(['ul', 'ol', 'table', 'pre', 'dl']);

  const doItem = (n: LNode, g: number, ord: number | undefined) => {
    flush();
    const extra: Partial<Block> = { g, lv: listDepth };
    if (ord !== undefined) extra.ord = ord;
    if (wc(n) <= 70 && !hasTag(n, NESTED)) {
      const i = capture(() => walkChildren(n), ' | ');
      if (i.length) emit('li', i, extra);
      return;
    }
    const at = blocks.length;
    walkChildren(n);
    flush();
    const first = blocks[at];
    if (first && first.k === 'p' && first.lv === undefined) Object.assign(first, { k: 'li' as BlockKind }, extra);
  };

  /** A list whose items are all tiny (menus, tag clouds, pagers) becomes a few dense lines. */
  const compactList = (start: number, g: number) => {
    const items = blocks.slice(start);
    if (items.length < 2) return;
    let withAct = 0;
    for (const b of items) {
      if (b.k !== 'li' || b.g !== g || b.ord !== undefined) return;
      let w = 0;
      let acts = 0;
      for (const x of b.i) {
        if (typeof x === 'string') w += words(x);
        else {
          acts++;
          w += words(x.l);
        }
      }
      if (w > 5 || acts > 2) return;
      if (acts) withAct++;
    }
    if (withAct < items.length * 0.6 && items.length > 8) return;
    blocks.length = start;
    const PER = 12;
    for (let i = 0; i < items.length; i += PER) {
      const line: Inline[] = [];
      for (const b of items.slice(i, i + PER)) {
        if (line.length) line.push(b.i.length === 1 && typeof b.i[0] !== 'string' && typeof line[line.length - 1] !== 'string' ? ' ' : ' · ');
        line.push(...b.i);
      }
      const merged: Block = { k: 'p', r: items[0].r, i: normalize(line), hx: '' };
      if (items[0].fm !== undefined) merged.fm = items[0].fm;
      blocks.push(merged);
    }
  };

  const TR = new Set(['tr', 'table']);

  const doTable = (n: LNode) => {
    boundary();
    if (flat) return walkChildren(n);
    const saved = tableG;
    tableG = { g: ++groupSeq, data: hasTag(n, new Set(['th'])), head: false };
    walkChildren(n);
    flush();
    tableG = saved;
  };

  const doRow = (n: LNode) => {
    if (flat || !tableG) {
      boundary();
      walkChildren(n);
      boundary();
      return;
    }
    flush();
    if (hasTag(n, TR) || (!tableG.data && wc(n) > 160)) return walkChildren(n); // layout row
    const t = tableG;
    const line: Inline[] = [];
    let any = false;
    let allTh = true;
    let cells = 0;
    if (n.c) {
      for (const c of n.c) {
        if (c.t !== 'td' && c.t !== 'th') continue;
        if (c.h) {
          collectHiddenFields(c);
          continue;
        }
        if (c.t === 'td') allTh = false;
        const ci = capture(() => walkChildren(c), ' ');
        if (!ci.length && !t.data) continue;
        if (cells++) line.push(' | ');
        line.push(...ci);
        if (ci.length) any = true;
      }
    }
    if (!any) return;
    while (line.length && typeof line[line.length - 1] === 'string' && /^[\s|]*$/.test(line[line.length - 1] as string)) line.pop();
    const extra: Partial<Block> = { g: t.g };
    if (cells > 0 && (allTh || t.head)) extra.hd = true;
    emit('row', normalize(line), extra);
  };

  const doForm = (n: LNode, a: Record<string, string>) => {
    boundary();
    const rawAction = (a.action ?? '').trim();
    const method: 'GET' | 'POST' = (a.method ?? 'get').toLowerCase() === 'post' ? 'POST' : 'GET';
    const js = /^javascript:/i.test(rawAction) || rawAction === '#' || (a.method ?? '').toLowerCase() === 'dialog';
    const action = (rawAction && !js ? resolveUrl(rawAction, base) : undefined) ?? pageNoHash;
    let path = action;
    try {
      path = new URL(action).pathname;
    } catch {}
    // identity = what the form submits, not where it sits: the 2nd "Add to cart" form on two
    // listings are different products (hidden fields carry the id); per-request tokens are ignored
    const hidden: string[] = [];
    (function scan(x: LNode) {
      if (x.t === 'input' && (x.a?.type ?? '').toLowerCase() === 'hidden' && x.a?.name && !VOLATILE_FIELD.test(x.a.name)) hidden.push(x.a.name + '=' + (x.a.value ?? ''));
      if (x.c && x.t !== 'form') for (const c of x.c) scan(c);
    })({ ...n, t: 'div' });
    const keyBase = method + ' ' + path + (hidden.length ? ' ' + hash(hidden.sort().join('&')) : '');
    const ordinal = forms.filter((f) => f.key.startsWith(keyBase + '#')).length;
    const def: FormDef = { key: keyBase + '#' + ordinal, action, method, enctype: (a.enctype ?? 'application/x-www-form-urlencoded').toLowerCase(), fields: [] };
    if (js) def.js = true;
    if (flat) {
      // a form inside a folded record still needs its model so its button can submit
      forms.push(def);
      const s = form;
      form = forms.length - 1;
      walkChildren(n);
      form = s;
      boundary();
      return;
    }
    forms.push(def);
    const sForm = form;
    form = forms.length - 1;
    walkChildren(n);
    flush();
    form = sForm;
  };

  const doPre = (n: LNode) => {
    boundary();
    let t = plainTextRaw(n).replace(/\r/g, '').replace(/^\n+|\s+$/g, '');
    if (!t) return;
    if (flat) return pushText(squash(t));
    if (t.length > 8000) t = t.slice(0, 8000) + `\n… (${t.length - 8000} more characters)`;
    emit('pre', [t]);
  };
  const plainTextRaw = (n: LNode): string => {
    if (n.t === '#text') return n.x ?? '';
    if (n.h) return '';
    if (n.t === 'br') return '\n';
    let s = '';
    if (n.c) for (const c of n.c) s += plainTextRaw(c);
    return s;
  };

  /** Three or more sibling elements with the same shape and little text each are records: one line each. */
  const foldPlan = (n: LNode): Set<LNode> | null => {
    const kids = n.c;
    if (!kids || kids.length < 3) return null;
    const counts = new Map<string, number>();
    let els = 0;
    for (const c of kids) {
      if (c.t === '#text') {
        // loose text between the children means this is prose with inline links, not a set of records
        if ((c.x ?? '').trim().length > 1) return null;
        continue;
      }
      if (c.h) continue;
      els++;
      if (!FOLD_TAGS.has(c.t)) continue;
      const cls = c.a?.class ? c.a.class.trim().split(/\s+/)[0] : '';
      const s = c.t + '.' + cls;
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    if (els < 3) return null;
    let best = '';
    let bestN = 0;
    for (const [s, k] of counts) if (k > bestN) [best, bestN] = [s, k];
    if (bestN < 3 || bestN < els * 0.6) return null;
    const out = new Set<LNode>();
    let wordy = 0;
    let slight = 0;
    for (const c of kids) {
      if (c.t === '#text' || c.h || !FOLD_TAGS.has(c.t)) continue;
      const cls = c.a?.class ? c.a.class.trim().split(/\s+/)[0] : '';
      if (c.t + '.' + cls !== best) continue;
      const w = wc(c);
      if (w > 90 || hasTag(c, NESTED)) return null;
      if (c.t === 'a' && !isBlockish(c)) return null; // plain inline links are a menu, not cards
      if (w > 0) wordy++;
      if (w <= 4) slight++;
      out.add(c);
    }
    // children of a few words each are a menu or a tag list: let them flow and merge instead
    if (slight >= out.size * 0.8) return null;
    return wordy >= 3 ? out : null;
  };

  function walkChildren(n: LNode) {
    const kids = n.c;
    if (!kids) return;
    if (!flat && !inLabel && BLOCK.has(n.t) && n.t !== 'ul' && n.t !== 'ol' && n.t !== 'tr' && n.t !== 'tbody' && n.t !== 'table') {
      const plan = foldPlan(n);
      if (plan) {
        const g = ++groupSeq;
        for (const c of kids) {
          if (plan.has(c)) {
            flush();
            const sRegion = region;
            const cr = c.a ? hintRegion(c, c.a) : undefined;
            if (cr) region = cr;
            const i = capture(() => (c.t === 'a' ? walk(c) : walkChildren(c)), ' | ');
            if (i.length) emit('row', i, { g });
            region = sRegion;
          } else walk(c);
        }
        return;
      }
    }
    for (const c of kids) walk(c);
  }

  const hintRegion = (n: LNode, a: Record<string, string>): Region | undefined => {
    const idc = (a.id ?? '') + ' ' + (a.class ?? '');
    if (idc.length < 2) return undefined;
    if (COOKIE_HINT.test(idc) && wc(n) < 260 && wc(n) > 3) return 'cookie';
    if (!live && a.class && !OPENED.test(a.class)) {
      if (COLLAPSED_MENU.test(a.class)) return 'nav';
      if (COLLAPSED_PANEL.test(a.class) && n.t !== 'body') return 'aside';
    }
    if (!live && (n.t === 'ul' || n.t === 'div') && n.c && n.c.length > 6 && languageList(n)) return 'footer';
    if (a.class && ALERT_CLASS.test(a.class) && wc(n) <= 80 && wc(n) > 0) return 'dialog';
    if (n.t === 'div' || n.t === 'section' || n.t === 'ul' || n.t === 'td' || n.t === 'table' || n.t === 'span') {
      for (const [re, r] of REGION_HINT) if (re.test(idc)) return r;
    }
    return undefined;
  };

  /** A list of links to translations of this page. */
  const languageList = (n: LNode): boolean => {
    let hits = 0;
    let seen = 0;
    const scan = (x: LNode, depth: number) => {
      if (seen > 40 || depth > 3 || !x.c) return;
      for (const c of x.c) {
        if (c.t === 'a') {
          seen++;
          if (c.a?.hreflang) hits++;
        } else if (c.t !== '#text') scan(c, depth + 1);
      }
    };
    scan(n, 0);
    return hits >= 5 && hits >= seen * 0.7;
  };

  const landmark = (n: LNode, a: Record<string, string>): Region | undefined => {
    const tag = n.t;
    const role = a.role;
    if (tag === 'nav' || role === 'navigation') return 'nav';
    if (tag === 'aside' || role === 'complementary') return 'aside';
    if (tag === 'main' || role === 'main') return 'main';
    if (role === 'dialog' || role === 'alertdialog' || role === 'alert' || role === 'status') return wc(n) ? 'dialog' : undefined;
    if (tag === 'dialog') return 'dialog';
    if ((tag === 'header' || role === 'banner') && sectionDepth === 0) return 'header';
    if ((tag === 'footer' || role === 'contentinfo') && sectionDepth === 0) return 'footer';
    return hintRegion(n, a);
  };

  function walk(n: LNode) {
    if (n.t === '#text') {
      const inElement = gap;
      pushText((n.x ?? '').replace(/\s+/g, ' '));
      if (!inElement) gap = false;
      return;
    }
    walkEl(n);
    gap = true;
  }

  function walkEl(n: LNode) {
    if (n.h) {
      const w = wc0(n);
      if (w) {
        hiddenChars += w;
        if (w >= 12) hiddenRuns++;
      }
      if (form >= 0 && !live) collectHiddenFields(n);
      return;
    }
    const tag = n.t;
    if (SKIP.has(tag)) return;
    const a = n.a ?? EMPTY;
    if (n.sr && !inLabel) return; // screen-reader-only text is a label, never content
    if (tag === 'dialog' && !live && !('open' in a)) return;

    // landmarks and region hints
    if (!flat && !inLabel) {
      const r = landmark(n, a);
      if (r && r !== region && region !== 'dialog' && region !== 'cookie') {
        flush();
        const sRegion = region;
        const sDepth = sectionDepth;
        region = r;
        if (r === 'main') sectionDepth++;
        handle(n, tag, a);
        flush();
        region = sRegion;
        sectionDepth = sDepth;
        return;
      }
    }
    handle(n, tag, a);
  }

  /** Text length of a hidden subtree (the live extractor replaces it with a whitespace marker). */
  const wc0 = (n: LNode): number => {
    if (n.t === '#text') return (n.x ?? '').length;
    let s = 0;
    if (n.c) for (const c of n.c) s += c.t === '#text' ? (c.x ?? '').trim().length || (c.x ?? '').length : wc0(c);
    return s;
  };

  function handle(n: LNode, tag: string, a: Record<string, string>) {
    switch (tag) {
      case 'a':
        return doLink(n, a);
      case 'button':
        return doButton(n, a, false);
      case 'input':
        return doInput(n, a);
      case 'select':
        return doSelect(n, a);
      case 'textarea':
        return doTextarea(n, a);
      case 'label':
        return doLabel(n, a);
      case 'img': {
        const alt = squash(a.alt ?? '');
        if (inLabel) {
          if (!labelAlt) labelAlt = alt;
          return;
        }
        if (alt.length >= 4 && !flat) pushText(' (image: ' + clip(alt, 100) + ') ');
        return;
      }
      case 'svg': {
        if (inLabel && !labelAlt && n.c) labelAlt = squash(plainText(n));
        return;
      }
      case 'br':
        return pushText(' ');
      case 'hr':
        return boundary();
      case 'ul':
      case 'ol':
      case 'menu':
        return doList(n, a);
      case 'li':
        // an <li> outside a list
        boundary();
        walkChildren(n);
        return boundary();
      case 'table':
        return doTable(n);
      case 'thead': {
        if (tableG) tableG.head = true;
        walkChildren(n);
        if (tableG) tableG.head = false;
        return;
      }
      case 'tr':
        return doRow(n);
      case 'form':
        return doForm(n, a);
      case 'pre':
        return doPre(n);
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        boundary();
        walkChildren(n);
        if (flat) boundary();
        else flush('h', { lv: tag.charCodeAt(1) - 48 });
        return;
      }
      case 'blockquote': {
        boundary();
        quote++;
        walkChildren(n);
        boundary();
        quote--;
        return;
      }
      case 'dt': {
        holdOnce = false;
        boundary();
        walkChildren(n);
        if (bufHas) {
          if (!/[:\uff1a]\s*$/.test(inlineToText(buf))) pushText(': ');
          else pushText(' ');
          holdOnce = true;
        }
        return;
      }
      case 'dd': {
        walkChildren(n);
        holdOnce = false;
        return boundary();
      }
      case 'article':
      case 'section': {
        boundary();
        sectionDepth++;
        walkChildren(n);
        sectionDepth--;
        return boundary();
      }
      case 'iframe':
      case 'frame': {
        if (n.c && n.c.length) {
          boundary();
          walkChildren(n);
          return boundary();
        }
        const src = a.src ? resolveUrl(a.src, base) : undefined;
        if (src && /^https?:/.test(src) && (a.title || sameSite(src, pageUrl))) {
          boundary();
          pushAct(linkAct('frame: ' + clip(squash(a.title ?? '') || nameFromHref(src), 60), src));
          boundary();
        }
        return;
      }
      case 'canvas':
      case 'video':
      case 'audio':
        return;
      case 'summary': {
        boundary();
        walkChildren(n);
        return boundary();
      }
      case 'noscript':
        if (live) return;
        return walkChildren(n);
    }

    // non-native clickables
    const role = a.role;
    if ((role && CLICK_ROLES.has(role)) || a.onclick !== undefined || n.p || a.contenteditable === 'true' || a.contenteditable === '') {
      if (role === 'textbox' || role === 'searchbox' || a.contenteditable === 'true' || a.contenteditable === '') {
        if (!containsInteractive(n)) {
          const l = controlLabel(n, a, 'text');
          const act: Act = { f: uniq('J' + hash('textarea\n' + l + '\n' + region)), k: 'textarea', l, js: true };
          const v = squash(plainText(n));
          if (v) act.val = clip(v, 60);
          if (n.n !== undefined) act.n = n.n;
          return void pushAct(act);
        }
      } else if (!containsInteractive(n) && wc(n) <= 40) {
        const l = labelOf(n, a);
        if (l) {
          const k: Act['k'] = role === 'checkbox' || role === 'switch' || role === 'menuitemcheckbox' ? 'check' : role === 'radio' || role === 'menuitemradio' ? 'radio' : role === 'button' ? 'button' : 'click';
          if (BLOCK.has(tag)) boundary();
          pushAct(mkClick(n, a, l, k));
          if (BLOCK.has(tag)) boundary();
          return;
        }
      }
    }

    if (BLOCK.has(tag) || (tag.includes('-') && isBlockish(n))) {
      boundary();
      walkChildren(n);
      boundary();
      return;
    }
    walkChildren(n);
  }

  const isBlockish = (n: LNode): boolean => {
    if (!n.c) return false;
    let els = 0;
    for (const c of n.c) {
      if (c.t === '#text') continue;
      els++;
      if (BLOCK.has(c.t)) return true;
    }
    return els >= 3;
  };

  walk(doc.root);
  flush();

  // ── post-processing ──
  const out = postProcess(blocks);
  let wordCount = 0;
  for (const b of out) {
    b.hx = blockHash(b);
    if (b.r === 'main' || b.r === 'other' || b.r === 'dialog') wordCount += words(blockText(b));
  }

  if (hiddenRuns) notes.push(`${hiddenRuns} hidden text ${hiddenRuns === 1 ? 'block' : 'blocks'} not shown`);
  if (hasCanvas) notes.push('page draws on a canvas: its content is not in the text view');
  if (blocks.length >= maxBlocks) notes.push(TRUNCATED);
  for (const f of forms) {
    try {
      if (new URL(f.action).origin !== new URL(pageUrl).origin && f.method === 'POST') {
        notes.push(`a form here posts to another site: ${new URL(f.action).origin}`);
        break;
      }
    } catch {}
  }

  const page: Page = {
    url: pageUrl,
    status: o.status ?? 200,
    title: squash(meta.title),
    tier: o.tier,
    kind: 'html',
    method: o.method ?? 'GET',
    blocks: out,
    forms,
    notes,
    stats: { bytes: o.bytes ?? 0, ms: o.ms ?? 0, hidden: hiddenChars, scripts: meta.scripts, words: wordCount, acts: actCount },
  };
  if (meta.description || meta.lang || meta.links.length) page.meta = { description: meta.description, lang: meta.lang, links: meta.links };
  if (!live) page.shell = looksLikeShell(doc, wordCount, actCount) || asksForScripts(out, meta.scripts, wordCount);
  return page;
}

function sameSite(a: string, b: string): boolean {
  try {
    return new URL(a).host === new URL(b).host;
  } catch {
    return false;
  }
}

const ASKS_FOR_JS = /\b(?:please |you (?:need|must|have) to )?(?:enable|activate|turn on|allow) javascript\b|\bjavascript (?:is |must be )?(?:required|disabled|turned off|not enabled)\b|\brequires javascript\b/i;

/** A short page whose visible content tells the reader to enable JavaScript (search pages, widgets). */
function asksForScripts(blocks: Block[], scripts: number, wordCount: number): boolean {
  if (!scripts || wordCount >= 300) return false;
  return blocks.some((b) => (b.r === 'main' || b.r === 'other' || b.r === 'dialog') && ASKS_FOR_JS.test(blockText(b)));
}

const GENERIC_CLASS = /^(?:btn|button|icon|icons?-?btn|btn-?icon|icon-?button|small|sm|lg|xs|primary|secondary|tertiary|ghost|outline|flat|round(?:ed)?|circle|active|inline|block|flex|grid|d-\w+|p[xy]?-\d|m[xy]?-\d|text-\w+|bg-\w+|svg|fa|fas|far|fab|material-icons|js-.*|is-.*|has-.*|[a-z]{1,2}\d*|.*[A-Z0-9]{4,}.*)$/;

/** A name for an icon-only control from what its markup says: <title>, sprite id, data-icon, meaningful classes. */
export function iconHint(n: LNode, a: Record<string, string>): string {
  const pick: string[] = [];
  const fromClasses = (c: string | undefined) => {
    for (const t of (c ?? '').split(/\s+/)) {
      const w = t.replace(/^(?:fa|icon|ico|bi|mdi|glyphicon|ti|ri|lucide|feather)-/, '').replace(/[-_]+/g, ' ').trim();
      if (w && !(/\d/.test(t) && t.length > 4) && !GENERIC_CLASS.test(t) && !GENERIC_CLASS.test(w) && w.length <= 24 && !pick.includes(w)) pick.push(w);
    }
  };
  for (const k of ['data-icon', 'data-action', 'data-testid', 'data-test', 'name', 'id']) {
    const v = a[k];
    if (v && v.length <= 32 && !/\d{3,}/.test(v)) pick.push(v.replace(/[-_]+/g, ' '));
  }
  (function scan(x: LNode, depth: number) {
    if (depth > 4 || pick.length > 2) return;
    if (x.t === 'title' && x.c) pick.unshift(x.c.map((c) => c.x ?? '').join('').trim());
    const href = x.a?.href ?? x.a?.['xlink:href'];
    if (x.t === 'use' && href?.includes('#')) pick.unshift(href.split('#').pop()!.replace(/^(?:icon|i)[-_]/, '').replace(/[-_]+/g, ' '));
    if (x.t === 'i' || x.t === 'span' || x.t === 'svg') fromClasses(x.a?.class);
    if (x.c) for (const c of x.c) scan(c, depth + 1);
  })(n, 0);
  fromClasses(a.class);
  return squash(pick.filter(Boolean).slice(0, 2).join(' ')).slice(0, 40);
}

const VOLATILE_FIELD = /csrf|xsrf|token|nonce|authenticity|session|timestamp|^_|captcha|state$/i;

function looksLikeShell(doc: Doc, wordCount: number, actCount: number): boolean {
  const meta = doc.meta;
  if (!meta.scripts) return false;
  if (wordCount >= 120) return false;
  if (/enable javascript|requires javascript|javascript is (?:required|disabled|not enabled)|turn on javascript|need to enable js|without javascript/i.test(meta.noscript) && wordCount < 80) return true;
  // an empty framework mount point
  let mount = false;
  (function scan(n: LNode, depth: number) {
    if (mount || n.t === '#text' || depth > 8) return;
    if (n.a?.id && MOUNT_ID.test(n.a.id)) {
      let w = 0;
      (function count(x: LNode) {
        if (x.t === '#text') w += words(x.x ?? '');
        else if (!x.h && x.c) for (const c of x.c) count(c);
      })(n);
      if (w < 8) mount = true;
      return;
    }
    if (n.c) for (const c of n.c) scan(c, depth + 1);
  })(doc.root, 0);
  if (mount) return true;
  return wordCount < 25 && actCount < 8;
}

function postProcess(blocks: Block[]): Block[] {
  const out: Block[] = [];
  const tiny = (b: Block): boolean => {
    if (b.k !== 'p' || b.g !== undefined) return false;
    let w = 0;
    let acts = 0;
    for (const x of b.i) {
      if (typeof x === 'string') w += PUNCT_ONLY.test(x) ? 0 : words(x);
      else acts++;
    }
    return acts >= 1 && acts <= 3 && w <= 2;
  };
  let run = 0; // number of blocks merged into the last output block
  for (const b of blocks) {
    // drop lines that are only separators
    if (b.i.every((x) => typeof x === 'string' && PUNCT_ONLY.test(x))) continue;
    dedupeLinks(b);
    const prev = out[out.length - 1];
    if (prev && run > 0 && run < 12 && tiny(b) && prev.r === b.r && prev.fm === b.fm && prev.k === 'p' && prev.g === undefined) {
      prev.i.push(' ', ...b.i);
      run++;
      continue;
    }
    out.push(b);
    run = tiny(b) ? 1 : 0;
  }
  return out;
}

/** Within one line, a second link to the same place adds nothing: keep the first, demote the rest to text. */
function dedupeLinks(b: Block) {
  let seen: Set<string> | undefined;
  for (let i = 0; i < b.i.length; i++) {
    const x = b.i[i];
    if (typeof x === 'string' || x.k !== 'link' || !x.href) continue;
    seen ??= new Set();
    if (seen.has(x.href)) {
      const first = b.i.find((y) => typeof y !== 'string' && y.href === x.href) as Act;
      // same place, same (or contained) name: drop it. Same place under a different name: both stay.
      const fa = first.l.toLowerCase().replace(/[.\u2026\s]+$/, '');
      const xa = x.l.toLowerCase().replace(/[.\u2026\s]+$/, '');
      if (fa.includes(xa)) b.i[i] = '';
      else if (xa.includes(fa)) b.i[b.i.indexOf(first)] = '';
    } else seen.add(x.href);
  }
  if (seen) {
    // tidy the holes left by removed duplicates
    const cleaned: Inline[] = [];
    for (const x of b.i) {
      if (x === '') continue;
      const last = cleaned[cleaned.length - 1];
      if (typeof x === 'string' && typeof last === 'string') cleaned[cleaned.length - 1] = (last + x).replace(/\s+/g, ' ').replace(/ \|(?: \|)+ /g, ' | ');
      else cleaned.push(x);
    }
    // a separator left dangling at either end of the line
    if (typeof cleaned[0] === 'string') cleaned[0] = (cleaned[0] as string).replace(/^\s*\|\s*/, '');
    const li = cleaned.length - 1;
    if (li >= 0 && typeof cleaned[li] === 'string') cleaned[li] = (cleaned[li] as string).replace(/\s*\|\s*$/, '');
    b.i = cleaned.filter((y) => y !== '');
  }
}
