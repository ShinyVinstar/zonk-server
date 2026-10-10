// ─────────────────────────────────────────────────────────────
//  Минимальный WebSocket (RFC 6455) без внешних зависимостей.
//  Только текстовые сообщения — этого хватает для игры.
// ─────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MSG = 64 * 1024;

export class Socket extends EventEmitter {
  constructor(sock, ip) {
    super();
    this.sock = sock;
    this.ip = ip;
    this.open = true;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.alive = true;
    sock.setNoDelay(true);
    sock.on('data', (d) => this._data(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }

  send(obj) {
    if (!this.open) return;
    const data = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
    this._frame(0x1, data);
  }

  /** Проверка «живости»: браузер сам отвечает pong. */
  ping() {
    if (!this.open) return;
    if (!this.alive) { this.sock.destroy(); this._closed(); return; }
    this.alive = false;
    try { this._frame(0x9, Buffer.alloc(0)); } catch { this._closed(); }
  }

  close(code = 1000) {
    if (!this.open) return;
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    try { this._frame(0x8, p); } catch { /* сокет уже закрыт */ }
    this.open = false;
    setTimeout(() => this.sock.destroy(), 200);
    this._closed();
  }

  _frame(op, data) {
    const n = data.length;
    let head;
    if (n < 126) { head = Buffer.alloc(2); head[1] = n; }
    else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
    else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
    head[0] = 0x80 | op;
    this.sock.write(Buffer.concat([head, data]));
  }

  _data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG || !masked) return this.close(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this.alive = true;

      if (op === 0x8) return this.close();
      if (op === 0x9) { this._frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) {
        if (fin) this._msg(payload); else this.frag = [payload];
      } else if (op === 0x0 && this.frag) {
        this.frag.push(payload);
        if (this.frag.reduce((s, b) => s + b.length, 0) > MAX_MSG) return this.close(1009);
        if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this._msg(all); }
      }
    }
  }

  _msg(buf) {
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (m && typeof m === 'object') this.emit('message', m);
  }

  _closed() {
    if (this._gone) return;
    this._gone = true;
    this.open = false;
    this.emit('close');
  }
}

/** Принять апгрейд HTTP → WebSocket. Возвращает Socket или null. */
export function accept(req, sock) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const acceptKey = createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return new Socket(sock, ip);
}
