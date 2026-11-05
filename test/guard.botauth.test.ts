import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  createBotSigner,
  DIRECTORY_TYPE,
  exportBotKey,
  generateBotKey,
  jwkThumbprint,
  loadBotKey,
  parseDictionary,
  verifyBotSignature,
} from '../src/guard/index.ts';

const NOW = 1_800_000_000;

describe('keys', () => {
  it('thumbprint follows RFC 7638 (RFC 8037 appendix A.3 test vector)', () => {
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' };
    assert.equal(jwkThumbprint(jwk), 'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k');
  });
  it('round-trips a generated key through JWK export and PEM', () => {
    const k = generateBotKey();
    const again = loadBotKey(exportBotKey(k));
    assert.equal(again.keyid, k.keyid);
    const pem = k.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    assert.equal(loadBotKey(pem).keyid, k.keyid);
    assert.throws(() => loadBotKey('{"kty":"OKP"'), /cannot load bot key/);
  });
});

describe('request signatures', () => {
  const key = generateBotKey();
  const signer = createBotSigner({ key, agent: 'https://agent.example' });
  const url = 'https://shop.example:8443/products?q=1';
  const h = signer.headers(url, { now: NOW, nonce: 'n0nce' });
  const keys = signer.directory().keys;

  it('produces the three headers in the Web Bot Auth shape', () => {
    assert.equal(h['signature-agent'], '"https://agent.example"');
    assert.match(h['signature-input'], /^sig1=\("@authority" "signature-agent"\);created=1800000000;keyid="[\w-]{43}";alg="ed25519";expires=1800000060;nonce="n0nce";tag="web-bot-auth"$/);
    assert.match(h.signature, /^sig1=:[A-Za-z0-9+/]+=*:$/);
    const sig = parseDictionary(h.signature).get('sig1')!;
    assert.ok('v' in sig && typeof sig.v === 'object' && 'bytes' in sig.v && sig.v.bytes.length === 64);
  });

  it('verifies', () => {
    const r = verifyBotSignature({ headers: h, authority: 'shop.example:8443', keys, now: NOW + 10 });
    assert.deepEqual(r, { ok: true, keyid: key.keyid, label: 'sig1', agent: 'https://agent.example' });
  });

  it('fails when a covered component changes', () => {
    const other = verifyBotSignature({ headers: h, authority: 'evil.example', keys, now: NOW });
    assert.equal(other.ok, false);
    const port = verifyBotSignature({ headers: h, authority: 'shop.example', keys, now: NOW });
    assert.equal(port.ok, false);
    const agent = verifyBotSignature({ headers: { ...h, 'signature-agent': '"https://impostor.example"' }, authority: 'shop.example:8443', keys, now: NOW });
    assert.equal(agent.ok, false);
    if (!agent.ok) assert.match(agent.reason, /does not verify/);
  });

  it('fails when the signature parameters are tampered with', () => {
    const later = h['signature-input'].replace('expires=1800000060', 'expires=1900000000');
    const r = verifyBotSignature({ headers: { ...h, 'signature-input': later }, authority: 'shop.example:8443', keys, now: NOW });
    assert.equal(r.ok, false);
  });

  it('enforces time, key and tag', () => {
    assert.match(String((verifyBotSignature({ headers: h, authority: 'shop.example:8443', keys, now: NOW + 3600 }) as { reason: string }).reason), /expired/);
    assert.match(String((verifyBotSignature({ headers: h, authority: 'shop.example:8443', keys, now: NOW - 3600 }) as { reason: string }).reason), /future/);
    const stranger = generateBotKey();
    assert.match(String((verifyBotSignature({ headers: h, authority: 'shop.example:8443', keys: [stranger.jwk], now: NOW }) as { reason: string }).reason), /unknown keyid/);
    assert.equal(verifyBotSignature({ headers: h, authority: 'shop.example:8443', keys, now: NOW, tag: 'other' }).ok, false);
    assert.equal(verifyBotSignature({ headers: {}, authority: 'shop.example:8443', keys, now: NOW }).ok, false);
    assert.equal(verifyBotSignature({ headers: { ...h, signature: 'sig1=:AAAA' }, authority: 'shop.example:8443', keys, now: NOW }).ok, false);
  });

  it('header names are case-insensitive on the verifier', () => {
    const upper = { 'Signature-Input': h['signature-input'], Signature: h.signature, 'Signature-Agent': h['signature-agent'] };
    assert.equal(verifyBotSignature({ headers: upper, authority: 'shop.example:8443', keys, now: NOW }).ok, true);
  });
});

describe('key directory', () => {
  const key = generateBotKey();
  const signer = createBotSigner({ key, agent: 'https://agent.example/' });
  it('publishes the public key only, with a signed response', () => {
    const res = signer.directoryResponse('agent.example', { now: NOW });
    assert.equal(res.headers['content-type'], DIRECTORY_TYPE);
    const doc = JSON.parse(res.body);
    assert.deepEqual(Object.keys(doc.keys[0]).sort(), ['crv', 'kty', 'x']);
    assert.ok(!res.body.includes('"d"'));
    assert.equal(jwkThumbprint(doc.keys[0]), key.keyid);
    assert.match(res.headers['signature-input'], /\("@authority";req\).*tag="http-message-signatures-directory"/);
    const v = verifyBotSignature({ headers: res.headers, authority: 'agent.example', keys: doc.keys, now: NOW, tag: 'http-message-signatures-directory' });
    assert.equal(v.ok, true);
    assert.equal(verifyBotSignature({ headers: res.headers, authority: 'mirror.example', keys: doc.keys, now: NOW, tag: 'http-message-signatures-directory' }).ok, false);
  });
  it('nonces differ per request', () => {
    const a = signer.headers('https://x.example/', { now: NOW });
    const b = signer.headers('https://x.example/', { now: NOW });
    assert.notEqual(a['signature-input'], b['signature-input']);
    assert.notEqual(createHash('sha256').update(a.signature).digest('hex'), createHash('sha256').update(b.signature).digest('hex'));
  });
});
