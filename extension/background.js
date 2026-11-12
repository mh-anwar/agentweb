// agentweb browser extension: relays DevTools commands from the local agentweb bridge to tabs.
//
// It connects OUT to ws://127.0.0.1:<port>/extension (nothing listens in the browser). The bridge
// may open tabs (kept in an "agentweb" tab group), drive them through chrome.debugger, and close
// them. It can touch one of your own tabs only after you press "Share this tab" in the popup.

const DEFAULT_PORT = 4466;
const VERSION = chrome.runtime.getManifest().version;

let ws;
let retry;
/** tabId -> { owned } : tabs the agent is driving */
const tabs = new Map();
/** tabIds the user offered from the popup, not yet taken */
const offered = new Set();
let groupId;

const settings = () => chrome.storage.local.get({ port: DEFAULT_PORT, enabled: true });

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function badge() {
  const on = !!ws && ws.readyState === 1;
  const n = tabs.size;
  chrome.action.setBadgeText({ text: on ? (n ? String(n) : '') : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });
  chrome.action.setTitle({ title: on ? (n ? `agentweb: an agent is using ${n} tab${n > 1 ? 's' : ''}` : 'agentweb: connected') : 'agentweb: not connected' });
}

async function connect() {
  if (ws && ws.readyState <= 1) return;
  const { port, enabled } = await settings();
  if (!enabled) return;
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  } catch {
    return;
  }
  ws = sock;
  sock.onopen = () => {
    const m = /Chrom(?:e|ium)\/([\d.]+)/.exec(navigator.userAgent);
    send({ event: 'hello', version: VERSION, userAgent: navigator.userAgent, product: 'Chrome/' + (m ? m[1] : '0.0.0.0') });
    sendOffered();
    badge();
  };
  sock.onmessage = (e) => void onMessage(e.data);
  sock.onclose = () => {
    if (ws === sock) ws = undefined;
    void releaseAll();
    badge();
    clearTimeout(retry);
    retry = setTimeout(connect, 2000);
  };
  sock.onerror = () => {};
}

async function releaseAll() {
  for (const [tabId, t] of [...tabs]) {
    tabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    if (t.owned) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function sendOffered() {
  const list = [];
  for (const tabId of [...offered]) {
    const t = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!t) offered.delete(tabId);
    else list.push({ tabId, url: t.url || '', title: t.title || '' });
  }
  send({ event: 'offered', tabs: list });
}

async function intoGroup(tabId) {
  try {
    if (groupId !== undefined) {
      const g = await chrome.tabGroups.get(groupId).catch(() => undefined);
      if (!g) groupId = undefined;
    }
    groupId = await chrome.tabs.group(groupId === undefined ? { tabIds: [tabId] } : { tabIds: [tabId], groupId });
    await chrome.tabGroups.update(groupId, { title: 'agentweb', color: 'blue' });
  } catch {}
}

async function targetOf(tabId) {
  const r = await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo');
  return r.targetInfo.targetId;
}

const handlers = {
  ping: async () => ({}),
  async createTab({ url, background }) {
    const tab = await chrome.tabs.create({ url: url || 'about:blank', active: background === false });
    try {
      await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    } catch (e) {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw e;
    }
    tabs.set(tab.id, { owned: true });
    void intoGroup(tab.id);
    badge();
    return { tabId: tab.id, targetId: await targetOf(tab.id) };
  },
  async attachTab({ tabId }) {
    if (!offered.has(tabId)) throw new Error('that tab was not shared with agentweb');
    await chrome.debugger.attach({ tabId }, '1.3');
    offered.delete(tabId);
    tabs.set(tabId, { owned: false });
    badge();
    return { targetId: await targetOf(tabId) };
  },
  async closeTab({ tabId }) {
    tabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.tabs.remove(tabId).catch(() => {});
    badge();
    return {};
  },
  async detachTab({ tabId }) {
    tabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    badge();
    return {};
  },
  async listTabs() {
    const list = [];
    for (const tabId of offered) {
      const t = await chrome.tabs.get(tabId).catch(() => undefined);
      if (t) list.push({ tabId, url: t.url || '', title: t.title || '' });
    }
    return { tabs: list };
  },
  async cdp({ tabId, sessionId, method, params }) {
    if (!tabs.has(tabId)) throw new Error('Session with given id not found');
    return (await chrome.debugger.sendCommand(sessionId ? { tabId, sessionId } : { tabId }, method, params || {})) || {};
  },
};

async function onMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  const h = handlers[msg.method];
  if (!h) return send({ id: msg.id, error: { message: `unknown method ${msg.method}` } });
  try {
    send({ id: msg.id, result: await h(msg.params || {}) });
  } catch (e) {
    let m = e && e.message ? e.message : String(e);
    // chrome.debugger wraps protocol errors as a JSON string
    try {
      const j = JSON.parse(m);
      if (j && j.message) m = j.message;
    } catch {}
    send({ id: msg.id, error: { message: m } });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId === undefined || !tabs.has(source.tabId)) return;
  send({ event: 'cdp', tabId: source.tabId, sessionId: source.sessionId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined || !tabs.delete(source.tabId)) return;
  send({ event: 'detached', tabId: source.tabId, reason });
  badge();
});

// a window an agent tab opened belongs to the agent too: the bridge decides what happens to it
chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.openerTabId === undefined || !tabs.has(tab.openerTabId) || tab.id === undefined) return;
  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    tabs.set(tab.id, { owned: true });
    send({ event: 'popup', tabId: tab.id, openerTabId: tab.openerTabId, targetId: await targetOf(tab.id), url: tab.pendingUrl || tab.url || '' });
  } catch {}
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (offered.delete(tabId)) void sendOffered();
});

// the popup talks to the worker
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  (async () => {
    if (msg.type === 'status') {
      const s = await settings();
      const agentTabs = [];
      for (const [tabId, t] of tabs) {
        const tab = await chrome.tabs.get(tabId).catch(() => undefined);
        agentTabs.push({ tabId, owned: t.owned, title: tab ? tab.title || tab.url || '' : '' });
      }
      return { connected: !!ws && ws.readyState === 1, port: s.port, enabled: s.enabled, tabs: agentTabs, offered: [...offered] };
    }
    if (msg.type === 'share') {
      if (msg.on) offered.add(msg.tabId);
      else offered.delete(msg.tabId);
      await sendOffered();
      return {};
    }
    if (msg.type === 'stop') {
      // the user's override: take every tab away from the agent and stay disconnected until switched on again
      await chrome.storage.local.set({ enabled: false });
      offered.clear();
      await releaseAll();
      if (ws) ws.close();
      badge();
      return {};
    }
    if (msg.type === 'settings') {
      await chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT, enabled: !!msg.enabled });
      if (ws) ws.close();
      else void connect();
      return {};
    }
    return {};
  })().then(respond, () => respond({}));
  return true;
});

chrome.alarms.create('agentweb-connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());
void connect();
badge();
