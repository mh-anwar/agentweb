// login('name'): sign in from a stored credential, typed only on the site it is bound to, never shown to the agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentweb } from '../src/index.ts';

let server: Server;
let base = '';
const seen: string[] = [];
const page = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const send = (html: string, status = 200, headers: Record<string, string> = {}) => res.writeHead(status, { 'content-type': 'text/html', ...headers }).end(html);
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      const f = new URLSearchParams(body);
      if (req.method === 'POST') seen.push(u.pathname + ' ' + body);
      if (u.pathname === '/') return send(page('Home', '<p>Welcome.</p><a href="/login">Sign in</a>'));
      if (u.pathname === '/login' && req.method === 'GET') return send(page('Sign in', '<form method="post" action="/login"><label>Email <input name="email" type="email"></label><label>Password <input name="pw" type="password"></label><button>Sign in</button></form>'));
      if (u.pathname === '/login') return f.get('email') === 'maya@example.com' && f.get('pw') === 'correct-horse-9' ? send('', 303, { location: '/account', 'set-cookie': 'sid=1; Path=/' }) : send(page('Sign in', '<p>Wrong email or password.</p><form method="post" action="/login"><input name="email" type="email" aria-label="Email"><input name="pw" type="password" aria-label="Password"><button>Sign in</button></form>'));
      if (u.pathname === '/account') return send(page('Account', /sid=1/.test(req.headers.cookie ?? '') ? '<p>Signed in as Maya.</p>' : '<p>Not signed in.</p>'));
      // user name first, password on the next page
      if (u.pathname === '/two' && req.method === 'GET') return send(page('Sign in', '<form method="post" action="/two"><label>Email or phone <input name="id" type="text"></label><button>Next</button></form>'));
      if (u.pathname === '/two') return send(page('Welcome back', `<form method="post" action="/two/pw"><input type="hidden" name="id" value="${f.get('id')}"><label>Enter your password <input name="pw" type="password"></label><button>Next</button></form>`));
      if (u.pathname === '/two/pw') return f.get('id') === 'maya@example.com' && f.get('pw') === 'correct-horse-9' ? send('', 303, { location: '/account', 'set-cookie': 'sid=1; Path=/' }) : send(page('Sign in', '<p>Wrong.</p>'));
      send(page('Not found', ''), 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const mk = (extra: Record<string, string> = {}) =>
  createAgentweb({
    store: 'memory:', ghost: false, chrome: false, atlas: false,
    env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_SECRET_SHOP: 'correct-horse-9', AGENTWEB_SECRET_SHOP_ORIGINS: base, AGENTWEB_SECRET_SHOP_USER: 'maya@example.com', ...extra },
  });

test("login('name') opens the site, follows its sign-in link, types both fields and submits; nothing secret is shown", async () => {
  const rt = await mk();
  try {
    const r = await rt.run('a', "login('shop')");
    assert.ok(r.ok, r.text);
    assert.match(r.text, /note: signed in as 'shop'/);
    assert.match(r.text, /Signed in as Maya/);
    assert.doesNotMatch(r.text, /correct-horse-9|maya@example\.com/);
    assert.ok(seen.includes('/login email=maya%40example.com&pw=correct-horse-9'), seen.join(' | '));
  } finally {
    await rt.close();
  }
});

test('a form that asks for the user name first', async () => {
  const rt = await mk();
  try {
    const r = await rt.run('b', `login('shop', url='${base}/two')`);
    assert.ok(r.ok, r.text);
    assert.match(r.text, /Signed in as Maya/);
  } finally {
    await rt.close();
  }
});

test('a wrong password leaves the form and says so; an unknown name lists the stored ones', async () => {
  const rt = await mk({ AGENTWEB_SECRET_SHOP: 'wrong-pass-1' });
  try {
    const r = await rt.run('c', "login('shop')");
    assert.match(r.text, /note: the sign-in form is still showing/);
    assert.match(r.text, /Wrong email or password/);
    const u = await rt.run('c', "login('bank')");
    assert.equal(u.ok, false);
    assert.match(u.text, /no stored sign-in is called 'bank'\nstored: shop/);
  } finally {
    await rt.close();
  }
});

test('the credential is never typed on a site it is not bound to', async () => {
  const rt = await mk({ AGENTWEB_SECRET_SHOP_ORIGINS: 'https://shop.example' });
  try {
    const before = seen.length;
    const r = await rt.run('d', `login('shop', url='${base}/login')`);
    assert.equal(r.ok, false);
    assert.match(r.text, /the sign-in form is on http:\/\/127\.0\.0\.1:\d+, and 'shop' is bound to https:\/\/shop\.example/);
    assert.equal(seen.length, before, 'nothing was posted');
  } finally {
    await rt.close();
  }
});
