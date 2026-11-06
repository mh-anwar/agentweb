// Messages between the engine (parent) and a page process (child). Types only, plus the
// defaults both sides agree on. The child is untrusted once it has run page code: everything
// it sends is validated by the parent, and nothing here lets it name another session.

import type { Action, Doc } from '../../types.ts';

export interface Limits {
  /** a timer further away than this does not hold a settle open (virtual ms) */
  horizonMs: number;
  /** most virtual time one settle may skip */
  maxVirtualMs: number;
  /** most tasks (timers, frames, message ports) one settle may run */
  maxTasks: number;
  /** most real time one settle may take */
  maxWallMs: number;
  /** real time a settle waits on in-flight requests before treating them as background */
  netWaitMs: number;
  /** synchronous CPU budget of one script or one task; `while(true)` is terminated after this */
  cpuMs: number;
  /** firings of one interval / one self-rescheduling timer before it is treated as background */
  repeatLimit: number;
  /** animation frames one settle runs before frames are treated as background */
  frameLimit: number;
  /** most sub-requests one page may start per operation */
  maxRequests: number;
  /** extractor node cap */
  maxNodes: number;
}

export const DEFAULT_LIMITS: Limits = {
  horizonMs: 5000,
  maxVirtualMs: 30000,
  maxTasks: 20000,
  maxWallMs: 8000,
  netWaitMs: 4000,
  cpuMs: 2000,
  repeatLimit: 5,
  frameLimit: 30,
  maxRequests: 300,
  maxNodes: 25000,
};

export interface LoadMsg {
  t: 'load';
  id: number;
  url: string;
  status: number;
  contentType: string;
  referrer: string;
  html: Uint8Array;
  userAgent: string;
  /** document.cookie-visible cookies for `url` */
  cookie: string;
  local: Record<string, string>;
  session: Record<string, string>;
  /** first node id the extractor may hand out (ids never repeat within a session) */
  idBase: number;
  /** fetch stylesheets (computed visibility from CSS classes) */
  styles: boolean;
  limits: Limits;
  /** real ms the whole operation may still take */
  budgetMs: number;
}

export interface ActMsg {
  t: 'act';
  id: number;
  action: Action;
  limits: Limits;
  budgetMs: number;
}

export interface SnapMsg {
  t: 'snap';
  id: number;
  limits: Limits;
  budgetMs: number;
}

/** reply to a child's NetReq */
export interface NetReply {
  t: 'netr';
  rid: number;
  error?: string;
  url?: string;
  status?: number;
  statusText?: string;
  headers?: [string, string][];
  body?: Uint8Array;
  redirected?: boolean;
  /** current document.cookie string for the page */
  cookie?: string;
}

export type ToChild = LoadMsg | ActMsg | SnapMsg | NetReply | { t: 'ping'; id: number };

export type NetKind = 'script' | 'style' | 'xhr';

export interface NetReq {
  t: 'net';
  rid: number;
  kind: NetKind;
  url: string;
  method: string;
  headers: [string, string][];
  body?: Uint8Array | null;
  /** fetch credentials mode; scripts and styles behave like 'include' */
  credentials: 'omit' | 'same-origin' | 'include';
  mode: 'cors' | 'no-cors' | 'same-origin' | 'navigate';
}

export interface NavIntent {
  url: string;
  method: 'GET' | 'POST';
  body?: Uint8Array;
  contentType?: string;
  /** history.back() across documents: how many documents to go back (negative) */
  delta?: number;
  replace?: boolean;
  why: 'link' | 'form' | 'script' | 'refresh' | 'history';
}

export interface PageStats {
  /** virtual ms skipped by clock jumps */
  skippedMs: number;
  tasks: number;
  wallMs: number;
  requests: number;
  nodes: number;
  truncated: boolean;
  /** why the settle loop stopped */
  stop: string;
  rssMb: number;
}

export interface PageResult {
  t: 'res';
  id: number;
  ok: true;
  url: string;
  doc?: Doc;
  events: string[];
  escalate?: string;
  nav?: NavIntent;
  /** a `back` that could not be served inside the document */
  noHistory?: boolean;
  local: Record<string, string>;
  session: Record<string, string>;
  /** next free node id */
  idNext: number;
  stats: PageStats;
}

export interface PageError {
  t: 'res';
  id: number;
  ok: false;
  code: string;
  message: string;
  hint?: string;
}

export type FromChild =
  | { t: 'ready'; pid: number }
  | { t: 'pong'; id: number; rssMb: number }
  | PageResult
  | PageError
  | NetReq
  | { t: 'cookie'; value: string }
  | { t: 'netc'; rid: number };
