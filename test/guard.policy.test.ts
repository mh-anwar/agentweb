import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AwError } from '../src/types.ts';
import { createGuard, defaultPolicy, hostMatches, loadPolicy, permissiveGuard } from '../src/guard/index.ts';

describe('loadPolicy', () => {
  it('defaults depend on mode', () => {
    const l = loadPolicy({});
    assert.equal(l.mode, 'local');
    assert.equal(l.allowPrivate, true);
    assert.equal(l.flow, 'warn');
    const h = loadPolicy({ AGENTWEB_MODE: 'hosted' });
    assert.equal(h.allowPrivate, false);
    assert.equal(h.flow, 'block');
    assert.equal(h.confirm, 'consequential');
  });
  it('file then env, env wins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-guard-'));
    try {
      const f = join(dir, 'p.json');
      writeFileSync(f, JSON.stringify({ mode: 'hosted', allow: ['example.com'], deny: ['bad.example.com'], readOnly: true, flow: 'warn', confirmed: ['0123abcd'], secrets: { a: { value: 'v', origins: ['https://example.com'] } } }));
      const p = loadPolicy({ AGENTWEB_FLOW: 'off', AGENTWEB_ALLOW: 'a.com, b.com' }, f);
      assert.equal(p.mode, 'hosted');
      assert.equal(p.allowPrivate, false);
      assert.equal(p.readOnly, true);
      assert.equal(p.flow, 'off');
      assert.deepEqual(p.allow, ['a.com', 'b.com']);
      assert.deepEqual(p.deny, ['bad.example.com']);
      assert.deepEqual(p.confirmed, ['0123abcd']);
      assert.equal(p.secrets[0].name, 'a');
      assert.equal(loadPolicy({ AGENTWEB_POLICY: f }).flow, 'warn');
      writeFileSync(f, JSON.stringify({ alow: [] }));
      assert.throws(() => loadPolicy({}, f), /unknown key "alow"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects bad values with bad_request', () => {
    for (const env of [{ AGENTWEB_MODE: 'cloud' }, { AGENTWEB_FLOW: 'maybe' }, { AGENTWEB_READ_ONLY: 'sure' }, { AGENTWEB_CONFIRM: 'always' }])
      assert.throws(() => loadPolicy(env), (e: AwError) => e.code === 'bad_request');
    assert.throws(() => loadPolicy({}, '/nonexistent/policy.json'), (e: AwError) => e.code === 'bad_request');
  });
});

describe('host patterns', () => {
  const cases: [string, string, boolean][] = [
    ['example.com', 'example.com', true],
    ['example.com', 'www.example.com', true],
    ['example.com', 'notexample.com', false],
    ['example.com', 'example.com.evil.net', false],
    ['*.example.com', 'example.com', false],
    ['*.example.com', 'a.b.example.com', true],
    ['api-*.example.com', 'api-eu.example.com', true],
    ['api-*.example.com', 'www.example.com', false],
    ['https://Example.com:8443/path', 'example.com', true],
    ['example.com.', 'EXAMPLE.COM.', true],
    ['*', 'anything.example', true],
  ];
  for (const [p, h, want] of cases) it(`${p} ~ ${h} = ${want}`, () => assert.equal(hostMatches(p, h), want));
});

describe('guard basics', () => {
  it('state is compact JSON and restores', () => {
    const g = createGuard(defaultPolicy('local'));
    const s = g.state();
    assert.equal(s.v, 1);
    assert.ok(JSON.stringify(s).length < 120, JSON.stringify(s));
    const g2 = createGuard(defaultPolicy('local'), JSON.parse(JSON.stringify(s)));
    assert.equal(g2.session, g.session);
  });
  it('permissiveGuard allows everything', async () => {
    const p = permissiveGuard();
    assert.deepEqual(await p.checkUrl('http://127.0.0.1/', 'open'), { ok: true });
    assert.deepEqual(await p.checkStep({ verb: 'click', label: 'Delete account' }), { ok: true });
    assert.equal(p.reveal('{{secret:x}}', 'https://a.example'), '{{secret:x}}');
    assert.deepEqual(p.checkOutflow('x', 'https://a.example'), { ok: true });
  });
  it('exposes a policy-matched connect-time lookup', async () => {
    const hosted = createGuard(defaultPolicy('hosted'));
    const e = await new Promise<Error | null>((r) => hosted.lookup('localhost', {}, (err) => r(err)));
    assert.ok(e);
  });
});
