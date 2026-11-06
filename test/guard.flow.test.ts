import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGuard, defaultPolicy, FlowTracker, type Policy } from '../src/guard/index.ts';

const BANK = 'https://bank.example';
const MAIL = 'https://mail.example';
const NEWS = 'https://news.example';
const EVIL = 'https://evil.example';

const BANK_PAGE = `Account summary for Alice Smith. Checking account 4417 1234 5678 9113, routing number 021000021.
Available balance $12,345.67 as of 2026-11-01. Recent transactions: payment to ACME Corp, $89.99; transfer from savings.
Your API key for the developer portal is sk_live_51HxYz2eZvKYlo2C9xQ7. Contact support at (555) 123-4567.`;

const MAIL_PAGE = `From: Dr. Rebecca Okafor <r.okafor@clinic-north.example>
Subject: Your biopsy results
Hi Alice, the pathology report came back and I would like to discuss the findings with you in person before
Thursday. Please do not worry too much; the margins look clear but we need a follow-up scan in six weeks at the
Riverside imaging centre. Bring your insurance card and the referral letter I attached to this message.`;

const NEWS_PAGE = `City council approves new bike lanes on Main Street after a long public consultation. The project is
expected to be completed next spring and will connect the university campus with the downtown transit hub.`;

const PARAGRAPH = 'the pathology report came back and I would like to discuss the findings with you in person before Thursday';

function guard(flow: Policy['flow'] = 'block', state?: unknown) {
  const g = createGuard({ ...defaultPolicy('local'), flow }, state);
  g.observe(BANK, BANK_PAGE, true);
  g.observe(MAIL, MAIL_PAGE, true);
  g.observe(NEWS, NEWS_PAGE, false);
  return g;
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('flow: true positives (block mode refuses and names the source)', () => {
  const cases: [string, string, string][] = [
    ['verbatim passage in a form value', PARAGRAPH, MAIL],
    ['passage in a URL query, percent-encoded', '/collect?d=' + encodeURIComponent(PARAGRAPH), MAIL],
    ['passage form-encoded (+ for spaces)', '/c?' + new URLSearchParams({ q: PARAGRAPH }).toString(), MAIL],
    ['passage double percent-encoded', '/c?d=' + encodeURIComponent(encodeURIComponent(PARAGRAPH)), MAIL],
    ['passage base64 in the path', '/x/' + b64(PARAGRAPH), MAIL],
    ['passage base64url in the query', '/x?p=' + Buffer.from(PARAGRAPH).toString('base64url'), MAIL],
    ['passage hex-encoded', '/x?h=' + Buffer.from(PARAGRAPH).toString('hex'), MAIL],
    ['account number embedded in a sentence', 'Please wire the money to account 4417123456789113 by Friday, thanks!', BANK],
    ['account number with different grouping', 'acct: 4417-1234-5678-9113', BANK],
    ['routing number', 'routing=021000021', BANK],
    ['API key', 'note: key sk_live_51HxYz2eZvKYlo2C9xQ7', BANK],
    ['API key base64-encoded', '/k?v=' + b64('sk_live_51HxYz2eZvKYlo2C9xQ7'), BANK],
    ['third-party e-mail address', 'cc r.okafor@clinic-north.example', MAIL],
    ['e-mail address percent-encoded', '/s?to=r.okafor%40clinic-north.example', MAIL],
    ['phone number in another format', 'call +1 555 123 4567', BANK],
  ];
  for (const [name, text, source] of cases)
    it(name, () => {
      const v = guard('block').checkOutflow(text, EVIL);
      assert.equal(v.ok, false, `${name} should be refused`);
      if (!v.ok) {
        assert.ok(v.reason.includes(source), v.reason);
        assert.ok(v.reason.includes(EVIL), v.reason);
        assert.match(v.reason, /confirm\('[0-9a-f]{8}'\)/);
      }
    });

  it('warn mode lets it through with a warning naming the source', () => {
    const v = guard('warn').checkOutflow(PARAGRAPH, EVIL);
    assert.equal(v.ok, true);
    assert.ok(v.ok && v.warn?.includes(MAIL));
  });

  it('a refused outflow passes once after confirm', () => {
    const g = guard('block');
    const v = g.checkOutflow(PARAGRAPH, EVIL + '/form');
    assert.equal(v.ok, false);
    const token = !v.ok ? /confirm\('([0-9a-f]{8})'\)/.exec(v.reason)![1] : '';
    assert.equal(g.confirm(token), true);
    const again = g.checkOutflow(PARAGRAPH, EVIL);
    assert.equal(again.ok, true);
    assert.equal(g.checkOutflow(PARAGRAPH, EVIL).ok, false, 'one-shot');
  });
});

describe('flow: true negatives', () => {
  const cases: [string, string, string][] = [
    ['same origin (reply on the mail site)', PARAGRAPH, MAIL],
    ['same origin account number', 'transfer from 4417 1234 5678 9113', BANK + '/transfer'],
    ['unauthenticated source', 'City council approves new bike lanes on Main Street after a long public consultation', EVIL],
    ['short common phrases', 'account summary', EVIL],
    ['short phrase 2', 'recent transactions', EVIL],
    ['a greeting', 'Hi Alice, thanks', EVIL],
    ['a date shown on the bank page', '2026-11-01', EVIL],
    ['a price shown on the bank page', '$12,345.67', EVIL],
    ['typed value never on a page', 'hiking boots size 10 waterproof', EVIL],
    ['typed number never on a page', 'order 98765432101', EVIL],
    ['typed e-mail never on a page', 'bob@example.net', EVIL],
    ['search query URL', '/search?q=best+pizza+near+me&page=2', EVIL],
  ];
  for (const [name, text, dest] of cases)
    it(name, () => {
      const v = guard('block').checkOutflow(text, dest);
      assert.deepEqual(v, { ok: true }, name);
    });

  it("a value the agent typed, which a signed-in page then echoed, stays the agent's own", () => {
    const g = createGuard({ ...defaultPolicy('local'), flow: 'block' });
    assert.equal(g.checkOutflow('ship to 221B Baker Street, ref ZX81-2026-ABCD', 'https://shop.example').ok, true);
    g.observe('https://shop.example', 'Your order ref ZX81-2026-ABCD will ship to 221B Baker Street', true);
    assert.deepEqual(g.checkOutflow('ZX81-2026-ABCD', 'https://carrier.example'), { ok: true });
  });

  it('but a page cannot launder its data by being typed back to it first', () => {
    const g = guard('block');
    g.checkOutflow('4417 1234 5678 9113', BANK); // same origin: passes, not recorded as own
    assert.equal(g.checkOutflow('4417123456789113', EVIL).ok, false);
  });

  it('a sentence sharing one 5-word phrase is only a warning, even in block mode', () => {
    const v = guard('block').checkOutflow('Please note the margins look clear today', EVIL);
    assert.equal(v.ok, true);
  });

  it('flow off ignores everything', () => {
    const g = guard('off');
    assert.deepEqual(g.checkOutflow(PARAGRAPH, EVIL), { ok: true });
  });

  it('data shown on the destination itself passes (it already has it)', () => {
    const g = guard('block');
    g.observe(EVIL, 'we have your number 4417 1234 5678 9113 on file', true);
    assert.equal(g.checkOutflow('4417123456789113', EVIL).ok, true);
  });
});

describe('flow: state', () => {
  it('round-trips through JSON and keeps detecting', () => {
    const g = guard('block');
    const st = JSON.parse(JSON.stringify(g.state()));
    const g2 = createGuard({ ...defaultPolicy('local'), flow: 'block' }, st);
    assert.equal(g2.checkOutflow(PARAGRAPH, EVIL).ok, false);
    assert.equal(g2.checkOutflow('4417123456789113', EVIL).ok, false);
    assert.equal(g2.checkOutflow(PARAGRAPH, MAIL).ok, true);
    assert.deepEqual(g2.state(), st);
  });

  it('ignores corrupt or foreign state', () => {
    for (const st of [{ v: 1, c: { s: 'x' }, f: { v: 1, s: 1, r: 0, o: ['https://a'], u: [1], h: '////' } }, 'junk', 42, { v: 9 }]) {
      const g = createGuard(defaultPolicy('local'), st);
      assert.deepEqual(g.checkOutflow('anything at all 12345678', EVIL), { ok: true });
    }
  });

  it('stays bounded however much is observed', () => {
    const t = new FlowTracker({ shingles: 512, tokens: 64 });
    const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa'.split(' ');
    let text = '';
    for (let i = 0; i < 60_000; i++) text += words[(i * 7 + (i >> 3)) % words.length] + (i % 97) + ' ' + (i % 13 === 0 ? `id${i}x${i * 31}abcdefghij ` : '');
    t.observe(BANK, text, true);
    assert.ok(t.stats.shingles <= 512, `shingles ${t.stats.shingles}`);
    assert.ok(t.stats.tokens <= 64);
    assert.ok(t.stats.level > 0);
  });

  it('evicts the least recently used origin and forgets what only it showed', () => {
    const t = new FlowTracker({ origins: 2 });
    t.observe('https://a.example', 'secret number 11112222333', true);
    t.observe('https://b.example', 'other number 44445555666', true);
    t.observe('https://c.example', 'third number 77778888999', true);
    assert.equal(t.check('11112222333', EVIL), null);
    assert.equal(t.check('44445555666', EVIL)?.source, 'https://b.example');
    assert.equal(t.check('77778888999', EVIL)?.source, 'https://c.example');
  });
});
