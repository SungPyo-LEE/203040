'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { attachWebSocketServer } = require('./ws-server');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const httpServer = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);

  // Render 의 헬스체크용. 정적 파일을 거치지 않고 바로 응답한다.
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
    return;
  }

  if (p === '/') p = '/index.html';
  const full = path.join(PUBLIC_DIR, p);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

/** roomCode -> { conns: [conn1, conn2|null], prep } */
const rooms = new Map();

/* ── 웨이브 개시 동기화 ─────────────────────────────────
 * 예전에는 각자 「웨이브 개시」를 눌러 자기 판만 돌렸다. 그러면 빨리 누르는 쪽이 그냥 앞서 나가서,
 * 실력이 아니라 클릭 속도가 승부를 갈랐다.
 *
 * 이제 웨이브를 여는 것은 서버다:
 *   1. 각자 준비 단계에 들어오면 { t:'prep' } 을 보낸다 (웨이브 사이 효과 선택까지 끝난 뒤에).
 *   2. 두 사람이 다 들어오면 그 순간부터 PREP_MS 를 잰다 — 먼저 끝낸 쪽이 기다리는 동안은
 *      시간이 흐르지 않으므로, 느리게 막은 쪽도 배치할 시간을 온전히 받는다.
 *   3. 둘 다 준비를 누르면 기다리지 않고 즉시, 아니면 시간이 다 되면 자동으로 양쪽에 waveGo 를 보낸다.
 */
const PREP_MS = 15000;

function prepOf(room) {
  if (!room.prep) room.prep = { in: [false, false], ready: [false, false], timer: null };
  return room.prep;
}
function seatOf(room, conn) { return room.conns[0] === conn ? 0 : 1; }
function bothSend(room, obj) { for (const c of room.conns) if (c) send(c, obj); }
function stopPrepTimer(p) { if (p.timer) { clearTimeout(p.timer); p.timer = null; } }

/** 두 사람이 모두 준비 단계에 들어왔으면 제한시간을 건다 (이미 돌고 있으면 그대로 둔다) */
function openPrep(room) {
  const p = prepOf(room);
  if (p.timer || !p.in[0] || !p.in[1]) return;
  bothSend(room, { t: 'prepOpen', ms: PREP_MS });
  p.timer = setTimeout(() => { p.timer = null; fireWave(room); }, PREP_MS);
}

/** 둘 다 준비를 눌렀으면 제한시간을 기다리지 않는다 */
function firePrepIfReady(room) {
  const p = prepOf(room);
  if (p.ready[0] && p.ready[1]) fireWave(room);
}

function fireWave(room) {
  const p = prepOf(room);
  if (!p.in[0] || !p.in[1]) return;   // 한쪽이 아직 웨이브를 막고 있거나 판을 떠났다
  stopPrepTimer(p);
  p.in = [false, false];
  p.ready = [false, false];
  bothSend(room, { t: 'waveGo' });
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 헷갈리는 글자(0/O, 1/I) 제외
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[(Math.random() * chars.length) | 0]).join('');
  } while (rooms.has(code));
  return code;
}

function send(conn, obj) { try { conn.send(JSON.stringify(obj)); } catch (_) {} }
function otherOf(room, conn) { return room.conns[0] === conn ? room.conns[1] : room.conns[0]; }

function leaveRoom(conn) {
  if (!conn._room) return;
  const room = rooms.get(conn._room);
  if (!room) return;
  const other = otherOf(room, conn);
  if (other) { send(other, { t: 'oppLeft' }); other._room = null; }
  if (room.prep) stopPrepTimer(room.prep);   // 방이 사라진 뒤 타이머가 혼자 깨어나지 않도록
  rooms.delete(conn._room);
  conn._room = null;
}

// 방(room) 안에서 상대에게 그대로 중계하는 메시지 타입 → 상대가 받을 때의 타입
const RELAY = { state: 'oppState', passive: 'oppPassive', mutation: 'oppMutation', won: 'oppWon', lost: 'oppLost' };

attachWebSocketServer(httpServer, (conn) => {
  conn._room = null;

  conn.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }

    if (msg.t === 'create') {
      const code = makeCode();
      rooms.set(code, { conns: [conn, null] });
      conn._room = code;
      send(conn, { t: 'created', code });
      return;
    }

    if (msg.t === 'join') {
      const code = String(msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room || room.conns[1]) {
        send(conn, { t: 'joinError', reason: room ? '방이 가득 찼습니다' : '존재하지 않는 방입니다' });
        return;
      }
      room.conns[1] = conn;
      conn._room = code;
      send(room.conns[0], { t: 'start', youAre: 'p1' });
      send(room.conns[1], { t: 'start', youAre: 'p2' });
      return;
    }

    if (!conn._room) return;
    const room = rooms.get(conn._room);
    if (!room) return;
    const other = otherOf(room, conn);
    if (!other) return;

    // 준비 상태는 중계가 아니라 서버가 직접 판정한다 — 웨이브를 여는 주체가 서버이기 때문이다
    if (msg.t === 'prep') {
      prepOf(room).in[seatOf(room, conn)] = true;
      send(other, { t: 'oppPrep' });
      openPrep(room);
      firePrepIfReady(room);
      return;
    }
    if (msg.t === 'ready') {
      prepOf(room).ready[seatOf(room, conn)] = !!msg.on;
      send(other, { t: 'oppReady', on: !!msg.on });
      firePrepIfReady(room);
      return;
    }

    const relayType = RELAY[msg.t];
    if (relayType) send(other, Object.assign({}, msg, { t: relayType }));
  });

  conn.on('close', () => leaveRoom(conn));
});

// 컨테이너 밖에서도 닿아야 하므로 0.0.0.0 에 바인딩한다.
// localhost 로만 열면 Render 가 포트를 감지하지 못해 배포가 실패한다.
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[patent-siege] listening on 0.0.0.0:${PORT}`);
});

// 배포를 갈아끼울 때 붙어 있는 사람에게 끊긴 이유를 알리고 정리한다
function shutdown(sig) {
  console.log(`[patent-siege] ${sig} 수신 — 종료합니다`);
  for (const [code, room] of rooms) {
    for (const conn of room.conns) if (conn) send(conn, { t: 'oppLeft' });
    rooms.delete(code);
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();   // 남은 연결이 늘어져도 5초 뒤엔 내려간다
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
