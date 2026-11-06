// A minimal MCP stdio client on Node built-ins: initialize, tools/list, tools/call.
//
// It speaks newline-delimited JSON-RPC 2.0 over the child's stdin/stdout, which is what the
// MCP stdio transport specifies. It answers the few requests a server may send back
// (ping, roots/list) the way an ordinary client such as Claude Code would, so that servers
// which ask for workspace roots (Playwright MCP does) behave as they do in real use.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  [k: string]: unknown;
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  [k: string]: unknown;
}

export interface McpCallResult {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: unknown;
  [k: string]: unknown;
}

export interface McpClientOptions {
  /** Per-request timeout. Default 60 s. */
  requestTimeoutMs?: number;
  /** Directory reported as the single workspace root. Default: spec.cwd or process.cwd(). */
  rootDir?: string;
  clientName?: string;
  clientVersion?: string;
  /** Keep at most this much of the child's stderr (bytes). Default 64 KiB. */
  stderrLimit?: number;
}

export class McpError extends Error {
  code: number | string;
  data: unknown;
  constructor(code: number | string, message: string, data?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

export const PROTOCOL_VERSION = '2025-06-18';

export class McpClient {
  readonly spec: McpServerSpec;
  serverInfo: { name?: string; version?: string } = {};
  serverCapabilities: Record<string, unknown> = {};
  instructions: string | undefined;
  protocolVersion: string | undefined;

  private child: ChildProcess | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  private stderrBuf = '';
  private exited: { code: number | null; signal: string | null } | undefined;
  private opts: Required<Omit<McpClientOptions, 'rootDir'>> & { rootDir: string };

  constructor(spec: McpServerSpec, opts: McpClientOptions = {}) {
    this.spec = spec;
    this.opts = {
      requestTimeoutMs: opts.requestTimeoutMs ?? 60_000,
      rootDir: opts.rootDir ?? spec.cwd ?? process.cwd(),
      clientName: opts.clientName ?? 'agentweb-baselines',
      clientVersion: opts.clientVersion ?? '0.1.0',
      stderrLimit: opts.stderrLimit ?? 64 * 1024,
    };
  }

  /** Text the server wrote to stderr (tail, bounded). */
  get stderr(): string {
    return this.stderrBuf;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Spawn the server and run the initialize handshake. */
  async start(): Promise<void> {
    if (this.child) throw new Error('already started');
    const child = spawn(this.spec.command, this.spec.args ?? [], {
      cwd: this.spec.cwd,
      env: { ...process.env, ...this.spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group, so close() can take down the browser the server launched.
      detached: true,
    });
    this.child = child;
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => this.onData(chunk));
    child.stderr!.on('data', (chunk: string) => {
      this.stderrBuf += chunk;
      if (this.stderrBuf.length > this.opts.stderrLimit) {
        this.stderrBuf = this.stderrBuf.slice(-this.opts.stderrLimit);
      }
    });
    child.stdin!.on('error', () => {}); // EPIPE after the child died: reported via 'exit'.
    child.on('error', (err) => this.failAll(err));
    child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      const tail = this.stderrBuf.trim().split('\n').slice(-5).join('\n');
      this.failAll(new McpError('exited', `server exited (code ${code}, signal ${signal})${tail ? ': ' + tail : ''}`));
    });

    const init = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: this.opts.clientName, version: this.opts.clientVersion },
    })) as {
      protocolVersion?: string;
      capabilities?: Record<string, unknown>;
      serverInfo?: { name?: string; version?: string };
      instructions?: string;
    };
    this.protocolVersion = init.protocolVersion;
    this.serverCapabilities = init.capabilities ?? {};
    this.serverInfo = init.serverInfo ?? {};
    this.instructions = init.instructions;
    this.notify('notifications/initialized');
  }

  /** All tools, following pagination cursors. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = (await this.request('tools/list', cursor ? { cursor } : {})) as {
        tools?: McpTool[];
        nextCursor?: string;
      };
      tools.push(...(res.tools ?? []));
      if (!res.nextCursor) return tools;
      cursor = res.nextCursor;
    }
    throw new McpError('pagination', 'tools/list returned more than 100 pages');
  }

  /** Call a tool. Protocol errors throw; tool errors come back with isError: true. */
  async callTool(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<McpCallResult> {
    const res = (await this.request('tools/call', { name, arguments: args }, timeoutMs)) as McpCallResult;
    return { ...res, content: Array.isArray(res?.content) ? res.content : [] };
  }

  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const child = this.child;
    if (!child || this.exited) return Promise.reject(new McpError('closed', `cannot send ${method}: server not running`));
    const id = this.nextId++;
    const ms = timeoutMs ?? this.opts.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Tell the server to stop working on it, as the spec asks.
        this.notify('notifications/cancelled', { requestId: id, reason: 'timeout' });
        reject(new McpError('timeout', `${method} timed out after ${ms} ms`));
      }, ms);
      this.pending.set(id, { resolve, reject, timer, method });
      this.write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.child || this.exited) return;
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  /** Close stdin, then escalate to SIGTERM / SIGKILL on the whole process group. */
  async close(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (!this.exited) {
      const done = new Promise<void>((r) => child.once('exit', () => r()));
      try {
        child.stdin!.end();
      } catch {}
      const waited = await Promise.race([done.then(() => true), sleep(graceMs).then(() => false)]);
      if (!waited) {
        killGroup(child.pid, 'SIGTERM');
        const t = await Promise.race([done.then(() => true), sleep(graceMs).then(() => false)]);
        if (!t) killGroup(child.pid, 'SIGKILL');
        await Promise.race([done, sleep(graceMs)]);
      }
    }
    // Stragglers (the browser) can outlive the server even after a clean exit.
    killGroup(child.pid, 'SIGKILL');
    this.failAll(new McpError('closed', 'client closed'));
  }

  private write(msg: unknown): void {
    try {
      this.child!.stdin!.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      this.failAll(err as Error);
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // Servers sometimes log to stdout by mistake. Keep it visible but do not die.
        this.stderrBuf += `[stdout non-JSON] ${line.slice(0, 500)}\n`;
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: any): void {
    if (msg && typeof msg === 'object' && 'id' in msg && ('result' in msg || 'error' in msg) && !('method' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new McpError(msg.error.code ?? 'error', `${p.method}: ${msg.error.message ?? 'error'}`, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (msg && typeof msg.method === 'string' && 'id' in msg) {
      // Server → client request.
      let result: unknown;
      let error: { code: number; message: string } | undefined;
      switch (msg.method) {
        case 'ping':
          result = {};
          break;
        case 'roots/list':
          result = { roots: [{ uri: pathToFileURL(this.opts.rootDir).href, name: 'workspace' }] };
          break;
        default:
          error = { code: -32601, message: `method not supported by client: ${msg.method}` };
      }
      this.write(error ? { jsonrpc: '2.0', id: msg.id, error } : { jsonrpc: '2.0', id: msg.id, result });
    }
    // Notifications (logging, list_changed, progress) are ignored.
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, sig);
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref());
}

/** Convenience: start, run fn, always close. */
export async function withMcp<T>(spec: McpServerSpec, fn: (c: McpClient) => Promise<T>, opts?: McpClientOptions): Promise<T> {
  const c = new McpClient(spec, opts);
  try {
    await c.start();
    return await fn(c);
  } finally {
    await c.close();
  }
}
