import assert from 'node:assert/strict';
import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import {
  checkUrlSafety,
  createGuard,
  defaultPolicy,
  isPublicAddress,
  makeSsrfLookup,
  numericHost,
  parseIPv4Loose,
  parseIPv6,
  type Resolver,
} from '../src/guard/index.ts';

describe('isPublicAddress', () => {
  const notPublic: [string, string][] = [
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'this-network'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'rfc1918'],
    ['172.16.0.1', 'rfc1918'],
    ['172.31.255.255', 'rfc1918'],
    ['192.168.1.1', 'rfc1918'],
    ['169.254.169.254', 'metadata / link-local'],
    ['169.254.1.1', 'link-local'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.100.100.200', 'alibaba metadata'],
    ['192.0.0.192', 'oracle metadata'],
    ['168.63.129.16', 'azure wireserver (public range, still refused)'],
    ['192.0.2.1', 'TEST-NET-1'],
    ['198.51.100.7', 'TEST-NET-2'],
    ['203.0.113.9', 'TEST-NET-3'],
    ['198.18.0.1', 'benchmark'],
    ['192.88.99.1', '6to4 relay'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'v6 unspecified'],
    ['::1', 'v6 loopback'],
    ['[::1]', 'bracketed'],
    ['fe80::1%eth0', 'link-local with zone'],
    ['fc00::1', 'ULA'],
    ['fd00:ec2::254', 'AWS v6 metadata'],
    ['fec0::1', 'site-local'],
    ['ff02::1', 'v6 multicast'],
    ['100::1', 'discard'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation (RFC 9637)'],
    ['::ffff:127.0.0.1', 'v4-mapped loopback'],
    ['::ffff:7f00:1', 'v4-mapped loopback, hex'],
    ['::ffff:169.254.169.254', 'v4-mapped metadata'],
    ['::ffff:10.1.2.3', 'v4-mapped private'],
    ['::127.0.0.1', 'v4-compatible loopback'],
    ['::10.0.0.1', 'v4-compatible private'],
    ['::ffff:0:192.168.0.1', 'SIIT translated'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['64:ff9b::169.254.169.254', 'NAT64 metadata'],
    ['64:ff9b:1::1', 'local-use NAT64'],
    ['2002:7f00:1::', '6to4 loopback'],
    ['2002:c0a8:101::1', '6to4 192.168.1.1'],
    ['2002:a9fe:a9fe::1', '6to4 metadata'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'Teredo, client 192.0.2.45'],
    ['2001:0:c0a8:101:0:0:f7ff:fffe', 'Teredo, server 192.168.1.1'],
    ['2001:2::1', 'benchmarking'],
    ['not-an-ip', 'garbage'],
    ['', 'empty'],
  ];
  for (const [ip, why] of notPublic)
    it(`refuses ${ip || '(empty)'} (${why})`, () => assert.equal(isPublicAddress(ip), false));

  const pub = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '192.169.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'];
  for (const ip of pub) it(`accepts ${ip}`, () => assert.equal(isPublicAddress(ip), true));

  it('handles loose IPv4 forms like inet_aton', () => {
    assert.equal(isPublicAddress('0x7f.1'), false);
    assert.equal(isPublicAddress('2130706433'), false);
    assert.equal(isPublicAddress('017700000001'), false);
    assert.equal(isPublicAddress('0x8.0x8.0x8.0x8'), true);
  });
});

describe('numeric host encodings', () => {
  const cases: [string, string][] = [
    ['2130706433', '127.0.0.1'],
    ['0x7f000001', '127.0.0.1'],
    ['0x7F.0.0.1', '127.0.0.1'],
    ['0177.0.0.1', '127.0.0.1'],
    ['017700000001', '127.0.0.1'],
    ['127.1', '127.0.0.1'],
    ['127.0.1', '127.0.0.1'],
    ['0', '0.0.0.0'],
    ['0x0', '0.0.0.0'],
    ['127.0.0.1.', '127.0.0.1'],
    ['3232235777', '192.168.1.1'],
    ['0xa9.0xfe.0xa9.0xfe', '169.254.169.254'],
    ['0251.0376.0251.0376', '169.254.169.254'],
    ['169.16689662', '169.254.169.254'],
  ];
  for (const [h, want] of cases) it(`${h} → ${want}`, () => assert.equal(numericHost(h), want));
  it('rejects out-of-range and non-numeric forms', () => {
    assert.equal(parseIPv4Loose('256.0.0.1'), null);
    assert.equal(parseIPv4Loose('1.2.3.4.5'), null);
    assert.equal(parseIPv4Loose('4294967296'), null);
    assert.equal(parseIPv4Loose('09.1.1.1'), null);
    assert.equal(parseIPv4Loose('example.com'), null);
    assert.equal(numericHost('1e3'), null);
  });
  it('parses IPv6 forms', () => {
    assert.deepEqual(parseIPv6('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
    assert.deepEqual(parseIPv6('1::'), [1, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(parseIPv6('1:2:3:4:5:6:7:8'), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), null);
    assert.equal(parseIPv6('1::2::3'), null);
    assert.equal(parseIPv6('::ffff:1.2.3.256'), null);
    assert.equal(parseIPv6('12345::'), null);
  });
});

/** A resolver backed by a table; unknown names fail like NXDOMAIN. */
function fakeDns(table: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const r = (async (host: string) => {
    calls.push(host);
    const a = table[host];
    if (!a) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    return a;
  }) as Resolver & { calls: string[] };
  r.calls = calls;
  return r;
}

describe('checkUrlSafety (hosted: no private)', () => {
  const resolve = fakeDns({
    'example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    'mixed.example': ['93.184.216.34', '10.0.0.5'],
    'mixed6.example': ['2606:4700::1', '::1'],
    'rebind.example': ['127.0.0.1'],
    'mapped.example': ['::ffff:169.254.169.254'],
    'nip.example': ['192.168.0.10'],
  });
  const opts = { allowPrivate: false, resolve };
  const refused: [string, RegExp][] = [
    ['http://127.0.0.1/', /loopback/],
    ['http://localhost:8080/', /internal host/],
    ['http://LOCALHOST./', /internal host/],
    ['http://app.localhost/', /internal host/],
    ['http://printer.local/', /internal host/],
    ['http://db.internal/', /internal host/],
    ['http://metadata.google.internal/computeMetadata/v1/', /metadata/],
    ['http://router/', /single-label/],
    ['http://wiki.intranet/', /internal host/],
    ['http://2130706433/', /loopback/],
    ['http://0x7f.1/', /loopback/],
    ['http://0177.0.0.1/', /loopback/],
    ['http://127.1/', /loopback/],
    ['http://0/', /this-network/],
    ['http://169.254.169.254/latest/meta-data/', /metadata/],
    ['http://[::1]/', /loopback|IPv4-embedded/],
    ['http://[::ffff:127.0.0.1]/', /IPv4-embedded loopback/],
    ['http://[::ffff:a9fe:a9fe]/', /metadata/],
    ['http://[fd00:ec2::254]/', /metadata/],
    ['http://[64:ff9b::a00:1]/', /IPv4-embedded private/],
    ['http://[2002:c0a8:1::]/', /6to4/],
    ['http://[fe80::1]/', /link-local/],
    ['http://mixed.example/', /10\.0\.0\.5/],
    ['http://mixed6.example/', /::1/],
    ['http://rebind.example/', /127\.0\.0\.1/],
    ['http://mapped.example/', /metadata/],
    ['http://nip.example/', /private/],
    ['http://nxdomain.example/', /cannot resolve/],
    ['ftp://example.com/', /scheme/],
    ['file:///etc/passwd', /scheme/],
    ['gopher://example.com/', /scheme/],
    ['javascript:alert(1)', /scheme/],
    ['data:text/html,hi', /scheme/],
    ['http://user:pass@example.com/', /credentials/],
    ['http://user@example.com/', /credentials/],
    ['https://example.com@127.0.0.1/', /credentials/],
    ['not a url', /valid/],
  ];
  for (const [url, re] of refused)
    it(`refuses ${url}`, async () => {
      const r = await checkUrlSafety(url, opts);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.reason, re);
    });
  it('accepts a host whose every record is public', async () => {
    const r = await checkUrlSafety('https://example.com/a?b=c', opts);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.addresses?.length, 2);
  });
  it('accepts public IP literals', async () => {
    assert.equal((await checkUrlSafety('http://8.8.8.8/', opts)).ok, true);
    assert.equal((await checkUrlSafety('http://[2606:4700:4700::1111]/', opts)).ok, true);
  });
  it('caches DNS answers per resolver', async () => {
    const r = fakeDns({ 'cache.example': ['93.184.216.34'] });
    await checkUrlSafety('http://cache.example/1', { allowPrivate: false, resolve: r });
    await checkUrlSafety('http://cache.example/2', { allowPrivate: false, resolve: r });
    assert.equal(r.calls.length, 1);
  });
  it('treats a DNS timeout as a refusal', async () => {
    const slow: Resolver = () => new Promise(() => {});
    const r = await checkUrlSafety('http://slow.example/', { allowPrivate: false, resolve: slow, dnsTimeoutMs: 20 });
    assert.equal(r.ok, false);
  });
});

describe('checkUrlSafety (local: allowPrivate)', () => {
  const opts = { allowPrivate: true, resolve: fakeDns({}) };
  it('allows localhost and private addresses', async () => {
    for (const u of ['http://localhost:3000/', 'http://127.0.0.1/', 'http://192.168.1.10/', 'http://[::1]:8080/'])
      assert.equal((await checkUrlSafety(u, opts)).ok, true, u);
  });
  it('still refuses cloud metadata in every encoding', async () => {
    for (const u of ['http://169.254.169.254/', 'http://0xa9fea9fe/', 'http://[::ffff:169.254.169.254]/', 'http://metadata.google.internal/', 'http://168.63.129.16/', 'http://[fd00:ec2::254]/'])
      assert.equal((await checkUrlSafety(u, opts)).ok, false, u);
  });
  it('still refuses bad schemes and credentials', async () => {
    assert.equal((await checkUrlSafety('file:///etc/passwd', opts)).ok, false);
    assert.equal((await checkUrlSafety('http://a:b@localhost/', opts)).ok, false);
  });
});

describe('guard.checkUrl', () => {
  it('applies allow and deny lists before DNS', async () => {
    const resolve = fakeDns({ 'docs.example.com': ['93.184.216.34'], 'evil.example.com': ['93.184.216.35'], 'other.org': ['93.184.216.36'] });
    const g = createGuard({ ...defaultPolicy('hosted'), allow: ['example.com'], deny: ['evil.example.com'] }, undefined, { resolve });
    assert.equal((await g.checkUrl('https://docs.example.com/', 'open')).ok, true);
    const d = await g.checkUrl('https://evil.example.com/', 'open');
    assert.equal(d.ok, false);
    if (!d.ok) assert.match(d.reason, /deny list/);
    const o = await g.checkUrl('https://other.org/', 'redirect');
    assert.equal(o.ok, false);
    if (!o.ok) assert.match(o.reason, /allow list/);
    assert.deepEqual(resolve.calls, ['docs.example.com']);
  });
});

describe('ssrfLookup at connect time (DNS rebinding)', () => {
  it('refuses when the name now resolves to loopback, so a real request fails', async () => {
    const server = http.createServer((_q, s) => s.end('secret internal page'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      // the "attacker's" name resolves to loopback at connect time
      const rebinding = ((h: string, o: dns.LookupOptions, cb: (e: null, a: dns.LookupAddress[]) => void) =>
        cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as typeof dns.lookup;
      const lookup = makeSsrfLookup({ lookup: rebinding });
      const err = await new Promise<Error | null>((resolve) => {
        const req = http.get({ host: 'rebind.attacker.example', port, path: '/', lookup: lookup as never }, (res) => {
          res.resume();
          resolve(null);
        });
        req.on('error', resolve);
      });
      assert.ok(err, 'request must fail');
      assert.equal((err as { code?: string }).code, 'policy');
      // permissive lookup reaches it, proving the server was reachable
      const ok = makeSsrfLookup({ allowPrivate: true, lookup: rebinding });
      const body = await new Promise<string>((resolve, reject) => {
        http.get({ host: 'rebind.attacker.example', port, path: '/', lookup: ok as never }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve(b));
        }).on('error', reject);
      });
      assert.equal(body, 'secret internal page');
    } finally {
      server.close();
    }
  });

  const mixed = ((h: string, o: dns.LookupOptions, cb: (e: null, a: dns.LookupAddress[]) => void) =>
    cb(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '::ffff:10.0.0.1', family: 6 },
    ])) as unknown as typeof dns.lookup;
  const pub = ((h: string, o: dns.LookupOptions, cb: (e: null, a: dns.LookupAddress[]) => void) =>
    cb(null, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ])) as unknown as typeof dns.lookup;

  it('fails on mixed public and private answers', async () => {
    const lookup = makeSsrfLookup({ lookup: mixed });
    const e = await new Promise<Error | null>((r) => lookup('x.example', {}, (err) => r(err)));
    assert.ok(e);
  });
  it('supports all three dns.lookup call shapes', async () => {
    const lookup = makeSsrfLookup({ lookup: pub });
    const a = await new Promise<unknown[]>((r) => lookup('x.example', (err, addr, fam) => r([err, addr, fam])));
    assert.deepEqual(a, [null, '93.184.216.34', 4]);
    const b = await new Promise<unknown[]>((r) => lookup('x.example', 4, (err, addr, fam) => r([err, addr, fam])));
    assert.deepEqual(b, [null, '93.184.216.34', 4]);
    const c = await new Promise<unknown>((r) => lookup('x.example', { all: true }, (_e, addr) => r(addr)));
    assert.equal((c as unknown[]).length, 2);
  });
  it('refuses internal names without resolving', async () => {
    let called = false;
    const spy = ((...a: unknown[]) => {
      called = true;
      (a[2] as (e: null, x: dns.LookupAddress[]) => void)(null, []);
    }) as unknown as typeof dns.lookup;
    const lookup = makeSsrfLookup({ lookup: spy });
    const e = await new Promise<Error | null>((r) => lookup('metadata.google.internal', {}, (err) => r(err)));
    assert.ok(e);
    assert.equal(called, false);
  });
});
