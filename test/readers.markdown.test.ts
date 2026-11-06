import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { readBody, readMarkdown, readText } from '../src/readers/index.ts';
import { acts, fixture, lines } from './fixtures/readers/helpers.ts';

const md = (text: string, url = 'https://widget.dev/docs/config') => readMarkdown({ url, contentType: 'text/markdown', text });

test('Next.js docs (served as markdown): front matter title, headings, lists of links, inline code', async () => {
  const text = readFileSync(new URL('../bench/fixtures/nextjs.html', import.meta.url), 'utf8');
  const out = await readBody({ url: 'https://nextjs.org/docs', contentType: 'text/markdown', text });
  assert.equal(out.kind, 'markdown');
  assert.equal(out.title, 'Next.js Docs');
  const ls = lines(out);
  assert.deepEqual(ls.slice(0, 4), ['Next.js Docs', 'Welcome to the Next.js Documentation.', 'For an index of all documentation, see /docs/llms.txt .', 'What is Next.js?']);
  assert.equal(out.blocks[2].k, 'q');
  assert.ok(ls.includes('Getting Started : Step-by-step tutorials to help you create a new application and learn the core Next.js features.'));
  assert.ok(ls.includes('App Router: The newer router that supports new React features like Server Components.'), 'bold dropped');
  assert.ok(ls.includes("Pages Router: Uses the React version installed in your project's `package.json`."));
  assert.ok(!ls.some((l) => /\*\*|\]\(|^---|lastUpdated/.test(l)), 'no markdown syntax or front matter leaks');
  const as = acts(out);
  assert.ok(as.some((a) => a.l === 'Getting Started' && a.href === 'https://nextjs.org/docs/app/getting-started'));
  assert.ok(as.some((a) => a.l === 'GitHub Discussions' && a.href === 'https://github.com/vercel/next.js/discussions'));
  const h = out.blocks.filter((b) => b.k === 'h');
  assert.equal(h.find((b) => b.i[0] === 'React version handling')!.lv, 3);
});

test('documentation page: nested lists with code, tables, alerts, reference links, HTML, setext, task lists', () => {
  const out = md(fixture('docs-config.md'));
  const ls = lines(out);
  const kinds = out.blocks.map((b) => b.k + (b.lv ?? '') + (b.ord ? '#' + b.ord : ''));
  assert.equal(out.title, 'Configuring the CLI');
  assert.deepEqual(ls.slice(0, 3), ['Configuring the CLI', 'Every option the widget CLI reads, where it reads them from, and in which order.', 'Architecture diagram']);
  // ordered list
  const i1 = ls.indexOf('A `widget.config.ts` file in the project root');
  assert.deepEqual(kinds.slice(i1, i1 + 3), ['li1#1', 'li1#2', 'li1#3']);
  // GitHub alert
  assert.ok(ls.includes('Note: Flags always win. If you set `WIDGET_PORT=3000` and pass `--port 8080`, the server listens on 8080.'));
  assert.equal(out.blocks[ls.indexOf('Note: Flags always win. If you set `WIDGET_PORT=3000` and pass `--port 8080`, the server listens on 8080.')].k, 'q');
  // setext heading and fenced code
  assert.equal(kinds[ls.indexOf('Quick start')], 'h2');
  const code = out.blocks.find((b) => b.k === 'pre')!;
  assert.equal(code.i[0], "import { defineConfig } from 'widget';\n\nexport default defineConfig({\n  port: 8080,\n  plugins: [react()],\n});");
  // table with escaped pipes inside code
  assert.ok(ls.includes('Option | Type | Default | Description'));
  assert.ok(ls.includes("`host` | `string ¦ boolean` | `'localhost'` | Set to `true` to listen on all addresses"));
  assert.ok(acts(out).some((a) => a.l === 'caching' && a.href === 'https://widget.dev/docs/config#caching'));
  // nested list with a code block inside an item, and lazy continuation
  const b = ls.indexOf('Build plugins:');
  assert.deepEqual(kinds.slice(b, b + 5), ['li1', 'li2', 'li2', 'pre', 'li1']);
  assert.equal(ls[b + 4], 'Serve plugins run only in development and may add middleware.');
  assert.equal(ls[b + 5], 'They receive the dev server instance as their second argument.');
  assert.ok(ls.includes('[ ] Document plugin ordering') && ls.includes('[x] Document plugin hooks'));
  const i3 = ls.indexOf('Install the plugin');
  assert.equal(out.blocks[i3].ord, 3);
  // reference links, autolinks, bare URLs
  const cache = acts(out).find((a) => a.l === 'cache guide')!;
  assert.equal(cache.href, 'https://widget.dev/guide/cache');
  assert.equal(acts(out).find((a) => a.l === 'FAQ')!.href, 'https://widget.dev/docs/faq');
  assert.ok(acts(out).some((a) => a.href === 'https://widget.dev/issues'));
  assert.ok(acts(out).some((a) => a.href === 'https://widget.dev/changelog'));
  // indented code, HTML block, comment, emphasis rules
  assert.ok(out.blocks.some((x) => x.k === 'pre' && x.i[0] === 'widget --force   # rebuild ignoring the cache'));
  assert.ok(ls.includes('Advanced: sharing the cache in CI'));
  assert.ok(!ls.some((l) => l.includes('TODO')));
  assert.ok(ls.includes('Snake_case_names and 2 * 3 = 6 stay intact; bold and strike do not. Escaped *stars* stay.'));
});

test('inline edge cases', () => {
  const ls = (s: string) => lines(md(s));
  assert.deepEqual(ls('Use `a | b` and ``code with ` tick``.'), ['Use `a | b` and `code with ` tick`.']);
  assert.deepEqual(ls('[![logo](x.png)](https://example.com/home) and ![](blank.png)'), ['logo and']);
  assert.deepEqual(ls('[link with (parens)](https://en.wikipedia.org/wiki/Foo_(bar)) end'), ['link with (parens) end']);
  assert.equal(acts(md('[w](https://en.wikipedia.org/wiki/Foo_(bar))'))[0].href, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.deepEqual(ls('a <kbd>Ctrl</kbd>+<kbd>K</kbd> b<br>c &amp; &copy; &#x27;q&#x27;'), ["a Ctrl+K b c & © 'q'"]);
  assert.deepEqual(ls('[not a link] and [x]: not a def either'), ['[not a link] and [x]: not a def either']);
  assert.deepEqual(ls('<a href="/docs">Docs</a> here'), ['Docs here']);
  assert.equal(acts(md('<a href="/docs">Docs</a>'))[0].href, 'https://widget.dev/docs');
  assert.equal(acts(md('[x](javascript:alert(1))')).length, 0);
});

test('blocks edge cases: quotes with lists, nested ordered lists, list after paragraph, tilde fences', () => {
  const out = md('> quoted line\n> - item in quote\n\n1. one\n   1. one.a\n   2. one.b\n2. two\n\npara\n- not interrupting? yes it does\n\n~~~python\nprint("x")\n~~~\n\n# Title #\n');
  const got = out.blocks.map((b) => [b.k + (b.lv ?? '') + (b.ord ? '#' + b.ord : ''), lines({ blocks: [b] })[0]]);
  assert.deepEqual(got, [
    ['q', 'quoted line'],
    ['li1', 'item in quote'],
    ['li1#1', 'one'],
    ['li2#1', 'one.a'],
    ['li2#2', 'one.b'],
    ['li1#2', 'two'],
    ['p', 'para'],
    ['li1', 'not interrupting? yes it does'],
    ['pre', 'print("x")'],
    ['h1', 'Title'],
  ]);
});

test('plain text: paragraphs joined, lists, underlined headings, indented code kept', () => {
  const t = `RELEASE NOTES

Version 2.0
===========

This release rewrites the parser. Lines that were
hard-wrapped at 50 columns are joined back into one para-
graph.

  - faster startup
  - smaller binary
    with a continuation line

Example:

    $ widget build --release
    $ widget serve

        nested indent kept
`;
  const out = readText({ url: 'https://x.example/NOTES.txt', contentType: 'text/plain', text: t });
  const got = out.blocks.map((b) => [b.k + (b.lv ?? ''), String(b.i[0])]);
  assert.deepEqual(got, [
    ['h2', 'RELEASE NOTES'],
    ['h1', 'Version 2.0'],
    ['p', 'This release rewrites the parser. Lines that were hard-wrapped at 50 columns are joined back into one paragraph.'],
    ['li1', 'faster startup'],
    ['li1', 'smaller binary with a continuation line'],
    ['p', 'Example:'],
    ['pre', '$ widget build --release\n$ widget serve\n\n    nested indent kept'],
  ]);
});

test('very long paragraphs are split at sentence ends', () => {
  const s = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const out = readText({ url: 'https://x.example/a.txt', contentType: 'text/plain', text: s });
  assert.ok(out.blocks.length >= 2);
  assert.ok(out.blocks.every((b) => String(b.i[0]).length <= 1500 && /\.$/.test(String(b.i[0]))));
});
