// A WebSocket server endpoint with no dependencies: enough of RFC 6455 for JSON text messages
// between local processes (handshake, masking, fragments, ping/pong, close).

import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export interface WsConn {
  send(text: string): void;
  close(): void;
  onMessage: (text: string) => void;
  onClose: () => void;
  readonly open: boolean;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 256 * 1024 * 1024;

function frame(opcode: number, payload: Buffer): Buffer {
  const n = payload.length;
  let head: Buffer;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  return Buffer.concat([head, payload]);
}

/** Answer an HTTP upgrade request. Returns undefined (and closes the socket) when it is not a WebSocket handshake. */
export function acceptWs(req: IncomingMessage, socket: Duplex, head?: Buffer): WsConn | undefined {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
    socket.destroy();
    return undefined;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  (socket as { setNoDelay?: (b: boolean) => void }).setNoDelay?.(true);

  let open = true;
  let buf: Buffer = head && head.length ? head : Buffer.alloc(0);
  let parts: Buffer[] = [];
  let partsLen = 0;
  const conn: WsConn = {
    onMessage: () => {},
    onClose: () => {},
    get open() {
      return open;
    },
    send(text) {
      if (!open) throw new Error('socket closed');
      socket.write(frame(1, Buffer.from(text, 'utf8')));
    },
    close() {
      if (!open) return;
      open = false;
      try {
        socket.write(frame(8, Buffer.alloc(0)));
        socket.end();
      } catch {}
      conn.onClose();
    },
  };
  const end = () => {
    if (!open) return;
    open = false;
    socket.destroy();
    conn.onClose();
  };
  socket.on('data', (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return end();
        len = Number(big);
        off = 10;
      }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload = buf.subarray(off + (masked ? 4 : 0), need);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      buf = buf.subarray(need);
      if (opcode === 8) return end();
      if (opcode === 9) {
        if (open) socket.write(frame(10, payload));
        continue;
      }
      if (opcode === 10) continue;
      parts.push(payload);
      partsLen += payload.length;
      if (partsLen > MAX_MESSAGE) return end();
      if (!fin) continue;
      const whole = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      parts = [];
      partsLen = 0;
      try {
        conn.onMessage(whole.toString('utf8'));
      } catch {}
    }
  });
  socket.on('close', end);
  socket.on('error', end);
  return conn;
}
