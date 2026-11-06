// Content recovered from data embedded in HTML, without running any JavaScript.
//
// JSON-LD is rendered by schema.org type (Article, Product, Recipe, FAQPage, Event, JobPosting, …).
// Framework payloads (__NEXT_DATA__, Nuxt's devalue payload, React Query / Apollo caches, other
// application/json script tags) are pruned of noise (config, flags, translations, tracking, images),
// then we descend to the subtree that holds most of the text and render it with the JSON writer.

import { linkAct } from '../blocks.ts';
import { squash } from '../tree.ts';
import type { Doc, Inline, ReadOutput } from '../types.ts';
import { JsonWriter, isEmpty, isObj, parseJson, type J, type JObj } from './json.ts';
import { emitParagraph } from './text.ts';
import { Emitter, absUrl, htmlText, isUrl, looksHtml, plural, shortUrl, stripHtml, trunc } from './util.ts';

/** Group ids of embedded blocks start here so they do not collide with the compiler's tables. */
const FIRST_GROUP = 5000;

// ───────────────────────────── JSON-LD ─────────────────────────────

const BOILERPLATE = new Set([
  'website', 'webpage', 'organization', 'corporation', 'searchaction', 'imageobject', 'sitenavigationelement', 'wpheader',
  'wpfooter', 'wpsidebar', 'readaction', 'entrypoint', 'brand', 'collectionpage', 'aboutpage', 'contactpage', 'itempage',
  'searchresultspage', 'profilepage', 'medicalwebpage', 'realestatelisting', 'person', 'contactpoint', 'postaladdress',
  'listitem', 'offer', 'aggregateoffer', 'aggregaterating', 'rating', 'review', 'place', 'geocoordinates', 'thing',
]);
const ARTICLE = /^(article|newsarticle|blogposting|report|scholarlyarticle|techarticle|liveblogposting|socialmediaposting|analysisnewsarticle|opinionnewsarticle|reportagenewsarticle|reviewnewsarticle|backgroundnewsarticle|discussionforumposting|posting|creativework|medicalscholarlyarticle)$/;
const PRODUCT = /^(product|productgroup|individualproduct|productmodel|vehicle|car|book|softwareapplication|mobileapplication|webapplication|videogame)$/;

type Node = JObj;

const typesOf = (n: Node): string[] => {
  const t = n['@type'];
  const arr = Array.isArray(t) ? t : t ? [t] : [];
  return arr.filter((x) => typeof x === 'string').map((x) => (x as string).replace(/^.*[/#:]/, '').toLowerCase());
};

function lenientJson(text: string): J | undefined {
  const t = text.trim().replace(/^<!--/, '').replace(/-->$/, '').replace(/^\s*\/\/\s*<!\[CDATA\[/, '').replace(/\/\/\s*\]\]>\s*$/, '');
  try {
    return parseJson(t).value;
  } catch {}
  try {
    // raw control characters inside strings and trailing commas are common in hand-written JSON-LD
    return JSON.parse(t.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1'));
  } catch {
    return undefined;
  }
}

class LdRenderer {
  em: Emitter;
  base: string;
  ids = new Map<string, Node>();
  /** long strings already shown, so framework data does not repeat them */
  shown = new Set<string>();
  title = '';
  substantive = false;
  types: string[] = [];
  constructor(em: Emitter) {
    this.em = em;
    this.base = em.base;
  }

  resolve(v: J | undefined): J | undefined {
    if (isObj(v) && typeof v['@id'] === 'string' && Object.keys(v).length <= 2) return this.ids.get(v['@id']) ?? v;
    return v;
  }
  /** A display string for a value: text, number, {name}, {@value}, the first of an array. */
  str(v: J | undefined): string {
    v = this.resolve(v);
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return looksHtml(v) ? stripHtml(v) : squash(v);
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map((x) => this.str(x)).filter(Boolean).join(', ');
    return this.str(v.name ?? v['@value'] ?? v.text ?? v.headline ?? v.value);
  }
  names(v: J | undefined): string {
    v = this.resolve(v);
    if (Array.isArray(v)) return [...new Set(v.map((x) => this.names(x)).filter(Boolean))].slice(0, 6).join(', ');
    return this.str(v);
  }
  link(v: J | undefined, label?: string): Inline | undefined {
    const u = typeof v === 'string' ? v : isObj(v) ? (v.url ?? v['@id']) : undefined;
    if (typeof u !== 'string') return undefined;
    const abs = absUrl(u, this.base);
    if (!abs || abs.includes('#') && abs.split('#')[0] === this.base.split('#')[0]) return undefined;
    return linkAct(label || shortUrl(abs, this.base), abs);
  }
  /** `a · b · c` from labelled parts, skipping empty ones. */
  line(parts: (string | Inline | undefined | false)[]): void {
    const out: Inline[] = [];
    for (const p of parts) {
      if (!p) continue;
      if (out.length) out.push(' · ');
      out.push(p);
    }
    if (out.length) this.em.add('p', out);
  }
  body(text: string, max = 20_000): void {
    const t = looksHtml(text) ? htmlText(text) : text;
    if (t.length > 60) this.shown.add(squash(t).slice(0, 200));
    const capped = t.length > max ? t.slice(0, max) : t;
    for (const para of capped.split(/\n\s*\n|\n/)) emitParagraph(this.em, para);
    if (t.length > max) this.em.text(`… (${t.length} chars in all)`);
  }
  desc(v: J | undefined, max = 2000): void {
    const s = this.str(v);
    if (!s) return;
    this.shown.add(s.slice(0, 200));
    emitParagraph(this.em, trunc(s, max));
  }

  collect(v: J | undefined, out: Node[]): void {
    if (Array.isArray(v)) for (const x of v) this.collect(x, out);
    else if (isObj(v)) {
      if (Array.isArray(v['@graph'])) this.collect(v['@graph'], out);
      if (typeof v['@id'] === 'string' && !this.ids.has(v['@id'])) this.ids.set(v['@id'], v);
      if (v['@type']) out.push(v);
    }
  }

  render(blobs: J[]): void {
    const nodes: Node[] = [];
    for (const b of blobs) this.collect(b, nodes);
    // pages wrapping their entity: WebPage.mainEntity → the entity
    for (const n of [...nodes]) {
      if (!typesOf(n).every((t) => BOILERPLATE.has(t))) continue; // FAQPage, QAPage render their own entities
      const me = this.resolve(n.mainEntity);
      if (isObj(me) && me['@type'] && !nodes.includes(me)) nodes.push(me);
      if (Array.isArray(me)) for (const m of me) if (isObj(m) && m['@type'] && !nodes.includes(m)) nodes.push(m);
    }
    const crumbs: Node[] = [];
    const done = new Set<Node>();
    // nodes referenced from other nodes (offers, authors) are rendered by their parents
    const main = nodes.filter((n) => {
      const ts = typesOf(n);
      if (ts.includes('breadcrumblist')) {
        crumbs.push(n);
        return false;
      }
      return !ts.every((t) => BOILERPLATE.has(t)) || (ts.includes('person') && nodes.length === 1);
    });
    for (const n of main) {
      if (done.has(n)) continue;
      done.add(n);
      const before = this.em.blocks.length;
      this.node(n);
      if (this.em.blocks.length - before > 1) {
        this.substantive = true;
        const raw = Array.isArray(n['@type']) ? n['@type'][0] : n['@type'];
        if (typeof raw === 'string') this.types.push(raw.replace(/^.*[/#:]/, ''));
      }
    }
    for (const c of crumbs) this.breadcrumbs(c);
  }

  node(n: Node): void {
    const ts = typesOf(n);
    const t = ts.find((x) => !BOILERPLATE.has(x)) ?? ts[0] ?? '';
    if (ARTICLE.test(t)) return this.article(n);
    if (PRODUCT.test(t)) return this.product(n);
    if (t === 'recipe') return this.recipe(n);
    if (t === 'faqpage') return this.faq(n);
    if (t === 'qapage' || t === 'question') return this.qa(n);
    if (t === 'itemlist' || t === 'howto') return t === 'howto' ? this.howto(n) : this.itemList(n, 2);
    if (/event$/.test(t)) return this.event(n);
    if (t === 'jobposting') return this.job(n);
    if (n.address || n.telephone || n.openingHours || n.openingHoursSpecification) return this.place(n);
    this.generic(n, t);
  }

  heading(n: Node, lv = 1): string {
    const name = this.str(n.headline ?? n.name ?? n.title);
    if (name) {
      this.em.h(name, lv);
      if (!this.title) this.title = name;
    }
    return name;
  }

  date(v: J | undefined): string {
    const s = this.str(v);
    return /^\d{4}-\d\d-\d\dT/.test(s) ? s.slice(0, 10) : s;
  }

  article(n: Node): void {
    this.heading(n);
    const by = this.names(n.author ?? n.creator);
    const pub = this.date(n.datePublished ?? n.dateCreated);
    const mod = this.date(n.dateModified);
    this.line([by && 'by ' + by, pub && 'published ' + pub, mod && mod !== pub && 'updated ' + mod, this.names(n.publisher)]);
    const section = this.str(n.articleSection);
    const kw = Array.isArray(n.keywords) ? n.keywords.map((k) => this.str(k)).join(', ') : this.str(n.keywords);
    this.line([section && 'section: ' + section, kw && 'keywords: ' + trunc(kw, 200)]);
    const body = this.str(n.articleBody ?? n.text);
    const d = this.str(n.description ?? n.abstract);
    if (d && !body.startsWith(d.slice(0, 60))) this.desc(d);
    if (body) this.body(typeof n.articleBody === 'string' ? n.articleBody : typeof n.text === 'string' ? n.text : body);
    const comments = this.arr(n.comment);
    if (comments.length) {
      this.em.h(`Comments (${this.str(n.commentCount) || comments.length})`, 2);
      const g = this.em.group();
      this.em.row([['author'], ['date'], ['text']], g, true);
      for (const c of comments.slice(0, 50)) this.em.row([[this.names(c.author)], [this.date(c.datePublished ?? c.dateCreated)], [trunc(this.str(c.text), 300)]], g);
    }
  }

  arr(v: J | undefined): Node[] {
    v = this.resolve(v);
    const a = Array.isArray(v) ? v : v ? [v] : [];
    return a.map((x) => this.resolve(x)).filter(isObj) as Node[];
  }

  offer(o: Node): string {
    const cur = this.str(o.priceCurrency ?? (isObj(o.priceSpecification) ? o.priceSpecification.priceCurrency : undefined));
    const spec = isObj(o.priceSpecification) ? o.priceSpecification : undefined;
    let price = this.str(o.price ?? spec?.price);
    const lo = this.str(o.lowPrice);
    const hi = this.str(o.highPrice);
    if (!price && lo) price = hi && hi !== lo ? `${lo}–${hi}` : lo;
    return price ? `${price}${cur ? ' ' + cur : ''}` : '';
  }
  enumName(v: J | undefined): string {
    return this.str(v).replace(/^https?:\/\/schema\.org\//i, '').replace(/^schema:/, '');
  }

  rating(v: J | undefined): string {
    const r = this.resolve(v);
    if (!isObj(r)) return '';
    const val = this.str(r.ratingValue);
    if (!val) return '';
    const best = this.str(r.bestRating) || '5';
    const cnt = this.str(r.reviewCount ?? r.ratingCount);
    return `rating ${val}/${best}${cnt ? ` (${cnt} ratings)` : ''}`;
  }

  product(n: Node): void {
    this.heading(n);
    const ids: string[] = [];
    for (const k of ['brand', 'manufacturer', 'model', 'sku', 'mpn', 'gtin', 'gtin13', 'gtin12', 'gtin8', 'isbn', 'color', 'material', 'size', 'category']) {
      const s = k === 'brand' || k === 'manufacturer' ? this.names(n[k]) : this.str(n[k]);
      if (s && s.length < 120) ids.push(`${k}: ${s}`);
    }
    this.line(ids.slice(0, 8));
    const isAgg = (o: Node) => typesOf(o).includes('aggregateoffer');
    const top = this.arr(n.offers);
    const agg = top.find(isAgg);
    const list = [...top.filter((o) => !isAgg(o)), ...(agg ? this.arr(agg.offers) : [])];
    const head = agg ?? list[0];
    if (head) {
      const cnt = agg ? this.str(agg.offerCount) : '';
      this.line([
        'price ' + (this.offer(head) || '?') + (cnt ? ` (${plural(Number(cnt) || 0, 'offer')})` : ''),
        this.enumName(head.availability),
        !!head.itemCondition && this.enumName(head.itemCondition).replace(/Condition$/, ''),
        this.names(head.seller) && 'seller ' + this.names(head.seller),
        this.str(head.priceValidUntil) && 'until ' + this.str(head.priceValidUntil),
        list.length <= 1 && this.link(head.url, 'buy'),
      ]);
    }
    if (list.length > 1) {
      const g = this.em.group();
      this.em.row([['offer'], ['price'], ['availability'], ['seller']], g, true);
      for (const o of list.slice(0, 30)) {
        const label = this.str(o.name) || this.str(o.sku) || 'offer';
        this.em.row([[this.link(o.url, label) ?? label], [this.offer(o)], [this.enumName(o.availability)], [this.names(o.seller)]], g);
      }
    }
    const rating = this.rating(n.aggregateRating);
    if (rating) this.em.text(rating);
    this.desc(n.description);
    const variants = this.arr(n.hasVariant);
    if (variants.length) {
      this.em.h(`Variants (${variants.length})`, 2);
      const g = this.em.group();
      this.em.row([['name'], ['sku'], ['price'], ['availability']], g, true);
      for (const v of variants.slice(0, 50)) {
        const o = this.arr(v.offers)[0];
        this.em.row([[this.str(v.name)], [this.str(v.sku)], [o ? this.offer(o) : ''], [o ? this.enumName(o.availability) : '']], g);
      }
    }
    const props = this.arr(n.additionalProperty);
    if (props.length) this.line(props.slice(0, 20).map((p) => `${this.str(p.name)}: ${this.str(p.value)}`));
    this.reviews(n.review);
  }

  reviews(v: J | undefined): void {
    const rs = this.arr(v);
    if (!rs.length) return;
    this.em.h(`Reviews (${rs.length})`, 2);
    const g = this.em.group();
    this.em.row([['rating'], ['author'], ['date'], ['review']], g, true);
    for (const r of rs.slice(0, 20)) {
      const rr = this.resolve(r.reviewRating);
      const text = [this.str(r.name), this.str(r.reviewBody ?? r.description)].filter(Boolean).join(': ');
      this.em.row([[isObj(rr) ? this.str(rr.ratingValue) : ''], [this.names(r.author)], [this.date(r.datePublished)], [trunc(text, 300)]], g);
    }
  }

  dur(v: J | undefined): string {
    const s = this.str(v);
    const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(s);
    if (!m || !s) return s;
    const parts = [m[1] && m[1] + 'd', m[2] && m[2] + 'h', m[3] && m[3] + 'm', m[4] && m[4] + 's'].filter(Boolean);
    return parts.join(' ') || s;
  }

  recipe(n: Node): void {
    this.heading(n);
    const nut = this.resolve(n.nutrition);
    this.line([
      this.names(n.author) && 'by ' + this.names(n.author),
      this.dur(n.prepTime) && 'prep ' + this.dur(n.prepTime),
      this.dur(n.cookTime) && 'cook ' + this.dur(n.cookTime),
      this.dur(n.totalTime) && 'total ' + this.dur(n.totalTime),
      this.str(n.recipeYield) && 'yield ' + this.str(Array.isArray(n.recipeYield) ? n.recipeYield[0] : n.recipeYield),
      isObj(nut) && this.str(nut.calories),
      this.rating(n.aggregateRating),
    ]);
    this.line([this.str(n.recipeCuisine), this.str(n.recipeCategory), this.str(n.keywords) && trunc(this.str(n.keywords), 150)]);
    this.desc(n.description);
    const ing = n.recipeIngredient ?? n.ingredients;
    const ings = (Array.isArray(ing) ? ing : ing ? [ing] : []).map((x) => this.str(x)).filter(Boolean);
    if (ings.length) {
      this.em.h('Ingredients', 2);
      for (const x of ings) this.em.text(x, 'li', { lv: 1 });
    }
    this.steps(n.recipeInstructions, 'Instructions');
    this.reviews(n.review);
  }

  steps(v: J | undefined, title: string): void {
    v = this.resolve(v);
    if (isEmpty(v ?? null)) return;
    this.em.h(title, 2);
    let k = 1;
    const walk = (x: J | undefined) => {
      x = this.resolve(x);
      if (typeof x === 'string') {
        for (const s of (looksHtml(x) ? htmlText(x) : x).split(/\n+/).map(squash).filter(Boolean)) this.em.text(s, 'li', { lv: 1, ord: k++ });
      } else if (Array.isArray(x)) for (const y of x) walk(y);
      else if (isObj(x)) {
        const ts = typesOf(x);
        if (ts.includes('howtosection')) {
          const nm = this.str(x.name);
          if (nm) this.em.h(nm, 3);
          walk(x.itemListElement ?? x.steps);
        } else {
          const s = this.str(x.text ?? x.name ?? x.description);
          if (s) this.em.text(s, 'li', { lv: 1, ord: k++ });
          if (x.itemListElement) walk(x.itemListElement);
        }
      }
    };
    walk(v);
  }

  howto(n: Node): void {
    this.heading(n);
    this.line([this.dur(n.totalTime) && 'total ' + this.dur(n.totalTime), this.str(n.estimatedCost) && 'cost ' + this.str(n.estimatedCost)]);
    this.desc(n.description);
    const supply = this.arr(n.supply).map((s) => this.str(s)).concat(this.arr(n.tool).map((s) => this.str(s))).filter(Boolean);
    if (supply.length) this.em.text('you need: ' + supply.join(', '));
    this.steps(n.step, 'Steps');
  }

  faq(n: Node): void {
    const name = this.str(n.name ?? n.headline);
    this.em.h(name || 'FAQ', 1);
    if (!this.title) this.title = name || 'FAQ';
    for (const q of this.arr(n.mainEntity)) {
      const qs = this.str(q.name ?? q.text);
      if (!qs) continue;
      this.em.h(qs, 3);
      const a = this.arr(q.acceptedAnswer ?? q.suggestedAnswer)[0];
      if (a) this.body(typeof a.text === 'string' ? a.text : this.str(a.text), 4000);
    }
  }

  qa(n: Node): void {
    const q = typesOf(n).includes('question') ? n : this.arr(n.mainEntity)[0] ?? n;
    this.heading(q);
    this.line([this.names(q.author) && 'asked by ' + this.names(q.author), this.date(q.dateCreated ?? q.datePublished), this.str(q.answerCount) && plural(Number(q.answerCount) || 0, 'answer'), this.str(q.upvoteCount) && this.str(q.upvoteCount) + ' votes']);
    const qt = this.str(q.text);
    if (qt && qt !== this.str(q.name)) this.body(typeof q.text === 'string' ? q.text : qt, 4000);
    const answers = [...this.arr(q.acceptedAnswer).map((a) => ({ a, acc: true })), ...this.arr(q.suggestedAnswer).map((a) => ({ a, acc: false }))];
    for (const { a, acc } of answers.slice(0, 10)) {
      this.em.h(`${acc ? 'Accepted answer' : 'Answer'}${this.str(a.upvoteCount) ? ` (${this.str(a.upvoteCount)} votes)` : ''}${this.names(a.author) ? ' by ' + this.names(a.author) : ''}`, 3);
      this.body(typeof a.text === 'string' ? a.text : this.str(a.text), 3000);
    }
  }

  itemList(n: Node, lv: number): void {
    const items = this.arr(n.itemListElement).sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
    if (!items.length) return;
    const name = this.str(n.name);
    this.em.h(`${name || 'Items'} (${this.str(n.numberOfItems) || items.length})`, lv);
    if (!this.title && name) this.title = name;
    const rows = items.map((li) => {
      const it = this.resolve(li.item);
      const obj = isObj(it) ? it : li;
      const label = this.str(obj.name ?? li.name ?? obj.headline) || this.str(li.url ?? (typeof it === 'string' ? it : ''));
      const href = typeof it === 'string' ? it : (obj.url ?? li.url ?? obj['@id']);
      const offer = this.arr(obj.offers)[0];
      const extra = [offer && this.offer(offer), this.rating(obj.aggregateRating), this.date(obj.datePublished)].filter(Boolean).join(' · ');
      return { pos: this.str(li.position), cell: this.link(href, label) ?? label, extra };
    });
    const hasExtra = rows.some((r) => r.extra);
    const g = this.em.group();
    this.em.row(hasExtra ? [['#'], ['item'], ['details']] : [['#'], ['item']], g, true);
    for (const r of rows.slice(0, 200)) this.em.row(hasExtra ? [[r.pos], [r.cell], [r.extra]] : [[r.pos], [r.cell]], g);
  }

  address(v: J | undefined): string {
    const a = this.resolve(v);
    if (!isObj(a)) return this.str(a);
    return [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry].map((x) => this.str(x)).filter(Boolean).join(', ');
  }

  placeText(v: J | undefined): string {
    const out: string[] = [];
    for (const p of this.arr(v)) {
      const t = typesOf(p);
      if (t.includes('virtuallocation')) out.push('online' + (typeof p.url === 'string' ? ' ' + shortUrl(p.url, this.base) : ''));
      else out.push([this.str(p.name), this.address(p.address)].filter(Boolean).join(', '));
    }
    if (!out.length && typeof v === 'string') out.push(v);
    return out.filter(Boolean).join('; ');
  }

  event(n: Node): void {
    this.heading(n);
    const start = this.str(n.startDate);
    const end = this.str(n.endDate);
    const status = this.enumName(n.eventStatus).replace(/^Event/, '');
    const mode = this.enumName(n.eventAttendanceMode).replace(/EventAttendanceMode$/, '').toLowerCase();
    this.line([start && (end && end !== start ? `${start} – ${end}` : start), status && status !== 'Scheduled' && status, mode && mode]);
    const loc = this.placeText(n.location);
    if (loc) this.em.text('location: ' + loc);
    const offer = this.arr(n.offers)[0];
    if (offer) this.line(['tickets ' + (this.offer(offer) || '?'), this.enumName(offer.availability), this.link(offer.url, 'tickets')]);
    this.line([this.names(n.performer) && 'performer: ' + this.names(n.performer), this.names(n.organizer) && 'organizer: ' + this.names(n.organizer)]);
    this.desc(n.description);
  }

  job(n: Node): void {
    this.heading(n);
    const remote = /telecommute/i.test(this.str(n.jobLocationType)) ? 'remote' : '';
    const sal = this.resolve(n.baseSalary);
    let salary = '';
    if (isObj(sal)) {
      const v = this.resolve(sal.value);
      const amt = isObj(v) ? (v.minValue !== undefined || v.maxValue !== undefined ? [this.str(v.minValue), this.str(v.maxValue)].filter(Boolean).join('–') : this.str(v.value)) : this.str(v);
      const unit = isObj(v) ? this.str(v.unitText) : '';
      salary = amt ? `salary ${amt} ${this.str(sal.currency)}${unit ? '/' + unit.toLowerCase() : ''}`.replace(/\s+\//, '/') : '';
    }
    this.line([this.names(n.hiringOrganization), this.placeText(n.jobLocation) || this.str(n.applicantLocationRequirements && this.names(n.applicantLocationRequirements)), remote, this.str(n.employmentType).toLowerCase().replace(/_/g, ' '), salary]);
    this.line([this.date(n.datePosted) && 'posted ' + this.date(n.datePosted), this.date(n.validThrough) && 'apply by ' + this.date(n.validThrough), this.link(n.url, 'apply')]);
    if (n.description) this.body(typeof n.description === 'string' ? n.description : this.str(n.description), 6000);
  }

  place(n: Node): void {
    this.heading(n, 1);
    this.line([this.address(n.address), this.str(n.telephone), this.str(n.email), this.str(n.priceRange) && 'price ' + this.str(n.priceRange), this.rating(n.aggregateRating)]);
    const hours: string[] = [];
    for (const h of Array.isArray(n.openingHours) ? n.openingHours : n.openingHours ? [n.openingHours] : []) hours.push(this.str(h));
    for (const s of this.arr(n.openingHoursSpecification)) {
      const days = (Array.isArray(s.dayOfWeek) ? s.dayOfWeek : [s.dayOfWeek]).map((d) => this.enumName(d as J).slice(0, 3)).filter(Boolean).join(',');
      hours.push(`${days} ${this.str(s.opens)}–${this.str(s.closes)}`);
    }
    if (hours.length) this.em.text('hours: ' + hours.join('; '));
    const url = this.link(n.url);
    const same = (Array.isArray(n.sameAs) ? n.sameAs : n.sameAs ? [n.sameAs] : []).filter((x) => typeof x === 'string').slice(0, 6).map((x) => this.link(x)).filter(Boolean) as Inline[];
    if (url || same.length) this.line([url, ...same]);
    this.desc(n.description);
    this.reviews(n.review);
  }

  generic(n: Node, t: string): void {
    const clean: JObj = {};
    for (const [k, v] of Object.entries(n)) {
      if (k.startsWith('@') || /^(image|logo|thumbnailUrl|potentialAction|isPartOf|mainEntityOfPage|inLanguage|publisher|copyrightHolder)$/.test(k)) continue;
      clean[k] = v;
    }
    const name = this.str(n.name ?? n.headline);
    if (!name && Object.keys(clean).length < 3) return;
    this.em.h(name ? name : t, 1);
    if (name && !this.title) this.title = name;
    delete clean.name;
    delete clean.headline;
    new JsonWriter(this.em, { mainRows: 50 }).object(clean, '', 1, false);
  }

  breadcrumbs(n: Node): void {
    const items = this.arr(n.itemListElement).sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
    const out: Inline[] = [];
    for (const li of items) {
      const it = this.resolve(li.item);
      const name = this.str(li.name ?? (isObj(it) ? it.name : undefined));
      const href = typeof it === 'string' ? it : isObj(it) ? (it['@id'] ?? it.url) : li.url;
      if (!name) continue;
      if (out.length) out.push(' › ');
      out.push(this.link(href, name) ?? name);
    }
    if (out.length > 1) this.em.add('p', out);
  }
}

// ───────────────────────────── framework payloads ─────────────────────────────

/** Nuxt 3 `__NUXT_DATA__` (devalue's flattened format) → plain value. */
export function devalue(arr: J[]): J {
  const memo = new Map<number, J>();
  const hyd = (i: J): J => {
    if (typeof i !== 'number') return null;
    if (i < 0) return null;
    if (memo.has(i)) return memo.get(i)!;
    const v = arr[i];
    if (v === null || typeof v !== 'object') {
      memo.set(i, v ?? null);
      return v ?? null;
    }
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string') {
        const tag = v[0];
        let out: J;
        if (tag === 'Date' || tag === 'BigInt' || tag === 'RegExp' || tag === 'URL') out = v[1] as J;
        else if (tag === 'Set') out = v.slice(1).map(hyd);
        else if (tag === 'Map') {
          const o: JObj = {};
          for (let k = 1; k + 1 < v.length; k += 2) o[String(hyd(v[k]))] = hyd(v[k + 1]);
          out = o;
        } else if (tag === 'null' || tag === 'Object') {
          const o: JObj = {};
          for (let k = 1; k + 1 < v.length; k += 2) o[String(v[k])] = hyd(v[k + 1]);
          out = o;
        } else out = v.length >= 2 ? hyd(v[1]) : null; // Reactive, ShallowReactive, Ref, EmptyRef, NuxtError, …
        memo.set(i, out);
        return out;
      }
      const out: J[] = [];
      memo.set(i, out);
      for (const x of v) out.push(hyd(x));
      return out;
    }
    const o: JObj = {};
    memo.set(i, o);
    for (const [k, x] of Object.entries(v)) o[k] = hyd(x);
    return o;
  };
  return hyd(0);
}

const isDevalue = (v: J): v is J[] =>
  Array.isArray(v) && v.length > 1 && ((isObj(v[0]) && Object.values(v[0]).every((x) => Number.isInteger(x))) || (Array.isArray(v[0]) && typeof v[0][0] === 'string' && /Reactive|Ref/.test(v[0][0] as string)));

const NOISE_KEY =
  /^(_.*|\$.*|i18n|intl|locales?|localeData|translations?|messages|dictionary|dict|strings|t|l10n|config|configuration|.*Config|settings|featureFlags?|featureToggles|flags|experiments?|abTests?|variants?Config|optimizely|tracking|trackingData|analytics|gtm|dataLayer|ads|adConfig|adSlots|advertising|cookies?|consent|env|runtimeConfig|buildId|assetPrefix|isFallback|gssp|gsp|gip|appGip|scriptLoader|nextExport|autoExport|dynamicIds|defaultLocale|domainLocales|serverRendered|once|_errors|head|headTags|scripts|styles|css|theme|icons?|images?|thumbnails?|srcset|sizes|logo|avatar|placeholder|blurDataURL|svg|sprite|schema|jsonLd|structuredData|csrf.*|token|nonce|sentry.*|err|errors?|statusCode|navigation|nav|menu|menus|footer|header|breadcrumbs?|seo|meta|metadata|layout|session|user|auth|currentUser|viewer|device|ua|userAgent|preview|draftMode|__typename|pageInfo|cursor)$/i;
const IMAGE_URL = /\.(jpe?g|png|gif|webp|avif|svg|ico)(\?|$)|\/(images?|img|media|static)\//i;

/** Prune noise from framework data. `seen` holds long strings JSON-LD already showed. */
function prune(v: J, key: string, depth: number, seen: Set<string>): J | undefined {
  if (depth > 14) return undefined;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return undefined;
    if (/^data:/.test(s)) return undefined;
    if (isUrl(s) && IMAGE_URL.test(s)) return undefined;
    if (s.length > 200 && !/\s/.test(s.slice(0, 200))) return undefined; // encoded blobs, CSS, tokens
    if ((s.startsWith('{') || s.startsWith('[')) && s.length > 40) {
      try {
        const inner = JSON.parse(s);
        return prune(inner, key, depth + 1, seen);
      } catch {}
    }
    const flat = squash(looksHtml(s) ? stripHtml(s) : s);
    if (flat.length > 60 && seen.has(flat.slice(0, 200))) return undefined;
    return looksHtml(s) ? htmlText(s) : s;
  }
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = v.map((x) => prune(x, key, depth + 1, seen)).filter((x) => x !== undefined && !isEmpty(x)) as J[];
    return out.length ? out : undefined;
  }
  // React Query: the data is inside dehydratedState.queries[].state.data
  if (Array.isArray(v.queries) && key === 'dehydratedState') {
    const datas = (v.queries as J[]).map((q) => (isObj(q) && isObj(q.state) ? q.state.data : undefined)).filter((x) => x !== undefined) as J[];
    return prune(datas.length === 1 ? datas[0] : datas, 'queries', depth + 1, seen);
  }
  // Apollo normalized cache: {"Product:1": {...}, ROOT_QUERY: {...}} → {Product: [...]}
  const keys = Object.keys(v);
  if (keys.length >= 2 && keys.filter((k) => /^[A-Z]\w*:./.test(k)).length >= keys.length * 0.6) {
    const by: JObj = {};
    for (const k of keys) {
      const m = /^([A-Z]\w*):./.exec(k);
      if (!m) continue;
      ((by[m[1]] ??= []) as J[]).push(v[k]);
    }
    return prune(by, key, depth + 1, seen);
  }
  const vals = Object.values(v);
  // feature-flag maps and translation dictionaries
  if (keys.length >= 8 && vals.every((x) => typeof x === 'boolean')) return undefined;
  if (keys.length >= 40 && vals.every((x) => typeof x === 'string' && x.length < 160)) return undefined;
  const out: JObj = {};
  for (const [k, x] of Object.entries(v)) {
    if (NOISE_KEY.test(k)) continue;
    const p = prune(x, k, depth + 1, seen);
    if (p !== undefined && !isEmpty(p)) out[k] = p;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Characters of human-readable content in a value. */
function weight(v: J): number {
  if (typeof v === 'string') {
    if (isUrl(v)) return 1;
    return /\s/.test(v) || v.length < 40 ? Math.min(v.length, 4000) : 2;
  }
  if (typeof v === 'number') return 2;
  if (v === null || typeof v !== 'object') return 0;
  let n = 0;
  if (Array.isArray(v)) for (const x of v) n += weight(x);
  else for (const k in v) n += weight(v[k]);
  return n;
}

/** Descend while one child holds most of the content. */
function core(v: J, path: string): { v: J; path: string } {
  let cur = v;
  let p = path;
  for (let i = 0; i < 12 && isObj(cur); i++) {
    const total = weight(cur);
    let best: [string, J] | undefined;
    let bw = 0;
    for (const [k, x] of Object.entries(cur)) {
      const w = weight(x);
      if (w > bw) [best, bw] = [[k, x], w];
    }
    if (!best || bw < total * 0.75 || (!isObj(best[1]) && !Array.isArray(best[1]))) break;
    p = p ? p + '.' + best[0] : best[0];
    cur = best[1];
  }
  return { v: cur, path: p };
}

/** Is there real content here: records, prose, or a named entity with several fields? */
function substantive(v: J): boolean {
  const w = weight(v);
  if (w < 120) return false;
  let ok = false;
  const visit = (x: J, d: number) => {
    if (ok || d > 8) return;
    if (typeof x === 'string' && x.length >= 160 && (x.match(/\s/g)?.length ?? 0) >= 20) ok = true;
    else if (Array.isArray(x)) {
      const objs = x.filter(isObj);
      if (objs.length >= 3 && objs.filter((o) => Object.values(o).some((y) => typeof y === 'string' && /\s/.test(y))).length >= 3) ok = true;
      for (const y of x.slice(0, 50)) visit(y, d + 1);
    } else if (isObj(x)) {
      const scalars = Object.entries(x).filter(([, y]) => typeof y === 'string' || typeof y === 'number');
      if (scalars.length >= 3 && scalars.some(([k, y]) => /^(name|title|headline)$/i.test(k) && typeof y === 'string')) ok = true;
      for (const y of Object.values(x)) visit(y, d + 1);
    }
  };
  visit(v, 0);
  return ok;
}

interface Payload {
  label: string;
  value: J;
}

function payloads(doc: Doc): { ld: J[]; data: Payload[] } {
  const ld: J[] = [];
  const data: Payload[] = [];
  for (const b of doc.meta.json) {
    const type = b.type.toLowerCase();
    const v = lenientJson(b.text);
    if (v === undefined) continue;
    if (type.includes('ld+json')) {
      ld.push(v);
      continue;
    }
    if (b.id === '__NEXT_DATA__' && isObj(v)) {
      const props = isObj(v.props) ? v.props : v;
      const pp = isObj(props) && props.pageProps !== undefined ? props.pageProps : props;
      data.push({ label: '__NEXT_DATA__' + (isObj(props) && props.pageProps !== undefined ? ' pageProps' : ''), value: pp });
      continue;
    }
    if (isDevalue(v)) {
      const root = devalue(v);
      data.push({ label: b.id || 'Nuxt payload', value: isObj(root) && root.data !== undefined ? { data: root.data, state: root.state ?? null, pinia: root.pinia ?? null } : root });
      continue;
    }
    if (b.text.length < 80) continue;
    // SvelteKit fetched-data blobs wrap the response body as a string
    if (isObj(v) && typeof v.body === 'string' && v.status !== undefined) {
      const inner = lenientJson(v.body);
      if (inner !== undefined) {
        data.push({ label: b.id || 'fetched data', value: inner });
        continue;
      }
    }
    data.push({ label: b.id || type, value: v });
  }
  return { ld, data };
}

function pickName(v: J): string {
  if (isObj(v)) for (const k of ['name', 'title', 'headline']) if (typeof v[k] === 'string' && (v[k] as string).length < 200) return squash(v[k] as string);
  return '';
}

/**
 * Recover page content from embedded data (JSON-LD, framework payloads) without running scripts.
 * Returns undefined when nothing substantive is there.
 */
export function mineEmbedded(doc: Doc, url: string): ReadOutput | undefined {
  if (!doc.meta.json.length) return undefined;
  const em = new Emitter(url, FIRST_GROUP);
  const { ld, data } = payloads(doc);
  const notes: string[] = [];
  const r = new LdRenderer(em);
  if (ld.length) {
    r.render(ld);
    if (r.substantive) notes.push(`JSON-LD ${[...new Set(r.types)].join(', ')}`);
    else em.blocks.length = 0; // only boilerplate (WebSite, Organization, breadcrumbs): not content
  }
  let title = r.substantive ? r.title : '';
  // framework payloads, best first
  const cands = data
    .map((p) => {
      const pr = prune(p.value, '', 0, r.shown);
      if (pr === undefined) return undefined;
      const c = core(pr, '');
      return { label: p.label, ...c, w: weight(c.v) };
    })
    .filter((c): c is { label: string; v: J; path: string; w: number } => !!c && substantive(c.v))
    .sort((a, b) => b.w - a.w);
  for (const c of cands.slice(0, 2)) {
    const name = pickName(c.v);
    if (name && !title) title = name;
    const sub = new Emitter(url, 0);
    if (name && !(r.substantive && r.title === name)) sub.h(name, r.substantive ? 2 : 1);
    const v = isObj(c.v) && name ? Object.fromEntries(Object.entries(c.v).filter(([k]) => !/^(name|title|headline)$/i.test(k))) : c.v;
    const leaf = c.path.split('.').pop() ?? '';
    // the entity the page is about first, then by amount of content
    const pageTitle = doc.meta.title.toLowerCase();
    const rank = (_k: string, x: J) => {
      const nm = pickName(x).toLowerCase();
      return (nm && pageTitle.includes(nm) ? 1e9 : 0) + weight(x);
    };
    new JsonWriter(sub, { rank }).value(v, Array.isArray(v) && leaf ? leaf : '', name ? 1 : 0, true);
    if (sub.blocks.length < 2) continue;
    em.adopt(sub.blocks);
    notes.push(`${c.label}${c.path ? ' → ' + c.path : ''}`);
  }
  if (!notes.length) return undefined;
  return { title: title || doc.meta.title, kind: 'html', blocks: em.blocks, notes: ['recovered from embedded data: ' + notes.join('; ')] };
}
