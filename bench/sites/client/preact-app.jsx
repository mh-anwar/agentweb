// The /spa-preact/ storefront: a Preact single-page app over /spa/api/*.
import { render } from 'preact';
import { useState, useEffect } from 'preact/hooks';

const BASE = '/spa-preact';
const money = (c) => '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const get = (p) => fetch('/spa/api' + p).then((r) => r.json());
const post = (p, b) => fetch('/spa/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

function App() {
  const [path, setPath] = useState(location.pathname.slice(BASE.length) || '/');
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [product, setProduct] = useState(null);
  const [count, setCount] = useState(0);
  const [notice, setNotice] = useState('');
  const [sort, setSort] = useState('featured');
  const go = (to) => { history.pushState({}, '', BASE + to); setPath(to); };
  useEffect(() => { get('/categories').then((d) => setCats(d.items)); get('/cart').then((c) => setCount(c.lines.reduce((a, l) => a + l.qty, 0))); const f = () => setPath(location.pathname.slice(BASE.length) || '/'); addEventListener('popstate', f); }, []);
  let m;
  useEffect(() => {
    if ((m = /^\/c\/([a-z-]+)$/.exec(path))) { setItems([]); setSort('featured'); get('/products?category=' + m[1]).then((d) => setItems(d.items)); }
    else if ((m = /^\/p\/(\d+)$/.exec(path))) { setProduct(null); get('/products/' + m[1]).then(setProduct); }
  }, [path]);
  const add = (p) => post('/cart/add', { productId: p.id, qty: 1 }).then((c) => { setCount(c.lines.reduce((a, l) => a + l.qty, 0)); setNotice('Added ' + p.name + ' to cart'); });
  const Anchor = ({ to, children }) => <a href={BASE + to} onClick={(e) => { e.preventDefault(); go(to); }}>{children}</a>;
  const xs = items.slice();
  if (sort === 'price_asc') xs.sort((a, b) => a.priceCents - b.priceCents); else if (sort === 'price_desc') xs.sort((a, b) => b.priceCents - a.priceCents); else if (sort === 'rating') xs.sort((a, b) => b.rating - a.rating || a.id - b.id);
  return (
    <div>
      <header class="site"><div class="bar"><Anchor to="/">Tradewind (Preact)</Anchor><span class="cart-link" style="margin-left:auto">Cart ({count})</span></div></header>
      <main style="max-width:1100px;margin:0 auto;padding:20px">
        {notice && <p role="status" class="notice">{notice}</p>}
        {path === '/' && <section><h1>Tradewind Store</h1><ul class="categories">{cats.map((c) => <li key={c.slug}><Anchor to={'/c/' + c.slug}>{c.name}</Anchor> ({c.count})</li>)}</ul></section>}
        {/^\/c\//.test(path) && <section><h1>Products</h1>
          <label>Sort by <select value={sort} onChange={(e) => setSort(e.target.value)}><option value="featured">Featured</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option><option value="rating">Rating</option></select></label>
          <p role="status">{xs.length} products</p>
          {xs.map((p) => <article key={p.id} class="product-card" data-product-id={p.id} style="border-bottom:1px solid #dde1e8;padding:8px 0"><Anchor to={'/p/' + p.id}><strong>{p.name}</strong></Anchor> <span class="price">{money(p.priceCents)}</span> <span class="rating-value">{p.rating}</span> <button class="primary" disabled={p.stock <= 0} onClick={() => add(p)}>Add to cart</button></article>)}</section>}
        {/^\/p\//.test(path) && product && <section><h1>{product.name}</h1><p class="price">{money(product.priceCents)}</p><p>Rating {product.rating} ({product.reviews.length} reviews)</p><button class="primary" disabled={product.stock <= 0} onClick={() => add(product)}>Add to cart</button>
          <table class="specs"><tbody>{product.specs.map((s) => <tr key={s[0]}><th>{s[0]}</th><td>{s[1]}</td></tr>)}</tbody></table></section>}
      </main>
    </div>
  );
}
render(<App />, document.getElementById('root'));
