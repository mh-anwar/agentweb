import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from '../src/server/index.ts';
import { createFakeRuntime } from '../src/server/testing.ts';

const agent = new http.Agent({ keepAlive: false });
const J = { 'content-type': 'application/json', authorization: 'Bearer k1' };

function raw(url: string, path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: any }>((resolve, reject) => {
    const r = http.request(url + path, { method: o.method ?? (o.body ? 'POST' : 'GET'), headers: o.headers, agent }, (res) => {
      let text = '';
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
    r.end(o.body);
  });
}

test('cluster: any worker serves any session; revocation, events and metrics span workers', async () => {
  const script = fileURLToPath(new URL('../src/server/testing.ts', import.meta.url));
  const srv = createHttpServer(createFakeRuntime(), {
    workers: 2,
    workerScript: script,
    secret: 'cluster-secret-0123456789abcdef',
    workerEnv: { AGENTWEB_FAKE_HTTP: JSON.stringify({ keys: { k1: 'alice' } }) },
    log: () => {},
  });
  const { url } = await srv.listen(0);
  try {
    // connections are spread over both workers
    const pids = new Set<number>();
    for (let i = 0; i < 20; i++) pids.add((await raw(url, '/healthz')).json.pid);
    assert.equal(pids.size, 2);

    // an SSE subscriber on one worker
    const events: any[] = [];
    const es = http.get(url + '/v1/events', { headers: { accept: 'text/event-stream', authorization: 'Bearer k1' }, agent });
    await new Promise<void>((resolve) =>
      es.on('response', (res) => {
        res.setEncoding('utf8');
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const d = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
            buf = buf.slice(i + 2);
            if (d) events.push(JSON.parse(d.slice(6)));
          }
        });
        resolve();
      }),
    );
    es.on('error', () => {});
    await new Promise((r) => setTimeout(r, 100)); // let the interest flag reach the other worker

    // MCP: initialize on one worker, call on whichever worker each new connection lands on
    const init = await raw(url, '/mcp', { headers: J, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }) });
    const sid = init.headers['mcp-session-id'] as string;
    const sessions = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const r = await raw(url, '/mcp', {
        headers: { ...J, 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: 'web', arguments: { run: 'echo hi' } } }),
      });
      assert.equal(r.status, 200);
      sessions.add(r.json.result.content[0].text);
    }
    assert.equal(sessions.size, 1); // same runtime session id on both workers

    for (let i = 0; i < 6; i++) assert.equal((await raw(url, '/v1/run', { headers: J, body: '{"run":"echo r"}' })).status, 200);

    // events from both workers reach the subscriber
    for (let i = 0; i < 40 && events.length < 16; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(events.length, 16);

    // metrics are summed across workers
    const m = await raw(url, '/metrics', { headers: { authorization: 'Bearer k1' } });
    const lines = m.text.split('\n');
    assert.ok(lines.includes('agentweb_workers 2'), m.text);
    assert.ok(lines.includes('agentweb_runs_total{surface="mcp",outcome="ok"} 10'));
    assert.ok(lines.includes('agentweb_runs_total{surface="rest",outcome="ok"} 6'));
    assert.ok(lines.includes('agentweb_runtime_runs 16'));

    // ending the session on one worker ends it on all of them
    assert.equal((await raw(url, '/mcp', { method: 'DELETE', headers: { ...J, 'mcp-session-id': sid } })).status, 204);
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 8; i++) {
      const r = await raw(url, '/mcp', { headers: { ...J, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
      assert.equal(r.status, 404);
    }
    es.destroy();
  } finally {
    await srv.close();
  }
  await assert.rejects(raw(url, '/healthz'), /ECONNREFUSED/);
});
