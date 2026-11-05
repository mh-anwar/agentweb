// Step policy: read-only mode, and confirmation of consequential (irreversible or costly) steps.
//
// CONFIRMATION PROTOCOL (for the runtime / server):
//   1. `checkStep` refuses a consequential step with a reason ending in `confirm <token>`, where
//      token = first 8 hex chars of HMAC-SHA256(key, session id ‖ canonical step). The step is
//      identified by verb, origin, destination (without fragment), method, label and a hash of
//      the agent-supplied text, so the token approves exactly that step and nothing else.
//   2. The caller shows the user what is about to happen and, if approved, calls
//      `guard.confirm(token)` (the agent's program can carry it, e.g. a `confirm <token>` step,
//      ideally only after an MCP elicitation or another human-visible channel).
//   3. The next `checkStep` for the identical step passes once; the token is consumed.
//   Standing approvals can be put in `policy.confirmed` (never consumed). Pending tokens are part
//   of `guard.state()`, so a confirmation survives the session moving between workers.
//   Honest limit: a prompt-injected agent can echo the token itself. The token guarantees the
//   approval names this exact step and forces a second, visible call; a human-in-the-loop
//   guarantee needs the token to come from the user, not from the model.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { StepInfo, Verdict } from '../types.ts';

export type Consequence = 'payment' | 'purchase' | 'deletion' | 'transfer' | 'sending' | 'cancellation';

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Labels that look consequential but are not (dialog "Cancel", "Send me a code", ...). */
const BENIGN: RegExp[] = [
  /^(?:cancel|close|dismiss|back|go back|no|no thanks|not now|never mind|skip|undo|keep (?:my |your )?(?:subscription|plan|membership|account))$/,
  /\b(?:send|resend|email|text) (?:me )?(?:a |the |my )?(?:new )?(?:code|link|otp|one[- ]time (?:code|password)|verification|magic link|reset link|password reset|login link)\b/,
  /\b(?:remove|delete) (?:from|item from) (?:the |my )?(?:cart|bag|basket|wishlist|wish list|list|favou?rites|saved)\b/,
  /\b(?:clear|reset|remove|delete) (?:all )?(?:filters?|search|selection|query|text|input|history filter)\b/,
  /\b(?:add to|view|go to|proceed to|continue to|review) (?:cart|bag|basket|checkout|order|payment)\b/,
  /^(?:checkout|check out)$/,
  /\bsend feedback\b/,
];

const LABEL_RULES: [RegExp, Consequence][] = [
  [/\b(?:cancel|end|terminate|stop) (?:my |your |the )?(?:subscription|membership|plan|order|booking|reservation|service|auto-?renew(?:al)?|account)\b/, 'cancellation'],
  [/\bunsubscribe\b|\bconfirm cancell?ation\b|\bcancel anyway\b/, 'cancellation'],
  [/\b(?:transfer|wire|withdraw|send money|send funds|move money|send payment to)\b/, 'transfer'],
  [/\bpay\b|\b(?:make|submit|confirm|complete|authori[sz]e) (?:a |the |your |my )?payment\b|\bdonate\b|\bconfirm and pay\b/, 'payment'],
  [
    /\b(?:buy|purchase|place (?:your |my |the )?order|order now|complete (?:your |my |the )?(?:order|purchase|booking)|confirm (?:your |my |the )?(?:order|purchase|booking|reservation)|submit (?:your |my |the )?order|book now|reserve now|rent now|place bid|bid now|upgrade(?: now| plan| to\b| my)|start (?:my |your )?(?:subscription|membership|free trial|trial)|subscribe (?:now|to (?:premium|pro|plus)|for \$?\d))\b/,
    'purchase',
  ],
  [/\b(?:delete|erase|destroy|wipe|purge|permanently remove)\b|\b(?:close|deactivate|terminate|remove) (?:my |your |the |this )?account\b|\bremove\b/, 'deletion'],
  [/^(?:send|post|publish|tweet|reply|forward|repost|retweet|submit (?:comment|review|post|reply)|post (?:comment|reply|review)|send (?:message|email|e-mail|reply|invite|invitation)s?)\b/, 'sending'],
  [/\bsend (?:message|email|e-mail|reply|invite|invitation)s?\b|\bpublish\b/, 'sending'],
];

/** Destination paths that make a POST consequential whatever the button says. */
const PATH_RULES: [RegExp, Consequence][] = [
  [/(?:^|[/_\-.])(?:unsubscribe|cancel[_\-]?(?:subscription|membership|plan|order|account))(?:$|[/_\-.?])/, 'cancellation'],
  [/(?:^|[/_\-.])(?:transfers?|wire|withdraw(?:al)?|payouts?|remit)(?:$|[/_\-.?])/, 'transfer'],
  [/(?:^|[/_\-.])(?:pay|payments?|charges?|billing|donat(?:e|ion)s?|card[_\-]?charge)(?:$|[/_\-.?])/, 'payment'],
  [/(?:^|[/_\-.])(?:checkout|orders?|purchases?|buy|place[_\-]?order|subscriptions?|subscribe|bookings?|reservations?)(?:$|[/_\-.?])/, 'purchase'],
  [/(?:^|[/_\-.])(?:delete|destroy|remove|erase|purge)(?:$|[/_\-.?])/, 'deletion'],
  [/(?:^|[/_\-.])(?:send|compose|post|publish|tweet|reply|messages?|comments?)(?:$|[/_\-.?])/, 'sending'],
];

/** Even a GET to these is an action (e-mail unsubscribe links, `/items/7/delete?confirm=1`). */
const GET_PATH_RULES: [RegExp, Consequence][] = [
  [/(?:^|[/_\-.])unsubscribe(?:$|[/_\-.?])/, 'cancellation'],
  [/(?:^|[/_\-.])(?:delete|destroy)(?:$|[/_\-.?])/, 'deletion'],
];

const NON_MUTATING = new Set(['open', 'goto', 'go', 'nav', 'navigate', 'back', 'forward', 'reload', 'scroll', 'hover', 'wait', 'find', 'read', 'extract', 'shot', 'screenshot', 'fill', 'type', 'select', 'check', 'uncheck', 'focus', 'search', 'follow', 'link']);

/** Could this step change server-side state? */
export function isMutating(s: StepInfo): boolean {
  const verb = s.verb.toLowerCase();
  if (s.method === 'POST') return true;
  if (verb === 'submit' || verb === 'upload') return true;
  // a click with a destination is a link (GET); without one it is a script-driven control
  if (verb === 'click' || verb === 'tap' || verb === 'press') return !s.dest;
  return !NON_MUTATING.has(verb) && s.method !== 'GET' && !s.dest;
}

function pathOf(dest?: string): string {
  if (!dest) return '';
  try {
    const u = new URL(dest);
    return (u.pathname + u.search).toLowerCase();
  } catch {
    return dest.toLowerCase();
  }
}

/** Classify a step as consequential, with a short human reason, or null. */
export function classifyStep(s: StepInfo): { kind: Consequence; why: string } | null {
  const mutating = isMutating(s);
  const path = pathOf(s.dest);
  if (!mutating) {
    for (const [re, kind] of GET_PATH_RULES) if (re.test(path)) return { kind, why: `link to ${shortPath(path)}` };
    return null;
  }
  const label = squash((s.label ?? '').toLowerCase());
  if (label && !BENIGN.some((re) => re.test(label))) {
    for (const [re, kind] of LABEL_RULES) if (re.test(label)) return { kind, why: `"${clip(s.label!)}"` };
  }
  if (s.method === 'POST' || s.verb === 'submit')
    for (const [re, kind] of PATH_RULES) if (re.test(path)) return { kind, why: `${s.method ?? 'submit'} to ${shortPath(path)}` };
  return null;
}

const clip = (s: string, n = 48) => (s.length > n ? s.slice(0, n - 1) + '…' : squash(s));
const shortPath = (p: string) => clip(p.split('?')[0] || '/', 60);

function canonical(s: StepInfo): string {
  let dest = s.dest ?? '';
  const h = dest.indexOf('#');
  if (h >= 0) dest = dest.slice(0, h);
  const text = s.text ? createHash('sha256').update(s.text).digest('hex').slice(0, 16) : '';
  return JSON.stringify([s.verb.toLowerCase(), s.origin ?? '', dest, s.method ?? '', squash((s.label ?? '').toLowerCase()), text]);
}

export function confirmToken(key: string, session: string, s: StepInfo): string {
  return createHmac('sha256', key).update(session).update('\n').update(canonical(s)).digest('hex').slice(0, 8);
}

export interface GateState {
  /** session id (random) */
  s: string;
  /** per-session HMAC key, when the policy does not provide one */
  k?: string;
  /** pending one-shot approvals */
  p?: string[];
}

const MAX_PENDING = 32;
const TOKEN_RE = /^[0-9a-f]{8}$/;

export class StepGate {
  private sid: string;
  private key: string;
  private ownKey: boolean;
  private pending: string[] = [];
  private standing: Set<string>;
  private readonly readOnly: boolean;
  private readonly mode: 'never' | 'consequential';

  constructor(opts: { readOnly: boolean; confirm: 'never' | 'consequential'; key?: string; confirmed?: string[] }, state?: unknown) {
    this.readOnly = opts.readOnly;
    this.mode = opts.confirm;
    this.standing = new Set((opts.confirmed ?? []).map((t) => t.toLowerCase()));
    const st = state as GateState | undefined;
    this.sid = typeof st?.s === 'string' ? st.s : randomBytes(9).toString('base64url');
    this.ownKey = !opts.key;
    this.key = opts.key ?? (typeof st?.k === 'string' ? st.k : randomBytes(18).toString('base64url'));
    if (Array.isArray(st?.p)) this.pending = st.p.filter((t) => typeof t === 'string' && TOKEN_RE.test(t)).slice(-MAX_PENDING);
  }

  get session(): string {
    return this.sid;
  }

  /** Approve one consequential step by the token its refusal named. */
  confirm(token: string): boolean {
    const t = token.trim().toLowerCase().replace(/^confirm\s+/, '');
    if (!TOKEN_RE.test(t)) return false;
    if (!this.pending.includes(t)) this.pending.push(t);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    return true;
  }

  /** Token for an arbitrary approval subject (used by the flow check in block mode). */
  token(s: StepInfo): string {
    return confirmToken(this.key, this.sid, s);
  }

  /** Consume a pending or standing approval for `s`. */
  consume(s: StepInfo): boolean {
    const t = this.token(s);
    if (this.standing.has(t)) return true;
    const i = this.pending.indexOf(t);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    return true;
  }

  check(s: StepInfo): Verdict {
    const where = s.origin ? ` on ${s.origin}` : s.dest ? ` to ${safeOrigin(s.dest)}` : '';
    if (this.readOnly && isMutating(s)) {
      const what = s.label ? `"${clip(s.label)}"` : s.method === 'POST' ? 'a POST' : `${s.verb}`;
      return { ok: false, reason: `read-only mode: refusing ${s.verb} ${what}${where}` };
    }
    if (this.mode !== 'consequential') return { ok: true };
    const c = classifyStep(s);
    if (!c) return { ok: true };
    if (this.consume(s)) return { ok: true, warn: `confirmed ${c.kind}: ${c.why}${where}` };
    return {
      ok: false,
      reason: `${c.why}${where} looks like a ${c.kind} step and needs the user's approval. If the user approves, run it again with confirm ${this.token(s)}`,
    };
  }

  state(): GateState {
    const st: GateState = { s: this.sid };
    if (this.ownKey) st.k = this.key;
    if (this.pending.length) st.p = [...this.pending];
    return st;
  }
}

function safeOrigin(u: string): string {
  try {
    return new URL(u).origin;
  } catch {
    return u.slice(0, 60);
  }
}
