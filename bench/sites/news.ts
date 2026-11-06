// /news/ — a link aggregator in nested tables, in the style of classic link-aggregator sites:
// 30 stories per page, comment threads, "More" pagination, login by form POST, and voting that
// requires a login (vote links are GETs with an auth token, as on the real thing).
import type { Ctx } from './core.ts';
import { intParam } from './core.ts';
import { esc } from './html.ts';
import { hashHex } from './rng.ts';
import type { Story } from './truth.ts';
import { newsRank } from './truth.ts';

const PER_PAGE = 30;

function ago(min: number): string {
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} hour${Math.floor(min / 60) === 1 ? '' : 's'} ago`;
  return `${Math.floor(min / 1440)} day${Math.floor(min / 1440) === 1 ? '' : 's'} ago`;
}

const CSS = `body{font-family:Verdana,Geneva,sans-serif;font-size:10pt;color:#828282;margin:0;background:#fff}
#hnmain{width:85%;background:#f6f6ef;margin:8px auto}td{font-family:Verdana,Geneva,sans-serif;font-size:10pt;color:#828282;border:0;padding:0}
.pagetop{color:#222}.pagetop a{color:#000;text-decoration:none}.hnname{font-weight:bold;margin-right:10px}
.title,.titleline{font-size:10pt;color:#828282}.titleline a{color:#000;text-decoration:none}.rank{text-align:right;color:#828282}
.subtext{font-size:7pt;color:#828282}.subtext a{color:#828282;text-decoration:none}.score{color:#828282}
.sitebit a{color:#828282;font-size:8pt;text-decoration:none}.votearrow{width:10px;height:10px;border:0;margin:3px 2px 6px;background:#9a9a9a;clip-path:polygon(50% 0,0 100%,100% 100%)}
.comment{margin:4px 0 8px}.commtext{color:#000;font-size:9pt}.comhead{font-size:8pt;color:#828282}.comhead a{color:#828282;text-decoration:none}
.yclinks a{color:#828282}.morelink{color:#000;text-decoration:none}input{font-family:monospace;font-size:10pt}`;

function authToken(c: Ctx, user: string, id: number): string {
  return hashHex(c.truth.seed, 'vote', user, id).slice(0, 16);
}

function currentUser(c: Ctx): string | undefined {
  return c.session('news', false)?.user as string | undefined;
}

function pageShell(c: Ctx, title: string, inner: string): string {
  const user = currentUser(c);
  const u = user ? c.truth.news.users.find((x) => x.id === user)! : undefined;
  return `<!doctype html><html lang="en" op="news"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><center><table id="hnmain" border="0" cellpadding="0" cellspacing="0" width="85%" bgcolor="#f6f6ef">
<tr><td bgcolor="#ff6600"><table border="0" cellpadding="0" cellspacing="0" width="100%" style="padding:2px"><tr>
<td style="width:18px;padding-right:4px"><a href="/news/"><img src="/news/y18.svg" width="18" height="18" style="border:1px white solid;display:block" alt="Y"></a></td>
<td style="line-height:12pt;height:10px;" class="pagetop"><span class="pagetop"><b class="hnname"><a href="/news/">Hacker Digest</a></b>
<a href="/news/newest">new</a> | <a href="/news/threads">threads</a> | <a href="/news/ask">ask</a> | <a href="/news/show">show</a> | <a href="/news/submit">submit</a></span></td>
<td style="text-align:right;padding-right:4px" class="pagetop">${user ? `<a href="/news/user?id=${esc(user)}">${esc(user)}</a> (${u!.karma}) | <a href="/news/logout?goto=news">logout</a>` : '<a href="/news/login?goto=news">login</a>'}</td></tr></table></td></tr>
<tr id="pagespace" title="" style="height:10px"></tr>
${inner}
<tr><td><img src="/news/s.gif" height="10" width="0" alt=""><table width="100%" cellspacing="0" cellpadding="1"><tr><td bgcolor="#ff6600"></td></tr></table><br>
<center><span class="yclinks"><a href="/news/info/guidelines">Guidelines</a> | <a href="/news/info/faq">FAQ</a> | <a href="/news/info/lists">Lists</a> | <a href="/news/info/api">API</a> | <a href="/news/info/security">Security</a> | <a href="/news/info/legal">Legal</a> | <a href="/news/info/apply">Apply</a> | <a href="/news/info/contact">Contact</a></span><br><br>
<form method="get" action="/news/search">Search: <input type="text" name="q" size="17" autocorrect="off" spellcheck="false" autocapitalize="off" autocomplete="off"></form></center></td></tr>
</table></center></body></html>`;
}

function storyRows(c: Ctx, s: Story, rank: number | null, goto: string): string {
  const pts = c.rt.newsPoints.get(s.id)!;
  const user = currentUser(c);
  const voted = user ? c.rt.newsVoted.has(`${user}:${s.id}`) : false;
  const n = s.comments.length;
  const up = voted ? '' : `<a id="up_${s.id}" href="vote?id=${s.id}&amp;how=up&amp;auth=${user ? authToken(c, user, s.id) : 'x'}&amp;goto=${esc(encodeURIComponent(goto))}"><div class="votearrow" title="upvote"></div></a>`;
  return `<tr class="athing" id="${s.id}"><td align="right" valign="top" class="title"><span class="rank">${rank === null ? '' : rank + '.'}</span></td>
<td valign="top" class="votelinks"><center>${up}</center></td>
<td class="title"><span class="titleline"><a href="${esc(s.url)}">${esc(s.title)}</a><span class="sitebit comhead"> (<a href="from?site=${esc(s.domain)}"><span class="sitestr">${esc(s.domain)}</span></a>)</span></span></td></tr>
<tr><td colspan="2"></td><td class="subtext"><span class="subline"><span class="score" id="score_${s.id}">${pts} point${pts === 1 ? '' : 's'}</span> by <a href="user?id=${esc(s.user)}" class="hnuser">${esc(s.user)}</a>
<span class="age" title="${s.ageMin}m"><a href="item?id=${s.id}">${ago(s.ageMin)}</a></span> | <a href="hide?id=${s.id}">hide</a> | <a href="item?id=${s.id}">${n === 0 ? 'discuss' : `${n}&nbsp;comment${n === 1 ? '' : 's'}`}</a></span></td></tr>
<tr class="spacer" style="height:5px"></tr>`;
}

function listing(c: Ctx, kind: 'front' | 'newest'): void {
  const t = c.truth.news;
  const ranked = kind === 'front' ? newsRank(t.stories, (s) => c.rt.newsPoints.get(s.id)!) : t.stories.slice().sort((a, b) => a.ageMin - b.ageMin || a.id - b.id);
  const pages = Math.ceil(ranked.length / PER_PAGE);
  const p = intParam(c.q.get('p'), 1, 1, pages);
  const slice = ranked.slice((p - 1) * PER_PAGE, p * PER_PAGE);
  const path = kind === 'front' ? 'news' : 'newest';
  const rows = slice.map((s, i) => storyRows(c, s, (p - 1) * PER_PAGE + i + 1, kind === 'front' ? 'news' : 'newest')).join('\n');
  const more = p < pages ? `<tr class="morespace" style="height:10px"></tr><tr><td colspan="2"></td><td class="title"><a href="${path}?p=${p + 1}" class="morelink" rel="next">More</a></td></tr>` : '';
  c.html(pageShell(c, kind === 'front' ? 'Hacker Digest' : 'New Links | Hacker Digest', `<tr id="bigbox"><td><table border="0" cellpadding="0" cellspacing="0">${rows}${more}</table></td></tr>`));
}

function commentRows(c: Ctx, s: Story): string {
  return s.comments.map((cm) => `<tr class="athing comtr" id="${cm.id}"><td><table border="0"><tr>
<td class="ind" indent="${cm.depth}"><img src="/news/s.gif" height="1" width="${cm.depth * 40}" alt=""></td>
<td valign="top" class="votelinks"><center><a id="up_${cm.id}" href="vote?id=${cm.id}&amp;how=up&amp;goto=item%3Fid%3D${s.id}"><div class="votearrow" title="upvote"></div></a></center></td>
<td class="default"><div style="margin-top:2px;margin-bottom:-10px"><span class="comhead"><a href="user?id=${esc(cm.user)}" class="hnuser">${esc(cm.user)}</a> <span class="age"><a href="item?id=${cm.id}">${ago(cm.ageMin)}</a></span></span></div><br>
<div class="comment"><span class="commtext c00">${esc(cm.text)}</span></div></td></tr></table></td></tr>`).join('\n');
}

function itemPage(c: Ctx, id: number): void {
  const s = c.truth.news.stories.find((x) => x.id === id);
  if (!s) {
    const parentStory = c.truth.news.stories.find((x) => x.comments.some((cm) => cm.id === id));
    if (parentStory) return c.redirect(`/news/item?id=${parentStory.id}`, 302);
    return c.html(pageShell(c, 'No such item', '<tr><td>No such item.</td></tr>'), 404);
  }
  c.html(pageShell(c, `${s.title} | Hacker Digest`, `<tr id="bigbox"><td><table class="fatitem" border="0">${storyRows(c, s, null, `item?id=${s.id}`)}
<tr><td colspan="2"></td><td><form method="post" action="comment"><textarea name="text" rows="6" cols="60"></textarea><br><br><input type="submit" value="add comment"></form></td></tr></table><br><br>
<table border="0" class="comment-tree">${commentRows(c, s)}</table></td></tr>`));
}

async function loginHandler(c: Ctx): Promise<void> {
  const goto = c.q.get('goto') ?? 'news';
  const form = (msg = '', gotoVal = goto) => c.html(pageShell(c, 'Login | Hacker Digest', `<tr><td>${msg ? `<b>${esc(msg)}</b><br><br>` : ''}<b>Login</b><br><br>
<form action="/news/login" method="post"><input type="hidden" name="goto" value="${esc(gotoVal)}"><table border="0"><tr><td>username:</td><td><input type="text" name="acct" size="20" autocorrect="off" spellcheck="false" autocapitalize="off" autofocus="true"></td></tr>
<tr><td>password:</td><td><input type="password" name="pw" size="20"></td></tr></table><br><input type="submit" value="login"></form></td></tr>`));
  if (c.method !== 'POST') return form();
  const f = await c.form();
  const acct = f.get('acct').trim();
  const u = c.truth.news.users.find((x) => x.id === acct);
  const ok = !!u && u.password === f.get('pw');
  c.rt.state.logins.push({ site: 'news', user: acct, ok });
  if (!ok) return form('Bad login.', f.get('goto') || 'news');
  c.session('news')!.user = u!.id;
  const g = f.get('goto') || 'news';
  c.redirect('/news/' + (/^[a-z?=&0-9%A-Z_.-]+$/.test(g) && !g.includes('..') ? decodeURIComponent(g) : 'news'), 302);
}

function vote(c: Ctx): void {
  const id = Number(c.q.get('id'));
  const goto = c.q.get('goto') ?? 'news';
  const user = currentUser(c);
  if (!user) return c.redirect(`/news/login?goto=${encodeURIComponent(goto)}`, 302);
  const s = c.truth.news.stories.find((x) => x.id === id);
  if (!s) return c.html(pageShell(c, 'Error', '<tr><td>Can\'t vote on that item.</td></tr>'), 400);
  if (c.q.get('auth') !== authToken(c, user, id)) return c.html(pageShell(c, 'Error', '<tr><td>Bad or missing auth token.</td></tr>'), 403);
  const key = `${user}:${id}`;
  if (!c.rt.newsVoted.has(key)) {
    c.rt.newsVoted.add(key);
    c.rt.newsPoints.set(id, c.rt.newsPoints.get(id)! + 1);
    c.rt.state.votes.push({ user, storyId: id });
  }
  c.redirect('/news/' + (/^[a-z?=&0-9%A-Z_.-]+$/.test(goto) ? decodeURIComponent(goto) : 'news'), 302);
}

export async function handle(c: Ctx, rest: string): Promise<void> {
  const t = c.truth.news;
  if (rest === '/' || rest === '' || rest === '/news') return listing(c, 'front');
  if (rest === '/newest') return listing(c, 'newest');
  if (rest === '/item') return itemPage(c, Number(c.q.get('id')));
  if (rest === '/login') return loginHandler(c);
  if (rest === '/vote') return vote(c);
  if (rest === '/logout') { const s = c.session('news', false); if (s) s.user = undefined; return c.redirect('/news/', 302); }
  if (rest === '/user') {
    const u = t.users.find((x) => x.id === c.q.get('id'));
    if (!u) return c.html(pageShell(c, 'Profile: unknown', '<tr><td>No such user.</td></tr>'), 404);
    return c.html(pageShell(c, `Profile: ${u.id} | Hacker Digest`, `<tr><td><table border="0"><tr><td valign="top">user:</td><td>${esc(u.id)}</td></tr><tr><td valign="top">created:</td><td>${u.created}</td></tr>
<tr><td valign="top">karma:</td><td>${u.karma}</td></tr><tr><td valign="top">about:</td><td>${esc(u.about)}</td></tr></table></td></tr>`));
  }
  if (rest === '/s.gif') return c.send(200, { 'Content-Type': 'image/gif' }, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  if (rest === '/y18.svg') return c.send(200, { 'Content-Type': 'image/svg+xml' }, '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><rect width="18" height="18" fill="#ff6600"/><text x="4" y="14" fill="#fff" font-size="13">Y</text></svg>');
  if (['/threads', '/ask', '/show', '/submit', '/hide', '/from', '/search', '/comment'].includes(rest) || rest.startsWith('/info/')) {
    return c.html(pageShell(c, 'Hacker Digest', `<tr><td><p>${esc(rest.replace(/^\/(info\/)?/, ''))}: nothing to see here.</p></td></tr>`));
  }
  c.notFound();
}
