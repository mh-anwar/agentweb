// What Playwright journeys need from `agentweb test` (reported by a project moving 26 journey specs over):
// assertions on any role with a name and a state, negative assertions with a locator, scoping to a dialog or a
// row, a second user in the same test, waiting step targets, downloads, readable command failures, date keys.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testCommand } from '../src/test/cli.ts';
import { dateKey, NEEDS_BROWSER, whyFailed } from '../src/test/runner.ts';
import { parseProgram } from '../src/dsl.ts';

process.env.AGENTWEB_TEST_MEMORY = '0';

let server: Server;
let base = '';
let dir = '';
let n = 0;

const APP = `<!doctype html><html lang="en"><head><title>Journeys</title></head><body><main>
<h1>Students</h1>
<button id="open" aria-label="Report a problem">⚑</button>
<dialog id="d" aria-labelledby="dt"><h2 id="dt">Report a problem</h2><label for="note">What went wrong</label><textarea id="note"></textarea>
<button id="send">Send report</button> <button id="cancel">Cancel</button></dialog>
<p id="toast" role="status"></p>
<fieldset><legend>Clock in by</legend><label><input type="radio" name="m" value="e" checked> Either way</label><label><input type="radio" name="m" value="k"> Kiosk code</label></fieldset>
<label for="code">Clock-in code</label><input id="code" readonly value="482 913">
<button disabled>Archive</button>
<table><tr><th>Name</th><th></th></tr><tr><td>Ada Lovelace</td><td><button>Edit</button></td></tr><tr><td>Grace Hopper</td><td><button>Edit</button></td></tr></table>
<div role="tablist"><button role="tab" aria-selected="true">TV, QR codes and app</button></div>
<p>1 student</p><p>11 students</p>
<p><a href="/export">Download all data</a></p>
<div id="late"></div>
</main><script>
const d=document.getElementById('d');
document.getElementById('open').onclick=()=>{d.showModal();document.getElementById('note').focus();};
document.getElementById('cancel').onclick=()=>d.close();
document.getElementById('send').onclick=()=>{d.close();document.getElementById('toast').textContent='Your report was sent.';};
document.querySelectorAll('tr button').forEach(b=>b.onclick=()=>{document.getElementById('toast').textContent='Editing '+b.closest('tr').cells[0].textContent;});
setTimeout(()=>{document.getElementById('late').innerHTML='<button onclick="this.textContent=\\'Done\\'">Appears late</button>';},700);
</script></body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    if (u.pathname === '/export') return res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="export-2026-11-12.csv"' }).end('a,b\n1,2\n');
    if (u.pathname === '/who') return res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><html lang="en"><title>Who</title><main><h1>${/sid=(\w+)/.exec(req.headers.cookie ?? '')?.[1] ?? 'nobody'}</h1></main></html>`);
    res.writeHead(200, { 'content-type': 'text/html' }).end(APP);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = mkdtempSync(join(tmpdir(), 'aw-journeys-'));
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

async function run(files: Record<string, string>, args: string[] = []) {
  const d = join(dir, 'c' + ++n);
  mkdirSync(d, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(d, f), text.replaceAll('$BASE', base).replaceAll('$DIR', d));
  const out: string[] = [];
  const err: string[] = [];
  const code = await testCommand([d, '--base', base, '--workers', '1', ...args], { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('expect on any role, name and state; a control named only by aria-label is clicked by that name', async () => {
  const r = await run({
    'a.aw': `## roles and states
open('/'); expect(role='button', name='Report a problem'); expect(role='button', name='Archive', disabled=1)
expect(role='radio', name='Either way', checked=1); expect(checked='Either way'); expect(role='radio', name='Kiosk code', checked=0)
expect(role='textbox', name='Clock-in code', value='482 913'); expect(label='Clock-in code', value='/^\\d{3} \\d{3}$/')
expect(role='tab', name='TV, QR codes', selected=1); expect(role='row', n=3); expect(role='button', name='Edit', n=2)
expect(not='QR codes', role='heading'); expect(role='dialog', hidden=1); expect('1 student', exact=1)
click('Report a problem'); expect(role='dialog', name='Report a problem'); expect(focused='What went wrong')
click('Send report', in='dialog:Report a problem'); expect(role='dialog', hidden=1); expect('Your report was sent.', in='status')
`,
  });
  assert.equal(r.code, 0, r.out);
});

test('a failing locator assertion says what is there instead', async () => {
  const r = await run({
    'a.aw': `## wrong state
open('/'); expect(role='button', name='Archive', enabled=1, timeout=1)
## wrong focus
open('/'); click('Report a problem'); expect(focused='Send report', timeout=1)
## wrong name
open('/'); expect(role='button', name='Delete everything', timeout=1)
## should be hidden
open('/'); expect(role='heading', name='Students', hidden=1, timeout=1)
## wrong count
open('/'); expect(role='row', n=5, timeout=1)
`,
  });
  assert.equal(r.code, 1);
  assert.match(r.out, /button 'Archive' is disabled/);
  assert.match(r.out, /button 'Send report' does not have the focus \(it is on textbox 'What went wrong'\)/);
  assert.match(r.out, /no button named 'Delete everything' on the page \(button here: .*'Archive'/);
  assert.match(r.out, /heading 'Students' is visible but should not be/);
  assert.match(r.out, /expected 5 visible row, found 3/);
});

test('within() scopes later steps to a row; nth= picks one of several', async () => {
  const r = await run({
    'a.aw': `## edit grace
open('/'); within('row:Grace Hopper'); click('Edit'); within(); expect('Editing Grace Hopper')
## edit the first
open('/'); click('Edit', nth=1); expect('Editing Ada Lovelace')
`,
  });
  assert.equal(r.code, 0, r.out);
});

test('a step waits for a target that appears late', async () => {
  const r = await run({ 'a.aw': `# engine: chrome\n## late\nopen('/'); click('Appears late'); expect(role='button', name='Done')\n` });
  assert.equal(r.code, 0, r.out);
});

test("as('name') runs later steps as another user, in a browser context that stays open", async () => {
  const state = (sid: string) => JSON.stringify({ cookies: [{ name: 'sid', value: sid, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] });
  const r = await run({
    'alice.json': state('alice'),
    'bob.json': state('bob'),
    'a.aw': `# engine: chrome\n## two users\nprofile(file='$DIR/alice.json'); open('/who'); expect('alice', role='heading')\nas('bob', profile='$DIR/bob.json'); open('/who'); expect('bob', role='heading')\nas('main'); expect('alice', role='heading'); open('/who'); expect('alice', role='heading')\n`,
  });
  assert.equal(r.code, 0, r.out);
});

test("expect(download=) checks the file a click downloaded; \${download.path} is where it is", async () => {
  const r = await run({ 'a.aw': `# engine: chrome\n## export\nopen('/'); click('Download all data'); expect(download='/^export-\\d{4}-\\d\\d-\\d\\d\\.csv$/')\nexec('cat "\${download.path}"', expect='1,2')\n## none\nopen('/'); expect(download='x.csv')\n` });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /✗ export/);
  assert.match(r.out, /nothing was downloaded \(expected 'x\.csv'\)/);
});

test('exec: expect= and not= on what it printed; a failure names the error line and the exit code', async () => {
  const r = await run({
    'a.aw': `## prints
exec('echo row=history', expect='history', not='error')
## mismatch
exec('echo nothing useful', expect='/^row=/')
## crash
exec('node -e "function f(){ throw new TypeError(\\'bad row\\') } f()"')
`,
  });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /✗ prints/);
  assert.match(r.out, /the command printed 'nothing useful', expected it to contain '\/\^row=\/'/);
  assert.match(r.out, /TypeError: bad row — exit code 1/);
  assert.equal(whyFailed({ ok: false, out: '', err: 'file:///x.mjs:3\n}\n^\n\nError: no world for worker 2\n    at load (x.mjs:3:9)\n\nNode.js v24.22.1', code: 1 }), 'Error: no world for worker 2 — exit code 1');
});

test('${today} and ${today+N} are date keys; ${base} is the run address', async () => {
  const r = await run({ 'a.aw': `## dates\nexec('echo \${today} \${today+3} \${base}', expect='${dateKey(0)} ${dateKey(3)} ${base}')\n` });
  assert.equal(r.code, 0, r.out);
  assert.match(dateKey(-1, 'America/Toronto'), /^\d{4}-\d\d-\d\d$/);
});

test('string escapes other than quotes, \\n, \\t and \\\\ keep their backslash (patterns survive)', () => {
  const s = parseProgram("expect(name='/^\\d+ items\\.$/', text='a\\'b', x='c\\\\d')")[0];
  assert.equal(s.opts.name, '/^\\d+ items\\.$/');
  assert.equal(s.opts.text, "a'b");
  assert.equal(s.opts.x, 'c\\d');
});

test('steps that only a browser can run make a test start in one', () => {
  for (const src of ["expect(role='button', name='Save')", "expect(checked='Kiosk')", "upload('Photo', 'a.png')", "within('row:Ada')", "expect(overflow=0)", "emulate(390, 844)"]) assert.ok(NEEDS_BROWSER.test(src), src);
  for (const src of ["expect('Saved')", "expect(role='heading', level=1)", "click('Save')", "expect(url='/home')"]) assert.ok(!NEEDS_BROWSER.test(src), src);
});
