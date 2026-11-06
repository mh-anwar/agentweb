// /spa/, /spa-vue/, /spa-preact/, /spa-vanilla/ — the same store as single-page apps. The server
// returns an empty HTML shell for every route and serves JSON from /spa/api/*. The React, Vue and
// Preact bundles are built with esbuild at start-up and cached in a temp directory keyed by the hash
// of their sources, so only the first start of a given checkout pays for the build.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx, Order } from './core.ts';
import { BASE_CSS } from './html.ts';
import { hashHex } from './rng.ts';
import { listProducts, queryFromParams } from './shop.ts';
import { quote } from './truth.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, 'client');

export type SpaKind = 'react' | 'vue' | 'preact' | 'vanilla';
export const SPA_BASES: Record<SpaKind, string> = { react: '/spa', vue: '/spa-vue', preact: '/spa-preact', vanilla: '/spa-vanilla' };

const SOURCES: Record<SpaKind, string> = { react: 'react-app.jsx', vue: 'vue-app.js', preact: 'preact-app.jsx', vanilla: 'vanilla-app.js' };

let assets: Record<SpaKind, string> | undefined;
let building: Promise<Record<SpaKind, string>> | undefined;
export const assetStats = { cached: false, ms: 0 };

/** Build (or load from the temp-dir cache) the four client bundles. Memoised per process. */
export function prepareAssets(): Promise<Record<SpaKind, string>> {
  if (assets) return Promise.resolve(assets);
  return (building ??= doPrepare().then((a) => (assets = a)));
}

async function doPrepare(): Promise<Record<SpaKind, string>> {
  const t0 = Date.now();
  const kinds = Object.keys(SOURCES) as SpaKind[];
  const h = createHash('sha256');
  const esbuild = await import('esbuild');
  h.update('v2:' + esbuild.version);
  for (const k of kinds) h.update(readFileSync(join(CLIENT, SOURCES[k])));
  const dir = join(tmpdir(), `agentweb-farm-${h.digest('hex').slice(0, 16)}`);
  const files = (k: SpaKind) => join(dir, `${k}.js`);
  if (kinds.every((k) => existsSync(files(k)))) {
    assetStats.cached = true;
    assetStats.ms = Date.now() - t0;
    return Object.fromEntries(kinds.map((k) => [k, readFileSync(files(k), 'utf8')])) as Record<SpaKind, string>;
  }
  mkdirSync(dir, { recursive: true });
  const repo = join(here, '..', '..');
  const common = { bundle: true, write: false, minify: true, format: 'iife' as const, target: 'es2020', absWorkingDir: repo, logLevel: 'silent' as const, define: { 'process.env.NODE_ENV': '"production"' } };
  const out: Record<string, string> = {};
  await Promise.all(kinds.map(async (k) => {
    if (k === 'vanilla') { out[k] = readFileSync(join(CLIENT, SOURCES[k]), 'utf8'); return; }
    const r = await esbuild.build({
      ...common, entryPoints: [join(CLIENT, SOURCES[k])], outfile: `${k}.js`,
      ...(k === 'vue' ? { alias: { vue: 'vue/dist/vue.esm-bundler.js' }, define: { ...common.define, __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } } : {}),
      ...(k === 'react' ? { jsx: 'automatic' as const } : {}),
      ...(k === 'preact' ? { jsx: 'automatic' as const, jsxImportSource: 'preact' } : {}),
    });
    out[k] = r.outputFiles![0]!.text;
  }));
  for (const k of kinds) {
    const tmp = files(k) + `.${process.pid}.tmp`;
    writeFileSync(tmp, out[k]!);
    renameSync(tmp, files(k));
  }
  assetStats.cached = false;
  assetStats.ms = Date.now() - t0;
  return out as Record<SpaKind, string>;
}

function shellHtml(kind: SpaKind): string {
  const base = SPA_BASES[kind];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tradewind Store (${kind})</title><style>${BASE_CSS}</style></head>
<body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript>
<script src="${base}/assets/app.js" defer></script></body></html>`;
}

// ---------------------------------------------------------------------------------------------
// API

type SpaCart = Record<string, number>;
const cartOf = (c: Ctx): SpaCart => ((c.session('spa')!.cart ??= {}) as SpaCart);

function cartJson(c: Ctx) {
  const lines = Object.entries(cartOf(c)).filter(([, q]) => q > 0).map(([id, qty]) => {
    const p = c.truth.shop.products[Number(id) - 1]!;
    return { productId: p.id, name: p.name, priceCents: p.priceCents, qty };
  });
  return { lines, subtotalCents: lines.reduce((a, l) => a + l.priceCents * l.qty, 0) };
}

const summary = (p: import('./truth.ts').Product) => ({ id: p.id, name: p.name, brand: p.brand, category: p.category, priceCents: p.priceCents, rating: p.rating, reviewCount: p.reviews.length, stock: p.stock });

async function api(c: Ctx, rest: string): Promise<void> {
  const t = c.truth;
  let m: RegExpExecArray | null;
  if (rest === '/categories') return c.json({ items: t.shop.categories.map((x) => ({ slug: x.slug, name: x.name, count: t.shop.products.filter((p) => p.category === x.slug).length })) });
  if (rest === '/products') return c.json({ items: listProducts(t, queryFromParams(c.q)).map(summary) });
  if ((m = /^\/products\/(\d+)$/.exec(rest))) {
    const p = t.shop.products[Number(m[1]) - 1];
    return p ? c.json({ ...summary(p), specs: p.specs, description: p.description, reviews: p.reviews }) : c.json({ error: 'not found' }, 404);
  }
  if (rest === '/promo') return c.json({ code: t.spa.promoCode, pct: t.spa.dealPct });
  if (rest === '/cart' && c.method === 'GET') return c.json(cartJson(c));
  if (rest === '/cart/add' && c.method === 'POST') {
    const f = await c.form();
    const id = Number(f.get('productId'));
    const qty = Math.max(1, Math.min(10, Number(f.get('qty') || 1) || 1));
    const p = t.shop.products[id - 1];
    if (!p) return c.json({ error: 'unknown product' }, 404);
    if (p.stock <= 0) return c.json({ error: 'out of stock' }, 409);
    const cart = cartOf(c);
    cart[id] = (cart[id] ?? 0) + qty;
    c.rt.state.cartEvents.push({ site: 'spa', op: 'add', productId: id, qty });
    return c.json(cartJson(c));
  }
  if (rest === '/cart/remove' && c.method === 'POST') {
    const f = await c.form();
    const id = Number(f.get('productId'));
    const cart = cartOf(c);
    if (cart[id]) { c.rt.state.cartEvents.push({ site: 'spa', op: 'remove', productId: id, qty: cart[id]! }); delete cart[id]; }
    return c.json(cartJson(c));
  }
  if (rest === '/checkout' && c.method === 'POST') {
    const cart = cartJson(c);
    if (!cart.lines.length) return c.json({ error: 'empty cart' }, 400);
    const qt = quote(cart.lines.map((l) => ({ priceCents: l.priceCents, qty: l.qty })));
    const id = 'SPA-' + hashHex(t.seed, 'order', ++c.rt.orderCounter).slice(0, 8).toUpperCase();
    const order: Order = {
      id, site: 'spa', lines: cart.lines.map((l) => ({ productId: l.productId, qty: l.qty, priceCents: l.priceCents })), subtotalCents: qt.subtotal, shippingCents: qt.shipping, taxCents: qt.tax,
      totalCents: qt.total, shippingMethod: 'standard', shipTo: { name: '', email: '', address: '', city: '', state: '', zip: '' }, cardLast4: '',
    };
    c.rt.state.orders.push(order);
    c.session('spa')!.cart = {};
    return c.json({ id, totalCents: qt.total });
  }
  c.json({ error: 'not found' }, 404);
}

export function makeHandler(kind: SpaKind) {
  return async (c: Ctx, rest: string): Promise<void> => {
    if (kind === 'react' && rest.startsWith('/api/')) return api(c, rest.slice(4));
    if (rest === '/assets/app.js') {
      const a = await prepareAssets();
      return c.send(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=60' }, a[kind]);
    }
    if (c.method !== 'GET' && c.method !== 'HEAD') return c.notFound();
    c.html(shellHtml(kind));
  };
}
