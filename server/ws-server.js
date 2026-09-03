// 순수 Node.js 내장 모듈만 사용하는 초경량 WebSocket 서버.
// 외부 패키지(ws, socket.io) 설치가 필요 없다 — npm install만으로 바로 동작한다.
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.alive = true;
    this._buf = Buffer.alloc(0);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => { this.alive = false; this.emit('close'); });
    socket.on('error', () => { this.alive = false; this.emit('close'); });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    // 버퍼에 프레임이 여러 개 쌓일 수 있으니 다 소진될 때까지 반복 파싱
    while (true) {
      const frame = this._tryParseFrame(this._buf);
      if (!frame) break;
      this._buf = this._buf.subarray(frame.total);
      if (frame.opcode === 0x8) { this.close(); return; }       // close
      if (frame.opcode === 0x9) { this._sendRaw(0xA, frame.payload); continue; } // ping->pong
      if (frame.opcode === 0x1) { this.emit('message', frame.payload.toString('utf8')); }
    }
  }

  _tryParseFrame(buf) {
    if (buf.length < 2) return null;
    const b0 = buf[0], b1 = buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset); offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      len = Number(buf.readBigUInt64BE(offset)); offset += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4); offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = buf.subarray(offset, offset + len);
    if (masked) {
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
      payload = out;
    }
    return { opcode, payload, total: offset + len };
  }

  _sendRaw(opcode, payload) {
    if (!this.alive) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (_) { /* ignore */ }
  }

  send(str) { this._sendRaw(0x1, Buffer.from(str, 'utf8')); }
  close() { if (this.alive) { this.alive = false; try { this._sendRaw(0x8, Buffer.alloc(0)); this.socket.end(); } catch (_) {} this.emit('close'); } }
}

/** httpServer의 'upgrade' 이벤트에 연결해서 쓴다. onConnection(conn, req)를 호출한다. */
function attachWebSocketServer(httpServer, onConnection) {
  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers['upgrade'] || '').toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n');
    socket.write(headers);
    const conn = new WSConnection(socket);
    onConnection(conn, req);
  });
}

module.exports = { attachWebSocketServer };
