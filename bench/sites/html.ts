// HTML helpers shared by the server-rendered sites: escaping, a realistic page shell
// (header, navigation, cookie banner, footer) and generic boilerplate pages.
import type { Ctx } from './core.ts';
import { Rng, paragraph, title as mkTitle } from './rng.ts';

export function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function stars(rating: number): string {
  const full = Math.round(rating);
  return '★'.repeat(full) + '☆'.repeat(5 - full);
}

export interface Chrome {
  /** Path prefix, e.g. /shop */
  base: string;
  brand: string;
  tagline: string;
  nav: [label: string, href: string][];
  /** Extra markup placed in the header (search box, account links…). */
  headerExtra?: string;
  accent?: string;
}

export const BASE_CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2330;background:#f6f7f9}
a{color:#1a56c4}header.site{background:#fff;border-bottom:1px solid #dde1e8}
.bar{display:flex;gap:24px;align-items:center;max-width:1180px;margin:0 auto;padding:12px 20px}
.brand{font-weight:700;font-size:20px;color:#111;text-decoration:none}.tagline{color:#667}
nav.main ul{display:flex;gap:16px;list-style:none;margin:0;padding:0}nav.main a{text-decoration:none;color:#334}
main{max-width:1180px;margin:0 auto;padding:20px}
.cookie-banner{position:fixed;bottom:0;left:0;right:0;background:#222;color:#eee;padding:14px 20px;display:flex;gap:16px;align-items:center;z-index:50}
.cookie-banner button{padding:6px 14px;border-radius:4px;border:0;cursor:pointer}
footer.site{background:#1d2330;color:#c8cdd8;margin-top:48px;padding:32px 20px}
footer.site .cols{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:repeat(4,1fr);gap:24px}
footer.site h4{color:#fff;margin:0 0 8px}footer.site ul{list-style:none;margin:0;padding:0}footer.site a{color:#c8cdd8}
.copy{max-width:1180px;margin:20px auto 0;color:#8a93a6;font-size:13px}
table{border-collapse:collapse}th,td{padding:6px 10px;border:1px solid #dde1e8;text-align:left}
.error{color:#b00020}.notice{background:#fff7d6;border:1px solid #ecd37a;padding:8px 12px;border-radius:4px}
input,select,textarea,button{font:inherit}label{display:block;margin:8px 0 2px}
.btn,button.primary{background:#1a56c4;color:#fff;border:0;border-radius:4px;padding:7px 14px;cursor:pointer}
`;

const FOOTER_COLS: [string, [string, string][]][] = [
  ['Company', [['About us', 'about'], ['Careers', 'careers'], ['Press', 'press'], ['Investors', 'investors'], ['Sustainability', 'sustainability']]],
  ['Support', [['Help centre', 'help'], ['Contact us', 'contact'], ['Shipping', 'shipping'], ['Returns', 'returns'], ['Status', 'status']]],
  ['Legal', [['Terms of service', 'terms'], ['Privacy policy', 'privacy'], ['Cookie policy', 'cookies'], ['Accessibility', 'accessibility'], ['Licences', 'licences']]],
  ['Community', [['Blog', 'blog'], ['Forum', 'forum'], ['Newsletter', 'newsletter'], ['Affiliates', 'affiliates'], ['Gift cards', 'gift-cards']]],
];

export interface ShellOpts {
  title: string;
  main: string;
  head?: string;
  scripts?: string;
  lang?: string;
  /** Skip the cookie banner (some pages should not have it). */
  noCookie?: boolean;
  bodyAttrs?: string;
}

export function shell(chrome: Chrome, o: ShellOpts): string {
  const nav = chrome.nav.map(([l, h]) => `<li><a href="${esc(h)}">${esc(l)}</a></li>`).join('');
  const cols = FOOTER_COLS.map(([h, links]) =>
    `<div><h4>${h}</h4><ul>${links.map(([l, s]) => `<li><a href="${chrome.base}/info/${s}">${l}</a></li>`).join('')}</ul></div>`).join('');
  const cookie = o.noCookie ? '' : `
<div id="cookie-banner" class="cookie-banner" role="dialog" aria-label="Cookie consent">
  <p>We use cookies to personalise content, measure traffic and improve your experience. See our <a href="${chrome.base}/info/cookies">cookie policy</a>.</p>
  <button type="button" id="cookie-accept">Accept all</button>
  <button type="button" id="cookie-reject">Reject non-essential</button>
</div>
<script>(function(){var b=document.getElementById('cookie-banner');if(!b)return;function hide(v){document.cookie='consent='+v+'; path=/; max-age=31536000';b.style.display='none'}
if(/(?:^|; )consent=/.test(document.cookie)){b.style.display='none'}
document.getElementById('cookie-accept').addEventListener('click',function(){hide('all')});document.getElementById('cookie-reject').addEventListener('click',function(){hide('essential')})})();</script>`;
  return `<!doctype html>
<html lang="${o.lang ?? 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(chrome.brand)} — ${esc(chrome.tagline)}">
<style>${BASE_CSS}</style>
${o.head ?? ''}
</head>
<body ${o.bodyAttrs ?? ''}>
<a href="#content" class="skip" style="position:absolute;left:-9999px">Skip to main content</a>
<header class="site"><div class="bar">
  <a class="brand" href="${chrome.base}/">${esc(chrome.brand)}</a>
  <span class="tagline">${esc(chrome.tagline)}</span>
  <nav class="main" aria-label="Main"><ul>${nav}</ul></nav>
  ${chrome.headerExtra ?? ''}
</div></header>
<main id="content">
${o.main}
</main>
<footer class="site"><div class="cols">${cols}</div>
<div class="copy">© 2026 ${esc(chrome.brand)} Ltd. All rights reserved. Registered office: 14 Mill Lane, Norwich. Prices include VAT where applicable.</div></footer>
${cookie}
${o.scripts ?? ''}
</body>
</html>`;
}

/** Generic boilerplate for footer links: /<site>/info/<slug>. Deterministic per slug. */
export function infoPage(c: Ctx, chrome: Chrome, slug: string): string {
  const r = Rng.for(c.truth.seed, 'info:' + slug);
  const name = slug.replace(/-/g, ' ').replace(/^./, (x) => x.toUpperCase());
  const paras = Array.from({ length: 5 }, () => `<p>${esc(paragraph(r, 5))}</p>`).join('\n');
  return shell(chrome, {
    title: `${name} — ${chrome.brand}`,
    main: `<h1>${esc(name)}</h1>${paras}<h2>${esc(mkTitle(r))}</h2>${paras.slice(0, 600)}`,
  });
}

export function pager(basePath: string, params: URLSearchParams, page: number, pages: number, key = 'page'): string {
  if (pages <= 1) return '';
  const href = (p: number) => {
    const q = new URLSearchParams(params);
    q.set(key, String(p));
    return `${basePath}?${q}`;
  };
  const out: string[] = [];
  if (page > 1) out.push(`<a rel="prev" href="${esc(href(page - 1))}">« Previous</a>`);
  for (let p = 1; p <= pages; p++) {
    out.push(p === page ? `<strong aria-current="page">${p}</strong>` : `<a href="${esc(href(p))}">${p}</a>`);
  }
  if (page < pages) out.push(`<a rel="next" href="${esc(href(page + 1))}">Next »</a>`);
  return `<nav class="pager" aria-label="Pagination" style="display:flex;gap:10px;margin:16px 0">${out.join(' ')}</nav>`;
}
