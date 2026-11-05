// HTML form submission (WHATWG "constructing the entry list" + the three encodings) over the
// static FormDef model. Pure: no I/O, no randomness unless a multipart boundary is generated.

import { randomBytes } from 'node:crypto';
import type { Field, FormDef } from '../types.ts';

export interface EncodedForm {
  url: string;
  method: 'GET' | 'POST';
  body?: string | Uint8Array;
  contentType?: string;
}

export interface EncodeOptions {
  /** fixed multipart boundary (tests); default is random */
  boundary?: string;
}

const BUTTONS = new Set(['submit', 'image', 'button', 'reset']);
const NEVER = new Set(['button', 'reset']);

/** Build the form data set: ordered [name, value] entries (file inputs give their filename ''). */
export function entryList(form: FormDef, submitter?: Field): { name: string; value: string; file?: boolean }[] {
  const out: { name: string; value: string; file?: boolean }[] = [];
  const sub = submitter ? resolveSubmitter(form, submitter) : undefined;
  for (const f of form.fields) {
    const type = (f.type || 'text').toLowerCase();
    if (f.disabled) continue;
    if (NEVER.has(type)) continue;
    if (type === 'submit' || type === 'image') {
      if (f !== sub) continue;
      if (type === 'image') {
        const p = f.name ? `${f.name}.` : '';
        out.push({ name: `${p}x`, value: '0' }, { name: `${p}y`, value: '0' });
        continue;
      }
      if (!f.name) continue;
      out.push({ name: f.name, value: f.value ?? '' });
      continue;
    }
    if (!f.name) continue;
    if (type === 'checkbox' || type === 'radio') {
      if (!f.checked) continue;
      // the model cannot tell a missing value attribute from value="": both send "on"
      out.push({ name: f.name, value: f.value ? f.value : 'on' });
      continue;
    }
    if (type === 'select') {
      for (const v of selectValues(f)) out.push({ name: f.name, value: v });
      continue;
    }
    if (type === 'file') {
      out.push({ name: f.name, value: '', file: true });
      continue;
    }
    if (type === 'hidden' && f.name.toLowerCase() === '_charset_') {
      out.push({ name: f.name, value: 'UTF-8' });
      continue;
    }
    let v = f.value ?? '';
    if (type === 'textarea') v = v.replace(/\r\n|\r|\n/g, '\r\n');
    else if (type !== 'hidden') v = v.replace(/[\r\n]/g, ''); // single-line inputs strip newlines
    out.push({ name: f.name, value: v });
  }
  return out;
}

function resolveSubmitter(form: FormDef, s: Field): Field | undefined {
  if (form.fields.includes(s)) return s;
  const t = (s.type || '').toLowerCase();
  if (!BUTTONS.has(t)) return undefined;
  return form.fields.find((f) => f.name === s.name && (f.type || '').toLowerCase() === t && f.value === s.value);
}

function selectValues(f: Field): string[] {
  const opts = f.options ?? [];
  if (f.multiple) return opts.filter((o) => o.s).map((o) => o.v);
  if (!opts.length) return f.value ? [f.value] : [];
  // the runtime writes the chosen value into `value`; trust it when it names a real option
  if (f.value !== undefined && f.value !== '' && opts.some((o) => o.v === f.value)) return [f.value];
  let sel: string | undefined;
  for (const o of opts) if (o.s) sel = o.v; // last selected wins, as in HTML parsing
  if (sel !== undefined) return [sel];
  if (f.value === '' && opts.some((o) => o.v === '')) return [''];
  return [opts[0].v]; // a single-select with nothing selected submits its first option
}

/** application/x-www-form-urlencoded serialiser (spaces become '+'). */
export function urlencode(entries: { name: string; value: string }[]): string {
  const p = new URLSearchParams();
  for (const e of entries) p.append(e.name, e.value);
  return p.toString();
}

export function encodeForm(form: FormDef, submitter?: Field, opts: EncodeOptions = {}): EncodedForm {
  const entries = entryList(form, submitter);
  const method = form.method === 'POST' ? 'POST' : 'GET';
  let action: URL;
  try { action = new URL(form.action); } catch { throw new TypeError(`bad form action: ${form.action}`); }

  if (method === 'GET') {
    // "mutate action URL": the query is replaced, the fragment is kept
    action.search = urlencode(entries);
    if (action.search === '?' || action.search === '') action.search = '';
    let url = action.href;
    if (!entries.length && !url.includes('?')) {
      const hash = action.hash;
      url = url.slice(0, url.length - hash.length) + '?' + hash;
    }
    return { url, method };
  }

  const enctype = (form.enctype || '').toLowerCase().trim();
  if (enctype === 'multipart/form-data') {
    const boundary = opts.boundary ?? `----agentweb${randomBytes(12).toString('hex')}`;
    const esc = (s: string) => s.replace(/\r\n|\r|\n/g, '\r\n').replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    let body = '';
    for (const e of entries) {
      body += `--${boundary}\r\n`;
      if (e.file) {
        body += `Content-Disposition: form-data; name="${esc(e.name)}"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n`;
      } else {
        body += `Content-Disposition: form-data; name="${esc(e.name)}"\r\n\r\n${e.value.replace(/\r\n|\r|\n/g, '\r\n')}\r\n`;
      }
    }
    body += `--${boundary}--\r\n`;
    return { url: action.href, method, body, contentType: `multipart/form-data; boundary=${boundary}` };
  }
  if (enctype === 'text/plain') {
    let body = '';
    for (const e of entries) body += `${e.name}=${e.value}\r\n`;
    return { url: action.href, method, body, contentType: 'text/plain;charset=UTF-8' };
  }
  return { url: action.href, method, body: urlencode(entries), contentType: 'application/x-www-form-urlencoded' };
}
