// Transport-independent MCP core: JSON-RPC 2.0 dispatch for the one agentweb tool.
//
// Transports (stdio, Streamable HTTP) parse bytes into JSON values and hand them to
// `McpCore.handle`, together with a `CallContext` that says who is calling and how tool-level
// session names map to runtime session ids. The core never touches sockets or streams.

import { AwError } from '../types.ts';
import type { RunOptions, RunResult, Runtime, ToolSpec } from '../types.ts';

// ───────────────────────────── protocol constants ─────────────────────────────

/** Newest first. The first entry is what we answer when a client asks for something unknown. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

export function negotiateVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

export const RpcCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export type JsonRpcId = string | number;
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId | null; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: JsonRpcError };

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  const error: JsonRpcError = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id, error };
}

// ───────────────────────────── errors surfaced to agents ─────────────────────────────

/** An error raised by a server layer (limits, shutdown, cancellation) that is safe to show. */
export class ServerError extends Error {
  code: string;
  status: number;
  hint?: string;
  retryAfterSec?: number;
  constructor(code: string, status: number, message: string, hint?: string, retryAfterSec?: number) {
    super(message);
    this.name = 'ServerError';
    this.code = code;
    this.status = status;
    this.hint = hint;
    this.retryAfterSec = retryAfterSec;
  }
}

/** Turn an abort reason into an error an agent can read. */
export function abortError(reason: unknown): Error {
  if (reason instanceof AwError || reason instanceof ServerError) return reason;
  if (reason instanceof Error && reason.name === 'TimeoutError') return new AwError('timeout', 'the call timed out');
  return new ServerError('cancelled', 499, 'the call was cancelled');
}

/** Text an agent sees for a failed call. Unknown errors are not echoed (they may hold internals). */
export function errorText(e: unknown): string {
  if (e instanceof AwError || e instanceof ServerError) {
    return `error (${e.code}): ${e.message}${e.hint ? `\nhint: ${e.hint}` : ''}`;
  }
  return 'error (internal): the server failed while running this program; try again';
}

// ───────────────────────────── tool arguments ─────────────────────────────

export interface ToolArgs {
  run: string;
  session: string;
  budget?: number;
  fork?: string;
}

export type ParsedArgs = { ok: true; args: ToolArgs } | { ok: false; message: string };

export const DEFAULT_SESSION = 'default';
export const MAX_PROGRAM_CHARS = 100_000;
export const MAX_BUDGET = 1_000_000;
const NAME_RE = /^[A-Za-z0-9._:@+~-]{1,128}$/;
const KNOWN_ARGS = new Set(['run', 'session', 'budget', 'fork']);
const RUN_ALIASES = ['program', 'code', 'script', 'command', 'commands', 'input', 'query', 'steps', 'url'];

export function isSessionName(s: string): boolean {
  return NAME_RE.test(s);
}

/** `name` or `scope/name` (scope = another MCP session's scope, or `rest`). */
export function isForkRef(s: string): boolean {
  const i = s.indexOf('/');
  if (i < 0) return NAME_RE.test(s);
  return NAME_RE.test(s.slice(0, i)) && NAME_RE.test(s.slice(i + 1));
}

const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v.length > 40 ? v.slice(0, 40) + '…' : v) : typeof v === 'object' ? (v === null ? 'null' : Array.isArray(v) ? 'an array' : 'an object') : String(v));

const allowedCache = new WeakMap<ToolSpec, Set<string>>();
function allowedArgs(spec?: ToolSpec): Set<string> {
  if (!spec) return KNOWN_ARGS;
  let s = allowedCache.get(spec);
  if (!s) {
    s = new Set(KNOWN_ARGS);
    const declared = spec.inputSchema?.properties;
    if (declared && typeof declared === 'object') for (const k of Object.keys(declared)) s.add(k);
    allowedCache.set(spec, s);
  }
  return s;
}

/**
 * Validate the tool's arguments. Messages are written for the model that sent them: they say
 * what was wrong and what a correct call looks like.
 */
export function parseToolArgs(input: unknown, spec?: ToolSpec): ParsedArgs {
  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: `arguments must be an object like {"run": "open https://example.com"}, got ${show(input)}` };
  }
  const a = input as Record<string, unknown>;
  const allowed = allowedArgs(spec);
  const unknown: string[] = [];
  for (const k in a) if (!allowed.has(k)) unknown.push(k);

  if (a.run === undefined) {
    const alias = unknown.find((k) => RUN_ALIASES.includes(k.toLowerCase()));
    if (alias) return { ok: false, message: `put the program in "run", not "${alias}": {"run": ${show(a[alias])}}` };
    return { ok: false, message: 'missing "run": pass the program text, e.g. {"run": "open https://example.com"}' };
  }
  if (unknown.length) {
    return { ok: false, message: `unknown argument${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => `"${k}"`).join(', ')}; allowed: ${[...allowed].map((k) => `"${k}"`).join(', ')}` };
  }
  if (typeof a.run !== 'string') return { ok: false, message: `"run" must be a string holding the program, got ${show(a.run)}` };
  if (!a.run.trim()) return { ok: false, message: '"run" is empty: pass at least one step, e.g. "open https://example.com"' };
  if (a.run.length > MAX_PROGRAM_CHARS) return { ok: false, message: `"run" is ${a.run.length} characters; the limit is ${MAX_PROGRAM_CHARS}. Split it into several calls` };

  let session = DEFAULT_SESSION;
  if (a.session !== undefined && a.session !== null && a.session !== '') {
    if (typeof a.session !== 'string') return { ok: false, message: `"session" must be a string name, got ${show(a.session)}` };
    if (!NAME_RE.test(a.session)) return { ok: false, message: `"session" ${show(a.session)} is not a valid name: use 1-128 of A-Z a-z 0-9 . _ : @ + ~ - (no slashes)` };
    session = a.session;
  }

  let budget: number | undefined;
  if (a.budget !== undefined && a.budget !== null) {
    let b = a.budget;
    if (typeof b === 'string' && /^\s*\d+\s*$/.test(b)) b = Number(b);
    if (typeof b !== 'number' || !Number.isInteger(b)) return { ok: false, message: `"budget" must be an integer number of tokens, got ${show(a.budget)}` };
    if (b < 1 || b > MAX_BUDGET) return { ok: false, message: `"budget" must be between 1 and ${MAX_BUDGET}, got ${b}` };
    budget = b;
  }

  let fork: string | undefined;
  if (a.fork !== undefined && a.fork !== null && a.fork !== '') {
    if (typeof a.fork !== 'string') return { ok: false, message: `"fork" must be the name of an existing session, got ${show(a.fork)}` };
    if (!isForkRef(a.fork)) return { ok: false, message: `"fork" ${show(a.fork)} is not a valid session name` };
    if (a.fork === session) return { ok: false, message: `"fork" names the session itself (${show(session)}); pick a new "session" name to fork into` };
    fork = a.fork;
  }
  return { ok: true, args: { run: a.run, session, budget, fork } };
}

// ───────────────────────────── tool results ─────────────────────────────

export type ContentItem = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface CallToolResult {
  content: ContentItem[];
  isError?: boolean;
}

export function toCallResult(r: RunResult): CallToolResult {
  const content: ContentItem[] = [{ type: 'text', text: typeof r.text === 'string' ? r.text : String(r.text ?? '') }];
  if (Array.isArray(r.images)) for (const im of r.images) if (im && typeof im.data === 'string') content.push({ type: 'image', data: im.data, mimeType: im.mime || 'image/png' });
  return r.ok ? { content } : { content, isError: true };
}

export function errorResult(e: unknown): CallToolResult {
  return { content: [{ type: 'text', text: errorText(e) }], isError: true };
}

// ───────────────────────────── the core ─────────────────────────────

export type RunFn = (session: string, program: string, opts: RunOptions) => Promise<RunResult>;

export interface CallContext {
  /** connection key; scopes request ids for notifications/cancelled */
  conn?: string;
  tenant?: string;
  /** maps the tool's `session` argument to a runtime session id */
  sessionId(name: string): string;
  /** maps the tool's `fork` argument (`name` or `scope/name`) to a runtime session id */
  forkId(ref: string): string;
  /** aborts every tool call of this request (timeout, disconnect, shutdown) */
  signal?: AbortSignal;
  /** replaces runtime.run (limits, metrics); must return the runtime's own promise */
  run?: RunFn;
}

export interface McpOptions {
  serverName?: string;
  serverVersion?: string;
  instructions?: string;
  /** diagnostics; never stdout */
  log?: (line: string) => void;
}

/** Answer a value received from a transport: a message, a batch, or garbage. */
export class McpCore {
  readonly runtime: Runtime;
  #opts: McpOptions;
  #spec: ToolSpec | undefined;
  #inflight = new Map<string, AbortController>();

  constructor(runtime: Runtime, opts: McpOptions = {}) {
    this.runtime = runtime;
    this.#opts = opts;
  }

  tool(): ToolSpec {
    return (this.#spec ??= this.runtime.tool());
  }

  /** Number of tools/call requests in a payload (used by transports for admission). */
  static countCalls(payload: unknown): number {
    const one = (m: unknown) => (m && typeof m === 'object' && (m as { method?: unknown }).method === 'tools/call' && 'id' in m ? 1 : 0);
    return Array.isArray(payload) ? payload.reduce((n: number, m) => n + one(m), 0) : one(payload);
  }

  async handleText(text: string, ctx: CallContext): Promise<string | undefined> {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return JSON.stringify(rpcError(null, RpcCode.ParseError, 'Parse error: body is not valid JSON'));
    }
    const out = await this.handle(payload, ctx);
    return out === undefined ? undefined : JSON.stringify(out);
  }

  async handle(payload: unknown, ctx: CallContext): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined> {
    if (!Array.isArray(payload)) return this.handleMessage(payload, ctx);
    if (payload.length === 0) return rpcError(null, RpcCode.InvalidRequest, 'Invalid Request: empty batch');
    const outs = await Promise.all(payload.map((m) => this.handleMessage(m, ctx)));
    const answered = outs.filter((o): o is JsonRpcResponse => o !== undefined);
    return answered.length ? answered : undefined;
  }

  async handleMessage(msg: unknown, ctx: CallContext): Promise<JsonRpcResponse | undefined> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return rpcError(null, RpcCode.InvalidRequest, 'Invalid Request: expected a JSON-RPC object');
    }
    const m = msg as Record<string, unknown>;
    const hasId = 'id' in m;
    const id = m.id;
    const validId = typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
    const replyId: JsonRpcId | null = validId ? (id as JsonRpcId) : null;

    if (typeof m.method !== 'string') {
      // A response from the client (we never send requests) or garbage. Responses get no reply.
      if (hasId && ('result' in m || 'error' in m)) return undefined;
      return rpcError(replyId, RpcCode.InvalidRequest, 'Invalid Request: missing "method"');
    }
    if (m.jsonrpc !== '2.0') {
      return hasId ? rpcError(replyId, RpcCode.InvalidRequest, 'Invalid Request: "jsonrpc" must be "2.0"') : undefined;
    }
    if (!hasId) {
      this.#notification(m.method, m.params, ctx);
      return undefined;
    }
    if (!validId) return rpcError(null, RpcCode.InvalidRequest, 'Invalid Request: "id" must be a string or a number');
    const params = m.params;
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      return rpcError(replyId, RpcCode.InvalidParams, 'Invalid params: "params" must be an object');
    }
    try {
      return await this.#request(replyId as JsonRpcId, m.method, (params ?? {}) as Record<string, unknown>, ctx);
    } catch (e) {
      this.#log(`agentweb mcp: ${m.method} failed: ${e instanceof Error ? e.stack || e.message : String(e)}`);
      return rpcError(replyId, RpcCode.InternalError, 'Internal error');
    }
  }

  async #request(id: JsonRpcId, method: string, params: Record<string, unknown>, ctx: CallContext): Promise<JsonRpcResponse | undefined> {
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: '2.0', id, result });
    switch (method) {
      case 'initialize': {
        const result: Record<string, unknown> = {
          protocolVersion: negotiateVersion(params.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: this.#opts.serverName ?? 'agentweb', version: this.#opts.serverVersion ?? '0.1.0' },
        };
        if (this.#opts.instructions) result.instructions = this.#opts.instructions;
        return ok(result);
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: [this.#listedTool()] });
      case 'tools/call':
        return this.#call(id, params, ctx);
      // Harmless empty answers for clients that probe these without checking capabilities.
      case 'resources/list':
        return ok({ resources: [] });
      case 'resources/templates/list':
        return ok({ resourceTemplates: [] });
      case 'prompts/list':
        return ok({ prompts: [] });
      case 'logging/setLevel':
        return ok({});
      default:
        return rpcError(id, RpcCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  #listedTool(): Record<string, unknown> {
    const t = this.tool();
    return { name: t.name, description: t.description, inputSchema: t.inputSchema };
  }

  async #call(id: JsonRpcId, params: Record<string, unknown>, ctx: CallContext): Promise<JsonRpcResponse | undefined> {
    const spec = this.tool();
    if (typeof params.name !== 'string') return rpcError(id, RpcCode.InvalidParams, `Invalid params: "name" is required (the tool is "${spec.name}")`);
    if (params.name !== spec.name) return rpcError(id, RpcCode.InvalidParams, `Unknown tool: "${params.name}". This server has one tool, "${spec.name}"`);
    const parsed = parseToolArgs(params.arguments, spec);
    // Argument errors are tool errors, not protocol errors, so the model sees them and can fix the call.
    if (!parsed.ok) return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error (bad_request): ${parsed.message}` }], isError: true } };
    const { run, session, budget, fork } = parsed.args;

    const key = `${ctx.conn ?? ''}\u0000${typeof id}:${id}`;
    const ac = new AbortController();
    const outer = ctx.signal;
    const onOuter = () => ac.abort(outer?.reason);
    if (outer) {
      if (outer.aborted) ac.abort(outer.reason);
      else outer.addEventListener('abort', onOuter, { once: true });
    }
    this.#inflight.set(key, ac);
    let cancelled = false;
    const onCancel = () => {
      if (ac.signal.reason instanceof ServerError && ac.signal.reason.code === 'cancelled_by_client') cancelled = true;
    };
    ac.signal.addEventListener('abort', onCancel, { once: true });
    try {
      const opts: RunOptions = { signal: ac.signal };
      if (budget !== undefined) opts.budget = budget;
      if (ctx.tenant !== undefined) opts.tenant = ctx.tenant;
      if (fork !== undefined) opts.fork = ctx.forkId(fork);
      const runFn: RunFn = ctx.run ?? ((s, p, o) => this.runtime.run(s, p, o));
      const result = await raceAbort(() => runFn(ctx.sessionId(session), run, opts), ac.signal);
      return { jsonrpc: '2.0', id, result: toCallResult(result) };
    } catch (e) {
      if (cancelled) return undefined; // cancelled requests get no response
      if (!(e instanceof AwError || e instanceof ServerError)) this.#log(`agentweb mcp: run failed: ${e instanceof Error ? e.stack || e.message : String(e)}`);
      return { jsonrpc: '2.0', id, result: errorResult(e) };
    } finally {
      outer?.removeEventListener('abort', onOuter);
      if (this.#inflight.get(key) === ac) this.#inflight.delete(key);
    }
  }

  #notification(method: string, params: unknown, ctx: CallContext): void {
    if (method === 'notifications/cancelled' && params && typeof params === 'object') {
      const rid = (params as { requestId?: unknown }).requestId;
      if (typeof rid === 'string' || typeof rid === 'number') {
        const ac = this.#inflight.get(`${ctx.conn ?? ''}\u0000${typeof rid}:${rid}`);
        ac?.abort(new ServerError('cancelled_by_client', 499, 'cancelled by the client'));
      }
    }
    // notifications/initialized, progress, roots/list_changed, …: accepted, never answered.
  }

  /** number of tool calls currently running through this core */
  get inflight(): number {
    return this.#inflight.size;
  }

  #log(line: string): void {
    (this.#opts.log ?? ((l: string) => process.stderr.write(l + '\n')))(line);
  }
}

/**
 * Run `fn`, but settle as soon as `signal` aborts even if the runtime ignores the signal. The
 * runtime's own promise keeps running to completion (and its rejection is swallowed here).
 */
export function raceAbort<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal.reason));
  let p: Promise<T>;
  try {
    p = fn();
  } catch (e) {
    return Promise.reject(e);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        // An abort-induced rejection from the runtime reads better as the abort reason.
        reject(signal.aborted ? abortError(signal.reason) : e);
      },
    );
  });
}
