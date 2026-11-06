// Virtual time: timers, intervals, animation frames and clocks run on the engine's clock, which
// jumps to the next timer instead of sleeping. Settling is bounded for polling and animation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createGhostEngine } from '../src/engines/ghost/index.ts';
import type { Engine } from '../src/types.ts';
import { serve, html, makeCtx, textOf, byId } from './ghost.helpers.ts';

let srv: Awaited<ReturnType<typeof serve>>;
let eng: Engine;

before(async () => {
  srv = await serve({
    // renders only after three seconds
    '/late': html(`<div id="out">loading…</div><script>
      const t0 = Date.now(), p0 = performance.now();
      setTimeout(() => {
        document.getElementById('out').textContent = 'rendered after ' + (Date.now() - t0) + 'ms (perf ' + Math.round(performance.now() - p0) + ')';
      }, 3000);
    </script>`),
    // polls forever every second and animates forever: must still settle, quickly
    '/busy': html(`<p id="polls">0</p><p id="frames">0</p><p id="ready"></p><script>
      let polls = 0, frames = 0;
      setInterval(() => { document.getElementById('polls').textContent = String(++polls); }, 1000);
      (function loop(){ frames++; document.getElementById('frames').textContent = String(frames); requestAnimationFrame(loop); })();
      (function poll(){ setTimeout(poll, 250); })();
      setTimeout(() => { document.getElementById('ready').textContent = 'ready'; }, 1200);
    </script>`),
    // a timer beyond the settle horizon shows up only after an explicit wait
    '/far': html(`<p id="far">not yet</p><script>
      setTimeout(() => { document.getElementById('far').textContent = 'twelve seconds later'; }, 12000);
      setTimeout(() => { document.body.insertAdjacentHTML('beforeend', '<p id="t2">appeared</p>'); }, 20000);
    </script>`),
    // a chain of zero-delay chunks, requestIdleCallback, MessageChannel, queueMicrotask
    '/chunks': html(`<p id="sum"></p><script>
      let n = 0;
      const step = () => { n++; if (n < 500) setTimeout(step, 0); else done(); };
      function done() {
        requestIdleCallback(() => {
          const ch = new MessageChannel();
          ch.port1.onmessage = (e) => queueMicrotask(() => { document.getElementById('sum').textContent = 'chunks=' + n + ' msg=' + e.data; });
          ch.port2.postMessage('hi');
        });
      }
      step();
    </script>`),
  });
  eng = createGhostEngine({});
});

after(async () => {
  await eng?.close();
  await srv?.close();
});

test('a page that renders after setTimeout(…, 3000) settles in well under a second of wall time', async () => {
  const ctx = makeCtx();
  await eng.open(ctx, { url: srv.url + '/far' }); // warm a process for this session
  const t0 = performance.now();
  const l = await eng.open(ctx, { url: srv.url + '/late' });
  const wall = performance.now() - t0;
  const text = textOf(byId(l.doc!.root, 'out'));
  const m = /rendered after (\d+)ms \(perf (\d+)\)/.exec(text);
  assert.ok(m, text);
  assert.ok(+m[1] >= 3000 && +m[1] < 3500, 'Date.now advanced by the virtual 3 s: ' + text);
  assert.ok(+m[2] >= 3000 && +m[2] < 3500, 'performance.now advanced too: ' + text);
  assert.ok(wall < 1000, `wall time ${Math.round(wall)} ms`);
  const st = eng.stats!();
  assert.ok(st.lastSkippedMs >= 2900, 'virtual time skipped: ' + st.lastSkippedMs);
  console.log(`late page: open ${Math.round(wall)} ms wall, ${st.lastSkippedMs} ms virtual skipped`);
});

test('polling intervals and animation loops do not keep a settle open', async () => {
  const ctx = makeCtx();
  const t0 = performance.now();
  const l = await eng.open(ctx, { url: srv.url + '/busy' });
  const wall = performance.now() - t0;
  assert.equal(textOf(byId(l.doc!.root, 'ready')), 'ready', 'a one-shot timer inside the horizon still ran');
  const polls = +textOf(byId(l.doc!.root, 'polls'));
  const frames = +textOf(byId(l.doc!.root, 'frames'));
  assert.ok(polls >= 1 && polls <= 8, 'polls ' + polls);
  assert.ok(frames >= 2 && frames <= 60, 'frames ' + frames);
  assert.ok(wall < 3000, `wall ${Math.round(wall)} ms`);
  // the page keeps living: another snapshot gives the loops one more bounded turn
  const s = await eng.snapshot!(ctx);
  assert.ok(+textOf(byId(s.doc!.root, 'polls')) >= polls);
});

test('timers beyond the horizon wait for an explicit wait (ms or text)', async () => {
  const ctx = makeCtx();
  let l = await eng.open(ctx, { url: srv.url + '/far' });
  assert.equal(textOf(byId(l.doc!.root, 'far')), 'not yet');
  const t0 = performance.now();
  l = await eng.act!(ctx, { do: 'wait', ms: 12500 });
  assert.equal(textOf(byId(l.doc!.root, 'far')), 'twelve seconds later');
  l = await eng.act!(ctx, { do: 'wait', text: 'appeared' });
  assert.equal(textOf(byId(l.doc!.root, 't2')), 'appeared');
  assert.ok(performance.now() - t0 < 2000, 'waiting is virtual');
  l = await eng.act!(ctx, { do: 'wait', text: 'never shows up' });
  assert.ok((l.events || []).some((e) => e.includes('did not appear')), JSON.stringify(l.events));
});

test('zero-delay chunking, idle callbacks, message channels and microtasks all run', async () => {
  const ctx = makeCtx();
  const l = await eng.open(ctx, { url: srv.url + '/chunks' });
  assert.equal(textOf(byId(l.doc!.root, 'sum')), 'chunks=500 msg=hi');
});
