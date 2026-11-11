// Verify optional engines/readers through the built CLI, not TypeScript source imports.
// node scripts/smoke-build.mjs [path/to/agentweb.mjs]
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const bundle = resolve(process.argv[2] ?? 'dist/agentweb.mjs');
const pdf = readFileSync(new URL('../test/fixtures/readers/report.pdf', import.meta.url));
const server = createServer((req, res) => {
  if (req.url === '/report.pdf') {
    res.setHeader('content-type', 'application/pdf');
    res.end(pdf);
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(`<div id="root"></div><script>document.getElementById('root').innerHTML='<main><h1>Bundle JavaScript smoke passed</h1></main>'</script>`);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const run = async program => (await promisify(execFile)(process.execPath, [bundle, 'run', program], {
  env: { ...process.env, AGENTWEB_STORE: 'memory:', AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_CHROME_ENGINE: '0', AGENTWEB_USAGE_LOG: '' },
  timeout: 20_000,
})).stdout;
try {
  assert.match(await run(`engine('ghost'); open('${base}/')`), /Bundle JavaScript smoke passed/);
  assert.match(await run(`open('${base}/report.pdf'); find('Headcount')`), /412 people/);
  console.log('Built CLI: JavaScript-only engine and PDF reader passed.');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
