// A short list of hosts that only ever serve analytics, ads or session recording. Requests to
// them (and to their subdomains) are dropped: they cost time and memory and tell the agent
// nothing. This is not an ad blocker; it is the handful of names behind most third-party noise.

export const TRACKER_HOSTS: readonly string[] = [
  'google-analytics.com',
  'googletagmanager.com',
  'googletagservices.com',
  'googlesyndication.com',
  'googleadservices.com',
  'doubleclick.net',
  'adservice.google.com',
  'connect.facebook.net',
  'analytics.twitter.com',
  'static.ads-twitter.com',
  'ads.linkedin.com',
  'snap.licdn.com',
  'bat.bing.com',
  'clarity.ms',
  'hotjar.com',
  'hotjar.io',
  'fullstory.com',
  'mouseflow.com',
  'crazyegg.com',
  'cdn.segment.com',
  'api.segment.io',
  'mixpanel.com',
  'cdn.amplitude.com',
  'api.amplitude.com',
  'api2.amplitude.com',
  'heapanalytics.com',
  'scorecardresearch.com',
  'quantserve.com',
  'chartbeat.com',
  'chartbeat.net',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'adsrvr.org',
  'amazon-adsystem.com',
  'moatads.com',
  'nr-data.net',
  'js-agent.newrelic.com',
  'browser-intake-datadoghq.com',
  'analytics.tiktok.com',
  'ads.pinterest.com',
  'ct.pinterest.com',
  'sc-static.net',
  'tr.snapchat.com',
  'stats.g.doubleclick.net',
  'plausible.io',
  'matomo.cloud',
];

/** Build a matcher: true when `host` is one of the names or a subdomain of one. */
export function hostMatcher(hosts: readonly string[]): (host: string) => boolean {
  const set = new Set(hosts.map((h) => h.toLowerCase().replace(/^\.+/, '')));
  if (!set.size) return () => false;
  return (host: string) => {
    let h = host.toLowerCase();
    for (;;) {
      if (set.has(h)) return true;
      const dot = h.indexOf('.');
      if (dot === -1) return false;
      h = h.slice(dot + 1);
    }
  };
}
