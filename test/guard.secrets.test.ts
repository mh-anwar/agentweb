import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AwError } from '../src/types.ts';
import { createGuard, defaultPolicy, loadPolicy, parseSecrets, SecretStore, secretsFromEnv } from '../src/guard/index.ts';

const VALUE = 'hunter2-S3cr3t/pa$$ word+=&é';
const store = () =>
  new SecretStore([
    { name: 'gh', value: VALUE, origins: ['https://github.com', 'https://*.github.com'] },
    { name: 'Local', value: 'dev-token-123456', origins: ['http://localhost:3000'] },
    { name: 'unbound', value: 'nobody-gets-this', origins: [] },
  ]);

function catchErr(fn: () => unknown): AwError {
  try {
    fn();
  } catch (e) {
    return e as AwError;
  }
  throw new Error('expected a throw');
}

describe('reveal', () => {
  it('substitutes for a bound origin', () => {
    const s = store();
    assert.equal(s.reveal('pw={{secret:gh}}', 'https://github.com'), 'pw=' + VALUE);
    assert.equal(s.reveal('{{ secret:GH }}', 'https://github.com/login?x=1'), VALUE);
    assert.equal(s.reveal('{{secret:gh}}', 'https://api.github.com'), VALUE);
    assert.equal(s.reveal('{{secret:local}}', 'http://localhost:3000/x'), 'dev-token-123456');
  });
  it('refuses other origins, naming secret and origin but never the value', () => {
    const s = store();
    const cases: [string, string][] = [
      ['{{secret:gh}}', 'https://evil.example'],
      ['{{secret:gh}}', 'http://github.com'], // scheme downgrade
      ['{{secret:gh}}', 'https://github.com:8443'], // other port
      ['{{secret:gh}}', 'https://github.com.evil.example'],
      ['{{secret:gh}}', 'https://notgithub.com'],
      ['{{secret:local}}', 'http://localhost:3001'],
      ['{{secret:unbound}}', 'https://github.com'],
      ['{{secret:gh}}', 'javascript:alert(1)'],
    ];
    for (const [text, origin] of cases) {
      const e = catchErr(() => s.reveal(text, origin));
      assert.ok(e instanceof AwError, origin);
      assert.equal(e.code, 'policy');
      const all = e.message + ' ' + (e.hint ?? '') + ' ' + (e.stack ?? '');
      assert.ok(!all.includes(VALUE) && !all.includes('nobody-gets-this') && !all.includes('dev-token'), `value leaked for ${origin}`);
      assert.match(e.message, /secret "(gh|local|unbound)"/);
    }
    assert.match(catchErr(() => s.reveal('{{secret:gh}}', 'https://evil.example')).message, /evil\.example/);
  });
  it('is all-or-nothing and reports unknown names', () => {
    const s = store();
    const e = catchErr(() => s.reveal('{{secret:gh}} {{secret:nope}}', 'https://github.com'));
    assert.match(e.message, /unknown secret "nope"/);
    assert.match(e.hint ?? '', /gh/);
  });
  it('leaves text without handles alone', () => {
    assert.equal(store().reveal('no {{handles}} here', 'https://x.example'), 'no {{handles}} here');
  });
});

describe('redact', () => {
  const s = store();
  const b = Buffer.from(VALUE);
  const forms: [string, string][] = [
    ['raw', VALUE],
    ['encodeURIComponent', encodeURIComponent(VALUE)],
    ['lower-case percent', encodeURIComponent(VALUE).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())],
    ['form encoding', new URLSearchParams({ x: VALUE }).toString().slice(2)],
    ['base64', b.toString('base64')],
    ['base64 unpadded', b.toString('base64').replace(/=+$/, '')],
    ['base64url', b.toString('base64url')],
    ['hex', b.toString('hex')],
    ['HEX', b.toString('hex').toUpperCase()],
    ['JSON', JSON.stringify(VALUE).slice(1, -1)],
    ['HTML', VALUE.replace(/&/g, '&amp;')],
  ];
  for (const [name, f] of forms)
    it(`removes the ${name} form`, () => {
      const out = s.redact(`before ${f} after`);
      assert.equal(out, 'before {{secret:gh}} after');
    });
  it('removes the value inside a larger base64 blob at every alignment', () => {
    for (const prefix of ['', 'u', 'us', 'user:']) {
      const blob = Buffer.from(prefix + VALUE + ':tail').toString('base64');
      const out = s.redact(`Authorization: Basic ${blob}`);
      assert.match(out, /\{\{secret:gh\}\}/, `prefix ${JSON.stringify(prefix)}`);
    }
  });
  it('leaves ordinary text alone and handles several secrets', () => {
    assert.equal(s.redact('nothing secret here'), 'nothing secret here');
    assert.equal(s.redact(`a ${VALUE} b dev-token-123456 c`), 'a {{secret:gh}} b {{secret:local}} c');
  });
});

describe('sources', () => {
  it('reads AGENTWEB_SECRET_<NAME> and _ORIGINS from the environment', () => {
    const defs = secretsFromEnv({
      AGENTWEB_SECRET_GITHUB_TOKEN: 'ghp_x',
      AGENTWEB_SECRET_GITHUB_TOKEN_ORIGINS: 'https://github.com, https://api.github.com',
      AGENTWEB_SECRET_PLAIN: 'p',
      OTHER: 'ignored',
    });
    assert.deepEqual(defs.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: 'github_token', value: 'ghp_x', origins: ['https://github.com', 'https://api.github.com'] },
      { name: 'plain', value: 'p', origins: [] },
    ]);
  });
  it('reads a JSON file in both shapes, and env overrides file by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-guard-'));
    try {
      const f = join(dir, 's.json');
      writeFileSync(f, JSON.stringify({ bank: { value: 'file-value', origins: ['https://bank.example'] }, mail: { value: 'm', origins: 'https://mail.example' } }));
      const p = loadPolicy({ AGENTWEB_SECRETS_FILE: f, AGENTWEB_SECRET_BANK: 'env-value', AGENTWEB_SECRET_BANK_ORIGINS: 'https://bank.example' });
      const bank = p.secrets.find((s) => s.name === 'bank')!;
      assert.equal(bank.value, 'env-value');
      assert.deepEqual(p.secrets.find((s) => s.name === 'mail')!.origins, ['https://mail.example']);
      assert.deepEqual(parseSecrets([{ name: 'a', value: 'b', origins: ['https://a.example'] }]), [{ name: 'a', value: 'b', origins: ['https://a.example'] }]);
      writeFileSync(f, '{"x": {"value": "super-secret-value", ');
      const e = catchErr(() => loadPolicy({ AGENTWEB_SECRETS_FILE: f }));
      assert.ok(!e.message.includes('super-secret-value'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('rejects invalid origins and names without echoing values', () => {
    const e = catchErr(() => new SecretStore([{ name: 'x', value: 'top-secret-value', origins: ['ftp://x.example'] }]));
    assert.ok(!e.message.includes('top-secret-value'));
    assert.throws(() => new SecretStore([{ name: 'bad name', value: 'v', origins: [] }]));
  });
});

describe('guard integration', () => {
  it('reveal and redact through the Guard interface; state never holds the value', () => {
    const g = createGuard({ ...defaultPolicy('local'), secrets: [{ name: 'gh', value: VALUE, origins: ['https://github.com'] }] });
    assert.equal(g.reveal('{{secret:gh}}', 'https://github.com'), VALUE);
    assert.throws(() => g.reveal('{{secret:gh}}', 'https://gist.example'), (e: AwError) => e.code === 'policy');
    assert.equal(g.redact(`echo ${VALUE}`), 'echo {{secret:gh}}');
    g.observe('https://github.com', `your token is ${VALUE}`, true);
    assert.ok(!JSON.stringify(g.state()).includes(VALUE));
  });
});
