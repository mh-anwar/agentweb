// Local origin for the wire-engine tests. One node:http server on port 0; behaviour is chosen
// by path. `hits` counts requests per path so tests can assert how many reached the origin.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

export interface Fixture {
  port: number;
  base: string;
  hits: Map<string, number>;
  /** last request seen per path */
  last: Map<string, { method: string; headers: http.IncomingHttpHeaders; body: string }>;
  hit(path: string): number;
  reset(): void;
  close(): Promise<void>;
}

const enc = (s: string, label: string): Buffer => {
  switch (label) {
    case 'latin1':
    case 'windows-1252':
      return Buffer.from(
        [...s].map((ch) => {
          const cp = ch.codePointAt(0)!;
          if (cp === 0x20ac) return 0x80; // € in windows-1252
          if (cp === 0x201c) return 0x93;
          if (cp === 0x201d) return 0x94;
          return cp;
        }),
      );
    case 'utf-16le':
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
    case 'utf-16be': {
      const le = Buffer.from(s, 'utf16le');
      for (let i = 0; i < le.length; i += 2) { const t = le[i]; le[i] = le[i + 1]; le[i + 1] = t; }
      return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
    }
    default:
      return Buffer.from(s, 'utf8');
  }
};

// "日本語のテキスト" in Shift_JIS and "中文网页" in GBK, precomputed so the fixture needs no encoder
export const SJIS_TEXT = '日本語のテキスト';
const SJIS = Buffer.from('93fa967b8cea82cc8365834c83588367', 'hex');
export const GBK_TEXT = '中文网页';
const GBK = Buffer.from('d6d0cec4cdf8d2b3', 'hex');

export async function startFixture(): Promise<Fixture> {
  const hits = new Map<string, number>();
  const last = new Map<string, { method: string; headers: http.IncomingHttpHeaders; body: string }>();
  const state = new Map<string, number>();
  let etagVersion = 1;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = u.pathname;
    hits.set(p, (hits.get(p) ?? 0) + 1);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString();
    last.set(p, { method: req.method ?? '', headers: req.headers, body });
    const host = (req.headers.host ?? '').split(':')[0];
    const html = (s: string, extra: http.OutgoingHttpHeaders = {}, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extra });
      res.end(s);
    };

    // ── echo ──
    if (p === '/echo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, host, headers: req.headers, body }));
      return;
    }
    if (p === '/hello') return html('<!doctype html><title>Hello</title><h1>Hello world</h1><p>Some text.</p>');

    // ── redirects ──
    if (p.startsWith('/chain/')) {
      const n = Number(p.split('/')[2]);
      if (n > 0) { res.writeHead(302, { location: `/chain/${n - 1}` }); res.end(); return; }
      return html('<title>end of chain</title><p>done</p>');
    }
    if (p === '/loop/a') { res.writeHead(302, { location: '/loop/b' }); res.end(); return; }
    if (p === '/loop/b') { res.writeHead(301, { location: '/loop/a' }); res.end(); return; }
    if (p === '/self-cookie') {
      // classic cookie check: redirect to self once the cookie is set; not a loop
      if ((req.headers.cookie ?? '').includes('chk=1')) return html('<title>ok</title><p>cookie ok</p>');
      res.writeHead(302, { location: '/self-cookie', 'set-cookie': 'chk=1; Path=/' });
      res.end();
      return;
    }
    if (p === '/self-loop') { res.writeHead(302, { location: '/self-loop' }); res.end(); return; }
    if (p === '/goto') {
      res.writeHead(Number(u.searchParams.get('s') ?? 302), { location: u.searchParams.get('to') ?? '/' });
      res.end();
      return;
    }
    if (p === '/post-303') { res.writeHead(303, { location: '/echo' }); res.end(); return; }
    if (p === '/post-302') { res.writeHead(302, { location: '/echo' }); res.end(); return; }
    if (p === '/post-307') { res.writeHead(307, { location: '/echo' }); res.end(); return; }
    if (p === '/post-308') { res.writeHead(308, { location: '/echo' }); res.end(); return; }
    if (p === '/frag') { res.writeHead(302, { location: '/hello' }); res.end(); return; }

    // ── cookies ──
    if (p === '/login') {
      // sets a host-only cookie and a domain cookie for the parent, then bounces to the other subdomain
      res.writeHead(302, {
        'set-cookie': ['host=only; Path=/', `wide=yes; Domain=example.test; Path=/`, 'sec=1; Secure; HttpOnly; Path=/', 'gone=1; Max-Age=0'],
        location: `http://b.example.test:${(server.address() as AddressInfo).port}/echo`,
      });
      res.end();
      return;
    }
    if (p === '/suffix-cookie') {
      res.writeHead(200, { 'set-cookie': ['bad=1; Domain=test', 'ok=1'], 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    // ── charsets ──
    if (p.startsWith('/cs/')) {
      const kind = p.slice(4);
      const text = 'Café “quoted” €5 naïve';
      switch (kind) {
        case 'header-latin1':
          res.writeHead(200, { 'content-type': 'text/html; charset=ISO-8859-1' });
          return void res.end(enc(`<title>${text}</title><p>${text}</p>`, 'latin1'));
        case 'meta-1252':
          res.writeHead(200, { 'content-type': 'text/html' });
          return void res.end(enc(`<html><head><meta charset="windows-1252"><title>${text}</title></head><p>${text}</p>`, 'windows-1252'));
        case 'http-equiv':
          res.writeHead(200, { 'content-type': 'text/html' });
          return void res.end(enc(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>${text}</title></head><p>${text}</p>`, 'latin1'));
        case 'sjis':
          res.writeHead(200, { 'content-type': 'text/html; charset=Shift_JIS' });
          return void res.end(Buffer.concat([Buffer.from('<title>'), SJIS, Buffer.from('</title><p>'), SJIS, Buffer.from('</p>')]));
        case 'sjis-meta':
          res.writeHead(200, { 'content-type': 'text/html' });
          return void res.end(Buffer.concat([Buffer.from('<meta charset=shift_jis><title>'), SJIS, Buffer.from('</title>')]));
        case 'gbk':
          res.writeHead(200, { 'content-type': 'text/html; charset="gbk"' });
          return void res.end(Buffer.concat([Buffer.from('<title>'), GBK, Buffer.from('</title><p>'), GBK, Buffer.from('</p>')]));
        case 'utf16le':
          res.writeHead(200, { 'content-type': 'text/html' });
          return void res.end(enc(`<title>${text}</title><p>${text}</p>`, 'utf-16le'));
        case 'utf16be-wrong-header':
          // the BOM is authoritative even when the header says otherwise
          res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
          return void res.end(enc(`<title>${text}</title><p>${text}</p>`, 'utf-16be'));
        case 'undeclared-1252':
          res.writeHead(200, { 'content-type': 'text/html' });
          return void res.end(enc(`<title>${text}</title><p>${text}</p>`, 'windows-1252'));
        case 'utf8':
          res.writeHead(200, { 'content-type': 'text/html' });
          return void res.end(enc(`<title>${text}</title><p>${text}</p>`, 'utf8'));
        case 'json-latin1':
          res.writeHead(200, { 'content-type': 'application/json; charset=latin1' });
          return void res.end(enc(JSON.stringify({ t: text }), 'latin1'));
      }
    }

    // ── encodings ──
    if (p.startsWith('/z/')) {
      const kind = p.slice(3);
      const doc = Buffer.from(`<!doctype html><title>compressed ${kind}</title><p>${'lorem ipsum '.repeat(200)}</p>`);
      const map: Record<string, () => Buffer> = {
        gzip: () => zlib.gzipSync(doc),
        br: () => zlib.brotliCompressSync(doc),
        deflate: () => zlib.deflateSync(doc),
        'deflate-raw': () => zlib.deflateRawSync(doc),
        zstd: () => zlib.zstdCompressSync(doc),
        'gzip-br': () => zlib.brotliCompressSync(zlib.gzipSync(doc)),
        'gzip-truncated': () => { const z = zlib.gzipSync(doc); return z.subarray(0, z.length - 30); },
        'gzip-corrupt': () => Buffer.from('this is not gzip at all, sorry'),
      };
      const name = kind === 'deflate-raw' ? 'deflate' : kind === 'gzip-br' ? 'gzip, br' : kind.startsWith('gzip-') ? 'gzip' : kind;
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': name });
      return void res.end(map[kind]());
    }
    if (p === '/bomb') {
      // 1 KB of gzip that inflates to 64 MB
      res.writeHead(200, { 'content-type': u.searchParams.get('type') ?? 'text/html', 'content-encoding': 'gzip' });
      return void res.end(zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024, 0x61)));
    }

    // ── sizes ──
    if (p === '/big') {
      const n = Number(u.searchParams.get('n') ?? 1e6);
      const type = u.searchParams.get('type') ?? 'text/html';
      const chunked = u.searchParams.has('chunked');
      res.writeHead(200, chunked ? { 'content-type': type } : { 'content-type': type, 'content-length': n });
      const block = Buffer.alloc(64 * 1024, type.includes('html') ? '<p>xxxxxxxxx</p>\n' : 'x');
      let sent = 0;
      const pump = () => {
        while (sent < n) {
          const c = block.subarray(0, Math.min(block.length, n - sent));
          sent += c.length;
          if (!res.write(c)) return void res.once('drain', pump);
        }
        res.end();
      };
      res.on('error', () => {});
      return pump();
    }

    // ── timing ──
    if (p === '/slow') {
      const ms = Number(u.searchParams.get('ms') ?? 1000);
      const t = setTimeout(() => html('<title>slow</title>'), ms);
      res.on('close', () => clearTimeout(t));
      return;
    }
    if (p === '/stall') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<title>stall</title><p>first part');
      return; // never ends
    }
    if (p === '/reset') {
      req.socket.destroy();
      return;
    }
    if (p === '/cut') {
      res.writeHead(200, { 'content-type': u.searchParams.get('type') ?? 'text/html', 'content-length': 100000 });
      res.write('<title>cut</title><p>' + 'x'.repeat(5000));
      setTimeout(() => req.socket.destroy(), 20);
      return;
    }

    // ── negotiation ──
    if (p === '/doc') {
      const accept = req.headers.accept ?? '';
      if (/text\/markdown/.test(accept)) {
        res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', vary: 'Accept', 'cache-control': 'public, max-age=60' });
        return void res.end('# Doc\n\nMarkdown body.\n');
      }
      return html('<title>Doc</title><h1>Doc</h1>', { vary: 'Accept', 'cache-control': 'public, max-age=60' });
    }

    // ── sniffing ──
    if (p.startsWith('/sniff/')) {
      const kind = p.slice(7);
      const send = (ct: string | undefined, b: string | Buffer) => {
        res.writeHead(200, ct ? { 'content-type': ct } : {});
        res.end(b);
      };
      switch (kind) {
        case 'html-noct': return send(undefined, '  <!DOCTYPE html><title>sniffed</title><p>hi</p>');
        case 'html-octet': return send('application/octet-stream', '<html><head><title>octet</title></head></html>');
        case 'json-noct': return send(undefined, '{"a":1,"b":[1,2]}');
        case 'pdf-octet': return send('application/octet-stream', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100, 1)]));
        case 'pdf-plain': return send('text/plain', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(50, 2)]));
        case 'xhtml-xml': return send('text/xml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>xhtml</title></head><body/></html>');
        case 'rss': return send(undefined, '<?xml version="1.0"?><rss version="2.0"><channel><title>feed</title></channel></rss>');
        case 'csv': return send('text/csv; charset=utf-8', 'a,b\n1,2\n');
        case 'md.md': return send('text/plain', '# Title\n');
        case 'xhtml': return send('application/xhtml+xml', '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>real xhtml</title></head><body><p>x</p></body></html>');
        case 'png': return send(undefined, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
        case 'weird-ct': return send('TEXT/HTML ; Charset = "UTF-8"', '<title>weird ct</title>');
      }
    }

    // ── cache ──
    if (p.startsWith('/c/')) {
      const kind = p.slice(3);
      const n = hits.get(p)!;
      const delay = Number(u.searchParams.get('delay') ?? 0);
      const send = (headers: http.OutgoingHttpHeaders, b = `<title>${kind} v${n}</title><p>${kind}</p>`, status = 200) => {
        const go = () => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(status === 304 ? undefined : b); };
        if (delay) setTimeout(go, delay); else go();
      };
      switch (kind) {
        case 'fresh': return send({ 'cache-control': 'public, max-age=60' });
        case 'smaxage': return send({ 'cache-control': 'max-age=0, s-maxage=60' });
        case 'expires': return send({ expires: new Date(Date.now() + 60_000).toUTCString(), date: new Date().toUTCString() });
        case 'heuristic': return send({});
        case 'private': return send({ 'cache-control': 'private, max-age=60' });
        case 'nostore': return send({ 'cache-control': 'no-store' });
        case 'setcookie': return send({ 'cache-control': 'max-age=60', 'set-cookie': 'track=1' });
        case 'vary-cookie': return send({ 'cache-control': 'max-age=60', vary: 'Cookie' });
        case 'etag': {
          const tag = `"v${etagVersion}"`;
          if (req.headers['if-none-match'] === tag) return send({ etag: tag, 'cache-control': 'max-age=0' }, '', 304);
          return send({ etag: tag, 'cache-control': 'max-age=0' }, `<title>etag ${tag}</title>`);
        }
        case 'lastmod': {
          const lm = 'Wed, 21 Oct 2015 07:28:00 GMT';
          if (req.headers['if-modified-since'] === lm) return send({ 'last-modified': lm, 'cache-control': 'no-cache' }, '', 304);
          return send({ 'last-modified': lm, 'cache-control': 'no-cache' });
        }
        case 'redirect': { res.writeHead(301, { location: '/c/fresh', 'cache-control': 'max-age=60' }); res.end(); return; }
        case 'slow': return send({ 'cache-control': 'max-age=60' });
        case 'slow-private': return send({ 'cache-control': 'private' });
      }
    }

    // ── bot walls ──
    if (p.startsWith('/wall/')) {
      const kind = p.slice(6);
      const w = (status: number, headers: http.OutgoingHttpHeaders, b: string) => { res.writeHead(status, { 'content-type': 'text/html', ...headers }); res.end(b); };
      switch (kind) {
        case 'cloudflare': return w(403, { server: 'cloudflare', 'cf-mitigated': 'challenge' }, '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>');
        case 'cloudflare-body': return w(503, { server: 'cloudflare' }, '<html><head><title>Just a moment...</title></head><body><div id="challenge-body"></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>');
        case 'datadome': return w(403, { 'x-datadome': 'protected', server: 'nginx' }, '<html><head><title>example.com</title></head><body><script>var dd={\'rt\':\'c\',\'cid\':\'x\'}</script><script src="https://ct.captcha-delivery.com/c.js"></script></body></html>');
        case 'perimeterx': return w(403, {}, '<html><head><title>Access to this page has been denied</title></head><body><div id="px-captcha"></div><script>window._pxAppId="PXabc";</script></body></html>');
        case 'akamai': return w(403, { server: 'AkamaiGHost' }, '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>You don\'t have permission to access "http://www.example.com/" on this server.<P>Reference #18.abc.123</BODY></HTML>');
        case 'imperva': return w(200, {}, '<html><head><META NAME="robots" CONTENT="noindex,nofollow"><script src="/_Incapsula_Resource?SWJIYLWA=5074a744e2e3d891814e9a2dace20bd4,719d34d31c8e3a6e6fffd425f7e032f3"></script></head><body>Request unsuccessful. Incapsula incident ID: 123-456</body></html>');
        case 'captcha': return w(200, {}, '<html><head><title>Security check</title></head><body><h1>Please verify you are a human</h1><div class="g-recaptcha" data-sitekey="x"></div></body></html>');
        case 'google-sorry': return w(429, {}, '<html><body>Our systems have detected unusual traffic from your computer network.</body></html>');
        case 'js-403': return w(403, {}, '<html><body><noscript>Please enable JavaScript to continue</noscript><script>location.reload()</script></body></html>');
        case 'contact-form': return w(200, {}, `<html><head><title>Contact us</title></head><body><h1>Contact</h1>${'<p>We are a company that makes many products and we would love to hear from you about anything at all.</p>'.repeat(30)}<form><textarea></textarea><div class="g-recaptcha" data-sitekey="x"></div></form></body></html>`);
        case 'plain-403': return w(403, { server: 'nginx' }, '<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center><hr><center>nginx</center></body></html>');
      }
    }

    // ── retry-after ──
    if (p === '/busy') {
      const key = u.searchParams.get('k') ?? '';
      const n = (state.get(key) ?? 0) + 1;
      state.set(key, n);
      if (n === 1) { res.writeHead(Number(u.searchParams.get('s') ?? 429), { 'retry-after': u.searchParams.get('ra') ?? '1', 'content-type': 'text/plain' }); res.end('busy'); return; }
      return html('<title>finally</title>');
    }

    if (p === '/bench') return html(`<!doctype html><title>bench ${u.searchParams.get('i') ?? ''}</title><h1>Bench</h1>${'<p>The quick brown fox jumps over the lazy dog.</p>'.repeat(Number(u.searchParams.get('rep') ?? 40))}`, u.searchParams.has('cache') ? { 'cache-control': 'public, max-age=600' } : {});

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  server.keepAliveTimeout = 5000;
  server.on('clientError', (_e, s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    hits,
    last,
    hit: (p) => hits.get(p) ?? 0,
    reset() { hits.clear(); last.clear(); state.clear(); etagVersion++; },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
