// Shared fixtures for the chrome engine tests: a local site, a minimal cookie jar and guard, and a
// session context factory. Nothing here imports another module's implementation.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { CookieData, CookieJar, Guard, SessionCtx, Verdict } from '../src/types.ts';
import type { LNode } from '../src/tree.ts';

// ───────────────────────────── cookie jar ─────────────────────────────

export class TestJar implements CookieJar {
  list: CookieData[] = [];
  private key = (c: CookieData) => `${c.name}\n${c.domain.replace(/^\./, '').toLowerCase()}\n${c.path || '/'}`;
  private live = (c: CookieData) => c.expires === undefined || c.expires > Date.now() / 1000;
  private matches(c: CookieData, url: string): boolean {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const d = c.domain.replace(/^\./, '').toLowerCase();
    const domOk = c.hostOnly ? host === d : host === d || host.endsWith('.' + d);
    const path = c.path || '/';
    const pathOk = u.pathname === path || u.pathname.startsWith(path.endsWith('/') ? path : path + '/');
    return domOk && pathOk && (!c.secure || u.protocol === 'https:') && this.live(c);
  }
  header(url: string): string {
    return this.list.filter((c) => this.matches(c, url)).map((c) => `${c.name}=${c.value}`).join('; ');
  }
  setFromHeaders(url: string, setCookie: string[]): void {
    const host = new URL(url).hostname;
    for (const line of setCookie) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const c: CookieData = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, path: '/', hostOnly: true };
      for (const a of attrs) {
        const [k, v = ''] = a.split('=').map((s) => s.trim());
        const kl = k.toLowerCase();
        if (kl === 'domain') {
          c.domain = v.replace(/^\./, '');
          c.hostOnly = false;
        } else if (kl === 'path') c.path = v;
        else if (kl === 'max-age') c.expires = Math.round(Date.now() / 1000 + Number(v));
        else if (kl === 'httponly') c.httpOnly = true;
        else if (kl === 'secure') c.secure = true;
      }
      this.set(c);
    }
  }
  all(): CookieData[] {
    return this.list.filter((c) => this.live(c));
  }
  set(c: CookieData): void {
    const k = this.key(c);
    this.list = this.list.filter((x) => this.key(x) !== k);
    if (this.live(c)) this.list.push({ ...c });
  }
  merge(cookies: CookieData[]): void {
    for (const c of cookies) this.set(c);
  }
  has(url: string): boolean {
    return this.list.some((c) => this.matches(c, url));
  }
  clear(): void {
    this.list = [];
  }
  get(name: string): CookieData | undefined {
    return this.all().find((c) => c.name === name);
  }
}

// ───────────────────────────── guard ─────────────────────────────

export class TestGuard implements Guard {
  /** return a reason to refuse */
  deny: (url: string, why: string) => string | undefined = () => undefined;
  seen: { url: string; why: string }[] = [];
  async checkUrl(url: string, why: 'open' | 'redirect' | 'sub' | 'submit'): Promise<Verdict> {
    this.seen.push({ url, why });
    const r = this.deny(url, why);
    return r ? { ok: false, reason: r } : { ok: true };
  }
  async checkStep(): Promise<Verdict> {
    return { ok: true };
  }
  reveal(text: string): string {
    return text;
  }
  redact(text: string): string {
    return text;
  }
  observe(): void {}
  checkOutflow(): Verdict {
    return { ok: true };
  }
  state(): unknown {
    return {};
  }
}

export function makeCtx(id: string, over: Partial<SessionCtx> = {}): SessionCtx & { jar: TestJar; guard: TestGuard } {
  return { id, jar: new TestJar(), storage: {}, userAgent: '', guard: new TestGuard(), timeoutMs: 15_000, ...over } as any;
}

// ───────────────────────────── tree helpers ─────────────────────────────

export function* nodes(n: LNode): Generator<LNode> {
  yield n;
  if (n.c) for (const c of n.c) yield* nodes(c);
}

/** visible text of a tree (hidden subtrees skipped, sr-only kept) */
export function textOf(n: LNode): string {
  if (n.t === '#text') return n.x ?? '';
  if (n.h) return '';
  let s = '';
  for (const c of n.c ?? []) s += textOf(c);
  return s.replace(/\s+/g, ' ');
}

/** first node with a live id whose own text (or label attributes) contains `label` */
export function byText(root: LNode, label: string, pred: (n: LNode) => boolean = () => true): LNode | undefined {
  for (const n of nodes(root)) {
    if (n.n === undefined || !pred(n)) continue;
    const t = textOf(n) + ' ' + (n.a?.['aria-label'] ?? '') + ' ' + (n.a?.id ?? '') + ' ' + (n.a?.name ?? '');
    if (t.includes(label)) return n;
  }
  return undefined;
}

export function byId(root: LNode, id: string): LNode | undefined {
  for (const n of nodes(root)) if (n.a?.id === id) return n;
  return undefined;
}

// ───────────────────────────── site ─────────────────────────────

export interface Site {
  base: string;
  server: Server;
  hits: string[];
  close(): Promise<void>;
}

const page = (title: string, body: string, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => resolve(s));
  });
}

const ROUTES: Record<string, (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>> = {
  '/': (_q, res) => html(res, page('Home', '<h1>Hello</h1><p>A trivial page.</p><a href="/next">Next page</a>')),
  '/next': (_q, res) => html(res, page('Next', '<h1>Second page</h1><a href="/">Home</a>')),
  '/spa': (_q, res) =>
    html(
      res,
      page(
        'SPA',
        '<div id="app">Loading…</div><script>setTimeout(async()=>{const r=await fetch("/api/items");const items=await r.json();' +
          'document.getElementById("app").innerHTML="<h1>Products</h1><ul>"+items.map(i=>"<li>"+i+"</li>").join("")+"</ul><button id=more>More</button>";' +
          'document.getElementById("more").addEventListener("click",()=>{const li=document.createElement("li");li.textContent="Extra item";document.querySelector("ul").appendChild(li)});},150)</script>',
      ),
    ),
  '/api/items': async (_q, res) => {
    await new Promise((r) => setTimeout(r, 120));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(['Red shoe', 'Blue hat', 'Green scarf']));
  },
  '/actions': (_q, res) =>
    html(
      res,
      page(
        'Actions',
        `<style>#cover{position:fixed;left:0;top:0;width:100vw;height:60px;background:#fff;z-index:9} #covered{position:fixed;left:10px;top:10px} .tall{height:3000px}</style>
<p id="out">none</p>
<button id="inc" onclick="this.dataset.n=(+(this.dataset.n||0)+1);out.textContent='clicked '+this.dataset.n+' trusted='+event.isTrusted">Increment</button>
<label>Name <input id="name" name="name"></label><p id="mirror"></p>
<textarea id="ta"></textarea>
<select id="color"><option value="r">Red</option><option value="g">Green</option><option value="b">Blue</option></select><p id="chosen"></p>
<label><input type="checkbox" id="agree"> I agree</label><p id="agreed">no</p>
<span id="hov" role="button" style="display:inline-block;width:100px;height:30px">Hover me</span><p id="hovered"></p>
<input id="keys"><p id="pressed"></p>
<input type="file" id="file" multiple><p id="files"></p>
<div id="cover">overlay</div><button id="covered" onclick="out.textContent='covered clicked'">Under</button>
<p id="later"></p>
<div class="tall"></div><p id="bottom">bottom of page</p>
<script>
const name=document.getElementById('name');
// a framework-style listener: only the input event updates the model
name.addEventListener('input',e=>{document.getElementById('mirror').textContent='model:'+e.target.value});
document.getElementById('color').addEventListener('change',e=>{document.getElementById('chosen').textContent='chose '+e.target.value});
document.getElementById('agree').addEventListener('change',e=>{document.getElementById('agreed').textContent=e.target.checked?'yes':'no'});
document.getElementById('hov').addEventListener('mouseenter',()=>{document.getElementById('hovered').textContent='hovering'});
document.getElementById('keys').addEventListener('keydown',e=>{if(e.key==='Shift'||e.key==='Control')return;document.getElementById('pressed').textContent+=(e.ctrlKey?'C-':'')+(e.shiftKey?'S-':'')+e.key+' '});
document.getElementById('file').addEventListener('change',e=>{document.getElementById('files').textContent=[...e.target.files].map(f=>f.name+':'+f.size).join(',')});
window.addEventListener('scroll',()=>{if(window.scrollY>1000&&!document.getElementById('lazy')){const p=document.createElement('p');p.id='lazy';p.textContent='lazy loaded';document.body.appendChild(p);const d=document.createElement('div');d.style.height='2000px';document.body.appendChild(d);}});
</script>`,
      ),
    ),
  '/later': (_q, res) => html(res, page('Later', '<p id="x">waiting</p><script>setTimeout(()=>{x.textContent="It is ready now"},700)</script>')),
  '/nav1': (_q, res) =>
    html(
      res,
      page(
        'Nav one',
        '<a id="go" href="/nav2">Go to two</a> <a id="blank" href="/nav2?tab=1" target="_blank">New tab</a> <button id="pop" onclick="window.open(\'/nav2?pop=1\')">Popup</button>',
      ),
    ),
  '/nav2': (_q, res, u) => html(res, page('Nav two', `<h1>Page two${u.search}</h1>`)),
  '/dialogs': (_q, res) =>
    html(
      res,
      page(
        'Dialogs',
        `<p id="r">-</p><button id="a" onclick="alert('Hi there')">Alert</button>
<button id="c" onclick="r.textContent='confirm='+confirm('Delete it?')">Confirm</button>
<button id="p" onclick="r.textContent='prompt='+JSON.stringify(prompt('Your name?'))">Prompt</button>
<button id="e" onclick="setTimeout(()=>{throw new Error('kaboom')})">Error</button>`,
      ),
    ),
  '/shadow': (_q, res) =>
    html(
      res,
      page(
        'Shadow',
        `<div id="host"></div><iframe id="fr" src="/frame" style="width:400px;height:200px"></iframe>
<script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<p>Shadow text</p><button id="sb">Shadow button</button><span id="so"></span>';
r.getElementById('sb').addEventListener('click',()=>{r.getElementById('so').textContent='shadow clicked'})</script>`,
      ),
    ),
  '/frame': (_q, res) => html(res, page('Frame', '<p>Inside the frame</p><button id="fb" onclick="fo.textContent=\'frame clicked\'">Frame button</button><span id="fo"></span>')),
  '/hidden': (_q, res) =>
    html(
      res,
      page(
        'Hidden',
        `<p>Visible text</p><p class="gone">Secret instructions</p><div id="card" class="card">Open card</div><p id="cardout"></p>
<span class="sr">Screen reader note</span>`,
        `<link rel="stylesheet" href="/hidden.css"><script>addEventListener('DOMContentLoaded',()=>document.getElementById('card').addEventListener('click',()=>cardout.textContent='card opened'))</script>`,
      ),
    ),
  '/hidden.css': (_q, res) => {
    res.writeHead(200, { 'content-type': 'text/css' });
    res.end('.gone{display:none}.card{cursor:pointer;padding:4px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}');
  },
  '/login': async (req, res, u) => {
    const user = u.searchParams.get('u') || 'anon';
    res.writeHead(302, { location: '/me', 'set-cookie': [`sid=${user}-token; Path=/; HttpOnly; Max-Age=3600`] });
    res.end();
  },
  '/me': (req, res) => {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '');
    html(
      res,
      page(
        'Me',
        `<p id="who">${m ? 'Signed in as ' + m[1] : 'Signed out'}</p><p id="ls"></p><button id="setls" onclick="localStorage.setItem('theme','dark');ls.textContent='theme='+localStorage.getItem('theme')">Dark</button><button id="jscookie" onclick="document.cookie='js=1; path=/'">JS cookie</button>
<script>document.getElementById('ls').textContent='theme='+localStorage.getItem('theme')</script>`,
      ),
    );
  },
  '/logout': (_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': ['sid=; Path=/; Max-Age=0'] });
    res.end(page('Bye', '<p>Signed out</p>'));
  },
  '/slow': async (_q, res) => {
    await new Promise((r) => setTimeout(r, 1500));
    html(res, page('Slow', '<p>Finally here</p>'));
  },
  '/redirect': (_q, res, u) => {
    res.writeHead(302, { location: u.searchParams.get('to') || '/' });
    res.end();
  },
  '/form': (_q, res) => html(res, page('Form', '<form method="post" action="/echo"><input name="q" id="q"><button id="send">Send</button></form>')),
  '/echo': async (req, res) => {
    const body = await readBody(req);
    html(res, page('Echo', `<p id="m">${req.method} ${body}</p>`));
  },
  '/json': (_q, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true,"n":3}');
  },
  '/download': (_q, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="data.bin"' });
    res.end('xxxx');
  },
  '/ticker': (_q, res) => html(res, page('Ticker', '<p id="t">0</p><script>let i=0;setInterval(()=>{t.textContent=String(++i)},50)</script>')),
  '/remove': (_q, res) => html(res, page('Remove', '<button id="gone" onclick="this.remove()">Vanish</button><button id="stay">Stay</button>')),
};

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

export async function startSite(): Promise<Site> {
  const hits: string[] = [];
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.push(u.pathname + u.search);
    const r = ROUTES[u.pathname];
    if (!r) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end(page('Not found', '<h1>404</h1>'));
      return;
    }
    try {
      await r(req, res, u);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// ───────────────────────────── processes ─────────────────────────────

/** a process and all its descendants (Linux /proc) */
export function treePids(root: number): number[] {
  const parents = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'latin1');
      parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch {}
  }
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const [pid, ppid] of parents) if (ppid === out[i]) out.push(pid);
  return out.filter(alive);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // a zombie still answers signal 0; it is gone for every purpose that matters here
    return !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'latin1'));
  } catch {
    return false;
  }
}

/** pids of Chromium processes owned by this user that this test run could have started */
export function chromePids(): number[] {
  try {
    const out = execFileSync('pgrep', ['-u', String(process.getuid!()), '-f', 'agentweb-chrome-'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean).map(Number).filter((p) => p !== process.pid);
  } catch {
    return [];
  }
}
