// Key names and chords ("Enter", "Shift+Tab", "Control+a") -> the CDP key events that produce them.

import { AwError } from '../../types.ts';

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  /** text the key types when no Control/Alt/Meta is held */
  text?: string;
  location?: number;
}

const NAMED: Record<string, KeyDef> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
};
const ALIASES: Record<string, string> = {
  return: 'enter', esc: 'escape', del: 'delete', ins: 'insert', spacebar: 'space', ' ': 'space',
  up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
  pgup: 'pageup', pgdn: 'pagedown', pgdown: 'pagedown',
  ctrl: 'control', cmd: 'meta', command: 'meta', win: 'meta', super: 'meta', option: 'alt', opt: 'alt',
};

/** US-layout punctuation: character -> [code, keyCode, needs shift] */
const PUNCT: Record<string, [string, number, boolean]> = {
  '-': ['Minus', 189, false], '_': ['Minus', 189, true], '=': ['Equal', 187, false], '+': ['Equal', 187, true],
  '[': ['BracketLeft', 219, false], '{': ['BracketLeft', 219, true], ']': ['BracketRight', 221, false], '}': ['BracketRight', 221, true],
  '\\': ['Backslash', 220, false], '|': ['Backslash', 220, true], ';': ['Semicolon', 186, false], ':': ['Semicolon', 186, true],
  "'": ['Quote', 222, false], '"': ['Quote', 222, true], ',': ['Comma', 188, false], '<': ['Comma', 188, true],
  '.': ['Period', 190, false], '>': ['Period', 190, true], '/': ['Slash', 191, false], '?': ['Slash', 191, true],
  '`': ['Backquote', 192, false], '~': ['Backquote', 192, true],
  '!': ['Digit1', 49, true], '@': ['Digit2', 50, true], '#': ['Digit3', 51, true], '$': ['Digit4', 52, true], '%': ['Digit5', 53, true],
  '^': ['Digit6', 54, true], '&': ['Digit7', 55, true], '*': ['Digit8', 56, true], '(': ['Digit9', 57, true], ')': ['Digit0', 48, true],
};

export const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
type ModName = keyof typeof MOD;

function keyDef(name: string): KeyDef | undefined {
  const lower = name.toLowerCase();
  const named = NAMED[ALIASES[lower] ?? lower];
  if (named) return named;
  const f = /^f(\d{1,2})$/.exec(lower);
  if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return { key: 'F' + f[1], code: 'F' + f[1], keyCode: 111 + Number(f[1]) };
  if (name.length !== 1) return undefined;
  if (/[a-z]/i.test(name)) return { key: name, code: 'Key' + name.toUpperCase(), keyCode: name.toUpperCase().charCodeAt(0), text: name };
  if (/[0-9]/.test(name)) return { key: name, code: 'Digit' + name, keyCode: name.charCodeAt(0), text: name };
  const p = PUNCT[name];
  if (p) return { key: name, code: p[0], keyCode: p[1], text: name };
  // anything else that is one character: no physical key, but it can still be typed
  return { key: name, code: '', keyCode: 0, text: name };
}

export interface Chord {
  mods: ModName[];
  key: KeyDef;
}

/** "Control+Shift+a" -> modifiers and the main key. "+" alone, and "Control++", name the plus key. */
export function parseChord(spec: string): Chord {
  const raw = String(spec ?? '');
  if (!raw) throw new AwError('bad_request', 'press needs a key', 'for example Enter, Tab, Escape, ArrowDown, Control+a');
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '+' && cur !== '' ) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur === '' && parts.length ? '+' : cur);
  const mods: ModName[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i].trim().toLowerCase();
    const d = NAMED[ALIASES[p] ?? p];
    if (!d || !(d.key in MOD)) throw new AwError('bad_request', `"${parts[i]}" is not a modifier key`, 'modifiers are Control, Shift, Alt and Meta');
    if (!mods.includes(d.key as ModName)) mods.push(d.key as ModName);
  }
  const last = parts[parts.length - 1];
  const name = last.length > 1 ? last.trim() : last;
  let key = keyDef(name);
  if (!key) throw new AwError('bad_request', `unknown key "${name.slice(0, 30)}"`, 'use names like Enter, Tab, Escape, Backspace, ArrowDown, PageDown, F5, or a single character');
  // "Shift+a" types "A"; an upper-case letter or shifted symbol implies Shift
  if (key.text && key.text.length === 1) {
    const shifted = PUNCT[key.text]?.[2] || (/[A-Z]/.test(key.text) && key.code.startsWith('Key'));
    if (shifted && !mods.includes('Shift')) mods.push('Shift');
    else if (mods.includes('Shift') && /[a-z]/.test(key.text)) key = { ...key, key: key.text.toUpperCase(), text: key.text.toUpperCase() };
  }
  return { mods, key };
}

const MOD_DEF: Record<ModName, KeyDef> = { Alt: NAMED.alt, Control: NAMED.control, Meta: NAMED.meta, Shift: NAMED.shift };

/** Editing commands macOS only runs when told to (its key bindings live outside Blink). */
const MAC_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

/** The Input.dispatchKeyEvent parameter objects, in order, for one press of a chord. */
export function chordEvents(chord: Chord, platform: NodeJS.Platform = process.platform): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let bits = 0;
  for (const m of chord.mods) {
    bits |= MOD[m];
    const d = MOD_DEF[m];
    out.push({ type: 'rawKeyDown', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, location: d.location, modifiers: bits });
  }
  const k = chord.key;
  if (k.key in MOD) {
    // a bare modifier press
    const d = k;
    const b = MOD[d.key as ModName];
    out.push({ type: 'rawKeyDown', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, location: d.location, modifiers: bits | b });
    out.push({ type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, location: d.location, modifiers: bits });
  } else {
    const typing = !!k.text && (bits & (MOD.Control | MOD.Meta | MOD.Alt)) === 0;
    const down: Record<string, unknown> = { type: typing ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: bits };
    if (typing) {
      down.text = k.text;
      down.unmodifiedText = k.text;
    }
    if (platform === 'darwin' && bits & MOD.Meta) {
      const cmd = MAC_COMMANDS[k.key.toLowerCase()];
      if (cmd) down.commands = [cmd === 'undo' && bits & MOD.Shift ? 'redo' : cmd];
    }
    out.push(down);
    out.push({ type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: bits });
  }
  for (let i = chord.mods.length - 1; i >= 0; i--) {
    const m = chord.mods[i];
    bits &= ~MOD[m];
    const d = MOD_DEF[m];
    out.push({ type: 'keyUp', key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, location: d.location, modifiers: bits });
  }
  return out;
}
