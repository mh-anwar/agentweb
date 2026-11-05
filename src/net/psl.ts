// A small built-in public suffix list. It is not the full PSL: it covers the generic TLDs (every
// single-label name is treated as a public suffix anyway), the second-level registries of the
// largest country codes, and the shared-hosting suffixes where one customer setting a cookie for
// the whole suffix would leak it to every other customer.

const SUFFIXES = new Set(
  `
co.uk org.uk ac.uk gov.uk me.uk ltd.uk plc.uk net.uk sch.uk nhs.uk police.uk
co.jp ne.jp or.jp ac.jp go.jp ed.jp gr.jp lg.jp
com.au net.au org.au edu.au gov.au asn.au id.au
co.nz net.nz org.nz govt.nz ac.nz school.nz
com.cn net.cn org.cn gov.cn edu.cn ac.cn
com.br net.br org.br gov.br edu.br
co.in net.in org.in gov.in ac.in edu.in firm.in
co.kr or.kr ne.kr go.kr ac.kr re.kr
com.mx net.mx org.mx gob.mx edu.mx
com.tw net.tw org.tw gov.tw edu.tw idv.tw
com.hk net.hk org.hk gov.hk edu.hk idv.hk
com.sg net.sg org.sg gov.sg edu.sg per.sg
co.za net.za org.za gov.za ac.za web.za
co.il org.il net.il ac.il gov.il muni.il
com.tr net.tr org.tr gov.tr edu.tr gen.tr
com.ar net.ar org.ar gob.ar edu.ar int.ar
com.pl net.pl org.pl gov.pl edu.pl
com.ru net.ru org.ru pp.ru msk.ru spb.ru
com.ua net.ua org.ua gov.ua in.ua kiev.ua
com.es nom.es org.es gob.es edu.es
com.pt org.pt gov.pt edu.pt
com.my net.my org.my gov.my edu.my
com.ph net.ph org.ph gov.ph edu.ph
co.id or.id web.id ac.id go.id
co.th or.th in.th ac.th go.th
com.vn net.vn org.vn gov.vn edu.vn
com.pk net.pk org.pk gov.pk edu.pk
com.ng org.ng gov.ng edu.ng
com.eg org.eg gov.eg edu.eg
com.sa net.sa org.sa gov.sa edu.sa
co.ke or.ke go.ke ac.ke
com.co net.co org.co gov.co edu.co
com.pe net.pe org.pe gob.pe edu.pe
com.ve net.ve org.ve gob.ve
gv.at co.at or.at ac.at
com.de com.fr asso.fr gouv.fr
github.io githubusercontent.com gitlab.io herokuapp.com herokussl.com appspot.com blogspot.com
cloudfront.net amazonaws.com s3.amazonaws.com elasticbeanstalk.com
azurewebsites.net azureedge.net cloudapp.net trafficmanager.net blob.core.windows.net
vercel.app now.sh netlify.app netlify.com pages.dev workers.dev r2.dev
firebaseapp.com web.app run.app cloudfunctions.net
fly.dev onrender.com glitch.me repl.co replit.dev ngrok.io ngrok-free.app ngrok.app
surge.sh bitbucket.io readthedocs.io wordpress.com tumblr.com myshopify.com
deno.dev deta.dev railway.app up.railway.app supabase.co
dyndns.org no-ip.org duckdns.org
`
    .split(/\s+/)
    .filter(Boolean),
);

/** Is `domain` (lower-case, no leading dot) a public suffix? Every single-label name is. */
export function isPublicSuffix(domain: string): boolean {
  if (!domain.includes('.')) return true;
  return SUFFIXES.has(domain);
}

/** Registrable domain ("eTLD+1") for a host, using the built-in list. IP literals return themselves. */
export function registrable(host: string): string {
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const rest = labels.slice(i + 1).join('.');
    if (isPublicSuffix(rest)) return labels.slice(i).join('.');
  }
  return host;
}
