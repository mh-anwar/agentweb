import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readJson, parseJson } from '../src/readers/index.ts';
import { acts, fixture, line, lines, text } from './fixtures/readers/helpers.ts';

const read = (v: unknown, url = 'https://api.example.com/v1/things') => readJson({ url, contentType: 'application/json', text: typeof v === 'string' ? v : JSON.stringify(v) });

test('GitHub search: one table, noise columns dropped, constants pulled out, links relative to their prefix', () => {
  const out = read(fixture('github-search.json'), 'https://api.github.com/search/repositories?q=react');
  const ls = lines(out);
  assert.equal(out.kind, 'json');
  assert.equal(ls[0], 'total_count: 1843211');
  assert.ok(ls.includes('items (30)'));
  const header = out.blocks.find((b) => b.k === 'row' && b.hd)!;
  const cols = header.i.join('').split(' | ');
  assert.ok(cols.length <= 10, 'column cap');
  for (const c of ['full_name', 'description', 'stargazers_count', 'language']) assert.ok(cols.includes(c), `has ${c}`);
  assert.ok(cols.some((c) => c.startsWith('html_url (github.com/')), 'html_url with its prefix named once');
  for (const c of ['node_id', 'owner.avatar_url', 'keys_url', 'git_url', 'name']) assert.ok(!cols.includes(c), `no ${c}`);
  // constant columns once, above the table
  const all = line(out, /^all 30: /)!;
  assert.match(all, /private=false/);
  assert.match(all, /visibility=public/);
  // duplicate and derived columns are named in the note
  const note = line(out, /^not shown: /)!;
  assert.match(note, /watchers_count\(=stargazers_count\)/);
  assert.match(note, /name\(⊂full_name\)/);
  // rows: 30, each with a link to the repo
  const rows = out.blocks.filter((b) => b.k === 'row' && !b.hd);
  assert.equal(rows.length, 30);
  assert.equal(new Set(out.blocks.filter((b) => b.k === 'row').map((b) => b.g)).size, 1);
  const first = lines({ blocks: [rows[0]] })[0];
  assert.match(first, /^vercel\/next\.js \| vercel\/next\.js \| /);
  assert.match(first, /\| 131000 \|/);
  const link = acts({ blocks: [rows[0]] }).find((a) => a.href === 'https://github.com/vercel/next.js');
  assert.ok(link, 'repo link act with absolute href');
  assert.equal(link.l, 'vercel/next.js');
  assert.doesNotMatch(text(out), /\{\/key_id\}|avatars\.githubusercontent/);
});

test('GitHub repo object: key: value lines, flags folded, URL fields grouped under their common prefix', () => {
  const out = read(fixture('github-repo.json'), 'https://api.github.com/repos/octocat/Hello-World');
  assert.equal(out.title, 'octocat/Hello-World');
  const ls = lines(out);
  assert.ok(ls.includes('full_name: octocat/Hello-World'));
  assert.ok(ls.includes('stargazers_count: 2654'));
  assert.ok(ls.includes('topics: octocat, atom, electron, api'));
  assert.ok(ls.includes('license: key=mit, name=MIT License, spdx_id=MIT, url= /licenses/mit , node_id=MDc6TGljZW5zZTEz'.replace(/ +/g, ' ')));
  assert.match(line(out, /^true: /)!, /^true: has_issues, has_downloads.* · false: private, fork/);
  assert.ok(!ls.some((l) => /^mirror_url|^temp_clone_token|^custom_properties/.test(l)), 'null and empty dropped');
  const api = line(out, /^links under \/repos\/octocat\/Hello-World: /)!;
  assert.match(api, /, \/issues\{\/number\}/);
  assert.match(api, /issue_events \/issues\/events/);
  assert.ok(acts(out).some((a) => a.href === 'https://api.github.com/repos/octocat/Hello-World/forks' && a.l === '/forks'));
  assert.ok(ls.includes('owner'));
  assert.ok(ls.includes('login: octocat'));
});

test('npm registry document: versions as a table keyed by version, readme as markdown, maps summarised', () => {
  const out = read(fixture('npm-package.json'), 'https://registry.npmjs.org/tiny-glob-walker');
  const ls = lines(out);
  assert.equal(out.title, 'tiny-glob-walker');
  assert.ok(ls.includes('dist-tags: latest=3.0.0, beta=3.0.0-beta.2'));
  assert.ok(ls.includes('readme'));
  assert.ok(ls.includes('npm install tiny-glob-walker'), 'code block from the README');
  assert.ok(ls.includes('library | ops/sec'), 'README table');
  assert.match(line(out, /^users /)!, /^users \(32, all true\): alice, bob, carol/);
  assert.match(line(out, /^time: 24 entries$/)!, /time/);
  assert.ok(ls.includes('versions (22)'));
  const hd = out.blocks.find((b, i) => b.k === 'row' && b.hd && i > ls.indexOf('versions (22)'))!;
  assert.match(hd.i.join(''), /^version \| main \| scripts\.test/);
  assert.match(line(out, /^all 22: /)!, /name=tiny-glob-walker/);
  assert.ok(ls.some((l) => l.startsWith('3.0.0 | dist/index.cjs | vitest run | >=18')));
  // the readme comes before the 22-row versions table (priority order)
  assert.ok(ls.indexOf('readme') < ls.indexOf('versions (22)'));
});

test('GraphQL: wrapper chains collapse, edges/node unwrap, nested connections become cells', () => {
  const out = read(fixture('graphql-issues.json'), 'https://api.github.com/graphql');
  const ls = lines(out);
  assert.ok(ls.includes('data.repository'));
  assert.ok(ls.includes('pageInfo: hasNextPage=true, endCursor=Y3Vyc29yOnYyOpHOBf3vXA=='));
  const hd = out.blocks.find((b) => b.k === 'row' && b.hd)!;
  assert.match(hd.i.join(''), /^number \| title \| state \| createdAt \| author\.login/);
  assert.ok(ls.some((l) => l.startsWith('340 | Crash when the config file is empty | CLOSED | 2026-01-10T08:00:00Z | alice |') && l.includes('| enhancement, help wanted |')));
  assert.doesNotMatch(text(out), /cursor|__typename/);
});

test('heterogeneous records: union of columns by frequency, nested payloads inline', () => {
  const out = read(fixture('github-events.json'), 'https://api.github.com/repos/octocat/Hello-World/events');
  const ls = lines(out);
  assert.match(ls[0], /^all 6: repo\.id=1296269, repo\.name=octocat\/Hello-World/);
  const hd = out.blocks.find((b) => b.k === 'row' && b.hd)!;
  assert.match(hd.i.join(''), /^id \| type \| actor\.id \| actor\.login/);
  assert.ok(ls.some((l) => /PullRequestEvent \| 104 \| dave .*action=closed, number=1346, pull_request=\{number, title, state, merged, …\}/.test(l)));
  assert.ok(!acts(out).some((a) => /avatars/.test(a.href!)), 'no avatar links');
  assert.match(line(out, /^not shown: /)!, /actor\.avatar_url/);
});

test('deep Kubernetes object: nested sections down to a containers table', () => {
  const out = read(fixture('k8s-deployment.json'), 'https://k8s.example/apis/apps/v1/namespaces/shop/deployments/checkout-api');
  const ls = lines(out);
  assert.ok(ls.includes('kind: Deployment'));
  assert.ok(ls.includes('labels: app=checkout-api, team=payments, tier=backend'));
  assert.ok(ls.includes('spec.template.spec.containers (2)'));
  assert.ok(ls.some((l) => l.startsWith('api | registry.example.com/shop/checkout-api:2.14.3 | http | cpu=1, memory=1Gi | DATABASE_URL, LOG_LEVEL, PAYMENTS_TIMEOUT_MS')));
  assert.ok(ls.some((l) => l.startsWith('Available | True |')));
});

test('anti-hijacking prefixes, JSONP and JSON Lines', () => {
  for (const prefix of [")]}'\n", ")]}',\n", 'while(1);', 'for(;;);', '{}&&']) {
    const p = parseJson(prefix + '{"a":1}');
    assert.deepEqual(p.value, { a: 1 }, prefix);
    assert.ok(p.stripped);
  }
  assert.deepEqual(parseJson('cb_123({"ok":true});').value, { ok: true });
  const jl = read('{"level":"info","msg":"started","ts":"2026-11-05T10:00:00Z"}\n{"level":"warn","msg":"slow request","ts":"2026-11-05T10:00:01Z","ms":812}\n\n{"level":"info","msg":"done","ts":"2026-11-05T10:00:02Z"}\n');
  assert.equal(jl.kind, 'json');
  assert.match(jl.notes![0], /JSON Lines, 3 records/);
  assert.ok(lines(jl).includes('warn | slow request | 2026-11-05T10:00:01Z | 812'));
  const hj = read(")]}'\n[[\"a\",\"b\"],[1,2],[3,4]]");
  assert.deepEqual(lines(hj), ['a | b', '1 | 2', '3 | 4']);
  assert.ok(hj.blocks[0].hd);
});

test('invalid JSON falls back to text with a note', () => {
  const out = read('{"a": 1,, "b": }');
  assert.equal(out.kind, 'text');
  assert.match(out.notes![0], /^invalid JSON/);
  assert.match(text(out), /"a": 1,,/);
});

test('large integers keep their digits; nulls and empties are dropped; long strings note their length', () => {
  const long = 'word '.repeat(400).trim();
  const out = read(`{"id": 1859345769381208064, "name": "x", "gone": null, "empty": "", "none": [], "nothing": {}, "bio": "${long}"}`);
  const ls = lines(out);
  assert.ok(ls.includes('id: 1859345769381208064'));
  assert.ok(!ls.some((l) => /^(gone|empty|none|nothing)/.test(l)));
  const bio = line(out, /^bio: /)!;
  assert.match(bio, /…\(1999 chars\)$/);
  assert.ok(bio.length < 1600);
});

test('column cap lists dropped keys; long cells are truncated with their length', () => {
  const rows = Array.from({ length: 5 }, (_, i) => Object.fromEntries([...Array(16)].map((_, k) => [`f${k}`, `v${i}-${k}`]).concat([['text', 'lorem ipsum dolor sit amet '.repeat(20) + i]])));
  const out = read(rows);
  const hd = out.blocks.find((b) => b.hd)!;
  assert.equal(hd.i.join('').split(' | ').length, 10);
  assert.match(line(out, /^not shown: /)!, /f\d+/);
  assert.ok(lines(out).some((l) => /…\(54\d chars\)/.test(l)));
});

test('URL values become link acts; templates stay text; relative link keys resolve', () => {
  const out = read({ homepage: 'https://example.org/docs', next: '/v1/things?page=2', self_url: '/v1/things/1', tmpl: 'https://api.example.com/x{/id}' });
  const as = acts(out);
  assert.ok(as.some((a) => a.href === 'https://example.org/docs' && a.l === 'example.org/docs'));
  assert.ok(as.some((a) => a.href === 'https://api.example.com/v1/things/1' && a.l === '/v1/things/1'));
  assert.ok(lines(out).includes('next: /v1/things?page=2'), 'non-link keys keep relative text');
  assert.ok(!as.some((a) => a.href?.includes('{')));
});

test('side collections are summarised by shape with their first rows; the dominant one is shown in full', () => {
  const items = Array.from({ length: 240 }, (_, i) => ({ id: i, name: `Item ${i}`, price: i * 1.5, tags: ['a', 'b'] }));
  const log = Array.from({ length: 60 }, (_, i) => ({ at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`, event: 'view', user: `u${i}` }));
  const out = read({ store: 'Main St', items, log });
  const ls = lines(out);
  assert.ok(ls.includes('log: 60 objects {at, event, user}'));
  assert.ok(ls.includes('items (240)'));
  const rows = out.blocks.filter((b) => b.k === 'row' && !b.hd);
  assert.equal(rows.length, 5 + 240);
  assert.ok(ls.includes('… +55 more rows'));
  assert.ok(ls.indexOf('log: 60 objects {at, event, user}') < ls.indexOf('items (240)'));
});

test('sparse heterogeneous records read as one line each', () => {
  const out = read([{ a: 1, b: 2 }, { c: 'x', d: 'y' }, { e: true, f: [1, 2] }, { g: 'z' }]);
  assert.deepEqual(lines(out), ['a=1, b=2', 'c=x, d=y', 'e=true, f=1, 2', 'g=z']);
  assert.ok(out.blocks.every((b) => b.k === 'li'));
});

test('single-key wrapper chains collapse into one dotted heading', () => {
  const out = read({ a: { b: { c: { d: { e: { name: 'deep', size: 3, kind: 'leaf', list: [{ x: 1 }, { x: 2 }] } } } } }, top: 1 });
  const ls = lines(out);
  assert.equal(ls[0], 'top: 1');
  assert.ok(ls.includes('a.b.c.d.e'));
  assert.ok(ls.includes('name: deep'));
});

test('deeply nested branching subtrees are summarised in one line', () => {
  const level = (d: number): Record<string, unknown> =>
    d === 0 ? { leaf: 'yes' } : { title: `level ${d}`, n: d, flag: 'on', extra1: 1, extra2: 2, extra3: 3, extra4: 4, left: level(d - 1), right: level(d - 1) };
  const out = read(level(7));
  const ls = lines(out);
  assert.ok(ls.includes('left.left.left.left.left: title=level 2, n=2, flag=on, extra1=1, extra2=2, extra3=3 (+3 keys)'));
  assert.ok(text(out).length < 20_000);
});

test('scalars and arrays of scalars at the root', () => {
  assert.deepEqual(lines(read('"just a string"')), ['just a string']);
  assert.deepEqual(lines(read('[1,2,3]')), ['1, 2, 3']);
  const many = read(Array.from({ length: 12 }, (_, i) => `name-${i}`));
  assert.equal(many.blocks.length, 12);
  assert.equal(many.blocks[0].k, 'li');
});

test('a long array is still counted: value counts and ranges over all rows, not only the ones shown', () => {
  const status = ['active', 'pending', 'archived'];
  const items = Array.from({ length: 900 }, (_, i) => ({ id: i + 1, name: 'item-' + i.toString(16), status: status[i % 4 === 3 ? 0 : i % 3], score: (i * 7) % 501 }));
  const out = read({ total: 900, items });
  const text = out.blocks.map((b) => b.i.map((x) => (typeof x === 'string' ? x : x.l)).join('')).join('\n');
  const want = status.map((s) => [s, items.filter((x) => x.status === s).length] as const).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s} ${n}`).join(' · ');
  assert.ok(text.includes(`over all 900 rows — id: 1 to 900; status: ${want}; score: 0 to 500`), text.slice(-400));
  // names are all different: no line for them
  assert.doesNotMatch(text, /name: item/);
  // a short array shows every row and needs no summary
  assert.doesNotMatch(read({ items: items.slice(0, 5) }).blocks.map((b) => b.i.join('')).join('\n'), /over all/);
});
