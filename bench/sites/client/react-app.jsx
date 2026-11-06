// The /spa/ storefront: a React single-page app over /spa/api/*.
import { useState, useEffect, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

const BASE = '/spa';
const money = (c) => '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const post = (p, body) => fetch('/spa/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch('/spa/api' + p).then((r) => r.json());
const stars = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));

function useRoute() {
  const [loc, setLoc] = useState(location.pathname + location.search);
  useEffect(() => {
    const f = () => setLoc(location.pathname + location.search);
    addEventListener('popstate', f);
    return () => removeEventListener('popstate', f);
  }, []);
  const go = useCallback((to) => { history.pushState({}, '', to); setLoc(to); window.scrollTo(0, 0); }, []);
  return [loc, go];
}

function Link({ to, go, children, ...rest }) {
  return <a href={BASE + to} onClick={(e) => { if (e.metaKey || e.ctrlKey) return; e.preventDefault(); go(BASE + to); }} {...rest}>{children}</a>;
}

function Modal({ title, onClose, children }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} style={{ background: '#fff', padding: 20, minWidth: 340, maxWidth: 520, borderRadius: 8 }} onClick={(e) => e.stopPropagation()}>
        <button aria-label="Close dialog" onClick={onClose} style={{ float: 'right' }}>×</button>
        <h2 style={{ marginTop: 0 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Card({ p, go, onQuick, onAdd }) {
  return (
    <article className="product-card" data-product-id={p.id} style={{ background: '#fff', border: '1px solid #dde1e8', padding: 12, borderRadius: 6 }}>
      <Link to={`/p/${p.id}`} go={go}><h3 style={{ fontSize: 15 }}>{p.name}</h3></Link>
      <div className="price" style={{ fontWeight: 700 }}>{money(p.priceCents)}</div>
      <div className="rating" aria-label={`Rated ${p.rating} out of 5`}>{stars(p.rating)} <span className="rating-value">{p.rating}</span> ({p.reviewCount})</div>
      <div>{p.stock > 0 ? 'In stock' : <span className="oos">Out of stock</span>}</div>
      <button onClick={() => onQuick(p)}>Quick view</button>{' '}
      <button className="primary" disabled={p.stock <= 0} onClick={() => onAdd(p)}>Add to cart</button>
    </article>
  );
}

function Home({ cats, go }) {
  const [deal, setDeal] = useState(null);
  useEffect(() => {
    const t = setTimeout(() => { get('/promo').then(setDeal); }, 2500);
    return () => clearTimeout(t);
  }, []);
  return (
    <div>
      <h1>Tradewind Store</h1>
      <p>Everyday tech, honestly reviewed. Pick a category to start.</p>
      <ul className="categories">{cats.map((c) => <li key={c.slug}><Link to={`/c/${c.slug}`} go={go}>{c.name}</Link> ({c.count})</li>)}</ul>
      {deal && (
        <section id="weekly-deal" aria-label="Weekly deal" style={{ background: '#fff7d6', padding: 12, border: '1px solid #ecd37a' }}>
          <h2>Weekly deal</h2>
          <p>Take {deal.pct}% off your order with code <strong className="promo-code">{deal.code}</strong> until Sunday.</p>
        </section>
      )}
    </div>
  );
}

function Listing({ slug, cats, go, onQuick, onAdd }) {
  const q0 = new URLSearchParams(location.search);
  const [items, setItems] = useState(null);
  const [sort, setSort] = useState(q0.get('sort') || 'featured');
  const [minRating, setMinRating] = useState(q0.get('min_rating') || '0');
  const [text, setText] = useState(q0.get('q') || '');
  const [inStock, setInStock] = useState(q0.get('in_stock') === '1');
  const [page, setPage] = useState(Number(q0.get('page')) || 1);
  useEffect(() => { setItems(null); get('/products?category=' + slug).then((d) => setItems(d.items)); }, [slug]);
  useEffect(() => {
    const q = new URLSearchParams();
    if (sort !== 'featured') q.set('sort', sort);
    if (minRating !== '0') q.set('min_rating', minRating);
    if (text) q.set('q', text);
    if (inStock) q.set('in_stock', '1');
    if (page > 1) q.set('page', String(page));
    history.replaceState({}, '', location.pathname + (q.toString() ? '?' + q : ''));
  }, [sort, minRating, text, inStock, page]);
  const shown = useMemo(() => {
    if (!items) return [];
    let xs = items.filter((p) => p.rating >= Number(minRating) && (!inStock || p.stock > 0) && (!text || p.name.toLowerCase().includes(text.toLowerCase())));
    if (sort === 'price_asc') xs = xs.slice().sort((a, b) => a.priceCents - b.priceCents);
    else if (sort === 'price_desc') xs = xs.slice().sort((a, b) => b.priceCents - a.priceCents);
    else if (sort === 'rating') xs = xs.slice().sort((a, b) => b.rating - a.rating || a.id - b.id);
    return xs;
  }, [items, sort, minRating, text, inStock]);
  const pages = Math.max(1, Math.ceil(shown.length / 20));
  const cur = Math.min(page, pages);
  const cat = cats.find((c) => c.slug === slug);
  useEffect(() => { document.title = (cat ? cat.name : 'Products') + ' — Tradewind SPA'; }, [cat]);
  return (
    <div>
      <h1>{cat ? cat.name : slug}</h1>
      <div className="filters" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'end' }}>
        <label>Search <input type="search" value={text} onChange={(e) => { setText(e.target.value); setPage(1); }} placeholder="Filter by name" /></label>
        <label>Sort by <select value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="featured">Featured</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option><option value="rating">Customer rating</option>
        </select></label>
        <label>Minimum rating <select value={minRating} onChange={(e) => { setMinRating(e.target.value); setPage(1); }}>
          <option value="0">Any</option><option value="3">3 &amp; up</option><option value="4">4 &amp; up</option><option value="4.5">4.5 &amp; up</option>
        </select></label>
        <label><input type="checkbox" checked={inStock} onChange={(e) => { setInStock(e.target.checked); setPage(1); }} /> In stock only</label>
      </div>
      {items === null ? <p>Loading…</p> : <p role="status" className="result-count">{shown.length} products · page {cur} of {pages}</p>}
      <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 14 }}>
        {shown.slice((cur - 1) * 20, cur * 20).map((p) => <Card key={p.id} p={p} go={go} onQuick={onQuick} onAdd={onAdd} />)}
      </div>
      {pages > 1 && (
        <nav className="pager" aria-label="Pagination" style={{ display: 'flex', gap: 10, margin: '16px 0' }}>
          <button disabled={cur <= 1} onClick={() => setPage(cur - 1)}>Previous</button>
          {Array.from({ length: pages }, (_, i) => <button key={i} aria-current={cur === i + 1 ? 'page' : undefined} onClick={() => setPage(i + 1)}>{i + 1}</button>)}
          <button disabled={cur >= pages} onClick={() => setPage(cur + 1)}>Next</button>
        </nav>
      )}
    </div>
  );
}

function Product({ id, onAdd }) {
  const [p, setP] = useState(null);
  useEffect(() => { setP(null); get('/products/' + id).then((d) => { setP(d); document.title = d.name + ' — Tradewind SPA'; }); }, [id]);
  if (!p) return <p>Loading…</p>;
  return (
    <div>
      <h1>{p.name}</h1>
      <p className="price" style={{ fontSize: 28, fontWeight: 700 }}>{money(p.priceCents)}</p>
      <p>{stars(p.rating)} <strong>{p.rating}</strong> out of 5 ({p.reviews.length} reviews)</p>
      <p>{p.stock > 0 ? `In stock — ${p.stock} available` : 'Out of stock'}</p>
      <button className="primary" disabled={p.stock <= 0} onClick={() => onAdd(p)}>Add to cart</button>
      <h2>Specifications</h2>
      <table className="specs"><tbody>{p.specs.map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}</tbody></table>
      <h2>Reviews</h2>
      {p.reviews.map((r, i) => <article key={i} className="review"><strong>{r.title}</strong> — {r.rating}/5 by {r.author}<p>{r.body}</p></article>)}
    </div>
  );
}

function Cart({ cart, onRemove, onOrder }) {
  const [order, setOrder] = useState(null);
  if (order) return <div><h1>Thank you</h1><p role="status">Order placed. Your order number is <strong id="order-id">{order.id}</strong>.</p></div>;
  if (!cart || !cart.lines.length) return <div><h1>Your cart</h1><p>Your cart is empty.</p></div>;
  return (
    <div>
      <h1>Your cart</h1>
      <table><thead><tr><th>Product</th><th>Qty</th><th>Price</th><th></th></tr></thead><tbody>
        {cart.lines.map((l) => <tr key={l.productId}><td>{l.name}</td><td>{l.qty}</td><td>{money(l.priceCents * l.qty)}</td><td><button onClick={() => onRemove(l)}>Remove</button></td></tr>)}
      </tbody></table>
      <p className="subtotal">Subtotal: <strong>{money(cart.subtotalCents)}</strong></p>
      <button className="primary" onClick={() => post('/checkout', {}).then((o) => { setOrder(o); onOrder(); })}>Place order</button>
    </div>
  );
}

function App() {
  const [loc, go] = useRoute();
  const [cats, setCats] = useState([]);
  const [cart, setCart] = useState(null);
  const [modal, setModal] = useState(null);
  const [notice, setNotice] = useState('');
  useEffect(() => { get('/categories').then((d) => setCats(d.items)); get('/cart').then(setCart); }, []);
  const add = useCallback((p) => {
    post('/cart/add', { productId: p.id, qty: 1 }).then((c) => { setCart(c); setNotice(`Added ${p.name} to cart`); setModal({ kind: 'added', p }); });
  }, []);
  const remove = useCallback((l) => post('/cart/remove', { productId: l.productId }).then(setCart), []);
  const path = loc.split('?')[0].slice(BASE.length) || '/';
  let m;
  let view;
  if (path === '/' || path === '') { document.title = 'Tradewind Store (SPA)'; view = <Home cats={cats} go={go} />; }
  else if ((m = /^\/c\/([a-z-]+)$/.exec(path))) view = <Listing key={m[1]} slug={m[1]} cats={cats} go={go} onQuick={(p) => setModal({ kind: 'quick', p })} onAdd={add} />;
  else if ((m = /^\/p\/(\d+)$/.exec(path))) view = <Product id={m[1]} onAdd={add} />;
  else if (path === '/cart') { document.title = 'Cart — Tradewind SPA'; view = <Cart cart={cart} onRemove={remove} onOrder={() => setCart({ lines: [], subtotalCents: 0 })} />; }
  else view = <div><h1>Not found</h1><p>No such page.</p></div>;
  const count = cart ? cart.lines.reduce((a, l) => a + l.qty, 0) : 0;
  return (
    <div>
      <header className="site" style={{ background: '#fff', borderBottom: '1px solid #dde1e8' }}>
        <div className="bar">
          <Link to="/" go={go} className="brand">Tradewind Store</Link>
          <nav className="main" aria-label="Main"><ul>
            {cats.slice(0, 5).map((c) => <li key={c.slug}><Link to={`/c/${c.slug}`} go={go}>{c.name}</Link></li>)}
          </ul></nav>
          <Link to="/cart" go={go} className="cart-link" style={{ marginLeft: 'auto' }}>Cart (<span id="cart-count">{count}</span>)</Link>
        </div>
      </header>
      <main style={{ maxWidth: 1180, margin: '0 auto', padding: 20 }}>
        {notice && <p role="status" className="notice">{notice}</p>}
        {view}
      </main>
      <footer className="site"><div className="copy">© 2026 Tradewind Store Ltd. All rights reserved. Prices include VAT where applicable.</div></footer>
      {modal && modal.kind === 'quick' && (
        <Modal title={modal.p.name} onClose={() => setModal(null)}>
          <p className="price">{money(modal.p.priceCents)}</p><p>{stars(modal.p.rating)} {modal.p.rating} · {modal.p.reviewCount} reviews</p>
          <button className="primary" disabled={modal.p.stock <= 0} onClick={() => add(modal.p)}>Add to cart</button>{' '}
          <Link to={`/p/${modal.p.id}`} go={(to) => { setModal(null); go(to); }}>Full details</Link>
        </Modal>
      )}
      {modal && modal.kind === 'added' && (
        <Modal title="Added to cart" onClose={() => setModal(null)}>
          <p>{modal.p.name} is in your cart.</p>
          <button onClick={() => setModal(null)}>Continue shopping</button>{' '}
          <button className="primary" onClick={() => { setModal(null); go(BASE + '/cart'); }}>View cart</button>
        </Modal>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
