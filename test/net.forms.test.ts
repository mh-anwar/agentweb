import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeForm } from '../src/net/forms.ts';
import type { Field, FormDef } from '../src/types.ts';

const form = (fields: Field[], over: Partial<FormDef> = {}): FormDef => ({
  key: 'k',
  action: 'https://shop.example/search?old=1#results',
  method: 'GET',
  enctype: 'application/x-www-form-urlencoded',
  fields,
  ...over,
});

const fields: Field[] = [
  { name: 'q', type: 'text', value: 'red shoes & socks' },
  { name: 'hidden', type: 'hidden', value: 'h' },
  { name: 'off', type: 'text', value: 'nope', disabled: true },
  { name: 'cb1', type: 'checkbox', value: 'yes', checked: true },
  { name: 'cb2', type: 'checkbox', value: 'no', checked: false },
  { name: 'cb3', type: 'checkbox', value: '', checked: true },
  { name: 'size', type: 'radio', value: 's', checked: false },
  { name: 'size', type: 'radio', value: 'm', checked: true },
  { name: 'color', type: 'select', value: '', options: [{ l: 'Red', v: 'r' }, { l: 'Blue', v: 'b', s: true }] },
  { name: 'tags', type: 'select', value: '', multiple: true, options: [{ l: 'A', v: 'a', s: true }, { l: 'B', v: 'b' }, { l: 'C', v: 'c', s: true }] },
  { name: 'first', type: 'select', value: '', options: [{ l: 'One', v: '1' }, { l: 'Two', v: '2' }] },
  { name: 'note', type: 'textarea', value: 'line1\nline2' },
  { name: '', type: 'text', value: 'nameless' },
  { name: 'go', type: 'submit', value: 'Search' },
  { name: 'other', type: 'submit', value: 'Other' },
  { name: 'btn', type: 'button', value: 'x' },
  { name: 'rst', type: 'reset', value: 'r' },
];

test('GET: successful controls only, query replaced, fragment kept', () => {
  const r = encodeForm(form(fields), fields[13]);
  assert.equal(r.method, 'GET');
  assert.equal(r.body, undefined);
  assert.equal(
    r.url,
    'https://shop.example/search?q=red+shoes+%26+socks&hidden=h&cb1=yes&cb3=on&size=m&color=b&tags=a&tags=c&first=1&note=line1%0D%0Aline2&go=Search#results',
  );
});

test('no submitter: no button is sent; submitter matched by value when not the same object', () => {
  const r = encodeForm(form(fields));
  assert.ok(!r.url.includes('go=') && !r.url.includes('other='));
  const r2 = encodeForm(form(fields), { name: 'other', type: 'submit', value: 'Other' });
  assert.ok(r2.url.includes('other=Other') && !r2.url.includes('go='));
});

test('select value written by the runtime wins over the parsed selection', () => {
  const f = form([{ name: 'color', type: 'select', value: 'r', options: [{ l: 'Red', v: 'r' }, { l: 'Blue', v: 'b', s: true }] }]);
  assert.equal(encodeForm(f).url, 'https://shop.example/search?color=r#results');
});

test('empty GET form still yields a "?"', () => {
  assert.equal(encodeForm(form([], { action: 'https://e.com/s' })).url, 'https://e.com/s?');
});

test('POST urlencoded: + for spaces, WHATWG escaping', () => {
  const r = encodeForm(form([{ name: 'a b', type: 'text', value: "x y~*-._!'()€" }, { name: '_charset_', type: 'hidden', value: '' }], { method: 'POST', action: 'https://e.com/post?keep=1' }));
  assert.equal(r.url, 'https://e.com/post?keep=1');
  assert.equal(r.contentType, 'application/x-www-form-urlencoded');
  assert.equal(r.body, 'a+b=x+y%7E*-._%21%27%28%29%E2%82%AC&_charset_=UTF-8');
});

test('image submitter sends .x/.y', () => {
  const img: Field = { name: 'map', type: 'image', value: '' };
  const r = encodeForm(form([{ name: 'q', type: 'text', value: '1' }, img], { method: 'POST', action: 'https://e.com/' }), img);
  assert.equal(r.body, 'q=1&map.x=0&map.y=0');
});

test('multipart/form-data with a fixed boundary', () => {
  const sub: Field = { name: 'send', type: 'submit', value: 'Send' };
  const f = form(
    [
      { name: 'title', type: 'text', value: 'Hello "world"' },
      { name: 'body', type: 'textarea', value: 'a\nb' },
      { name: 'up', type: 'file', value: '' },
      { name: 'na"me\n', type: 'hidden', value: 'v' },
      sub,
    ],
    { method: 'POST', enctype: 'multipart/form-data', action: 'https://e.com/up' },
  );
  const r = encodeForm(f, sub, { boundary: 'XyZ' });
  assert.equal(r.contentType, 'multipart/form-data; boundary=XyZ');
  assert.equal(
    r.body,
    '--XyZ\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello "world"\r\n' +
      '--XyZ\r\nContent-Disposition: form-data; name="body"\r\n\r\na\r\nb\r\n' +
      '--XyZ\r\nContent-Disposition: form-data; name="up"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n' +
      '--XyZ\r\nContent-Disposition: form-data; name="na%22me%0D%0A"\r\n\r\nv\r\n' +
      '--XyZ\r\nContent-Disposition: form-data; name="send"\r\n\r\nSend\r\n' +
      '--XyZ--\r\n',
  );
  const r2 = encodeForm(f);
  assert.match(r2.contentType!, /^multipart\/form-data; boundary=----agentweb[0-9a-f]{24}$/);
});

test('text/plain and unknown enctype', () => {
  const f = form([{ name: 'a', type: 'text', value: 'x y' }, { name: 'b', type: 'text', value: '2' }], { method: 'POST', enctype: 'text/plain', action: 'https://e.com/' });
  const r = encodeForm(f);
  assert.equal(r.body, 'a=x y\r\nb=2\r\n');
  assert.equal(r.contentType, 'text/plain;charset=UTF-8');
  const r2 = encodeForm({ ...f, enctype: 'weird/thing' });
  assert.equal(r2.contentType, 'application/x-www-form-urlencoded');
  assert.equal(r2.body, 'a=x+y&b=2');
});

test('urlencoded file input sends empty filename; single-line inputs strip newlines', () => {
  const r = encodeForm(form([{ name: 'f', type: 'file', value: '' }, { name: 't', type: 'text', value: 'a\r\nb' }], { method: 'POST', action: 'https://e.com/' }));
  assert.equal(r.body, 'f=&t=ab');
});
