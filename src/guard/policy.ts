// Guard policy: what an agent may reach and do. Loaded from a JSON file and the environment
// (environment wins), with defaults that depend on the deployment mode.
//
//                       local (one user, their machine)   hosted (many tenants, a server)
//   allowPrivate        true  (localhost dev servers)     false (SSRF)
//   confirm             consequential                     consequential
//   flow                warn                              block
//   readOnly            false                             false
// Cloud metadata endpoints are refused in every mode.
//
// Environment:
//   AGENTWEB_POLICY=<file>            JSON policy file (when loadPolicy gets no `file` argument)
//   AGENTWEB_MODE=local|hosted
//   AGENTWEB_ALLOW / AGENTWEB_DENY    comma/space separated host patterns
//   AGENTWEB_ALLOW_PRIVATE / AGENTWEB_READ_ONLY = 1|0|true|false|yes|no|on|off
//   AGENTWEB_CONFIRM=never|consequential   AGENTWEB_FLOW=off|warn|block
//   AGENTWEB_CONFIRM_KEY=<string>     HMAC key for confirmation tokens (share across workers)
//   AGENTWEB_SECRETS_FILE=<file>      secrets JSON (see secrets.ts)
//   AGENTWEB_SECRET_<NAME>=<value>, AGENTWEB_SECRET_<NAME>_ORIGINS=<origins>
//
// Host patterns: `example.com` matches example.com and every subdomain; `*.example.com` only
// subdomains; `*` inside a pattern matches any run of characters (`api-*.example.com`). Deny
// wins over allow; an empty allow list allows every host.

import { readFileSync } from 'node:fs';
import { AwError } from '../types.ts';
import type { FlowLimits } from './flow.ts';
import { parseSecrets, secretsFromEnv, secretsFromFile, splitList, type SecretDef } from './secrets.ts';
import { normHost } from './ssrf.ts';

export type Mode = 'local' | 'hosted';

export interface Policy {
  mode: Mode;
  /** host patterns; empty = all hosts */
  allow: string[];
  deny: string[];
  /** may the agent reach loopback, private, link-local … addresses? */
  allowPrivate: boolean;
  /** refuse submits, POSTs and other mutating steps */
  readOnly: boolean;
  /** consequential: payments, purchases, deletions … need a confirmation token */
  confirm: 'never' | 'consequential';
  /** cross-origin data-flow check */
  flow: 'off' | 'warn' | 'block';
  secrets: SecretDef[];
  /** HMAC key for confirmation tokens; without it each session gets a random key in its state */
  confirmKey?: string;
  /** standing approvals: confirmation tokens that always pass */
  confirmed?: string[];
  flowLimits?: Partial<FlowLimits>;
}

export function defaultPolicy(mode: Mode = 'local'): Policy {
  return {
    mode,
    allow: [],
    deny: [],
    allowPrivate: mode === 'local',
    readOnly: false,
    confirm: 'consequential',
    flow: mode === 'hosted' ? 'block' : 'warn',
    secrets: [],
  };
}

// ───────────────────────────── host patterns ─────────────────────────────

/** Normalise a list entry: strip scheme, path and port; lower-case. */
export function normPattern(p: string): string {
  let s = p.trim().toLowerCase();
  const i = s.indexOf('://');
  if (i >= 0) s = s.slice(i + 3);
  s = s.split(/[/?#]/)[0];
  if (!s.startsWith('[')) s = s.replace(/:\d+$/, '');
  return normHost(s);
}

const reCache = new Map<string, RegExp>();

export function hostMatches(pattern: string, host: string): boolean {
  const p = normPattern(pattern);
  const h = normHost(host);
  if (!p) return false;
  if (p === '*') return true;
  if (!p.includes('*')) return h === p || h.endsWith('.' + p);
  let re = reCache.get(p);
  if (!re) {
    re = new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    if (reCache.size > 1000) reCache.clear();
    reCache.set(p, re);
  }
  return re.test(h);
}

/** null when the host passes the lists, else the reason. */
export function listVerdict(policy: Pick<Policy, 'allow' | 'deny'>, host: string): string | null {
  for (const d of policy.deny) if (hostMatches(d, host)) return `${host} is on the deny list (${d})`;
  if (policy.allow.length && !policy.allow.some((a) => hostMatches(a, host))) return `${host} is not on the allow list`;
  return null;
}

// ───────────────────────────── loading ─────────────────────────────

function bool(v: unknown, name: string): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(s)) return false;
  throw new AwError('bad_request', `${name} must be true or false, got "${String(v).slice(0, 20)}"`);
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  const s = String(v).trim().toLowerCase() as T;
  if (!allowed.includes(s)) throw new AwError('bad_request', `${name} must be one of ${allowed.join(', ')}, got "${String(v).slice(0, 20)}"`);
  return s;
}

function list(v: unknown, name: string): string[] {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.map((x) => x.trim()).filter(Boolean);
  if (typeof v === 'string') return splitList(v);
  throw new AwError('bad_request', `${name} must be a list of host patterns`);
}

function readJson(path: string, what: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new AwError('bad_request', `cannot read ${what} ${path}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`);
  }
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error();
    return j as Record<string, unknown>;
  } catch {
    // never echo parser output: the file may hold secrets
    throw new AwError('bad_request', `${what} ${path} must be a JSON object`);
  }
}

const KNOWN_KEYS = new Set(['mode', 'allow', 'deny', 'allowPrivate', 'readOnly', 'confirm', 'flow', 'secrets', 'secretsFile', 'confirmKey', 'confirmed', 'flowLimits']);

/**
 * Build the policy from defaults (by mode), then the JSON file (`file`, else AGENTWEB_POLICY),
 * then the environment. Throws AwError('bad_request') on invalid values; messages never contain
 * secret values.
 */
export function loadPolicy(env: Record<string, string | undefined> = process.env, file?: string): Policy {
  const path = file ?? env.AGENTWEB_POLICY;
  const f = path ? readJson(path, 'policy file') : {};
  for (const k of Object.keys(f)) if (!KNOWN_KEYS.has(k)) throw new AwError('bad_request', `policy file: unknown key "${k}"`, `known keys: ${[...KNOWN_KEYS].join(', ')}`);

  const mode = oneOf(env.AGENTWEB_MODE ?? f.mode ?? 'local', ['local', 'hosted'] as const, 'mode');
  const p = defaultPolicy(mode);

  if (f.allow !== undefined) p.allow = list(f.allow, 'allow');
  if (f.deny !== undefined) p.deny = list(f.deny, 'deny');
  if (f.allowPrivate !== undefined) p.allowPrivate = bool(f.allowPrivate, 'allowPrivate');
  if (f.readOnly !== undefined) p.readOnly = bool(f.readOnly, 'readOnly');
  if (f.confirm !== undefined) p.confirm = oneOf(f.confirm, ['never', 'consequential'] as const, 'confirm');
  if (f.flow !== undefined) p.flow = oneOf(f.flow, ['off', 'warn', 'block'] as const, 'flow');
  if (f.confirmKey !== undefined) p.confirmKey = String(f.confirmKey);
  if (f.confirmed !== undefined) p.confirmed = list(f.confirmed, 'confirmed');
  if (f.flowLimits !== undefined) {
    if (!f.flowLimits || typeof f.flowLimits !== 'object') throw new AwError('bad_request', 'flowLimits must be an object');
    const fl: Partial<FlowLimits> = {};
    for (const [k, v] of Object.entries(f.flowLimits as Record<string, unknown>)) {
      if (!['shingles', 'tokens', 'origins', 'own'].includes(k) || typeof v !== 'number' || !(v > 0)) throw new AwError('bad_request', `flowLimits.${k} must be a positive number`);
      fl[k as keyof FlowLimits] = Math.floor(v);
    }
    p.flowLimits = fl;
  }
  const secrets: SecretDef[] = [];
  if (f.secrets !== undefined) secrets.push(...parseSecrets(f.secrets, 'policy file secrets'));
  if (typeof f.secretsFile === 'string') secrets.push(...secretsFromFile(f.secretsFile));

  if (env.AGENTWEB_ALLOW !== undefined) p.allow = splitList(env.AGENTWEB_ALLOW);
  if (env.AGENTWEB_DENY !== undefined) p.deny = splitList(env.AGENTWEB_DENY);
  if (env.AGENTWEB_ALLOW_PRIVATE !== undefined) p.allowPrivate = bool(env.AGENTWEB_ALLOW_PRIVATE, 'AGENTWEB_ALLOW_PRIVATE');
  if (env.AGENTWEB_READ_ONLY !== undefined) p.readOnly = bool(env.AGENTWEB_READ_ONLY, 'AGENTWEB_READ_ONLY');
  if (env.AGENTWEB_CONFIRM !== undefined) p.confirm = oneOf(env.AGENTWEB_CONFIRM, ['never', 'consequential'] as const, 'AGENTWEB_CONFIRM');
  if (env.AGENTWEB_FLOW !== undefined) p.flow = oneOf(env.AGENTWEB_FLOW, ['off', 'warn', 'block'] as const, 'AGENTWEB_FLOW');
  if (env.AGENTWEB_CONFIRM_KEY) p.confirmKey = env.AGENTWEB_CONFIRM_KEY;
  if (env.AGENTWEB_SECRETS_FILE) secrets.push(...secretsFromFile(env.AGENTWEB_SECRETS_FILE));
  secrets.push(...secretsFromEnv(env));

  // later sources override earlier ones by name
  const byName = new Map<string, SecretDef>();
  for (const s of secrets) byName.set(s.name.toLowerCase(), { ...s, name: s.name.toLowerCase() });
  p.secrets = [...byName.values()];
  return p;
}

export { createGuard } from './guard.ts';
