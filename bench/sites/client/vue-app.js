// The /spa-vue/ storefront: a Vue 3 single-page app (runtime template compiler) over /spa/api/*.
import { createApp, ref, computed, onMounted } from 'vue';

const BASE = '/spa-vue';
const money = (c) => '$' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const get = (p) => fetch('/spa/api' + p).then((r) => r.json());
const post = (p, b) => fetch('/spa/api' + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());

createApp({
  template: `
  <div>
    <header class="site"><div class="bar">
      <a :href="base + '/'" class="brand" @click.prevent="go('/')">Tradewind (Vue)</a>
      <nav class="main" aria-label="Main"><ul><li v-for="c in cats" :key="c.slug"><a :href="base + '/c/' + c.slug" @click.prevent="go('/c/' + c.slug)">{{ c.name }}</a></li></ul></nav>
      <span class="cart-link" style="margin-left:auto">Cart ({{ count }})</span>
    </div></header>
    <main style="max-width:1100px;margin:0 auto;padding:20px">
      <p v-if="notice" role="status" class="notice">{{ notice }}</p>
      <section v-if="view === 'home'"><h1>Tradewind Store</h1><p>Choose a category.</p>
        <ul class="categories"><li v-for="c in cats" :key="c.slug"><a :href="base + '/c/' + c.slug" @click.prevent="go('/c/' + c.slug)">{{ c.name }}</a> ({{ c.count }})</li></ul></section>
      <section v-else-if="view === 'list'"><h1>{{ catName }}</h1>
        <label>Sort by <select v-model="sort"><option value="featured">Featured</option><option value="price_asc">Price: low to high</option><option value="price_desc">Price: high to low</option><option value="rating">Rating</option></select></label>
        <p role="status">{{ sorted.length }} products</p>
        <article v-for="p in sorted" :key="p.id" class="product-card" :data-product-id="p.id" style="border-bottom:1px solid #dde1e8;padding:8px 0">
          <a :href="base + '/p/' + p.id" @click.prevent="go('/p/' + p.id)"><strong>{{ p.name }}</strong></a>
          <span class="price"> {{ money(p.priceCents) }}</span> <span class="rating-value">{{ p.rating }}</span>
          <button class="primary" :disabled="p.stock <= 0" @click="add(p)">Add to cart</button></article></section>
      <section v-else-if="view === 'product' && product"><h1>{{ product.name }}</h1><p class="price">{{ money(product.priceCents) }}</p>
        <p>Rating {{ product.rating }} ({{ product.reviews.length }} reviews)</p><button class="primary" :disabled="product.stock <= 0" @click="add(product)">Add to cart</button>
        <table class="specs"><tr v-for="s in product.specs" :key="s[0]"><th>{{ s[0] }}</th><td>{{ s[1] }}</td></tr></table></section>
    </main>
  </div>`,
  setup() {
    const cats = ref([]); const items = ref([]); const product = ref(null); const count = ref(0); const notice = ref('');
    const view = ref('home'); const slug = ref(''); const sort = ref('featured');
    const route = () => {
      const p = location.pathname.slice(BASE.length) || '/'; let m;
      sort.value = 'featured';
      if ((m = /^\/c\/([a-z-]+)$/.exec(p))) { view.value = 'list'; slug.value = m[1]; items.value = []; get('/products?category=' + m[1]).then((d) => { items.value = d.items; }); document.title = 'List — Tradewind Vue'; }
      else if ((m = /^\/p\/(\d+)$/.exec(p))) { view.value = 'product'; product.value = null; get('/products/' + m[1]).then((d) => { product.value = d; document.title = d.name + ' — Tradewind Vue'; }); }
      else { view.value = 'home'; document.title = 'Tradewind Store (Vue)'; }
    };
    const go = (to) => { history.pushState({}, '', BASE + to); route(); };
    onMounted(() => { get('/categories').then((d) => { cats.value = d.items; }); get('/cart').then((c) => { count.value = c.lines.reduce((a, l) => a + l.qty, 0); }); route(); addEventListener('popstate', route); });
    const add = (p) => post('/cart/add', { productId: p.id, qty: 1 }).then((c) => { count.value = c.lines.reduce((a, l) => a + l.qty, 0); notice.value = 'Added ' + p.name + ' to cart'; });
    const sorted = computed(() => { const xs = items.value.slice(); if (sort.value === 'price_asc') xs.sort((a, b) => a.priceCents - b.priceCents); else if (sort.value === 'price_desc') xs.sort((a, b) => b.priceCents - a.priceCents); else if (sort.value === 'rating') xs.sort((a, b) => b.rating - a.rating || a.id - b.id); return xs; });
    const catName = computed(() => (cats.value.find((c) => c.slug === slug.value) || {}).name || slug.value);
    return { base: BASE, cats, product, count, notice, view, sort, sorted, catName, go, add, money };
  },
}).mount('#root');
