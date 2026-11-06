// Agent actions against a live jsdom window, with the event sequences real pages listen for.
// Runs in the page process. Every function here is synchronous page-code dispatch; the caller
// runs it under the CPU guard and settles the page afterwards.

export class ActError extends Error {
  code: string;
  hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export interface ActEnv {
  win: any;
  note(kind: string, msg: string): void;
}

const TEXTY = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'color', 'range']);

const label = (el: any): string => {
  const s = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder'))) || (el.textContent || '').trim().slice(0, 40) || el.tagName.toLowerCase();
  return String(s).replace(/\s+/g, ' ');
};

function disabled(el: any): boolean {
  if (el.disabled === true) return true;
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
  try {
    const fs = el.closest && el.closest('fieldset[disabled]');
    if (fs && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(el.tagName)) {
      const legend = fs.querySelector('legend');
      if (!legend || !legend.contains(el)) return true;
    }
  } catch {}
  return false;
}

function point(el: any): { clientX: number; clientY: number; screenX: number; screenY: number } {
  let x = 10;
  let y = 10;
  try {
    const r = el.getBoundingClientRect();
    x = r.left + Math.min(r.width / 2, 20);
    y = r.top + Math.min(r.height / 2, 10);
  } catch {}
  return { clientX: x, clientY: y, screenX: x, screenY: y };
}

function mouse(env: ActEnv, el: any, type: string, extra?: Record<string, unknown>): boolean {
  const win = env.win;
  const isPointer = type.startsWith('pointer');
  const C = isPointer && win.PointerEvent ? win.PointerEvent : win.MouseEvent;
  const noBubble = type === 'mouseenter' || type === 'mouseleave' || type === 'pointerenter' || type === 'pointerleave';
  const init: any = {
    bubbles: !noBubble,
    cancelable: !noBubble,
    composed: true,
    view: win,
    button: 0,
    buttons: type === 'mousedown' || type === 'pointerdown' || type === 'mousemove' ? (type === 'mousemove' ? 0 : 1) : 0,
    detail: type === 'click' || type === 'mousedown' || type === 'mouseup' ? 1 : 0,
    ...point(el),
    ...extra,
  };
  if (isPointer) Object.assign(init, { pointerId: 1, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: type === 'pointerdown' ? 0.5 : 0 });
  return el.dispatchEvent(new C(type, init));
}

/** hovering: leave the previous target, enter this one */
export function hover(env: ActEnv, el: any, state: { hovered: any }): void {
  const prev = state.hovered;
  if (prev && prev !== el && prev.isConnected) {
    mouse(env, prev, 'pointerout');
    mouse(env, prev, 'pointerleave');
    mouse(env, prev, 'mouseout');
    mouse(env, prev, 'mouseleave');
  }
  if (prev !== el) {
    mouse(env, el, 'pointerover');
    mouse(env, el, 'pointerenter');
    mouse(env, el, 'mouseover');
    mouse(env, el, 'mouseenter');
  }
  mouse(env, el, 'pointermove');
  mouse(env, el, 'mousemove');
  state.hovered = el;
}

const FOCUSABLE = 'a[href],area[href],button,input,select,textarea,iframe,summary,[tabindex],[contenteditable=""],[contenteditable=true]';

function focusTarget(el: any): any {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    try {
      if (n.matches(FOCUSABLE) && !disabled(n)) return n;
    } catch {}
  }
  return null;
}

function focus(env: ActEnv, el: any): void {
  const doc = env.win.document;
  const t = focusTarget(el);
  if (t) {
    if (doc.activeElement !== t) t.focus();
  } else if (doc.activeElement && doc.activeElement !== doc.body && typeof doc.activeElement.blur === 'function') doc.activeElement.blur();
}

export function click(env: ActEnv, el: any, state: { hovered: any }): void {
  if (disabled(el)) throw new ActError('bad_request', `[${label(el)}] is disabled`);
  hover(env, el, state);
  const down = mouse(env, el, 'pointerdown');
  const mdown = down ? mouse(env, el, 'mousedown') : false;
  if (el.isConnected && mdown) focus(env, el);
  if (el.isConnected) mouse(env, el, 'pointerup');
  if (el.isConnected) mouse(env, el, 'mouseup');
  // the activation behaviour (links, submit buttons, checkboxes, labels) runs as part of click dispatch
  if (el.isConnected) mouse(env, el, 'click');
}

const valueSetter = (win: any, el: any): ((v: string) => void) => {
  const proto = el instanceof win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : el instanceof win.HTMLSelectElement ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  const d = Object.getOwnPropertyDescriptor(proto, 'value');
  return (v: string) => (d && d.set ? d.set.call(el, v) : (el.value = v));
};

function key(env: ActEnv, el: any, type: string, k: KeySpec): boolean {
  const win = env.win;
  return el.dispatchEvent(
    new win.KeyboardEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: win,
      key: k.key,
      code: k.code,
      keyCode: type === 'keypress' ? k.charCode || k.keyCode : k.keyCode,
      charCode: type === 'keypress' ? k.charCode : 0,
      which: type === 'keypress' ? k.charCode || k.keyCode : k.keyCode,
      ctrlKey: k.ctrl,
      shiftKey: k.shift,
      altKey: k.alt,
      metaKey: k.meta,
    }),
  );
}

function inputEvent(env: ActEnv, el: any, type: 'beforeinput' | 'input', inputType: string, data: string | null): boolean {
  const win = env.win;
  const C = win.InputEvent || win.Event;
  return el.dispatchEvent(new C(type, { bubbles: true, cancelable: type === 'beforeinput', composed: true, inputType, data }));
}

const change = (env: ActEnv, el: any) => el.dispatchEvent(new env.win.Event('change', { bubbles: true }));

const isTextControl = (win: any, el: any): boolean =>
  el instanceof win.HTMLTextAreaElement || (el instanceof win.HTMLInputElement && TEXTY.has(String(el.type || '').toLowerCase()));
const editable = (el: any): boolean => !!el && el.isContentEditable === true;

export function fill(env: ActEnv, el: any, value: string, state: { hovered: any }): void {
  const win = env.win;
  if (el instanceof win.HTMLLabelElement && el.control) el = el.control;
  if (el instanceof win.HTMLSelectElement) return select(env, el, value);
  if (el instanceof win.HTMLInputElement) {
    const t = String(el.type).toLowerCase();
    if (t === 'checkbox' || t === 'radio') throw new ActError('bad_request', `[${label(el)}] is a ${t}: use check`);
    if (t === 'file') throw new ActError('unsupported', 'file inputs need upload, which the ghost engine cannot do', "use engine('chrome')");
    if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') throw new ActError('bad_request', `[${label(el)}] is a button: use click`);
  }
  const contentEditable = !isTextControl(win, el) && (editable(el) || (el.isContentEditable === undefined && el.getAttribute('contenteditable') !== null));
  if (!isTextControl(win, el) && !contentEditable) {
    // a wrapper around a single text control (custom input components)
    const inner = el.querySelector && el.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,[contenteditable=""],[contenteditable=true]');
    if (!inner) throw new ActError('bad_request', `<${el.tagName.toLowerCase()}> [${label(el)}] is not a text field`);
    return fill(env, inner, value, state);
  }
  if (disabled(el)) throw new ActError('bad_request', `[${label(el)}] is disabled`);
  if (el.readOnly) throw new ActError('bad_request', `[${label(el)}] is read-only`);
  click(env, el, state);
  if (!el.isConnected) return;
  const doc = win.document;
  if (doc.activeElement !== el) el.focus();
  const last = value.length ? value[value.length - 1] : '';
  const k = parseKey(last || 'Unidentified');
  key(env, el, 'keydown', k);
  if (contentEditable) {
    if (inputEvent(env, el, 'beforeinput', 'insertText', value)) {
      el.textContent = value;
      inputEvent(env, el, 'input', 'insertText', value);
    }
  } else {
    // React and other frameworks track `value` on the instance; the prototype setter bypasses the tracker
    if (inputEvent(env, el, 'beforeinput', 'insertText', value)) {
      valueSetter(win, el)(value);
      inputEvent(env, el, 'input', 'insertText', value);
      if (el.value !== value && value !== '') {
        const t = String(el.type || 'text').toLowerCase();
        env.note('fill', `the ${t} field [${label(el)}] holds "${String(el.value).slice(0, 40)}" after filling "${value.slice(0, 40)}"`);
      }
    }
  }
  key(env, el, 'keyup', k);
  change(env, el);
}

export function select(env: ActEnv, el: any, value: string): void {
  const win = env.win;
  if (el instanceof win.HTMLOptionElement && el.parentElement) el = el.closest('select') || el;
  if (el instanceof win.HTMLLabelElement && el.control) el = el.control;
  if (!(el instanceof win.HTMLSelectElement)) {
    const inner = el.querySelector && el.querySelector('select');
    if (inner) el = inner;
    else throw new ActError('bad_request', `[${label(el)}] is not a <select>`, 'click it to open the list, then click the option');
  }
  if (disabled(el)) throw new ActError('bad_request', `[${label(el)}] is disabled`);
  const opts: any[] = Array.from(el.options);
  const want = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const text = (o: any) => String(o.label || o.textContent || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const opt =
    opts.find((o) => text(o) === want) ||
    opts.find((o) => String(o.value).toLowerCase() === want) ||
    opts.find((o) => text(o).startsWith(want)) ||
    opts.find((o) => want && text(o).includes(want));
  if (!opt) {
    const names = opts.slice(0, 12).map((o) => text(o) || o.value);
    throw new ActError('bad_request', `no option "${value}" in [${label(el)}]`, 'options: ' + names.join(', '));
  }
  if (opt.disabled) throw new ActError('bad_request', `option "${value}" is disabled`);
  el.focus();
  if (el.multiple) opt.selected = true;
  else valueSetter(win, el)(opt.value);
  if (!opt.selected) opt.selected = true;
  inputEvent(env, el, 'input', 'insertReplacementText', null);
  change(env, el);
}

export function check(env: ActEnv, el: any, on: boolean, state: { hovered: any }): void {
  const win = env.win;
  if (el instanceof win.HTMLLabelElement && el.control) el = el.control;
  if (el instanceof win.HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    if (el.checked === on) return;
    if (!on && el.type === 'radio') throw new ActError('bad_request', `[${label(el)}] is a radio button: check another option instead`);
    // a hidden native input styled through its label: click the label like a person would
    click(env, el, state);
    if (el.checked !== on) env.note('check', `[${label(el)}] is still ${el.checked ? 'checked' : 'unchecked'}: the page refused the change`);
    return;
  }
  const role = el.getAttribute && el.getAttribute('role');
  if (role === 'checkbox' || role === 'switch' || role === 'radio' || role === 'menuitemcheckbox' || el.hasAttribute('aria-checked') || el.hasAttribute('aria-pressed')) {
    const attr = el.hasAttribute('aria-checked') ? 'aria-checked' : 'aria-pressed';
    const now = el.getAttribute(attr) === 'true';
    if (now !== on) click(env, el, state);
    return;
  }
  const inner = el.querySelector && el.querySelector('input[type=checkbox],input[type=radio]');
  if (inner) return check(env, inner, on, state);
  throw new ActError('bad_request', `[${label(el)}] is not a checkbox`);
}

interface KeySpec {
  key: string;
  code: string;
  keyCode: number;
  charCode: number;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

const NAMED: Record<string, [string, string, number]> = {
  enter: ['Enter', 'Enter', 13], return: ['Enter', 'Enter', 13], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
  space: [' ', 'Space', 32], ' ': [' ', 'Space', 32], backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46], del: ['Delete', 'Delete', 46],
  arrowup: ['ArrowUp', 'ArrowUp', 38], up: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40], down: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], left: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39], right: ['ArrowRight', 'ArrowRight', 39],
  home: ['Home', 'Home', 36], end: ['End', 'End', 35], pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34],
  unidentified: ['Unidentified', '', 0],
};

export function parseKey(spec: string): KeySpec {
  const parts = spec.length > 1 ? spec.split('+').map((s) => s.trim()) : [spec];
  let name = parts.pop() || '';
  if (name === '' && spec.endsWith('+')) name = '+';
  const mods = parts.map((p) => p.toLowerCase());
  const k: KeySpec = {
    key: name, code: '', keyCode: 0, charCode: 0,
    ctrl: mods.includes('ctrl') || mods.includes('control'), shift: mods.includes('shift'), alt: mods.includes('alt') || mods.includes('option'),
    meta: mods.includes('meta') || mods.includes('cmd') || mods.includes('command'),
  };
  const named = NAMED[name.toLowerCase()];
  if (named) [k.key, k.code, k.keyCode] = named;
  else if (/^f([1-9]|1[0-2])$/i.test(name)) Object.assign(k, { key: name.toUpperCase(), code: name.toUpperCase(), keyCode: 111 + +name.slice(1) });
  else if (name.length === 1) {
    const up = name.toUpperCase();
    k.key = k.shift ? up : name;
    k.code = /[a-z]/i.test(name) ? 'Key' + up : /[0-9]/.test(name) ? 'Digit' + name : '';
    k.keyCode = /[a-z0-9]/i.test(name) ? up.charCodeAt(0) : name.charCodeAt(0);
    k.charCode = k.key.charCodeAt(0);
  }
  if (k.key === 'Enter') k.charCode = 13;
  return k;
}

function tabbables(doc: any): any[] {
  const all: any[] = Array.from(doc.querySelectorAll(FOCUSABLE));
  return all.filter((e) => !disabled(e) && e.tabIndex >= 0 && !(e instanceof doc.defaultView.HTMLInputElement && e.type === 'hidden') && !e.closest('[hidden],[inert]'));
}

function setText(env: ActEnv, el: any, next: string, inputType: string, data: string | null): void {
  if (!inputEvent(env, el, 'beforeinput', inputType, data)) return;
  if (editable(el)) el.textContent = next;
  else valueSetter(env.win, el)(next);
  inputEvent(env, el, 'input', inputType, data);
}

/** implicit submission: https://html.spec.whatwg.org/#implicit-submission */
function implicitSubmit(env: ActEnv, input: any, state: { hovered: any }): void {
  const form = input.form;
  if (!form) return;
  const win = env.win;
  const controls: any[] = Array.from(form.elements);
  const isSubmit = (e: any) => (e instanceof win.HTMLButtonElement && (e.type || 'submit') === 'submit') || (e instanceof win.HTMLInputElement && (e.type === 'submit' || e.type === 'image'));
  const button = controls.find(isSubmit);
  if (button) {
    if (!disabled(button)) click(env, button, state);
    return;
  }
  const blocking = controls.filter((e) => e instanceof win.HTMLInputElement && TEXTY.has(String(e.type).toLowerCase()) && !['color', 'range'].includes(e.type));
  if (blocking.length <= 1) form.requestSubmit();
}

export function press(env: ActEnv, el: any | null, spec: string, state: { hovered: any }): void {
  const win = env.win;
  const doc = win.document;
  const k = parseKey(spec);
  if (el) {
    const t = focusTarget(el);
    if (t && doc.activeElement !== t) t.focus();
  }
  const target = el || doc.activeElement || doc.body;
  if (!target) return;
  const proceed = key(env, target, 'keydown', k);
  if (proceed && (k.charCode || k.key === 'Enter') && !k.ctrl && !k.meta) key(env, target, 'keypress', k);
  if (proceed && target.isConnected) {
    const text = isTextControl(win, target) || editable(target);
    const cur = text ? String(editable(target) ? target.textContent : target.value) : '';
    if (k.key === 'Enter' && !k.ctrl && !k.meta) {
      if (target instanceof win.HTMLTextAreaElement || editable(target)) setText(env, target, cur + '\n', 'insertLineBreak', null);
      else if (target instanceof win.HTMLInputElement && !['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(target.type)) implicitSubmit(env, target, state);
      else if (target.matches && target.matches('a[href],button,input,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option]')) click(env, target, state);
    } else if (k.key === ' ' && !text) {
      if (target.matches && target.matches('button,input,summary,[role=button],[role=checkbox],[role=switch],[role=tab],[role=menuitem],[role=option]')) click(env, target, state);
    } else if (k.key === 'Tab') {
      const list = tabbables(doc);
      if (list.length) {
        const i = list.indexOf(doc.activeElement);
        const next = k.shift ? list[(i <= 0 ? list.length : i) - 1] : list[(i + 1) % list.length];
        next.focus();
      }
    } else if (k.key === 'Backspace' && text) {
      if (cur) setText(env, target, cur.slice(0, -1), 'deleteContentBackward', null);
    } else if (k.key === 'Escape') {
      const dlg = doc.querySelector('dialog[open]');
      if (dlg && dlg.dispatchEvent(new win.Event('cancel', { cancelable: true }))) dlg.close();
    } else if (k.charCode && text && !k.ctrl && !k.meta && !k.alt && k.key.length === 1) {
      setText(env, target, cur + k.key, 'insertText', k.key);
    }
  }
  if (target.isConnected) key(env, target, 'keyup', k);
  else if (doc.activeElement) key(env, doc.activeElement, 'keyup', k);
}
