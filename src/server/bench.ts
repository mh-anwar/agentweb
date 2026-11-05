// Throughput / latency benchmark of the HTTP surfaces against a fake runtime that answers at once.
//
//   node src/server/bench.ts [--seconds 5] [--clients 4] [--workers 1,8] [--conc 64,1024]
//
// The server runs as a node:cluster (1 worker, then one per core); load comes from separate client
// processes using keep-alive connections, so the numbers include real sockets and JSON on both ends.

import http from 'node:http';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from './http.ts';
import { createFakeRuntime } from './testing.ts';

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : def;
};

if (process.argv.includes('--client')) {
  await client();
} else {
  await main();
}

async function client() {
  const url = new URL(arg('url', ''));
  const surface = arg('surface', 'rest');
  const conc = Number(arg('conc', '64'));
  const warm = Number(arg('warm', '1000'));
  const dur = Number(arg('dur', '5000'));
  const sid = arg('sid', '');
  const agent = new http.Agent({ keepAlive: true, maxSockets: conc, maxFreeSockets: conc });
  const body =
    surface === 'rest'
      ? JSON.stringify({ run: 'echo bench', session: 's' })
      : JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web', arguments: { run: 'echo bench', session: 's' } } });
  const headers: Record<string, string | number> = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  if (surface === 'mcp') {
    headers['mcp-session-id'] = sid;
    headers.accept = 'application/json, text/event-stream';
    headers['mcp-protocol-version'] = '2025-06-18';
  }
  const path = surface === 'rest' ? '/v1/run' : '/mcp';
  const t0 = performance.now();
  const startAt = t0 + warm;
  const endAt = startAt + dur;
  const lat: number[] = [];
  let errors = 0;
  let non200 = 0;
  await Promise.all(
    Array.from(
      { length: conc },
      () =>
        new Promise<void>((resolve) => {
          const one = () => {
            const s = performance.now();
            if (s >= endAt) return resolve();
            const req = http.request({ host: url.hostname, port: url.port, path, method: 'POST', headers, agent }, (res) => {
              res.on('data', () => {});
              res.on('end', () => {
                const e = performance.now();
                if (s >= startAt && e <= endAt) {
                  if (res.statusCode === 200) lat.push(e - s);
                  else non200++;
                }
                one();
              });
            });
            req.on('error', () => {
              errors++;
              setTimeout(one, 10);
            });
            req.end(body);
          };
          one();
        }),
    ),
  );
  agent.destroy();
  process.stdout.write(JSON.stringify({ lat, errors, non200 }));
}

function runClient(url: string, surface: string, conc: number, sid: string, dur: number): Promise<{ lat: number[]; errors: number; non200: number }> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [fileURLToPath(import.meta.url), '--client', '--url', url, '--surface', surface, '--conc', String(conc), '--sid', sid, '--dur', String(dur)], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error('client exited ' + code))));
  });
}

async function main() {
  const seconds = Number(arg('seconds', '5'));
  const nClients = Number(arg('clients', '4'));
  const cores = os.availableParallelism();
  const workerList = arg('workers', `1,${cores}`).split(',').map(Number);
  const concList = arg('conc', '64,1024').split(',').map(Number);
  const rows: string[] = [];
  console.log(`node ${process.version}, ${cores} cores, ${nClients} client processes, ${seconds}s per cell (+1s warm-up)`);
  for (const workers of workerList) {
    const srv = createHttpServer(createFakeRuntime({ record: false }), {
      workers,
      workerScript: fileURLToPath(new URL('./testing.ts', import.meta.url)),
      secret: 'bench-secret-0123456789abcdef',
      workerEnv: { AGENTWEB_FAKE_HTTP: JSON.stringify({ maxConcurrent: 0 }), AGENTWEB_FAKE_RECORD: '0' },
    });
    const { url } = await srv.listen(0);
    const sid = await new Promise<string>((resolve) => {
      const b = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
      const r = http.request(url + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.headers['mcp-session-id'] as string);
      });
      r.end(b);
    });
    for (const surface of ['rest', 'mcp']) {
      for (const conc of concList) {
        const per = Math.ceil(conc / nClients);
        const results = await Promise.all(Array.from({ length: nClients }, () => runClient(url, surface, per, sid, seconds * 1000)));
        const lat = results.flatMap((r) => r.lat).sort((a, b) => a - b);
        const errors = results.reduce((n, r) => n + r.errors + r.non200, 0);
        const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? NaN;
        const row = `| ${workers} | ${surface === 'rest' ? 'POST /v1/run' : 'MCP tools/call'} | ${per * nClients} | ${Math.round(lat.length / seconds).toLocaleString('en-US')} | ${q(0.5).toFixed(2)} | ${q(0.99).toFixed(2)} | ${errors} |`;
        console.log(row);
        rows.push(row);
      }
    }
    await srv.close();
  }
  console.log('\n| workers | surface | concurrency | req/s | p50 ms | p99 ms | errors |\n|---|---|---|---|---|---|---|\n' + rows.join('\n'));
}
