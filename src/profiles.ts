// Saved sign-ins. A profile is a file of cookies and localStorage, in Playwright's storageState
// format, so the files a Playwright test suite already writes (`context.storageState({ path })`)
// work as they are. profile('instructor') loads one into the session; profile('x', save=1) writes
// the session's current sign-in out. Values never reach the model: only counts are reported.
//
// Files live in AGENTWEB_PROFILES (default ~/.config/agentweb/profiles), one <name>.json each.
// AGENTWEB_PROFILES=off disables the verb (e.g. on a shared multi-tenant server).

import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AwError, type CookieData } from './types.ts';

export interface Profile {
  cookies: CookieData[];
  /** origin -> localStorage items */
  storage: Record<string, Record<string, string>>;
}

interface PwCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}
interface PwState {
  cookies?: PwCookie[];
  origins?: { origin: string; localStorage?: { name: string; value: string }[] }[];
}

export function profileDir(env: Record<string, string | undefined> = process.env): string | undefined {
  const d = env.AGENTWEB_PROFILES;
  if (d === 'off' || d === '0') return undefined;
  return d || join(homedir(), '.config', 'agentweb', 'profiles');
}

function pathFor(name: string, env?: Record<string, string | undefined>): string {
  const dir = profileDir(env);
  if (!dir) throw new AwError('policy', 'saved sign-ins are turned off on this server (AGENTWEB_PROFILES=off)');
  if (!/^[\w.-]{1,64}$/.test(name) || name.startsWith('.')) throw new AwError('bad_request', `profile names are letters, digits, '-', '_' and '.', got '${name}'`);
  return join(dir, name.endsWith('.json') ? name : name + '.json');
}

export function parseProfile(text: string): Profile {
  let s: PwState;
  try {
    s = JSON.parse(text);
  } catch {
    throw new AwError('bad_request', 'the profile file is not JSON (expected Playwright storageState: {cookies, origins})');
  }
  const cookies: CookieData[] = [];
  for (const c of s.cookies ?? []) {
    if (!c || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string') continue;
    const hostOnly = !c.domain.startsWith('.');
    const d: CookieData = { name: c.name, value: c.value, domain: c.domain.replace(/^\./, '').toLowerCase(), path: c.path || '/', hostOnly };
    if (typeof c.expires === 'number' && c.expires > 0) d.expires = c.expires;
    if (c.httpOnly) d.httpOnly = true;
    if (c.secure) d.secure = true;
    if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') d.sameSite = c.sameSite;
    cookies.push(d);
  }
  const storage: Record<string, Record<string, string>> = {};
  for (const o of s.origins ?? []) {
    if (!o || typeof o.origin !== 'string') continue;
    let origin: string;
    try {
      origin = new URL(o.origin).origin;
    } catch {
      continue;
    }
    const items: Record<string, string> = {};
    for (const it of o.localStorage ?? []) if (it && typeof it.name === 'string') items[it.name] = String(it.value ?? '');
    if (Object.keys(items).length) storage[origin] = items;
  }
  return { cookies, storage };
}

export function serializeProfile(p: Profile): string {
  const now = Date.now() / 1000;
  const state: PwState = {
    cookies: p.cookies
      .filter((c) => c.expires === undefined || c.expires > now)
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.hostOnly === false ? '.' + c.domain : c.domain,
        path: c.path,
        expires: c.expires ?? -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite ?? 'Lax',
      })),
    origins: Object.entries(p.storage).map(([origin, items]) => ({ origin, localStorage: Object.entries(items).map(([name, value]) => ({ name, value })) })),
  };
  return JSON.stringify(state, null, 2) + '\n';
}

export function loadProfile(name: string, env?: Record<string, string | undefined>): Profile {
  const path = pathFor(name, env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new AwError('bad_request', `no saved sign-in called '${name}'`, `save one with profile('${name}', save=1) after signing in, or put a Playwright storageState file at ${path}`);
  }
  return parseProfile(text);
}

export function saveProfile(name: string, p: Profile, env?: Record<string, string | undefined>): string {
  const path = pathFor(name, env);
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, serializeProfile(p), { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** "3 cookies for 2 sites (app.example.com, auth.example.com), storage for 1 origin" — no values. */
export function describeProfile(p: Profile): string {
  const sites = [...new Set(p.cookies.map((c) => c.domain))];
  const shown = sites.slice(0, 4).join(', ') + (sites.length > 4 ? `, +${sites.length - 4}` : '');
  const parts = [`${p.cookies.length} cookie${p.cookies.length === 1 ? '' : 's'}` + (sites.length ? ` for ${shown}` : '')];
  const n = Object.keys(p.storage).length;
  if (n) parts.push(`stored data for ${n} site${n === 1 ? '' : 's'}`);
  return parts.join(', ');
}
