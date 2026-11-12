// Bug reports: what is saved, and what is never saved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentweb } from '../src/index.ts';
import { bugsText, readBugs, redactProgram, redactText } from '../src/usage.ts';

test('redaction masks typed secrets, e-mail addresses, tokens and query values, and keeps the rest', () => {
  const p = redactProgram("open('https://x.test/login?next=/home&sid=abc123'); fill('Email', 'jo@example.com'); fill('Password', 'hunter2 !'); fill('Search', 'usb hub'); fill('API key', '{{secret:key}}'); click('Sign in')");
  assert.ok(!p.includes('hunter2') && !p.includes('jo@example.com') && !p.includes('abc123'), p);
  assert.match(p, /fill\('Password', '<redacted>'\)/);
  assert.match(p, /fill\('Email', '<email>'\)/);
  assert.match(p, /fill\('Search', 'usb hub'\)/);
  assert.match(p, /\{\{secret:key\}\}/);
  assert.match(p, /next=<v>&sid=<v>/);
  assert.match(p, /click\('Sign in'\)/);
  assert.equal(redactText('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc'), 'Bearer <token>');
  assert.equal(redactText("click('Sign in by hand') did nothing"), "click('Sign in by hand') did nothing");
});

test("bug() in the tool saves the previous call's program, engine and status lines, never the page", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-bug-'));
  const saved = process.env.AGENTWEB_USAGE_LOG;
  process.env.AGENTWEB_USAGE_LOG = join(dir, 'usage.jsonl');
  const server = createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Shop</title><h1>PAGE-SECRET-CONTENT</h1><form><input name="password" aria-label="Password"><button>Go</button></form>'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rt = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, env: { AGENTWEB_ALLOW_PRIVATE: '1' } });
  try {
    const r1 = await rt.run('s', `open('${base}/'); fill('Password', 'hunter2'); click('Checkout')`);
    assert.ok(!r1.ok);
    const r2 = await rt.run('s', "bug('the Checkout button to be clicked | nothing clickable matches')");
    assert.ok(r2.ok, r2.text);
    assert.match(r2.text, /bug recorded/);
    const [b] = readBugs(1);
    assert.equal(b.from, 'tool');
    assert.equal(b.engine, 'wire');
    assert.match(b.site, /^127\.0\.0\.1:/);
    assert.match(b.program, /fill\('Password', '<redacted>'\); click\('Checkout'\)/);
    assert.equal(b.expected, 'the Checkout button to be clicked');
    assert.equal(b.got, 'nothing clickable matches');
    assert.match(b.result ?? '', /✗ click\('Checkout'\)/);
    assert.match(b.version, /^\d+\.\d+\.\d+/);
    const raw = readFileSync(join(dir, 'bugs.jsonl'), 'utf8');
    assert.ok(!raw.includes('hunter2') && !raw.includes('PAGE-SECRET-CONTENT'), raw);

    // in the same call as the steps: that call's program is the one saved
    await rt.run('s', `open('${base}/'); bug('a heading | none')`);
    const all = readBugs(1);
    assert.equal(all.length, 2);
    assert.match(all[1].program, /^open\(.*\); bug\(/);
    assert.match(bugsText(1), /2 bug report\(s\)/);
  } finally {
    await rt.close();
    await new Promise<void>((r) => server.close(() => r()));
    if (saved === undefined) delete process.env.AGENTWEB_USAGE_LOG;
    else process.env.AGENTWEB_USAGE_LOG = saved;
  }
});

test('agentweb bug on the command line: site | program | expected | got, and a program may contain |', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aw-bugcli-'));
  const env = { ...process.env, AGENTWEB_USAGE_LOG: join(dir, 'usage.jsonl') };
  const cli = new URL('../src/cli.ts', import.meta.url).pathname;
  const out = execFileSync(process.execPath, [cli, 'bug', "localhost:3987 | open('http://localhost:3987/a'); js('a || b') | the dialog opens | no visible change", '--engine', 'ghost'], { env, encoding: 'utf8' });
  assert.match(out, /bug recorded/);
  const b = JSON.parse(readFileSync(join(dir, 'bugs.jsonl'), 'utf8').trim());
  assert.equal(b.site, 'localhost:3987');
  assert.equal(b.program, "open('http://localhost:3987/a'); js('a || b')");
  assert.equal(b.expected, 'the dialog opens');
  assert.equal(b.got, 'no visible change');
  assert.equal(b.engine, 'ghost');
  assert.equal(b.from, 'cli');
  assert.match(execFileSync(process.execPath, [cli, 'bugs'], { env, encoding: 'utf8' }), /1 bug report\(s\)[\s\S]*the dialog opens/);
  assert.throws(() => execFileSync(process.execPath, [cli, 'bug', 'only | two'], { env, encoding: 'utf8', stdio: 'pipe' }));
});

test("find('$') finds prices, and a bare amount finds the priced line", async () => {
  const { parseHtml, compile, renderFind } = await import('../src/index.ts');
  const page = compile(parseHtml('<html><body><main><h1>Drives</h1><p>Samsung 990 Pro 2TB</p><p>Now $359.99 each</p><p>Ships free</p></main></body></html>'), 'https://x.test/', { tier: 'wire', status: 200, method: 'GET', bytes: 0, ms: 0 });
  const refs = { ref: () => 0 } as any;
  for (const q of ['$', '359.99']) {
    const r = renderFind(page, { seq: 1, seen: {} }, refs, q, 500);
    assert.match(r.text, /\$359\.99/, q + ' -> ' + r.text);
  }
});
