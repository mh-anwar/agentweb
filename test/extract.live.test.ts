import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentweb } from '../src/index.ts';
import { defaultPolicy } from '../src/guard/index.ts';
import { startFarm } from '../bench/sites/farm.ts';

test('records gathers later infinite-feed batches after switching from HTTP to JavaScript', async () => {
  const farm = await startFarm();
  const rt = await createAgentweb({ store: 'memory:', policy: defaultPolicy('local'), chrome: false, atlas: false });
  try {
    const r = await rt.run('feed', `open('${farm.url}/hard/infinite'); records(pages=3)`, { budget: 12000 });
    assert.ok(r.ok, r.text);
    // HTTP and script engines group the same list differently; the new batch must still be read.
    assert.ok(r.text.includes(farm.truth.hard.feed[39]), r.text);
    assert.match(r.text, /over 3 pages/);
  } finally {
    await rt.close();
    await farm.close();
  }
});

test('records follows a virtualized feed whose DOM row count stays constant', async () => {
  const { createServer } = await import('node:http');
  const rows = (batch: number) => Array.from({ length: 5 }, (_, i) => `<li>Batch ${batch} entry ${i}: unique content ${batch * 5 + i}</li>`).join('');
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<main><h1>Virtual feed</h1><ul id="rows">${rows(0)}</ul></main><script>
      let batch = 0;
      window.addEventListener('scroll', () => {
        if (batch >= 2) return;
        batch++;
        document.getElementById('rows').innerHTML = Array.from({length:5}, (_,i) => '<li>Batch '+batch+' entry '+i+': unique content '+(batch*5+i)+'</li>').join('');
      });
    </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const rt = await createAgentweb({ store: 'memory:', policy: defaultPolicy('local'), chrome: false, atlas: false });
  try {
    const r = await rt.run('virtual', `open('http://127.0.0.1:${port}'); records(pages=3)`);
    assert.ok(r.ok, r.text);
    assert.match(r.text, /15 records over 3 pages/);
    assert.match(r.text, /Batch 2 entry 4/);
  } finally {
    await rt.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
