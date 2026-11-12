// The bridge to the user's own browser.
//
// The agentweb browser extension (extension/) connects out to this hub from inside the user's
// Chrome and relays DevTools commands to tabs through chrome.debugger. Towards agentweb the hub
// looks like a browser's DevTools socket, limited to what the chrome engine uses in "shared" mode
// (pages open as tabs in the user's own profile; only tabs agentweb opened are closed):
//
//   agentweb chrome engine ──CDP over ws──▶ hub /cdp ──JSON──▶ extension ──chrome.debugger──▶ tab
//
// One hub serves every agentweb process on the machine: the first one to need it listens, the
// others connect to it. The address and an access token are kept in ~/.agentweb/bridge.json
// (readable only by the user). A web page cannot use the hub: /cdp needs the token and refuses
// any connection that carries an Origin header; /extension accepts only an extension origin.

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { acceptWs, type WsConn } from './ws.ts';

export const DEFAULT_BRIDGE_PORT = 4466;
export const NOT_CONNECTED =
  'the agentweb browser extension is not connected. Ask the user to open Chrome with the agentweb extension installed and switched on ' +
  '(its toolbar icon shows whether it is connected), then try again';

export interface HubOptions {
  port?: number;
  host?: string;
  /** where the address and token are written (default ~/.agentweb/bridge.json); false = nowhere */
  stateFile?: string | false;
  token?: string;
  /** how long a browser-level call waits for the extension to connect */
  waitForExtensionMs?: number;
  log?: (line: string) => void;
}

export interface HubStatus {
  port: number;
  extension: boolean;
  browser: string;
  clients: number;
  tabs: { tabId: number; targetId: string; owned: boolean }[];
  offered: OfferedTab[];
}

export interface OfferedTab {
  tabId: number;
  url: string;
  title: string;
}

export interface Hub {
  /** DevTools endpoint for the chrome engine (ws://127.0.0.1:port/cdp?token=…) */
  url: string;
  port: number;
  token: string;
  status(): HubStatus;
  close(): Promise<void>;
}

interface Client {
  conn: WsConn;
  tabs: Set<number>;
}

interface Tab {
  client: Client;
  targetId: string;
  /** opened by agentweb (closed when released); false = the user's own tab, only detached */
  owned: boolean;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function bridgeStateFile(env: Record<string, string | undefined> = process.env): string {
  return join(env.AGENTWEB_HOME ?? join(homedir(), '.agentweb'), 'bridge.json');
}

export async function startHub(opts: HubOptions = {}): Promise<Hub> {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? randomBytes(18).toString('base64url');
  const waitMs = opts.waitForExtensionMs ?? 8000;
  const log = opts.log ?? (() => {});

  let ext: WsConn | undefined;
  let hello: { product: string; userAgent: string; version: string } = { product: '', userAgent: '', version: '' };
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const clients = new Set<Client>();
  const tabs = new Map<number, Tab>();
  const children = new Map<string, number>(); // child CDP session -> tab
  let offered: OfferedTab[] = [];
  const extWaiters: (() => void)[] = [];

  const sid = (tabId: number) => `tab-${tabId}`;

  function extCall<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const e = ext;
    if (!e || !e.open) return Promise.reject(new Error(NOT_CONNECTED));
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method}: the browser extension did not answer in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        e.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  async function needExtension(): Promise<void> {
    if (ext?.open) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, waitMs);
      function done() {
        clearTimeout(t);
        resolve();
      }
      extWaiters.push(done);
    });
    if (!ext?.open) throw new Error(NOT_CONNECTED);
  }

  function emit(c: Client, method: string, params: unknown, sessionId?: string): void {
    if (!c.conn.open) return;
    try {
      c.conn.send(JSON.stringify(sessionId ? { method, params, sessionId } : { method, params }));
    } catch {}
  }

  function targetInfo(tabId: number, t: Tab, extra: Record<string, unknown> = {}) {
    return { targetId: t.targetId, type: 'page', title: '', url: 'about:blank', attached: true, canAccessOpener: false, browserContextId: 'default', ...extra };
  }

  function forgetTab(tabId: number, notify: boolean): void {
    const t = tabs.get(tabId);
    if (!t) return;
    tabs.delete(tabId);
    t.client.tabs.delete(tabId);
    for (const [s, id] of [...children]) if (id === tabId) children.delete(s);
    if (notify) emit(t.client, 'Target.detachedFromTarget', { sessionId: sid(tabId), targetId: t.targetId });
  }

  function adopt(c: Client, tabId: number, targetId: string, owned: boolean, extra: Record<string, unknown> = {}): void {
    const t: Tab = { client: c, targetId, owned };
    tabs.set(tabId, t);
    c.tabs.add(tabId);
    emit(c, 'Target.attachedToTarget', { sessionId: sid(tabId), targetInfo: targetInfo(tabId, t, extra), waitingForDebugger: false });
  }

  async function browserCall(c: Client, method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'Browser.getVersion':
        await needExtension();
        return { protocolVersion: '1.3', product: hello.product || 'Chrome/0.0.0.0', revision: '', userAgent: hello.userAgent, jsVersion: '' };
      case 'Target.setAutoAttach':
      case 'Target.setDiscoverTargets':
      case 'Browser.close':
        return {};
      case 'Target.createTarget': {
        await needExtension();
        const r = await extCall<{ tabId: number; targetId: string }>('createTab', { url: p?.url ?? 'about:blank', background: p?.background !== false });
        // the answer first, then the attach event: the pool accepts either order
        queueMicrotask(() => adopt(c, r.tabId, r.targetId, true));
        return { targetId: r.targetId };
      }
      case 'Target.getTargets': {
        await needExtension();
        const r = await extCall<{ tabs: (OfferedTab & { targetId?: string })[] }>('listTabs');
        return { targetInfos: r.tabs.map((t) => ({ targetId: t.targetId ?? `tab:${t.tabId}`, type: 'page', title: t.title, url: t.url, attached: tabs.has(t.tabId), browserContextId: 'default' })) };
      }
      case 'Target.attachToTarget': {
        // only tabs the user offered from the extension's popup can be taken over
        const m = /^tab:(\d+)$/.exec(String(p?.targetId ?? ''));
        const tabId = m ? Number(m[1]) : NaN;
        if (!offered.some((o) => o.tabId === tabId)) throw new Error('that tab was not shared with agentweb: the user shares a tab from the extension\'s toolbar button');
        if (tabs.has(tabId)) throw new Error('that tab is already in use by an agent');
        await needExtension();
        const r = await extCall<{ targetId: string }>('attachTab', { tabId });
        offered = offered.filter((o) => o.tabId !== tabId);
        adopt(c, tabId, r.targetId, false);
        return { sessionId: sid(tabId) };
      }
      case 'Target.closeTarget': {
        const hit = [...tabs].find(([, t]) => t.targetId === p?.targetId && t.client === c);
        if (!hit) return { success: false };
        const [tabId, t] = hit;
        forgetTab(tabId, true);
        await extCall(t.owned ? 'closeTab' : 'detachTab', { tabId }).catch(() => {});
        return { success: true };
      }
      case 'Target.detachFromTarget': {
        const tabId = Number(String(p?.sessionId ?? '').replace(/^tab-/, ''));
        const t = tabs.get(tabId);
        if (!t || t.client !== c) return {};
        forgetTab(tabId, false);
        await extCall('detachTab', { tabId }).catch(() => {});
        return {};
      }
      default:
        throw new Error(`'${method}' is not available through the browser extension`);
    }
  }

  async function onClientMessage(c: Client, text: string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    const { id, method, params, sessionId } = msg ?? {};
    if (typeof id !== 'number' || typeof method !== 'string') return;
    const reply = (body: Record<string, unknown>) => {
      if (!c.conn.open) return;
      try {
        c.conn.send(JSON.stringify(sessionId ? { id, sessionId, ...body } : { id, ...body }));
      } catch {}
    };
    try {
      let result: unknown;
      if (sessionId) {
        const top = /^tab-(\d+)$/.exec(sessionId);
        const tabId = top ? Number(top[1]) : children.get(sessionId);
        const t = tabId === undefined ? undefined : tabs.get(tabId);
        if (!t || t.client !== c) throw new Error('Session with given id not found');
        result = await extCall('cdp', { tabId, sessionId: top ? undefined : sessionId, method, params }, 120_000);
      } else result = await browserCall(c, method, params);
      reply({ result: result ?? {} });
    } catch (e) {
      reply({ error: { code: -32000, message: (e as Error).message || String(e) } });
    }
  }

  function onExtMessage(text: string): void {
    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof msg?.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? msg.error)));
      else p.resolve(msg.result ?? {});
      return;
    }
    switch (msg?.event) {
      case 'hello':
        hello = { product: String(msg.product ?? ''), userAgent: String(msg.userAgent ?? ''), version: String(msg.version ?? '') };
        log(`extension connected (${hello.product})`);
        return;
      case 'cdp': {
        const t = tabs.get(msg.tabId);
        if (!t) return;
        if (msg.method === 'Target.attachedToTarget' && msg.params?.sessionId) children.set(msg.params.sessionId, msg.tabId);
        if (msg.method === 'Target.detachedFromTarget' && msg.params?.sessionId) children.delete(msg.params.sessionId);
        emit(t.client, msg.method, msg.params ?? {}, msg.sessionId || sid(msg.tabId));
        return;
      }
      case 'detached':
        forgetTab(msg.tabId, true);
        return;
      case 'popup': {
        const opener = tabs.get(msg.openerTabId);
        if (!opener) return void extCall('detachTab', { tabId: msg.tabId }).catch(() => {});
        adopt(opener.client, msg.tabId, String(msg.targetId), true, { openerId: opener.targetId, url: String(msg.url ?? '') });
        return;
      }
      case 'offered':
        offered = Array.isArray(msg.tabs) ? msg.tabs.map((t: any) => ({ tabId: Number(t.tabId), url: String(t.url ?? ''), title: String(t.title ?? '') })) : [];
        return;
    }
  }

  function dropExtension(reason: string): void {
    ext = undefined;
    offered = [];
    for (const [id, p] of [...pending]) {
      pending.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(`the browser extension disconnected (${reason})`));
    }
    for (const tabId of [...tabs.keys()]) forgetTab(tabId, true);
    log('extension disconnected');
  }

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.headers.origin) {
      res.writeHead(403).end();
      return;
    }
    if (path === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ agentweb: 'bridge', extension: !!ext?.open }));
      return;
    }
    res.writeHead(404).end();
  });

  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const origin = String(req.headers.origin ?? '');
    if (u.pathname === '/extension') {
      if (!/^(chrome|moz|edge)-extension:\/\//.test(origin)) return void socket.destroy();
      const conn = acceptWs(req, socket, head);
      if (!conn) return;
      // a newer connection replaces the old one (the extension was reloaded)
      const old = ext;
      ext = conn;
      if (old?.open) {
        old.onClose = () => {};
        old.close();
        dropExtension('replaced');
        ext = conn;
      }
      conn.onMessage = onExtMessage;
      conn.onClose = () => {
        if (ext === conn) dropExtension('closed');
      };
      for (const w of extWaiters.splice(0)) w();
      return;
    }
    if (u.pathname === '/cdp') {
      if (origin || u.searchParams.get('token') !== token) return void socket.destroy();
      const conn = acceptWs(req, socket, head);
      if (!conn) return;
      const c: Client = { conn, tabs: new Set() };
      clients.add(c);
      conn.onMessage = (text) => void onClientMessage(c, text);
      conn.onClose = () => {
        clients.delete(c);
        for (const tabId of [...c.tabs]) {
          const t = tabs.get(tabId);
          forgetTab(tabId, false);
          if (t) void extCall(t.owned ? 'closeTab' : 'detachTab', { tabId }).catch(() => {});
        }
      };
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULT_BRIDGE_PORT, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  const port = (server.address() as { port: number }).port;

  // a service worker is put to sleep after 30 s without traffic: keep the extension's one awake
  const keepAlive = setInterval(() => {
    if (ext?.open) void extCall('ping', {}, 10_000).catch(() => {});
  }, 20_000);
  keepAlive.unref();

  const stateFile = opts.stateFile === false ? undefined : opts.stateFile ?? bridgeStateFile();
  if (stateFile) {
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ port, token, pid: process.pid }) + '\n', { mode: 0o600 });
      chmodSync(stateFile, 0o600);
    } catch {}
  }

  return {
    url: `ws://127.0.0.1:${port}/cdp?token=${token}`,
    port,
    token,
    status: () => ({
      port,
      extension: !!ext?.open,
      browser: hello.product,
      clients: clients.size,
      tabs: [...tabs].map(([tabId, t]) => ({ tabId, targetId: t.targetId, owned: t.owned })),
      offered: [...offered],
    }),
    async close() {
      clearInterval(keepAlive);
      for (const c of clients) c.conn.close();
      ext?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    },
  };
}

let own: Promise<Hub> | undefined;

/**
 * The DevTools endpoint of the bridge: this process's hub if it could take the port, otherwise the
 * hub another agentweb process on this machine is already running.
 */
export async function bridgeEndpoint(env: Record<string, string | undefined> = process.env): Promise<string> {
  const port = Number(env.AGENTWEB_EXTENSION_PORT) || DEFAULT_BRIDGE_PORT;
  if (own) {
    const h = await own.catch(() => undefined);
    if (h) return h.url;
    own = undefined;
  }
  const mine = startHub({ port, stateFile: bridgeStateFile(env) });
  try {
    const h = await mine;
    own = mine;
    return h.url;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
  }
  try {
    const s = JSON.parse(readFileSync(bridgeStateFile(env), 'utf8'));
    if (s && s.port === port && typeof s.token === 'string') return `ws://127.0.0.1:${port}/cdp?token=${s.token}`;
  } catch {}
  throw new Error(`port ${port} is in use by something that is not an agentweb bridge; set AGENTWEB_EXTENSION_PORT to another port (and the same port in the extension)`);
}

export async function ownHub(): Promise<Hub | undefined> {
  return own ? own.catch(() => undefined) : undefined;
}
