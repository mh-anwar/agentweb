import { CHECKOUT } from '../bench/sites/tasks.ts';
// A tiny cookie-keeping HTTP client for the farm tests (plain fetch, no browser).
export interface Res { status: number; headers: Headers; text: string; url: string; buf: Buffer }

export class Client {
  jar = new Map<string, string>();
  base: string;
  constructor(base: string) { this.base = base; }

  private cookieHeader(): string { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }

  async req(path: string, init: { method?: string; form?: Record<string, string | string[]>; body?: BodyInit; headers?: Record<string, string>; follow?: boolean } = {}): Promise<Res> {
    let url = path.startsWith('http') ? path : this.base + path;
    let method = init.method ?? (init.form ? 'POST' : 'GET');
    let body: BodyInit | undefined = init.body;
    const headers: Record<string, string> = { ...init.headers };
    if (init.form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(init.form)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
      body = p.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    for (let hop = 0; hop < 12; hop++) {
      const h = { ...headers };
      const ck = this.cookieHeader();
      if (ck) h.Cookie = ck;
      const r = await fetch(url, { method, headers: h, body, redirect: 'manual' });
      for (const sc of r.headers.getSetCookie()) {
        const [pair] = sc.split(';');
        const i = pair!.indexOf('=');
        this.jar.set(pair!.slice(0, i), decodeURIComponent(pair!.slice(i + 1)));
      }
      const buf = Buffer.from(await r.arrayBuffer());
      const loc = r.headers.get('location');
      if (loc && r.status >= 300 && r.status < 400 && init.follow !== false) {
        url = new URL(loc, url).toString();
        if (r.status !== 307 && r.status !== 308) { method = 'GET'; body = undefined; delete headers['Content-Type']; }
        continue;
      }
      return { status: r.status, headers: r.headers, text: buf.toString('utf8'), url, buf };
    }
    throw new Error('too many redirects');
  }
  get(path: string, follow = true) { return this.req(path, { follow }); }
  post(path: string, form: Record<string, string | string[]>, follow = true) { return this.req(path, { form, follow }); }
}

export function hidden(html: string, name: string): string {
  const m = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (!m) throw new Error(`no hidden field ${name}`);
  return m[1]!;
}

export const textOf = (html: string) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
export const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// ---- scripted flows used by several test files -------------------------------------------------
export interface Buy { productId: number; qty: number; method?: 'standard' | 'express'; ship?: { name: string; email: string; address: string; city: string; state: string; zip: string } }

/** Drive the whole shop checkout with plain HTTP. Returns the confirmation page. */
export async function shopCheckout(c: Client, buy: Buy): Promise<Res> {
  await c.post('/shop/cart/add', { product_id: String(buy.productId), qty: String(buy.qty) });
  const ship = buy.ship ?? CHECKOUT;
  const s1 = await c.get('/shop/checkout/shipping');
  const csrf = hidden(s1.text, 'csrf_token');
  const r2 = await c.post('/shop/checkout/shipping', { csrf_token: csrf, name: ship.name, email: ship.email, address: ship.address, city: ship.city, state: ship.state, zip: ship.zip });
  if (!r2.url.endsWith('/shop/checkout/payment')) return r2;
  const r3 = await c.post('/shop/checkout/payment', { csrf_token: hidden(r2.text, 'csrf_token'), method: buy.method ?? 'standard', card_name: ship.name, card_number: CHECKOUT.card, card_expiry: CHECKOUT.expiry, card_cvc: CHECKOUT.cvc });
  if (!r3.url.endsWith('/shop/checkout/review')) return r3;
  return c.post('/shop/checkout/place', { csrf_token: hidden(r3.text, 'csrf_token') });
}

export async function bankLogin(c: Client, user: string, password: string): Promise<Res> {
  return c.post('/bank/login', { username: user, password });
}

export async function bankTransfer(c: Client, o: { from: string; to: string; amount: string; memo: string }): Promise<Res> {
  const form = await c.get('/bank/transfer');
  return c.post('/bank/transfer', { csrf_token: hidden(form.text, 'csrf_token'), from: o.from, to: o.to, amount: o.amount, memo: o.memo, confirm: 'yes' });
}
