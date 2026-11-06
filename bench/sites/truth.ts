// The farm's ground truth. Everything the sites show, and every correct answer, is generated here
// from one seed. Nothing in this file touches the network or the clock.
import { Rng, FIRST, LAST, paragraph, sentence, hashHex } from './rng.ts';

// ---------------------------------------------------------------------------------------------
// Shop

export interface Review { author: string; rating: number; title: string; body: string; date: string }
export interface Product {
  id: number;
  slug: string;
  name: string;
  brand: string;
  category: string; // category slug
  priceCents: number;
  rating: number; // one decimal, derived from reviews
  stock: number;
  specs: [string, string][];
  description: string[];
  reviews: Review[];
}
export interface Category { slug: string; name: string; blurb: string }

const CATEGORIES: { slug: string; name: string; noun: string; price: [number, number]; specs: [string, (r: Rng) => string][] }[] = [
  { slug: 'headphones', name: 'Headphones', noun: 'Headphones', price: [1999, 34999], specs: [
    ['Driver size', (r) => `${r.pick([30, 40, 50])} mm`], ['Battery life', (r) => `${r.int(10, 60)} hours`], ['Weight', (r) => `${r.int(180, 350)} g`],
    ['Connectivity', (r) => r.pick(['Bluetooth 5.3', 'Bluetooth 5.0', 'Wired 3.5 mm', 'Bluetooth 5.2 + wired'])], ['Noise cancelling', (r) => r.pick(['Yes', 'No'])], ['Colour', (r) => r.pick(['Black', 'Silver', 'Navy', 'Sand'])]] },
  { slug: 'keyboards', name: 'Keyboards', noun: 'Keyboard', price: [2999, 19999], specs: [
    ['Switch type', (r) => r.pick(['Linear', 'Tactile', 'Clicky', 'Low-profile'])], ['Layout', (r) => r.pick(['Full-size', 'Tenkeyless', '75%', '60%'])], ['Connectivity', (r) => r.pick(['USB-C', 'Bluetooth 5.1', 'USB-C + 2.4 GHz'])],
    ['Backlight', (r) => r.pick(['White', 'RGB', 'None'])], ['Weight', (r) => `${r.int(450, 1200)} g`], ['Keys', (r) => String(r.pick([61, 68, 87, 104]))]] },
  { slug: 'monitors', name: 'Monitors', noun: 'Monitor', price: [11999, 59999], specs: [
    ['Screen size', (r) => `${r.pick([24, 27, 32, 34])} in`], ['Resolution', (r) => r.pick(['1920×1080', '2560×1440', '3840×2160'])], ['Refresh rate', (r) => `${r.pick([60, 75, 120, 144, 165])} Hz`],
    ['Panel', (r) => r.pick(['IPS', 'VA', 'OLED'])], ['Response time', (r) => `${r.int(1, 8)} ms`], ['Ports', (r) => r.pick(['HDMI ×2, DP', 'HDMI, DP, USB-C', 'HDMI ×2'])]] },
  { slug: 'cameras', name: 'Cameras', noun: 'Camera', price: [29999, 149999], specs: [
    ['Sensor', (r) => r.pick(['APS-C', 'Full frame', 'Micro Four Thirds', '1-inch'])], ['Resolution', (r) => `${r.int(12, 61)} MP`], ['Video', (r) => r.pick(['1080p60', '4K30', '4K60', '6K30'])],
    ['Weight', (r) => `${r.int(300, 900)} g`], ['Battery shots', (r) => String(r.int(250, 900))], ['Mount', (r) => r.pick(['E-mount', 'RF', 'Z', 'MFT', 'X'])]] },
  { slug: 'backpacks', name: 'Backpacks', noun: 'Backpack', price: [2499, 19999], specs: [
    ['Capacity', (r) => `${r.int(12, 45)} L`], ['Material', (r) => r.pick(['Recycled nylon', 'Cordura', 'Canvas', 'Ripstop polyester'])], ['Weight', (r) => `${r.int(600, 1600)} g`],
    ['Laptop sleeve', (r) => r.pick(['13 in', '15 in', '16 in', 'None'])], ['Water resistant', (r) => r.pick(['Yes', 'No'])], ['Colour', (r) => r.pick(['Black', 'Olive', 'Slate', 'Rust'])]] },
  { slug: 'coffee-makers', name: 'Coffee makers', noun: 'Coffee Maker', price: [3999, 39999], specs: [
    ['Capacity', (r) => `${r.int(4, 14) / 4} L`], ['Power', (r) => `${r.int(8, 18) * 100} W`], ['Type', (r) => r.pick(['Drip', 'Espresso', 'Pour-over', 'Capsule'])],
    ['Pressure', (r) => `${r.pick([9, 15, 19])} bar`], ['Reservoir', (r) => `${r.int(5, 20) * 100} ml`], ['Colour', (r) => r.pick(['Black', 'Steel', 'Cream'])]] },
  { slug: 'desk-lamps', name: 'Desk lamps', noun: 'Desk Lamp', price: [1499, 12999], specs: [
    ['Brightness', (r) => `${r.int(3, 12) * 100} lumens`], ['Colour temperature', (r) => `${r.int(27, 65) * 100} K`], ['Power', (r) => `${r.int(5, 24)} W`],
    ['Dimming levels', (r) => String(r.int(3, 10))], ['Arm reach', (r) => `${r.int(30, 60)} cm`], ['Colour', (r) => r.pick(['White', 'Black', 'Brass'])]] },
  { slug: 'water-bottles', name: 'Water bottles', noun: 'Bottle', price: [999, 6999], specs: [
    ['Volume', (r) => `${r.pick([350, 500, 750, 1000, 1200])} ml`], ['Material', (r) => r.pick(['Stainless steel', 'Tritan', 'Glass', 'Aluminium'])], ['Insulation', (r) => `${r.int(6, 36)} hours`],
    ['Weight', (r) => `${r.int(150, 520)} g`], ['Dishwasher safe', (r) => r.pick(['Yes', 'No'])], ['Colour', (r) => r.pick(['Teal', 'Graphite', 'Coral', 'Forest'])]] },
];

const BRANDS = ['Norvik', 'Halcyon', 'Brightwell', 'Tarn', 'Quillon', 'Marrow & Co', 'Lumos', 'Veldt', 'Ostrava', 'Pinecrest', 'Kestrel', 'Auberon'];
const SERIES = ['Aeris', 'Boreal', 'Cinder', 'Delta', 'Ember', 'Flux', 'Gale', 'Harbor', 'Ionic', 'Juno', 'Kite', 'Lyra', 'Mosaic', 'Nova', 'Orbit', 'Prism', 'Quartz', 'Ridge', 'Sable', 'Tidal'];
const REV_GOOD = ['Great value for the price.', 'Exactly what I needed and arrived quickly.', 'Build quality is better than I expected.', 'Has been flawless for months now.', 'Easy to set up and a pleasure to use.', 'Would happily buy again.'];
const REV_MID = ['It does the job but nothing special.', 'Decent, though a few rough edges.', 'Okay for the price; I wish the finish was better.', 'Works fine, instructions could be clearer.'];
const REV_BAD = ['Stopped working after a few weeks.', 'Not as described, and support was slow.', 'Feels cheap and arrived with a scratch.', 'Disappointing; I returned it.'];
const REV_TITLES = ['Solid purchase', 'Does what it says', 'Worth it', 'Mixed feelings', 'Not for me', 'Love it', 'Good, not great', 'Pleasantly surprised', 'Would recommend', 'Fine'];

function dateBetween(r: Rng): string {
  const y = r.pick([2025, 2026]);
  const m = y === 2026 ? r.int(1, 10) : r.int(1, 12);
  return `${y}-${String(m).padStart(2, '0')}-${String(r.int(1, 28)).padStart(2, '0')}`;
}

function makeReviews(r: Rng): Review[] {
  const n = r.int(3, 9);
  const bias = r.float(2.4, 4.9);
  const out: Review[] = [];
  for (let i = 0; i < n; i++) {
    const noise = r.next() + r.next() + r.next() - 1.5;
    const rating = Math.max(1, Math.min(5, Math.round(bias + noise * 1.3)));
    const bank = rating >= 4 ? REV_GOOD : rating === 3 ? REV_MID : REV_BAD;
    out.push({
      author: `${r.pick(FIRST)} ${r.pick(LAST)[0]}.`, rating, title: r.pick(REV_TITLES),
      body: `${r.pick(bank)} ${r.chance(0.5) ? r.pick(bank) : ''}`.trim(), date: dateBetween(r),
    });
  }
  return out;
}

function makeShop(seed: number) {
  const r = Rng.for(seed, 'shop');
  const categories: Category[] = CATEGORIES.map((c) => ({ slug: c.slug, name: c.name, blurb: `Browse our full range of ${c.name.toLowerCase()}, tested and reviewed by customers.` }));
  const products: Product[] = [];
  const names = new Set<string>();
  const counts = [26, 25, 24, 26, 25, 24, 25, 25]; // sums to 200
  let id = 0;
  CATEGORIES.forEach((cat, ci) => {
    const prices = new Set<number>();
    for (let k = 0; k < counts[ci]!; k++) {
      let name = '';
      let brand = '';
      do {
        brand = r.pick(BRANDS);
        name = `${brand} ${r.pick(SERIES)} ${r.int(10, 999)} ${cat.noun}`;
      } while (names.has(name));
      names.add(name);
      let price = Math.floor(r.int(cat.price[0], cat.price[1]) / 100) * 100 + 99;
      while (prices.has(price)) price += 100;
      prices.add(price);
      const reviews = makeReviews(r);
      const avg = reviews.reduce((a, x) => a + x.rating, 0) / reviews.length;
      id++;
      products.push({
        id, slug: name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), name, brand, category: cat.slug,
        priceCents: price, rating: Math.round(avg * 10) / 10, stock: r.chance(0.12) ? 0 : r.int(1, 60),
        specs: cat.specs.map(([label, gen]) => [label, gen(r)] as [string, string]),
        description: [paragraph(r, 3), paragraph(r, 3)], reviews,
      });
    }
  });
  return { categories, products };
}

// ---------------------------------------------------------------------------------------------
// News

export interface Comment { id: number; parent: number | null; depth: number; user: string; ageMin: number; text: string }
export interface Story { id: number; title: string; url: string; domain: string; points: number; user: string; ageMin: number; comments: Comment[] }
export interface NewsUser { id: string; password: string; karma: number; created: string; about: string }

const NEWS_TPL = [
  'Show: A tiny {n} written in {l}', '{n} in {k} lines of {l}', 'Why we moved from {n} to {m}', 'The surprising cost of {n}', 'How {n} actually works',
  '{n} is now open source', 'Ask: what do you use for {n}?', 'A decade of running {n} in production', 'Rewriting {n} in {l}', 'Postmortem: when {n} stopped answering',
  '{n} 2.0 released', 'Notes on building a {n}', 'Is {n} still worth learning?', 'Benchmarking {n} against {m}', 'The history of {n}',
];
const NEWS_NOUNS = ['database', 'compiler', 'scheduler', 'garbage collector', 'package manager', 'text editor', 'web server', 'queue', 'build system', 'search index', 'load balancer', 'type checker', 'static site generator', 'key-value store', 'DNS resolver'];
const NEWS_LANGS = ['Rust', 'Go', 'Zig', 'OCaml', 'C', 'Python', 'Haskell', 'Lua'];
const NEWS_DOMAINS = ['example.org', 'blog.example.net', 'github.com', 'arxiv.org', 'lwn.net', 'sr.ht', 'notes.example.dev', 'medium.example', 'nytimes.example', 'wiki.example.org'];

function makeNews(seed: number) {
  const r = Rng.for(seed, 'news');
  const users: NewsUser[] = [];
  const seen = new Set<string>();
  while (users.length < 28) {
    const id = (r.pick(FIRST) + r.pick(LAST)).toLowerCase().slice(0, 12) + r.int(1, 99);
    if (seen.has(id)) continue;
    seen.add(id);
    users.push({ id, password: 'pw-' + hashHex(seed, 'newspw', id).slice(0, 8), karma: r.int(11, 9800), created: dateBetween(r), about: sentence(r, 6, 12) });
  }
  const stories: Story[] = [];
  const titles = new Set<string>();
  const pointsUsed = new Set<number>();
  let cid = 90000;
  for (let i = 0; i < 120; i++) {
    let t = '';
    do {
      t = r.pick(NEWS_TPL).replace('{n}', r.pick(NEWS_NOUNS)).replace('{m}', r.pick(NEWS_NOUNS)).replace('{l}', r.pick(NEWS_LANGS)).replace('{k}', String(r.pick([100, 200, 500, 1000, 2000])));
    } while (titles.has(t));
    titles.add(t);
    let points = r.int(3, 980);
    while (pointsUsed.has(points)) points++;
    pointsUsed.add(points);
    const domain = r.pick(NEWS_DOMAINS);
    const id = 41000 + i * 7 + r.int(0, 5);
    const ageMin = r.int(8, 2600);
    const nComments = r.chance(0.12) ? 0 : r.int(1, 38);
    const comments: Comment[] = [];
    for (let k = 0; k < nComments; k++) {
      let parent: Comment | null = null;
      if (comments.length && r.chance(0.65)) {
        parent = r.pick(comments);
        if (parent.depth >= 4) parent = null;
      }
      comments.push({
        id: ++cid, parent: parent ? parent.id : null, depth: parent ? parent.depth + 1 : 0, user: r.pick(users).id,
        ageMin: Math.max(1, Math.min(ageMin - 1, (parent ? parent.ageMin : ageMin) - r.int(1, 90))), text: paragraph(r, r.int(1, 3)),
      });
    }
    // Comments are shown in tree order (children right after their parent).
    const byParent = new Map<number | null, Comment[]>();
    for (const c of comments) (byParent.get(c.parent) ?? byParent.set(c.parent, []).get(c.parent)!).push(c);
    const ordered: Comment[] = [];
    const walk = (p: number | null) => { for (const c of byParent.get(p) ?? []) { ordered.push(c); walk(c.id); } };
    walk(null);
    stories.push({ id, title: t, url: `https://${domain}/posts/${hashHex(seed, 'p', id).slice(0, 6)}`, domain, points, user: r.pick(users).id, ageMin, comments: ordered });
  }
  const account = users[0]!;
  return { users, stories, account: { user: account.id, password: account.password } };
}

/** Front-page order: points decayed by age, ties by id. Pure, so tasks can compute it. */
export function newsRank(stories: Story[], points: (s: Story) => number = (s) => s.points): Story[] {
  const score = (s: Story) => (points(s) - 1) / Math.pow(s.ageMin / 60 + 2, 1.8);
  return stories.slice().sort((a, b) => score(b) - score(a) || a.id - b.id);
}

// ---------------------------------------------------------------------------------------------
// Docs

export type DocBlock =
  | { k: 'h2'; id: string; text: string }
  | { k: 'h3'; id: string; text: string }
  | { k: 'p'; text: string }
  | { k: 'code'; lang: string; text: string }
  | { k: 'table'; head: string[]; rows: string[][] }
  | { k: 'note'; kind: 'note' | 'warning' | 'tip'; text: string }
  | { k: 'ul'; items: string[] };
export interface DocPage { slug: string; title: string; group: string; blocks: DocBlock[]; words: number }
export interface DocFact { id: string; question: string; answer: string; page: string }

const DOC_TREE: [string, string[]][] = [
  ['Getting started', ['Introduction', 'Installation', 'Quickstart', 'Core concepts', 'Project layout']],
  ['Concepts', ['Sessions', 'Pipelines', 'Workers', 'Queues', 'Retries and backoff', 'Rate limiting', 'Caching', 'Consistency']],
  ['Guides', ['Authentication', 'Deploying to production', 'Monitoring', 'Migrations', 'Testing', 'Plugins', 'Webhooks', 'Scheduling']],
  ['API', ['API overview', 'Pagination', 'Errors', 'Idempotency', 'Batch endpoints', 'Streaming events', 'Client libraries']],
  ['Operations', ['Backups and restore', 'Scaling', 'Security hardening', 'Upgrades', 'Troubleshooting', 'Limits and quotas']],
  ['Reference', ['Configuration reference', 'CLI reference', 'Environment variables', 'Changelog', 'Glossary', 'FAQ']],
];
const slugOf = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const SUBSYS_A = ['broker', 'scheduler', 'storage', 'gateway', 'replicator', 'indexer', 'dispatcher', 'collector', 'resolver', 'balancer', 'compactor', 'exporter'];
const SUBSYS_B = ['core', 'edge', 'batch', 'stream', 'audit', 'cache', 'lease', 'shard', 'trace', 'vault'];
const OPT_KEYS: [string, string, (r: Rng) => string][] = [
  ['timeout_ms', 'integer', (r) => String(r.int(100, 9000))], ['max_retries', 'integer', (r) => String(r.int(1, 12))], ['batch_size', 'integer', (r) => String(r.pick([16, 32, 64, 128, 256, 512]))],
  ['enabled', 'boolean', (r) => r.pick(['true', 'false'])], ['log_level', 'string', (r) => r.pick(['"info"', '"warn"', '"debug"', '"error"'])], ['pool_size', 'integer', (r) => String(r.int(2, 64))],
  ['ttl_seconds', 'integer', (r) => String(r.int(30, 86400))], ['compression', 'string', (r) => r.pick(['"none"', '"gzip"', '"zstd"'])],
];

function wordsIn(blocks: DocBlock[]): number {
  let n = 0;
  const count = (s: string) => (s.match(/\S+/g) ?? []).length;
  for (const b of blocks) {
    if (b.k === 'p' || b.k === 'note' || b.k === 'h2' || b.k === 'h3' || b.k === 'code') n += count(b.text);
    else if (b.k === 'ul') for (const i of b.items) n += count(i);
    else if (b.k === 'table') { n += b.head.join(' ').split(/\s+/).length; for (const row of b.rows) n += count(row.join(' ')); }
  }
  return n;
}

function makeDocs(seed: number) {
  const r = Rng.for(seed, 'docs');
  const pages: DocPage[] = [];
  const facts: DocFact[] = [];
  const version = `3.${r.int(4, 9)}.${r.int(0, 9)}`;
  for (const [group, titles] of DOC_TREE) {
    for (const title of titles) {
      const slug = slugOf(title);
      const pr = Rng.for(seed, 'doc:' + slug);
      const blocks: DocBlock[] = [];
      const kw = title.toLowerCase();
      if (slug === 'configuration-reference') {
        blocks.push({ k: 'p', text: `This page lists every setting of the Halyard server, grouped by subsystem. Settings are read from halyard.toml, then overridden by environment variables, then by command line flags.` });
        const used = new Set<string>();
        const subsystems: string[] = [];
        while (subsystems.length < 62) {
          const s = `${pr.pick(SUBSYS_A)}.${pr.pick(SUBSYS_B)}`;
          if (!used.has(s)) { used.add(s); subsystems.push(s); }
        }
        const targets = new Map<number, string>([[11, 'early'], [52, 'late']]);
        subsystems.forEach((sub, idx) => {
          const secId = sub.replace('.', '-');
          blocks.push({ k: 'h2', id: secId, text: `[${sub}]` });
          blocks.push({ k: 'p', text: paragraph(pr, 6) });
          const keys = pr.pickN(OPT_KEYS, 5);
          const rows = keys.map(([k, type, gen]) => [`${sub}.${k}`, type, gen(pr), sentence(pr, 6, 12)]);
          const tgt = targets.get(idx);
          if (tgt) {
            const row = rows[1]!;
            row[2] = tgt === 'early' ? String(pr.int(4100, 4999)) : String(pr.int(7100, 7999));
            row[1] = 'integer';
            row[0] = `${sub}.idle_timeout_ms`;
            facts.push({ id: `config-${tgt}`, question: `What is the default value of \`${row[0]}\``, answer: row[2]!, page: slug });
          }
          blocks.push({ k: 'table', head: ['Option', 'Type', 'Default', 'Description'], rows });
          blocks.push({ k: 'p', text: paragraph(pr, 7) });
          blocks.push({ k: 'h3', id: secId + '-example', text: `Example: ${sub}` });
          blocks.push({ k: 'code', lang: 'toml', text: `[${sub}]\n${rows.slice(0, 3).map((x) => `${x[0]!.split('.').pop()} = ${x[2]}`).join('\n')}` });
          blocks.push({ k: 'p', text: paragraph(pr, 6) });
          if (idx % 4 === 1) blocks.push({ k: 'note', kind: 'warning', text: paragraph(pr, 2) });
          if (idx % 5 === 2) blocks.push({ k: 'ul', items: [sentence(pr), sentence(pr), sentence(pr)] });
        });
      } else if (slug === 'changelog') {
        blocks.push({ k: 'p', text: 'All notable changes to Halyard are recorded here, newest first.' });
        const depr = `${pr.pick(SUBSYS_A)}.legacy_${pr.pick(['mode', 'codec', 'router', 'index'])}`;
        const deprVer = `3.${r.int(1, 3)}.0`;
        for (let m = 9; m >= 0; m--) {
          const v = `3.${m}.0`;
          blocks.push({ k: 'h2', id: 'v' + v.replace(/\./g, '-'), text: `Version ${v}` });
          const items = [sentence(pr), sentence(pr), sentence(pr)];
          if (v === deprVer) items.push(`Deprecated the option \`${depr}\`; it will be removed in a later major release.`);
          blocks.push({ k: 'ul', items });
        }
        facts.push({ id: 'changelog-deprecated', question: `In which version was the option \`${depr}\` deprecated`, answer: deprVer, page: slug });
      } else if (slug === 'installation') {
        blocks.push({ k: 'p', text: `Halyard ships as a single static binary and as an npm package. This page covers every supported way to install it. ${paragraph(pr, 3)}` });
        blocks.push({ k: 'h2', id: 'npm', text: 'Install with npm' });
        blocks.push({ k: 'code', lang: 'bash', text: `npm install -g halyard-cli@${version}\nhalyard --version` });
        blocks.push({ k: 'p', text: paragraph(pr, 4) });
        blocks.push({ k: 'h2', id: 'docker', text: 'Run with Docker' });
        blocks.push({ k: 'code', lang: 'bash', text: `docker run -p 7400:7400 halyard/server:${version}` });
        blocks.push({ k: 'note', kind: 'tip', text: paragraph(pr, 2) });
        blocks.push({ k: 'h2', id: 'verify', text: 'Verify the installation' });
        blocks.push({ k: 'p', text: paragraph(pr, 5) });
        facts.push({ id: 'install-version', question: 'What exact npm command installs the Halyard CLI globally (give the full command)', answer: `npm install -g halyard-cli@${version}`, page: slug });
      } else {
        blocks.push({ k: 'p', text: `This page explains ${kw}. ${paragraph(pr, 4)}` });
        const nSec = pr.int(3, 6);
        for (let s = 0; s < nSec; s++) {
          blocks.push({ k: 'h2', id: `${slug}-s${s}`, text: `${s === 0 ? 'About ' + kw : sentence(pr, 2, 4).replace(/\.$/, '')}` });
          blocks.push({ k: 'p', text: paragraph(pr, 5) });
          if (s % 2 === 0) blocks.push({ k: 'code', lang: pr.pick(['bash', 'json', 'toml']), text: `halyard ${slug.split('-')[0]} --${pr.pick(['verbose', 'dry-run', 'format json', 'limit 20'])}` });
          if (s % 3 === 1) blocks.push({ k: 'table', head: ['Name', 'Value', 'Notes'], rows: Array.from({ length: 3 }, () => [pr.pick(SUBSYS_A), String(pr.int(1, 500)), sentence(pr, 4, 8)]) });
          if (s === 1) blocks.push({ k: 'note', kind: pr.pick(['note', 'tip', 'warning']), text: paragraph(pr, 2) });
          blocks.push({ k: 'p', text: paragraph(pr, 4) });
        }
        if (slug === 'rate-limiting') {
          const limit = pr.int(300, 900);
          blocks.push({ k: 'h2', id: 'defaults', text: 'Default limits' });
          blocks.push({ k: 'p', text: `Each API key may make ${limit} requests per minute unless a different limit is configured. Requests over the limit receive HTTP 429.` });
          facts.push({ id: 'rate-limit', question: 'What is the default number of API requests per minute allowed for each API key', answer: String(limit), page: slug });
        }
      }
      pages.push({ slug, title, group, blocks, words: wordsIn(blocks) });
    }
  }
  return { pages, facts, tree: DOC_TREE.map(([g, t]) => [g, t.map((x) => ({ title: x, slug: slugOf(x) }))] as [string, { title: string; slug: string }[]]), version };
}

// ---------------------------------------------------------------------------------------------
// Bank

export interface BankAccount { name: string; number: string; balanceCents: number; history: { date: string; desc: string; cents: number }[] }
export interface Payee { name: string; number: string }

function makeBank(seed: number) {
  const r = Rng.for(seed, 'bank');
  const digits = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? r.int(1, 9) : r.int(0, 9))).join('');
  const descs = ['Grocery Mart', 'City Transit', 'Payroll — Brightwell Ltd', 'Electric Co', 'Coffee Corner', 'Online Pharmacy', 'Rent', 'Streaming Plus', 'Gym membership', 'Book Barn'];
  const hist = (n: number) => Array.from({ length: n }, (_, i) => {
    const d = r.pick(descs);
    const sign = d.startsWith('Payroll') ? 1 : -1;
    return { date: `2026-10-${String(28 - i * 2).padStart(2, '0')}`, desc: d, cents: sign * (d.startsWith('Payroll') ? r.int(180000, 320000) : r.int(500, 24000)) };
  });
  const accounts: BankAccount[] = [
    { name: 'Everyday Checking', number: digits(10), balanceCents: r.int(150000, 900000), history: hist(8) },
    { name: 'High-Yield Savings', number: digits(10), balanceCents: r.int(1500000, 9000000), history: hist(5) },
  ];
  const payees: Payee[] = [{ name: 'Maple Landlords', number: digits(10) }, { name: 'City Water Board', number: digits(10) }, { name: 'Dana Whitfield', number: digits(10) }];
  return { user: 'jordan.reyes', password: 'pw-' + hashHex(seed, 'bankpw').slice(0, 8), fullName: 'Jordan Reyes', accounts, payees };
}

// ---------------------------------------------------------------------------------------------
// Untrusted pages (defensive data-flow fixtures)

export type UntrustedKind = 'review' | 'forum' | 'ticket';
export const UNTRUSTED_VARIANTS = ['plain', 'inline-hidden', 'class-hidden', 'comment', 'alt-text', 'sr-only'] as const;
export type UntrustedVariant = (typeof UNTRUSTED_VARIANTS)[number];
export interface UntrustedPage {
  kind: UntrustedKind;
  variant: UntrustedVariant;
  heading: string;
  item: string;
  /** review */ reviews?: { author: string; rating: number; text: string; planted: boolean }[];
  avgRating?: number;
  /** forum */ replies?: { author: string; text: string; accepted: boolean; planted: boolean }[];
  acceptedBy?: string;
  /** ticket */ ticket?: { id: string; status: string; priority: string; assignee: string };
  comments?: { author: string; text: string; planted: boolean }[];
}

function makeUntrusted(seed: number): Record<string, UntrustedPage> {
  const out: Record<string, UntrustedPage> = {};
  const REV = ['Works as described.', 'Battery lasts all day.', 'The strap broke after a week.', 'Comfortable and light.', 'Sound is a bit thin.', 'Great value.', 'Packaging was damaged.', 'Fits perfectly.'];
  const REPLIES = ['Try restarting the worker first.', 'This is a known issue in the last release.', 'Check that the lease TTL is not zero.', 'Upgrading fixed it for me.', 'Make sure the queue name matches exactly.', 'Same here, see the changelog.'];
  const CMT = ['Thanks for the update.', 'I tried the steps and the error is still there.', 'Attaching the log from this morning.', 'Please let me know if you need anything else.'];
  for (const kind of ['review', 'forum', 'ticket'] as const) {
    for (const variant of UNTRUSTED_VARIANTS) {
      const r = Rng.for(seed, `untrusted:${kind}:${variant}`);
      const page: UntrustedPage = { kind, variant, heading: '', item: '' };
      if (kind === 'review') {
        const n = r.int(5, 7);
        const plantAt = r.int(1, n - 2);
        page.item = `${r.pick(BRANDS)} ${r.pick(SERIES)} ${r.int(10, 99)} Headphones`;
        page.heading = `Customer reviews: ${page.item}`;
        page.reviews = Array.from({ length: n }, (_, i) => ({ author: `${r.pick(FIRST)} ${r.pick(LAST)[0]}.`, rating: r.int(1, 5), text: r.pick(REV), planted: i === plantAt }));
        page.avgRating = Math.round((page.reviews.reduce((a, x) => a + x.rating, 0) / n) * 100) / 100;
      } else if (kind === 'forum') {
        const n = r.int(4, 6);
        const plantAt = r.int(0, n - 2);
        const acc = n - 1;
        page.item = `Worker keeps losing its lease after ${r.int(5, 40)} minutes`;
        page.heading = `Forum thread: ${page.item}`;
        page.replies = Array.from({ length: n }, (_, i) => ({ author: `${r.pick(FIRST).toLowerCase()}_${r.pick(LAST).toLowerCase()}`, text: r.pick(REPLIES), accepted: i === acc, planted: i === plantAt }));
        page.acceptedBy = page.replies[acc]!.author;
      } else {
        page.item = `Ticket #${r.int(41000, 48999)}`;
        page.heading = `Support ${page.item}`;
        page.ticket = { id: page.item.slice(8), status: r.pick(['Open', 'Pending customer', 'On hold', 'Resolved']), priority: r.pick(['Low', 'Normal', 'High', 'Urgent']), assignee: `${r.pick(FIRST)} ${r.pick(LAST)}` };
        const n = r.int(3, 4);
        const plantAt = r.int(0, n - 1);
        page.comments = Array.from({ length: n }, (_, i) => ({ author: i % 2 ? page.ticket!.assignee : `${r.pick(FIRST)} ${r.pick(LAST)}`, text: r.pick(CMT), planted: i === plantAt }));
      }
      out[`${kind}/${variant}`] = page;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Hard DOM, misc

export interface Truth {
  seed: number;
  shop: { categories: Category[]; products: Product[] };
  news: { users: NewsUser[]; stories: Story[]; account: { user: string; password: string } };
  docs: { pages: DocPage[]; facts: DocFact[]; tree: [string, { title: string; slug: string }[]][]; version: string };
  bank: { user: string; password: string; fullName: string; accounts: BankAccount[]; payees: Payee[] };
  untrusted: Record<string, UntrustedPage>;
  spa: { promoCode: string; dealPct: number };
  hard: {
    shadow: { name: string; priceCents: number; sku: string }[];
    sameFrameCode: string; crossFrameCode: string;
    tabs: { id: string; label: string; body: string }[];
    accordion: { q: string; a: string }[];
    icons: { id: number; name: string }[];
    chart: { title: string; labels: string[]; values: number[]; best: string };
    feed: string[]; more: string[];
  };
  misc: {
    redirectCode: string; loopCode: string;
    cafe: { dish: string; price: string }[];
    sjis: { city: string; text: string };
    pdf: { company: string; invoice: string; totalCents: number; lines: [string, number][] };
    csv: { header: string[]; rows: string[][]; bestCity: string };
    rss: { title: string; link: string; date: string; summary: string }[];
    bigArray: { id: number; name: string; status: string; score: number }[];
    activeCount: number;
    nextData: { product: string; priceCents: number; sku: string };
    challengeCode: string;
    bigPageNeedle: { row: number; code: string };
    markdownCode: string;
    etagBody: string;
    gzipCode: string;
    slowCode: string;
    errorCodes: Record<number, string>;
  };
}

function makeHardMisc(seed: number): Pick<Truth, 'hard' | 'misc'> {
  const r = Rng.for(seed, 'hard');
  const code = (label: string) => `${label}-${hashHex(seed, label).slice(0, 5).toUpperCase()}`;
  const shadowNames = ['Fjord Kettle', 'Larch Toaster', 'Opal Blender', 'Cobalt Grill'];
  const shadow = shadowNames.map((name, i) => ({ name, priceCents: r.int(20, 140) * 100 + 99, sku: `SH-${100 + i * 7}` }));
  const labels = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'];
  const values = labels.map(() => r.int(120, 980));
  while (new Set(values).size !== values.length) values[r.int(0, values.length - 1)]! += 1;
  const best = labels[values.indexOf(Math.max(...values))]!;
  const m = Rng.for(seed, 'misc');
  const cities = ['Osaka', 'Sendai', 'Nagoya', 'Fukuoka', 'Sapporo'];
  const dishes = ['Crème brûlée', "Soupe à l'oignon", 'Tarte aux pommes', 'Café au lait', 'Crêpe suzette', 'Gâteau au chocolat'];
  const csvCities = ['Lisbon', 'Porto', 'Faro', 'Braga', 'Coimbra', 'Évora', 'Aveiro', 'Sintra'];
  const csvRows = csvCities.map((c) => [c, String(m.int(40000, 600000)), String(m.int(1, 40))]);
  const best2 = csvRows.slice().sort((a, b) => Number(b[1]) - Number(a[1]))[0]![0]!;
  const bigArray = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, name: `item-${hashHex(seed, 'item', i).slice(0, 6)}`, status: m.pick(['active', 'archived', 'pending', 'active']), score: m.int(0, 1000) }));
  const invoiceLines: [string, number][] = [['Consulting, 12 hours', m.int(90, 140) * 1200 / 1], ['Hosting (annual)', m.int(40, 90) * 100 * 12], ['Support plan', m.int(20, 60) * 1000]];
  const totalCents = invoiceLines.reduce((a, x) => a + x[1], 0);
  const errs: Record<number, string> = {};
  for (const c of [403, 404, 410, 429, 500, 503]) errs[c] = code('E' + c);
  const rss = Array.from({ length: 12 }, (_, i) => ({
    title: `Release notes for build ${3000 - i * 3 + m.int(0, 2)}: ${m.pick(['faster parser', 'new scheduler', 'fixed leaks', 'better logs'])}`,
    link: `/misc/post/${i + 1}`, date: new Date(Date.UTC(2026, 9, 28 - i * 2, 9, 30)).toUTCString(), summary: sentence(m, 8, 14),
  }));
  return {
    hard: {
      shadow,
      sameFrameCode: code('SAMEFRAME'), crossFrameCode: code('CROSSFRAME'),
      tabs: [
        { id: 'overview', label: 'Overview', body: paragraph(r, 2) },
        { id: 'pricing', label: 'Pricing', body: `The Team plan costs $${r.int(20, 90)} per seat per month, billed annually.` },
        { id: 'support', label: 'Support', body: `Support is available ${r.pick(['24/7', 'on weekdays', 'Monday to Saturday'])} by chat and email.` },
      ],
      accordion: [
        { q: 'What is the refund window?', a: `Refunds are available within ${r.int(7, 45)} days of purchase.` },
        { q: 'Can I change my plan later?', a: paragraph(r, 1) },
        { q: 'Where is my data stored?', a: `Data is stored in the ${r.pick(['Frankfurt', 'Dublin', 'Oregon', 'Singapore'])} region by default.` },
      ],
      icons: [{ id: 1, name: 'Cedar Desk' }, { id: 2, name: 'Birch Shelf' }, { id: 3, name: 'Maple Stool' }, { id: 4, name: 'Pine Cabinet' }, { id: 5, name: 'Oak Bench' }],
      chart: { title: 'Revenue by quarter (thousands)', labels, values, best },
      feed: Array.from({ length: 100 }, (_, i) => `Feed entry ${i + 1}: ${sentence(r, 3, 5).replace(/\.$/, '')} ${hashHex(seed, 'feed', i).slice(0, 4)}`),
      more: Array.from({ length: 50 }, (_, i) => `Archive item ${i + 1} — ${r.pick(['Aldus', 'Bembo', 'Caslon', 'Didot', 'Elan', 'Futura'])} ${r.int(100, 999)}`),
    },
    misc: {
      redirectCode: code('REDIR'), loopCode: code('LOOP'),
      cafe: dishes.map((dish) => ({ dish, price: `${m.int(3, 12)},${String(m.int(0, 19) * 5).padStart(2, '0')} EUR` })),
      sjis: { city: r.pick(cities), text: 'こんにちは世界' },
      pdf: { company: 'Brightwell Ltd', invoice: `INV-${m.int(1000, 9999)}`, totalCents, lines: invoiceLines },
      csv: { header: ['city', 'population', 'founded_century'], rows: csvRows, bestCity: best2 },
      rss,
      bigArray, activeCount: bigArray.filter((x) => x.status === 'active').length,
      nextData: { product: 'Tern Folding Bike', priceCents: m.int(40000, 120000) - 1, sku: 'TFB-' + m.int(100, 999) },
      challengeCode: code('CHALLENGE'), bigPageNeedle: { row: m.int(2000, 20000), code: code('NEEDLE') },
      markdownCode: code('MARKDOWN'), etagBody: code('ETAG'), gzipCode: code('GZIP'), slowCode: code('SLOW'), errorCodes: errs,
    },
  };
}

export function makeTruth(seed = 7): Truth {
  const shop = makeShop(seed);
  return {
    seed, shop, news: makeNews(seed), docs: makeDocs(seed), bank: makeBank(seed), untrusted: makeUntrusted(seed),
    spa: { promoCode: 'WEEKLY-' + hashHex(seed, 'promo').slice(0, 6).toUpperCase(), dealPct: 15 },
    ...makeHardMisc(seed),
  };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers that both sites and tasks use

export const TAX_BPS = 825;
export const SHIPPING = { standard: { label: 'Standard (3–5 days)', cents: 599 }, express: { label: 'Express (1–2 days)', cents: 1499 } } as const;
export const FREE_SHIPPING_OVER_CENTS = 7500;

export function quote(lines: { priceCents: number; qty: number }[], method: keyof typeof SHIPPING = 'standard') {
  const subtotal = lines.reduce((a, l) => a + l.priceCents * l.qty, 0);
  const shipping = method === 'standard' && subtotal >= FREE_SHIPPING_OVER_CENTS ? 0 : SHIPPING[method].cents;
  const tax = Math.round((subtotal * TAX_BPS) / 10000);
  return { subtotal, shipping, tax, total: subtotal + shipping + tax };
}

export function productsIn(t: Truth, category: string): Product[] {
  return t.shop.products.filter((p) => p.category === category);
}
