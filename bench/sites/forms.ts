// /forms/ — every control type, three labelling styles, placeholder-only fields, a multi-page
// wizard, and server-side validation that re-renders the form with errors.
import type { Ctx, Form } from './core.ts';
import { esc, shell, infoPage } from './html.ts';
import type { Chrome } from './html.ts';
import { hashHex } from './rng.ts';

const chrome: Chrome = {
  base: '/forms', brand: 'Formworks', tagline: 'Registration and contact forms',
  nav: [['Home', '/forms/'], ['Registration', '/forms/controls'], ['Contact', '/forms/contact'], ['Sign-up wizard', '/forms/wizard/1']],
};

export const COUNTRIES = ['Canada', 'Germany', 'Japan', 'Kenya', 'Norway', 'Portugal', 'United States'];
export const INTERESTS = ['Cycling', 'Chess', 'Cooking', 'Photography', 'Gardening', 'Hiking'];
export const PLANS = ['Free', 'Pro', 'Enterprise'];
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

const err = (errs: Record<string, string>, k: string) => (errs[k] ? `<span class="error" id="err-${k}" role="alert">${esc(errs[k]!)}</span>` : '');

function controlsForm(v: Record<string, string[]>, errs: Record<string, string>): string {
  const one = (k: string) => v[k]?.[0] ?? '';
  const has = (k: string, x: string) => (v[k] ?? []).includes(x);
  return `<form method="post" action="/forms/controls" enctype="multipart/form-data" id="registration" novalidate>
<input type="hidden" name="form_id" value="registration-v2">
<div><label for="full_name">Full name</label><input type="text" id="full_name" name="full_name" value="${esc(one('full_name'))}" required>${err(errs, 'full_name')}</div>
<div><label for="email">Email address</label><input type="email" id="email" name="email" value="${esc(one('email'))}" required>${err(errs, 'email')}</div>
<div><label for="password">Password (min. 8 characters)</label><input type="password" id="password" name="password" autocomplete="new-password">${err(errs, 'password')}</div>
<div><label for="age">Age</label><input type="number" id="age" name="age" min="18" max="99" value="${esc(one('age'))}">${err(errs, 'age')}</div>
<div><label for="birthdate">Date of birth</label><input type="date" id="birthdate" name="birthdate" value="${esc(one('birthdate'))}">${err(errs, 'birthdate')}</div>
<div><label for="country">Country</label><select id="country" name="country"><option value="">Select a country</option>${COUNTRIES.map((x) => `<option value="${x}" ${one('country') === x ? 'selected' : ''}>${x}</option>`).join('')}</select>${err(errs, 'country')}</div>
<div><label for="interests">Interests (hold Ctrl to select several)</label><select id="interests" name="interests" multiple size="4">${INTERESTS.map((x) => `<option value="${x.toLowerCase()}" ${has('interests', x.toLowerCase()) ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
<fieldset><legend>Plan</legend>${PLANS.map((x) => `<label><input type="radio" name="plan" value="${x.toLowerCase()}" ${one('plan') === x.toLowerCase() ? 'checked' : ''}> ${x}</label>`).join('')}${err(errs, 'plan')}</fieldset>
<fieldset><legend>Preferred contact days</legend>${DAYS.map((x) => `<label><input type="checkbox" name="days" value="${x.toLowerCase()}" ${has('days', x.toLowerCase()) ? 'checked' : ''}> ${x}</label>`).join('')}</fieldset>
<div><label for="bio">About you</label><textarea id="bio" name="bio" rows="4" cols="50">${esc(one('bio'))}</textarea></div>
<div><label for="avatar">Profile picture</label><input type="file" id="avatar" name="avatar" accept="image/*,.txt"></div>
<div><label><input type="checkbox" name="newsletter" value="yes" ${one('newsletter') ? 'checked' : ''}> Send me the newsletter</label></div>
<div><label><input type="checkbox" name="terms" value="accepted" ${one('terms') ? 'checked' : ''}> I accept the terms and conditions</label>${err(errs, 'terms')}</div>
<p><button type="submit" name="action" value="register">Create account</button> <button type="reset">Reset</button></p></form>`;
}

async function controls(c: Ctx): Promise<void> {
  const page = (body: string, status = 200) => c.html(shell(chrome, { title: 'Registration — Formworks', main: `<h1>Create your account</h1>${body}` }), status);
  if (c.method !== 'POST') return page(controlsForm({}, {}));
  const f = await c.form();
  const errs: Record<string, string> = {};
  if (f.get('full_name').trim().length < 2) errs.full_name = 'Please enter your full name.';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.get('email'))) errs.email = 'Please enter a valid email address.';
  if (f.get('password').length < 8) errs.password = 'Password must be at least 8 characters.';
  const age = Number(f.get('age'));
  if (f.get('age') === '' || !(age >= 18 && age <= 99)) errs.age = 'Age must be between 18 and 99.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.get('birthdate'))) errs.birthdate = 'Choose your date of birth.';
  if (!COUNTRIES.includes(f.get('country'))) errs.country = 'Select a country.';
  if (!PLANS.map((x) => x.toLowerCase()).includes(f.get('plan'))) errs.plan = 'Choose a plan.';
  if (f.get('terms') !== 'accepted') errs.terms = 'You must accept the terms.';
  if (Object.keys(errs).length) {
    return page(`<div class="notice" role="alert"><strong>There were ${Object.keys(errs).length} errors.</strong> Please correct them below.</div>${controlsForm(f.fields, errs)}`);
  }
  record(c, '/forms/controls', f);
  const rows = Object.entries(f.fields).filter(([k]) => k !== 'password' && k !== 'form_id' && k !== 'avatar').map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v.join(', '))}</td></tr>`).join('');
  const file = f.files[0];
  page(`<p class="success" role="status">Account created. Your registration reference is <strong id="reference">REG-${hashHex(c.truth.seed, 'reg', f.get('email')).slice(0, 6).toUpperCase()}</strong>.</p>
<table id="result"><tbody>${rows}<tr><th scope="row">avatar</th><td>${file ? `${esc(file.filename)} (${file.size} bytes)` : 'none'}</td></tr></tbody></table>`);
}

function record(c: Ctx, path: string, f: Form): void {
  const fields: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(f.fields)) if (k !== 'password') fields[k] = v;
  c.rt.state.submissions.push({ path, fields, files: f.files.map((x) => ({ field: x.field, filename: x.filename, type: x.type, size: x.size })) });
}

async function contact(c: Ctx): Promise<void> {
  const form = (v: Record<string, string>, errs: string[]) => `${errs.length ? `<div class="notice" role="alert"><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/forms/contact" id="contact">
<p><input type="text" name="name" placeholder="Your name" value="${esc(v.name ?? '')}"></p>
<p><input type="text" name="email" placeholder="Email address" value="${esc(v.email ?? '')}"></p>
<p><input type="text" name="subject" placeholder="Subject (optional)" value="${esc(v.subject ?? '')}"></p>
<p><textarea name="message" rows="5" cols="50" placeholder="How can we help?">${esc(v.message ?? '')}</textarea></p>
<p><button type="submit">Send message</button></p></form>`;
  const page = (body: string, status = 200) => c.html(shell(chrome, { title: 'Contact us — Formworks', main: `<h1>Contact us</h1>${body}` }), status);
  if (c.method !== 'POST') return page(form({}, []));
  const f = await c.form();
  const v = { name: f.get('name').trim(), email: f.get('email').trim(), subject: f.get('subject').trim(), message: f.get('message').trim() };
  const errs: string[] = [];
  if (!v.name) errs.push('Name is required.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) errs.push('Email address is not valid.');
  if (v.message.length < 10) errs.push('Message must be at least 10 characters.');
  if (errs.length) return page(form(v, errs), 422);
  record(c, '/forms/contact', f);
  page(`<p role="status">Thanks, ${esc(v.name)}! Your message was received. Reference: <strong id="reference">MSG-${hashHex(c.truth.seed, 'msg', v.email, v.message).slice(0, 6).toUpperCase()}</strong></p>`);
}

const WIZ_STEPS = 3;

function wizardStepNav(n: number): string {
  return `<ol class="wizard-steps" style="display:flex;gap:18px;list-style:none;padding:0">${['Account', 'Preferences', 'Confirm'].map((l, i) => `<li ${i + 1 === n ? 'aria-current="step"' : ''}>${i + 1}. ${l}</li>`).join('')}</ol>`;
}

async function wizard(c: Ctx, step: string): Promise<void> {
  const s = c.session('forms')!;
  const data = (s.wizard ??= {}) as Record<string, string>;
  const page = (n: number, body: string, status = 200) => c.html(shell(chrome, { title: `Sign-up wizard, step ${n} of ${WIZ_STEPS} — Formworks`, main: `<h1>Sign-up wizard</h1>${wizardStepNav(n)}${body}` }), status);
  const errBox = (errs: string[]) => (errs.length ? `<div class="notice" role="alert"><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : '');
  if (step === '1') {
    const form = (errs: string[]) => page(1, `${errBox(errs)}<form method="post" action="/forms/wizard/1"><label for="username">Username</label><input id="username" name="username" value="${esc(data.username ?? '')}">
<label for="wemail">Email</label><input id="wemail" name="email" type="email" value="${esc(data.email ?? '')}"><p><button type="submit">Next</button></p></form>`);
    if (c.method !== 'POST') return form([]);
    const f = await c.form();
    const errs: string[] = [];
    if (!/^[a-z][a-z0-9_]{2,15}$/i.test(f.get('username'))) errs.push('Username must be 3–16 letters, digits or underscores, starting with a letter.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.get('email'))) errs.push('Enter a valid email address.');
    if (errs.length) return form(errs);
    data.username = f.get('username'); data.email = f.get('email');
    return c.redirect('/forms/wizard/2');
  }
  if (!data.username) return c.redirect('/forms/wizard/1');
  if (step === '2') {
    const form = (errs: string[]) => page(2, `${errBox(errs)}<form method="post" action="/forms/wizard/2"><fieldset><legend>Delivery frequency</legend>
${['daily', 'weekly', 'monthly'].map((x) => `<label><input type="radio" name="frequency" value="${x}" ${data.frequency === x ? 'checked' : ''}> ${x[0]!.toUpperCase() + x.slice(1)}</label>`).join('')}</fieldset>
<label for="topic">Topic</label><select id="topic" name="topic"><option value="">Choose…</option>${['Releases', 'Security', 'Events'].map((x) => `<option ${data.topic === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
<p><a href="/forms/wizard/1">Back</a> <button type="submit">Next</button></p></form>`);
    if (c.method !== 'POST') return form([]);
    const f = await c.form();
    const errs: string[] = [];
    if (!['daily', 'weekly', 'monthly'].includes(f.get('frequency'))) errs.push('Choose a delivery frequency.');
    if (!['Releases', 'Security', 'Events'].includes(f.get('topic'))) errs.push('Choose a topic.');
    if (errs.length) return form(errs);
    data.frequency = f.get('frequency'); data.topic = f.get('topic');
    return c.redirect('/forms/wizard/3');
  }
  if (!data.frequency) return c.redirect('/forms/wizard/2');
  if (step === '3') {
    if (c.method !== 'POST') {
      return page(3, `<h2>Confirm your details</h2><dl><dt>Username</dt><dd>${esc(data.username)}</dd><dt>Email</dt><dd>${esc(data.email)}</dd><dt>Frequency</dt><dd>${esc(data.frequency)}</dd><dt>Topic</dt><dd>${esc(data.topic)}</dd></dl>
<form method="post" action="/forms/wizard/3"><label><input type="checkbox" name="confirm" value="yes"> I confirm these details are correct</label><p><a href="/forms/wizard/2">Back</a> <button type="submit">Finish</button></p></form>`);
    }
    const f = await c.form();
    if (f.get('confirm') !== 'yes') return page(3, `${errBox(['Tick the box to confirm.'])}<form method="post" action="/forms/wizard/3"><label><input type="checkbox" name="confirm" value="yes"> I confirm these details are correct</label><p><button type="submit">Finish</button></p></form>`);
    const code = 'WZ-' + hashHex(c.truth.seed, 'wizard', data.username, data.email, data.frequency, data.topic).slice(0, 6).toUpperCase();
    c.rt.state.submissions.push({ path: '/forms/wizard', fields: { username: [data.username!], email: [data.email!], frequency: [data.frequency!], topic: [data.topic!], code: [code] }, files: [] });
    s.wizard = {};
    return page(3, `<h2>All done</h2><p role="status">Thanks ${esc(data.username)}! Your confirmation code is <strong id="confirmation-code">${code}</strong>.</p>`);
  }
  c.notFound();
}

export async function handle(c: Ctx, rest: string): Promise<void> {
  if (rest === '/' || rest === '') {
    return c.html(shell(chrome, { title: 'Formworks — forms test bed', main: `<h1>Forms</h1><ul><li><a href="/forms/controls">Registration form (every control type)</a></li><li><a href="/forms/contact">Contact form (placeholder-only fields)</a></li><li><a href="/forms/wizard/1">Sign-up wizard (three steps)</a></li></ul>` }));
  }
  if (rest === '/controls') return controls(c);
  if (rest === '/contact') return contact(c);
  let m: RegExpExecArray | null;
  if ((m = /^\/wizard\/([123])$/.exec(rest))) return wizard(c, m[1]!);
  if ((m = /^\/info\/([a-z-]+)$/.exec(rest))) return c.html(infoPage(c, chrome, m[1]!));
  c.notFound();
}
