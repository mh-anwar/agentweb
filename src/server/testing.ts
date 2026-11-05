// A small fake Runtime for tests and benchmarks of the server layer, plus a cluster-worker entry.
//
// Programs it understands (one per call):
//   echo <text>      ok, text = "<session>|<text>"            (anything unrecognised behaves like echo)
//   fail <text>      ok: false
//   throw <code>     throws AwError(<code>)
//   crash            throws a plain Error (internals must not leak)
//   image            ok with one PNG image
//   sleep <ms>       waits, honouring the AbortSignal
//   hang <ms>        waits, ignoring the AbortSignal
//   history          text = programs run so far in this session (fork copies history)
//   whoami           text = JSON of { session, tenant, budget, fork }

import cluster from 'node:cluster';
import { AwError } from '../types.ts';
import type { ErrCode, RunEvent, RunOptions, RunResult, Runtime, ToolSpec } from '../types.ts';
import { createHttpServer } from './http.ts';
import type { HttpOptions } from './http.ts';

export interface FakeCall {
  session: string;
  program: string;
  opts: RunOptions;
}

export interface FakeRuntime extends Runtime {
  calls: FakeCall[];
  aborted: string[];
  closed: boolean;
  /** runs currently executing */
  running: number;
}

export const FAKE_TOOL: ToolSpec = {
  name: 'web',
  description: 'Browse the web with a short program. Returns compact text.',
  inputSchema: {
    type: 'object',
    properties: {
      run: { type: 'string', description: 'the program' },
      session: { type: 'string', description: 'session name (default "default")' },
      budget: { type: 'integer', description: 'max output tokens' },
      fork: { type: 'string', description: 'copy this session first' },
    },
    required: ['run'],
  },
};

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export function createFakeRuntime(o: { record?: boolean } = {}): FakeRuntime {
  const record = o.record ?? true;
  const subs = new Set<(e: RunEvent) => void>();
  const history = new Map<string, string[]>();
  let runs = 0;
  const stats = (t0: number) => ({ steps: 1, ms: Date.now() - t0, tokens: 1, fetches: 0 });

  const wait = (ms: number, signal?: AbortSignal, honour = true) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (honour && signal) {
        const onAbort = () => {
          clearTimeout(timer);
          rt.aborted.push(String((signal.reason as Error)?.message ?? signal.reason));
          reject(signal.reason);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });

  const rt: FakeRuntime = {
    calls: [],
    aborted: [],
    closed: false,
    running: 0,
    async run(session, program, opts = {}) {
      runs++;
      if (record) rt.calls.push({ session, program, opts });
      const t0 = Date.now();
      if (!history.has(session) && opts.fork) history.set(session, [...(history.get(opts.fork) ?? [])]);
      const h = history.get(session) ?? [];
      if (record) history.set(session, h);
      const sp = program.indexOf(' ');
      const verb = sp < 0 ? program : program.slice(0, sp);
      const arg = sp < 0 ? '' : program.slice(sp + 1);
      rt.running++;
      let result: RunResult;
      try {
        switch (verb) {
          case 'fail':
            result = { ok: false, text: arg || 'failed', stats: stats(t0) };
            break;
          case 'throw':
            throw new AwError((arg || 'bad_request') as ErrCode, `fake ${arg || 'bad_request'}`, 'fake hint');
          case 'crash':
            throw new Error('secret internal detail');
          case 'image':
            result = { ok: true, text: 'shot', images: [{ mime: 'image/png', data: PNG_1PX }], stats: stats(t0) };
            break;
          case 'sleep':
            await wait(Number(arg) || 0, opts.signal);
            result = { ok: true, text: 'slept', stats: stats(t0) };
            break;
          case 'hang':
            await wait(Number(arg) || 0, opts.signal, false);
            result = { ok: true, text: 'hung', stats: stats(t0) };
            break;
          case 'history':
            result = { ok: true, text: h.join('\n'), stats: stats(t0) };
            break;
          case 'whoami':
            result = { ok: true, text: JSON.stringify({ session, tenant: opts.tenant, budget: opts.budget, fork: opts.fork }), stats: stats(t0) };
            break;
          default:
            result = { ok: true, text: `${session}|${verb === 'echo' ? arg : program}`, stats: stats(t0) };
        }
      } finally {
        rt.running--;
      }
      if (record) h.push(program);
      if (subs.size) {
        const e: RunEvent = { at: Date.now(), session, tenant: opts.tenant, program, ok: result.ok, stats: result.stats, preview: result.text.slice(0, 80) };
        for (const f of subs) f(e);
      }
      return result;
    },
    tool: () => FAKE_TOOL,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    metrics: () => ({ runs, 'sessions.live': history.size }),
    async close() {
      rt.closed = true;
    },
  };
  return rt;
}

/**
 * Cluster worker entry: `AGENTWEB_FAKE_HTTP` holds JSON HttpOptions (minus functions). Used by
 * the cluster test and the benchmark as `workerScript`.
 */
if (cluster.isWorker && process.env.AGENTWEB_WORKER === '1' && process.env.AGENTWEB_FAKE_HTTP !== undefined) {
  const httpOpts = JSON.parse(process.env.AGENTWEB_FAKE_HTTP || '{}') as HttpOptions;
  const rt = createFakeRuntime({ record: process.env.AGENTWEB_FAKE_RECORD !== '0' });
  await createHttpServer(rt, httpOpts).listen(0);
}
