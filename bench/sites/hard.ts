// /hard/ — difficult DOM: shadow roots and slots, same- and cross-origin iframes, icon-only buttons,
// divs with click handlers, script-driven tabs and accordion, a canvas chart whose numbers are in no
// text node, infinite scroll, and a "load more" button.
import type { Ctx } from './core.ts';
import { esc, shell, infoPage } from './html.ts';
import type { Chrome } from './html.ts';
import { money } from './rng.ts';

const chrome: Chrome = {
  base: '/hard', brand: 'Edge Cases', tagline: 'Awkward pages on purpose',
  nav: [['Shadow DOM', '/hard/shadow'], ['Frames', '/hard/frames'], ['Icons', '/hard/icons'], ['Tabs', '/hard/tabs'], ['Chart', '/hard/chart'], ['Infinite', '/hard/infinite'], ['Load more', '/hard/more']],
};

const BEACON = `function beacon(name,detail){try{fetch('/hard/api/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,detail:String(detail||'')})})}catch(e){}}`;

export async function handle(c: Ctx, rest: string): Promise<void> {
  const h = c.truth.hard;
  if (rest === '/' || rest === '') {
    return c.html(shell(chrome, { title: 'Edge Cases', main: `<h1>Difficult pages</h1><ul>${chrome.nav.map(([l, p]) => `<li><a href="${p}">${l}</a></li>`).join('')}</ul>` }));
  }
  if (rest === '/shadow') {
    const prices = Object.fromEntries(h.shadow.map((p) => [p.sku, money(p.priceCents)]));
    return c.html(shell(chrome, {
      title: 'Web components — Edge Cases',
      main: `<h1>Kitchen range</h1><p id="status" role="status">Nothing added yet.</p>
<div class="range">${h.shadow.map((p) => `<product-card sku="${p.sku}"><span slot="title">${esc(p.name)}</span><small>Free delivery on orders over $75</small></product-card>`).join('\n')}</div>`,
      scripts: `<script>${BEACON}
var PRICES=${JSON.stringify(prices)};
class ProductCard extends HTMLElement{constructor(){super();var r=this.attachShadow({mode:'open'});
r.innerHTML='<style>:host{display:block;border:1px solid #ccd;padding:10px;margin:8px 0;background:#fff}.price{font-weight:700;font-size:20px}</style><div class="card"><h3><slot name="title"></slot></h3><span class="price" part="price"></span> <slot></slot><div><button type="button" class="add">Add to basket</button></div></div>';
r.querySelector('.price').textContent=PRICES[this.getAttribute('sku')];
var self=this;r.querySelector('.add').addEventListener('click',function(){var n=self.querySelector('[slot=title]').textContent;document.getElementById('status').textContent='Added '+n+' to basket';beacon('shadow-add',self.getAttribute('sku'))})}}
customElements.define('product-card',ProductCard);</script>`,
    }));
  }
  if (rest === '/frames') {
    return c.html(shell(chrome, {
      title: 'Frames — Edge Cases',
      main: `<h1>Embedded content</h1><h2>Same-origin frame</h2><iframe src="/hard/frame-inner" title="Order status" width="520" height="120" style="border:1px solid #ccd"></iframe>
<h2>Cross-origin frame</h2><iframe src="${c.otherOrigin}/frame" title="Partner widget" width="520" height="120" style="border:1px solid #ccd"></iframe>`,
    }));
  }
  if (rest === '/frame-inner') {
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Order status frame</title></head><body style="font-family:sans-serif"><h3>Order status</h3><p>Verification code: <strong id="code">${h.sameFrameCode}</strong></p></body></html>`);
  }
  if (rest === '/icons') {
    const heart = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 21s-8-5.4-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.6-8 11-8 11z" fill="none" stroke="currentColor"/></svg>';
    const bin = '<svg viewBox="0 0 24 24" width="20" height="20"><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor"/></svg>';
    const rows = h.icons.map((it) => {
      const favBtn = it.id <= 2
        ? `<button type="button" class="icon-btn fav" data-id="${it.id}" aria-label="Add to wishlist">${heart}</button>`
        : it.id === 3 ? `<button type="button" class="icon-btn fav" data-id="${it.id}" title="Save for later">${heart}</button>`
          : `<button type="button" class="icon-btn fav" data-id="${it.id}">${heart}</button>`;
      return `<li class="item" data-id="${it.id}" style="display:flex;gap:12px;align-items:center;padding:6px 0;border-bottom:1px solid #dde1e8"><span class="name" style="width:160px">${esc(it.name)}</span>${favBtn}
<button type="button" class="icon-btn del" data-id="${it.id}">${bin}</button><div class="share" data-id="${it.id}" style="cursor:pointer;color:#1a56c4">Share</div></li>`;
    }).join('');
    return c.html(shell(chrome, {
      title: 'Icon buttons — Edge Cases',
      main: `<h1>Furniture list</h1><p>Wishlist: <span id="wishlist-count">0</span> items · Removed: <span id="removed-count">0</span> · <span id="last-action">No action yet</span></p><ul id="items" style="list-style:none;padding:0">${rows}</ul>`,
      scripts: `<script>${BEACON}
var wish={},removed=0;
document.getElementById('items').addEventListener('click',function(e){var t=e.target.closest('.fav,.del,.share');if(!t)return;var id=t.getAttribute('data-id');var name=t.closest('.item').querySelector('.name').textContent;
if(t.classList.contains('fav')){wish[id]=!wish[id];document.getElementById('wishlist-count').textContent=Object.keys(wish).filter(function(k){return wish[k]}).length;document.getElementById('last-action').textContent=(wish[id]?'Wishlisted ':'Unwishlisted ')+name;beacon('wishlist',id)}
else if(t.classList.contains('del')){t.closest('.item').style.opacity='0.4';removed++;document.getElementById('removed-count').textContent=removed;document.getElementById('last-action').textContent='Removed '+name;beacon('remove',id)}
else{document.getElementById('last-action').textContent='Link to '+name+' copied';beacon('share',id)}});</script>`,
    }));
  }
  if (rest === '/tabs') {
    return c.html(shell(chrome, {
      title: 'Tabs and accordion — Edge Cases',
      main: `<h1>Plans and FAQ</h1>
<div role="tablist" aria-label="Product information">${h.tabs.map((t, i) => `<div role="tab" id="tab-${t.id}" data-tab="${t.id}" tabindex="0" aria-selected="${i === 0}" style="display:inline-block;padding:8px 16px;cursor:pointer;border-bottom:3px solid ${i === 0 ? '#1a56c4' : 'transparent'}">${esc(t.label)}</div>`).join('')}</div>
<div id="panels">${h.tabs.map((t, i) => `<div role="tabpanel" id="panel-${t.id}" ${i === 0 ? '' : 'hidden'}>${t.id === 'pricing' ? '<p>Loading…</p>' : `<p>${esc(t.body)}</p>`}</div>`).join('')}</div>
<h2>Frequently asked questions</h2>
<div class="accordion">${h.accordion.map((a, i) => `<div class="acc-item"><button type="button" class="acc-head" aria-expanded="false" aria-controls="acc-${i}" style="width:100%;text-align:left;padding:10px">${esc(a.q)}</button><div id="acc-${i}" class="acc-body" hidden><p>${esc(a.a)}</p></div></div>`).join('')}</div>`,
      scripts: `<script>
var loaded=false;
function show(id){document.querySelectorAll('[role=tab]').forEach(function(t){var on=t.dataset.tab===id;t.setAttribute('aria-selected',on);t.style.borderBottomColor=on?'#1a56c4':'transparent'});
document.querySelectorAll('[role=tabpanel]').forEach(function(p){p.hidden=p.id!=='panel-'+id});
if(id==='pricing'&&!loaded){loaded=true;fetch('/hard/api/tab/pricing').then(function(r){return r.text()}).then(function(t){document.getElementById('panel-pricing').innerHTML='<p>'+t+'</p>'})}}
document.querySelectorAll('[role=tab]').forEach(function(t){t.addEventListener('click',function(){show(t.dataset.tab)})});
document.querySelectorAll('.acc-head').forEach(function(b){b.addEventListener('click',function(){var open=b.getAttribute('aria-expanded')==='true';b.setAttribute('aria-expanded',String(!open));document.getElementById(b.getAttribute('aria-controls')).hidden=open})});</script>`,
    }));
  }
  if (rest === '/chart') {
    // The numbers are stored scrambled and drawn onto the canvas only: they appear in no text node.
    const enc = h.chart.values.map((v) => (v - 7) * 3);
    return c.html(shell(chrome, {
      title: 'Chart — Edge Cases',
      main: `<h1>Quarterly revenue</h1><p>The chart below shows revenue per quarter in thousands of dollars.</p><canvas id="chart" width="640" height="360" role="img" aria-label="Bar chart of revenue by quarter" style="background:#fff;border:1px solid #ccd"></canvas>`,
      scripts: `<script>(function(){var e=${JSON.stringify(enc)},L=${JSON.stringify(h.chart.labels)};var v=e.map(function(x){return x/3+7});
var cv=document.getElementById('chart'),g=cv.getContext('2d');var max=Math.max.apply(null,v);g.font='14px sans-serif';g.fillStyle='#222';
g.fillText(${JSON.stringify(h.chart.title)},20,24);var w=70,gap=28,x0=40,base=320;
v.forEach(function(val,i){var hh=Math.round(val/max*240);var x=x0+i*(w+gap);g.fillStyle='#1a56c4';g.fillRect(x,base-hh,w,hh);g.fillStyle='#222';g.fillText(String(val),x+w/2-12,base-hh-8);g.fillText(L[i],x+w/2-8,base+20)})})();</script>`,
    }));
  }
  if (rest === '/infinite') {
    const first = h.feed.slice(0, 20);
    return c.html(shell(chrome, {
      title: 'Infinite scroll — Edge Cases',
      main: `<h1>Activity feed</h1><ol id="feed" style="list-style:none;padding:0">${first.map((t, i) => `<li class="entry" style="height:56px;border-bottom:1px solid #dde1e8" data-n="${i + 1}">${esc(t)}</li>`).join('')}</ol><div id="sentinel" style="height:10px"></div><p id="end" hidden>You have reached the end of the feed.</p>`,
      scripts: `<script>var page=1,busy=false,done=false;
function more(){if(busy||done)return;busy=true;fetch('/hard/api/feed?page='+(page+1)).then(function(r){return r.json()}).then(function(d){var f=document.getElementById('feed');d.items.forEach(function(t,i){var li=document.createElement('li');li.className='entry';li.style.cssText='height:56px;border-bottom:1px solid #dde1e8';li.textContent=t;f.appendChild(li)});page++;busy=false;if(!d.more){done=true;document.getElementById('end').hidden=false}})}
new IntersectionObserver(function(es){if(es[0].isIntersecting)more()},{rootMargin:'100px'}).observe(document.getElementById('sentinel'));
window.addEventListener('scroll',function(){if(innerHeight+scrollY>=document.body.scrollHeight-200)more()});</script>`,
    }));
  }
  if (rest === '/more') {
    return c.html(shell(chrome, {
      title: 'Load more — Edge Cases',
      main: `<h1>Archive</h1><ul id="list">${h.more.slice(0, 10).map((t) => `<li>${esc(t)}</li>`).join('')}</ul><p id="count">Showing 10 of ${h.more.length}</p><button type="button" id="load-more">Load more</button>`,
      scripts: `<script>var shown=10;document.getElementById('load-more').addEventListener('click',function(){fetch('/hard/api/more?offset='+shown).then(function(r){return r.json()}).then(function(d){var ul=document.getElementById('list');d.items.forEach(function(t){var li=document.createElement('li');li.textContent=t;ul.appendChild(li)});shown+=d.items.length;document.getElementById('count').textContent='Showing '+shown+' of '+d.total;if(shown>=d.total)document.getElementById('load-more').remove()})});</script>`,
    }));
  }
  if (rest === '/api/event' && c.method === 'POST') {
    const f = await c.form();
    c.rt.state.events.push({ name: f.get('name'), detail: f.get('detail') });
    return c.json({ ok: true });
  }
  if (rest === '/api/tab/pricing') return c.text(h.tabs.find((t) => t.id === 'pricing')!.body);
  if (rest === '/api/feed') {
    const p = Math.max(1, Number(c.q.get('page')) || 1);
    const items = h.feed.slice((p - 1) * 20, p * 20);
    return c.json({ items, more: p * 20 < h.feed.length });
  }
  if (rest === '/api/more') {
    const off = Math.max(0, Number(c.q.get('offset')) || 0);
    return c.json({ items: h.more.slice(off, off + 10), total: h.more.length });
  }
  const m = /^\/info\/([a-z-]+)$/.exec(rest);
  if (m) return c.html(infoPage(c, chrome, m[1]!));
  c.notFound();
}

/** The cross-origin frame body, served by the second origin. */
export function crossFrame(code: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Partner widget</title></head><body style="font-family:sans-serif"><h3>Partner widget</h3><p>Partner code: <strong id="code">${code}</strong></p></body></html>`;
}
