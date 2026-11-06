// The ghost engine: a browser engine for agents that runs a page's JavaScript against a DOM
// with no layout, no paint and no pixels, on a virtual clock. See engine.ts.

export { createGhostEngine, GhostEngine, REOPENED, sanitizeDoc } from './engine.ts';
export type { GhostOptions } from './engine.ts';
export { defaultFetch, documentCookie, cookieHeader, siteOf, sameSite } from './net.ts';
export type { GhostFetch, GhostRequest, GhostResponse, FetchKind, DefaultFetchOptions } from './net.ts';
export { DEFAULT_LIMITS } from './protocol.ts';
export type { Limits } from './protocol.ts';
