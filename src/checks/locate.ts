// Code that runs INSIDE the page (the engine's isolated world): find elements the way a person or a
// screen reader names them (ARIA role + accessible name, a field's label, a test id, CSS), optionally
// inside a scope (a dialog, a row, a region), and report each match's state. Powers
// expect(role='button', name='Save', disabled=1), expect(checked='Kiosk'), expect(focused='Email')
// and steps aimed with in='dialog:Report a problem'.
//
// Injected with toString(): nothing here may reference anything outside `locator`.
// No change to the page, except that a match is registered in the extractor's node registry
// (win.__aw) so a step can act on it by number.

export interface LocSpec {
  role?: string;
  /** accessible name: substring (case-insensitive), or /regex/flags; exact=true for whole-string equality */
  name?: string;
  exact?: boolean;
  /** a form control whose label (or aria-label, placeholder) matches */
  label?: string;
  testid?: string;
  css?: string;
  /** element whose own visible text contains this (getByText) */
  text?: string;
  /** heading level */
  level?: number;
  /** scope: 'dialog:Report a problem', 'row:Emil', 'region', or a CSS selector */
  within?: string;
  /** only controls (things you can click or type into) count when matching by name alone */
  actionable?: boolean;
  /** return the scope's own elements (for text inside a scope) */
  roots?: boolean;
}

export interface LocMatch {
  n: number;
  role: string;
  name: string;
  visible: boolean;
  checked?: boolean | 'mixed';
  disabled: boolean;
  focused: boolean;
  selected?: boolean;
  expanded?: boolean;
  pressed?: boolean;
  value?: string;
  text: string;
  tag: string;
  level?: number;
  attrs: Record<string, string>;
}

export interface LocResult {
  matches: LocMatch[];
  /** when nothing matched: the scope was not found */
  noScope?: string;
  /** a few elements of the same role (or the same name) that did not match, for the failure message */
  near: { role: string; name: string; visible: boolean }[];
  /** what has the focus now */
  focus?: { role: string; name: string; tag: string };
}

export function locator(win: any): { query: (spec: LocSpec) => LocResult } {
  const doc = win.document;
  const low = (s: any): string => String(s == null ? '' : s).toLowerCase();
  const squash = (s: any): string => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const tagOf = (el: any): string => low(el.localName);
  const attr = (el: any, a: string): string | null => (el.getAttribute ? el.getAttribute(a) : null);
  const cs = (el: any): any => win.getComputedStyle(el);

  const reg = (win.__aw ||= { ids: new WeakMap(), nodes: new Map(), next: 1 });
  const idOf = (el: any): number => {
    let id = reg.ids.get(el);
    if (!id) {
      id = reg.next++;
      reg.ids.set(el, id);
    }
    if (!reg.nodes.has(id)) reg.nodes.set(id, typeof win.WeakRef === 'function' ? new win.WeakRef(el) : el);
    return id;
  };

  const INPUT_ROLE: Record<string, string> = {
    button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider',
    number: 'spinbutton', search: 'searchbox', email: 'textbox', tel: 'textbox', text: 'textbox', url: 'textbox', '': 'textbox',
  };
  const TAG_ROLE: Record<string, string> = {
    button: 'button', textarea: 'textbox', option: 'option', nav: 'navigation', main: 'main', aside: 'complementary', dialog: 'dialog',
    ul: 'list', ol: 'list', menu: 'list', li: 'listitem', table: 'table', tr: 'row', td: 'cell', fieldset: 'group', article: 'article',
    progress: 'progressbar', output: 'status', hr: 'separator', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading',
    h6: 'heading', dl: 'list', details: 'group', meter: 'meter', tbody: 'rowgroup', thead: 'rowgroup', tfoot: 'rowgroup', optgroup: 'group',
    datalist: 'listbox', search: 'search', p: 'paragraph', blockquote: 'blockquote', figure: 'figure', caption: 'caption',
  };
  const NAME_FROM_CONTENT = new Set(['button', 'link', 'heading', 'cell', 'gridcell', 'columnheader', 'rowheader', 'row', 'tab', 'menuitem',
    'menuitemcheckbox', 'menuitemradio', 'option', 'checkbox', 'radio', 'switch', 'treeitem', 'tooltip', 'listitem', 'term', 'caption']);
  const ACTIONABLE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option', 'slider',
    'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);

  const inSection = (el: any): boolean => !!(el.parentElement && el.parentElement.closest('article,aside,main,nav,section'));
  const roleOf = (el: any): string => {
    const explicit = squash(attr(el, 'role')).split(' ')[0];
    if (explicit && explicit !== 'none' && explicit !== 'presentation') return explicit;
    if (explicit) return 'none';
    const t = tagOf(el);
    if (t === 'a' || t === 'area') return el.hasAttribute('href') ? 'link' : 'generic';
    if (t === 'input') {
      const ty = low(attr(el, 'type'));
      if (ty === 'hidden' || ty === 'password' || ty === 'file' || ty === 'color' || ty === 'date' || ty === 'time' || ty === 'datetime-local' || ty === 'month' || ty === 'week') return ty === 'hidden' ? 'none' : ty === 'password' ? 'textbox-password' : ty;
      if (el.hasAttribute('list') && (ty === '' || ty === 'text' || ty === 'search' || ty === 'email' || ty === 'tel' || ty === 'url')) return 'combobox';
      return INPUT_ROLE[ty] ?? 'textbox';
    }
    if (t === 'select') return el.multiple || Number(attr(el, 'size')) > 1 ? 'listbox' : 'combobox';
    if (t === 'img') return attr(el, 'alt') === '' ? 'presentation' : 'img';
    if (t === 'header') return inSection(el) ? 'generic' : 'banner';
    if (t === 'footer') return inSection(el) ? 'generic' : 'contentinfo';
    if (t === 'section') return attr(el, 'aria-label') || attr(el, 'aria-labelledby') ? 'region' : 'generic';
    if (t === 'form') return attr(el, 'aria-label') || attr(el, 'aria-labelledby') ? 'form' : 'generic';
    if (t === 'th') return low(attr(el, 'scope')) === 'row' ? 'rowheader' : 'columnheader';
    if (t === 'summary') return 'button';
    if (t === 'svg') return 'img';
    return TAG_ROLE[t] ?? 'generic';
  };

  const hiddenFromA11y = (el: any): boolean => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
      if (attr(n, 'aria-hidden') === 'true' || n.hidden) return true;
      if (tagOf(n) === 'dialog' && !n.open) return true;
    }
    const s = cs(el);
    return s.display === 'none' || s.visibility === 'hidden';
  };
  const visible = (el: any): boolean => {
    if (tagOf(el) === 'option') {
      const sel = el.closest('select');
      return sel ? visible(sel) : false;
    }
    try {
      if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: false })) return false;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) {
        // display:contents and zero-size wrappers: visible when a child is
        if (cs(el).display === 'contents') return [...el.children].some(visible);
        return false;
      }
      return cs(el).visibility !== 'hidden';
    } catch {
      return false;
    }
  };

  /** text of a subtree for a name: hidden parts skipped, aria-label and alt of descendants used */
  const textOf = (el: any, depth = 0): string => {
    if (depth > 30) return '';
    let out = '';
    for (const c of el.childNodes) {
      if (c.nodeType === 3) out += c.data;
      else if (c.nodeType === 1) {
        if (attr(c, 'aria-hidden') === 'true') continue;
        const t = tagOf(c);
        if (t === 'script' || t === 'style' || t === 'template' || t === 'noscript') continue;
        let s;
        try {
          s = cs(c);
        } catch {
          s = null;
        }
        if (s && (s.display === 'none' || s.visibility === 'hidden')) continue;
        const al = attr(c, 'aria-label');
        if (al && squash(al)) out += ' ' + al + ' ';
        else if (t === 'img' || (t === 'input' && low(attr(c, 'type')) === 'image')) out += ' ' + (attr(c, 'alt') || '') + ' ';
        else if (t === 'input' && /^(submit|button|reset)$/.test(low(attr(c, 'type')))) out += ' ' + (c.value || '') + ' ';
        else if (t === 'input' || t === 'textarea') out += ' ' + (c.value || '') + ' ';
        else if (t === 'select') out += ' ' + (c.selectedOptions && c.selectedOptions[0] ? c.selectedOptions[0].textContent : '') + ' ';
        else {
          const block = s && s.display !== 'inline' && s.display !== 'contents';
          out += (block ? ' ' : '') + (c.shadowRoot ? textOf(c.shadowRoot, depth + 1) : textOf(c, depth + 1)) + (block ? ' ' : '');
        }
      }
    }
    return out;
  };
  const byIds = (el: any, ids: string): string => {
    const root = el.getRootNode ? el.getRootNode() : doc;
    return squash(ids.split(/\s+/).map((id) => {
      const t = (root.getElementById ? root.getElementById(id) : null) || doc.getElementById(id);
      return t ? squash(attr(t, 'aria-label') || textOf(t)) : '';
    }).join(' '));
  };
  const labelText = (el: any): string => {
    const parts: string[] = [];
    if (el.labels && el.labels.length) for (const l of el.labels) {
      // the label's text without the control itself
      let s = '';
      for (const c of l.childNodes) if (c !== el && !(c.nodeType === 1 && c.contains(el))) s += c.nodeType === 3 ? c.data : ' ' + textOf(c) + ' ';
      else if (c.nodeType === 1 && c !== el && c.contains(el)) s += ' ' + textOf(c).replace(squash(el.value || ''), '') + ' ';
      parts.push(squash(s));
    }
    return squash(parts.join(' '));
  };
  const nameOf = (el: any, role: string): string => {
    const lb = attr(el, 'aria-labelledby');
    if (lb) {
      const s = byIds(el, lb);
      if (s) return s;
    }
    const al = squash(attr(el, 'aria-label'));
    if (al) return al;
    const t = tagOf(el);
    if (t === 'input' || t === 'textarea' || t === 'select' || t === 'meter' || t === 'progress' || t === 'output') {
      const ty = low(attr(el, 'type'));
      if (t === 'input' && /^(submit|reset|button)$/.test(ty)) return squash(el.value || (ty === 'submit' ? 'Submit' : ty === 'reset' ? 'Reset' : ''));
      if (t === 'input' && ty === 'image') return squash(attr(el, 'alt') || attr(el, 'value') || 'Submit');
      const l = labelText(el);
      if (l) return l;
      return squash(attr(el, 'title') || attr(el, 'placeholder') || '');
    }
    if (t === 'img' || t === 'area') return squash(attr(el, 'alt') || attr(el, 'title') || '');
    if (t === 'fieldset') {
      const lg = el.querySelector(':scope > legend');
      if (lg) return squash(textOf(lg));
    }
    if (t === 'table') {
      const cap = el.querySelector(':scope > caption');
      if (cap) return squash(textOf(cap));
    }
    if (t === 'svg') {
      const ti = el.querySelector(':scope > title');
      if (ti) return squash(ti.textContent);
    }
    if (NAME_FROM_CONTENT.has(role)) {
      const s = squash(el.shadowRoot ? textOf(el.shadowRoot) : textOf(el));
      if (s) return s;
    }
    return squash(attr(el, 'title') || '');
  };

  const matcher = (want: string | undefined, exact?: boolean): ((s: string) => boolean) => {
    if (want === undefined) return () => true;
    const m = /^\/(.*)\/([a-z]*)$/s.exec(want);
    if (m) {
      try {
        const re = new RegExp(m[1], m[2]);
        return (s) => re.test(s);
      } catch {
        // not a valid pattern: compare as text
      }
    }
    const w = squash(want);
    if (exact) return (s) => squash(s) === w;
    const lw = low(w);
    return (s) => low(squash(s)).includes(lw);
  };

  /** every element of the document, through open shadow roots */
  const all = (root: any): any[] => {
    const out: any[] = [];
    const walk = (r: any) => {
      const it = doc.createTreeWalker(r, 1);
      for (let n = it.currentNode.nodeType === 1 ? it.currentNode : it.nextNode(); n; n = it.nextNode()) {
        out.push(n);
        if (n.shadowRoot) walk(n.shadowRoot);
        if (out.length > 30000) return;
      }
    };
    walk(root);
    return out;
  };

  const activeEl = (): any => {
    let a = doc.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };

  const describe = (el: any) => {
    const role = roleOf(el);
    const r = role === 'textbox-password' ? 'textbox' : role;
    return { role: r, name: nameOf(el, role) };
  };

  const stateOf = (el: any, role: string, name: string): LocMatch => {
    const t = tagOf(el);
    const ac = attr(el, 'aria-checked');
    let checked: boolean | 'mixed' | undefined;
    if (t === 'input' && (el.type === 'checkbox' || el.type === 'radio')) checked = el.indeterminate ? 'mixed' : !!el.checked;
    else if (ac !== null) checked = ac === 'mixed' ? 'mixed' : ac === 'true';
    let disabled = attr(el, 'aria-disabled') === 'true';
    try {
      if (el.matches && el.matches(':disabled')) disabled = true;
    } catch {}
    for (let p = el.parentElement; p && !disabled; p = p.parentElement) if (attr(p, 'aria-disabled') === 'true') disabled = true;
    const asel = attr(el, 'aria-selected');
    const aexp = attr(el, 'aria-expanded');
    const apr = attr(el, 'aria-pressed');
    const attrs: Record<string, string> = {};
    for (const a of el.attributes || []) if (attrs[a.name] === undefined && Object.keys(attrs).length < 40) attrs[a.name] = String(a.value).slice(0, 200);
    const lv = attr(el, 'aria-level') || (/^h[1-6]$/.test(t) ? t.slice(1) : null);
    return {
      n: idOf(el),
      role,
      name: name.slice(0, 200),
      visible: visible(el),
      checked,
      disabled,
      focused: el === activeEl(),
      selected: t === 'option' ? !!el.selected : asel !== null ? asel === 'true' : undefined,
      expanded: aexp !== null ? aexp === 'true' : t === 'details' ? !!el.open : undefined,
      pressed: apr !== null ? apr === 'true' : undefined,
      value: t === 'input' || t === 'textarea' || t === 'select' ? String(el.value ?? '') : attr(el, 'aria-valuenow') ?? undefined,
      text: squash(el.innerText ?? el.textContent ?? '').slice(0, 300),
      tag: t,
      level: lv ? Number(lv) : undefined,
      attrs,
    };
  };

  const scopeRoots = (within: string): any[] | string => {
    const w = within.trim();
    if (/^[.#[]/.test(w) || /^css=/i.test(w)) {
      const sel = w.replace(/^css=/i, '');
      try {
        const els = [...doc.querySelectorAll(sel)];
        return els.length ? els : `nothing matches ${sel}`;
      } catch {
        // not CSS: a role
      }
    }
    const i = w.indexOf(':');
    const role = low(i < 0 ? w : w.slice(0, i)).trim();
    const name = i < 0 ? undefined : w.slice(i + 1).trim();
    const nm = matcher(name);
    const found = all(doc.documentElement).filter((el) => {
      const r = roleOf(el);
      if (r !== role) return false;
      if (hiddenFromA11y(el)) return false;
      if (name === undefined) return true;
      // a row or a card is found by any text in it, as well as by its name
      return nm(nameOf(el, r)) || nm(squash(el.innerText ?? el.textContent ?? ''));
    });
    const vis = found.filter(visible);
    return vis.length ? vis : found.length ? found : `no ${role}${name ? ` named '${name}'` : ''} on the page`;
  };

  const query = (spec: LocSpec): LocResult => {
    let roots: any[] = [doc.documentElement];
    if (spec.within) {
      const r = scopeRoots(spec.within);
      if (typeof r === 'string') return { matches: [], noScope: r, near: [] };
      roots = r;
      if (spec.roots) {
        const a0 = activeEl();
        return { matches: roots.slice(0, 50).map((el) => { const d = describe(el); return stateOf(el, d.role, d.name); }), near: [], focus: a0 ? { ...describe(a0), tag: tagOf(a0) } : undefined };
      }
    }
    const inScope = (el: any) => roots.some((r) => r === doc.documentElement || (r !== el && r.contains(el)) || (el.getRootNode && el.getRootNode().host && r.contains(el.getRootNode().host)));
    const els = roots.length === 1 ? all(roots[0]) : [...new Set(roots.flatMap((r: any) => all(r)))];
    const wantRole = spec.role ? low(spec.role) : undefined;
    const nameM = matcher(spec.name, spec.exact);
    const labelM = matcher(spec.label, spec.exact);
    const textM = matcher(spec.text, spec.exact);
    const out: LocMatch[] = [];
    const near: { role: string; name: string; visible: boolean }[] = [];
    const seen = new Set<string>();
    for (const el of els) {
      if (el === doc.documentElement && roots[0] !== doc.documentElement) continue;
      if (!inScope(el) && roots[0] !== doc.documentElement) continue;
      if (spec.testid !== undefined) {
        const tid = attr(el, 'data-testid') ?? attr(el, 'data-test') ?? attr(el, 'data-cy') ?? attr(el, 'data-qa');
        if (tid !== spec.testid) continue;
      }
      if (spec.css !== undefined) {
        try {
          if (!el.matches(spec.css)) continue;
        } catch {
          return { matches: [], noScope: `'${spec.css}' is not a CSS selector`, near: [] };
        }
      }
      let role = roleOf(el);
      if (role === 'textbox-password') role = wantRole === 'textbox' ? 'textbox' : 'password';
      if (wantRole && role !== wantRole) continue;
      if (spec.label !== undefined) {
        const t = tagOf(el);
        const control = t === 'input' || t === 'textarea' || t === 'select' || ACTIONABLE.has(role) || role === 'group' || role === 'region' || role === 'dialog';
        if (!control) continue;
        const lab = labelText(el) || squash(attr(el, 'aria-label')) || (attr(el, 'aria-labelledby') ? byIds(el, attr(el, 'aria-labelledby')!) : '') || squash(attr(el, 'placeholder'));
        if (!lab || !labelM(lab)) continue;
      }
      if (spec.text !== undefined) {
        // the innermost element with that text (getByText): its own text matches and no child's does alone
        const own = squash(el.innerText ?? el.textContent ?? '');
        if (!own || !textM(own)) continue;
        if ([...el.children].some((c: any) => textM(squash(c.innerText ?? c.textContent ?? '')))) continue;
      }
      if (spec.level !== undefined) {
        const lv = attr(el, 'aria-level') || (/^h[1-6]$/.test(tagOf(el)) ? tagOf(el).slice(1) : '');
        if (Number(lv) !== spec.level) continue;
      }
      // matching by name alone: elements that have a role a person would point at
      if (!wantRole && spec.name !== undefined && spec.label === undefined && spec.testid === undefined && spec.css === undefined) {
        if (role === 'generic' || role === 'none' || role === 'presentation' || role === 'paragraph') continue;
        if (spec.actionable && !ACTIONABLE.has(role)) continue;
      }
      if (hiddenFromA11y(el) && spec.css === undefined && spec.testid === undefined) {
        continue;
      }
      const name = wantRole || spec.name !== undefined ? nameOf(el, role) : '';
      if (spec.name !== undefined && !nameM(name)) {
        if (near.length < 8 && wantRole && name && !seen.has(name)) {
          seen.add(name);
          near.push({ role, name: name.slice(0, 60), visible: visible(el) });
        }
        continue;
      }
      out.push(stateOf(el, role, name || nameOf(el, role)));
      if (out.length >= 200) break;
    }
    const a = activeEl();
    const focus = a && a !== doc.body && a !== doc.documentElement ? { ...describe(a), tag: tagOf(a) } : undefined;
    return { matches: out, near, focus };
  };

  return { query };
}
