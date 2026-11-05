// MCP over stdio: newline-delimited JSON-RPC on stdin/stdout.
//
// stdout carries protocol messages only; every diagnostic goes to stderr. Lines may arrive split
// across chunks or several to a chunk, with LF or CRLF endings. When stdin ends, `done` resolves
// once every in-flight call has answered and stdout has flushed.

import type { Readable, Writable } from 'node:stream';
import type { Runtime } from '../types.ts';
import { McpCore, RpcCode, rpcError } from './mcp.ts';
import type { CallContext, McpOptions } from './mcp.ts';

export interface StdioOptions extends McpOptions {
  stdin?: Readable;
  stdout?: Writable;
  stderr?: Writable;
  /** tenant passed in RunOptions for every call (stdio = one tenant) */
  tenant?: string;
  /** longest accepted line; longer lines are discarded with a parse error (default 16 MiB) */
  maxLineBytes?: number;
}

export interface StdioServer {
  /** resolves when stdin has ended (or close() was called) and all calls have answered */
  readonly done: Promise<void>;
  /** stop reading input; in-flight calls still answer. Resolves like `done`. */
  close(): Promise<void>;
}

const NL = 0x0a;

export function serveStdio(runtime: Runtime, opts: StdioOptions = {}): StdioServer {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const maxLine = opts.maxLineBytes ?? 16 * 1024 * 1024;
  const log = opts.log ?? ((l: string) => void stderr.write(l + '\n'));
  const core = new McpCore(runtime, { ...opts, log });

  const ctx: CallContext = {
    conn: 'stdio',
    tenant: opts.tenant,
    sessionId: (name) => name,
    forkId: (ref) => ref,
  };

  let pending: Buffer[] = [];
  let pendingLen = 0;
  let discarding = false;
  let inflight = 0;
  let ended = false;
  let outOk = true;
  let lastWrite: Promise<void> = Promise.resolve();
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const write = (msg: unknown) => {
    if (!outOk) return;
    const line = JSON.stringify(msg) + '\n';
    lastWrite = new Promise<void>((resolve) => {
      try {
        stdout.write(line, () => resolve());
      } catch {
        outOk = false;
        resolve();
      }
    });
  };

  const maybeFinish = () => {
    if (ended && inflight === 0) lastWrite.then(() => resolveDone());
  };

  const onLine = (buf: Buffer) => {
    let end = buf.length;
    if (end && buf[end - 1] === 0x0d) end--;
    const text = buf.toString('utf8', 0, end);
    if (!text.trim()) return;
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      write(rpcError(null, RpcCode.ParseError, 'Parse error: each line must be one JSON-RPC message'));
      return;
    }
    inflight++;
    core
      .handle(payload, ctx)
      .then(
        (out) => {
          if (out !== undefined) write(out);
        },
        (e) => log(`agentweb stdio: ${e instanceof Error ? e.stack : String(e)}`),
      )
      .finally(() => {
        inflight--;
        maybeFinish();
      });
  };

  const onData = (chunk: Buffer | string) => {
    if (ended) return;
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let start = 0;
    for (;;) {
      const i = b.indexOf(NL, start);
      if (i < 0) break;
      if (discarding) {
        discarding = false;
      } else if (pendingLen) {
        pending.push(b.subarray(start, i));
        const line = Buffer.concat(pending);
        pending = [];
        pendingLen = 0;
        onLine(line);
      } else {
        onLine(b.subarray(start, i));
      }
      start = i + 1;
    }
    if (start < b.length && !discarding) {
      // Copy: the remainder may be a view into a pooled buffer that the stream reuses.
      const rest = Buffer.from(b.subarray(start));
      pending.push(rest);
      pendingLen += rest.length;
      if (pendingLen > maxLine) {
        pending = [];
        pendingLen = 0;
        discarding = true;
        write(rpcError(null, RpcCode.ParseError, `Parse error: message longer than ${maxLine} bytes`));
      }
    }
  };

  const onEnd = () => {
    if (ended) return;
    // A final line without a trailing newline still counts.
    if (pendingLen && !discarding) {
      const line = Buffer.concat(pending);
      pending = [];
      pendingLen = 0;
      onLine(line);
    }
    ended = true;
    stdin.off('data', onData);
    stdin.off('end', onEnd);
    stdin.off('close', onEnd);
    stdin.off('error', onErr);
    maybeFinish();
  };
  const onErr = (e: Error) => {
    log(`agentweb stdio: stdin error: ${e.message}`);
    onEnd();
  };
  stdout.on('error', (e: Error) => {
    // EPIPE: the client went away. Stop writing; diagnostics only.
    outOk = false;
    log(`agentweb stdio: stdout error: ${e.message}`);
  });

  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.on('close', onEnd);
  stdin.on('error', onErr);

  return {
    done,
    close() {
      onEnd();
      if (typeof stdin.pause === 'function') stdin.pause();
      return done;
    },
  };
}
