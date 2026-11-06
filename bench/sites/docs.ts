// /docs/ — a documentation site: sidebar of ~40 pages, long articles (one over 15,000 words) with
// headings, code blocks, tables and admonitions, and a server-side search box.
import type { Ctx } from './core.ts';
import { esc, shell, infoPage } from './html.ts';
import type { Chrome } from './html.ts';
import type { DocBlock, DocPage } from './truth.ts';

const chrome: Chrome = {
  base: '/docs', brand: 'Halyard Docs', tagline: 'Durable job queues for small teams',
  nav: [['Docs', '/docs/'], ['API', '/docs/api-overview'], ['CLI', '/docs/cli-reference'], ['Changelog', '/docs/changelog'], ['Community', '/docs/info/forum']],
  headerExtra: `<form action="/docs/search" method="get" role="search" style="margin-left:auto"><label for="docsearch" class="sr-only" style="position:absolute;left:-9999px">Search the docs</label><input id="docsearch" type="search" name="q" placeholder="Search docs…" aria-label="Search docs"> <button type="submit">Search</button></form>`,
};

function render(b: DocBlock): string {
  switch (b.k) {
    case 'h2': return `<h2 id="${b.id}"><a class="anchor" href="#${b.id}" aria-hidden="true">#</a> ${esc(b.text)}</h2>`;
    case 'h3': return `<h3 id="${b.id}">${esc(b.text)}</h3>`;
    case 'p': return `<p>${esc(b.text)}</p>`;
    case 'code': return `<pre class="code"><code class="language-${b.lang}">${esc(b.text)}</code></pre>`;
    case 'ul': return `<ul>${b.items.map((i) => `<li>${esc(i).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('')}</ul>`;
    case 'note': return `<div class="admonition ${b.kind}" role="note" style="border-left:4px solid #1a56c4;background:#eef3fc;padding:6px 14px;margin:12px 0"><p class="admonition-title"><strong>${b.kind[0]!.toUpperCase() + b.kind.slice(1)}</strong></p><p>${esc(b.text)}</p></div>`;
    case 'table': return `<table><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((x, i) => `<td>${i === 0 ? `<code>${esc(x)}</code>` : esc(x)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
}

function sidebar(c: Ctx, current: string): string {
  return `<nav class="sidebar" aria-label="Documentation" style="width:240px;flex:none">${c.truth.docs.tree.map(([g, pages]) => `<h3 style="font-size:13px;text-transform:uppercase;color:#667">${esc(g)}</h3><ul style="list-style:none;padding-left:0;margin:0 0 12px">${pages.map((p) => `<li><a href="/docs/${p.slug}" ${p.slug === current ? 'aria-current="page" style="font-weight:700"' : ''}>${esc(p.title)}</a></li>`).join('')}</ul>`).join('')}</nav>`;
}

function articlePage(c: Ctx, p: DocPage, slug = p.slug): void {
  const all = c.truth.docs.pages;
  const i = all.indexOf(p);
  const toc = p.blocks.filter((b): b is Extract<DocBlock, { k: 'h2' }> => b.k === 'h2');
  const prev = all[i - 1];
  const next = all[i + 1];
  c.html(shell(chrome, {
    title: `${p.title} — Halyard Docs`,
    main: `<div style="display:flex;gap:28px">${sidebar(c, slug)}<article style="flex:1;min-width:0;background:#fff;padding:8px 28px">
<p style="color:#667;margin:0">${esc(p.group)} › ${esc(p.title)}</p><h1>${esc(p.title)}</h1>
${toc.length > 3 ? `<nav class="toc" aria-label="On this page"><strong>On this page</strong><ul>${toc.map((h) => `<li><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul></nav>` : ''}
${p.blocks.map(render).join('\n')}
<hr><nav class="prevnext" style="display:flex;justify-content:space-between">${prev ? `<a rel="prev" href="/docs/${prev.slug}">« ${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a rel="next" href="/docs/${next.slug}">${esc(next.title)} »</a>` : ''}</nav></article></div>`,
  }));
}

function blockText(b: DocBlock): string {
  switch (b.k) {
    case 'ul': return b.items.join(' ');
    case 'table': return b.rows.map((r) => r.join(' ')).join(' ');
    default: return b.text;
  }
}

function searchPage(c: Ctx): void {
  const q = (c.q.get('q') ?? '').trim();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { p: DocPage; score: number; snippet: string }[] = [];
  if (terms.length) {
    for (const p of c.truth.docs.pages) {
      const title = p.title.toLowerCase();
      let score = 0;
      for (const w of terms) score += (title.includes(w) ? 20 : 0);
      const body = p.blocks.map(blockText).join(' ');
      const low = body.toLowerCase();
      let first = -1;
      for (const w of terms) {
        const idx = low.indexOf(w);
        if (idx >= 0) { score += Math.min(10, low.split(w).length - 1); if (first < 0 || idx < first) first = idx; }
      }
      if (score > 0) hits.push({ p, score, snippet: first >= 0 ? '…' + body.slice(Math.max(0, first - 60), first + 140) + '…' : body.slice(0, 160) });
    }
    hits.sort((a, b) => b.score - a.score || a.p.title.localeCompare(b.p.title));
  }
  const top = hits.slice(0, 10);
  c.html(shell(chrome, {
    title: `Search: ${q} — Halyard Docs`,
    main: `<div style="display:flex;gap:28px">${sidebar(c, '')}<section style="flex:1"><h1>Search results</h1>
<form action="/docs/search" method="get"><input type="search" name="q" value="${esc(q)}" aria-label="Search query"> <button type="submit">Search</button></form>
<p role="status">${hits.length} result${hits.length === 1 ? '' : 's'} for “${esc(q)}”</p>
<ol class="results">${top.map((h) => `<li><a href="/docs/${h.p.slug}"><strong>${esc(h.p.title)}</strong></a> <span style="color:#667">${esc(h.p.group)}</span><p>${esc(h.snippet)}</p></li>`).join('')}</ol></section></div>`,
  }));
}

export function handle(c: Ctx, rest: string): void {
  const pages = c.truth.docs.pages;
  if (rest === '/' || rest === '') {
    const intro = pages[0]!;
    return articlePage(c, intro, '');
  }
  if (rest === '/search') return searchPage(c);
  let m: RegExpExecArray | null;
  if ((m = /^\/info\/([a-z-]+)$/.exec(rest))) return c.html(infoPage(c, chrome, m[1]!));
  if ((m = /^\/([a-z0-9-]+)$/.exec(rest))) {
    const p = pages.find((x) => x.slug === m![1]);
    if (p) return articlePage(c, p);
  }
  c.notFound('No such documentation page.');
}
