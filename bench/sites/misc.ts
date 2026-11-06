// /misc/ — protocol behaviour: redirects, status codes, slow and huge responses, legacy encodings,
// compression, JSON/RSS/CSV/PDF/markdown content types, conditional requests, a script-set-cookie
// challenge, and a page whose content lives only in __NEXT_DATA__.
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import type { Ctx } from './core.ts';
import { sleep } from './core.ts';
import { esc, shell, infoPage } from './html.ts';
import type { Chrome } from './html.ts';
import { hashHex, money } from './rng.ts';

const chrome: Chrome = {
  base: '/misc', brand: 'Wire Lab', tagline: 'Protocol behaviour',
  nav: [['Redirects', '/misc/redirect/3'], ['Status codes', '/misc/status/404'], ['Data', '/misc/api/items?limit=20'], ['Feeds', '/misc/feed.xml']],
};

// ---------------------------------------------------------------------------------------------
// Encoders

let sjisMap: Map<string, number[]> | undefined;
/** Shift_JIS encoder built from the platform decoder (Node ships no encoder for it). */
export function encodeShiftJis(s: string): Buffer {
  if (!sjisMap) {
    sjisMap = new Map();
    const dec = new TextDecoder('shift_jis');
    for (let lead = 0x81; lead <= 0xef; lead++) {
      if (lead > 0x9f && lead < 0xe0) continue;
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail === 0x7f) continue;
        const ch = dec.decode(new Uint8Array([lead, trail]));
        if (ch.length === 1 && ch !== '\ufffd' && !sjisMap.has(ch)) sjisMap.set(ch, [lead, trail]);
      }
    }
  }
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) out.push(code);
    else {
      const b = sjisMap.get(ch);
      if (!b) throw new Error(`cannot encode ${ch} as Shift_JIS`);
      out.push(...b);
    }
  }
  return Buffer.from(out);
}

function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** A one-page PDF 1.4 with real text objects and a correct xref table. */
export function makePdf(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 72 740 Td 16 TL ${lines.map((l) => `(${pdfEscape(l)}) '`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ---------------------------------------------------------------------------------------------

let bigPage: string | undefined;
function bigHtml(c: Ctx): string {
  if (bigPage) return bigPage;
  const n = c.truth.misc.bigPageNeedle;
  const rows: string[] = [];
  const TARGET = 5 * 1024 * 1024;
  let size = 0;
  for (let i = 1; size < TARGET; i++) {
    const row = i === n.row
      ? `<tr><td>${i}</td><td>special-record</td><td>access code ${n.code}</td></tr>\n`
      : `<tr><td>${i}</td><td>record-${(i * 2654435761 % 4294967296).toString(16)}</td><td>status nominal, checksum ${(i * 40503 % 65521).toString(16).padStart(4, '0')}</td></tr>\n`;
    rows.push(row);
    size += row.length;
  }
  bigPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Large export</title></head><body><h1>Large export</h1><p>${rows.length} records.</p><table><thead><tr><th>#</th><th>Name</th><th>Detail</th></tr></thead><tbody>\n${rows.join('')}</tbody></table></body></html>`;
  return bigPage;
}

const CHALLENGE_SCRIPT = (token: string) => `<script>setTimeout(function(){document.cookie='__chal=${token}; path=/';location.reload()},300)</script>`;

function menuHtml(c: Ctx, charset: 'header' | 'meta'): Buffer {
  const rows = c.truth.misc.cafe.map((d) => `<tr><td>${d.dish}</td><td>${d.price}</td></tr>`).join('');
  const meta = charset === 'meta' ? '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">' : '<meta charset="iso-8859-1">';
  return Buffer.from(`<!doctype html><html lang="fr"><head>${meta}<title>Café du Port — carte</title></head><body><h1>Café du Port</h1><p>Notre carte du jour, préparée avec des produits frais.</p><table><tr><th>Plat</th><th>Prix</th></tr>${rows}</table></body></html>`, 'latin1');
}

export async function handle(c: Ctx, rest: string): Promise<void> {
  const m0 = c.truth.misc;
  c.rt.state.misc.requests[rest.split('/')[1] ?? ''] = (c.rt.state.misc.requests[rest.split('/')[1] ?? ''] ?? 0) + 1;
  let m: RegExpExecArray | null;
  if (rest === '/' || rest === '') {
    const links = ['redirect/3', 'redirect-loop/a', 'status/404', 'status/500', 'slow?ms=3000', 'big', 'latin1', 'sjis', 'gzip', 'api/items', 'feed.xml', 'data.csv', 'doc.pdf', 'markdown', 'etag', 'challenge', 'next'];
    return c.html(shell(chrome, { title: 'Wire Lab', main: `<h1>Protocol behaviour</h1><ul>${links.map((l) => `<li><a href="/misc/${l}">/misc/${l}</a></li>`).join('')}</ul>` }));
  }
  if ((m = /^\/redirect\/(\d+)$/.exec(rest))) {
    const n = Number(m[1]);
    if (n > 0) return c.send([301, 302, 303, 307, 308][n % 5]!, { Location: `/misc/redirect/${n - 1}`, 'Cache-Control': 'no-store' }, `Moved to /misc/redirect/${n - 1}`);
    return c.html(shell(chrome, { title: 'Redirect destination', main: `<h1>You made it</h1><p>Final destination reached. Redirect code: <strong id="code">${m0.redirectCode}</strong></p>` }));
  }
  if ((m = /^\/redirect-loop\/([ab])$/.exec(rest))) return c.send(302, { Location: `/misc/redirect-loop/${m[1] === 'a' ? 'b' : 'a'}`, 'Cache-Control': 'no-store' }, 'Loop');
  if ((m = /^\/status\/(\d{3})$/.exec(rest))) {
    const code = Number(m[1]);
    if (code < 200 || code > 599) return c.notFound();
    if (code === 204 || code === 304) return c.send(code, {}, '');
    const headers: Record<string, string> = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
    if (code === 429 || code === 503) headers['Retry-After'] = '1';
    if (code >= 300 && code < 400) headers.Location = '/misc/status/200';
    const word = ({ 403: 'Forbidden', 404: 'Not Found', 410: 'Gone', 429: 'Too Many Requests', 500: 'Internal Server Error', 503: 'Service Unavailable' } as Record<number, string>)[code] ?? 'Status';
    return c.send(code, headers, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${code} ${word}</title></head><body><h1>${code} ${word}</h1><p>The server answered with status ${code}. Reference code: <strong id="code">${m0.errorCodes[code] ?? 'N/A'}</strong></p></body></html>`);
  }
  if (rest === '/slow') {
    const ms = Math.max(0, Math.min(15000, Number(c.q.get('ms') ?? 3000) || 3000));
    await sleep(ms);
    return c.html(shell(chrome, { title: 'Slow page', main: `<h1>Slow response</h1><p>This page was delayed by ${ms} ms. Slow code: <strong id="code">${m0.slowCode}</strong></p>` }));
  }
  if (rest === '/big') return c.send(200, { 'Content-Type': 'text/html; charset=utf-8' }, bigHtml(c));
  if (rest === '/latin1') return c.send(200, { 'Content-Type': 'text/html; charset=iso-8859-1' }, menuHtml(c, 'meta'));
  if (rest === '/latin1-meta') return c.send(200, { 'Content-Type': 'text/html' }, menuHtml(c, 'meta'));
  if (rest === '/sjis') {
    const html = `<!doctype html><html lang="ja"><head><meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS"><title>${m0.sjis.text}</title></head><body><h1>${m0.sjis.text}</h1><p>この街の名前は ${m0.sjis.city} です。</p><p>City (English): ${m0.sjis.city}</p></body></html>`;
    return c.send(200, { 'Content-Type': 'text/html; charset=Shift_JIS' }, encodeShiftJis(html));
  }
  if ((m = /^\/(gzip|deflate|brotli)$/.exec(rest))) {
    const html = shell(chrome, { title: 'Compressed page', main: `<h1>Compressed response</h1><p>Content-Encoding: ${m[1]}. Code: <strong id="code">${m0.gzipCode}</strong></p>${'<p>Filler paragraph for the compressor to chew on. </p>'.repeat(200)}`, noCookie: true });
    const body = m[1] === 'gzip' ? gzipSync(html) : m[1] === 'deflate' ? deflateSync(html) : brotliCompressSync(html);
    return c.send(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': m[1] === 'brotli' ? 'br' : m[1]!, Vary: 'Accept-Encoding' }, body);
  }
  if (rest === '/api/items') {
    const limit = Math.max(1, Math.min(5000, Number(c.q.get('limit')) || 5000));
    const offset = Math.max(0, Number(c.q.get('offset')) || 0);
    return c.json({ total: m0.bigArray.length, offset, items: m0.bigArray.slice(offset, offset + limit) });
  }
  if (rest === '/feed.xml') {
    const items = m0.rss.map((i) => `<item><title>${esc(i.title)}</title><link>${c.origin}${i.link}</link><guid>${c.origin}${i.link}</guid><pubDate>${i.date}</pubDate><description>${esc(i.summary)}</description></item>`).join('\n');
    return c.send(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' }, `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Wire Lab releases</title><link>${c.origin}/misc/</link><description>Release notes</description>\n${items}\n</channel></rss>`);
  }
  if ((m = /^\/post\/(\d+)$/.exec(rest))) {
    const it = m0.rss[Number(m[1]) - 1];
    return it ? c.html(shell(chrome, { title: it.title, main: `<article><h1>${esc(it.title)}</h1><p>${esc(it.summary)}</p></article>` })) : c.notFound();
  }
  if (rest === '/data.csv') {
    const csv = [m0.csv.header.join(','), ...m0.csv.rows.map((r) => r.join(','))].join('\n') + '\n';
    return c.send(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'inline; filename="cities.csv"' }, csv);
  }
  if (rest === '/doc.pdf') {
    const p = m0.pdf;
    return c.send(200, { 'Content-Type': 'application/pdf' }, makePdf([`${p.company} - Invoice ${p.invoice}`, 'Date: 2026-10-31', '', ...p.lines.map(([d, cents]) => `${d}: ${money(cents)}`), '', `Total due: ${money(p.totalCents)}`, 'Payment terms: 30 days.']));
  }
  if (rest === '/markdown') {
    const wants = /text\/markdown/.test(c.header('accept'));
    if (wants) return c.send(200, { 'Content-Type': 'text/markdown; charset=utf-8', Vary: 'Accept' }, `# Release guide\n\nThis is the markdown edition of the page.\n\n- Step one: install\n- Step two: verify\n\nMarkdown code: **${m0.markdownCode}**\n`);
    return c.html(shell(chrome, { title: 'Release guide', main: `<h1>Release guide</h1><p>This is the HTML edition of the page. Ask for text/markdown to get a leaner version.</p>${'<p>Navigation chrome and boilerplate that a markdown edition would drop.</p>'.repeat(30)}` }), 200, { Vary: 'Accept' });
  }
  if (rest === '/etag') {
    const tag = `"v1-${hashHex(c.truth.seed, 'etag').slice(0, 10)}"`;
    const lm = 'Mon, 02 Nov 2026 10:00:00 GMT';
    const inm = c.header('if-none-match');
    const ims = c.header('if-modified-since');
    if ((inm && inm.split(/\s*,\s*/).includes(tag)) || (!inm && ims && Date.parse(ims) >= Date.parse(lm))) {
      c.rt.state.misc.etag304++;
      return c.send(304, { ETag: tag, 'Last-Modified': lm, 'Cache-Control': 'max-age=0, must-revalidate' }, '');
    }
    c.rt.state.misc.etag200++;
    return c.send(200, { 'Content-Type': 'text/html; charset=utf-8', ETag: tag, 'Last-Modified': lm, 'Cache-Control': 'max-age=0, must-revalidate' }, `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cacheable page</title></head><body><h1>Cacheable page</h1><p>Cache code: <strong id="code">${m0.etagBody}</strong></p></body></html>`);
  }
  if (rest === '/challenge') {
    const token = hashHex(c.truth.seed, 'challenge').slice(0, 20);
    if (c.cookies.__chal === token) {
      c.rt.state.misc.challengePassed++;
      return c.html(shell(chrome, { title: 'Protected page', main: `<h1>Protected page</h1><p>Welcome. Access code: <strong id="code">${m0.challengeCode}</strong></p>` }));
    }
    c.rt.state.misc.challengeServed++;
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Just a moment...</title></head><body><h1>Checking your browser before accessing this site</h1><p>This process is automatic. Your browser will redirect to your requested content shortly.</p><noscript>Please enable JavaScript and cookies to continue.</noscript>${CHALLENGE_SCRIPT(token)}</body></html>`, 503, { 'Retry-After': '5' });
  }
  if (rest === '/next') {
    const p = m0.nextData;
    const data = { props: { pageProps: { product: { name: p.product, sku: p.sku, price: (p.priceCents / 100).toFixed(2), currency: 'USD', inStock: true } } }, page: '/products/[sku]', query: { sku: p.sku }, buildId: 'farm-build' };
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(p.product)} | Tern Shop</title></head><body><div id="__next"></div>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>(function(){var d=JSON.parse(document.getElementById('__NEXT_DATA__').textContent).props.pageProps.product;document.getElementById('__next').innerHTML='<h1>'+d.name+'</h1><p>SKU '+d.sku+'</p><p class="price">$'+d.price+'</p>'})();</script></body></html>`);
  }
  if ((m = /^\/info\/([a-z-]+)$/.exec(rest))) return c.html(infoPage(c, chrome, m[1]!));
  c.notFound();
}
