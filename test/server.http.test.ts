import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { IncomingMessage } from 'node:http';
import { createHttpServer } from '../src/server/index.ts';
import type { HttpOptions } from '../src/server/index.ts';
import { createFakeRuntime } from '../src/server/testing.ts';
import type { FakeRuntime } from '../src/server/testing.ts';

const SECRET = 'test-secret-0123456789abcdef';
const agent = new http.Agent({ keepAlive: false });

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any;
}

function raw(url: string, path: string, o: { method?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...o.headers };
    const r = http.request(url + path, { method: o.method ?? (o.body !== undefined ? 'POST' : 'GET'), headers, agent }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode!, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (o.body !== undefined) {
      if (o.chunked) {
        const b = Buffer.from(o.body);
        r.write(b.subarray(0, b.length >> 1));
        r.end(b.subarray(b.length >> 1));
      } else r.end(o.body);
    } else r.end();
  });
}

const J = { 'content-type': 'application/json' };
const auth = (k: string) => ({ authorization: `Bearer ${k}` });

async function start(t: { after: (fn: () => unknown) => void }, opts: HttpOptions = {}, rt: FakeRuntime = createFakeRuntime()) {
  const srv = createHttpServer(rt, { secret: SECRET, log: () => {}, ...opts });
  const { url } = await srv.listen(0);
  t.after(() => srv.close());
  return { srv, url, rt };
}

const rpc = (id: number | undefined, method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params });
const callBody = (id: number, args: unknown) => rpc(id, 'tools/call', { name: 'web', arguments: args });

async function init(url: string, headers: Record<string, string> = {}, version = '2025-06-18'): Promise<string> {
  const r = await raw(url, '/mcp', { headers: { ...J, accept: 'application/json, text/event-stream', ...headers }, body: rpc(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 't', version: '1' } }) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.result.protocolVersion, version);
  const sid = r.headers['mcp-session-id'] as string;
  assert.ok(sid && /^[\x21-\x7e]+$/.test(sid));
  return sid;
}

const mcpPost = (url: string, sid: string | undefined, body: string, headers: Record<string, string> = {}) =>
  raw(url, '/mcp', { headers: { ...J, accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}), ...headers }, body });

/** open an SSE stream and collect events until `until` returns true */
function sse(url: string, path: string, headers: Record<string, string> = {}) {
  let buf = '';
  let res: IncomingMessage | undefined;
  const events: any[] = [];
  const waiters: (() => void)[] = [];
  const req = http.get(url + path, { headers: { accept: 'text/event-stream', ...headers }, agent });
  const ready = new Promise<IncomingMessage>((resolve, reject) => {
    req.on('response', (r) => {
      res = r;
      r.setEncoding('utf8');
      r.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (data) events.push(JSON.parse(data));
          waiters.splice(0).forEach((w) => w());
        }
      });
      resolve(r);
    });
    req.on('error', reject);
  });
  return {
    ready,
    events,
    ended: () => new Promise<void>((r) => (res!.complete || res!.destroyed ? r() : res!.on('close', () => r()))),
    async waitFor(pred: (e: any[]) => boolean, ms = 2000) {
      const t0 = Date.now();
      while (!pred(events)) {
        if (Date.now() - t0 > ms) throw new Error('timeout waiting for SSE events: ' + JSON.stringify(events));
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
    close: () => req.destroy(),
  };
}

test('MCP session lifecycle over Streamable HTTP', async (t) => {
  const { url, rt } = await start(t);
  const sid = await init(url);
  assert.equal((await mcpPost(url, sid, rpc(undefined, 'notifications/initialized'))).status, 202);
  const list = await mcpPost(url, sid, rpc(2, 'tools/list'), { 'mcp-protocol-version': '2025-06-18' });
  assert.equal(list.status, 200);
  assert.equal(list.headers['content-type'], 'application/json');
  assert.equal(list.json.result.tools[0].name, 'web');
  const call = await mcpPost(url, sid, callBody(3, { run: 'echo hi', session: 'tab1' }));
  assert.equal(call.json.result.content[0].text.endsWith('|hi'), true);
  const rid = rt.calls[0].session.split('/')[1];
  assert.equal(rt.calls[0].session, `anon/${rid}/tab1`);
  assert.equal(rt.calls[0].opts.tenant, 'anon');
  // batch over HTTP
  const batch = await mcpPost(url, sid, `[${rpc(4, 'ping')},${rpc(undefined, 'notifications/x')},${rpc(5, 'ping')}]`);
  assert.deepEqual(batch.json.map((m: any) => m.id), [4, 5]);
  // client that only accepts SSE gets the response as an SSE event
  const ev = await mcpPost(url, sid, rpc(6, 'ping'), { accept: 'text/event-stream' });
  assert.equal(ev.headers['content-type'], 'text/event-stream');
  assert.match(ev.text, /^event: message\ndata: \{"jsonrpc":"2.0","id":6,"result":\{\}\}\n\n$/);
  // errors
  assert.equal((await mcpPost(url, undefined, rpc(7, 'ping'))).status, 400);
  assert.equal((await mcpPost(url, 'garbage.token', rpc(7, 'ping'))).status, 404);
  assert.equal((await mcpPost(url, sid + 'x', rpc(7, 'ping'))).status, 404);
  assert.equal((await mcpPost(url, sid, rpc(7, 'ping'), { 'mcp-protocol-version': '1999-01-01' })).status, 400);
  const parse = await mcpPost(url, sid, '{not json');
  assert.equal(parse.status, 400);
  assert.equal(parse.json.error.code, -32700);
  assert.equal((await raw(url, '/mcp', { method: 'POST', headers: { 'content-type': 'text/plain', 'mcp-session-id': sid }, body: rpc(1, 'ping') })).status, 415);
  assert.equal((await raw(url, '/mcp', { method: 'PUT' })).status, 405);
  // GET opens an SSE stream; DELETE ends the session and closes it
  const stream = sse(url, '/mcp', { 'mcp-session-id': sid });
  const r = await stream.ready;
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['content-type'], 'text/event-stream');
  assert.equal((await raw(url, '/mcp', { method: 'GET', headers: { 'mcp-session-id': sid, accept: 'application/json' } })).status, 405);
  assert.equal((await raw(url, '/mcp', { method: 'DELETE', headers: { 'mcp-session-id': sid } })).status, 204);
  await stream.ended();
  assert.equal((await mcpPost(url, sid, rpc(8, 'ping'))).status, 404);
  // a fresh initialize works and gives a new scope
  const sid2 = await init(url, {}, '2024-11-05');
  assert.notEqual(sid2, sid);
});

test('stateless sessions: two instances sharing a secret accept each other\'s session ids', async (t) => {
  const a = await start(t);
  const b = await start(t);
  const c = await start(t, { secret: 'a-different-secret-0123456789' });
  const sid = await init(a.url);
  const onB = await mcpPost(b.url, sid, callBody(2, { run: 'echo from b', session: 's' }));
  assert.equal(onB.status, 200);
  const onA = await mcpPost(a.url, sid, callBody(3, { run: 'echo from a', session: 's' }));
  // the same runtime session id is used on both instances
  assert.equal(a.rt.calls[0].session, b.rt.calls[0].session);
  assert.equal(onA.json.result.content[0].text, `${a.rt.calls[0].session}|from a`);
  assert.equal((await mcpPost(c.url, sid, rpc(4, 'ping'))).status, 404);
});

test('expired session ids are rejected', async (t) => {
  const { url } = await start(t, { sessionTtlSec: 1 });
  const sid = await init(url);
  assert.equal((await mcpPost(url, sid, rpc(2, 'ping'))).status, 200);
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal((await mcpPost(url, sid, rpc(3, 'ping'))).status, 404);
});

test('auth: bearer keys, 401s, open endpoints', async (t) => {
  const { url } = await start(t, { keys: { 'key-alice': 'alice', 'key-bob': 'bob' } });
  const body = JSON.stringify({ run: 'echo x' });
  const none = await raw(url, '/v1/run', { headers: J, body });
  assert.equal(none.status, 401);
  assert.match(String(none.headers['www-authenticate']), /^Bearer/);
  assert.equal((await raw(url, '/v1/run', { headers: { ...J, ...auth('nope') }, body })).status, 401);
  assert.equal((await raw(url, '/v1/run', { headers: { ...J, authorization: 'Basic a2V5LWFsaWNl' }, body })).status, 401);
  const ok = await raw(url, '/v1/run', { headers: { ...J, ...auth('key-alice') }, body });
  assert.equal(ok.status, 200);
  assert.equal((await raw(url, '/v1/run', { headers: { ...J, 'x-api-key': 'key-bob' }, body })).status, 200);
  const m = await raw(url, '/mcp', { headers: J, body: rpc(1, 'initialize', {}) });
  assert.equal(m.status, 401);
  assert.equal(m.json.error.code, -32000);
  assert.equal((await raw(url, '/v1/events')).status, 401);
  assert.equal((await raw(url, '/metrics')).status, 401);
  assert.equal((await raw(url, '/metrics', { headers: auth('key-bob') })).status, 200);
  assert.equal((await raw(url, '/healthz')).status, 200);
  assert.equal((await raw(url, '/v1/tool')).status, 200);
});

test('tenant isolation: a tenant cannot name another tenant\'s sessions', async (t) => {
  const { url, rt } = await start(t, { keys: { ka: 'alice', kb: 'bob' } });
  const run = (k: string, args: unknown) => raw(url, '/v1/run', { headers: { ...J, ...auth(k) }, body: JSON.stringify(args) });
  assert.equal((await run('ka', { run: 'echo alice-secret', session: 'x' })).json.session, 'x');
  const bobHist = await run('kb', { run: 'history', session: 'x' });
  assert.equal(bobHist.json.text, '');
  assert.equal((await run('ka', { run: 'history', session: 'x' })).json.text, 'echo alice-secret');
  // MCP: alice's session id is useless with bob's key
  const sidA = await init(url, auth('ka'));
  assert.equal((await mcpPost(url, sidA, rpc(2, 'ping'), auth('kb'))).status, 404);
  await mcpPost(url, sidA, callBody(3, { run: 'echo a-mcp' }), auth('ka'));
  const aliceScope = rt.calls.at(-1)!.session.split('/')[1];
  // bob tries to fork alice's sessions by every name he can form
  const sidB = await init(url, auth('kb'));
  for (const fork of ['x', 'rest/x', `${aliceScope}/default`]) {
    const r = await mcpPost(url, sidB, callBody(4, { run: 'history', session: 'steal' + fork.length, fork }), auth('kb'));
    assert.doesNotMatch(r.json.result.content[0].text, /alice/, fork);
  }
  const bobRest = await run('kb', { run: 'history', session: 'y', fork: `${aliceScope}/default` });
  assert.equal(bobRest.json.text, '');
  for (const c of rt.calls) {
    const tenant = c.opts.tenant!;
    assert.ok(c.session.startsWith(tenant + '/'), c.session);
    if (c.opts.fork) assert.ok(c.opts.fork.startsWith(tenant + '/'), c.opts.fork);
  }
  // alice can fork her own REST session into her MCP session
  const own = await mcpPost(url, sidA, callBody(5, { run: 'history', session: 'copy', fork: 'rest/x' }), auth('ka'));
  assert.equal(own.json.result.content[0].text, 'echo alice-secret\nhistory');
});

test('REST /v1/run shapes and errors', async (t) => {
  const { url } = await start(t);
  const run = (body: string, headers: Record<string, string> = J) => raw(url, '/v1/run', { headers, body });
  const ok = await run(JSON.stringify({ run: 'image', session: 's', budget: 100 }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.session, 's');
  assert.equal(ok.json.images[0].mime, 'image/png');
  assert.equal(typeof ok.json.stats.ms, 'number');
  const fail = await run(JSON.stringify({ run: 'fail no' }));
  assert.equal(fail.status, 200);
  assert.equal(fail.json.ok, false);
  assert.equal(fail.json.session, 'default');
  const bad = await run(JSON.stringify({ program: 'x' }));
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /put the program in "run"/);
  assert.equal((await run('{"run":')).status, 400);
  assert.equal((await run(JSON.stringify({ run: 'x' }), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await run(JSON.stringify({ run: 'x' }), { 'content-type': 'application/json; charset=utf-8' })).status, 200);
  const thrown = await run(JSON.stringify({ run: 'throw policy' }));
  assert.equal(thrown.status, 403);
  assert.deepEqual(thrown.json.error, { code: 'policy', message: 'fake policy', hint: 'fake hint' });
  const crash = await run(JSON.stringify({ run: 'crash' }));
  assert.equal(crash.status, 500);
  assert.doesNotMatch(crash.text, /secret internal/);
  assert.equal((await raw(url, '/v1/run')).status, 405);
  assert.equal((await raw(url, '/nope')).status, 404);
  assert.equal((await raw(url, '/')).json.mcp, '/mcp');
});

test('GET /v1/tool in each vendor shape', async (t) => {
  const { url } = await start(t);
  const get = async (f?: string) => (await raw(url, '/v1/tool' + (f ? `?format=${f}` : ''))).json;
  const mcp = await get();
  assert.deepEqual(Object.keys(mcp), ['name', 'description', 'inputSchema']);
  assert.deepEqual(await get('mcp'), mcp);
  const oa = await get('openai');
  assert.equal(oa.type, 'function');
  assert.equal(oa.function.name, 'web');
  assert.deepEqual(oa.function.parameters, mcp.inputSchema);
  const an = await get('anthropic');
  assert.deepEqual(an, { name: 'web', description: mcp.description, input_schema: mcp.inputSchema });
  assert.equal((await get('gemini')).parameters.type, 'object');
  assert.equal((await raw(url, '/v1/tool?format=cobol')).status, 400);
});

test('rate limit (token bucket) per tenant', async (t) => {
  const { url } = await start(t, { keys: { ka: 'alice', kb: 'bob' }, rateLimit: { perSec: 1, burst: 2 } });
  const run = (k: string) => raw(url, '/v1/run', { headers: { ...J, ...auth(k) }, body: '{"run":"echo"}' });
  assert.equal((await run('ka')).status, 200);
  assert.equal((await run('ka')).status, 200);
  const limited = await run('ka');
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, 'rate_limited');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  // another tenant has its own bucket
  assert.equal((await run('kb')).status, 200);
  // MCP: limit errors come back as a tool error the model can read
  const sid = await init(url, auth('kb'));
  await mcpPost(url, sid, callBody(2, { run: 'echo' }), auth('kb'));
  const m = await mcpPost(url, sid, callBody(3, { run: 'echo' }), auth('kb'));
  assert.equal(m.status, 200);
  assert.equal(m.json.result.isError, true);
  assert.match(m.json.result.content[0].text, /^error \(rate_limited\).*\nhint: retry in \d+s/s);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal((await run('ka')).status, 200);
});

test('concurrency cap per tenant', async (t) => {
  const { url } = await start(t, { maxConcurrent: 2 });
  const run = (p: string) => raw(url, '/v1/run', { headers: J, body: JSON.stringify({ run: p }) });
  const slow = [run('sleep 200'), run('sleep 200')];
  await new Promise((r) => setTimeout(r, 50));
  const third = await run('echo');
  assert.equal(third.status, 429);
  assert.equal(third.json.error.code, 'busy');
  for (const s of await Promise.all(slow)) assert.equal(s.status, 200);
  assert.equal((await run('echo')).status, 200);
});

test('request timeout aborts the runtime call', async (t) => {
  const { url, rt } = await start(t, { timeoutMs: 100 });
  const t0 = Date.now();
  const r = await raw(url, '/v1/run', { headers: J, body: '{"run":"sleep 5000"}' });
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(r.status, 504);
  assert.equal(r.json.error.code, 'timeout');
  assert.equal(rt.aborted.length, 1);
  assert.match(rt.aborted[0], /longer than 0.1s/);
  // MCP: a runtime that ignores the signal still yields a prompt tool error
  const sid = await init(url);
  const t1 = Date.now();
  const m = await mcpPost(url, sid, callBody(2, { run: 'hang 1500' }));
  assert.ok(Date.now() - t1 < 1000);
  assert.match(m.json.result.content[0].text, /^error \(timeout\)/);
  // the concurrency slot is held until the runtime really finishes
  assert.equal(rt.running, 1);
});

test('client disconnect aborts the run', async (t) => {
  const { url, rt } = await start(t);
  const req = http.request(url + '/v1/run', { method: 'POST', headers: J, agent });
  req.on('error', () => {});
  req.end('{"run":"sleep 5000"}');
  await new Promise((r) => setTimeout(r, 80));
  req.destroy();
  for (let i = 0; i < 50 && !rt.aborted.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(rt.aborted.length, 1);
  assert.match(rt.aborted[0], /disconnected/);
});

test('SSE /v1/events delivers RunEvents, filtered by tenant', async (t) => {
  const { url } = await start(t, { keys: { ka: 'alice', kb: 'bob' } });
  const a = sse(url, '/v1/events', auth('ka'));
  assert.equal((await a.ready).statusCode, 200);
  t.after(() => a.close());
  await raw(url, '/v1/run', { headers: { ...J, ...auth('kb') }, body: '{"run":"echo bob-private","session":"s"}' });
  await raw(url, '/v1/run', { headers: { ...J, ...auth('ka') }, body: '{"run":"echo alice-run","session":"s"}' });
  await a.waitFor((e) => e.length >= 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].session, 'alice/rest/s');
  assert.equal(a.events[0].program, 'echo alice-run');
  assert.equal(a.events[0].ok, true);
  assert.equal(typeof a.events[0].stats.ms, 'number');
});

test('SSE stream cap per tenant', async (t) => {
  const { url } = await start(t, { maxStreams: 1 });
  const a = sse(url, '/v1/events');
  await a.ready;
  t.after(() => a.close());
  assert.equal((await raw(url, '/v1/events')).status, 429);
});

test('metrics: Prometheus text format with runtime metrics and own counters', async (t) => {
  const { url } = await start(t);
  for (let i = 0; i < 3; i++) await raw(url, '/v1/run', { headers: J, body: '{"run":"echo"}' });
  await raw(url, '/v1/run', { headers: J, body: '{"run":"fail"}' });
  const r = await raw(url, '/metrics');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /^text\/plain; version=0\.0\.4/);
  const lines = r.text.trimEnd().split('\n');
  const typed = new Set<string>();
  for (const l of lines) {
    if (l.startsWith('# TYPE ')) {
      const [, , name, kind] = l.split(' ');
      assert.ok(['counter', 'gauge', 'histogram', 'untyped'].includes(kind), l);
      assert.ok(!typed.has(name), 'duplicate TYPE ' + name);
      typed.add(name);
      continue;
    }
    if (l.startsWith('# HELP ')) continue;
    assert.match(l, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\]|\\.)*",?)*\})? (-?[0-9.]+(e[+-]?\d+)?|NaN|[+-]Inf)$/, l);
  }
  assert.ok(lines.includes('agentweb_http_requests_total{route="/v1/run",code="200"} 4'), r.text);
  assert.ok(lines.includes('agentweb_runs_total{surface="rest",outcome="ok"} 3'));
  assert.ok(lines.includes('agentweb_runs_total{surface="rest",outcome="fail"} 1'));
  assert.ok(lines.includes('agentweb_run_duration_seconds_bucket{le="+Inf"} 4'));
  assert.ok(lines.includes('agentweb_run_duration_seconds_count 4'));
  assert.ok(lines.includes('agentweb_runtime_runs 4'));
  assert.ok(lines.includes('agentweb_runtime_sessions_live 1'));
  assert.ok(lines.some((l) => l.startsWith('agentweb_http_request_duration_seconds_bucket{route="/v1/run",le="0.001"} ')));
  // buckets are cumulative
  const buckets = lines.filter((l) => l.startsWith('agentweb_run_duration_seconds_bucket')).map((l) => Number(l.split(' ')[1]));
  for (let i = 1; i < buckets.length; i++) assert.ok(buckets[i] >= buckets[i - 1]);
});

test('metrics token', async (t) => {
  const { url } = await start(t, { metricsToken: 'scrape-me' });
  assert.equal((await raw(url, '/metrics')).status, 401);
  assert.equal((await raw(url, '/metrics', { headers: auth('scrape-me') })).status, 200);
});

test('request body cap', async (t) => {
  const { url, rt } = await start(t, { maxBodyBytes: 1000 });
  const big = JSON.stringify({ run: 'echo ' + 'x'.repeat(2000) });
  const r1 = await raw(url, '/v1/run', { headers: J, body: big });
  assert.equal(r1.status, 413);
  assert.equal(r1.json.error.code, 'too_large');
  const r2 = await raw(url, '/v1/run', { headers: { ...J, 'transfer-encoding': 'chunked' }, body: big, chunked: true });
  assert.equal(r2.status, 413);
  const r3 = await raw(url, '/mcp', { headers: J, body: rpc(1, 'initialize', { pad: 'x'.repeat(2000) }) });
  assert.equal(r3.status, 413);
  assert.equal(r3.json.error.code, -32000);
  assert.equal(rt.calls.length, 0);
  assert.equal((await raw(url, '/v1/run', { headers: J, body: '{"run":"echo small"}' })).status, 200);
});

test('origin and host validation on loopback (DNS rebinding)', async (t) => {
  const { url } = await start(t, { allowedOrigins: ['https://app.example'] });
  const port = new URL(url).port;
  const get = (headers: Record<string, string>) => raw(url, '/healthz', { headers });
  assert.equal((await get({})).status, 200);
  assert.equal((await get({ origin: 'http://localhost:3000' })).status, 200);
  assert.equal((await get({ origin: 'http://127.0.0.1:9' })).status, 200);
  assert.equal((await get({ origin: 'http://[::1]:9' })).status, 200);
  assert.equal((await get({ origin: 'https://app.example' })).status, 200);
  assert.equal((await get({ origin: 'http://evil.example' })).status, 403);
  assert.equal((await get({ origin: 'null' })).status, 403);
  assert.equal((await get({ host: `evil.example:${port}` })).status, 403);
  assert.equal((await get({ host: `localhost:${port}` })).status, 200);
  const r = await raw(url, '/mcp', { headers: { ...J, origin: 'http://evil.example' }, body: rpc(1, 'initialize', {}) });
  assert.equal(r.status, 403);
});

test('refuses to bind a public address without keys', async () => {
  const srv = createHttpServer(createFakeRuntime(), { secret: SECRET, log: () => {} });
  await assert.rejects(srv.listen(0, '0.0.0.0'), /refusing to bind/);
  await srv.close();
});

test('graceful drain: in-flight runs finish, new work is refused', async () => {
  const rt = createFakeRuntime();
  const srv = createHttpServer(rt, { secret: SECRET, log: () => {} });
  const { url } = await srv.listen(0);
  const keep = new http.Agent({ keepAlive: true, maxSockets: 1 });
  // warm a keep-alive connection
  await new Promise<void>((r) => http.get(url + '/healthz', { agent: keep }, (res) => res.resume().on('end', () => r())));
  const inflight = raw(url, '/v1/run', { headers: J, body: '{"run":"sleep 300"}' });
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  const closed = srv.close();
  let closedAt = 0;
  closed.then(() => (closedAt = Date.now()));
  await new Promise((r) => setTimeout(r, 20));
  // new connections are refused
  await assert.rejects(raw(url, '/healthz'), /ECONNREFUSED/);
  const done = await inflight;
  assert.equal(done.status, 200);
  assert.equal(done.json.text, 'slept');
  assert.equal(done.headers.connection, 'close');
  await closed;
  assert.ok(closedAt - t0 >= 200, `closed after ${closedAt - t0}ms`);
  keep.destroy();
});

test('graceful drain: runs that outlive drainMs are aborted with 503', async () => {
  const rt = createFakeRuntime();
  const srv = createHttpServer(rt, { secret: SECRET, log: () => {}, drainMs: 100 });
  const { url } = await srv.listen(0);
  const inflight = raw(url, '/v1/run', { headers: J, body: '{"run":"sleep 10000"}' });
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  await srv.close();
  assert.ok(Date.now() - t0 < 1500);
  const r = await inflight;
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'unavailable');
  assert.equal(rt.aborted.length, 1);
});
