// The default provider set, best first. Keyed providers switch themselves on when their
// environment variable is present; everything else works without configuration.

import type { Provider } from './provider.ts';
import { braveApi, googleCse, searxng, serper, tavily } from './providers/keyed.ts';
import { github, hackerNews, stackExchange, wikipedia } from './providers/vertical.ts';
import { bing, bingHtml, brave, ddg, ddgLite, mwmbl, seznam, yahoo } from './providers/web.ts';

export function defaultProviders(): Provider[] {
  return [
    // keyed (available only when configured)
    braveApi(), googleCse(), searxng(), serper(), tavily(),
    // keyless web, in fallback order
    bing(), brave(), ddg(), yahoo(), seznam(), ddgLite(), bingHtml(), mwmbl(),
    // verticals, added by intent or site:
    wikipedia(), github(), stackExchange(), hackerNews(),
  ];
}
