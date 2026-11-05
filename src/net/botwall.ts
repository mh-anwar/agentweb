// Recognise bot walls and challenge interstitials. The wire tier never tries to get past them; it
// reports the vendor so the runtime can decide (escalate a GET, or tell the agent).

export interface WallInput {
  status: number;
  headers: Record<string, string>;
  /** decoded body text (only the first ~64 KB are looked at) */
  text: string;
  mime: string;
}

const SCAN = 64 * 1024;

const CF_BODY = /<title>\s*(?:just a moment|attention required!? \| cloudflare|please wait\.\.\.|checking your browser)|_cf_chl_opt|\/cdn-cgi\/challenge-platform\/|cf-browser-verification|cf_chl_prog|id="cf-error-details"|cf-turnstile-wrapper|challenges\.cloudflare\.com\/turnstile/i;
const DATADOME_BODY = /(?:geo|ct)\.captcha-delivery\.com|datadome\.co\/captcha|dd=\{['"]?(?:rt|cid)['"]?\s*:/i;
const PX_BODY = /_pxCaptcha|px-captcha|window\._pxAppId|perimeterx|captcha\.px-cdn\.net|\/_px\d?\/|press\s*(?:&amp;|&)\s*hold/i;
const AKAMAI_BODY = /errors\.edgesuite\.net|<title>\s*access denied\s*<\/title>[^]*you don't have permission to access[^]*reference\s*#|ak_bmsc|bm-verify|_abck=/i;
const IMPERVA_BODY = /incapsula incident id|_incapsula_resource|\/_incapsula_|imperva|<iframe[^>]+src="[^"]*_Incapsula_Resource/i;
const CAPTCHA_WIDGET = /class="g-recaptcha|www\.google\.com\/recaptcha\/(?:api|enterprise)|class="h-captcha|hcaptcha\.com\/1\/api|class="cf-turnstile|challenges\.cloudflare\.com\/turnstile|arkoselabs\.com|funcaptcha|geetest|friendlycaptcha/i;
const HUMAN_CHECK = /verify (?:that )?you(?:'re| are) (?:a )?human|are you a (?:human|robot)|confirm you are not a robot|i(?:'m| am) not a robot|unusual traffic from your computer|automated (?:queries|requests|access)|please (?:complete|solve) the (?:security check|captcha)|security check to access|enable javascript and cookies to continue|bot (?:detection|protection|check)|access to this page has been denied|checking if the site connection is secure|ddos protection by/i;
const JS_REQUIRED = /enable javascript|javascript is (?:disabled|required)|requires javascript|turn on javascript/i;

const SUSPECT = /just a moment|attention required|please wait|checking (?:your browser|if the site)|_cf_chl|challenge-platform|cf-browser-verification|cf-error-details|turnstile|captcha|_px|perimeterx|press\s*(?:&amp;|&)\s*hold|edgesuite|ak_bmsc|bm-verify|_abck|incapsula|imperva|awswaf|aws-waf|recaptcha|hcaptcha|arkoselabs|geetest|human|robot|unusual traffic|automated (?:queries|requests|access)|security check|enable javascript|javascript is|requires javascript|turn on javascript|bot (?:detection|protection|check)|has been denied|ddos protection|dd=\{|access denied/i;

const visibleLength = (html: string) =>
  html.replace(/<(script|style|noscript)\b[^]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;

/** Returns the vendor name if the response is a bot wall, else undefined. */
export function detectBotWall(r: WallInput): string | undefined {
  const h = r.headers;
  const status = r.status;
  const t = r.text.length > SCAN ? r.text.slice(0, SCAN) : r.text;
  const server = (h.server ?? '').toLowerCase();

  // explicit vendor headers are the strongest signal
  if (h['cf-mitigated'] === 'challenge') return 'cloudflare';
  if (h['x-datadome'] || h['x-dd-b'] || (status >= 400 && /datadome/i.test(h['set-cookie'] ?? ''))) {
    if (status === 403 || status === 401 || status === 429 || DATADOME_BODY.test(t)) return 'datadome';
  }
  if (h['x-px-blocked'] || (status === 403 && h['x-px'])) return 'perimeterx';

  const challengeStatus = status === 403 || status === 429 || status === 503 || status === 401;
  if ((server.includes('akamaighost') || h['akamai-grn'] || h['x-akamai-transformed']) && status === 403) return 'akamai';
  if ((h['x-iinfo'] || /imperva|incapsula/i.test(h['x-cdn'] ?? '')) && challengeStatus) return 'imperva';
  if (h['x-amzn-waf-action'] === 'captcha' || h['x-amzn-waf-action'] === 'challenge') return 'aws waf';

  // one cheap pass first: almost every page has none of the body markers below
  if (!SUSPECT.test(t)) return status === 429 ? 'rate limited 429' : undefined;

  if (server.includes('cloudflare') && challengeStatus && CF_BODY.test(t)) return 'cloudflare';
  if (CF_BODY.test(t) && (challengeStatus || /<title>\s*just a moment/i.test(t))) return 'cloudflare';
  if (DATADOME_BODY.test(t) && (challengeStatus || t.length < 20_000)) return 'datadome';
  if (PX_BODY.test(t) && (challengeStatus || /px-captcha|_pxCaptcha/i.test(t))) return 'perimeterx';
  if (AKAMAI_BODY.test(t) && challengeStatus) return 'akamai';
  if (IMPERVA_BODY.test(t) && (challengeStatus || /incapsula incident id|_incapsula_resource/i.test(t))) return 'imperva';
  if (challengeStatus && /awswaf|aws-waf-token|token\.awswaf\.com/i.test(t)) return 'aws waf';

  // generic CAPTCHA interstitials: a captcha widget or a "prove you are human" line on a page
  // that has little else on it (a contact form with a reCAPTCHA is not a wall)
  const markup = r.mime === 'text/html' || r.mime === 'application/xhtml+xml';
  if (markup || r.mime.startsWith('text/')) {
    let small: boolean | undefined;
    const isSmall = () => (small ??= visibleLength(t) < 1500);
    if ((CAPTCHA_WIDGET.test(t) || HUMAN_CHECK.test(t)) && (challengeStatus || isSmall())) return 'captcha';
    if (status === 403 && JS_REQUIRED.test(t) && isSmall()) return '403 challenge';
  }
  if (status === 429) return 'rate limited 429';
  return undefined;
}
