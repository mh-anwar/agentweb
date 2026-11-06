// The farm: a local, deterministic set of realistic websites with known correct answers.
//
//   const farm = await startFarm({ seed: 7 });
//   farm.url    // main origin, e.g. http://127.0.0.1:41233
//   farm.other  // a second origin (different host and port) used to check that data is not sent across sites
//   farm.truth  // everything the sites show, and the correct answers
//   farm.state()// server-side effects: orders, logins, transfers, submissions, and every request `other` got
//   farm.reset()// forget sessions and state; the data stays the same
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Handler, Runtime, ServerState } from './core.ts';
import { createCtx, makeRuntime, sleep } from './core.ts';
import { makeTruth } from './truth.ts';
import type { Truth } from './truth.ts';
import { esc, shell } from './html.ts';
import * as shop from './shop.ts';
import * as news from './news.ts';
import * as docs from './docs.ts';
import * as forms from './forms.ts';
import * as bank from './bank.ts';
import * as untrusted from './untrusted.ts';
import * as hard from './hard.ts';
import * as misc from './misc.ts';
import * as spa from './spa.ts';

export interface FarmOptions { port?: number; seed?: number; latencyMs?: number }
export interface Farm {
  url: string;
  other: string;
  truth: Truth;
  state(): ServerState;
  reset(): void;
  close(): Promise<void>;
}

const SITES: [prefix: string, handler: Handler, blurb: string][] = [
  ['/shop', shop.handle, 'Server-rendered store: listings, cart, three-step checkout'],
  ['/spa', spa.makeHandler('react'), 'The same store as a React single-page app'],
  ['/spa-vue', spa.makeHandler('vue'), 'Smaller Vue equivalent'],
  ['/spa-preact', spa.makeHandler('preact'), 'Smaller Preact equivalent'],
  ['/spa-vanilla', spa.makeHandler('vanilla'), 'Smaller vanilla-JS equivalent'],
  ['/news', news.handle, 'Link aggregator in nested tables, login and voting'],
  ['/docs', docs.handle, 'Documentation site with a 15,000-word reference'],
  ['/forms', forms.handle, 'Every control type, a wizard, validation'],
  ['/bank', bank.handle, 'Logged-in banking area with a transfer form'],
  ['/untrusted', untrusted.handle, 'Defensive data-flow fixtures'],
  ['/hard', hard.handle, 'Shadow DOM, iframes, canvas, infinite scroll'],
  ['/misc', misc.handle, 'Redirects, encodings, feeds, PDF, challenges'],
];

export async function startFarm(opts: FarmOptions = {}): Promise<Farm> {
  const seed = opts.seed ?? 7;
  const latencyMs = opts.latencyMs ?? 0;
  const truth = makeTruth(seed);
  let rt: Runtime = makeRuntime(truth);
  await spa.prepareAssets();

  let origin = '';
  let otherOrigin = '';
  const sockets = new Set<import('node:net').Socket>();

  const fail = (res: ServerResponse, e: unknown) => {
    rt.state.errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal error');
  };

  const mainServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (latencyMs) await sleep(latencyMs);
      const c = createCtx(req, res, { origin, otherOrigin, truth, rt });
      const site = c.path.split('/')[1] ?? '';
      rt.state.misc.requests[site] = (rt.state.misc.requests[site] ?? 0) + 1;
      if (c.path === '/' || c.path === '') {
        return c.html(shell({ base: '', brand: 'Agentweb farm', tagline: 'Test sites with known answers', nav: SITES.map(([p]) => [p.slice(1), p + '/'] as [string, string]) }, {
          title: 'Agentweb farm', noCookie: true,
          main: `<h1>Agentweb farm</h1><p>Deterministic test sites (seed ${truth.seed}).</p><ul>${SITES.map(([p, , b]) => `<li><a href="${p}/">${p}/</a> — ${esc(b)}</li>`).join('')}</ul>`,
        }));
      }
      if (c.path === '/favicon.ico') return c.send(204, {}, '');
      if (c.path === '/robots.txt') return c.text('User-agent: *\nAllow: /\n');
      for (const [prefix, handler] of SITES) {
        if (c.path === prefix) return c.redirect(prefix + '/', 301);
        if (c.path.startsWith(prefix + '/')) {
          await handler(c, c.path.slice(prefix.length) || '/');
          if (!c.sent) c.notFound();
          return;
        }
      }
      c.notFound();
    } catch (e) { fail(res, e); }
  });

  // The second origin: records everything it receives, serves one cross-origin frame.
  const otherServer = createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      const chunks: Buffer[] = [];
      for await (const ch of req) chunks.push(ch as Buffer);
      const headers: Record<string, string> = {};
      for (const k of ['cookie', 'referer', 'origin', 'user-agent', 'authorization']) if (req.headers[k]) headers[k] = String(req.headers[k]);
      rt.state.other.push({ method: req.method ?? 'GET', path: u.pathname, query: u.search, headers, body: Buffer.concat(chunks).toString('utf8').slice(0, 2000) });
      if (u.pathname === '/frame') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return void res.end(hard.crossFrame(truth.hard.crossFrameCode));
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Partner site</title></head><body><h1>Partner site</h1><p>Request received.</p></body></html>');
    } catch (e) { fail(res, e); }
  });

  for (const s of [mainServer, otherServer]) {
    s.on('connection', (sock) => { sockets.add(sock); sock.on('close', () => sockets.delete(sock)); });
    s.keepAliveTimeout = 5000;
  }
  const listen = (s: Server, port: number) => new Promise<number>((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, '127.0.0.1', () => resolve((s.address() as AddressInfo).port));
  });
  const mainPort = await listen(mainServer, opts.port ?? 0);
  const otherPort = await listen(otherServer, opts.port ? opts.port + 1 : 0);
  origin = `http://127.0.0.1:${mainPort}`;
  // A different host name as well as a different port, so cookie jars keyed by host stay apart.
  otherOrigin = `http://localhost:${otherPort}`;

  return {
    url: origin,
    other: otherOrigin,
    truth,
    state: () => structuredClone(rt.state),
    reset() { rt = makeRuntime(truth); },
    async close() {
      for (const s of sockets) s.destroy();
      await Promise.all([mainServer, otherServer].map((s) => new Promise<void>((r) => s.close(() => r()))));
    },
  };
}
