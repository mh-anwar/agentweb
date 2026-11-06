// The /spa-vanilla/ storefront: no framework, no build step. DOM calls over /spa/api/*.
(function () {
  var BASE = '/spa-vanilla';
  var root = document.getElementById('root');
  var money = function (c) { return '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); };
  var get = function (p) { return fetch('/spa/api' + p).then(function (r) { return r.json(); }); };
  var post = function (p, b) { return fetch('/spa/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(function (r) { return r.json(); }); };
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { if (k === 'text') e.textContent = attrs[k]; else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var count = 0;
  var header = el('header', { class: 'site' });
  var main = el('main', { style: 'max-width:1100px;margin:0 auto;padding:20px' });
  var cartLabel = el('span', { class: 'cart-link', style: 'margin-left:auto', text: 'Cart (0)' });
  var notice = el('p', { role: 'status', class: 'notice', hidden: '' });
  function link(to, text) { return el('a', { href: BASE + to, text: text, onclick: function (e) { e.preventDefault(); go(to); } }); }
  header.appendChild(el('div', { class: 'bar' }, [link('/', 'Tradewind (vanilla)'), cartLabel]));
  root.appendChild(header); root.appendChild(main);
  function setCount(c) { count = c.lines.reduce(function (a, l) { return a + l.qty; }, 0); cartLabel.textContent = 'Cart (' + count + ')'; }
  function add(p) { post('/cart/add', { productId: p.id, qty: 1 }).then(function (c) { setCount(c); notice.hidden = false; notice.textContent = 'Added ' + p.name + ' to cart'; }); }
  function go(to) { history.pushState({}, '', BASE + to); route(); }
  function route() {
    var p = location.pathname.slice(BASE.length) || '/'; var m;
    main.innerHTML = ''; main.appendChild(notice);
    if ((m = /^\/c\/([a-z-]+)$/.exec(p))) {
      var h1 = el('h1', { text: 'Products' }); var list = el('div'); var status = el('p', { role: 'status' });
      var sel = el('select', { id: 'sort' }, [['featured', 'Featured'], ['price_asc', 'Price: low to high'], ['price_desc', 'Price: high to low'], ['rating', 'Rating']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      main.appendChild(h1); main.appendChild(el('label', { for: 'sort' }, ['Sort by ', sel])); main.appendChild(status); main.appendChild(list);
      get('/products?category=' + m[1]).then(function (d) {
        function draw() {
          var xs = d.items.slice(); var s = sel.value;
          if (s === 'price_asc') xs.sort(function (a, b) { return a.priceCents - b.priceCents; }); else if (s === 'price_desc') xs.sort(function (a, b) { return b.priceCents - a.priceCents; }); else if (s === 'rating') xs.sort(function (a, b) { return b.rating - a.rating || a.id - b.id; });
          status.textContent = xs.length + ' products'; list.innerHTML = '';
          xs.forEach(function (x) { list.appendChild(el('article', { class: 'product-card', 'data-product-id': x.id, style: 'border-bottom:1px solid #dde1e8;padding:8px 0' }, [link('/p/' + x.id, x.name), ' ', el('span', { class: 'price', text: money(x.priceCents) }), ' ', el('span', { class: 'rating-value', text: String(x.rating) }), ' ', el('button', Object.assign({ class: 'primary', text: 'Add to cart', onclick: function () { add(x); } }, x.stock > 0 ? {} : { disabled: '' }))])); });
        }
        sel.addEventListener('change', draw); draw();
      });
    } else if ((m = /^\/p\/(\d+)$/.exec(p))) {
      get('/products/' + m[1]).then(function (x) {
        document.title = x.name + ' — Tradewind vanilla';
        main.appendChild(el('h1', { text: x.name })); main.appendChild(el('p', { class: 'price', text: money(x.priceCents) }));
        main.appendChild(el('p', { text: 'Rating ' + x.rating + ' (' + x.reviews.length + ' reviews)' }));
        main.appendChild(el('button', { class: 'primary', text: 'Add to cart', onclick: function () { add(x); } }));
        main.appendChild(el('table', { class: 'specs' }, x.specs.map(function (s) { return el('tr', {}, [el('th', { text: s[0] }), el('td', { text: s[1] })]); })));
      });
    } else {
      document.title = 'Tradewind Store (vanilla)';
      main.appendChild(el('h1', { text: 'Tradewind Store' }));
      var ul = el('ul', { class: 'categories' }); main.appendChild(ul);
      get('/categories').then(function (d) { d.items.forEach(function (c) { ul.appendChild(el('li', {}, [link('/c/' + c.slug, c.name), ' (' + c.count + ')'])); }); });
    }
  }
  addEventListener('popstate', route);
  get('/cart').then(setCount); route();
})();
