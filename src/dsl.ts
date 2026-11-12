// The program language. A program is a few steps; each step is a verb with arguments:
//
//     open('shop.example/x'); fill('Search', 'usb hub'); submit(); find('price')
//
// It is parsed, never evaluated: there is nothing to sandbox, the same program runs on every
// engine, and a program is plain data that can be stored and replayed.
//
// The parser is deliberately forgiving, because the cheapest failure is the one that does not
// happen. It accepts call syntax or shell syntax, any quote style, `await`, `page.` prefixes,
// Playwright spellings (goto, getByRole(...).click(), locator('text=…')), and named arguments.

import { AwError } from './types.ts';

export type Arg = string | number | boolean;

export interface Step {
  verb: string;
  args: Arg[];
  opts: Record<string, Arg>;
  /** the step as written, for error messages */
  src: string;
}

const ALIAS: Record<string, string> = {
  goto: 'open', navigate: 'open', visit: 'open', go: 'open', load: 'open', get: 'open', browse: 'open', nav: 'open',
  type: 'fill', enter: 'fill', input: 'fill', set: 'fill', write: 'fill', settext: 'fill', presssequentially: 'fill', setvalue: 'fill',
  tap: 'click', press_button: 'click', clickon: 'click', follow: 'click',
  choose: 'select', pick: 'select', selectoption: 'select', option: 'select',
  tick: 'check', setchecked: 'check', untick: 'uncheck',
  grep: 'find', locate: 'find', lookup: 'find', query: 'find', findtext: 'find',
  text: 'read', content: 'read', gettext: 'read', innertext: 'read', textcontent: 'read', more: 'read', next: 'read',
  snapshot: 'view', look: 'view', observe: 'view', page: 'view', show: 'view', state: 'view', fresh: 'view', ariasnapshot: 'view',
  screenshot: 'shot', capture: 'shot',
  key: 'press', keypress: 'press', keyboard: 'press', hit: 'press',
  sleep: 'wait', pause: 'wait', waitfor: 'wait', waitfortimeout: 'wait', waitforselector: 'wait', waitfortext: 'wait', waitforloadstate: 'wait', waitforurl: 'wait',
  assert: 'expect', should: 'expect', verify: 'expect', tohavetext: 'expect', tobevisible: 'expect', tocontaintext: 'expect',
  goback: 'back', go_back: 'back', previous: 'back',
  refresh: 'reload',
  google: 'search', websearch: 'search', web_search: 'search',
  urls: 'links', hrefs: 'links',
  headings: 'outline', toc: 'outline',
  scrollto: 'scroll', scrollintoview: 'scroll',
  use: 'engine', tier: 'engine',
  setinputfiles: 'upload', attach: 'upload',
  eval: 'js', evaluate: 'js', evaluatescript: 'js', runjs: 'js', executescript: 'js', runcode: 'js', javascript: 'js', script: 'js',
  consolelogs: 'console', consolemessages: 'console', listconsolemessages: 'console', logs: 'console', consoleerrors: 'console',
  requests: 'network', networkrequests: 'network', listnetworkrequests: 'network', har: 'network',
  handledialog: 'dialog', acceptdialog: 'dialog', dialogs: 'dialog',
  resize: 'emulate', viewport: 'emulate', setviewportsize: 'emulate', setviewport: 'emulate', device: 'emulate', resizepage: 'emulate', geolocation: 'emulate', setgeolocation: 'emulate', timezone: 'emulate', locale: 'emulate', emulatemedia: 'emulate', setdevice: 'emulate',
  forward: 'forward', goforward: 'forward', go_forward: 'forward',
  dragto: 'drag', draganddrop: 'drag', dragndrop: 'drag',
  dblclick: 'click', doubleclick: 'click', rightclick: 'click', contextclick: 'click', contextmenu: 'click',
  pdf: 'shot', savepdf: 'shot', screencast: 'shot',
  reportbug: 'bug', bugreport: 'bug',
  listtabs: 'tabs', tablist: 'tabs', pages: 'tabs', listpages: 'tabs', switchtab: 'tab', selecttab: 'tab', selectpage: 'tab', switchto: 'tab', newpage: 'newtab', opentab: 'newtab', createtab: 'newtab',
  storagestate: 'profile', loadstate: 'profile', usestate: 'profile', usesession: 'profile', signin_as: 'profile', signinas: 'profile', loginas: 'profile',
};

export const VERBS = new Set([
  'open', 'back', 'reload', 'search',
  'view', 'read', 'find', 'links', 'outline', 'shot',
  'click', 'fill', 'select', 'check', 'uncheck', 'submit', 'press', 'hover', 'scroll', 'upload', 'wait',
  'expect', 'engine', 'confirm', 'js', 'console', 'network', 'dialog', 'emulate', 'forward', 'drag',
  'extract', 'each', 'fork', 'watch', 'cookies', 'profile', 'tab', 'tabs', 'newtab', 'bug',
]);

/** Playwright locator builders: the string they carry is the target. */
const LOCATORS = new Set(['getbytext', 'getbyrole', 'getbylabel', 'getbyplaceholder', 'getbytitle', 'getbyalttext', 'getbytestid', 'locator', 'first', 'last', 'nth', 'filter', 'text', 'role', 'label', '$', 'queryselector', 'frame', 'framelocator']);
const NOISE_PREFIX = new Set(['page', 'browser', 'web', 'tab', 'this', 'context', 'window', 'document', 'agent', 'keyboard', 'mouse']);

// ───────────────────────────── tokenizer ─────────────────────────────

type Tok =
  | { t: 'str'; v: string }
  | { t: 'num'; v: number }
  | { t: 'word'; v: string }
  | { t: 'p'; v: string }; // punctuation: ( ) { } [ ] , . = :

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`' || c === '“' || c === '‘') {
      const close = c === '“' ? '”' : c === '‘' ? '’' : c;
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== close) {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          j += 2;
        } else s += src[j++];
      }
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if ('(){}[],=:'.includes(c)) {
      // "=>" and "==" are not ours; treat "=" and ":" as the named-argument separator
      toks.push({ t: 'p', v: c });
      i++;
      continue;
    }
    // a bare word: runs until whitespace or punctuation. Dots stay inside (urls, page.goto).
    let j = i;
    let depthGuard = 0;
    while (j < n && !' \t\r\n(),{}[]"\'`'.includes(src[j]) && depthGuard++ < 4000) {
      if (src[j] === '=' && j > i && /^[A-Za-z_]\w*$/.test(src.slice(i, j))) break; // name=value
      if (src[j] === ':' && j > i && /^[A-Za-z_]\w*$/.test(src.slice(i, j)) && src[j + 1] !== '/') break; // name: value (not http://)
      j++;
    }
    const w = src.slice(i, j);
    if (/^-?\d+(\.\d+)?$/.test(w)) toks.push({ t: 'num', v: Number(w) });
    else toks.push({ t: 'word', v: w });
    i = j;
  }
  return toks;
}

/** Split a program into statements on ';' and newlines that are outside quotes and brackets. */
export function splitStatements(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < src.length) cur += src[++i];
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1);
    if ((c === ';' || c === '\n') && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    // shell-style pipes between steps: open x | find y
    if (c === '|' && depth === 0 && src[i + 1] === ' ' && src[i - 1] === ' ') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ───────────────────────────── parser ─────────────────────────────

interface Call {
  name: string;
  args: Arg[];
  opts: Record<string, Arg>;
  /** nested calls among the arguments, flattened to their carried string */
}

class P {
  toks: Tok[];
  i = 0;
  constructor(toks: Tok[]) {
    this.toks = toks;
  }
  peek(k = 0): Tok | undefined {
    return this.toks[this.i + k];
  }
  isP(v: string, k = 0): boolean {
    const t = this.toks[this.i + k];
    return !!t && t.t === 'p' && t.v === v;
  }

  /** value := string | number | word | call | { k: v, ... } | [ v, ... ] */
  value(opts: Record<string, Arg>): Arg | undefined {
    const t = this.peek();
    if (!t) return undefined;
    if (t.t === 'str') {
      this.i++;
      return t.v;
    }
    if (t.t === 'num') {
      this.i++;
      return t.v;
    }
    if (t.t === 'p' && t.v === '{') {
      this.i++;
      this.object(opts);
      return undefined;
    }
    if (t.t === 'p' && t.v === '[') {
      // a list: keep its first scalar
      this.i++;
      let first: Arg | undefined;
      while (this.peek() && !this.isP(']')) {
        if (this.isP(',')) {
          this.i++;
          continue;
        }
        const v = this.value(opts);
        if (first === undefined && v !== undefined) first = v;
        if (v === undefined && !this.isP(']') && !this.isP(',')) this.i++;
      }
      this.i++;
      return first;
    }
    if (t.t === 'word') {
      if (this.isP('(', 1)) {
        // nested call: getByRole('button', { name: 'Sign in' }) carries a target string
        const chain = this.chain();
        return carried(chain);
      }
      this.i++;
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      return t.v;
    }
    return undefined;
  }

  object(opts: Record<string, Arg>) {
    while (this.peek() && !this.isP('}')) {
      if (this.isP(',')) {
        this.i++;
        continue;
      }
      const k = this.peek()!;
      if ((k.t === 'word' || k.t === 'str') && (this.isP(':', 1) || this.isP('=', 1))) {
        this.i += 2;
        const v = this.value(opts);
        if (v !== undefined) opts[String(k.v).toLowerCase()] = v;
      } else this.i++;
    }
    this.i++;
  }

  args(end: string | null): { args: Arg[]; opts: Record<string, Arg> } {
    const args: Arg[] = [];
    const opts: Record<string, Arg> = {};
    while (this.peek() && !(end && this.isP(end))) {
      if (this.isP(',')) {
        this.i++;
        continue;
      }
      const t = this.peek()!;
      // name=value / name: value
      if (t.t === 'word' && /^[A-Za-z_]\w*$/.test(t.v) && (this.isP('=', 1) || this.isP(':', 1))) {
        this.i += 2;
        const v = this.value(opts);
        if (v !== undefined) opts[t.v.toLowerCase()] = v;
        continue;
      }
      const before = this.i;
      const v = this.value(opts);
      if (v !== undefined) args.push(v);
      if (this.i === before) this.i++; // never stall
    }
    if (end) this.i++;
    return { args, opts };
  }

  /** a.b(args).c(args) ... */
  chain(): Call[] {
    const calls: Call[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== 'word') break;
      this.i++;
      // split dotted names that are not URLs: page.keyboard.press
      const parts = t.v.split('.').filter(Boolean);
      const last = parts.pop() ?? '';
      for (const p of parts) calls.push({ name: p, args: [], opts: {} });
      if (this.isP('(')) {
        this.i++;
        const { args, opts } = this.args(')');
        calls.push({ name: last, args, opts });
      } else {
        calls.push({ name: last, args: [], opts: {} });
      }
      // `.next(` arrives as a word starting with '.'
      const nx = this.peek();
      if (nx && nx.t === 'word' && nx.v.startsWith('.')) {
        nx.v = nx.v.slice(1);
        if (!nx.v) this.i++;
        continue;
      }
      break;
    }
    return calls;
  }
}

/** The target string a locator chain carries: getByRole('button', { name: 'X' }) -> 'X'. */
function carried(chain: Call[]): Arg | undefined {
  let out: Arg | undefined;
  for (const c of chain) {
    const n = c.name.toLowerCase();
    if (c.opts.name !== undefined) out = c.opts.name;
    else if (c.opts.hastext !== undefined) out = c.opts.hastext;
    else if (n === 'getbyrole') out = out ?? c.args[1] ?? c.args[0];
    else if (c.args.length && typeof c.args[0] !== 'boolean') out = c.args[0];
  }
  return typeof out === 'string' ? cleanSelector(out) : out;
}

/** Strip the selector engines models reach for; what remains is matched as visible text or a field name. */
export function cleanSelector(s: string): string {
  let t = s.trim();
  t = t.replace(/^(text|label|placeholder|title|alt|name|id|role|aria-label|data-testid)\s*=\s*/i, '');
  const hasText = /:has-text\((['"])(.*?)\1\)/.exec(t) ?? /:text(?:-is)?\((['"])(.*?)\1\)/.exec(t);
  if (hasText) return hasText[2];
  const attr = /\[(?:name|id|aria-label|placeholder|title|value|data-testid)\s*[*^$~|]?=\s*(['"]?)(.*?)\1\]/.exec(t);
  if (attr) return attr[2];
  if (/^#[\w-]+$/.test(t)) return t.slice(1).replace(/[-_]+/g, ' ');
  if (/^@?e?\d+$/.test(t) && /\d/.test(t)) return t.replace(/\D/g, ''); // @e12, e12, @12
  return t.replace(/^['"]|['"]$/g, '');
}

function toRef(a: Arg): Arg {
  if (typeof a === 'string') {
    const m = /^[@#\[]?e?(\d{1,6})\]?$/.exec(a.trim());
    if (m) return Number(m[1]);
    return cleanSelector(a);
  }
  return a;
}

function canonical(name: string): string {
  const n = name.toLowerCase().replace(/[^a-z_$]/g, '');
  return ALIAS[n] ?? n;
}

function parseStatement(src: string): Step | undefined {
  let s = src.trim().replace(/^(await|return|const \w+ =|let \w+ =|var \w+ =)\s+/i, '').replace(/^\d+[.)]\s+/, '');
  if (!s || s.startsWith('//') || s.startsWith('#')) return undefined;
  // expect(page.getByText('x')).toBeVisible() -> expect('x')
  const toks = tokenize(s);
  if (!toks.length) return undefined;
  const p = new P(toks);
  const first = toks[0];
  if (first.t !== 'word') throw new AwError('bad_request', `cannot read step: ${src}`, hintFor());

  const callStyle = toks.some((t, i) => t.t === 'p' && t.v === '(' && i > 0 && toks[i - 1].t === 'word');
  if (!callStyle) {
    // shell style: verb arg rest-of-line
    p.i = 1;
    const raw = first.v.split('.').pop() ?? first.v;
    const verb = canonical(raw);
    if (verb === 'js') return jsStep(src);
    const { args, opts } = p.args(null);
    return shape(verb, joinShell(verb, args), opts, src, raw);
  }

  const chain = p.chain().filter((c) => !(NOISE_PREFIX.has(c.name.toLowerCase()) && !c.args.length));
  if (!chain.length) throw new AwError('bad_request', `cannot read step: ${src}`, hintFor());
  // the last call that is a known verb is the action; locator calls before it carry the target
  let actionIx = -1;
  for (let k = chain.length - 1; k >= 0; k--) {
    if (VERBS.has(canonical(chain[k].name))) {
      actionIx = k;
      break;
    }
  }
  if (actionIx < 0) {
    const known = chain.find((c) => LOCATORS.has(c.name.toLowerCase()));
    throw new AwError('bad_request', `unknown verb '${chain[chain.length - 1].name}'` + (known ? '' : ''), hintFor(chain[chain.length - 1].name));
  }
  const action = chain[actionIx];
  const verb = canonical(action.name);
  if (verb === 'js' && actionIx === 0) return jsStep(src);
  const before = chain.slice(0, actionIx).filter((c) => LOCATORS.has(c.name.toLowerCase()) || c.args.length);
  const target = before.length ? carried(before) : undefined;
  const args = [...action.args];
  if (target !== undefined) args.unshift(target);
  const opts = { ...action.opts };
  // expect(locator).toHaveText('x'): the matcher's argument is what must be present
  const after = chain.slice(actionIx + 1);
  if (verb === 'expect') for (const c of after) if (c.args.length && typeof c.args[0] === 'string') args.push(c.args[0]);
  return shape(verb, args, opts, src, action.name);
}

const ONE_ARG = new Set(['open', 'find', 'read', 'search', 'expect', 'links', 'view', 'wait', 'engine', 'confirm', 'scroll', 'check', 'uncheck', 'submit', 'hover']);

function joinShell(verb: string, args: Arg[]): Arg[] {
  if (args.length <= 1) return args;
  const allWords = args.every((a) => typeof a !== 'boolean');
  if (!allWords) return args;
  if (ONE_ARG.has(verb) || (verb === 'click' && typeof args[0] !== 'number')) return [args.join(' ')];
  if (verb === 'fill' || verb === 'select' || verb === 'press' || verb === 'click') return [args[0], args.slice(1).join(' ')];
  return args;
}

const TARGETED = new Set(['click', 'fill', 'select', 'check', 'uncheck', 'hover', 'submit', 'upload']);

/**
 * js('code'): the code is kept as written. The general tokenizer would eat the backslashes of a
 * regex and split on quotes, so this one reads the first quoted string (or the whole rest of the
 * step, for the shell form) and unescapes only the quote that delimits it.
 */
function jsStep(src: string): Step {
  const m = /^\s*(?:await\s+)?[\w.$]+\s*(?:\(\s*)?/.exec(src);
  let rest = src.slice(m ? m[0].length : 0);
  const paren = !!m && m[0].includes('(');
  if (paren) rest = rest.replace(/\)\s*$/, '');
  const q = rest[0];
  let code = rest;
  if (q === '"' || q === "'" || q === '`') {
    let j = 1;
    let out = '';
    while (j < rest.length && rest[j] !== q) {
      if (rest[j] === '\\' && rest[j + 1] === q) {
        out += q;
        j += 2;
      } else out += rest[j++];
    }
    code = j >= rest.length ? rest.slice(1) : out;
  }
  code = code.trim();
  if (!code) throw new AwError('bad_request', "js needs code: js('document.title')");
  return { verb: 'js', args: [code], opts: {}, src };
}

function shape(verb: string, args: Arg[], opts: Record<string, Arg>, src: string, raw = ''): Step {
  if (!VERBS.has(verb)) throw new AwError('bad_request', `unknown verb '${verb}'`, hintFor(verb));
  const r = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (verb === 'click') {
    if (r === 'dblclick' || r === 'doubleclick') opts.double = 1;
    else if (r === 'rightclick' || r === 'contextclick' || r === 'contextmenu') opts.button = 'right';
  } else if (verb === 'shot' && (r === 'pdf' || r === 'savepdf')) opts.pdf = 1;
  else if (verb === 'emulate') {
    // viewport(390, 844) / device('iPhone 15') / timezone('Europe/Paris') / locale('fr-FR') / geolocation(48.8, 2.3)
    if (r === 'timezone' && typeof args[0] === 'string') (opts.tz = args.shift()!);
    else if (r === 'locale' && typeof args[0] === 'string') (opts.locale = args.shift()!);
    else if ((r === 'geolocation' || r === 'setgeolocation') && args.length >= 2 && typeof args[0] === 'number') opts.geo = `${args.shift()},${args.shift()}`;
  }
  if (TARGETED.has(verb) && args.length) args[0] = toRef(args[0]);
  if (verb === 'drag') args = args.slice(0, 2).map(toRef);
  if (verb === 'shot' && typeof args[0] === 'string' && /^\d+$/.test(args[0])) args[0] = Number(args[0]);
  if (verb === 'press' && args.length > 1) {
    const KEY = /^(enter|return|tab|escape|esc|space|backspace|delete|arrow|page|home|end|f\d|control|ctrl|shift|alt|meta|cmd)/i;
    const isKey = (a: Arg) => typeof a === 'string' && KEY.test(a);
    if (isKey(args[1]) && !isKey(args[0])) args = [args[1], toRef(args[0])]; // press(target, key) -> press(key, target)
    else args[1] = toRef(args[1]);
  }
  return { verb, args, opts, src };
}

function hintFor(verb?: string): string {
  let h = "verbs: open(url) find('words') read() click(n|'text') fill(n|'label','value') select(n,'option') check(n) submit() press('Enter') back() expect('text') search('query') records('words') each('link words', find='words') view() links() shot()";
  if (verb) {
    const v = verb.toLowerCase();
    let best = '';
    let bestD = 3;
    for (const k of VERBS) {
      const d = distance(v, k);
      if (d < bestD) [best, bestD] = [k, d];
    }
    if (best) h = `did you mean ${best}()? ` + h;
  }
  return h;
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = dp[i];
      dp[i] = Math.min(dp[i] + 1, dp[i - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[a.length];
}

export function parseProgram(src: string): Step[] {
  const text = src.trim();
  if (!text) throw new AwError('bad_request', 'empty program', hintFor());
  // a bare URL is the most common thing a model sends: treat it as open(url)
  if (/^(https?:\/\/|www\.)\S+$/i.test(text) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) return [{ verb: 'open', args: [text], opts: {}, src: text }];
  const steps: Step[] = [];
  for (const st of splitStatements(text)) {
    const s = parseStatement(st);
    if (s) steps.push(s);
  }
  if (!steps.length) throw new AwError('bad_request', 'no steps in program', hintFor());
  if (steps.length > 40) throw new AwError('bad_request', `too many steps (${steps.length}); the limit is 40 per call`);
  return steps;
}
