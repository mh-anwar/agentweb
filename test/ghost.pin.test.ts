import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createWireEngine, createJar } from '../src/net/index.ts';
import { isPublicAddress } from '../src/guard/index.ts';
import { defaultFetch } from '../src/engines/ghost/index.ts';

// A guard that waves everything through (e.g. a name that later resolves to a private address):
// ghost requests sent through the wire engine's pool are still refused at connect time.
test('ghost requests through the wire dispatcher get the connect-time address check', async () => {
  const s = createServer((_, r) => r.end('secret')).listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const url = `http://localhost:${(s.address() as AddressInfo).port}/`;
  const wire = createWireEngine({ checkAddress: (ip: string) => isPublicAddress(ip) });
  const ctx = { id: 'x', jar: createJar(), storage: {}, userAgent: 't', timeoutMs: 5000, guard: { checkUrl: async () => ({ ok: true }) } } as any;
  try {
    await assert.rejects(defaultFetch({ dispatcher: wire.dispatcher })(ctx, { url, kind: 'xhr' }), /EAW_ADDRESS|not allowed/);
    const r = await defaultFetch()(ctx, { url, kind: 'xhr' });
    assert.equal(new TextDecoder().decode(r.bytes), 'secret', 'control: without the dispatcher the request goes through');
  } finally {
    s.close();
    await (wire as any).close?.();
  }
});
