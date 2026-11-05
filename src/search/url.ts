// URL hygiene for search results: unwrap redirect wrappers, strip tracking noise, and build a
// canonical key for de-duplication. Pure functions, no I/O.

/** Query parameters that only ever carry tracking/attribution state, on any host. */
const TRACK_EXACT = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'ttclid', 'twclid', 'li_fat_id',
  'igshid', 'igsh', 'mc_cid', 'mc_eid', '_ga', '_gl', '_hsenc', '_hsmi', '__hstc', '__hssc', '__hsfp', 'hsctatracking',
  'mkt_tok', 'oly_anon_id', 'oly_enc_id', 'vero_conv', 'vero_id', 'wickedid', 'rb_clickid', 'irclickid', 'zanpid',
  'epik', 'sccid', 'srsltid', 'ref', 'ref_src', 'ref_url', 'referrer', 'referer', 'xtor', 'ncid', 'sr_share', 'spm',
  'scm', 'trk', 'trkcampaign', 'trackingid', 'cmpid', 'campaignid', 'adgroupid', 'adid', 'ocid', 'cvid', 'ito',
  'at_medium', 'at_campaign', 'at_custom1', 'at_custom2', 'at_custom3', 'at_custom4', 'ga_source', 'ga_medium',
  'ga_campaign', 'ga_content', 'ga_term', 'icid', 'int_cmp', 'utm', 's_cid', 'soc_src', 'soc_trk',
  'guccounter', 'guce_referrer', 'guce_referrer_sig', 'share_from', 'fb_action_ids', 'fb_action_types', 'fb_source',
  'fb_ref', 'action_object_map', 'action_type_map', 'action_ref_map', 'mibextid', 'share_id', '__twitter_impression',
]);
const TRACK_PREFIX = ['utm_', 'pk_', 'piwik_', 'mtm_', 'matomo_', 'hsa_', 'oly_', 'vero_', 'fb_', 'ga_', '_branch_'];
/** Parameters that are tracking only on specific hosts (they mean something elsewhere). */
const TRACK_BY_HOST: [RegExp, Set<string>][] = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, new Set(['si', 'pp', 'feature', 'ab_channel', 'embeds_referring_euri', 'embeds_referring_origin'])],
  [/(^|\.)google\.[a-z.]+$/, new Set(['ved', 'usg', 'ei', 'oq', 'gs_lcp', 'gs_lp', 'sca_esv', 'sca_upv', 'rlz', 'sxsrf', 'uact', 'sclient', 'sourceid', 'ie', 'bih', 'biw', 'dpr', 'prmd', 'sa', 'source'])],
  [/(^|\.)spotify\.com$/, new Set(['si', 'context', 'nd', 'dl_branch'])],
  [/(^|\.)amazon\.[a-z.]+$/, new Set(['tag', 'linkcode', 'creative', 'creativeasin', 'linkid', 'ascsubtag', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pd_rd_i', 'pf_rd_p', 'pf_rd_r', 'pf_rd_s', 'pf_rd_t', 'pf_rd_i', 'pf_rd_m', 'qid', 'sr', 'sprefix', 'crid', 'keywords', 'dib', 'dib_tag', 'th', 'psc', 'content-id', 'smid', 'social_share', 'starsleft', 'skipsupplementalfees'])],
  [/(^|\.)(twitter\.com|x\.com)$/, new Set(['s', 't', 'src', 'cxt'])],
  [/(^|\.)instagram\.com$/, new Set(['img_index', 'utm_source'])],
  [/(^|\.)reddit\.com$/, new Set(['share_id', 'utm_name', 'context', 'rdt'])],
  [/(^|\.)linkedin\.com$/, new Set(['trackingid', 'refid', 'lipi', 'midtoken', 'midsig', 'trk', 'trkemail', 'eid', 'originalsubdomain'])],
  [/(^|\.)medium\.com$/, new Set(['source', 'sk'])],
  [/(^|\.)tiktok\.com$/, new Set(['is_from_webapp', 'sender_device', 'sender_web_id', 'is_copy_url', '_r', '_t'])],
  [/(^|\.)facebook\.com$/, new Set(['__tn__', '__cft__', '__xts__', 'mibextid', 'rdid', 'sfnsn'])],
];
/** Fragments that carry no location: empty, "top", text directives, tracking. */
const JUNK_FRAGMENT = /^(?:$|top$|main$|content$|maincontent$|main-content$|skip$|:~:|xtor=|utm_|ref=|at_|intcid=|ns_|\.)/i;

const WRAPPER_PARAMS: [RegExp, RegExp, string[]][] = [
  // host, path, candidate param names (first present wins)
  [/(^|\.)duckduckgo\.com$/, /^\/l\/?$/, ['uddg']],
  [/(^|\.)google\.[a-z.]+$/, /^\/(url|imgres|aclk)$/, ['q', 'url', 'imgurl', 'adurl']],
  [/(^|\.)youtube\.com$/, /^\/redirect$/, ['q']],
  [/^l\.(facebook|instagram|messenger)\.com$/, /^\/l\.php$/, ['u']],
  [/^lm\.facebook\.com$/, /^\/l\.php$/, ['u']],
  [/(^|\.)safelinks\.protection\.outlook\.com$/, /^\//, ['url']],
  [/^out\.reddit\.com$/, /^\//, ['url']],
  [/^(www\.)?slack-redir\.net$/, /^\/link$/, ['url']],
  [/(^|\.)vk\.com$/, /^\/away\.php$/, ['to']],
  [/(^|\.)steamcommunity\.com$/, /^\/linkfilter\/?$/, ['url', 'u']],
  [/^href\.li$/, /^\/$/, []],
  [/(^|\.)startpage\.com$/, /^\/do\/(proxy|mlink)/, ['u', 'ep']],
  [/(^|\.)search\.brave\.com$/, /^\/redirect$/, ['url']],
  [/(^|\.)mojeek\.com$/, /^\/redirect$/, ['url']],
  [/(^|\.)exit\.sc$/, /^\/$/, ['url']],
  [/(^|\.)linkedin\.com$/, /^\/redir\/redirect\/?$/, ['url']],
  [/(^|\.)t\.umblr\.com$/, /^\/redirect$/, ['z']],
  [/(^|\.)deviantart\.com$/, /^\/users\/outgoing$/, []],
];

function tryUrl(s: string, base?: string): URL | undefined {
  try {
    return new URL(s, base);
  } catch {
    return undefined;
  }
}

const isHttp = (u: URL | undefined): u is URL => !!u && (u.protocol === 'http:' || u.protocol === 'https:');

/** Base64url (or standard base64) → UTF-8, or undefined if it does not decode to a URL. */
function b64url(s: string): string | undefined {
  try {
    const t = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//i.test(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

/** One level of redirect-wrapper decoding; undefined if `u` is not a known wrapper. */
function unwrapOnce(u: URL): string | undefined {
  const host = u.hostname.toLowerCase();
  const p = u.searchParams;
  // Bing: /ck/a?...&u=a1<base64url of destination>
  if (/(^|\.)bing\.com$/.test(host) && /^\/ck\/a/.test(u.pathname)) {
    const v = p.get('u');
    if (v && /^a1/.test(v)) return b64url(v.slice(2));
    return undefined;
  }
  // Yahoo: r.search.yahoo.com/_ylt=...;_ylu=.../RV=2/RE=.../RO=10/RU=<encoded dest>/RK=2/RS=...
  if (/(^|\.)yahoo\.com$/.test(host) && /\/RU=/.test(u.pathname)) {
    const m = /\/RU=([^/]+)\//.exec(u.pathname + '/');
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return undefined;
      }
    }
  }
  for (const [h, path, names] of WRAPPER_PARAMS) {
    if (!h.test(host) || !path.test(u.pathname)) continue;
    if (!names.length) {
      // href.li/?https://dest and deviantart outgoing?https://dest: the whole query is the target
      const raw = u.search.slice(1);
      try {
        const d = decodeURIComponent(raw);
        if (/^https?:\/\//i.test(d)) return d;
      } catch {}
      return undefined;
    }
    for (const n of names) {
      const v = p.get(n);
      if (v && /^(https?:)?\/\//i.test(v)) return v.startsWith('//') ? 'https:' + v : v;
      if (v && n === 'ep') return b64url(v);
    }
  }
  return undefined;
}

/** Follow known redirect wrappers (up to three nested) to the real destination. */
export function unwrap(url: string, base?: string): string {
  let cur = url.trim();
  for (let i = 0; i < 3; i++) {
    const u = tryUrl(cur.startsWith('//') ? 'https:' + cur : cur, base);
    if (!isHttp(u)) return cur;
    const next = unwrapOnce(u);
    if (!next) return u.href;
    cur = next;
  }
  return cur;
}

function trackingParam(name: string, host: string): boolean {
  const n = name.toLowerCase();
  if (TRACK_EXACT.has(n)) return true;
  for (const p of TRACK_PREFIX) if (n.startsWith(p)) return true;
  for (const [h, set] of TRACK_BY_HOST) if (h.test(host) && set.has(n)) return true;
  return false;
}

/**
 * Canonicalise a URL for display and de-duplication: unwrap redirect wrappers, drop tracking
 * parameters, meaningless fragments, default ports, empty queries and the root slash. Paths keep
 * their trailing slash (removing it is not safe in general: relative links resolve differently);
 * `urlKey` ignores it. Non-http(s) and unparseable input comes back trimmed and otherwise untouched.
 */
export function cleanUrl(url: string): string {
  const raw = unwrap(url);
  const u = tryUrl(raw);
  if (!isHttp(u)) return raw;
  const host = u.hostname;
  u.username = '';
  u.password = '';
  if (u.search) {
    const keep: [string, string][] = [];
    for (const [k, v] of u.searchParams) if (!trackingParam(k, host)) keep.push([k, v]);
    if (keep.length !== [...u.searchParams.keys()].length) {
      // rebuild only when something was removed, so untouched queries keep their exact encoding
      u.search = keep.length ? '?' + keep.map(([k, v]) => enc(k) + (v === '' && !hasEq(u.search, k) ? '' : '=' + enc(v))).join('&') : '';
    }
    if (u.search === '?') u.search = '';
  }
  // Amazon-style "/ref=sr_1_1" path segments are pure tracking
  if (/(^|\.)amazon\.[a-z.]+$/.test(host)) u.pathname = u.pathname.replace(/\/ref=[^/]*$/, '');
  if (u.hash) {
    const f = u.hash.slice(1);
    // keep hash-routes (#/x, #!/x) and real anchors; drop the rest
    if (!/^!?\//.test(f) && JUNK_FRAGMENT.test(f)) u.hash = '';
  }
  let s = u.href;
  // a bare "#" or "?" survives in href even when hash/search read as ''
  if (!u.hash) s = s.replace(/#$/, '');
  if (!u.search) s = s.replace(/\?(?=#|$)/, '');
  if (u.pathname === '/' && !u.search && !u.hash) s = s.replace(/\/$/, '');
  return s;
}

const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
const hasEq = (search: string, k: string) => new RegExp('(?:^\\?|&)' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=').test(search);

/**
 * Identity of a result for de-duplication: scheme, "www."/"m." prefixes, trailing slashes,
 * index files, fragments (except hash routes), AMP variants and parameter order are ignored.
 */
export function urlKey(url: string): string {
  const c = cleanUrl(url);
  const u = tryUrl(c);
  if (!isHttp(u)) return c.toLowerCase();
  let host = u.hostname.toLowerCase().replace(/^(www\d*|m|mobile|amp)\./, '');
  host = host.replace(/\.m\.(wikipedia|wiktionary|wikibooks|wikiquote|wikivoyage|wikimedia)\.org$/, '.$1.org');
  let path = u.pathname;
  try {
    path = decodeURI(path);
  } catch {}
  path = path.replace(/\/(index|default)\.(html?|php|aspx?)$/i, '/').replace(/\/amp\/?$/i, '/').replace(/\/+$/, '');
  if (/(^|\.)wikipedia\.org$/.test(host)) path = path.replace(/ /g, '_');
  const params = [...u.searchParams].filter(([k]) => k !== 'amp' && k !== 'outputType').sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  const q = params.length ? '?' + params.map(([k, v]) => k + '=' + v).join('&') : '';
  const h = /^#!?\//.test(u.hash) ? u.hash : '';
  return host + path + q + h;
}

/** Host without "www.", for display. */
export function hostOf(url: string): string {
  const u = tryUrl(url);
  return u ? u.hostname.replace(/^www\./, '') : '';
}

/** Does `host` equal `domain` or sit under it? (`docs.python.org` is under `python.org`) */
export function underDomain(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, '');
  const d = domain.toLowerCase().replace(/^\*?\.?/, '').replace(/^www\./, '');
  return h === d || h.endsWith('.' + d);
}
