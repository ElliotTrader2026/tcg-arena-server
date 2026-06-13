/*
 * TCG ARENA — Multiplayer Server (Phase 3a: server-refereed turns)
 * ----------------------------------------------------------------
 *  Phase 1 (done):   live connection + real-time player count.
 *  Phase 2 (done):   matchmaking queue + ready-check  ->  'room:start'.
 *  Phase 3a (this):  the duel begins, with the SERVER as the referee:
 *                      - it shuffles each player's deck and deals the
 *                        opening hands (so neither browser can cheat),
 *                      - it owns whose turn it is and the turn counter,
 *                      - it draws a card for the active player each turn,
 *                      - it sends each player a PERSONALIZED view: you see
 *                        your own hand; you only see the opponent's hand
 *                        as a COUNT, never their actual cards.
 *                    No card-playing or attacks yet — that arrives in 3b/3c.
 *
 *  How a battle flows now:
 *      room:start   ->  each client sends   battle:join {roomId, deck}
 *      both joined  ->  server deals + sends   battle:state   to each
 *      your turn    ->  you click End Turn ->  battle:endTurn {roomId}
 *      server       ->  flips turn, draws for the next player, re-sends state
 *
 *  You don't need to edit this file — just paste it into your GitHub repo's
 *  index.js (replacing what's there) and Render will redeploy automatically.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const VERSION = 'phase3a-0.3.0';
let online = 0;

// --- matchmaking + battle state (kept in memory) ---
let queue = [];                 // socket ids waiting for an opponent
const rooms = new Map();        // roomId -> { players:[idA,idB], names:{id:name}, ready:Set, battle:{...}|null }

// battle tuning — mirrors the single-player engine
const START_DP   = 800;         // shield (absorbs damage first)
const START_LP   = 1000;        // life (under the shield)
const HAND_SIZE  = 5;           // opening hand
const MAX_COPIES = 3;           // max copies of one card in a deck
const MAX_DECK   = 20;          // max total cards in a deck

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
<p style="max-width:460px;margin:18px auto"><small>Matchmaking + server-refereed turns are active. Server version ${VERSION}.</small></p>
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
      // Both ready — open a fresh battle slot and tell the clients to load in.
      room.battle = {
        submitted: {},          // sid -> sanitized deck map, until both have sent battle:join
        joined: new Set(),
        started: false,
        players: {},            // sid -> { name, DP, LP, hand[], deck[], mon[5], spell[5], grave[] }
        turn: null,
        turnNumber: 0,
        phase: 'main',
        over: null,
      };
      io.to(data.roomId).emit('room:start', { roomId: data.roomId });
    }
  });

  // ===== Phase 3a: the server-refereed battle =====

  // Each client sends its deck once it lands on the battle screen.
  socket.on('battle:join', (data) => {
    const roomId = data && data.roomId;
    const room = rooms.get(roomId);
    if (!room || !room.battle || !room.players.includes(socket.id)) return;
    if (room.battle.started) {                 // already running (e.g. a refresh) — just resend their view
      socket.emit('battle:state', stateFor(roomId, socket.id));
      return;
    }
    room.battle.submitted[socket.id] = sanitizeDeck(data && data.deck);
    room.battle.joined.add(socket.id);
    if (room.battle.joined.size === room.players.length) {
      startBattle(roomId);
    } else {
      socket.emit('battle:waiting', { msg: 'Waiting for your opponent to load in…' });
    }
  });

  // The active player ends their turn.
  socket.on('battle:endTurn', (data) => {
    const room = rooms.get(data && data.roomId);
    if (!room || !room.battle || !room.battle.started || room.battle.over) return;
    if (!room.players.includes(socket.id)) return;
    if (room.battle.turn !== socket.id) return;        // not your turn — ignore

    const oppId = room.players.find((id) => id !== socket.id);
    room.battle.turn = oppId;
    room.battle.turnNumber++;
    room.battle.phase = 'main';

    // Draw a card for the player whose turn just began.
    const np = room.battle.players[oppId];
    if (np.deck.length > 0) {
      np.hand.push(np.deck.pop());
    } else {
      // Can't draw from an empty deck -> that player loses (deck-out).
      room.battle.over = { winner: socket.id, loser: oppId, reason: 'deckout' };
    }
    broadcastState(data.roomId);
  });

  socket.on('disconnect', () => {
    online = Math.max(0, online - 1);
    queue = queue.filter((id) => id !== socket.id);
    for (const [roomId, room] of rooms) {
      if (room.players.includes(socket.id)) {
        socket.to(roomId).emit('opponent:left');       // tell the other duelist
        rooms.delete(roomId);
      }
    }
    io.emit('online', online);
  });
});

// Pair waiting players (first-come-first-served for now;
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
      battle: null,
    });
    sa.emit('match:found', { roomId, opponent: nameOf(sb) });
    sb.emit('match:found', { roomId, opponent: nameOf(sa) });
    console.log('match:', nameOf(sa), 'vs', nameOf(sb), '->', roomId);
  }
}

// ---- battle helpers ----

// Clean a client-sent deck: { cardKey: count }. Caps copies and total size and
// drops anything malformed. The server treats card keys as opaque labels for now
// (it doesn't need the card stats until 3b/3c), so it never trusts numbers blindly.
function sanitizeDeck(map) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  let total = 0;
  for (const k in map) {
    let n = parseInt(map[k], 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    n = Math.min(n, MAX_COPIES);
    if (total + n > MAX_DECK) n = MAX_DECK - total;
    if (n <= 0) break;
    out[String(k).slice(0, 40)] = n;
    total += n;
  }
  return out;
}

function expandDeck(map) {
  const arr = [];
  for (const k in map) for (let i = 0; i < map[k]; i++) arr.push(k);
  return arr;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deal the opening hands and pick who goes first.
function startBattle(roomId) {
  const room = rooms.get(roomId);
  const b = room.battle;
  let cid = 0;                                          // unique id per dealt card
  function buildSide(sid) {
    const keys = shuffle(expandDeck(b.submitted[sid] || {}));
    const cards = keys.map((k) => ({ id: 'c' + (++cid), key: k }));
    const hand = cards.splice(0, HAND_SIZE);            // first 5 -> hand, rest stays as the deck
    return {
      name: room.names[sid] || 'Duelist',
      DP: START_DP, LP: START_LP,
      hand, deck: cards,
      mon: [null, null, null, null, null],
      spell: [null, null, null, null, null],
      grave: [],
    };
  }
  b.players = {};
  for (const sid of room.players) b.players[sid] = buildSide(sid);
  b.turn = room.players[Math.random() < 0.5 ? 0 : 1];  // coin flip for who moves first
  b.turnNumber = 1;
  b.phase = 'main';
  b.over = null;
  b.started = true;
  console.log('battle start in', roomId, '— first move:', room.names[b.turn]);
  broadcastState(roomId);
}

// Build the personalized view for ONE player (never leak the opponent's hand contents).
function stateFor(roomId, sid) {
  const room = rooms.get(roomId);
  const b = room.battle;
  const oppId = room.players.find((id) => id !== sid);
  const me = b.players[sid];
  const opp = b.players[oppId];
  return {
    you: {
      name: me.name, DP: me.DP, LP: me.LP,
      hand: me.hand,                  // full cards — you're allowed to see your own hand
      deckCount: me.deck.length,      // your deck order stays hidden (count only)
      mon: me.mon, spell: me.spell,
      graveCount: me.grave.length,
    },
    opp: {
      name: opp.name, DP: opp.DP, LP: opp.LP,
      handCount: opp.hand.length,     // count only — opponent's cards are hidden
      deckCount: opp.deck.length,
      mon: opp.mon, spell: opp.spell,
      graveCount: opp.grave.length,
    },
    yourTurn: b.turn === sid,
    turnNumber: b.turnNumber,
    phase: b.phase,
    over: b.over ? { youWon: b.over.winner === sid, reason: b.over.reason } : null,
  };
}

function broadcastState(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.battle) return;
  for (const sid of room.players) {
    const s = io.sockets.sockets.get(sid);
    if (s) s.emit('battle:state', stateFor(roomId, sid));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('TCG Arena server (Phase 3a) listening on port ' + PORT));
