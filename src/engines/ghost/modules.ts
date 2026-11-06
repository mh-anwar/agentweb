// ES modules for the page process: <script type=module> (inline and external, static imports),
// dynamic import() from modules and classic scripts, import maps (imports + scopes), JSON and CSS
// module scripts. Module sources are fetched through the host like every other request and
// compiled with node:vm's SourceTextModule inside the page's context (needs
// --experimental-vm-modules, which the engine passes to the page process).

import vm from 'node:vm';

export interface ModuleHost {
  ctx: object;
  win: any;
  cpuMs: number;
  /** fetch through the parent; resolves with the final URL and the source text */
  fetchText(url: string): Promise<{ url: string; status: number; text: string; type: string }>;
  report(e: unknown, url: string): void;
  /** a module graph could not be loaded or linked: the page probably did not boot */
  failed(why: string): void;
  cpuKilled(): void;
  /** work counter: a non-zero value holds the settle open */
  busy(delta: number): void;
}

interface ImportMap {
  imports: Record<string, string>;
  scopes: Record<string, Record<string, string>>;
}

const MAX_MODULES = 2000;

export class ModuleLoader {
  private host: ModuleHost;
  private map: ImportMap = { imports: {}, scopes: {} };
  private cache = new Map<string, Promise<vm.Module>>();
  /** module → URL it was fetched from (after redirects), for relative resolution */
  private urls = new WeakMap<vm.Module, string>();

  constructor(host: ModuleHost) {
    this.host = host;
  }

  get count(): number {
    return this.cache.size;
  }

  addImportMap(text: string, base: string): void {
    let raw: any;
    try {
      raw = JSON.parse(text);
    } catch {
      this.host.report(new this.host.win.SyntaxError('import map is not valid JSON'), base);
      return;
    }
    const norm = (o: any, b: string): Record<string, string> => {
      const out: Record<string, string> = {};
      if (!o || typeof o !== 'object') return out;
      for (const k of Object.keys(o)) {
        if (typeof o[k] !== 'string') continue;
        try {
          out[k] = new URL(o[k], b).href;
        } catch {}
      }
      return out;
    };
    Object.assign(this.map.imports, norm(raw.imports, base));
    if (raw.scopes && typeof raw.scopes === 'object')
      for (const s of Object.keys(raw.scopes)) {
        try {
          this.map.scopes[new URL(s, base).href] = norm(raw.scopes[s], base);
        } catch {}
      }
  }

  resolve(spec: string, base: string): string {
    const lookup = (table: Record<string, string>, key: string): string | undefined => {
      if (table[key]) return table[key];
      let best = '';
      for (const k of Object.keys(table)) if (k.endsWith('/') && key.startsWith(k) && k.length > best.length) best = k;
      return best ? table[best] + key.slice(best.length) : undefined;
    };
    let asUrl: string | undefined;
    if (/^(\/|\.\/|\.\.\/)/.test(spec)) asUrl = new URL(spec, base).href;
    else {
      try {
        asUrl = new URL(spec).href;
      } catch {}
    }
    const key = asUrl ?? spec;
    const scopes = Object.keys(this.map.scopes).sort((a, b) => b.length - a.length);
    for (const s of scopes) {
      if (!base.startsWith(s)) continue;
      const hit = lookup(this.map.scopes[s], key);
      if (hit) return hit;
    }
    const hit = lookup(this.map.imports, key);
    if (hit) return hit;
    if (asUrl) return asUrl;
    throw new this.host.win.TypeError(`Failed to resolve module specifier "${spec}": bare specifiers need an import map`);
  }

  /** run a <script type=module> element; resolves when its graph has been evaluated */
  async runScript(el: any, inline: string | null, src: string | null, base: string): Promise<void> {
    const host = this.host;
    host.busy(1);
    let root: vm.Module;
    let id = src || base;
    try {
      if (src !== null) root = await this.load(src, undefined);
      else {
        id = base + '#inline-module-' + Math.random().toString(36).slice(2, 8);
        root = this.compile(inline || '', id, base);
      }
      await this.link(root);
    } catch (e: any) {
      host.busy(-1);
      host.failed(`${shortUrl(id)}: ${errText(e)}`);
      host.report(e, id);
      fire(host.win, el, 'error');
      return;
    }
    try {
      await this.evaluate(root);
    } catch (e) {
      host.report(e, id);
    } finally {
      host.busy(-1);
    }
    if (src !== null) fire(host.win, el, 'load');
  }

  /** import() from page code */
  async dynamic(spec: string, referrer: string, attrs: unknown): Promise<vm.Module> {
    const host = this.host;
    host.busy(1);
    try {
      const url = this.resolve(String(spec), referrer);
      const m = await this.load(url, attrs);
      await this.link(m);
      await this.evaluate(m);
      return m;
    } finally {
      host.busy(-1);
    }
  }

  private async evaluate(m: vm.Module): Promise<void> {
    if (m.status === 'evaluated' || m.status === 'evaluating') return;
    if (m.status === 'errored') throw m.error;
    try {
      await m.evaluate({ timeout: this.host.cpuMs });
    } catch (e: any) {
      if (e && e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') this.host.cpuKilled();
      throw e;
    }
  }

  private async link(m: vm.Module): Promise<void> {
    if (m.status !== 'unlinked') return;
    await m.link(async (spec: string, referencing: vm.Module, extra: any) => {
      const base = this.urls.get(referencing) || referencing.identifier;
      const url = this.resolve(spec, base);
      return this.load(url, extra && (extra.attributes || extra.assert));
    });
  }

  private load(url: string, attrs: any): Promise<vm.Module> {
    const type = attrs && typeof attrs === 'object' && typeof attrs.type === 'string' ? attrs.type : 'js';
    const key = type + ' ' + url;
    let p = this.cache.get(key);
    if (!p) {
      if (this.cache.size >= MAX_MODULES) return Promise.reject(new Error('too many modules'));
      p = this.fetchModule(url, type);
      this.cache.set(key, p);
    }
    return p;
  }

  private async fetchModule(url: string, type: string): Promise<vm.Module> {
    const host = this.host;
    if (!/^https?:|^data:/i.test(url)) throw new host.win.TypeError(`cannot load module ${url}`);
    const r = await host.fetchText(url);
    if (r.status < 200 || r.status >= 300) throw new host.win.TypeError(`module ${shortUrl(url)} answered HTTP ${r.status}`);
    if (type === 'json') {
      const win = host.win;
      const text = r.text;
      const m = new vm.SyntheticModule(['default'], function (this: any) {
        this.setExport('default', win.JSON.parse(text));
      }, { context: host.ctx as any, identifier: r.url });
      this.urls.set(m, r.url);
      return m;
    }
    if (type === 'css') {
      const win = host.win;
      const text = r.text;
      const m = new vm.SyntheticModule(['default'], function (this: any) {
        let sheet: any = null;
        try {
          sheet = new win.CSSStyleSheet();
          sheet.replaceSync(text);
        } catch {
          sheet = { cssRules: [], replace: () => Promise.resolve(sheet), replaceSync() {} };
        }
        this.setExport('default', sheet);
      }, { context: host.ctx as any, identifier: r.url });
      this.urls.set(m, r.url);
      return m;
    }
    if (/^text\/html/i.test(r.type) && /^\s*</.test(r.text)) throw new host.win.TypeError(`module ${shortUrl(url)} is an HTML page (wrong path?)`);
    return this.compile(r.text, r.url, r.url);
  }

  private compile(source: string, id: string, base: string): vm.Module {
    const m = new vm.SourceTextModule(source, {
      context: this.host.ctx as any,
      identifier: id,
      initializeImportMeta: (meta: any) => {
        meta.url = base;
        meta.resolve = (s: string) => this.resolve(String(s), base);
      },
      importModuleDynamically: ((spec: string, _ref: unknown, attrs: unknown) => this.dynamic(spec, base, attrs)) as any,
    });
    this.urls.set(m, base);
    return m;
  }
}

function fire(win: any, el: any, type: string): void {
  try {
    el.dispatchEvent(new win.Event(type));
  } catch {}
}

const errText = (e: any): string => String((e && e.message) || e).slice(0, 200);
const shortUrl = (u: string): string => (u.length > 120 ? u.slice(0, 117) + '…' : u);
