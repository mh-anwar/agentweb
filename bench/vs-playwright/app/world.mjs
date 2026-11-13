#!/usr/bin/env node
// A fresh world (one center, a staff member and an instructor, both already signed in) for one test.
// Shared test infrastructure, used the same way by both suites (and not counted in their size):
//   node world.mjs <base>      prints one JSON object; profile / admin_profile are Playwright storageState files
//   import { makeWorld } from './world.mjs'
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function makeWorld(base) {
  const w = await (await fetch(`${base}/api/world`, { method: 'POST' })).json();
  const host = new URL(base).hostname;
  const dir = mkdtempSync(join(tmpdir(), 'vsp-world-'));
  const state = (sid) => ({ cookies: [{ name: 'sid', value: sid, domain: host, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] });
  writeFileSync(join(dir, 'staff.json'), JSON.stringify(state(w.sid)));
  writeFileSync(join(dir, 'admin.json'), JSON.stringify(state(w.admin_sid)));
  return { ...w, profile: join(dir, 'staff.json'), admin_profile: join(dir, 'admin.json') };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await makeWorld(process.argv[2] ?? process.env.AGENTWEB_BASE ?? 'http://127.0.0.1:4720')));
}
