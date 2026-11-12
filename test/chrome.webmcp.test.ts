// WebMCP: a page publishes tools through navigator.modelContext; agentweb says so on open, lists them and calls one.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentweb } from '../src/index.ts';

const PAGE = `<!doctype html><title>Flights</title><main><h1>Flights</h1><p id="out">No search yet.</p></main>
<script>
  if ('modelContext' in navigator) {
    navigator.modelContext.registerTool({
      name: 'search_flights',
      description: 'Search flights between two airports',
      inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, max: { type: 'number' } }, required: ['from', 'to'] },
      async execute(a) {
        document.getElementById('out').textContent = 'Results for ' + a.from + ' to ' + a.to;
        return { content: [{ type: 'text', text: '2 flights ' + a.from + '-' + a.to + (a.max ? ' under ' + a.max : '') + ': AW101 $420, AW202 $515' }] };
      },
    });
    navigator.modelContext.registerTool({ name: 'ping', description: 'Answers pong', inputSchema: { type: 'object', properties: {} }, execute: () => 'pong' });
  }
</script>`;
const PLAIN = '<!doctype html><title>Plain</title><main><h1>Plain</h1><p>Nothing special.</p><script>document.title = "Plain";</script></main>';

let server: Server;
let base = '';
let rt: Awaited<ReturnType<typeof createAgentweb>>;
before(async () => {
  server = createServer((q, s) => s.writeHead(200, { 'content-type': 'text/html' }).end(q.url === '/plain' ? PLAIN : PAGE));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = await createAgentweb({ store: 'memory:', atlas: false, env: { ...process.env, AGENTWEB_ALLOW_PRIVATE: '1' } });
});
after(async () => {
  await rt.close();
  server.close();
});

test('a page that publishes tools says so when it is opened in the browser, and tools() lists them', async () => {
  const r = await rt.run('w', `engine('chrome'); open('${base}/')`);
  assert.ok(r.ok, r.text);
  assert.match(r.text, /this page offers tools: search_flights\(from, to, max\?\) - Search flights between two airports · ping\(\) - Answers pong\. call\('name', param='value'\) runs one/);
  const t = await rt.run('w', 'tools()');
  assert.match(t.text, /search_flights\(from: string, to: string, max\?: number\) - Search flights between two airports/);
});

test("call('name', param=…) runs the tool, shows what it returned and what changed on the page", async () => {
  const r = await rt.run('w', "call('search_flights', from='YYZ', to='LIS', max=600)");
  assert.ok(r.ok, r.text);
  assert.match(r.text, /2 flights YYZ-LIS under 600: AW101 \$420, AW202 \$515/);
  assert.match(r.text, /Results for YYZ to LIS/);
  assert.match((await rt.run('w', "call('ping')")).text, /pong/);
  const j = await rt.run('w', `call('search_flights', '{"from":"AMS","to":"OSL"}')`);
  assert.match(j.text, /2 flights AMS-OSL: /);
});

test('an unknown tool names the ones the page has; a page without tools says so', async () => {
  const bad = await rt.run('w', "call('book_flight', id=1)");
  assert.equal(bad.ok, false);
  assert.match(bad.text, /no page tool is called book_flight; this page has: search_flights, ping/);
  const plain = await rt.run('p', `engine('chrome'); open('${base}/plain'); tools()`);
  assert.doesNotMatch(plain.text, /offers tools/);
  assert.match(plain.text, /this page offers no tools \(WebMCP\)/);
});
