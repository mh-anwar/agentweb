import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpCore, SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION, parseToolArgs, raceAbort } from '../src/server/index.ts';
import type { CallContext } from '../src/server/index.ts';
import { createFakeRuntime, FAKE_TOOL } from '../src/server/testing.ts';

const ctx = (over: Partial<CallContext> = {}): CallContext => ({ conn: 'c', sessionId: (n) => `T/${n}`, forkId: (r) => `T/${r}`, tenant: 'T', ...over });
const req = (id: number | string, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });

async function call(core: McpCore, args: unknown, c = ctx()) {
  const r = (await core.handle(req(1, 'tools/call', { name: 'web', arguments: args }), c)) as any;
  return r;
}

test('initialize answers each supported version with that version', async () => {
  const core = new McpCore(createFakeRuntime(), { serverVersion: '9.9.9' });
  for (const v of SUPPORTED_PROTOCOL_VERSIONS) {
    const r = (await core.handle(req(1, 'initialize', { protocolVersion: v, capabilities: {}, clientInfo: { name: 't', version: '1' } }), ctx())) as any;
    assert.equal(r.jsonrpc, '2.0');
    assert.equal(r.id, 1);
    assert.equal(r.result.protocolVersion, v);
    assert.deepEqual(r.result.capabilities, { tools: { listChanged: false } });
    assert.deepEqual(r.result.serverInfo, { name: 'agentweb', version: '9.9.9' });
  }
  for (const v of ['2024-11-05', '2025-03-26', '2025-06-18']) assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(v));
});

test('initialize with an unknown or missing version answers the latest supported', async () => {
  const core = new McpCore(createFakeRuntime());
  for (const v of ['1999-01-01', '2099-12-31', 42, undefined]) {
    const r = (await core.handle(req('a', 'initialize', { protocolVersion: v }), ctx())) as any;
    assert.equal(r.result.protocolVersion, LATEST_PROTOCOL_VERSION);
    assert.equal(r.id, 'a');
  }
});

test('ping, tools/list, notifications', async () => {
  const core = new McpCore(createFakeRuntime());
  assert.deepEqual(await core.handle(req(7, 'ping'), ctx()), { jsonrpc: '2.0', id: 7, result: {} });
  const list = (await core.handle(req(8, 'tools/list', {}), ctx())) as any;
  assert.equal(list.result.tools.length, 1);
  assert.deepEqual(list.result.tools[0], { name: FAKE_TOOL.name, description: FAKE_TOOL.description, inputSchema: FAKE_TOOL.inputSchema });
  // notifications are never answered, even unknown or malformed ones
  assert.equal(await core.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx()), undefined);
  assert.equal(await core.handle({ jsonrpc: '2.0', method: 'no/such/thing', params: 5 }, ctx()), undefined);
  assert.equal(await core.handle({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'web', arguments: { run: 'x' } } }, ctx()), undefined);
  // client responses are not answered either
  assert.equal(await core.handle({ jsonrpc: '2.0', id: 3, result: {} }, ctx()), undefined);
});

test('JSON-RPC error codes', async () => {
  const core = new McpCore(createFakeRuntime());
  const code = async (m: unknown) => ((await core.handle(m, ctx())) as any).error.code;
  assert.equal(await code(req(1, 'resources/read')), -32601);
  assert.equal(await code(req(1, 'nope')), -32601);
  assert.equal(await code({ jsonrpc: '1.0', id: 1, method: 'ping' }), -32600);
  assert.equal(await code({ id: 1, method: 'ping' }), -32600);
  assert.equal(await code({ jsonrpc: '2.0', id: 1 }), -32600);
  assert.equal(await code({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }), -32600);
  assert.equal(await code({ jsonrpc: '2.0', id: null, method: 'ping' }), -32600);
  assert.equal(await code(42), -32600);
  assert.equal(await code('hello'), -32600);
  assert.equal(await code([]), -32600);
  assert.equal(await code(req(1, 'tools/list', 'str')), -32602);
  assert.equal(await code(req(1, 'tools/list', [1, 2])), -32602);
  assert.equal(await code(req(1, 'tools/call', {})), -32602);
  assert.equal(await code(req(1, 'tools/call', { name: 'other', arguments: { run: 'x' } })), -32602);
  const bad = (await core.handle(req(1, 'tools/call', { name: 'other' }), ctx())) as any;
  assert.match(bad.error.message, /one tool, "web"/);
  // ids of invalid requests are echoed when usable
  assert.equal(((await core.handle({ jsonrpc: '1.0', id: 'q', method: 'ping' }, ctx())) as any).id, 'q');
  assert.equal(await core.handleText('{nope', ctx()), JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not valid JSON' } }));
});

test('tools/call maps to runtime.run with scoped session, tenant, budget and fork', async () => {
  const rt = createFakeRuntime();
  const core = new McpCore(rt);
  const r = await call(core, { run: 'whoami', session: 's1', budget: 500, fork: 'base' });
  assert.equal(r.result.isError, undefined);
  assert.deepEqual(JSON.parse(r.result.content[0].text), { session: 'T/s1', tenant: 'T', budget: 500, fork: 'T/base' });
  const d = await call(core, { run: 'echo hi' });
  assert.deepEqual(d.result, { content: [{ type: 'text', text: 'T/default|hi' }] });
  assert.ok(rt.calls[1].opts.signal instanceof AbortSignal);
  // numeric string budget is coerced
  const b = await call(core, { run: 'whoami', budget: '42' });
  assert.equal(JSON.parse(b.result.content[0].text).budget, 42);
});

test('tools/call: images, ok=false, thrown errors', async () => {
  const core = new McpCore(createFakeRuntime(), { log: () => {} });
  const img = await call(core, { run: 'image' });
  assert.deepEqual(img.result.content[1], { type: 'image', data: img.result.content[1].data, mimeType: 'image/png' });
  assert.ok(img.result.content[1].data.length > 20);
  const fail = await call(core, { run: 'fail nope' });
  assert.equal(fail.result.isError, true);
  assert.equal(fail.result.content[0].text, 'nope');
  const thrown = await call(core, { run: 'throw policy' });
  assert.equal(thrown.result.isError, true);
  assert.equal(thrown.result.content[0].text, 'error (policy): fake policy\nhint: fake hint');
  const crash = await call(core, { run: 'crash' });
  assert.equal(crash.result.isError, true);
  assert.doesNotMatch(crash.result.content[0].text, /secret internal/);
});

test('bad arguments become helpful tool errors, not protocol errors', async () => {
  const core = new McpCore(createFakeRuntime());
  const cases: [unknown, RegExp][] = [
    [undefined, /missing "run"/],
    [{}, /missing "run"/],
    [{ program: 'open x' }, /put the program in "run", not "program"/],
    [{ run: 5 }, /"run" must be a string/],
    [{ run: '   ' }, /"run" is empty/],
    [{ run: 'x'.repeat(100_001) }, /limit is 100000/],
    [{ run: 'x', session: 'a/b' }, /not a valid name/],
    [{ run: 'x', session: 7 }, /"session" must be a string/],
    [{ run: 'x', budget: 1.5 }, /"budget" must be an integer/],
    [{ run: 'x', budget: 0 }, /between 1 and/],
    [{ run: 'x', budget: 'lots' }, /must be an integer/],
    [{ run: 'x', fork: 'a/b/c' }, /not a valid session name/],
    [{ run: 'x', session: 's', fork: 's' }, /names the session itself/],
    [{ run: 'x', color: 'red' }, /unknown argument "color"/],
    [[1], /must be an object/],
  ];
  for (const [args, re] of cases) {
    const r = await call(core, args);
    assert.equal(r.error, undefined, JSON.stringify(args));
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, re, JSON.stringify(args)?.slice(0, 60));
  }
  // properties declared by the runtime's schema are accepted
  assert.equal(parseToolArgs({ run: 'x', extra: 1 }, { ...FAKE_TOOL, inputSchema: { properties: { extra: {} } } }).ok, true);
});

test('batch: mixed requests and notifications, all-notification batch, invalid entries', async () => {
  const core = new McpCore(createFakeRuntime());
  const out = (await core.handle(
    [req(1, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, req(2, 'tools/call', { name: 'web', arguments: { run: 'echo b' } }), 5, req(3, 'zzz')],
    ctx(),
  )) as any[];
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(out[1].result.content[0].text, 'T/default|b');
  assert.equal(out[2].error.code, -32600);
  assert.equal(out[3].error.code, -32601);
  assert.equal(await core.handle([{ jsonrpc: '2.0', method: 'notifications/initialized' }], ctx()), undefined);
  assert.equal(McpCore.countCalls([req(1, 'tools/call'), req(2, 'ping'), { jsonrpc: '2.0', method: 'tools/call' }]), 1);
});

test('notifications/cancelled aborts the call and suppresses its response', async () => {
  const rt = createFakeRuntime();
  const core = new McpCore(rt);
  const p = core.handle(req(9, 'tools/call', { name: 'web', arguments: { run: 'sleep 5000' } }), ctx());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(core.inflight, 1);
  // a cancel from another connection does nothing
  await core.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }, ctx({ conn: 'other' }));
  assert.equal(core.inflight, 1);
  await core.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9, reason: 'user' } }, ctx());
  assert.equal(await p, undefined);
  assert.equal(core.inflight, 0);
  assert.equal(rt.aborted.length, 1);
});

test('context signal aborts a call even when the runtime ignores it', async () => {
  const core = new McpCore(createFakeRuntime());
  const ac = new AbortController();
  const p = call(core, { run: 'hang 300' }, ctx({ signal: ac.signal }));
  setTimeout(() => ac.abort(new DOMException('t', 'TimeoutError')), 20);
  const t0 = Date.now();
  const r = await p;
  assert.ok(Date.now() - t0 < 200);
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /^error \(timeout\)/);
  await assert.rejects(raceAbort(() => Promise.resolve(1), AbortSignal.abort()), /cancelled/);
});
