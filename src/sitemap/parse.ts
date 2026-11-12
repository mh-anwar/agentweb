// robots.txt and sitemap parsing for map(). Small and forgiving: real files are messy.

import { gunzipSync } from 'node:zlib';

export interface Robots {
  /** `Sitemap:` lines (absolute URLs) */
  sitemaps: string[];
  /** may an agent with our user-agent fetch this path (+query)? */
  allows(pathAndQuery: string): boolean;
  /** number of rules that apply to us (0 = robots.txt says nothing about us) */
  rules: number;
}

interface Rule {
  allow: boolean;
  pattern: string;
  re: RegExp;
}

function compileRule(pattern: string): RegExp {
  // '*' matches anything, a trailing '$' anchors the end; everything else is literal
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

/** Rules of the group(s) naming our user-agent, else the `*` group. The longest matching rule wins; allow wins a tie. */
export function parseRobots(text: string, agent = 'agentweb'): Robots {
  const sitemaps: string[] = [];
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | undefined;
  let lastWasAgent = false;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'sitemap') {
      if (/^https?:\/\//i.test(val)) sitemaps.push(val);
      continue;
    }
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if ((key === 'allow' || key === 'disallow') && cur) {
      if (!val) continue; // an empty Disallow allows everything; an empty Allow says nothing
      cur.rules.push({ allow: key === 'allow', pattern: val, re: compileRule(val) });
    }
  }
  const a = agent.toLowerCase();
  const named = groups.filter((g) => g.agents.some((x) => x !== '*' && a.includes(x)));
  const rules = (named.length ? named : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
  return {
    sitemaps,
    rules: rules.length,
    allows(path: string): boolean {
      let best: Rule | undefined;
      for (const r of rules) {
        if (!r.re.test(path)) continue;
        if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
      }
      return !best || best.allow;
    },
  };
}

// ───────────────────────────── sitemaps ─────────────────────────────

export interface SitemapDoc {
  kind: 'index' | 'urls';
  locs: string[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) =>
  s
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m)))
    .trim();

/** <sitemapindex> -> the sitemaps it lists; <urlset> -> page URLs; a plain list of URLs, one per line, also works. */
export function parseSitemap(text: string): SitemapDoc | undefined {
  const body = text.replace(/^﻿/, '');
  const index = /<sitemapindex[\s>]/i.test(body);
  if (index || /<urlset[\s>]/i.test(body)) {
    const locs: string[] = [];
    for (const m of body.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
      const u = decode(m[1]);
      if (/^https?:\/\//i.test(u)) locs.push(u);
    }
    return { kind: index ? 'index' : 'urls', locs };
  }
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length && lines.every((l) => /^https?:\/\/\S+$/i.test(l))) return { kind: 'urls', locs: lines };
  return undefined;
}

/** A .xml.gz sitemap arrives as bytes: inflate it (bounded: a zip bomb must not eat the machine). */
export function inflateSitemap(bytes: Uint8Array): string | undefined {
  try {
    const buf = Buffer.from(bytes);
    if (buf[0] !== 0x1f || buf[1] !== 0x8b) return undefined;
    return gunzipSync(buf, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8');
  } catch {
    return undefined;
  }
}
