// AGENTWEB_PROXY: HTTP-tier requests go through the proxy, not straight to the site.

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentweb } from '../src/index.ts';

it('sends wire requests through the configured proxy', async () => {
  const seen: string[] = [];
  const proxy = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<title>via proxy</title><h1>proxied</h1>');
  });
  proxy.on('connect', (req, sock) => {
    seen.push(`CONNECT ${req.url}`);
    sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const port = (proxy.address() as AddressInfo).port;
  const rt = await createAgentweb({ store: 'memory:', ghost: false, chrome: false, atlas: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_PROXY: `http://127.0.0.1:${port}` } });
  try {
    await rt.run('p', "open('http://example.invalid/page')");
    assert.ok(seen.some((s) => s.includes('example.invalid')), `proxy saw: ${seen.join(' | ')}`);
  } finally {
    await rt.close?.();
    proxy.close();
  }
});
