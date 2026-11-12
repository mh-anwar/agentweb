// overflow(), audit(), shot(widths=…), expect(console=0 / requests=0 / overflow=0 / audit=0), shot(annotate=1).
// Real Chromium against a small local site; every page below is built to fail one way or pass.

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createAgentweb } from '../src/index.ts';
import { decodePng, encodeGif } from '../src/checks/gif.ts';
import { imageSize, parseWidths } from '../src/checks/shots.ts';
import { parseRules, auditLines, overflowLines } from '../src/checks/report.ts';
import { axeLines, problemLines } from '../src/checks/index.ts';

const page = (title: string, body: string, head = '', lang = ' lang="en"') => `<!doctype html><html${lang}><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0}</style>${head}</head><body>${body}</body></html>`;

const SITE: Record<string, string> = {
  '/overflow': page(
    'Overflow',
    `<main><h1>Schedule</h1>
<p>Intro text that fits.</p>
<table class="schedule" style="width:980px"><tr><td>Mon 9:00</td><td>Tue 10:00</td></tr></table>
<div style="overflow-x:auto;width:100%"><table class="wrapped" style="width:1400px"><tr><td>scrolls inside its wrapper</td></tr></table></div>
<a class="wide" href="/ok" style="display:block;width:900px;margin-left:60px">Book a table now</a>
<div class="cut" style="width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A very long title that cannot fit in its box</div>
</main>`,
  ),
  '/fits': page('Fits', `<main><h1>Fits</h1><p>Everything fits.</p><div style="overflow-x:auto;width:100%"><table style="width:2000px"><tr><td>wrapped</td></tr></table></div></main>`),
  '/a11y': `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1>Shop</h1><h3>Deals</h3>
<img src="/p.png" width="10" height="10">
<img src="/p.png" alt="" width="10" height="10">
<img src="/p.png" role="presentation" width="10" height="10">
<img src="/p.png" alt="Logo" width="10" height="10">
<form><input name="email"><label for="n">Name</label><input id="n" name="n"><input placeholder="Search" name="s"><input aria-label="Zip" name="z"></form>
<button></button><button aria-label="Close">x</button><a href="/ok"><img src="/p.png" alt=""></a><a href="/ok">Home</a>
<p style="color:#bbb;background:#fff">Pale text</p>
<p style="color:#bbb;background:linear-gradient(#fff,#eee)">Over a gradient</p>
<div id="dup">a</div><div id="dup">b</div><label for="dup">uses dup</label>
<div tabindex="3">ordered</div>
<a href="/ok" style="display:inline-block;width:10px;height:10px;background:#000;margin:30px"></a>
<div aria-hidden="true"><a href="/ok">hidden but focusable</a></div>
<main>one</main><main>two</main>
</body></html>`,
  '/clean': page(
    'Clean',
    `<main><h1>Clean</h1><h2>Sub</h2><p style="color:#222;background:#fff">Readable text.</p><img src="/p.png" alt="Logo" width="10" height="10"><label>Email <input name="e"></label><button>Go</button><a href="/ok" style="display:inline-block;padding:12px">Home</a></main>`,
  ),
  '/noisy': page(
    'Noisy',
    `<main><h1>Noisy</h1></main><script>console.log('hello');console.warn('careful');console.error('boom one');console.error('boom one');setTimeout(()=>{throw new Error('late failure')},10)</script>
<img src="/missing.png" alt="x" width="5" height="5"><script src="https://www.google-analytics.com/analytics.js"></script><link rel="icon" href="/favicon.ico">
<script>fetch('/api/items').catch(()=>{});fetch('/api/broken').catch(()=>{})</script>`,
  ),
  '/quiet': page('Quiet', `<main><h1>Quiet</h1></main><script>console.log('only a log');fetch('/api/items')</script><script src="https://www.google-analytics.com/analytics.js"></script>`),
  '/warnonly': page('Warn', `<main><h1>Warn</h1></main><script>console.warn('deprecated thing')</script>`),
  '/hot': page('Hot', `<main><h1>Hot</h1></main><script>fetch('/static/x.hot-update.json').catch(()=>{});console.error('favicon trouble')</script>`),
  '/imgs': page('Imgs', `<main><h1>Imgs</h1><img src="/missing.png" alt="gone" width="5" height="5"><script src="https://www.google-analytics.com/analytics.js"></script></main>`),
  '/anim': page('Anim', `<main><h1>Anim</h1><div id="b" style="width:300px;height:200px;background:#e22"></div></main><script>let i=0;setInterval(()=>{document.getElementById('b').style.background=['#e22','#2a2','#22e','#ee2'][++i%4]},120)</script>`),
  '/ok': page('OK', '<main><h1>OK</h1></main>'),
  '/tall': page('Tall', `<main><h1>Tall</h1><div style="height:1500px;background:#ccf">tall</div><div id="w" style="width:50%;background:#fcc">half</div></main>`),
};

let server: Server;
let base = '';
let dir = '';
let rt: Awaited<ReturnType<typeof createAgentweb>>;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aw-checks-'));
  server = createServer((q, s) => {
    const url = (q.url ?? '/').split('?')[0];
    if (url === '/p.png') return void s.writeHead(200, { 'content-type': 'image/png' }).end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    if (url === '/api/items') return void s.writeHead(200, { 'content-type': 'application/json' }).end('[]');
    const html = SITE[url];
    if (!html) return void s.writeHead(404, { 'content-type': 'text/plain' }).end('no');
    s.writeHead(200, { 'content-type': 'text/html' }).end(html);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rt = await createAgentweb({ store: 'memory:', ghost: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_DOWNLOADS: dir, AGENTWEB_NO_SANDBOX: '1', AGENTWEB_USAGE_LOG: '', AGENTWEB_ATLAS: '0', AGENTWEB_IMAGES: '1' } });
});

after(async () => {
  await rt.close?.();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (sid: string, p: string) => rt.run(sid, p);
const at = (path: string, sid: string, p: string) => run(sid, `open('${base}${path}'); engine('chrome'); ${p}`);

describe('pure helpers', () => {
  it('parses widths and rule lists', () => {
    assert.deepEqual(parseWidths('375, 768,1280'), [375, 768, 1280]);
    assert.deepEqual(parseWidths(375), [375]);
    assert.throws(() => parseWidths('50'), /between 100 and 4000/);
    assert.throws(() => parseWidths(''), /no widths/);
    assert.deepEqual(parseRules('contrast,names'), ['placeholder', 'buttons', 'links', 'contrast'].concat([]).sort((a, b) => 0) && parseRules('contrast,names'));
    assert.ok(parseRules('names').includes('labels') && parseRules('names').includes('links'));
    assert.equal(parseRules(undefined).length, 14);
    assert.throws(() => parseRules('nonsense'), /unknown audit rule/);
  });

  it('reads the size of a JPEG and a PNG from the header', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    assert.deepEqual(imageSize(png), { w: 1, h: 1 });
    assert.equal(imageSize(Buffer.from('nope')), undefined);
  });

  it('formats reports in a few lines', () => {
    const acts = new Map();
    const o = overflowLines({ vw: 768, scrollW: 980, scrolls: true, locked: '', total: 7, hits: [{ tag: '<table.schedule>', by: 212, w: 980 }] }, acts, null);
    assert.equal(o.lines[1], 'overflows by 212 px: <table.schedule> 980 px wide in a 768 px viewport');
    assert.equal(o.lines.at(-1), '… 6 more');
    const rules: any = {};
    for (const id of parseRules(undefined)) rules[id] = { count: 3, items: [{ tag: '<p>', d: 'x' }, { tag: '<p>', d: 'y' }, { tag: '<p>', d: 'z' }] };
    const l = auditLines({ rules, skipped: 0, checkedText: 1 }, parseRules(undefined), acts, null);
    assert.ok(l.length <= 12, String(l.length));
    assert.match(l.at(-1)!, /more rules failed/);
    assert.deepEqual(axeLines({ version: '4.1', violations: [] }), ['axe-core 4.1: no violations']);
    const p = problemLines([{ doc: 1, page: 'http://x/a', kind: 'console', level: 'error', text: 'boom' }, { doc: 1, page: 'http://x/a', kind: 'console', level: 'error', text: 'boom' }, { doc: 1, page: 'http://x/a', kind: 'console', level: 'warning', text: 'hm' }], { kind: 'console', allow: [], doc: 1, url: 'http://x/a' });
    assert.deepEqual(p, { total: 2, lines: ['error: boom (×2)'] });
  });
});

describe('overflow()', { concurrency: false }, () => {
  it('names the elements that stick out, worst first, and skips what scrolls on its own', async () => {
    const r = await at('/overflow', 'ov1', 'overflow()');
    assert.match(r.text, /the page scrolls sideways: .* of content in a 1280 px viewport|no horizontal overflow/, r.text);
    // at the default 1280 px the 980 px table fits
    assert.match(r.text, /no horizontal overflow in a 1280 px viewport/, r.text);
    const t = (await run('ov1', 'emulate(768, 900); overflow()')).text;
    assert.match(t, /overflows by 212 px: <table\.schedule> "Mon 9:00 Tue" 980 px wide in a 768 px viewport/, t);
    assert.match(t, /overflows by 192 px: <a\.wide>\[Book a table now\]\d+ 900 px wide/, t);
    assert.doesNotMatch(t, /wrapped/, 'a table inside an overflow-x:auto wrapper is meant to scroll');
    assert.ok(t.split('\n').length <= 7, t);
    assert.match(t, /the page scrolls sideways/);
  });

  it('is quiet when everything fits, and the viewport is put back afterwards', async () => {
    const t = (await at('/fits', 'ov2', 'emulate(375, 700); overflow()')).text;
    assert.match(t, /no horizontal overflow in a 375 px viewport/);
    const w = (await run('ov2', "js('innerWidth')")).text;
    assert.match(w, /(^|\n)375\n/);
  });

  it('overflow(widths=…) measures at each width and restores the viewport', async () => {
    const t = (await at('/overflow', 'ov3', "overflow(widths='768,1280')")).text;
    assert.match(t, /overflows by 212 px: <table\.schedule>.* in a 768 px viewport/);
    assert.match(t, /no horizontal overflow in a 1280 px viewport/);
    assert.match((await run('ov3', "js('innerWidth')")).text, /(^|\n)1280\n/);
  });

  it('overflow(clipped=1) reports text cut off by its own box, separately', async () => {
    const t = (await at('/overflow', 'ov4', 'overflow(clipped=1)')).text;
    assert.match(t, /1 text box cut text off:/);
    assert.match(t, /clipped: <div\.cut> "A very long" needs \d+ px, box is 120 px/, t);
    assert.doesNotMatch((await run('ov4', 'overflow()')).text, /clipped/);
  });

  it('expect(overflow=0) and expect(no_overflow=1) fail with the lines', async () => {
    const bad = await at('/overflow', 'ov5', 'emulate(768, 900); expect(overflow=0)');
    assert.equal(bad.ok, false);
    assert.match(bad.text, /✗ expect\(overflow=0\) — the page scrolls sideways[^\n]*\n  overflows by 212 px: <table\.schedule>/, bad.text);
    assert.equal((await run('ov5', 'expect(no_overflow=1)')).ok, false);
    assert.equal((await run('ov5', 'expect(overflow=300)')).ok, true, 'a tolerance in px lets small overflow through');
    assert.equal((await at('/fits', 'ov6', 'expect(overflow=0)')).ok, true);
  });

  it('moves a page fetched without scripts to chrome, with a note', async () => {
    const r = await run('ov7', `open('${base}/fits'); overflow()`);
    assert.match(r.text, /note: overflow\(\) needs a real browser: this page was reopened in chrome/, r.text);
    assert.equal(r.stats.tier, 'chrome');
  });
});

describe('audit()', { concurrency: false }, () => {
  it('groups violations by rule with a count and the first two offenders, in at most 12 lines', async () => {
    const t = (await at('/a11y', 'au1', 'audit()')).text;
    const lines = t.split('\n').slice(1); // the first line is the run's own "ok: open → engine → audit"
    assert.ok(lines.length <= 12, t);
    assert.match(lines[0], /^audit: \d+ of 14 rules failed, \d+ elements \(built-in WCAG 2\.2 AA subset, not axe-core; contrast: \d+ text elements checked, 1 skipped/, t);
    assert.match(t, /^alt \(1\.1\.1\) ×1: <img> "p\.png" no alt attribute/m, 'only the image with no alt at all counts');
    assert.match(t, /^labels \(4\.1\.2\) ×1: .*no label/m);
    assert.match(t, /^placeholder \(3\.3\.2\) ×1: .*only a placeholder/m);
    assert.match(t, /^buttons \(4\.1\.2\) ×1: .*button has no name/m);
    assert.match(t, /^links \(2\.4\.4\) ×2: .*link has no name/m);
    assert.match(t, /^lang \(3\.1\.1\) ×1: <html> has no lang attribute/m);
    assert.match(t, /^title \(2\.4\.2\) ×1: <html> no <title>/m);
    assert.match(t, /^ids \(4\.1\.2\) ×1: .*id="dup" used 2×, referenced by a label or aria attribute/m);
    assert.match(t, /^headings \(1\.3\.1\) ×1: .*h1 → h3/m);
    assert.match(t, /^main \(2\.4\.1\) ×1: .*2 <main>/m);
    assert.match(t, /^… 4 more rules failed: tabindex ×1, contrast ×1, target ×2, aria-hidden ×1 \(audit\('tabindex'\) lists one\)$/m, 'the output stops at 12 lines and says what it left out');
    const rest = (await run('au1', "audit('tabindex,contrast,target,aria-hidden')")).text;
    assert.match(rest, /^tabindex \(2\.4\.3\) ×1: .*tabindex=3/m);
    assert.match(rest, /^contrast \(1\.4\.3\) ×1: .*"Pale text" 1\.9:1 \(needs 4\.5\) #bbb on #fff/m, rest);
    // the two crowded buttons fail; the 10x10 px link with 30 px of space around it is within WCAG 2.5.8's spacing exception
    assert.match(rest, /^target \(2\.5\.8\) ×2: <button>\[unlabeled button\]\d+ 16x6 px · <button>\[x\]\d+ 23x21 px$/m, rest);
    assert.match(rest, /^aria-hidden \(4\.1\.2\) ×1: .*hides 1 focusable/m);
  });

  it('a clean page passes, and audit(rules) runs only those', async () => {
    const t = (await at('/clean', 'au2', 'audit()')).text;
    assert.match(t, /^audit: no violations in 14 rules \(built-in WCAG 2\.2 AA subset, not axe-core; contrast: \d+ text elements checked\)$/m, t);
    const only = (await at('/a11y', 'au3', "audit('contrast,names')")).text;
    assert.doesNotMatch(only, /^alt |^lang /m);
    assert.match(only, /^contrast /m);
    assert.match(only, /^links /m);
    assert.match((await run('au3', "audit('bogus')")).text, /unknown audit rule 'bogus'/);
  });

  it('expect(audit=0) fails listing them; expect(audit=rules) checks only those', async () => {
    const bad = await at('/a11y', 'au4', 'expect(audit=0)');
    assert.equal(bad.ok, false);
    assert.match(bad.text, /✗ expect\(audit=0\) — audit: \d+ of 14 rules failed[^\n]*\n  alt \(1\.1\.1\)/, bad.text);
    assert.equal((await run('au4', "expect(audit='names,alt')")).ok, false);
    assert.equal((await run('au4', "expect(audit='tabindex')")).ok, false);
    assert.equal((await run('au4', "expect(audit='lang')")).ok, false);
    assert.equal((await at('/clean', 'au5', 'expect(audit=0)')).ok, true);
    assert.equal((await run('au5', "expect(audit='names,alt')")).ok, true);
  });

  it('numbers actionable offenders like the page view', async () => {
    const t = (await at('/a11y', 'au6', "audit('links,buttons')")).text;
    assert.match(t, /<button>\[unlabeled button\]\d+ button has no name/, t);
  });

  it('audit(axe=1) says how to install axe-core when it is missing, and runs it when it is there', async () => {
    const cwd = process.cwd();
    const none = mkdtempSync(join(tmpdir(), 'aw-noaxe-'));
    try {
      process.chdir(none);
      const r = await at('/ok', 'ax1', 'audit(axe=1)');
      assert.equal(r.ok, false);
      assert.match(r.text, /axe-core is not installed here/);
      assert.match(r.text, /npm install --save-dev axe-core/);
      // a stand-in with axe's interface, resolved from the working directory
      mkdirSync(join(none, 'node_modules', 'axe-core'), { recursive: true });
      writeFileSync(join(none, 'node_modules', 'axe-core', 'package.json'), '{"name":"axe-core","version":"4.0.0","main":"axe.min.js"}');
      writeFileSync(join(none, 'node_modules', 'axe-core', 'axe.min.js'), `window.axe={version:'4.0.0',run:async()=>({violations:[{id:'image-alt',impact:'critical',help:'Images must have alternate text',nodes:[{target:['img.hero'],html:'<img>'},{target:['#logo'],html:'<img>'},{target:['p img'],html:'<img>'}]}]})}`);
      const ok = await run('ax1', 'audit(axe=1)');
      assert.equal(ok.ok, true, ok.text);
      assert.match(ok.text, /axe-core 4\.0\.0: 1 rules violated, 3 elements\nimage-alt \(critical\) ×3: Images must have alternate text: img\.hero · #logo …/);
    } finally {
      process.chdir(cwd);
      rmSync(none, { recursive: true, force: true });
    }
  });
});

describe('expect(console=0) and expect(requests=0)', { concurrency: false }, () => {
  it('lists the first three errors, one line each; logs and agentweb-blocked trackers never count', async () => {
    const r = await at('/noisy', 'co1', 'expect(console=0)');
    assert.equal(r.ok, false);
    assert.match(r.text, /✗ expect\(console=0\) — console has 5 errors since the page loaded:\n  error: Failed to load resource: the server responded with a status of 404 \(Not Found\) \(\/missing\.png\)\n  error: boom one \(×2\)\n/, r.text);
    assert.doesNotMatch(r.text, /ERR_BLOCKED_BY_CLIENT|google-analytics|hello|careful/);
    assert.ok(r.text.split('\n').filter((l) => /^  (error|… )/.test(l)).length <= 4, r.text);
    assert.match(r.text, /… 1 more kinds/);
    assert.equal((await at('/quiet', 'co2', 'expect(console=0); expect(requests=0)')).ok, true);
  });

  it("console='warn' includes warnings", async () => {
    assert.equal((await at('/warnonly', 'co3', 'expect(console=0)')).ok, true);
    const r = await run('co3', "expect(console='warn')");
    assert.equal(r.ok, false);
    assert.match(r.text, /console has 1 errors or warnings since the page loaded:\n  warning: deprecated thing/, r.text);
  });

  it('allow= ignores matching messages', async () => {
    assert.equal((await at('/hot', 'co4', 'expect(console=0)')).ok, false);
    assert.equal((await at('/hot', 'co5', "expect(console=0, allow='favicon')")).ok, false, 'the 404 of the hot-update file is logged too');
    assert.equal((await at('/hot', 'co6', "expect(console=0, allow='favicon,hot-update')")).ok, true);
    assert.equal((await at('/hot', 'co6b', 'expect(requests=0)')).ok, false);
    assert.equal((await at('/hot', 'co6c', "expect(requests=0, allow='hot-update')")).ok, true);
  });

  it('expect(requests=0) fails on 4xx and failed requests, with the same allow=', async () => {
    const r = await at('/noisy', 'rq1', 'expect(requests=0)');
    assert.equal(r.ok, false);
    assert.match(r.text, /✗ expect\(requests=0\) — \d+ requests? failed \(4xx, 5xx or a network error\) since the page loaded:\n  GET 404 \/missing\.png/, r.text);
    assert.doesNotMatch(r.text, /google-analytics|BLOCKED/);
    assert.equal((await run('rq1', "expect(requests=0, allow='missing,favicon,broken')")).ok, true);
  });

  it('all=1 looks at every page of the session, not only the last', async () => {
    const r = await at('/noisy', 'co7', "open('" + base + "/ok'); expect(console=0)");
    assert.equal(r.ok, true, 'the last page is clean');
    const all = await run('co7', 'expect(console=0, all=1)');
    assert.equal(all.ok, false);
    assert.match(all.text, /in this test:\n  error: Failed to load resource[^\n]*\[\/noisy\]\n  error: boom one \(×2\) \[\/noisy\]/, all.text);
  });

  it('combines with a text check', async () => {
    assert.equal((await at('/quiet', 'co8', "expect('Quiet', console=0)")).ok, true);
    assert.match((await at('/quiet', 'co9', "expect('Nope', console=0)")).text, /'Nope' is not on the page/);
  });
});

describe('shot(widths=…)', { concurrency: false }, () => {
  it('saves one file per width, with the width in the name, and restores the viewport', async () => {
    const r = await at('/tall', 'sh1', "shot(widths='375,768,1280', save=1)");
    assert.equal(r.ok, true, r.text);
    const lines = r.text.split('\n').filter((l) => / px wide: /.test(l));
    assert.equal(lines.length, 3, r.text);
    for (const [i, w] of [375, 768, 1280].entries()) {
      const m = new RegExp(`^${w} px wide: (\\S+shot-w${w}-\\d+\\.jpg) \\(${w}x(\\d+) px, (\\d+) KB\\)$`).exec(lines[i]);
      assert.ok(m, lines[i]);
      assert.ok(existsSync(m[1]) && m[1].startsWith(dir));
      assert.deepEqual(imageSize(readFileSync(m[1])), { w, h: Number(m[2]) });
    }
    assert.equal(r.images, undefined, 'saved pictures are files, not attachments');
    assert.match((await run('sh1', "js('innerWidth')")).text, /(^|\n)1280\n/);
  });

  it('without save=1 it returns the images, one per width, and full=1 takes the whole page', async () => {
    const r = await at('/tall', 'sh2', "shot(widths='375,768')");
    assert.equal(r.images?.length, 2);
    assert.match(r.text, /^375 px wide: screenshot attached \(\d+x\d+ px, \d+ KB\)$/m);
    const full = await run('sh2', "shot(widths='375', full=1, save=1)");
    const m = /\((\d+)x(\d+) px/.exec(full.text);
    assert.ok(m && Number(m[2]) > 1500, full.text);
    const part = await run('sh2', "shot(widths='375', save=1)");
    assert.ok(Number(/\((\d+)x(\d+) px/.exec(part.text)![2]) <= 900, part.text);
  });

  it('refuses widths it cannot use', async () => {
    const r = await at('/tall', 'sh3', "shot(widths='20')");
    assert.equal(r.ok, false);
    assert.match(r.text, /'20' is not a viewport width between 100 and 4000 px/);
  });
});

describe('shot(annotate=1)', { concurrency: false }, () => {
  it('draws the element numbers the text view shows, and leaves nothing behind', async () => {
    const r = await at('/clean', 'an1', "shot(annotate=1); js('document.querySelectorAll(\"[data-agentweb-labels]\").length')");
    assert.equal(r.ok, true, r.text);
    assert.equal(r.images?.length, 1);
    assert.match(r.text, /(^|\n)0\n/, 'the labels are removed again');
    const plain = await run('an1', 'shot()');
    assert.notEqual(r.images![0].data, plain.images![0].data, 'the annotated picture differs');
  });
});

/** a PNG of w x h whose pixel (x, y) is fn(x, y) = [r, g, b] */
function png(w: number, h: number, fn: (x: number, y: number) => number[]): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(fn(x, y), y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (t: string, d: Buffer) => {
    const b = Buffer.alloc(12 + d.length);
    b.writeUInt32BE(d.length, 0);
    b.write(t, 4, 'latin1');
    d.copy(b, 8);
    return b; // the checksum is not checked by the decoder
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** a reference GIF decoder (frames composited onto a canvas), to check the encoder against */
function readGif(g: Buffer): { w: number; h: number; frames: { rgb: number[][]; delayCs: number }[] } {
  const w = g.readUInt16LE(6);
  const h = g.readUInt16LE(8);
  const pal = g.subarray(13, 13 + 768);
  let i = 13 + 768;
  const canvas = new Array<number[]>(w * h).fill([0, 0, 0]);
  const frames: { rgb: number[][]; delayCs: number }[] = [];
  let delayCs = 0;
  while (g[i] !== 0x3b) {
    if (g[i] === 0x21) {
      if (g[i + 1] === 0xf9) delayCs = g.readUInt16LE(i + 4);
      i += 2;
      while (g[i]) i += g[i] + 1;
      i++;
    } else if (g[i] === 0x2c) {
      const x0 = g.readUInt16LE(i + 1), y0 = g.readUInt16LE(i + 3), fw = g.readUInt16LE(i + 5), fh = g.readUInt16LE(i + 7);
      i += 10;
      const min = g[i++];
      const data: number[] = [];
      while (g[i]) {
        for (let k = 1; k <= g[i]; k++) data.push(g[i + k]);
        i += g[i] + 1;
      }
      i++;
      // LZW decode
      const out: number[] = [];
      let size = min + 1, next = (1 << min) + 2, bits = 0, nb = 0, prev: number[] | undefined;
      let dict: number[][] = [];
      const reset = () => { dict = []; for (let c = 0; c < 1 << min; c++) dict[c] = [c]; dict[1 << min] = []; dict[(1 << min) + 1] = []; size = min + 1; next = (1 << min) + 2; prev = undefined; };
      reset();
      for (const byte of data) {
        bits |= byte << nb; nb += 8;
        while (nb >= size) {
          const code = bits & ((1 << size) - 1);
          bits >>>= size; nb -= size;
          if (code === 1 << min) { reset(); continue; }
          if (code === (1 << min) + 1) { nb = -1e9; break; }
          const entry = dict[code] ?? (prev ? [...prev, prev[0]] : []);
          out.push(...entry);
          if (prev) dict[next++] = [...prev, entry[0]];
          prev = entry;
          if (next === 1 << size && size < 12) size++;
        }
      }
      assert.equal(out.length, fw * fh, 'every pixel of the frame decodes');
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) { const c = out[y * fw + x]; canvas[(y0 + y) * w + x0 + x] = [pal[c * 3], pal[c * 3 + 1], pal[c * 3 + 2]]; }
      frames.push({ rgb: canvas.slice(), delayCs });
    } else assert.fail('unexpected GIF block ' + g[i]);
  }
  return { w, h, frames };
}

describe('GIF encoder', () => {
  it('decodes PNG and writes a GIF that a reference decoder reads back exactly', () => {
    const a = png(40, 30, (x, y) => (x < 20 ? [200, 30, 30] : [30, 30, 200 - y]));
    const b = png(40, 30, (x, y) => (x < 20 ? [200, 30, 30] : y < 10 && x > 30 ? [250, 250, 0] : [30, 30, 200 - y]));
    assert.deepEqual([...decodePng(a).px.slice(0, 4)], [200, 30, 30, 255]);
    const r = encodeGif([{ png: a, ms: 100 }, { png: a, ms: 100 }, { png: b, ms: 300 }]);
    assert.equal(r.frames, 2, 'a repeated frame adds to the delay of the one before');
    assert.equal(r.skipped, 1);
    assert.equal(r.gif.toString('latin1', 0, 6), 'GIF89a');
    const g = readGif(r.gif);
    assert.deepEqual([g.w, g.h], [40, 30]);
    assert.equal(g.frames[0].delayCs, 20);
    assert.equal(g.frames[1].delayCs, 30);
    const want = (img: Buffer, x: number, y: number) => [...decodePng(img).px.slice((y * 40 + x) * 4, (y * 40 + x) * 4 + 3)];
    for (const [k, img] of [a, b].entries()) for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) assert.deepEqual(g.frames[k].rgb[y * 40 + x].map((v, c) => Math.abs(v - want(img, x, y)[c]) <= 4), [true, true, true], `frame ${k} pixel ${x},${y}`);
  });

  it('handles a photo-like frame with thousands of colours (LZW table resets)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const noisy = png(120, 90, () => [Math.floor(rnd() * 256), Math.floor(rnd() * 256), Math.floor(rnd() * 256)]);
    const r = encodeGif([{ png: noisy, ms: 50 }]);
    const g = readGif(r.gif);
    assert.equal(g.frames.length, 1);
    assert.equal(g.frames[0].rgb.length, 120 * 90);
  });
});

describe('record()', { concurrency: false }, () => {
  it('records the page as a GIF in the downloads folder and reports path, frames, seconds and size', async () => {
    const r = await at('/anim', 'rc1', "record('demo'); wait(1500); record(stop=1)");
    assert.equal(r.ok, true, r.text);
    const m = /^saved recording: (\S+demo-\d+\.gif) \((\d+) frames, ([\d.]+) s, (\d+) KB, (\d+)x(\d+) px\)$/m.exec(r.text);
    assert.ok(m, r.text);
    assert.ok(m[1].startsWith(dir));
    assert.ok(Number(m[2]) >= 3, `frames: ${m[2]}`);
    assert.ok(Number(m[3]) >= 1.4 && Number(m[3]) < 8, m[3]);
    assert.equal(Number(m[5]), 800);
    const gif = readFileSync(m[1]);
    assert.equal(gif.toString('latin1', 0, 6), 'GIF89a');
    assert.equal(readGif(gif).frames.length, Number(m[2]));
  });

  it('stopping without starting, or recording a page that never changes, says what to do', async () => {
    const none = await at('/ok', 'rc2', 'record(stop=1)');
    assert.equal(none.ok, false);
    assert.match(none.text, /no recording is running on this page/);
    const still = await run('rc2', "record('x'); record(stop=1)");
    assert.equal(still.ok, true, still.text);
  });
});

describe('what agentweb blocks itself is never the page\'s fault', { concurrency: false }, () => {
  it('images and trackers that agentweb refuses do not count; with AGENTWEB_IMAGES=1 a broken image does', async () => {
    const plain = await createAgentweb({ store: 'memory:', ghost: false, env: { AGENTWEB_ALLOW_PRIVATE: '1', AGENTWEB_NO_SANDBOX: '1', AGENTWEB_USAGE_LOG: '', AGENTWEB_ATLAS: '0' } });
    try {
      const r = await plain.run('bl1', `open('${base}/imgs'); engine('chrome'); expect(console=0, requests=0)`);
      assert.equal(r.ok, true, r.text);
    } finally {
      await plain.close?.();
    }
    const seen = await at('/imgs', 'bl2', 'expect(requests=0)');
    assert.equal(seen.ok, false);
    assert.match(seen.text, /GET 404 \/missing\.png/);
    assert.doesNotMatch(seen.text, /google-analytics/);
  });
});

describe('the page is left as it was found', { concurrency: false }, () => {
  it('overflow, audit and annotated screenshots change no DOM, focus or scroll position', async () => {
    const state = "js('JSON.stringify([document.documentElement.outerHTML.length, document.documentElement.outerHTML.slice(-300), String(document.activeElement && document.activeElement.tagName), scrollX, scrollY, document.querySelectorAll(\"[data-agentweb-labels]\").length])')";
    const before = (await at('/a11y', 'pg1', state)).text.split('\n').find((l) => l.startsWith('"['))!;
    await run('pg1', "overflow(clipped=1); audit(); shot(annotate=1); shot(widths='375,768', save=1); expect(console=0, requests=0, overflow=0, audit=0)");
    const after = (await run('pg1', state)).text.split('\n').find((l) => l.startsWith('"['))!;
    assert.equal(after, before);
  });
});
