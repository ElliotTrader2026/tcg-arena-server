/*
 * TCG ARENA — Multiplayer Server (Phase 2: Matchmaking)
 * -----------------------------------------------------
 *  Phase 1 (done):  live connection + real-time player count.
 *  Phase 2 (this):  a matchmaking QUEUE — two players who hit "Find Battle"
 *                   get paired into a private duel room and told who their
 *                   opponent is. Includes a ready-check handshake.
 *  Phase 3 (next):  the actual synchronized, server-refereed battle starts
 *                   from the 'room:start' event below.
 *
 * You don't need to edit this file — just paste it into your GitHub repo's
 * index.js (replacing what's there) and Render will redeploy automatically.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const VERSION = 'phase2-0.2.0';
let online = 0;

// --- matchmaking state (kept in memory) ---
let queue = [];                 // socket ids currently waiting for an opponent
const rooms = new Map();        // roomId -> { players:[idA,idB], names:{id:name}, ready:Set }

function nameOf(socket) {
  return (socket && socket.data && socket.data.name) || 'Duelist';
}

// --- Status page (visit the URL to confirm the server is live) ---
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TCG Arena Server</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#14121a;color:#ece7df;text-align:center;padding:46px 16px;margin:0}
  h1{font-size:22px;font-weight:800}.k{color:#46d6c4}
  #n{font-size:48px;color:#e3c46a;font-weight:800;margin:6px 0}
  small{color:#9a93a6;line-height:1.5}
</style>
<h1>TCG Arena server is <span class="k">online</span> &#9989;</h1>
<p>Players connected right now:</p>
<div id="n">0</div>
<p id="msg"><small>connecting&hellip;</small></p>
<p style="max-width:440px;margin:18px auto"><small>Matchmaking is active. Server version ${VERSION}.</small></p>
<script src="/socket.io/socket.io.js"></script>
<script>
  const s = io();
  s.on('welcome', d => { document.getElementById('msg').innerHTML = '<small>' + d.msg + '</small>'; });
  s.on('online', n => { document.getElementById('n').textContent = n; });
</script>`);
});

io.on('connection', (socket) => {
  online++;
  socket.emit('welcome', { msg: 'Connected to the TCG Arena server', version: VERSION, id: socket.id });
  io.emit('online', online);

  // Phase 1 echo (kept for the "Send test ping" button)
  socket.on('hello', () => {
    socket.emit('serverMsg', { text: 'Server received your hello at ' + new Date().toLocaleTimeString() });
  });

  // --- Matchmaking: join the queue ---
  socket.on('queue:join', (data) => {
    socket.data.name = (data && data.name) ? String(data.name).slice(0, 24) : 'Duelist';
    if (!queue.includes(socket.id)) queue.push(socket.id);
    tryMatch();
    if (queue.includes(socket.id)) {
      socket.emit('queue:waiting', { position: queue.indexOf(socket.id) + 1 });
    }
  });

  // --- Matchmaking: cancel / leave the queue ---
  socket.on('queue:leave', () => {
    queue = queue.filter((id) => id !== socket.id);
    socket.emit('queue:left');
  });

  // --- Ready-check inside a duel room ---
  socket.on('room:ready', (data) => {
    const room = rooms.get(data && data.roomId);
    if (!room || !room.players.includes(socket.id)) return;
    room.ready.add(socket.id);
    io.to(data.roomId).emit('room:readyState', { ready: [...room.ready], total: room.players.length });
    if (room.ready.size === room.players.length) {
      // Both players ready — Phase 3 (the real battle) will begin here.
      io.to(data.roomId).emit('room:start', { roomId: data.roomId });
    }
  });

  socket.on('disconnect', () => {
    online = Math.max(0, online - 1);
    queue = queue.filter((id) => id !== socket.id);
    for (const [roomId, room] of rooms) {
      if (room.players.includes(socket.id)) {
        socket.to(roomId).emit('opponent:left');
        rooms.delete(roomId);
      }
    }
    io.emit('online', online);
  });
});

// Pair as many waiting players as possible (simple first-come-first-served for now;
// Battle-Points bracket matching comes later, once there's a real player base).
function tryMatch() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    const sa = io.sockets.sockets.get(a);
    const sb = io.sockets.sockets.get(b);
    if (!sa || !sb) continue;
    const roomId = 'room_' + Math.random().toString(36).slice(2, 10);
    sa.join(roomId);
    sb.join(roomId);
    rooms.set(roomId, {
      players: [a, b],
      names: { [a]: nameOf(sa), [b]: nameOf(sb) },
      ready: new Set(),
    });
    sa.emit('match:found', { roomId, opponent: nameOf(sb) });
    sb.emit('match:found', { roomId, opponent: nameOf(sa) });
    console.log('match:', nameOf(sa), 'vs', nameOf(sb), '->', roomId);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('TCG Arena server (Phase 2) listening on port ' + PORT));
