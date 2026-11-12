// A drop-down reads the same in every engine, and a list that takes several takes several.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentweb } from '../src/index.ts';
import { parseProgram } from '../src/dsl.ts';
import { startFarm, type Farm } from '../bench/sites/farm.ts';

let farm: Farm;
let rt: Awaited<ReturnType<typeof createAgentweb>>;
before(async () => {
  farm = await startFarm({ seed: 7 });
  rt = await createAgentweb({ store: 'memory:', atlas: false, env: { ...process.env, AGENTWEB_ALLOW_PRIVATE: '1' } });
});
after(async () => {
  await rt.close();
  await farm.close();
});

test('a list argument is its items: select(t, [a, b]) is select(t, a, b)', () => {
  assert.deepEqual(parseProgram("select(35, ['Chess', 'Hiking'])")[0].args, [35, 'Chess', 'Hiking']);
  assert.deepEqual(parseProgram("wait(['Saved', 'Failed'])")[0].args, ['Saved', 'Failed']);
  assert.deepEqual(parseProgram("click(['Save'])")[0].args, ['Save']);
});

for (const engine of ['wire', 'ghost', 'chrome']) {
  test(`${engine}: options are named, the chosen one is starred, several can be chosen`, async () => {
    const r = await rt.run('sel-' + engine, `engine('${engine}'); open('${farm.url}/forms/controls'); select('Country', 'Norway'); select('Interests', ['Chess', 'Hiking']); find('Country'); find('Interests')`, { budget: 4000 });
    assert.ok(r.ok, r.text);
    assert.match(r.text, /\{Country: Select a country\|Canada\|Germany\|Japan\|Kenya\|\*Norway\|Portugal\|United States\}/);
    assert.match(r.text, /\{Interests[^}]*: Cycling\|\*Chess\|Cooking\|Photography\|Gardening\|\*Hiking\}/);
  });
}
