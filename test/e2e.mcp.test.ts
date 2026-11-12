// End to end through the shipped artifact: dist/agentweb.mjs as an MCP stdio server, driven the
// way an agent harness drives it, against the local farm. Run `npm run build` first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFarm, type Farm } from '../bench/sites/farm.ts';

const BIN = new URL('../dist/agentweb.mjs', import.meta.url).pathname;
let farm: Farm;
let proc: ChildProcessWithoutNullStreams;
let home: string;
let nextId = 1;
const pending = new Map<number, (m: any) => void>();

function rpc(method: string, params?: unknown): Promise<any> {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
    pending.set(id, (m) => (clearTimeout(t), resolve(m)));
  });
}
const call = async (run: string) => {
  const m = await rpc('tools/call', { name: 'web', arguments: { run, session: 'e2e' } });
  assert.ok(m.result, JSON.stringify(m));
  return { text: m.result.content.map((c: any) => c.text ?? '').join('\n') as string, isError: !!m.result.isError };
};

before(async () => {
  assert.ok(existsSync(BIN), 'run `npm run build` first');
  farm = await startFarm({ seed: 7 });
  home = mkdtempSync(join(tmpdir(), 'aw-e2e-'));
  proc = spawn(process.execPath, [BIN, 'mcp', '--store', 'memory:', '--no-chrome', '--no-ghost'], {
    env: {
      ...process.env,
      AGENTWEB_HOME: home,
      AGENTWEB_SECRET_BANK: farm.truth.bank.password,
      AGENTWEB_SECRET_BANK_ORIGINS: farm.url,
    },
  }) as ChildProcessWithoutNullStreams;
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d: string) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line); // stdout must carry nothing but protocol messages
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
});

after(async () => {
  proc?.stdin.end();
  proc?.kill();
  await farm?.close();
  rmSync(home, { recursive: true, force: true });
});

test('MCP handshake exposes exactly one small tool', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'agentweb');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc('tools/list');
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['web']);
  assert.match(list.result.tools[0].description, /with NAME one of bank; values are never shown/);
});

test('log in with a stored secret, read the balance, in one call', async () => {
  const acct = farm.truth.bank.accounts[0];
  const r = await call(`open('${farm.url}/bank/login'); fill('User ID', '${farm.truth.bank.user}'); fill('Password', '{{secret:bank}}'); submit(); expect('${acct.name}')`);
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes(acct.number) || r.text.includes(acct.name), r.text);
  assert.ok(!r.text.includes(farm.truth.bank.password), 'the password must never reach the model');
  const logins = farm.state().logins.filter((l: any) => l.site === 'bank');
  assert.deepEqual(logins.map((l: any) => l.ok), [true], 'the server saw exactly one successful login');
});

test('the session persists between calls (cookie kept server-side by agentweb)', async () => {
  const r = await call(`open('${farm.url}/bank/'); find('balance')`);
  assert.equal(r.isError, false, r.text);
  assert.doesNotMatch(r.text, /Log in/i);
});

test('a secret is refused on another origin', async () => {
  const r = await call(`open('${farm.other}/'); fill('q', '{{secret:bank}}')`);
  assert.equal(r.isError, true);
  assert.ok(!r.text.includes(farm.truth.bank.password));
});


test('shipped MCP collects typed product data with evidence and coverage', async () => {
  const m = await rpc('tools/call', { name: 'web', arguments: {
    run: `open('${farm.url}/shop/products'); collect(name='link', price='money', href='url')`,
    session: 'collection-e2e', budget: 12000,
  } });
  assert.ok(m.result && !m.result.isError, JSON.stringify(m));
  const text = m.result.content.map((c: any) => c.text ?? '').join('\n');
  const result = JSON.parse(text.slice(text.indexOf('{"schema"')));
  const first = farm.truth.shop.products[0];
  const found = result.rows.find((row: any) => row.values.name === first.name);
  assert.ok(found, text);
  assert.equal(found.values.price, first.priceCents / 100);
  assert.equal(found.source.url, farm.url + '/shop/products');
  assert.ok(found.evidence.price.includes('$'));
  assert.equal(result.coverage.complete, false, 'one catalogue page is not the whole collection');
  assert.equal(result.coverage.stop, 'page_limit');
});

test('a single search result remains an actionable record through the shipped MCP', async () => {
  const product = farm.truth.shop.products[0];
  const r = await call(`open('${farm.url}/shop/'); search(${JSON.stringify(product.name)}); records(${JSON.stringify(product.name)})`);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /1 record matching/);
  assert.ok(r.text.includes(product.name), r.text);
  assert.match(r.text, /Add to cart/);
});

test('the shipped binary says which commit it was built from', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [BIN, '--version'], { encoding: 'utf8' }).trim();
  assert.match(out, /^\d+\.\d+\.\d+(\+[0-9a-f]{7,40})?$/, out);
  // in a git checkout the build knows its commit (a copy without .git is told it: AGENTWEB_COMMIT)
  let head = '';
  try {
    head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
  if (head && existsSync(new URL('../.git', import.meta.url).pathname)) assert.match(out, /\+[0-9a-f]{7,40}$/, 'built in a git checkout: ' + out);
  assert.ok(execFileSync(process.execPath, [BIN, 'doctor'], { encoding: 'utf8', env: { ...process.env, AGENTWEB_USAGE_LOG: '' } }).startsWith(`agentweb ${out} on node `));
});
