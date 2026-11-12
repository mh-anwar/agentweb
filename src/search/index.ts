// Public surface of the search module.

export { search, fuse, intents, parseQuery, SearchState } from './search.ts';
export type { SearchOptions, SearchOutput, ParsedQuery } from './search.ts';
export { cleanUrl, unwrap, urlKey, hostOf } from './url.ts';
export { toBlocks, trimSnippet, queryTerms } from './blocks.ts';
export type { ToBlocksOptions } from './blocks.ts';
export { defaultProviders } from './defaults.ts';
export type { Provider, Vertical } from './provider.ts';
export { RateLimited } from './util.ts';
export { bing, bingHtml, brave, ddg, ddgLite, mwmbl, seznam, yahoo } from './providers/web.ts';
export { github, hackerNews, stackExchange, wikipedia } from './providers/vertical.ts';
export { braveApi, googleCse, searxng, serper, tavily } from './providers/keyed.ts';
