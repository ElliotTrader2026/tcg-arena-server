/*
 * TCG ARENA — Multiplayer Server (Phase 1)
 * ----------------------------------------
 * Goal of this phase: get a server online and prove real-time messaging works.
 * You do NOT need to edit this file. Just paste it into Replit and press Run.
 *
 * What it does:
 *   - Serves a tiny "is it alive?" status page at the root URL.
 *   - Accepts real-time websocket connections (via Socket.io).
 *   - Tracks how many clients are connected and broadcasts that count live.
 *
 * Later phases build on these same connection events: login, matchmaking,
 * and the server-authoritative battle engine.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// During testnet/dev we allow any origin so your game can connect from
// anywhere (file://, localhost, or a hosted page). We'll lock this down later.
const io = new Server(server, { cors: { origin: '*' } });

const VERSION = 'phase1-0.1.0';
let online = 0; // how many clients are connected right now (in memory)

// --- Health / status page -------------------------------------------------
// Replit needs the homepage to respond quickly. This page also doubles as a
// live test: it connects to this same server and shows the player count.
app.get('/', (req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TCG Arena Server</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#14121a;color:#ece7df;text-align:center;padding:46px 16px;margin:0}
  h1{font-size:22px;font-weight:800}
  .k{color:#46d6c4}
  #n{font-size:48px;color:#e3c46a;font-weight:800;margin:6px 0}
  small{color:#9a93a6;line-height:1.5}
</style>
<h1>TCG Arena server is <span class="k">online</span> &#9989;</h1>
<p>Players connected right now:</p>
<div id="n">0</div>
<p id="msg"><small>connecting&hellip;</small></p>
<p style="max-width:440px;margin:18px auto"><small>Tip: open this same URL in a second tab and watch the number climb &mdash;
that's real-time multiplayer working. &nbsp;Server version ${VERSION}.</small></p>
<script src="/socket.io/socket.io.js"></script>
<script>
  const s = io();
  s.on('welcome', d => { document.getElementById('msg').innerHTML = '<small>' + d.msg + '</small>'; });
  s.on('online', n => { document.getElementById('n').textContent = n; });
</script>`);
});

// --- Real-time connections -------------------------------------------------
io.on('connection', (socket) => {
  online++;
  console.log('connect   ', socket.id, '· online:', online);

  // greet the new client
  socket.emit('welcome', { msg: 'Connected to the TCG Arena server', version: VERSION, id: socket.id });

  // tell everyone the updated count
  io.emit('online', online);

  // simple round-trip echo — proves two-way messaging.
  // (Real game events like "playCard" / "attack" get added in later phases.)
  socket.on('hello', (data) => {
    console.log('hello from', socket.id, data || '');
    socket.emit('serverMsg', { text: 'Server received your hello at ' + new Date().toLocaleTimeString() });
  });

  socket.on('disconnect', () => {
    online = Math.max(0, online - 1);
    console.log('disconnect', socket.id, '· online:', online);
    io.emit('online', online);
  });
});

// --- Start -----------------------------------------------------------------
// Bind to 0.0.0.0 and use the port Replit provides (falls back to 3000 locally).
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('TCG Arena server listening on 0.0.0.0:' + PORT);
});
