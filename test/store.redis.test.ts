// Redis client and store. There is no redis-server on the build machine, so these run
// against FakeRedis (src/store/fake-redis.ts), an in-process RESP server.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AwError } from '../src/types.ts';
import { RedisClient, RedisStore, RespParser, encodeCommand, parseRedisUrl, openStore, RedisError } from '../src/store/index.ts';
import { FakeRedis } from '../src/store/fake-redis.ts';
import { sampleRecord } from '../src/store/sample.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const servers: FakeRedis[] = [];
const dirs: string[] = [];
async function fake(opts?: ConstructorParameters<typeof FakeRedis>[0], port = 0): Promise<FakeRedis> {
  const f = new FakeRedis(opts);
  await f.listen(port);
  servers.push(f);
  return f;
}
after(async () => {
  for (const f of servers) await f.close().catch(() => {});
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('RESP parser', () => {
  const stream = Buffer.from(
    '+OK\r\n-ERR bad thing\r\n:42\r\n:-7\r\n$5\r\nhe\r\nl\r\n$-1\r\n*-1\r\n*0\r\n' +
    '*3\r\n$1\r\na\r\n*2\r\n:1\r\n:2\r\n$0\r\n\r\n' +
    '_\r\n#t\r\n#f\r\n,3.5\r\n,inf\r\n(123456789012345678901234567890\r\n' +
    '%2\r\n+a\r\n:1\r\n$1\r\nb\r\n:2\r\n~2\r\n:1\r\n:1\r\n>2\r\n+message\r\n+hi\r\n=8\r\ntxt:abcd\r\n' +
    '|1\r\n+ttl\r\n:3600\r\n+after-attribute\r\n!5\r\nOOPS!\r\n:9007199254740993\r\n',
  );
  const check = (vals: unknown[]) => {
    assert.equal(vals.length, 23);
    assert.equal(vals[0], 'OK');
    assert.ok(vals[1] instanceof RedisError && vals[1].message === 'ERR bad thing');
    assert.deepEqual(vals.slice(2, 4), [42, -7]);
    assert.deepEqual(vals[4], Buffer.from('he\r\nl'), 'bulk strings may contain CRLF');
    assert.deepEqual(vals.slice(5, 8), [null, null, []]);
    assert.deepEqual(vals[8], [Buffer.from('a'), [1, 2], Buffer.alloc(0)]);
    assert.deepEqual(vals.slice(9, 14), [null, true, false, 3.5, Infinity]);
    assert.equal(vals[14], 123456789012345678901234567890n);
    assert.deepEqual(vals[15], new Map<unknown, unknown>([['a', 1], ['b', 2]]));
    assert.deepEqual(vals[16], [1, 1]);
    assert.deepEqual((vals[17] as { data: unknown }).data, ['message', 'hi']);
    assert.equal(vals[18], 'abcd');
    assert.equal(vals[19], 'after-attribute');
    assert.ok(vals[20] instanceof RedisError && vals[20].message === 'OOPS!');
    assert.equal(vals[21], 9007199254740993n);
  };

  it('parses every RESP2 and RESP3 type from one chunk', () => {
    const vals = new RespParser().feed(Buffer.concat([stream, Buffer.from(':0\r\n')]));
    check(vals);
  });

  it('parses the same stream fed one byte at a time and in random chunks', () => {
    const full = Buffer.concat([stream, Buffer.from(':0\r\n')]);
    const p = new RespParser();
    const vals: unknown[] = [];
    for (const b of full) vals.push(...p.feed(Buffer.from([b])));
    check(vals);
    for (let trial = 0; trial < 50; trial++) {
      const q = new RespParser();
      const out: unknown[] = [];
      let i = 0;
      while (i < full.length) {
        const n = 1 + Math.floor(Math.random() * 20);
        out.push(...q.feed(full.subarray(i, i + n)));
        i += n;
      }
      check(out);
      assert.equal(q.buffered, 0);
    }
  });

  it('waits for a large bulk string without re-parsing every chunk', () => {
    const body = Buffer.alloc(1_000_000, 'x');
    const msg = Buffer.concat([Buffer.from(`$${body.length}\r\n`), body, Buffer.from('\r\n')]);
    const p = new RespParser();
    let got: unknown[] = [];
    for (let i = 0; i < msg.length; i += 16 * 1024) got = got.concat(p.feed(msg.subarray(i, i + 16 * 1024)));
    assert.equal(got.length, 1);
    assert.equal((got[0] as Buffer).length, body.length);
  });

  it('throws on a malformed stream', () => {
    assert.throws(() => new RespParser().feed(Buffer.from('?what\r\n')), /protocol error/);
    assert.throws(() => new RespParser().feed(Buffer.from('$3\r\nabcd\r\n')), /not terminated/);
    assert.throws(() => new RespParser().feed(Buffer.from('*x\r\n')), /bad length/);
  });

  it('encodes commands with binary arguments', () => {
    const wire = Buffer.concat(encodeCommand(['SET', 'kéy', Buffer.from([0, 13, 10, 255]), 'PX', 50]));
    assert.deepEqual(wire, Buffer.concat([Buffer.from('*5\r\n$3\r\nSET\r\n$4\r\nkéy\r\n$4\r\n'), Buffer.from([0, 13, 10, 255]), Buffer.from('\r\n$2\r\nPX\r\n$2\r\n50\r\n')]));
  });
});

describe('redis URLs', () => {
  it('parses users, passwords, databases, TLS and IPv6 hosts', () => {
    assert.deepEqual(parseRedisUrl('redis://localhost'), { host: 'localhost', port: 6379, tls: false, username: undefined, password: undefined, db: 0, params: {} });
    const u = parseRedisUrl('rediss://al%40ice:p%3Ass@cache.example:6380/4?prefix=x:');
    assert.deepEqual([u.host, u.port, u.tls, u.username, u.password, u.db, u.params.prefix], ['cache.example', 6380, true, 'al@ice', 'p:ss', 4, 'x:']);
    assert.equal(parseRedisUrl('redis://:secret@h').password, 'secret');
    assert.equal(parseRedisUrl('redis://:secret@h').username, undefined);
    assert.equal(parseRedisUrl('redis://[::1]:7000').host, '::1');
    assert.throws(() => parseRedisUrl('redis://h/notanumber'), AwError);
    assert.throws(() => parseRedisUrl('http://h'), AwError);
  });
});

describe('RedisClient', () => {
  it('authenticates and selects the database from the URL', async () => {
    const f = await fake({ password: 'pw' });
    const s = await openStore(`redis://:pw@127.0.0.1:${f.port}/3`);
    await s.set('n', 'k', { ok: true });
    assert.equal(f.db(3).size, 1);
    assert.equal(f.db(0).size, 0);
    assert.deepEqual(await s.get('n', 'k'), { ok: true });
    await s.close();

    const acl = await fake({ username: 'bot', password: 's3cret' });
    const t = await openStore(`redis://bot:s3cret@127.0.0.1:${acl.port}`);
    await t.set('n', 'k', 1);
    await t.close();
  });

  it('fails clearly on a wrong password and when nothing listens', async () => {
    const f = await fake({ password: 'pw' });
    await assert.rejects(openStore(`redis://:nope@127.0.0.1:${f.port}`, { waitMs: 500 }), (e: unknown) => e instanceof AwError && e.code === 'net' && /WRONGPASS/.test(e.message));
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    await new Promise<void>((r) => srv.close(() => r()));
    const t0 = Date.now();
    await assert.rejects(openStore(`redis://127.0.0.1:${port}`, { waitMs: 300 }), (e: unknown) => e instanceof AwError && e.code === 'net');
    assert.ok(Date.now() - t0 < 2000);
  });

  it('speaks RESP3 when asked (HELLO 3 with AUTH)', async () => {
    const f = await fake({ password: 'pw' });
    const s = await openStore(`redis://:pw@127.0.0.1:${f.port}?protocol=3`);
    await s.set('n', 'k', 'v');
    assert.equal(await s.get('n', 'k'), 'v');
    assert.equal(await s.get('n', 'missing'), undefined); // RESP3 null
    assert.equal(f.calls.get('HELLO'), 1);
    await s.close();
  });

  it('connects over TLS (rediss://)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'aw-tls-'));
    dirs.push(dir);
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', join(dir, 'k.pem'),
        '-out', join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
    } catch {
      t.skip('openssl not available');
      return;
    }
    const cert = readFileSync(join(dir, 'c.pem'));
    const f = await fake({ tls: { key: readFileSync(join(dir, 'k.pem')), cert } });
    assert.match(f.url, /^rediss:/);
    const s = await openStore(f.url, { tls: { ca: cert } });
    await s.set('n', 'k', sampleRecord(20_000));
    assert.deepEqual(await s.get('n', 'k'), sampleRecord(20_000));
    await s.close();
    // without trusting the self-signed cert the handshake must fail
    await assert.rejects(openStore(f.url, { waitMs: 500 }), AwError);
  });

  it('pipelines many concurrent commands on one connection, in order', async () => {
    const f = await fake();
    const s = new RedisStore(f.url);
    await Promise.all(Array.from({ length: 2000 }, (_, i) => s.set('p', `k${i}`, i)));
    const got = await Promise.all(Array.from({ length: 2000 }, (_, i) => s.get('p', `k${i}`)));
    assert.deepEqual(got, Array.from({ length: 2000 }, (_, i) => i));
    assert.equal(f.connections, 1);
    await s.close();
  });

  it('reconnects after the server drops the connection', async () => {
    const f = await fake();
    const s = new RedisStore(f.url, { minBackoffMs: 10 });
    await s.set('r', 'k', 1);
    f.dropAll();
    // issued before the client has seen the drop: written to the dead socket, failed as
    // in-flight, and (being a read) retried once after the reconnect
    assert.equal(await s.get('r', 'k'), 1);
    for (let i = 0; i < 3; i++) {
      f.dropAll();
      await sleep(30); // the client has now seen the close: writes wait in the offline queue
      await s.set('r', 'k', i);
      assert.equal(await s.get('r', 'k'), i);
    }
    assert.ok(s.stats().reconnects >= 4);
    assert.equal(s.stats().readRetries, 1);
    assert.equal(f.connections, s.stats().reconnects + 1);
    await s.close();
  });

  it('fails in-flight writes when the connection drops, without replaying them', async () => {
    const f = await fake();
    const s = new RedisStore(f.url, { minBackoffMs: 10 });
    await s.set('r', 'k', 'before');
    f.silent = true;
    const write = s.set('r', 'k', 'lost?');
    const read = s.get('r', 'k');
    await sleep(30);
    f.silent = false;
    f.dropAll();
    await assert.rejects(write, (e: unknown) => e instanceof AwError && e.code === 'net' && /may or may not/.test(e.message));
    assert.equal(await read, 'before', 'the read is retried on the new connection');
    assert.equal(s.stats().failedInflight, 2);
    assert.equal(await s.get('r', 'k'), 'before', 'the unanswered SET was never applied, and was not replayed');
    await s.close();
  });

  it('drops a connection that stops answering and recovers', async () => {
    const f = await fake();
    const c = new RedisClient({ port: f.port, commandTimeoutMs: 150, minBackoffMs: 10 });
    await c.waitReady();
    f.silent = true;
    await assert.rejects(c.command('PING'), (e: unknown) => e instanceof AwError && e.code === 'net');
    f.silent = false;
    assert.equal(await c.command('PING'), 'PONG');
    assert.ok(c.stats().timeouts >= 1);
    await c.close();
  });

  it('queues commands while the server is down and sends them when it is back', async () => {
    const f = await fake();
    const port = f.port;
    const s = new RedisStore(f.url, { minBackoffMs: 10, maxBackoffMs: 50, commandTimeoutMs: 5000 });
    await s.set('d', 'k', 'v1');
    await f.close();
    await sleep(30);
    const pending = s.set('d', 'k2', 'queued');
    await sleep(150);
    const back = await fake(undefined, port);
    await pending;
    assert.equal(back.db(0).size, 1);
    assert.equal(await s.get('d', 'k2'), 'queued');
    await s.close();
  });

  it('times out queued commands when the server stays down', async () => {
    const f = await fake();
    const s = new RedisStore(f.url, { minBackoffMs: 10, maxBackoffMs: 50, commandTimeoutMs: 200 });
    await s.set('d', 'k', 1);
    await f.close();
    await sleep(30);
    await assert.rejects(s.get('d', 'k'), (e: unknown) => e instanceof AwError && e.code === 'timeout');
    await s.close();
  });

  it('close() waits for in-flight replies', async () => {
    const f = await fake();
    const s = new RedisStore(f.url);
    await s.get('c', 'warm');
    const writes = Array.from({ length: 100 }, (_, i) => s.set('c', `k${i}`, i));
    await s.close();
    await Promise.all(writes);
    assert.equal(f.db(0).size, 100);
    assert.equal(f.calls.get('QUIT'), 1);
  });

  it('surfaces server error replies as AwError', async () => {
    const f = await fake();
    const c = new RedisClient({ port: f.port });
    await assert.rejects(c.command('NOPE'), (e: unknown) => e instanceof RedisError && /unknown command/.test(e.message));
    assert.equal(await c.command('PING'), 'PONG', 'an error reply does not break the pipeline');
    await c.close();
  });

  it('keeps stores with different prefixes apart and lists keys with SCAN', async () => {
    const f = await fake();
    const a = new RedisStore(f.url, { prefix: 'a:', scanCount: 7 });
    const b = new RedisStore(a.client, { prefix: 'b:' });
    for (let i = 0; i < 100; i++) await a.set('n', `k${i}`, i);
    await b.set('n', 'k1', 'b');
    assert.equal((await a.keys('n', 'k', Infinity)).length, 100);
    assert.deepEqual(await b.keys('n'), ['k1']);
    assert.equal(await b.get('n', 'k1'), 'b');
    assert.equal(await a.get('n', 'k1'), 1);
    assert.equal((await a.keys('n', 'k1')).sort().join(), 'k1,k10,k11,k12,k13,k14,k15,k16,k17,k18,k19');
    await b.close(); // b borrows a's client: closing b leaves it open
    assert.equal(await a.get('n', 'k2'), 2);
    await a.close();
  });

  it('sets TTLs with millisecond precision', async () => {
    const f = await fake();
    const s = new RedisStore(f.url);
    await s.set('t', 'k', 1, 0.25);
    const ttl = await s.client.command('PTTL', s.rkey('t', 'k'));
    assert.ok(typeof ttl === 'number' && ttl > 150 && ttl <= 250, String(ttl));
    await s.close();
  });
});
