// node:cluster primary for createHttpServer({ workers }).
//
// The primary serves no requests. It forks workers that re-run the worker script (which calls
// createHttpServer(...).listen(...) itself), shares one session secret with them, restarts
// crashed workers, and relays the little state workers need from each other: session
// revocations, run events for SSE subscribers on other workers, and metrics for /metrics.

import cluster from 'node:cluster';
import type { Worker } from 'node:cluster';
import { randomBytes } from 'node:crypto';
import type { HttpOptions, HttpServer } from './http.ts';
import { secretBytes } from './token.ts';

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 30_000;

export function startPrimary(opts: HttpOptions, n: number): HttpServer {
  const log = opts.log ?? ((l: string) => void process.stderr.write(l + '\n'));
  const workers = new Set<Worker>();
  const interest = new Map<number, number>();
  const pendingMetrics = new Map<number, { from: Worker; req: unknown; snaps: unknown[]; rts: unknown[]; waiting: Set<number>; timer: NodeJS.Timeout }>();
  let metricsSeq = 0;
  let stopping = false;
  let restarts: number[] = [];
  let env: Record<string, string> = {};
  let url = '';

  const broadcast = (m: unknown, except?: Worker) => {
    for (const w of workers) if (w !== except && w.isConnected()) w.send(m as object);
  };

  const finishMetrics = (id: number) => {
    const p = pendingMetrics.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingMetrics.delete(id);
    if (p.from.isConnected()) p.from.send({ aw: 'metrics+', req: p.req, snaps: p.snaps, rts: p.rts });
  };

  const onMessage = (w: Worker, m: unknown) => {
    if (!m || typeof m !== 'object') return;
    const msg = m as Record<string, unknown>;
    switch (msg.aw) {
      case 'revoke':
      case 'ev':
        broadcast(msg, w);
        break;
      case 'interest': {
        interest.set(w.id, Number(msg.n) || 0);
        let total = 0;
        for (const v of interest.values()) total += v;
        broadcast({ aw: 'interest', total });
        break;
      }
      case 'metrics?': {
        const id = ++metricsSeq;
        const waiting = new Set([...workers].filter((x) => x.isConnected()).map((x) => x.id));
        pendingMetrics.set(id, { from: w, req: msg.req, snaps: [], rts: [], waiting, timer: setTimeout(() => finishMetrics(id), 1000) });
        broadcast({ aw: 'metrics!', req: id });
        break;
      }
      case 'metrics=': {
        const p = pendingMetrics.get(Number(msg.req));
        if (!p || !p.waiting.delete(w.id)) break;
        p.snaps.push(msg.snap);
        p.rts.push(msg.rt);
        if (!p.waiting.size) finishMetrics(Number(msg.req));
        break;
      }
    }
  };

  const fork = (): Worker => {
    const w = cluster.fork(env);
    workers.add(w);
    w.on('message', (m) => onMessage(w, m));
    w.on('exit', (code, signal) => {
      workers.delete(w);
      interest.delete(w.id);
      for (const [id, p] of pendingMetrics) if (p.waiting.delete(w.id) && !p.waiting.size) finishMetrics(id);
      if (stopping) return;
      const now = Date.now();
      restarts = restarts.filter((t) => now - t < RESTART_WINDOW_MS);
      if (restarts.length >= MAX_RESTARTS) {
        log(`agentweb cluster: worker ${w.process.pid} exited (${signal ?? code}); too many restarts, not replacing it`);
        return;
      }
      restarts.push(now);
      log(`agentweb cluster: worker ${w.process.pid} exited (${signal ?? code}); restarting`);
      setTimeout(() => !stopping && fork(), 500).unref();
    });
    return w;
  };

  return {
    async listen(port: number, host?: string) {
      const secret = opts.secret !== undefined ? secretBytes(opts.secret) : randomBytes(32);
      env = {
        ...opts.workerEnv,
        AGENTWEB_WORKER: '1',
        AGENTWEB_WORKERS: String(n),
        AGENTWEB_SECRET: Buffer.from(secret).toString('hex'),
        AGENTWEB_PORT: String(port),
        AGENTWEB_HOST: host ?? '',
      };
      cluster.setupPrimary({
        exec: opts.workerScript ?? process.argv[1],
        args: opts.workerArgs ?? process.argv.slice(2),
        execArgv: process.execArgv.filter((a) => !a.startsWith('--test')),
      });
      const started: Worker[] = [];
      for (let i = 0; i < n; i++) started.push(fork());
      const addrs = await Promise.all(
        started.map(
          (w) =>
            new Promise<{ address: string; port: number }>((resolve, reject) => {
              const onExit = (code: number) => reject(new Error(`agentweb cluster: worker exited with code ${code} before listening`));
              w.once('exit', onExit);
              w.once('listening', (a) => {
                w.off('exit', onExit);
                resolve(a as { address: string; port: number });
              });
            }),
        ),
      ).catch(async (e) => {
        stopping = true;
        for (const w of workers) w.process.kill();
        throw e;
      });
      const a = addrs[0];
      const h = !a.address || a.address === '0.0.0.0' || a.address === '::' ? '127.0.0.1' : a.address.includes(':') ? `[${a.address}]` : a.address;
      url = `http://${h}:${a.port}`;
      return { url };
    },
    async close() {
      stopping = true;
      const exits = [...workers].map(
        (w) =>
          new Promise<void>((resolve) => {
            if (w.isDead()) return resolve();
            const timer = setTimeout(() => w.process.kill('SIGKILL'), (opts.drainMs ?? 30_000) + 5_000);
            w.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
            if (w.isConnected()) w.send({ aw: 'shutdown' });
            else w.process.kill();
          }),
      );
      await Promise.all(exits);
      for (const p of pendingMetrics.values()) clearTimeout(p.timer);
      pendingMetrics.clear();
    },
  };
}
