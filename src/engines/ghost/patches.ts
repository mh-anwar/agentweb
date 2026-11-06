// Process-wide changes to jsdom and node:vm, applied once in the page process before any page
// exists. jsdom stops at "navigation to another Document", form submission, modules and
// cross-document history; these hooks hand each of those to the page that owns the document.
// Everything here touches jsdom internals (lib/jsdom/living/**): pinned to jsdom 31.

import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { NavIntent } from './protocol.ts';

const req = createRequire(import.meta.url);
const jsdomMain = req.resolve('jsdom');
const jsdomDir = path.dirname(path.dirname(jsdomMain)); // <pkg>/lib/api.js -> <pkg>
const fromJsdom = createRequire(jsdomMain);
const lib = (p: string) => req(path.join(jsdomDir, 'lib', p));

export const jsdom = req('jsdom');
export const idl = lib('generated/idl/utils.js');
export const reportException: (win: any, e: unknown, filename?: string) => void = lib('jsdom/living/helpers/runtime-script-errors.js');
const whatwgURL = fromJsdom('whatwg-url');
const { fireAnEvent } = lib('jsdom/living/helpers/events.js');
const SubmitEvent = lib('generated/idl/SubmitEvent.js');
const { isSubmitButton } = lib('jsdom/living/helpers/form-controls.js');

/** what a page must provide to the hooks */
export interface HookedPage {
  win: any;
  cpuMs: number;
  navigate(intent: NavIntent): void;
  note(kind: string, msg: string): void;
  cpuKilled(): void;
  dynamicImport(specifier: string, referrer: string, attrs: unknown): Promise<any>;
  moduleScript(el: any, parserInserted: boolean): void;
  importMap(text: string): void;
}

const byDoc = new WeakMap<object, HookedPage>();
const byCtx = new WeakMap<object, HookedPage>();

export function register(page: HookedPage, ctx: object): void {
  byDoc.set(idl.implForWrapper(page.win.document), page);
  byCtx.set(ctx, page);
}

const pageOf = (docImpl: any): HookedPage | undefined => (docImpl ? byDoc.get(docImpl) : undefined);

/** does going to `url` leave the current document? (fragment-only changes and javascript: stay) */
const leaves = (cur: any, url: any): boolean => {
  if (url.scheme === 'javascript') return false;
  if (whatwgURL.serializeURL(cur, true) !== whatwgURL.serializeURL(url, true)) return true;
  return url.fragment === null; // same URL, no fragment: a reload
};

let installed = false;

export function installPatches(): void {
  if (installed) return;
  installed = true;

  // ── classic scripts: CPU budget, dynamic import() ──
  const runInContext = vm.runInContext;
  (vm as any).runInContext = function (code: string, ctx: any, opts?: any) {
    const page = ctx ? byCtx.get(ctx) : undefined;
    if (!page) return runInContext.call(vm, code, ctx, opts);
    const o = typeof opts === 'string' ? { filename: opts } : opts || {};
    const filename = o.filename || String(page.win.location.href);
    const script = new vm.Script(String(code), {
      filename,
      lineOffset: o.lineOffset,
      importModuleDynamically: ((spec: string, _s: unknown, attrs: unknown) => page.dynamicImport(spec, filename, attrs)) as any,
    });
    try {
      return script.runInContext(ctx, { displayErrors: false, timeout: page.cpuMs });
    } catch (e: any) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') page.cpuKilled();
      throw e;
    }
  };

  // ── <script type=module>, <script type=importmap>, nomodule ──
  const ScriptImpl = lib('jsdom/living/nodes/HTMLScriptElement-impl.js').implementation;
  const prepare = ScriptImpl.prototype._prepare;
  const seen = new WeakSet<object>();
  ScriptImpl.prototype._prepare = function (this: any, parserSignal: unknown) {
    const page = pageOf(this._ownerDocument);
    if (page && !seen.has(this)) {
      const type = String(this.getAttributeNS(null, 'type') ?? '').trim().toLowerCase();
      if (type === 'module' || type === 'importmap') {
        if (!this.isConnected) return undefined;
        const text = this.textContent || '';
        if (!this.hasAttributeNS(null, 'src') && !text.trim()) return undefined;
        seen.add(this);
        if (type === 'importmap') page.importMap(text);
        else page.moduleScript(this, this._ownerDocument.readyState === 'loading');
        return undefined;
      }
      // a browser with modules skips nomodule fallbacks; running both renders the app twice
      if (this.hasAttributeNS(null, 'nomodule')) return undefined;
    }
    return prepare.call(this, parserSignal);
  };

  // ── location.assign / href / replace / reload ──
  const LocationImpl = lib('jsdom/living/window/Location-impl.js').implementation;
  const locNavigate = LocationImpl.prototype._locationObjectNavigate;
  LocationImpl.prototype._locationObjectNavigate = function (this: any, url: any, flags: any = {}) {
    const docImpl = this._relevantDocument;
    const page = pageOf(docImpl);
    if (!page || !leaves(docImpl._URL, url)) return locNavigate.call(this, url, flags);
    page.navigate({ url: whatwgURL.serializeURL(url), method: 'GET', why: 'script', replace: !!flags.replacement });
  };
  LocationImpl.prototype.reload = function (this: any) {
    const docImpl = this._relevantDocument;
    const page = pageOf(docImpl);
    if (page) page.navigate({ url: whatwgURL.serializeURL(docImpl._URL), method: 'GET', why: 'script', replace: true });
  };

  // ── following links (<a>, <area>) ──
  for (const file of ['HTMLAnchorElement-impl.js', 'HTMLAreaElement-impl.js']) {
    const proto = lib('jsdom/living/nodes/' + file).implementation.prototype;
    const follow = proto._followAHyperlink;
    proto._followAHyperlink = function (this: any) {
      const docImpl = this._ownerDocument;
      const page = pageOf(docImpl);
      if (!page || (this._cannotNavigate && this._cannotNavigate())) return follow.call(this);
      const url = docImpl.encodingParseAURL(this.href);
      if (!url || !leaves(docImpl._URL, url)) return follow.call(this);
      const href = whatwgURL.serializeURL(url);
      if (this.hasAttributeNS(null, 'download')) return page.note('download', 'download not saved: ' + href);
      const target = String(this.getAttributeNS(null, 'target') ?? '').trim();
      if (target && !/^_(self|top|parent)$/i.test(target)) page.note('popup', 'link targets a new window; followed in this one');
      page.navigate({ url: href, method: 'GET', why: 'link' });
    };
  }

  // ── form submission ──
  const FormImpl = lib('jsdom/living/nodes/HTMLFormElement-impl.js').implementation;
  FormImpl.prototype.requestSubmit = function (this: any, submitter: any = null) {
    if (submitter !== null) {
      if (!isSubmitButton(submitter)) throw new TypeError('The specified element is not a submit button');
      if (submitter.form !== this) throw new TypeError('The specified element is not owned by this form element');
    }
    const page = pageOf(this._ownerDocument);
    const novalidate = this.hasAttributeNS(null, 'novalidate') || (submitter && submitter.hasAttributeNS(null, 'formnovalidate'));
    if (!novalidate && !this.reportValidity()) {
      if (page) page.note('form', 'the form was not submitted: ' + invalidFields(this));
      return;
    }
    if (!fireAnEvent('submit', this, SubmitEvent, { bubbles: true, cancelable: true, submitter })) return;
    submitForm(this, submitter);
  };
  FormImpl.prototype.submit = function (this: any) {
    submitForm(this, null);
  };

  // ── history.back() past the first entry of this document ──
  const HistoryImpl = lib('jsdom/living/window/History-impl.js').implementation;
  const go = HistoryImpl.prototype.go;
  HistoryImpl.prototype.go = function (this: any, delta: number) {
    const sh = this._window && this._window._sessionHistory;
    const page = this._window && pageOf(idl.implForWrapper(this._window.document));
    delta = Math.trunc(+delta || 0);
    if (page && sh && delta < 0 && sh._currentIndex + delta < 0) {
      page.navigate({ url: '', method: 'GET', why: 'history', delta: sh._currentIndex + delta });
      return;
    }
    return go.call(this, delta);
  };
}

function invalidFields(formImpl: any): string {
  const out: string[] = [];
  try {
    for (const el of formImpl.elements) {
      if (typeof el.checkValidity === 'function' && !el.checkValidity()) {
        const name = el.getAttributeNS(null, 'name') || el.getAttributeNS(null, 'id') || el.localName;
        out.push(`${name} (${el.validationMessage || 'invalid'})`);
        if (out.length >= 4) break;
      }
    }
  } catch {}
  return out.length ? 'invalid ' + out.join(', ') : 'a field failed validation';
}

/** https://html.spec.whatwg.org/#form-submission-algorithm, the parts that matter without a UI */
function submitForm(formImpl: any, submitterImpl: any): void {
  const docImpl = formImpl._ownerDocument;
  const page = pageOf(docImpl);
  if (!page || !formImpl.isConnected) return;
  const win = page.win;
  const form = idl.wrapperForImpl(formImpl);
  const sub = submitterImpl ? idl.wrapperForImpl(submitterImpl) : null;
  const attr = (name: string, subName: string) => (sub && sub.hasAttribute(subName) ? sub.getAttribute(subName) : form.getAttribute(name));
  const method = String(attr('method', 'formmethod') || 'get').trim().toLowerCase();
  if (method === 'dialog') {
    const dialog = form.closest('dialog');
    if (dialog && typeof dialog.close === 'function') dialog.close(sub ? sub.value : undefined);
    return;
  }
  const actionAttr = attr('action', 'formaction');
  let action: URL;
  try {
    action = new URL(actionAttr && String(actionAttr).trim() ? String(actionAttr).trim() : String(win.document.URL), String(win.document.baseURI));
  } catch {
    page.note('form', 'the form has an invalid action URL');
    return;
  }
  const target = String(attr('target', 'formtarget') || '').trim();
  if (target && !/^_(self|top|parent)$/i.test(target)) page.note('popup', 'form targets a new window; submitted in this one');
  if (action.protocol === 'javascript:') {
    win.location.href = action.href;
    return;
  }
  const entries: [string, any][] = [];
  try {
    for (const [k, v] of new win.FormData(form, sub)) entries.push([String(k), v]);
  } catch {
    for (const [k, v] of new win.FormData(form)) entries.push([String(k), v]);
  }
  const enctype = String(attr('enctype', 'formenctype') || '').trim().toLowerCase();
  const strPairs = entries.map(([k, v]) => [k, typeof v === 'string' ? v : String((v && v.name) || '')]);
  if (method !== 'post') {
    action.search = new URLSearchParams(strPairs).toString();
    page.navigate({ url: action.href, method: 'GET', why: 'form' });
    return;
  }
  const enc = new TextEncoder();
  let body: Uint8Array;
  let contentType: string;
  if (enctype === 'multipart/form-data') {
    const boundary = '----agentweb' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const esc = (s: string) => s.replace(/\r?\n|\r/g, '%0D%0A').replace(/"/g, '%22');
    let s = '';
    for (const [k, v] of entries) {
      if (typeof v === 'string') s += `--${boundary}\r\nContent-Disposition: form-data; name="${esc(k)}"\r\n\r\n${v.replace(/\r?\n|\r/g, '\r\n')}\r\n`;
      // file bodies would need an async read; files only come from `upload`, which ghost does not do
      else s += `--${boundary}\r\nContent-Disposition: form-data; name="${esc(k)}"; filename="${esc(String((v && v.name) || ''))}"\r\nContent-Type: application/octet-stream\r\n\r\n\r\n`;
    }
    s += `--${boundary}--\r\n`;
    body = enc.encode(s);
    contentType = 'multipart/form-data; boundary=' + boundary;
  } else if (enctype === 'text/plain') {
    body = enc.encode(strPairs.map(([k, v]) => `${k}=${v}\r\n`).join(''));
    contentType = 'text/plain';
  } else {
    body = enc.encode(new URLSearchParams(strPairs).toString());
    contentType = 'application/x-www-form-urlencoded';
  }
  page.navigate({ url: action.href, method: 'POST', body, contentType, why: 'form' });
}
