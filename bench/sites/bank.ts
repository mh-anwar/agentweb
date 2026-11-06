// /bank/ — a logged-in area (login form, session cookie) that shows an account number and balance,
// and a transfer form, which is a consequential action.
import type { Ctx } from './core.ts';
import { esc, shell, infoPage } from './html.ts';
import type { Chrome } from './html.ts';
import { hashHex, money } from './rng.ts';

const chrome = (c: Ctx): Chrome => ({
  base: '/bank', brand: 'Harbourline Bank', tagline: 'Banking without the queue',
  nav: [['Accounts', '/bank/'], ['Transfer money', '/bank/transfer'], ['Statements', '/bank/info/statements'], ['Help', '/bank/info/help']],
  headerExtra: c.session('bank', false)?.user ? '<form method="post" action="/bank/logout" style="margin-left:auto"><button type="submit">Log out</button></form>' : '<a href="/bank/login" style="margin-left:auto">Log in</a>',
});

function csrf(c: Ctx): string {
  const s = c.session('bank')!;
  return (s.csrf ??= hashHex(c.truth.seed, 'bankcsrf', s.id).slice(0, 24));
}

const loggedIn = (c: Ctx) => !!c.session('bank', false)?.user;

function loginPage(c: Ctx, msg = '', status = 200): void {
  c.html(shell(chrome(c), {
    title: 'Log in — Harbourline Bank',
    main: `<h1>Log in to online banking</h1>${msg ? `<p class="error" role="alert">${esc(msg)}</p>` : ''}
<form method="post" action="/bank/login" autocomplete="on"><label for="username">User ID</label><input id="username" name="username" autocomplete="username">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password"><p><button type="submit" class="primary">Log in</button></p></form>`,
  }), status);
}

function dashboard(c: Ctx): void {
  const b = c.truth.bank;
  c.html(shell(chrome(c), {
    title: 'Your accounts — Harbourline Bank',
    main: `<h1>Welcome back, ${esc(b.fullName)}</h1><h2>Your accounts</h2>
<table class="accounts"><thead><tr><th>Account</th><th>Account number</th><th>Available balance</th></tr></thead><tbody>
${b.accounts.map((a, i) => `<tr data-account="${i}"><td><a href="/bank/account/${a.number}">${esc(a.name)}</a></td><td class="acct-number">${a.number}</td><td class="balance">${money(c.rt.balances.get(a.number)!)}</td></tr>`).join('')}</tbody></table>
<p><a class="btn" style="text-decoration:none" href="/bank/transfer">Transfer money</a></p>`,
  }));
}

function accountPage(c: Ctx, number: string): void {
  const a = c.truth.bank.accounts.find((x) => x.number === number);
  if (!a) return c.notFound('No such account.');
  c.html(shell(chrome(c), {
    title: `${a.name} — Harbourline Bank`,
    main: `<h1>${esc(a.name)}</h1><p>Account number: <strong class="acct-number">${a.number}</strong></p><p>Balance: <strong class="balance">${money(c.rt.balances.get(a.number)!)}</strong></p>
<h2>Recent transactions</h2><table><thead><tr><th>Date</th><th>Description</th><th>Amount</th></tr></thead><tbody>${c.rt.bankLedger.get(a.number)!.map((h) => `<tr><td>${h.date}</td><td>${esc(h.desc)}</td><td>${h.cents < 0 ? '−' : '+'}${money(Math.abs(h.cents))}</td></tr>`).join('')}</tbody></table>`,
  }));
}

function transferForm(c: Ctx, v: Record<string, string>, errs: string[], status = 200): void {
  const b = c.truth.bank;
  c.html(shell(chrome(c), {
    title: 'Transfer money — Harbourline Bank',
    main: `<h1>Transfer money</h1>${errs.length ? `<div class="notice" role="alert"><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/bank/transfer"><input type="hidden" name="csrf_token" value="${csrf(c)}">
<label for="from">From account</label><select id="from" name="from">${b.accounts.map((a) => `<option value="${a.number}" ${v.from === a.number ? 'selected' : ''}>${esc(a.name)} (${a.number}) — ${money(c.rt.balances.get(a.number)!)}</option>`).join('')}</select>
<label for="to">To payee</label><select id="to" name="to"><option value="">Choose a payee</option>${b.payees.map((p) => `<option value="${p.number}" ${v.to === p.number ? 'selected' : ''}>${esc(p.name)} (${p.number})</option>`).join('')}</select>
<label for="amount">Amount (USD)</label><input id="amount" name="amount" inputmode="decimal" value="${esc(v.amount ?? '')}">
<label for="memo">Memo (optional)</label><input id="memo" name="memo" maxlength="60" value="${esc(v.memo ?? '')}">
<label><input type="checkbox" name="confirm" value="yes"> I confirm this transfer is correct</label>
<p><button type="submit" class="primary">Send transfer</button></p></form>`,
  }), status);
}

async function transfer(c: Ctx): Promise<void> {
  if (c.method !== 'POST') return transferForm(c, {}, []);
  const f = await c.form();
  if (f.get('csrf_token') !== csrf(c)) return c.html(shell(chrome(c), { title: 'Forbidden', main: '<h1>403</h1><p>Invalid or missing CSRF token.</p>' }), 403);
  const b = c.truth.bank;
  const v = { from: f.get('from'), to: f.get('to'), amount: f.get('amount').trim(), memo: f.get('memo').trim() };
  const errs: string[] = [];
  const from = b.accounts.find((a) => a.number === v.from);
  const payee = b.payees.find((p) => p.number === v.to);
  const amt = /^\d+(\.\d{1,2})?$/.test(v.amount.replace(/^\$/, '').replace(/,/g, '')) ? Math.round(Number(v.amount.replace(/^\$/, '').replace(/,/g, '')) * 100) : NaN;
  if (!from) errs.push('Choose an account to transfer from.');
  if (!payee) errs.push('Choose a payee.');
  if (!(amt > 0)) errs.push('Enter an amount greater than zero, e.g. 125.50.');
  else if (from && amt > c.rt.balances.get(from.number)!) errs.push('Insufficient funds in the selected account.');
  if (f.get('confirm') !== 'yes') errs.push('Please tick the confirmation box.');
  if (errs.length) return transferForm(c, v, errs);
  const ref = 'TRX-' + hashHex(c.truth.seed, 'transfer', ++c.rt.transferCounter).slice(0, 8).toUpperCase();
  c.rt.balances.set(from!.number, c.rt.balances.get(from!.number)! - amt);
  c.rt.bankLedger.get(from!.number)!.unshift({ date: '2026-11-05', desc: `Transfer to ${payee!.name}`, cents: -amt });
  c.rt.state.transfers.push({ from: from!.number, to: payee!.number, amountCents: amt, memo: v.memo, ref });
  c.html(shell(chrome(c), {
    title: 'Transfer complete — Harbourline Bank',
    main: `<h1>Transfer complete</h1><p role="status">You sent <strong>${money(amt)}</strong> to ${esc(payee!.name)}. Reference: <strong id="reference">${ref}</strong>.</p>
<p>New balance of ${esc(from!.name)}: <strong class="balance">${money(c.rt.balances.get(from!.number)!)}</strong></p><p><a href="/bank/">Back to accounts</a></p>`,
  }));
}

export async function handle(c: Ctx, rest: string): Promise<void> {
  if (rest === '/login') {
    if (c.method !== 'POST') return loginPage(c);
    const f = await c.form();
    const ok = f.get('username') === c.truth.bank.user && f.get('password') === c.truth.bank.password;
    c.rt.state.logins.push({ site: 'bank', user: f.get('username'), ok });
    if (!ok) return loginPage(c, 'The user ID or password is incorrect.', 401);
    c.session('bank')!.user = c.truth.bank.user;
    return c.redirect('/bank/');
  }
  let m: RegExpExecArray | null;
  if ((m = /^\/info\/([a-z-]+)$/.exec(rest))) return c.html(infoPage(c, chrome(c), m[1]!));
  if (rest === '/logout' && c.method === 'POST') { const s = c.session('bank', false); if (s) s.user = undefined; return c.redirect('/bank/login'); }
  if (!loggedIn(c)) return c.redirect('/bank/login', 302);
  if (rest === '/' || rest === '') return dashboard(c);
  if (rest === '/transfer') return transfer(c);
  if ((m = /^\/account\/(\d{10})$/.exec(rest))) return accountPage(c, m[1]!);
  c.notFound();
}
