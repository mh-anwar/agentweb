import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime, type RuntimeImpl } from '../src/runtime.ts';
import { createJar, createWireEngine, encodeForm } from '../src/net/index.ts';
import { createGuard, defaultPolicy } from '../src/guard/index.ts';
import { MemoryStore } from '../src/store/index.ts';
import { readBody, mineEmbedded } from '../src/readers/index.ts';
import { parseProfile, serializeProfile } from '../src/profiles.ts';
import { startSite, type TestSite } from './core.site.ts';

let site: TestSite;
let rt: RuntimeImpl;
const dir = mkdtempSync(join(tmpdir(), 'aw-prof-'));
const prevEnv = process.env.AGENTWEB_PROFILES;

before(async () => {
  process.env.AGENTWEB_PROFILES = dir;
  site = await startSite();
  const policy = defaultPolicy('local');
  rt = createRuntime({
    store: new MemoryStore(),
    engines: { wire: createWireEngine({ polite: false }) },
    createJar,
    createGuard: (state) => createGuard(policy, state),
    encodeForm,
    readBody,
    mineEmbedded,
  });
});
after(async () => {
  await rt.close();
  await site.close();
  rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.AGENTWEB_PROFILES;
  else process.env.AGENTWEB_PROFILES = prevEnv;
});

test('sign in once, save it, and a fresh session reuses it without signing in', async () => {
  const a = await rt.run('a', `open('${site.url}/login'); fill('Username', 'bob'); fill('Password', 'hunter2'); submit(); expect('Welcome back'); profile('bob', save=1)`);
  assert.equal(a.ok, true, a.text);
  assert.match(a.text, /saved sign-in 'bob': 1 cookie/);
  const file = join(dir, 'bob.json');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'the file is private to its owner');
  const b = await rt.run('b', `profile('bob'); open('${site.url}/account'); expect('Welcome back, bob')`);
  assert.equal(b.ok, true, b.text);
  assert.doesNotMatch(b.text, new RegExp(JSON.parse(readFileSync(file, 'utf8')).cookies[0].value), 'cookie values never reach the model');
  const c = await rt.run('c', `open('${site.url}/account')`);
  assert.doesNotMatch(c.text, /Welcome back/, 'other sessions stay signed out');
});

test('Playwright storageState files load as they are; bad names and missing files are clear errors', async () => {
  const pw = { cookies: [{ name: 'sid', value: 'v1', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }], origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'role', value: 'parent' }] }] };
  const p = parseProfile(JSON.stringify(pw));
  assert.deepEqual(p.cookies[0], { name: 'sid', value: 'v1', domain: 'example.com', path: '/', hostOnly: false, httpOnly: true, secure: true, sameSite: 'Lax' });
  assert.deepEqual(p.storage, { 'https://app.example.com': { role: 'parent' } });
  assert.deepEqual(parseProfile(serializeProfile(p)), p, 'round trip');
  writeFileSync(join(dir, 'parent.json'), JSON.stringify(pw));
  const ok = await rt.run('d', `profile('parent')`);
  assert.match(ok.text, /signed in with 'parent': 1 cookie for example\.com, stored data for 1 site/);
  const bad = await rt.run('e', `profile('../etc/passwd')`);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /profile names are/);
  const missing = await rt.run('f', `profile('nobody')`);
  assert.match(missing.text, /no saved sign-in called 'nobody'/);
});
