// find() when the words are not on the page: say so plainly, and when nothing follows in the program and the
// site's own search has the thing, show that instead of costing the agent another call.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime, type RuntimeImpl } from '../src/runtime.ts';
import { createJar, createWireEngine, encodeForm } from '../src/net/index.ts';
import { createGuard, defaultPolicy } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';
import { readBody, mineEmbedded } from '../src/readers/index.ts';
import { startFarm, type Farm } from '../bench/sites/farm.ts';

let farm: Farm;
let rt: RuntimeImpl;
let n = 0;
before(async () => {
  farm = await startFarm({ seed: 7 });
  const policy = defaultPolicy('local');
  rt = createRuntime({ store: new MemoryStore(), engines: { wire: createWireEngine({ polite: false }) }, createJar, createGuard: (s) => createGuard(policy, s), encodeForm, readBody, mineEmbedded });
});
after(async () => {
  await rt.close();
  await farm.close();
});
const run = async (p: string) => (await rt.run('f' + ++n, p.replaceAll('$U', farm.url))).text;

test('a name that is elsewhere on the site: the last find() answers from the site search', async () => {
  const text = await run("open('$U/shop/'); find('Kestrel Flux 310')");
  assert.match(text, /note: 'Kestrel Flux 310' is not on .*\/shop\/; this is the site's own search for it/);
  assert.match(text, /\[Kestrel Flux 310 Camera\]\d+ \| \$1,325\.99/);
  assert.doesNotMatch(text, /Mosaic/);
});

test('a near miss is called a miss, not "1 match"', async () => {
  const text = await run("open('$U/shop/'); find('Kestrel Flux 310'); links('Cameras')");
  assert.match(text, /no line on this page has all of 'Kestrel Flux 310'; closest:/);
  assert.doesNotMatch(text, /1 match for/);
  assert.doesNotMatch(text, /site's own search/, 'the page stays put when more steps follow');
});

test('words the site search does not have either: the answer is about this page, and the page stays', async () => {
  for (const q of ['Zzyzx Quux 999', 'return policy']) {
    const text = await run(`open('$U/shop/'); find('${q}'); links('Cameras')`.replace("; links('Cameras')", ''));
    assert.doesNotMatch(text, /site's own search/, q);
    assert.match(text, /no match for|no line on this page has all of/, q);
  }
  const s = 'f' + ++n;
  await rt.run(s, `open('${farm.url}/shop/'); find('Zzyzx Quux 999')`);
  assert.match((await rt.run(s, 'view()')).text, /Spring tech sale/);
});

test('one-word and long queries keep the plain count', async () => {
  assert.match(await run("open('$U/shop/'); find('Keyboard')"), /\d+ match(es)? for 'Keyboard'/);
});
