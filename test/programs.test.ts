// Saved programs: the verbs, the files, the CLI, and the rules (no extra rights, depth limit).

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentweb, type Runtime } from '../src/index.ts';
import { programCommand } from '../src/programs/cli.ts';
import { fillPlaceholders, parseProgramText, placeholdersOf, programText } from '../src/programs/files.ts';
import { testCommand } from '../src/test/cli.ts';
import { defaultPolicy } from '../src/guard/index.ts';

let server: Server;
let base = '';
let rt: Runtime;
let dir = '';
const seen: string[] = [];
const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'awprog-'));
  server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push(u.pathname + u.search);
    res.writeHead(200, { 'content-type': 'text/html' });
    if (u.pathname === '/shop') res.end(html('Shop', `<h1>Shop</h1><p>usb hub costs $19.99 today</p><p>desk lamp costs $33.00 today</p><p>query ${u.searchParams.get('q') ?? ''}</p>`));
    else if (u.pathname === '/login') res.end(html('Login', '<h1>Login</h1><form action="/in" method="post"><label>Password <input type="password" name="pw"></label><button>Go</button></form>'));
    else res.end(html('Other', `<h1>Other ${u.pathname}</h1>`));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_PROGRAMS: join(dir, 'programs') } });
});

after(async () => {
  await rt.close();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const sid = () => `p${++n}`;

describe('placeholders', () => {
  it('finds names, ignores {{secret:x}} handles, and escapes values for the quote they sit in', () => {
    assert.deepEqual(placeholdersOf(["open('a'); find('{Item} {item} {{secret:pw}} {{PW}}')", 'js(\'x={a b}\')']), ['item']);
    const v = new Map([['item', `it's; "x"`]]);
    assert.equal(fillPlaceholders(["find('{item}')"], v).steps[0], `find('it\\'s; "x"')`);
    assert.equal(fillPlaceholders(['find("{item}")'], v).steps[0], `find("it's; \\"x\\"")`);
    assert.deepEqual(fillPlaceholders(["find('{a}{b}')"], new Map([['a', '1']])).missing, ['b']);
  });
  it('program files are test files: headers, one step per line', () => {
    const def = parseProgramText('x', programText('x', "open('/a'); find('{q}')"));
    assert.deepEqual(def.steps, ["open('/a')", "find('{q}')"]);
    assert.deepEqual(def.placeholders, ['q']);
  });
});

describe('program() and programs()', () => {
  it('saves, lists, runs with placeholders, shows and deletes', async () => {
    const s = sid();
    const saved = await rt.run(s, `program('Price-Check', save="open('${base}/shop'); find('{item}')")`);
    assert.ok(saved.ok, saved.text);
    assert.match(saved.text, /saved program 'price-check' \(2 steps; fill item=…\)/);
    assert.ok(existsSync(join(dir, 'programs', 'price-check.aw')));
    assert.match(readFileSync(join(dir, 'programs', 'price-check.aw'), 'utf8'), /^# name: price-check\n/);

    const list = await rt.run(s, 'programs()');
    assert.match(list.text, /1 saved program:\nprice-check\(item\) - open\('http:\/\/127\.0\.0\.1:\d+\/shop'\) \(\+1\)/);

    const ran = await rt.run(s, "program('price-check', item='usb hub')");
    assert.ok(ran.ok, ran.text);
    assert.match(ran.text, /\$19\.99/);
    assert.doesNotMatch(ran.text, /\$33\.00/);

    assert.match((await rt.run(s, "program('price-check', show=1)")).text, /find\('\{item\}'\)/);
    assert.match((await rt.run(s, "program('price-check', save=\"open('x.example')\")")).text, /^replaced program/);
    const del = await rt.run(s, "program('price-check', delete=1)");
    assert.match(del.text, /deleted program 'price-check'/);
    assert.match((await rt.run(s, 'programs()')).text, /no saved programs/);
  });

  it('a missing placeholder is an error that lists the placeholders', async () => {
    const s = sid();
    await rt.run(s, `program('two', save="open('${base}/shop?q={a}'); find('{b}')")`);
    const r = await rt.run(s, "program('two', a=1)");
    assert.equal(r.ok, false);
    assert.match(r.text, /needs b=/);
    assert.match(r.text, /placeholders: a, b\. Example: program\('two', a='…', b='…'\)/);
    const none = await rt.run(s, "program('nope')");
    assert.match(none.text, /no saved program 'nope'/);
    assert.match(none.text, /saved programs: .*two/);
  });

  it('a value cannot break out of its argument into a second step', async () => {
    const s = sid();
    await rt.run(s, `program('echo', save="open('${base}/shop'); find('{item}')")`);
    seen.length = 0;
    const r = await rt.run(s, `program('echo', item="x'); open('${base}/evil'); find('y")`);
    assert.ok(r.ok, r.text);
    assert.ok(!seen.some((p) => p.startsWith('/evil')), `fetched ${seen.join(',')}`);
  });

  it('names are file names: no path escapes', async () => {
    const r = await rt.run(sid(), "program('../../etc/x', save=\"open('a.example')\")");
    assert.equal(r.ok, false);
    assert.match(r.text, /not a usable program name/);
    assert.equal(readdirSync(dir).includes('etc'), false);
  });

  it('refuses to save text that does not parse, and a stored secret value', async () => {
    const bad = await rt.run(sid(), "program('bad', save=\"frobnicate('x')\")");
    assert.equal(bad.ok, false);
    assert.match(bad.text, /not saved: unknown verb 'frobnicate'/);
    assert.ok(!existsSync(join(dir, 'programs', 'bad.aw')));

    const policy = defaultPolicy('local');
    policy.secrets = [{ name: 'pw', value: 'hunter2-secret', origins: [base] }];
    const guarded = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, policy, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_PROGRAMS: join(dir, 'programs') } });
    try {
      const r = await guarded.run('g', "program('leak', save=\"open('x.example'); fill('Password', 'hunter2-secret')\")");
      assert.equal(r.ok, false);
      assert.match(r.text, /contains a stored secret value/);
      assert.match(r.text, /\{\{secret:NAME\}\}/);
      assert.ok(!existsSync(join(dir, 'programs', 'leak.aw')));
    } finally {
      await guarded.close();
    }
  });

  it('runs with the caller\'s guard: a refused address stays refused inside a program', async () => {
    const strict = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, env: { AGENTWEB_ALLOW_PRIVATE: '0', AGENTWEB_PROGRAMS: join(dir, 'programs') } });
    try {
      await strict.run('s', `program('local', save="open('${base}/shop')")`);
      const r = await strict.run('s', "program('local')");
      assert.equal(r.ok, false);
      assert.match(r.text, /in program 'local' step 1 \(open\(/);
    } finally {
      await strict.close();
    }
  });

  it('a failing step names the program and step; the code and hint are kept', async () => {
    const s = sid();
    await rt.run(s, `program('fails', save="open('${base}/shop'); expect('not on the page')")`);
    const r = await rt.run(s, "program('fails')");
    assert.equal(r.ok, false);
    assert.match(r.text, /in program 'fails' step 2 \(expect\('not on the page'\)\): 'not on the page' is not on the page/);
    assert.match(r.text, /^✗/);
  });

  it('programs call programs, three deep and no deeper', async () => {
    const s = sid();
    await rt.run(s, `program('leaf', save="open('${base}/shop')")`);
    await rt.run(s, "program('l2', save=\"program('leaf')\")");
    await rt.run(s, "program('l3', save=\"program('l2')\")");
    await rt.run(s, "program('l4', save=\"program('l3')\")");
    const ok = await rt.run(s, "program('l3')"); // l3 -> l2 -> leaf: three levels
    assert.ok(ok.ok, ok.text);
    const deep = await rt.run(s, "program('l4')"); // one more
    assert.equal(deep.ok, false);
    assert.match(deep.text, /only 3 deep/);
    // a program calling itself ends the same way instead of looping
    await rt.run(s, "program('loop', save=\"program('loop')\")");
    const loop = await rt.run(s, "program('loop')");
    assert.equal(loop.ok, false);
    assert.match(loop.text, /only 3 deep/);
  });

  it('`# base:` and `# profile:` headers in a stored file are honoured', async () => {
    const s = sid();
    writeFileSync(join(dir, 'programs', 'rel.aw'), `# name: rel\n# base: ${base}\n\nopen('/shop')\nfind('hub')\n`);
    const r = await rt.run(s, "program('rel')");
    assert.ok(r.ok, r.text);
    assert.match(r.text, /usb hub/);
  });
});

describe('agentweb program (command line)', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
  };
  const env = () => ({ AGENTWEB_PROGRAMS: join(dir, 'cliprograms'), AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_STORE: 'memory:' });

  it('save, list, show, run key=value, delete', async () => {
    const e = env();
    let c = io();
    assert.equal(await programCommand(['save', 'shop-find', `open('${base}/shop'); find('{item}')`], c.io, e), 0, c.err.join());
    assert.match(c.out[0], /saved shop-find \(2 steps; placeholders: item\)/);
    c = io();
    assert.equal(await programCommand(['list'], c.io, e), 0);
    assert.match(c.out[0], /^shop-find\(item\) - open\(/);
    c = io();
    assert.equal(await programCommand(['show', 'shop-find'], c.io, e), 0);
    assert.match(c.out[0], /# name: shop-find/);
    c = io();
    assert.equal(await programCommand(['run', 'shop-find', 'item=desk lamp', '--no-chrome', '--no-ghost'], c.io, e), 0, c.err.join());
    assert.match(c.out[0], /\$33\.00/);
    c = io();
    assert.equal(await programCommand(['run', 'shop-find', '--no-chrome', '--no-ghost'], c.io, e), 1);
    assert.match(c.out[0], /needs item=/);
    c = io();
    assert.equal(await programCommand(['delete', 'shop-find'], c.io, e), 0);
    assert.equal(await programCommand(['show', 'shop-find'], io().io, e), 1);
    assert.equal(await programCommand(['save', 'x', 'frobnicate()'], io().io, e), 1);
  });

  it('a recording from `agentweb test --record` saves as a program, and a program runs as a test', async () => {
    const e = env();
    const old = process.env.AGENTWEB_ALLOW_PRIVATE;
    process.env.AGENTWEB_ALLOW_PRIVATE = '1';
    try {
      const file = join(dir, 'rec.aw');
      const c = io();
      assert.equal(await testCommand(['--record', file, `open('${base}/shop'); expect('usb hub')`, '--base', base], c.io), 0, c.out.join() + c.err.join());
      const s = io();
      assert.equal(await programCommand(['save', 'recorded', '--from', file], s.io, e), 0, s.err.join());
      assert.match(readFileSync(join(dir, 'cliprograms', 'recorded.aw'), 'utf8'), /# base: http:\/\/127\.0\.0\.1:\d+/);
      const run = io();
      assert.equal(await programCommand(['run', 'recorded', '--no-chrome', '--no-ghost'], run.io, e), 0, run.out.join());
      // and the stored file is a test: the same file, run by `agentweb test`
      const t = io();
      assert.equal(await testCommand([join(dir, 'cliprograms', 'recorded.aw')], t.io), 0, t.out.join() + t.err.join());
    } finally {
      if (old === undefined) delete process.env.AGENTWEB_ALLOW_PRIVATE;
      else process.env.AGENTWEB_ALLOW_PRIVATE = old;
    }
  });
});
