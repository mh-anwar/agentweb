import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StepInfo } from '../src/types.ts';
import { classifyStep, createGuard, defaultPolicy, isMutating, type Policy } from '../src/guard/index.ts';

const SHOP = 'https://shop.example';
const click = (label: string, extra: Partial<StepInfo> = {}): StepInfo => ({ verb: 'click', origin: SHOP, label, ...extra });
const submit = (label: string, dest: string, extra: Partial<StepInfo> = {}): StepInfo => ({ verb: 'submit', origin: SHOP, label, dest, method: 'POST', ...extra });

describe('classifyStep', () => {
  const consequential: [StepInfo, string][] = [
    [click('Place order'), 'purchase'],
    [click('Buy now'), 'purchase'],
    [click('Complete purchase'), 'purchase'],
    [click('Confirm booking'), 'purchase'],
    [click('Start free trial'), 'purchase'],
    [click('Pay $42.00'), 'payment'],
    [click('Pay now'), 'payment'],
    [click('Submit payment'), 'payment'],
    [click('Donate'), 'payment'],
    [click('Delete'), 'deletion'],
    [click('Delete account'), 'deletion'],
    [click('Permanently remove'), 'deletion'],
    [click('Close my account'), 'deletion'],
    [click('Transfer $500'), 'transfer'],
    [click('Send money'), 'transfer'],
    [click('Withdraw'), 'transfer'],
    [click('Send'), 'sending'],
    [click('Send message'), 'sending'],
    [click('Post reply'), 'sending'],
    [click('Publish'), 'sending'],
    [click('Cancel subscription'), 'cancellation'],
    [click('Cancel my membership'), 'cancellation'],
    [click('Unsubscribe'), 'cancellation'],
    [submit('Continue', SHOP + '/checkout/submit'), 'purchase'],
    [submit('Next', SHOP + '/api/payments'), 'payment'],
    [submit('OK', 'https://bank.example/transfers/new'), 'transfer'],
    [submit('Yes', SHOP + '/items/7/delete'), 'deletion'],
    [{ verb: 'open', dest: 'https://news.example/unsubscribe?u=123&t=abc', method: 'GET' }, 'cancellation'],
  ];
  for (const [s, kind] of consequential) it(`${s.label ?? s.dest} → ${kind}`, () => assert.equal(classifyStep(s)?.kind, kind));

  const benign: StepInfo[] = [
    click('Cancel'),
    click('Close'),
    click('Add to cart'),
    click('Proceed to checkout'),
    click('Checkout'),
    click('Remove from cart'),
    click('Clear filters'),
    click('Send me a code'),
    click('Resend verification code'),
    click('Next'),
    click('Show more'),
    click('Search'),
    click('Buy now', { dest: SHOP + '/product/1', method: 'GET' }), // a link, not an action
    submit('Search', SHOP + '/search', { method: 'GET' }),
    { verb: 'submit', origin: SHOP, label: 'Sign in', dest: SHOP + '/session', method: 'POST' },
    { verb: 'fill', origin: SHOP, label: 'Card number', text: '4111111111111111' },
    { verb: 'open', dest: SHOP + '/orders', method: 'GET' },
  ];
  for (const s of benign) it(`not consequential: ${s.verb} ${s.label ?? s.dest}`, () => assert.equal(classifyStep(s), null));

  it('isMutating', () => {
    assert.equal(isMutating(click('x')), true);
    assert.equal(isMutating(click('x', { dest: SHOP + '/a' })), false);
    assert.equal(isMutating({ verb: 'fill', text: 'x' }), false);
    assert.equal(isMutating({ verb: 'submit', method: 'GET', dest: SHOP + '/s' }), true);
    assert.equal(isMutating({ verb: 'open', method: 'POST', dest: SHOP }), true);
  });
});

describe('confirmation round trip', () => {
  const pol = (p: Partial<Policy> = {}) => ({ ...defaultPolicy('local'), ...p });

  it('refuses with a token, passes once after confirm, survives state transfer', async () => {
    const g = createGuard(pol());
    const step = click('Place order', { text: 'qty=1' });
    const v = await g.checkStep(step);
    assert.equal(v.ok, false);
    const token = !v.ok ? /confirm\('([0-9a-f]{8})'\)/.exec(v.reason)?.[1] : undefined;
    assert.ok(token, !v.ok ? v.reason : '');
    assert.match(!v.ok ? v.reason : '', /purchase/);

    // a different step does not match the token
    g.confirm(token!);
    assert.equal((await g.checkStep(click('Place order', { text: 'qty=99' }))).ok, false);

    // the session moves to another worker before the step is retried
    const g2 = createGuard(pol(), JSON.parse(JSON.stringify(g.state())));
    const ok = await g2.checkStep(step);
    assert.equal(ok.ok, true);
    assert.ok(ok.ok && ok.warn?.includes('confirmed'));
    assert.equal((await g2.checkStep(step)).ok, false, 'tokens are one-shot');
  });

  it('tokens are bound to the session', async () => {
    const step = click('Delete account');
    const a = createGuard(pol());
    const b = createGuard(pol());
    const va = await a.checkStep(step);
    const vb = await b.checkStep(step);
    assert.ok(!va.ok && !vb.ok);
    const ta = /confirm\('(\w+)'\)/.exec(!va.ok ? va.reason : '')![1];
    const tb = /confirm\('(\w+)'\)/.exec(!vb.ok ? vb.reason : '')![1];
    assert.notEqual(ta, tb);
    b.confirm(ta);
    assert.equal((await b.checkStep(step)).ok, false);
  });

  it('a shared confirmKey makes tokens stable across workers and standing approvals work', async () => {
    const step = click('Pay now');
    const g = createGuard(pol({ confirmKey: 'k' }));
    const v = await g.checkStep(step);
    const t = /confirm\('(\w+)'\)/.exec(!v.ok ? v.reason : '')![1];
    const g2 = createGuard(pol({ confirmKey: 'k', confirmed: [t] }), g.state());
    assert.equal((await g2.checkStep(step)).ok, true);
    assert.equal((await g2.checkStep(step)).ok, true, 'standing approval is not consumed');
    assert.ok(!('k' in g.state().c), 'policy key is not copied into session state');
  });

  it('confirm: never lets consequential steps through', async () => {
    assert.equal((await createGuard(pol({ confirm: 'never' })).checkStep(click('Place order'))).ok, true);
  });

  it('rejects malformed tokens', () => {
    const g = createGuard(pol());
    assert.equal(g.confirm('nope'), false);
    assert.equal(g.confirm('confirm 0123abcd'), true);
  });
});

describe('read-only mode', () => {
  const g = createGuard({ ...defaultPolicy('local'), readOnly: true });
  it('refuses POSTs, submits and script buttons', async () => {
    for (const s of [submit('Sign in', SHOP + '/login'), { verb: 'open', method: 'POST' as const, dest: SHOP + '/api' }, click('Save'), { verb: 'upload', origin: SHOP }]) {
      const v = await g.checkStep(s);
      assert.equal(v.ok, false, JSON.stringify(s));
      assert.match(!v.ok ? v.reason : '', /read-only/);
    }
  });
  it('allows reading: links, fills, GET navigation', async () => {
    for (const s of [click('Docs', { dest: SHOP + '/docs' }), { verb: 'fill', origin: SHOP, text: 'q' }, { verb: 'open', dest: SHOP, method: 'GET' as const }])
      assert.equal((await g.checkStep(s)).ok, true, JSON.stringify(s));
  });
  it('a read-only refusal offers no confirmation token', async () => {
    const v = await g.checkStep(click('Place order'));
    assert.ok(!v.ok && !/confirm\('[0-9a-f]{8}'\)/.test(v.reason));
  });
});
