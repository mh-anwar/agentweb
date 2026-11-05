import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '../src/server/index.ts';
import { createFakeRuntime } from '../src/server/testing.ts';

function harness(opts: { maxLineBytes?: number } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  stdout.on('data', (c) => (out += c));
  const rt = createFakeRuntime();
  const srv = serveStdio(rt, { stdin, stdout, stderr, ...opts });
  const lines = () => out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { stdin, srv, rt, lines, raw: () => out };
}

const msg = (id: number, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

test('messages split across chunks, several per chunk, CRLF, blank lines', async () => {
  const h = harness();
  const a = msg(1, 'initialize', { protocolVersion: '2025-06-18' });
  const b = msg(2, 'tools/call', { name: 'web', arguments: { run: 'echo héllo ✓', session: 's' } });
  const c = msg(3, 'ping');
  const all = Buffer.from(`${a}\r\n\n${b}\n   \n${c}\n`);
  // feed one byte at a time across the multi-byte characters, then the rest in odd chunks
  const cut = all.indexOf(Buffer.from('✓'));
  for (let i = 0; i < cut + 2; i++) h.stdin.write(all.subarray(i, i + 1));
  h.stdin.write(all.subarray(cut + 2, cut + 9));
  h.stdin.write(all.subarray(cut + 9));
  h.stdin.end();
  await h.srv.done;
  const out = h.lines().sort((x, y) => x.id - y.id);
  assert.equal(out.length, 3);
  assert.equal(out[0].result.protocolVersion, '2025-06-18');
  assert.equal(out[1].result.content[0].text, 's|héllo ✓');
  assert.deepEqual(out[2], { jsonrpc: '2.0', id: 3, result: {} });
  // stdio: the session id is the tool's session argument, unprefixed
  assert.equal(h.rt.calls[0].session, 's');
});

test('three messages in one chunk; last line without newline; garbage gets a parse error', async () => {
  const h = harness();
  h.stdin.write(`${msg(1, 'ping')}\n{oops\n${msg(2, 'ping')}\n${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n${msg(3, 'ping')}`);
  h.stdin.end();
  await h.srv.done;
  const out = h.lines();
  assert.equal(out.length, 4);
  assert.equal(out.filter((m) => m.error?.code === -32700).length, 1);
  assert.deepEqual(out.filter((m) => m.result).map((m) => m.id).sort(), [1, 2, 3]);
});

test('over-long line is discarded with one parse error and the stream recovers', async () => {
  const h = harness({ maxLineBytes: 1000 });
  h.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping","x":"' + 'a'.repeat(600));
  h.stdin.write('a'.repeat(600));
  h.stdin.write('a'.repeat(600) + '"}\n' + msg(2, 'ping') + '\n');
  h.stdin.end();
  await h.srv.done;
  const out = h.lines();
  assert.equal(out.length, 2);
  assert.equal(out[0].error.code, -32700);
  assert.equal(out[1].id, 2);
});

test('done waits for in-flight calls after stdin closes; batches answered as arrays', async () => {
  const h = harness();
  h.stdin.write(msg(1, 'tools/call', { name: 'web', arguments: { run: 'sleep 80' } }) + '\n');
  h.stdin.write(JSON.stringify([JSON.parse(msg(2, 'ping')), JSON.parse(msg(3, 'ping'))]) + '\n');
  h.stdin.end();
  let finished = false;
  h.srv.done.then(() => (finished = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(finished, false);
  await h.srv.done;
  const out = h.lines();
  assert.ok(Array.isArray(out[0]) && out[0].length === 2);
  assert.equal(out[1].result.content[0].text, 'slept');
});

test('real process: stdout carries only protocol, process exits when stdin closes', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script = `
    import { serveStdio } from './src/server/index.ts';
    import { createFakeRuntime } from './src/server/testing.ts';
    console.error('diagnostic line');
    const rt = createFakeRuntime();
    await serveStdio(rt, { log: (l) => process.stderr.write(l + '\\n') }).done;
    await rt.close();
    process.stderr.write('bye\\n');
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (err += c));
  child.stdin.write(msg(1, 'initialize', { protocolVersion: '2024-11-05' }) + '\n');
  child.stdin.write(msg(2, 'tools/call', { name: 'web', arguments: { run: 'crash' } }) + '\n');
  child.stdin.end(msg(3, 'tools/call', { name: 'web', arguments: { run: 'sleep 50' } }) + '\n');
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, err);
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0');
  assert.match(err, /diagnostic line/);
  assert.match(err, /secret internal detail/); // the stack goes to stderr, not to the agent
  assert.doesNotMatch(out, /secret internal/);
  assert.match(err, /bye/);
});
