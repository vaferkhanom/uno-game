/**
 * server.js — سرور بازی آنلاین UCHO (Telegram Mini App)
 * Express + Socket.IO + Telegram Bot (long polling)
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Room, generateRoomCode, COLORS, MAX_PLAYERS } = require('./uno.js');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN ||'';
let BOT_USERNAME = process.env.BOT_USERNAME ||'';
const GAME_NAME ='UCHO';
const BOT_NAME ='UCHO Bot';
const SUPPORT_HANDLE ='@Vlniqqa';
const SUPPORT_URL ='https://t.me/Vlniqqa';

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin:'*' }, maxHttpBufferSize: 1e6 });

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname,'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size }));
app.get('/api/config', (req, res) => res.json({ botUsername: BOT_USERNAME, maxPlayers: MAX_PLAYERS }));

// ---------- REST API: room management ----------
function authUser(req) {
  const initData = req.body && req.body.initData;
  return validateInitData(initData);
}

app.post('/api/rooms', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error:'unauthorized' });
  const room = createRoom(user);
  console.log(`[api] user ${user.id} created room ${room.code}`);
  res.json({ code: room.code, webAppUrl: WEBAPP_URL +'?startapp=' + room.code });
});

app.get('/api/rooms/:code', (req, res) => {
  const code = String(req.params.code ||'').trim().toUpperCase();
  const summary = roomSummary(code);
  if (!summary) return res.status(404).json({ error:'not_found' });
  res.json(summary);
});

app.post('/api/rooms/:code/join', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error:'unauthorized' });
  const code = String(req.params.code ||'').trim().toUpperCase();
  const room = findRoomByCode(code);
  if (!room) return res.status(404).json({ error:'not_found' });
  if (room.state !=='lobby') return res.status(409).json({ error:'game_in_progress' });
  if (room.players.length >= MAX_PLAYERS) return res.status(409).json({ error:'room_full' });
  res.json({ code: room.code, webAppUrl: WEBAPP_URL +'?startapp=' + room.code });
});

// ---------- GitHub push webhook → خودکار deploy روی Railway ----------
const RAILWAY_API ='https://backboard.railway.app/graphql/v2';
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN ||'';
const RAILWAY_SERVICE_ID = process.env.RAILWAY_SERVICE_ID ||'';
const RAILWAY_ENV_ID = process.env.RAILWAY_ENV_ID ||'';
const GH_WEBHOOK_SECRET = process.env.GH_WEBHOOK_SECRET ||'';

app.post('/railway/deploy', (req, res) => {
  // بررسی امضای وب‌هوک گیت‌هاب
  const sig = req.headers['x-hub-signature-256'];
  if (GH_WEBHOOK_SECRET) {
    if (!sig || !req.rawBody) return res.status(401).json({ error:'missing signature' });
    const computed ='sha256=' + crypto.createHmac('sha256', GH_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
    if (computed !== sig) return res.status(401).json({ error:'bad signature' });
  }
  const event = req.headers['x-github-event'] ||'';
  if (event !=='push') return res.status(200).json({ ok: true, ignored: event });
  const sha = req.body && req.body.head_commit ? req.body.head_commit.id : null;
  const ref = req.body && req.body.ref;
  if (!sha || (ref && !ref.endsWith('/main'))) return res.status(200).json({ ok: true, ignored:'non-main push' });
  if (!RAILWAY_TOKEN || !RAILWAY_SERVICE_ID || !RAILWAY_ENV_ID) {
    console.warn('[deploy-webhook] Railway env not configured');
    return res.status(500).json({ error:'railway not configured' });
  }
  const query =`mutation { serviceInstanceDeployV2(serviceId: "${RAILWAY_SERVICE_ID}", environmentId: "${RAILWAY_ENV_ID}", commitSha: "${sha}") }`;
  fetch(RAILWAY_API, {
    method:'POST',
    headers: {'Authorization':'Bearer' + RAILWAY_TOKEN,'Content-Type':'application/json' },
    body: JSON.stringify({ query }),
  })
    .then(r => r.json())
    .then(data => {
      console.log('[deploy-webhook] triggered deploy for', sha.slice(0, 8), JSON.stringify(data).slice(0, 160));
      res.json({ ok: true, sha, result: data.data && data.data.serviceInstanceDeployV2 });
    })
    .catch(err => {
      console.error('[deploy-webhook] error:', err.message);
      res.status(502).json({ error: err.message });
    });
});

// ---------- rooms ----------
const rooms = new Map(); // code -> Room
const userRoom = new Map(); // userId -> room code (current room)

function createRoom(user) {
  const uid = String(user.id);
  let code;
  do { code = generateRoomCode(); } while (rooms.has(code));
  const room = new Room(code, user);
  rooms.set(code, room);
  userRoom.set(uid, code);
  return room;
}

function findRoomByCode(code) {
  if (!code) return null;
  return rooms.get(String(code).trim().toUpperCase()) || null;
}

function roomSummary(code) {
  const room = rooms.get(code);
  if (!room) return null;
  return {
    code: room.code,
    state: room.state,
    hostId: room.hostId,
    playerCount: room.players.length,
    maxPlayers: MAX_PLAYERS,
    canJoin: room.state ==='lobby' && room.players.length < MAX_PLAYERS,
  };
}

// cleanup idle rooms every 10 minutes
setInterval(() => {
  try {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.lastActivity > 6 * 60 * 60 * 1000 || room.players.length === 0) {
        rooms.delete(code);
        for (const [uid, c] of userRoom) if (c === code) userRoom.delete(uid);
        clearAITimer(code);
        console.log(`[cleanup] removed idle room ${code}`);
      }
    }
  } catch (e) {
    console.error('[cleanup] error:', e);
  }
}, 10 * 60 * 1000).unref();

// ---------- telegram initData validation ----------
function validateInitData(initData) {
  if (!BOT_TOKEN) return null;
  if (!initData) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const pairs = [];
    for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
    pairs.sort();
    const dataCheckString = pairs.join('\n');
    const secret = crypto.createHmac('sha256','WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (computed !== hash) return null;
    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    return {
      id: user.id,
      first_name: user.first_name ||'',
      username: user.username || null,
      photo_url: user.photo_url || null,
    };
  } catch (e) {
    console.error('initData validation error:', e.message);
    return null;
  }
}

// ---------- state broadcast ----------
function broadcastRoom(room) {
  const channel ='room:' + room.code;
  for (const [, sock] of io.of('/').sockets) {
    if (sock.rooms && sock.rooms.has(channel)) {
      sock.emit('state', room.serialize(sock.data.userId));
    }
  }
  // After any state broadcast, advance AI play if it's an AI's turn
  if (room.state ==='playing') {
    const cur = room.currentPlayer();
    if (cur && cur.isBot) scheduleNextAI(room);
    else if (cur && !cur.isBot) clearAITimer(room.code); // human's turn — don't run bot logic
  } else if (room.state ==='ended') {
    clearAITimer(room.code);
  }
}

function emitEvent(room, event) {
  io.in('room:' + room.code).emit('event', event);
}

// ---------- socket.io ----------
io.use((socket, next) => {
  const initData = socket.handshake.auth && socket.handshake.auth.initData;
  let user = validateInitData(initData);
  if (!user) {
    if (!initData) {
      // browser testing fallback (no initData provided)
      user = { id:'guest_' + crypto.randomBytes(4).toString('hex'), first_name:'مهمان' };
    } else {
      return next(new Error('unauthorized'));
    }
  }
  socket.data.user = user;
  socket.data.userId = String(user.id);
  next();
});

function handleAction(socket, fn) {
  try {
    const uid = socket.data.userId;
    const code = userRoom.get(uid);
    const room = code ? rooms.get(code) : null;
    if (!room) return;
    const result = fn(room, uid) || {};
    if (result && result.error) {
      socket.emit('error_msg', { message: result.error });
      return;
    }
    broadcastRoom(room); // also handles AI scheduling
  } catch (e) {
    console.error('action error:', e);
    socket.emit('error_msg', { message:'خطای داخلی سرور' });
  }
}

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  const user = socket.data.user;
  console.log(`[io] connected: ${user.first_name} (${userId})`);

  // Reconnect: rejoin current room automatically
  const prevCode = userRoom.get(userId);
  if (prevCode && rooms.has(prevCode)) {
    const room = rooms.get(prevCode);
    socket.join('room:' + prevCode);
    const p = room.playerById(userId);
    if (p) p.connected = true;
    socket.emit('joined', { code: room.code });
    broadcastRoom(room);
  } else {
    // No room: tell the client to show the home screen
    socket.emit('state', { viewer: null, state:'home' });
  }

  // create a brand-new personal room (hosted by this user)
  socket.on('createRoom', (cb) => {
    // remove user from any existing room
    leaveCurrentRoom(socket);
    const room = createRoom(user);
    socket.join('room:' + room.code);
    socket.emit('joined', { code: room.code });
    broadcastRoom(room);
    if (typeof cb ==='function') cb({ code: room.code });
  });

  socket.on('joinRoom', ({ code }) => {
    const room = findRoomByCode(code);
    if (!room) {
      socket.emit('error_msg', { message:'اتاقی با این کد پیدا نشد.' });
      return;
    }
    if (room.state !=='lobby') {
      socket.emit('error_msg', { message:'بازی این اتاق شروع شده است.' });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('error_msg', { message:'ظرفیت اتاق تکمیل است.' });
      return;
    }
    leaveCurrentRoom(socket);
    const res = room.addPlayer(user);
    if (res.error) {
      socket.emit('error_msg', { message: res.error });
      return;
    }
    userRoom.set(userId, room.code);
    socket.join('room:' + room.code);
    socket.emit('joined', { code: room.code });
    broadcastRoom(room);
  });

  socket.on('leaveRoom', () => {
    leaveCurrentRoom(socket);
    socket.emit('left', {});
  });

  socket.on('startGame', () => handleAction(socket, (room, uid) => {
    const res = room.startGame(uid);
    if (res.ok) emitEvent(room, { type:'gameStart' });
    return res;
  }));

  // playWithBots: create a room, add 2 AI opponents, auto-start the game
  socket.on('playWithBots', (cb) => {
    leaveCurrentRoom(socket);
    const room = createRoom(user);
    // Add 2 AI bots so the human has company
    addAIsToRoom(room, 2);
    socket.join('room:' + room.code);
    socket.emit('joined', { code: room.code });
    broadcastRoom(room);
    // Auto-start the game after a short delay so the client has time to receive the joined event
    setTimeout(() => {
      const startRes = room.startGame(room.players[0].id); // host starts
      if (startRes.ok) {
        emitEvent(room, { type:'gameStart' });
        broadcastRoom(room);
        // If it's an AI's turn right after start, schedule it
        const cur = room.currentPlayer();
        if (cur && cur.isBot) scheduleNextAI(room);
      }
    }, 800);
    if (typeof cb ==='function') cb({ code: room.code });
  });

  socket.on('playCard', ({ cardId, color }) => handleAction(socket, (room, uid) => {
    const me = room.playerById(uid);
    const card = me && me.hand.find(c => c.id === cardId);
    const res = room.playCard(uid, cardId, color);
    if (res.ok) {
      emitEvent(room, {
        type:'play', playerId: uid,
        card: card ? { color: card.color, value: card.value } : null,
        chosenColor: card && card.color ==='wild' ? color : null,
        won: !!res.won,
      });
    }
    return res;
  }));

  socket.on('drawCard', () => handleAction(socket, (room, uid) => {
    const res = room.drawCard(uid);
    if (res.ok) emitEvent(room, { type:'draw', playerId: uid, count: 1 });
    return res;
  }));

  socket.on('passTurn', () => handleAction(socket, (room, uid) => room.passTurn(uid)));

  socket.on('chooseColor', ({ color }) => handleAction(socket, (room, uid) => {
    const res = room.chooseColor(uid, color);
    if (res.ok) emitEvent(room, { type:'color', color });
    return res;
  }));

  socket.on('callUno', () => handleAction(socket, (room, uid) => {
    const res = room.callUno(uid);
    if (res.ok) emitEvent(room, { type:'uno', playerId: uid });
    return res;
  }));

  socket.on('catchUno', ({ accusedId }) => handleAction(socket, (room, uid) => {
    const res = room.catchUno(uid, accusedId);
    if (res.ok) emitEvent(room, { type:'caught', catcherId: uid, accusedId, count: 2 });
    return res;
  }));

  socket.on('backToLobby', () => handleAction(socket, (room, uid) => room.resetToLobby(uid)));

  socket.on('disconnect', () => {
    console.log(`[io] disconnected: ${userId}`);
    const code = userRoom.get(userId);
    const room = code ? rooms.get(code) : null;
    if (room) {
      const p = room.playerById(userId);
      if (p) p.connected = false;
      broadcastRoom(room);
    }
  });
});

function leaveCurrentRoom(socket) {
  const uid = socket.data.userId;
  const code = userRoom.get(uid);
  if (!code) return;
  const room = rooms.get(code);
  socket.leave('room:' + code);
  if (room) {
    room.removePlayer(uid);
    broadcastRoom(room);
  }
  userRoom.delete(uid);
}

// ---------- turn watchdog: avoid stalls ----------
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state !=='playing' || room.colorPickPending) continue;
    if (now - room.turnStartedAt > 90 * 1000) {
      const p = room.currentPlayer();
      if (!p || !p.connected) continue;
      if (room.pendingDraw > 0) {
        // stack pending: auto-take the pile (drawCard resolves and skips)
        room.drawCard(p.id);
        emitEvent(room, { type:'draw', playerId: p.id, count: room.players.find(pp => pp.id === p.id).hand.length, auto: true });
      } else if (!room.drawnThisTurn) {
        room.drawCard(p.id);
        emitEvent(room, { type:'draw', playerId: p.id, count: 1, auto: true });
      }
      if (room.drawnThisTurn && room.currentPlayerId() === p.id) room.passTurn(p.id);
      broadcastRoom(room);
    }
  }
}, 15 * 1000).unref();

// ---------- AI bot players ----------
// AI players have id'ai_<n>'. They are added by the server when the human
// host requests a "play with bots" game, or as placeholders if a human
// disconnects. The server runs their turns on a setTimeout.

const AI_NAMES = ['ربات علی','ربات نازنین','ربات کاوه','ربات شیرین'];
let aiCounter = 0;
const aiTimers = new Map(); // roomCode -> Timeout

function makeAIUser() {
  aiCounter += 1;
  const fa = String(aiCounter).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
  const name = AI_NAMES[(aiCounter - 1) % AI_NAMES.length] + ' ' + fa;
  return { id: 'ai_' + aiCounter, first_name: name, isBot: true };
}

function addAIsToRoom(room, count) {
  for (let i = 0; i < count; i++) {
    if (room.players.length >= MAX_PLAYERS) break;
    const u = makeAIUser();
    const res = room.addPlayer(u);
    if (res.error) break;
  }
}

// runAITurn: if the current player is a bot, make it act after a short delay.
function runAITurn(room) {
  if (room.state !=='playing') return;
  if (room.colorPickPending) {
    // bot picks a color; prefer the most common in its hand
    const p = room.currentPlayer();
    if (!p || !p.isBot) return;
    const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
    for (const c of p.hand) if (c.color && counts[c.color] !== undefined) counts[c.color]++;
    let chosen ='red'; let best = -1;
    for (const k of Object.keys(counts)) if (counts[k] > best) { best = counts[k]; chosen = k; }
    setTimeout(() => {
      if (room.state !=='playing' || !room.colorPickPending) return;
      const cur = room.currentPlayer();
      if (!cur || cur.id !== p.id) return;
      room.chooseColor(p.id, chosen);
      broadcastRoom(room); // auto-schedules next AI
    }, 1200);
    return;
  }
  const p = room.currentPlayer();
  if (!p) return;
  if (!p.isBot) return; // human's turn — wait for them
  // bot's turn: prefer a same-color or same-value card, else draw
  setTimeout(() => {
    if (room.state !=='playing') return;
    const cur = room.currentPlayer();
    if (!cur || cur.id !== p.id) return; // turn changed
    if (room.colorPickPending) return; // chooseColor path will handle this
    // stack rule: answer a pending +2 with own +2, otherwise take the pile
    if (room.pendingDraw > 0) {
      const d2 = cur.hand.find(c => c.value ==='draw2');
      if (d2) {
        room.playCard(p.id, d2.id);
      } else {
        room.drawCard(p.id); // draws the whole stack and is skipped
      }
      broadcastRoom(room);
      return;
    }
    if (room.drawnThisTurn) {
      // already drew — must pass
      room.passTurn(p.id);
      broadcastRoom(room);
      return;
    }
    const hand = cur.hand;
    const top = room.topCard();
    const playable = hand.find(c => {
      if (c.color ==='wild') return true;
      return c.color === room.currentColor || c.value === top.value;
    });
    if (playable) {
      let chosenColor = null;
      if (playable.color ==='wild') {
        // pick color we have most of
        const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
        for (const c of hand) if (c.color && counts[c.color] !== undefined) counts[c.color]++;
        chosenColor = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      }
      room.playCard(p.id, playable.id, chosenColor);
      if (cur.hand.length === 1) emitEvent(room, { type:'uno', playerId: p.id });
      broadcastRoom(room);
    } else {
      // no playable card — draw one
      room.drawCard(p.id);
      broadcastRoom(room);
      // schedule the passTurn after a short delay
      setTimeout(() => {
        if (room.state !=='playing') return;
        if (room.currentPlayerId() === p.id && room.drawnThisTurn) {
          room.passTurn(p.id);
          broadcastRoom(room);
        }
      }, 800);
    }
  }, 1500); // 1.5s per bot turn feels natural
}

function scheduleNextAI(room) {
  // clear any prior timer for this room
  if (aiTimers.has(room.code)) clearTimeout(aiTimers.get(room.code));
  const t = setTimeout(() => runAITurn(room), 2500);
  aiTimers.set(room.code, t);
}

// On a room ending, clear its timer
function clearAITimer(roomCode) {
  if (aiTimers.has(roomCode)) {
    clearTimeout(aiTimers.get(roomCode));
    aiTimers.delete(roomCode);
  }
}


// ---------- telegram bot (long polling) ----------
const TG_API ='https://api.telegram.org/bot' + BOT_TOKEN;
let botOffset = 0;
try { botOffset = parseInt(process.env.BOT_OFFSET ||'0', 10) || 0; } catch (e) {}
const BOT_OFFSET_FILE = process.env.BOT_OFFSET_FILE ||'/tmp/uno-bot-offset';

async function loadBotOffset() {
  try {
    const fs = require('fs');
    if (fs.existsSync(BOT_OFFSET_FILE)) {
      const v = parseInt(fs.readFileSync(BOT_OFFSET_FILE,'utf8'), 10);
      if (Number.isFinite(v) && v > 0) botOffset = v;
    }
  } catch (e) {}
}
async function saveBotOffset() {
  try {
    const fs = require('fs');
    fs.writeFileSync(BOT_OFFSET_FILE, String(botOffset));
  } catch (e) {}
}

// abortable in-flight getUpdates; cleared on each loop iteration
let botAbortController = null;
let botShuttingDown = false;

async function tgCall(method, body, opts) {
  const init = {
    method:'POST',
    headers: {'Content-Type':'application/json' },
    body: JSON.stringify(body || {}),
  };
  // Attach the abort signal if the caller provided one (only used for getUpdates)
  if (opts && opts.signal) init.signal = opts.signal;
  const res = await fetch(TG_API +'/' + method, init);
  return res.json();
}

async function botLoop() {
  if (!BOT_TOKEN) return;
  await loadBotOffset();
  console.log(`[bot] starting long-polling, offset=${botOffset}`);
  let conflictBackoff = 0; // exponential backoff for 409s
  while (true) {
    if (botShuttingDown) {
      console.log('[bot] shutdown flag set, exiting polling loop');
      return;
    }
    botAbortController = new AbortController();
    try {
      const res = await tgCall('getUpdates', { offset: botOffset, timeout: 10, allowed_updates: ['message'] }, { signal: botAbortController.signal });
      if (res.ok) {
        conflictBackoff = 0; // successful poll — reset backoff
        for (const upd of res.result) {
          botOffset = upd.update_id + 1;
          saveBotOffset();
          try { await handleBotUpdate(upd); }
          catch (e) { console.error('[bot] handler error:', e.message); }
        }
      } else {
        console.error('[bot] getUpdates error:', JSON.stringify(res).slice(0, 300));
        // On 409, exponential backoff up to 30s. On other errors, short retry.
        const is409 = res && res.error_code === 409;
        const sleep = is409 ? Math.min(30000, 1000 * Math.pow(2, conflictBackoff++)) : 5000;
        await new Promise(r => setTimeout(r, sleep));
      }
    } catch (e) {
      if (botShuttingDown || (e && e.name ==='AbortError')) {
        console.log('[bot] long-poll aborted by shutdown signal');
        return;
      }
      console.error('[bot] loop error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    } finally {
      botAbortController = null;
    }
  }
}

// Handle graceful shutdown so the in-flight getUpdates is cancelled and
// Telegram frees the polling slot IMMEDIATELY (instead of waiting up to 10s
// for the long-poll to time out, which causes 409 on the next instance).
function handleBotShutdown(signal) {
  if (botShuttingDown) return; // idempotent
  botShuttingDown = true;
  console.log(`[bot] received ${signal}, cancelling in-flight getUpdates and exiting`);
  try { if (botAbortController) botAbortController.abort(); } catch (e) {}
  // Stop accepting new HTTP/WS connections, finish in-flight ones, then exit.
  try { server.close(() => { try { process.exit(0); } catch (e) {} }); } catch (e) {}
  try { io.close(); } catch (e) {}
  // Hard cap: don't wait forever, exit after 2s no matter what.
  setTimeout(() => { try { process.exit(0); } catch (e) {} }, 2000).unref();
}
process.on('SIGTERM', () => handleBotShutdown('SIGTERM'));
process.on('SIGINT', () => handleBotShutdown('SIGINT'));

function handleBotUpdate(upd) {
  const msg = upd.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const rawText = msg.text;
  const text = rawText.trim();
  const fromUser = msg.from;
  const userKey = String(fromUser.id);
  console.log(`[bot] message from ${fromUser.username || fromUser.first_name} (${userKey}): ${text}`);

  // --- استخراج دستور (command) ---
  let cmd = null, args = [];
  if (text.startsWith('/')) {
    const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@[a-zA-Z0-9_]+)?\s*([\s\S]*)$/);
    if (m) { cmd = m[1].toLowerCase(); args = m[2].trim().split(/\s+/).filter(Boolean); }
  }

  // --- مسیریابی ---
  switch (cmd) {
    case'start':   return cmdStart(chatId, fromUser, args);
    case'help':    return cmdHelp(chatId);
    case'play':
    case'new':
    case'create':
    case'newgame': return cmdPlay(chatId, fromUser);
    case'join':
    case'enter':   return cmdJoin(chatId, fromUser, args);
    case'room':
    case'code':
    case'mycode':
    case'myr':     return cmdMyCode(chatId, userKey);
    case'list':
    case'rooms':
    case'myrooms': return cmdMyRooms(chatId, userKey);
    case'leave':
    case'exit':
    case'quit':    return cmdLeave(chatId, userKey);
    case'rules':
    case'قوانین':  return cmdRules(chatId);
    case'stats':
    case'profile':
    case'me':      return cmdStats(chatId, userKey);
    case'invite':
    case'share':   return cmdInvite(chatId, userKey);
    case'support':
    case'report':
    case'admin':   return cmdSupport(chatId);
    case'about':
    case'aboutus':
    case'darbare': return cmdAbout(chatId, fromUser);
  }

  // --- دکمه‌های کیبورد ---
  if (text ==='ساخت اتاق جدید' || text ==='ساخت اتاق' || text ==='بازی UCHO' || text ==='بازی') return cmdPlay(chatId, fromUser);
  if (text ==='پیوستن با کد' || text ==='پیوستن') return cmdJoinPrompt(chatId);
  if (text ==='قوانین بازی' || text ==='قوانین') return cmdRules(chatId);
  if (text ==='آمار من') return cmdStats(chatId, userKey);
  if (text ==='اتاق من') return cmdMyCode(chatId, userKey);
  if (text ==='دعوت دوستان' || text ==='دعوت') return cmdInvite(chatId, userKey);
  if (text ==='ترک اتاق') return cmdLeave(chatId, userKey);
  if (text ==='پشتیبانی' || text ==='گزارش مشکل') return cmdSupport(chatId);
  if (text ==='درباره UCHO' || text ==='دربارهٔ UCHO' || text ==='درباره') return cmdAbout(chatId, fromUser);

  // --- پیام متنی که فقط کد ۴ تا ۶ کاراکتری لاتین است → پیوستن ---
  if (/^[A-Za-z0-9]{4,6}$/.test(text)) return cmdJoin(chatId, fromUser, [text.toUpperCase()]);

  // --- هر چیز دیگری: راهنمای مختصر (نه فقط منو) ---
  return cmdUnknown(chatId, text);
}

// =================================================================
// دستورات ربات
// =================================================================

async function cmdStart(chatId, fromUser, args) {
  if (args && args[0] && /^[A-Za-z0-9]{4,6}$/.test(args[0])) {
    return cmdJoin(chatId, fromUser, [args[0].toUpperCase()]);
  }
  const firstName = escapeHtml(fromUser.first_name ||'دوست من');
  const webLink =`https://t.me/${BOT_USERNAME}`;
  const text =
`سلام <b>${firstName}</b>! به <b>${GAME_NAME}</b> خوش آمدی.

<b>${GAME_NAME}</b> بازی کارتی محبوب همه است — سریع، هیجانی و رقابتی؛ اینجا با دوستانت یا با ربات‌ها بازی کن.

━━━━━━━━━━━━━━━━━━
<b>دستورها:</b>

<code>/play</code> — ساخت اتاق جدید
<code>/join ABCDE</code> — پیوستن با کد اتاق
<code>/room</code> — کد اتاق فعلی تو
<code>/list</code> — اتاق‌های فعال تو
<code>/invite</code> — لینک دعوت دوستان
<code>/leave</code> — ترک اتاق
<code>/rules</code> — قوانین بازی
<code>/stats</code> — آمار تو
<code>/support</code> — گزارش مشکل یا پیشنهاد
<code>/about</code> — دربارهٔ ${GAME_NAME}

می‌توانی فقط کد اتاق را هم بفرستی (مثل <code>ABCDE</code>) تا مستقیم به اتاق بپیوندی.

━━━━━━━━━━━━━━━━━━
<b>شروع سریع:</b> <code>/play</code> را بزن، کد اتاق را برای دوستانت بفرست، و با هم بازی کنید.`;
  await tgCall('sendMessage', {
    chat_id: chatId, text, parse_mode:'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text:'PLAY UCHO', web_app: { url: webLink } }],
      ],
      keyboard: [
        [{ text:'بازی' }, { text:'پیوستن با کد' }],
        [{ text:'اتاق من' }, { text:'دعوت دوستان' }],
        [{ text:'قوانین بازی' }, { text:'آمار من' }],
        [{ text:'پشتیبانی' }, { text:'درباره UCHO' }],
      ],
      resize_keyboard: true,
    },
  }).catch(e => console.error('[bot] /start send error:', e.message));
}

async function cmdHelp(chatId) { return cmdStart(chatId, { first_name:'دوست من' }, []); }

async function cmdPlay(chatId, fromUser) {
  const user = tgUserToRoomUser(fromUser);
  const room = createRoom(user);
  console.log(`[bot] /play: created room ${room.code} for ${user.id}`);
  const link =`https://t.me/${BOT_USERNAME}?startapp=${room.code}`;
  const text =
`<b>اتاق جدید ساخته شد</b>

کد اتاق: <code>${room.code}</code>
ظرفیت: تا ${MAX_PLAYERS} بازیکن

━━━━━━━━━━━━━━━━━━
<b>قدم بعدی:</b>
۱. کد بالا را برای دوستانت بفرست.
۲. روی «PLAY UCHO» بزن تا وارد میز شوی.
۳. وقتی حداقل ۲ نفر بودید، از منوی داخل بازی «شروع بازی» را بزن.

دوستت هم می‌تواند در همین ربات کد را بفرستد: <code>/join ${room.code}</code>`;
  await tgCall('sendMessage', {
    chat_id: chatId, text, parse_mode:'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text:'اشتراک‌گذاری کد', switch_inline_query: room.code }],
        [{ text:'PLAY UCHO', web_app: { url: link } }],
      ],
    },
  }).catch(e => console.error('[bot] /play send error:', e.message));
}

async function cmdJoinPrompt(chatId) {
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
`<b>پیوستن به اتاق</b>

کد ۵ حرفی اتاق را بفرست؛ مثل <code>ABCDE</code>.
یا دستور کامل: <code>/join ABCDE</code>`,
    parse_mode:'HTML',
  }).catch(e => console.error('[bot] /join prompt error:', e.message));
}

async function cmdJoin(chatId, fromUser, args) {
  if (!args || !args[0]) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text:`<b>کد را وارد نکردی</b>

نحوهٔ استفاده: <code>/join ABCDE</code>
یا فقط کد را همان‌طور بفرست: <code>ABCDE</code>`,
      parse_mode:'HTML',
    }).catch(() => {});
  }
  const code = String(args[0]).toUpperCase().trim();
  if (!/^[A-Z0-9]{4,6}$/.test(code)) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text:`کد «<code>${code}</code>» معتبر نیست. کد اتاق ۴ تا ۶ کاراکتر است و فقط حرف و عدد دارد.

نمونهٔ درست: <code>ABCDE</code>`,
      parse_mode:'HTML',
    }).catch(() => {});
  }
  const room = rooms.get(code);
  if (!room) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text:`اتاقی با کد <code>${code}</code> پیدا نشد.

دلایل احتمالی:
• اتاق منقضی شده (اتاق‌های بی‌استفاده بعد از مدتی پاک می‌شوند)
• کد اشتباه تایپ شده

از دوستت بخواه اتاق تازه بسازد: <code>/play</code>`,
      parse_mode:'HTML',
    }).catch(() => {});
  }
  if (room.state !=='lobby') {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text:`اتاق <code>${room.code}</code> همین حالا درگیر بازی است. کمی صبر کن تا دست تمام شود، بعد دوباره امتحان کن.`,
      parse_mode:'HTML',
    }).catch(() => {});
  }
  if (room.players.length >= MAX_PLAYERS) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text:`ظرفیت اتاق <code>${room.code}</code> پُر است (${room.players.length} از ${MAX_PLAYERS}). متأسفانه جا نیست.`,
      parse_mode:'HTML',
    }).catch(() => {});
  }
  const user = tgUserToRoomUser(fromUser);
  userRoom.set(user.id, room.code);
  console.log(`[bot] /join: user ${user.id} queued for room ${room.code}`);
  const link =`https://t.me/${BOT_USERNAME}?startapp=${room.code}`;
  const hostName = room.players[0] ? escapeHtml(room.players[0].name) :'—';
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
`<b>اتاق پیدا شد</b>

کد: <code>${room.code}</code>
میزبان: ${hostName}
بازیکنان: ${room.players.length} از ${MAX_PLAYERS}

برای ورود به میز، دکمهٔ پایین را بزن:`,
    parse_mode:'HTML',
    reply_markup: {
      inline_keyboard: [[{ text:'PLAY UCHO', web_app: { url: link } }]],
    },
  }).catch(e => console.error('[bot] /join send error:', e.message));
}

async function cmdMyCode(chatId, userKey) {
  const code = userRoom.get(userKey);
  if (!code) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text:`الان در هیچ اتاقی نیستی.

برای شروع: <code>/play</code> یک اتاق تازه می‌سازد.
برای پیوستن: <code>/join ABCDE</code>`,
      parse_mode:'HTML',
    }).catch(() => {});
  }
  const room = rooms.get(code);
  if (!room) {
    userRoom.delete(userKey);
    return tgCall('sendMessage', {
      chat_id: chatId,
      text:`اتاق قبلی‌ات منقضی شده و پاک شده است. با <code>/play</code> یک اتاق تازه بساز.`,
      parse_mode:'HTML',
    }).catch(() => {});
  }
  const link =`https://t.me/${BOT_USERNAME}?startapp=${room.code}`;
  const status = room.state ==='lobby' ?'در انتظار بازیکن' : room.state ==='playing' ?'در حال بازی' :'پایان‌یافته';
  const hostName = room.players[0] ? escapeHtml(room.players[0].name) :'—';
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
`<b>اتاق فعلی تو</b>

کد: <code>${room.code}</code>
وضعیت: ${status}
میزبان: ${hostName}
بازیکنان: ${room.players.length} از ${MAX_PLAYERS}

دکمهٔ پایین تو را به میز می‌برد:`,
    parse_mode:'HTML',
    reply_markup: {
      inline_keyboard: [[{ text:'PLAY UCHO', web_app: { url: link } }]],
    },
  }).catch(e => console.error('[bot] /room send error:', e.message));
}

async function cmdMyRooms(chatId, userKey) {
  const inRoom = userRoom.get(userKey);
  let lines;
  if (inRoom && rooms.has(inRoom)) {
    const r = rooms.get(inRoom);
    const st = r.state ==='lobby' ?'در انتظار بازیکن' : r.state ==='playing' ?'در حال بازی' :'پایان‌یافته';
    lines = [`<code>${r.code}</code> — ${st} — ${r.players.length} از ${MAX_PLAYERS} بازیکن`];
  } else {
    if (inRoom) userRoom.delete(userKey);
    lines = ['الان در هیچ اتاقی نیستی.'];
  }
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:`<b>اتاق‌های فعال تو</b>

${lines.join('\n')}

اتاق جدید: <code>/play</code> — پیوستن: <code>/join ABCDE</code>`,
    parse_mode:'HTML',
  }).catch(() => {});
}

async function cmdLeave(chatId, userKey) {
  const code = userRoom.get(userKey);
  if (!code) {
    return tgCall('sendMessage', {
      chat_id: chatId, text:'الان در هیچ اتاقی نیستی؛ چیزی برای ترک کردن نیست.', parse_mode:'HTML',
    }).catch(() => {});
  }
  const room = rooms.get(code);
  if (room) {
    room.removePlayer(userKey);
    broadcastRoom(room);
  }
  userRoom.delete(userKey);
  await tgCall('sendMessage', {
    chat_id: chatId, text:`از اتاق <code>${code}</code> خارج شدی.

هر وقت خواستی برگردی: <code>/play</code> یا <code>/join ABCDE</code>`, parse_mode:'HTML',
  }).catch(() => {});
}

async function cmdInvite(chatId, userKey) {
  const code = userRoom.get(userKey);
  if (!code || !rooms.has(code)) {
    return tgCall('sendMessage', {
      chat_id: chatId, text:`اول باید در یک اتاق باشی.

با <code>/play</code> اتاق بساز، بعد دوباره <code>/invite</code> را بزن.`, parse_mode:'HTML',
    }).catch(() => {});
  }
  const link =`https://t.me/${BOT_USERNAME}?startapp=${code}`;
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:`<b>دعوت دوستان به اتاق</b>

کد اتاق: <code>${code}</code>

لینک دعوت:
${link}

این لینک را برای دوستانت بفرست؛ با باز کردنش مستقیم به اتاق تو می‌آیند.`,
    parse_mode:'HTML',
  }).catch(() => {});
}

async function cmdRules(chatId) {
  const text =
`<b>قوانین ${GAME_NAME}</b>

<b>هدف:</b> زودتر از بقیه کارت‌هایت را تمام کن.

<b>نوبت:</b> کارتی بازی کن که هم‌رنگ، هم‌عدد یا هم‌نمادِ کارت روی میز باشد؛ اگر کارت مناسب نداشتی، یک کارت بردار.

<b>کارت‌های ویژه:</b>
• <b>رد (Skip)</b> — بازیکن بعدی یک نوبت رد می‌شود.
• <b>معکوس (Reverse)</b> — جهت چرخش بازی عوض می‌شود.
• <b>۲+</b> — بازیکن بعدی ۲ کارت برمی‌دارد و رد می‌شود؛ اما اگر خودش ۲+ داشته باشد می‌تواند روی آن بگذارد و جریمه جمع شود (۲، ۴، ۶…)؛ در پایان، بازیکنی که نتواند ۲+ پاسخ دهد، همهٔ کارت‌های پشته را برمی‌دارد.
• <b>وایلد (Wild)</b> — رنگ دلخواهت را انتخاب می‌کنی.
• <b>وایلد ۴+</b> — رنگ انتخاب می‌کنی و بازیکن بعدی ۴ کارت جریمه می‌گیرد.

<b>UCHO!</b> وقتی فقط یک کارت برایت مانده، دکمهٔ «UCHO!» را بزن؛ اگر کسی قبل از نوبت بعدی متوجه شود و «بگیرش» را بزند، ۲ کارت جریمه می‌گیری.

<b>امتیاز:</b> برندهٔ هر دست، امتیاز کارت‌های باقی‌ماندهٔ بقیه را می‌گیرد (عددی = خود عدد، ویژه = ۲۰، وایلد = ۵۰).

برای دیدن قوانین در هر لحظه: <code>/rules</code>`;
  await tgCall('sendMessage', { chat_id: chatId, text, parse_mode:'HTML' }).catch(() => {});
}

async function cmdStats(chatId, userKey) {
  const code = userRoom.get(userKey);
  const inRoom = code && rooms.has(code);
  let roomLine = '—';
  if (inRoom) {
    const r = rooms.get(code);
    roomLine = `<code>${r.code}</code> (${r.players.length} از ${MAX_PLAYERS} بازیکن)`;
  }
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
`<b>آمار تو</b>

شناسه: <code>${userKey}</code>
اتاق فعلی: ${roomLine}
دست‌های بازی‌شده: <i>به‌زودی</i>
بردها: <i>به‌زودی</i>
مجموع امتیاز: <i>به‌زودی</i>

آماده‌ای؟ <code>/play</code>`,
    parse_mode:'HTML',
  }).catch(() => {});
}

async function cmdSupport(chatId) {
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
`<b>پشتیبانی ${GAME_NAME}</b>

اگر به مشکلی خوردی، باگی دیدی یا پیشنهادی برای بهتر شدن بازی داری، مستقیم برای ما بنویس:
${SUPPORT_HANDLE}

<b>برای گزارش سریع‌تر، این‌ها را ذکر کن:</b>
• چه کاری انجام می‌دادی؟
• دقیقاً چه اتفاقی افتاد؟
• اگر ممکن است، اسکرین‌شات هم بفرست.

در سریع‌ترین زمان پاسخ می‌دهیم.`,
    parse_mode:'HTML',
    reply_markup: {
      inline_keyboard: [[{ text:'گفتگو با پشتیبانی', url: SUPPORT_URL }]],
    },
  }).catch(e => console.error('[bot] /support send error:', e.message));
}

async function cmdAbout(chatId, fromUser) {
  const firstName = escapeHtml(fromUser && fromUser.first_name ||'دوست من');
  const webLink =`https://t.me/${BOT_USERNAME}`;
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
`<b>دربارهٔ ${GAME_NAME}</b>

${firstName}، <b>${GAME_NAME}</b> همان بازی کارتی محبوب است — فارسی، آنلاین و همین‌جا داخل تلگرام؛ بدون نصب، با دوستان یا با ربات‌های هوشمند.

<b>ربات:</b> ${BOT_NAME}
<b>نسخه:</b> ۱٫۰
<b>پشتیبانی و ادمین:</b> ${SUPPORT_HANDLE}

مشکل یا پیشنهادی داری؟ <code>/support</code>
آمادهٔ بازی؟ <code>/play</code>`,
    parse_mode:'HTML',
    reply_markup: {
      inline_keyboard: [[{ text:'PLAY UCHO', web_app: { url: webLink } }]],
    },
  }).catch(e => console.error('[bot] /about send error:', e.message));
}

async function cmdUnknown(chatId, text) {
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
`پیام «<i>${escapeHtml(text.slice(0, 60))}</i>» را متوجه نشدم.

<b>کارهایی که می‌توانی بکنی:</b>
• <code>/play</code> — ساخت اتاق جدید
• <code>/join ABCDE</code> — پیوستن به اتاق
• فقط خود کد اتاق را بفرست (مثل <code>ABCDE</code>)
• <code>/rules</code> — قوانین بازی
• <code>/help</code> — راهنمای کامل

اگر هم گم شدی، کیبورد پایین همهٔ گزینه‌ها را دارد.`,
    parse_mode:'HTML',
  }).catch(() => {});
}

function tgUserToRoomUser(tgUser) {
  return {
    id: String(tgUser.id), // همان شناسه‌ای که initData در Mini App می‌فرستد
    first_name: tgUser.first_name ||'بازیکن',
    username: tgUser.username || null,
    photo_url: tgUser.photo_url || null,
  };
}

function escapeHtml(s) {
  return String(s == null ?'' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#39;' }[c]));
}

const WEBAPP_URL = process.env.WEBAPP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ?'https://' + process.env.RAILWAY_PUBLIC_DOMAIN :'http://localhost:' + PORT);

async function initBot() {
  if (!BOT_TOKEN) return;
  tgCall('getMe', {}).then(res => {
    if (res.ok) {
      BOT_USERNAME = BOT_USERNAME || res.result.username;
      console.log(` Bot connected: @${res.result.username} (${BOT_NAME})`);
      // Set bot metadata: description + about + name, and the /-command menu
      const setDescription = tgCall('setMyDescription', {
        description: `${GAME_NAME} — بازی کارتی محبوب، فارسی و آنلاین داخل تلگرام. با دوستانت بازی کن یا به میزهای ربات‌ها بپیوند.`,
      });
      const setAbout = tgCall('setMyShortDescription', {
        short_description: `بازی کارتی ${GAME_NAME} — سریع، فارسی و آنلاین. PLAY UCHO`,
      });
      const setCommands = tgCall('setMyCommands', {
        commands: [
          { command: 'play', description: 'ساخت اتاق جدید' },
          { command: 'join', description: 'پیوستن به اتاق با کد — /join ABCDE' },
          { command: 'room', description: 'کد اتاق فعلی تو' },
          { command: 'list', description: 'اتاق‌های فعال تو' },
          { command: 'invite', description: 'لینک دعوت دوستان' },
          { command: 'leave', description: 'ترک اتاق فعلی' },
          { command: 'rules', description: 'قوانین بازی' },
          { command: 'stats', description: 'آمار تو' },
          { command: 'support', description: 'گزارش مشکل یا پیشنهاد' },
          { command: 'about', description: 'دربارهٔ UCHO' },
          { command: 'help', description: 'راهنمای کامل' },
        ],
      });
      Promise.allSettled([setDescription, setAbout, setCommands]).then(() => botLoop());
    } else {
      console.error(' Bot token invalid:', JSON.stringify(res));
    }
  });
}

if (process.env.BOT_TEST_HOOKS) {
  module.exports = { handleBotUpdate, initBot, rooms, userRoom, GAME_NAME, BOT_NAME, SUPPORT_HANDLE };
} else {
  server.listen(PORT, () => {
    console.log(` ${GAME_NAME} server listening on port ${PORT}`);
    console.log(`   WebApp URL: ${WEBAPP_URL}`);
    if (BOT_TOKEN) {
      initBot();
    } else {
      console.log('  BOT_TOKEN not set — bot disabled');
    }
  });
}

