#!/usr/bin/env node
// The fixture app for the agentweb-vs-Playwright scoreboard: a small staff app shaped like
// Clockwork's journeys (sign-in, a "Report a problem" dialog, a students form, settings that
// change another page, a sign-up code sent by email, a photo upload, a role menu). It renders a
// skeleton and fills it from script, as a hydrating React app does.
//
//   node server.mjs [port]            MUTANT=<name> plants one bug (see ../mutants.mjs); none = correct
//
// A tiny Mailpit-compatible API is served under /mailpit (GET /mailpit/api/v1/search, /message/:id).
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 4720);
const M = process.env.MUTANT ?? '';
const on = (name) => M === name;

// ── timing: benign variants make the app slow or jittery, never wrong ──
const apiDelay = () => (on('slow') ? 1200 : on('jitter') ? Math.random() * 700 : 30);
const hydrateDelay = () => (on('slow') ? 1000 : on('jitter') ? Math.random() * 600 : 120);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── data ──
let seq = 0;
const users = new Map(); // email -> { password, role, center, name }
const sessions = new Map(); // sid -> email
const centers = new Map(); // id -> { students: [], reports: [], clock: 'either' }
const mails = []; // { ID, to, Subject, Text, Created }
const codes = new Map(); // email -> code (parent sign-up)
const id = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

function newWorld() {
  const n = id();
  const center = `c${n}`;
  centers.set(center, { students: [], reports: [], clock: 'either' });
  const email = `staff-${n}@test.example`, admin = `admin-${n}@test.example`;
  users.set(email, { password: `pw-${n}`, role: 'employee', center, name: 'Sam Staff' });
  users.set(admin, { password: `pw-${n}`, role: 'admin', center, name: 'Ivy Instructor' });
  const sid = id(), adminSid = id();
  sessions.set(sid, email);
  sessions.set(adminSid, admin);
  return { center, email, password: `pw-${n}`, admin_email: admin, admin_password: `pw-${n}`, sid, admin_sid: adminSid };
}

// ── helpers ──
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cookies = (req) => Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), decodeURIComponent(c.slice(c.indexOf('=') + 1))]));
function who(req) {
  const email = sessions.get(cookies(req).sid);
  const u = email && users.get(email);
  return u ? { email, ...u, data: centers.get(u.center) } : null;
}
async function body(req) {
  let raw = '';
  for await (const c of req) raw += c;
  if ((req.headers['content-type'] ?? '').includes('json')) return raw ? JSON.parse(raw) : {};
  return Object.fromEntries(new URLSearchParams(raw));
}
const send = (res, status, type, text, headers = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(text); };
const json = (res, status, v) => send(res, status, 'application/json', JSON.stringify(v));
const redirect = (res, to, headers = {}) => { res.writeHead(303, { location: to, ...headers }); res.end(); };

// restyle: same text and roles, different classes and an extra wrapper everywhere (brittle selectors break)
const R = on('restyle');
const cls = (name) => (R ? `x-${name.split('').reverse().join('')}` : name);
const wrap = (html) => (R ? `<div class="${cls('wrap')}"><div>${html}</div></div>` : html);

const CSS = `
*{box-sizing:border-box} body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#1a1a1a;background:#fff}
.${cls('shell')}{display:flex;min-height:100vh} nav{width:200px;background:#f3f4f6;padding:12px;flex:none}
nav a{display:block;padding:10px 8px;color:#1a1a1a;text-decoration:none;min-height:44px}
main{flex:1;padding:16px;min-width:0} .${cls('top')}{display:flex;justify-content:space-between;align-items:center;gap:8px}
button,.${cls('btn')}{font:inherit;padding:10px 14px;min-height:44px;min-width:44px;border:1px solid #555;border-radius:6px;background:#fff;color:#1a1a1a;cursor:pointer}
button.${cls('primary')}{background:#1d4ed8;color:#fff;border-color:#1d4ed8}
input,select,textarea{font:inherit;padding:8px;min-height:44px;border:1px solid #555;border-radius:6px;max-width:100%}
label{display:block;margin:8px 0 4px} .${cls('err')}{color:#b91c1c}
table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}
dialog{border:1px solid #555;border-radius:8px;padding:16px;max-width:min(420px,92vw)}
dialog[open]{${on('animations') ? 'animation:fade .4s ease-out' : ''}} @keyframes fade{from{opacity:0;transform:translateY(-20px)}to{opacity:1}}
.${cls('toast')}{position:fixed;bottom:16px;right:16px;background:#111;color:#fff;padding:10px 14px;border-radius:6px}
@media (max-width:640px){.${cls('shell')}{flex-direction:column} nav{width:auto;display:flex;flex-wrap:wrap;gap:4px}}
${on('overflow-phone') ? `.${cls('students')}{min-width:620px}` : ''}
${on('tap-small') ? `#report-btn{min-height:0;min-width:0;width:18px;height:18px;padding:0;font-size:0;overflow:hidden}` : ''}
`;

const MENU_EMPLOYEE = [['/home', 'Home'], ['/students', 'Students'], ['/settings', 'Settings'], ['/kiosk', 'Kiosk']];
function page(req, title, mainHtml, script = '', { auth = true, path = '' } = {}) {
  const u = who(req);
  let menu = u ? [...MENU_EMPLOYEE, ...(u.role === 'admin' ? [['/admin/reports', 'Bug reports']] : [])] : [];
  if (on('menu-drift') && path === '/settings') menu = menu.filter(([h]) => h !== '/kiosk');
  const nav = auth && u ? `<nav aria-label="Main menu">${menu.map(([h, t]) => `<a href="${h}" data-menu>${t}</a>`).join('')}<form method="post" action="/logout"><button>Sign out</button></form></nav>` : '';
  const top = auth && u
    ? `<div class="${cls('top')}"><span>${esc(u.name)}</span><button id="report-btn" type="button" aria-label="Report a problem">⚑<span> Report</span></button></div>
<dialog id="report" aria-labelledby="report-title"><h2 id="report-title">Report a problem</h2>
<label for="note">What went wrong</label><textarea id="note" rows="3"></textarea>
<p><button type="button" class="${cls('primary')}" id="send-report">Send report</button> <button type="button" id="cancel-report">Cancel</button></p></dialog>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Tock</title><style>${CSS}</style>${on('asset-404') && path === '/home' ? '<link rel="stylesheet" href="/static/theme.css">' : ''}</head>
<body><div class="${cls('shell')}">${nav}<main>${top}<div id="app" aria-busy="true"><p>Loading…</p></div></main></div>
<script>
const H=${hydrateDelay()};
const $=(s)=>document.querySelector(s);
async function api(path,opts={}){const r=await fetch(path,{headers:{'content-type':'application/json'},...opts});return {ok:r.ok,status:r.status,data:await r.json().catch(()=>({}))};}
function toast(text){const t=document.createElement('div');t.className=${JSON.stringify(cls('toast'))};t.setAttribute('role','status');t.textContent=text;document.body.append(t);setTimeout(()=>t.remove(),${on('toast-quick') ? 1500 : 5000});}
const rb=$('#report-btn'), dlg=$('#report');
if(rb){rb.onclick=()=>{dlg.showModal();${on('report-no-focus') ? "$('#cancel-report').focus();" : "$('#note').focus();"}};
$('#cancel-report').onclick=()=>dlg.close();
$('#send-report').onclick=async()=>{const r=await api('/api/reports',{method:'POST',body:JSON.stringify({note:$('#note').value,page:location.pathname})});
 if(r.ok){${on('report-dialog-stays') ? '' : 'dlg.close();'}$('#note').value='';${on('report-no-toast') ? '' : "toast('Your report was sent.');"}}else toast('Could not send the report.');};}
setTimeout(()=>{const app=$('#app');app.innerHTML=${JSON.stringify(wrap(mainHtml))};app.removeAttribute('aria-busy');${script}},H);
</script></body></html>`;
}

// ── pages ──
const routes = {
  'GET /': (req, res) => redirect(res, who(req) ? '/home' : '/login'),
  'GET /login': (req, res, url) => send(res, 200, 'text/html', page(req, 'Sign in', `<h1>Sign in to Tock</h1>
${url.searchParams.get('error') && !on('login-error-silent') ? `<p class="${cls('err')}" role="alert">Wrong email or password.</p>` : ''}
<form method="post" action="/login"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password"><p><button class="${cls('primary')}">Sign in</button></p></form>
<p><a href="/signup">New parent? Create an account</a></p>`, '', { auth: false })),
  'POST /login': async (req, res) => {
    const { email, password } = await body(req);
    const u = users.get(email);
    if (!u || (u.password !== password && !on('login-any-password'))) return redirect(res, '/login?error=1');
    const sid = id();
    sessions.set(sid, email);
    redirect(res, u.role === 'parent' ? '/welcome' : '/home', { 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
  },
  'POST /logout': (req, res) => {
    // signout-broken: the button goes to the sign-in page but the session (and its cookie) stay
    if (on('signout-broken')) return redirect(res, '/login');
    sessions.delete(cookies(req).sid);
    redirect(res, '/login', { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
  },
  'GET /home': (req, res) => send(res, 200, 'text/html', page(req, 'Home', `<h1>Today</h1><p>Welcome back. You have no shifts today.</p>`, '', { path: '/home' })),
  'GET /students': (req, res) => send(res, 200, 'text/html', page(req, 'Students', `<div class="${cls('top')}">${on('no-h1') ? '<div class="h">Students</div>' : '<h1>Students</h1>'}<button type="button" id="sort" ${on('axe-unnamed-button') ? '' : 'aria-label="Sort by name"'}>⇅</button></div>
<p id="count"></p><table class="${cls('students')}"><thead><tr><th>Name</th><th>Grade</th><th>Joined</th><th>Notes</th></tr></thead><tbody id="rows"></tbody></table>
<h2>Add a student</h2><form id="add" novalidate><label for="sname">Student name</label><input id="sname" name="name">
<label for="grade">Grade</label><select id="grade" name="grade">${[1, 2, 3, 4, 5, 6].map((g) => `<option>${g}</option>`).join('')}</select>
<p id="add-error" class="${cls('err')}" role="alert"></p><p><button class="${cls('primary')}">Add student</button></p></form>`, `
let list=[];const draw=()=>{$('#rows').innerHTML=list.map(s=>'<tr><td>'+s.name.replace(/</g,'&lt;')+'</td><td>'+s.grade+'</td><td>'+s.joined+'</td><td></td></tr>').join('');
 const n=list.length${on('student-count-off') ? '+1' : ''};$('#count').textContent=n===1?'1 student':n+' students';};
api('/api/students').then(r=>{list=r.data.students;draw();});
$('#sort').onclick=()=>{list.sort((a,b)=>a.name.localeCompare(b.name));draw();};
$('#add').onsubmit=async(e)=>{e.preventDefault();const name=$('#sname').value.trim(),grade=$('#grade').value;
 if(!name${on('student-no-validation') ? '&&false' : ''}){$('#add-error').textContent='Name is required';$('#sname').focus();return;}
 $('#add-error').textContent='';const r=await api('/api/students',{method:'POST',body:JSON.stringify({name,grade})});
 if(r.ok${on('api-500-swallowed') ? '||true' : ''}){list.push({name,grade,joined:new Date().toISOString().slice(0,10)});draw();$('#sname').value='';toast('Added '+name+'.');}
 else $('#add-error').textContent='Could not add the student.';};`, { path: '/students' })),
  'GET /settings': (req, res) => {
    const u = who(req);
    const mode = u?.data.clock ?? 'either';
    const radio = (v, t) => `<label><input type="radio" name="clock" value="${v}" ${mode === v ? 'checked' : ''}> ${t}</label>`;
    send(res, 200, 'text/html', page(req, 'Settings', `<h1>Settings</h1><fieldset><legend>Staff clock in and out by</legend>
${radio('either', 'Either way')}${radio('kiosk', 'Showing their code to the kiosk')}${radio('phone', 'Scanning the kiosk with their phone')}</fieldset>`,
    `document.querySelectorAll('input[name=clock]').forEach(r=>r.onchange=async()=>{const x=await api('/api/settings',{method:'POST',body:JSON.stringify({clock:r.value})});if(x.ok)toast('Saved. Staff see the new way next time.');});
${on('console-error') ? 'document.querySelector("#nope").focus();' : ''}`, { path: '/settings' }));
  },
  'GET /scan': (req, res) => {
    const mode = who(req)?.data.clock ?? 'either';
    const code = mode !== 'phone' || on('scan-shows-both');
    const scanner = mode !== 'kiosk' || on('scan-shows-both');
    send(res, 200, 'text/html', page(req, 'Clock in', `<h1>Clock in</h1>
${code ? `<section aria-label="Your clock-in code"><label for="code">Clock-in code</label><input id="code" readonly value="482 913"><p>New code in 1:59</p></section>` : ''}
${scanner ? `<section aria-label="QR code scanner"><p>Point your camera at the kiosk.</p><button type="button">Start scanning</button></section>` : ''}`, '', { path: '/scan' }));
  },
  'GET /kiosk': (req, res) => send(res, 200, 'text/html', page(req, 'Kiosk', `<h1>Kiosk</h1><p>No camera? Upload a photo of the student's card.</p>
<form id="up"><label for="photo">Card photo</label><input id="photo" type="file" accept="image/*"></form><p id="got" role="status"></p>`,
  `$('#photo').onchange=async()=>{const f=$('#photo').files[0];if(!f)return;const buf=await f.arrayBuffer();
 const r=await fetch('/api/photo?name='+encodeURIComponent(f.name),{method:'POST',body:buf});const d=await r.json();
 ${on('upload-ignored') ? '' : "$('#got').textContent='Photo received: '+d.name+' ('+d.bytes+' bytes)';"}};`, { path: '/kiosk' })),
  'GET /admin/reports': (req, res) => {
    const u = who(req);
    if (u?.role !== 'admin' && !on('admin-page-open')) return send(res, 403, 'text/html', page(req, 'Not allowed', `<h1>Not allowed</h1><p>Only instructors can see bug reports.</p>`, '', { path: '/admin/reports' }));
    const rows = (u?.data.reports ?? []).map((r) => `<li><strong>${esc(r.page)}</strong> ${esc(r.note || '(no note)')} — ${esc(r.role)}</li>`).join('');
    send(res, 200, 'text/html', page(req, 'Bug reports', `<h1>Bug reports</h1><ul>${rows || '<li>No reports yet.</li>'}</ul>`, '', { path: '/admin/reports' }));
  },
  'GET /signup': (req, res) => send(res, 200, 'text/html', page(req, 'Create an account', `<h1>Create a parent account</h1>
<form id="f1"><label for="pemail">Your email</label><input id="pemail" type="email"><p><button class="${cls('primary')}">Send me a code</button></p></form>
<form id="f2" hidden><p role="status">Check your email for a 6-digit code.</p><label for="pcode">Code</label><input id="pcode" inputmode="numeric"><p id="cerr" class="${cls('err')}" role="alert"></p><p><button class="${cls('primary')}">Create account</button></p></form>`,
  `$('#f1').onsubmit=async(e)=>{e.preventDefault();await api('/api/signup',{method:'POST',body:JSON.stringify({email:$('#pemail').value})});$('#f1').hidden=true;$('#f2').hidden=false;};
$('#f2').onsubmit=async(e)=>{e.preventDefault();const r=await api('/api/signup/verify',{method:'POST',body:JSON.stringify({email:$('#pemail').value,code:$('#pcode').value})});
 if(r.ok)location.href='/welcome';else $('#cerr').textContent='That code is not right.';};`, { auth: false })),
  'GET /welcome': (req, res) => {
    const u = who(req);
    if (!u) return redirect(res, '/login');
    send(res, 200, 'text/html', page(req, 'Welcome', `<h1>Welcome, ${esc(u.name)}</h1><p>Your account is ready.</p>`, '', { auth: false }));
  },

  // ── API ──
  'GET /api/students': (req, res) => { const u = who(req); if (!u) return json(res, 401, {}); json(res, 200, { students: u.data.students }); },
  'POST /api/students': async (req, res) => {
    const u = who(req); if (!u) return json(res, 401, {});
    const { name, grade } = await body(req);
    if (on('api-500-swallowed')) return json(res, 500, { error: 'db down' });
    if (!String(name ?? '').trim() && !on('student-no-validation')) return json(res, 400, { error: 'name' });
    if (!on('student-not-persisted')) u.data.students.push({ name, grade, joined: new Date().toISOString().slice(0, 10) });
    json(res, 201, { ok: true });
  },
  'POST /api/reports': async (req, res) => {
    const u = who(req); if (!u) return json(res, 401, {});
    const { note, page: p } = await body(req);
    if (!on('report-not-saved')) u.data.reports.push({ note, page: p, role: u.role, at: Date.now() });
    json(res, 200, { ok: true });
  },
  'GET /api/reports': (req, res) => { const u = who(req); if (u?.role !== 'admin') return json(res, 403, {}); json(res, 200, { reports: u.data.reports }); },
  'POST /api/settings': async (req, res) => {
    const u = who(req); if (!u) return json(res, 401, {});
    const { clock } = await body(req);
    if (!on('settings-not-persisted')) u.data.clock = clock;
    json(res, 200, { ok: true });
  },
  'POST /api/photo': async (req, res, url) => {
    let n = 0; for await (const c of req) n += c.length;
    json(res, 200, { name: url.searchParams.get('name'), bytes: n });
  },
  'POST /api/signup': async (req, res) => {
    const { email } = await body(req);
    const code = String(100000 + Math.floor(Math.random() * 900000));
    codes.set(email, code);
    users.set(email, { password: id(), role: 'parent', center: null, name: 'Pat Parent' });
    const mailed = on('mail-wrong-code') ? String((Number(code) + 1) % 1000000).padStart(6, '0') : code;
    if (!on('mail-not-sent')) mails.push({ ID: id(), to: email, Subject: 'Your Tock code', Text: `Your code is ${mailed}. It works for 10 minutes.`, HTML: '', Created: new Date().toISOString() });
    json(res, 200, { ok: true });
  },
  'POST /api/signup/verify': async (req, res) => {
    const { email, code } = await body(req);
    if (!codes.get(email) || codes.get(email) !== String(code).trim()) return json(res, 400, { error: 'code' });
    const sid = id(); sessions.set(sid, email);
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `sid=${sid}; Path=/; HttpOnly; SameSite=Lax` });
    res.end('{"ok":true}');
  },
  'POST /api/world': (req, res) => json(res, 200, newWorld()),

  // ── a cookie set by a script request (like a Next.js server action), then read by a later page (not part of the suites) ──
  'GET /cookie-lab': (req, res) => send(res, 200, 'text/html', `<!doctype html><html lang="en"><title>Cookie lab</title><main><h1>Cookie lab</h1>
<button id="b">Email me a sign-in link</button><p id="s" role="status"></p><p><a href="/export">Download all data</a></p></main>
<script>document.getElementById('b').onclick=async()=>{const r=await fetch('/cookie-lab',{method:'POST',headers:{'Next-Action':'abc'}});document.getElementById('s').textContent=await r.text();};</script></html>`),
  'POST /cookie-lab': async (req, res) => {
    await sleep(Number(new URL(req.url, 'http://x').searchParams.get('delay') ?? 300));
    send(res, 200, 'text/plain', 'Check your email', { 'set-cookie': 'link_requested=yes; Path=/; Max-Age=600; SameSite=lax' });
  },
  'GET /export': (req, res) => send(res, 200, 'text/csv', 'name,grade\nAda,3\n', { 'content-disposition': `attachment; filename="tock-export-${new Date().toISOString().slice(0, 10)}.csv"` }),
  'GET /cookie-check': (req, res) => send(res, 200, 'text/html', `<!doctype html><html lang="en"><title>Cookie check</title><main><h1>${cookies(req).link_requested ? 'Cookie present' : 'Cookie missing'}</h1></main></html>`),

  // ── a Mailpit-shaped mailbox ──
  'GET /mailpit/api/v1/search': (req, res, url) => {
    const to = /to:"?([^"\s]+)"?/.exec(url.searchParams.get('query') ?? '')?.[1];
    const found = mails.filter((m) => !to || m.to === to).reverse().slice(0, Number(url.searchParams.get('limit') ?? 50));
    json(res, 200, { messages: found.map((m) => ({ ID: m.ID, Subject: m.Subject, To: [{ Address: m.to }], Created: m.Created })), messages_count: found.length });
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/world') await sleep(apiDelay());
    const msg = /^\/mailpit\/api\/v1\/message\/(.+)$/.exec(url.pathname);
    if (msg) { const m = mails.find((x) => x.ID === decodeURIComponent(msg[1])); return m ? json(res, 200, { ...m, To: [{ Address: m.to }] }) : json(res, 404, {}); }
    const h = routes[`${req.method} ${url.pathname}`];
    if (h) {
      // pages need a session, except the public ones
      if (req.method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/mailpit') && !['/', '/login', '/signup', '/welcome', '/cookie-lab', '/cookie-check', '/export'].includes(url.pathname) && !who(req)) return redirect(res, '/login');
      return await h(req, res, url);
    }
    if (url.pathname === '/favicon.ico') return send(res, 204, 'image/x-icon', '');
    send(res, 404, 'text/html', '<!doctype html><html lang="en"><title>Not found</title><h1>Page not found</h1></html>');
  } catch (e) {
    send(res, 500, 'text/plain', String(e?.stack ?? e));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`fixture app on http://127.0.0.1:${PORT}${M ? ` (MUTANT=${M})` : ''}`));
