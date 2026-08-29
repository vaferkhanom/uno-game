/**
 * server.js — سرور بازی آنلاین یونو (Telegram Mini App)
 * Express + Socket.IO + Telegram Bot (long polling)
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Room, generateRoomCode, COLORS, MAX_PLAYERS } = require('./uno.js');

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
let BOT_USERNAME = process.env.BOT_USERNAME || '';

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size }));
app.get('/api/config', (req, res) => res.json({ botUsername: BOT_USERNAME, maxPlayers: MAX_PLAYERS }));

// ---------- rooms ----------
const rooms = new Map(); // code -> Room
const userRoom = new Map(); // userId -> room code (current room)
const personalRoom = new Map(); // userId -> personal room code

function getOrCreatePersonalRoom(user) {
  const uid = String(user.id);
  let code = personalRoom.get(uid);
  let room = code ? rooms.get(code) : null;
  if (room && room.state === 'lobby' && room.isHost(uid)) return room;
  // create fresh personal room
  code = generateUniqueCode();
  room = new Room(code, user);
  rooms.set(code, room);
  personalRoom.set(uid, code);
  return room;
}

function generateUniqueCode() {
  let code;
  do { code = generateRoomCode(); } while (rooms.has(code));
  return code;
}

function findRoomByCode(code) {
  if (!code) return null;
  return rooms.get(String(code).trim().toUpperCase()) || null;
}

// cleanup idle rooms every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > 6 * 60 * 60 * 1000 || room.players.length === 0) {
      rooms.delete(code);
      for (const [uid, c] of personalRoom) if (c === code) personalRoom.delete(uid);
      for (const [uid, c] of userRoom) if (c === code) userRoom.delete(uid);
    }
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
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (computed !== hash) return null;
    const userRaw = params.get('user');
    if (!userRaw) return null;
    const user = JSON.parse(userRaw);
    return {
      id: user.id,
      first_name: user.first_name || '',
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
  const channel = 'room:' + room.code;
  for (const [, sock] of io.of('/').sockets) {
    if (sock.rooms && sock.rooms.has(channel)) {
      sock.emit('state', room.serialize(sock.data.userId));
    }
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
      user = { id: 'guest_' + crypto.randomBytes(4).toString('hex'), first_name: 'مهمان' };
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
    broadcastRoom(room);
  } catch (e) {
    console.error('action error:', e);
    socket.emit('error_msg', { message: 'خطای داخلی سرور' });
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
  }

  socket.on('getPersonalRoom', (cb) => {
    let code = userRoom.get(userId);
    let room = code ? rooms.get(code) : null;
    if (!room) {
      room = getOrCreatePersonalRoom(user);
      room.addPlayer(user);
      code = room.code;
      userRoom.set(userId, code);
      socket.join('room:' + code);
    }
    socket.emit('joined', { code });
    broadcastRoom(room);
    if (typeof cb === 'function') cb({ code });
  });


  socket.on('joinRoom', ({ code }) => {
    const room = findRoomByCode(code);
    if (!room) {
      socket.emit('error_msg', { message: 'اتاقی با این کد پیدا نشد.' });
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
    const room = getOrCreatePersonalRoom(user);
    userRoom.set(userId, room.code);
    room.addPlayer(user);
    socket.join('room:' + room.code);
    socket.emit('joined', { code: room.code });
    broadcastRoom(room);
  });

  socket.on('startGame', () => handleAction(socket, (room, uid) => {
    const res = room.startGame(uid);
    if (res.ok) emitEvent(room, { type: 'gameStart' });
    return res;
  }));

  socket.on('playCard', ({ cardId, color }) => handleAction(socket, (room, uid) => {
    const me = room.playerById(uid);
    const card = me && me.hand.find(c => c.id === cardId);
    const res = room.playCard(uid, cardId, color);
    if (res.ok) {
      emitEvent(room, {
        type: 'play', playerId: uid,
        card: card ? { color: card.color, value: card.value } : null,
        chosenColor: card && card.color === 'wild' ? color : null,
        won: !!res.won,
      });
    }
    return res;
  }));

  socket.on('drawCard', () => handleAction(socket, (room, uid) => {
    const res = room.drawCard(uid);
    if (res.ok) emitEvent(room, { type: 'draw', playerId: uid, count: 1 });
    return res;
  }));

  socket.on('passTurn', () => handleAction(socket, (room, uid) => room.passTurn(uid)));

  socket.on('chooseColor', ({ color }) => handleAction(socket, (room, uid) => {
    const res = room.chooseColor(uid, color);
    if (res.ok) emitEvent(room, { type: 'color', color });
    return res;
  }));

  socket.on('callUno', () => handleAction(socket, (room, uid) => {
    const res = room.callUno(uid);
    if (res.ok) emitEvent(room, { type: 'uno', playerId: uid });
    return res;
  }));

  socket.on('catchUno', ({ accusedId }) => handleAction(socket, (room, uid) => {
    const res = room.catchUno(uid, accusedId);
    if (res.ok) emitEvent(room, { type: 'caught', catcherId: uid, accusedId, count: 2 });
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
    if (room.state !== 'playing' || room.colorPickPending) continue;
    if (now - room.turnStartedAt > 90 * 1000) {
      const p = room.currentPlayer();
      if (!p || !p.connected) continue;
      if (!room.drawnThisTurn) {
        room.drawCard(p.id);
        emitEvent(room, { type: 'draw', playerId: p.id, count: 1, auto: true });
      }
      room.passTurn(p.id);
      broadcastRoom(room);
    }
  }
}, 15 * 1000).unref();


// ---------- telegram bot (long polling) ----------
const TG_API = 'https://api.telegram.org/bot' + BOT_TOKEN;
let botOffset = 0;

async function tgCall(method, body) {
  const res = await fetch(TG_API + '/' + method, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function botLoop() {
  if (!BOT_TOKEN) return;
  while (true) {
    try {
      const res = await tgCall('getUpdates', { offset: botOffset, timeout: 30, allowed_updates: ['message'] });
      if (res.ok) {
        for (const upd of res.result) {
          botOffset = upd.update_id + 1;
          handleBotUpdate(upd);
        }
      } else {
        console.error('[bot] getUpdates error:', JSON.stringify(res).slice(0, 300));
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) {
      console.error('[bot] loop error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function handleBotUpdate(upd) {
  const msg = upd.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();
  console.log(`[bot] message from ${msg.from.username || msg.from.first_name}: ${text}`);

  if (text.startsWith('/start') || text.startsWith('/help') || text === '🎮 بازی یونو') {
    tgCall('sendMessage', {
      chat_id: chatId,
      text: '🎲 <b>به یونو خوش آمدید!</b>\n\nیونو آنلاین را با دوستانتان بازی کنید.\n\n• روی دکمهٔ زیر بزنید تا بازی باز شود\n• اتاق اختصاصی خودتان ساخته می‌شود\n• با کد اتاق یا لینک دعوت، دوستانتان را وارد کنید\n• ۲ تا ۶ نفر می‌توانند بازی کنند',
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{ text: '🎮 شروع بازی', web_app: { url: WEBAPP_URL } }]],
      },
    }).catch(e => console.error('[bot] send error:', e.message));
  } else if (text.startsWith('/room')) {
    const code = text.split(/\s+/)[1];
    if (code) {
      tgCall('sendMessage', {
        chat_id: chatId,
        text: `🚪 کد اتاق: <b>${code.toUpperCase()}</b>\n\nدر بازی، از بخش «پیوستن به اتاق» این کد را وارد کنید.`,
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  }
}

const WEBAPP_URL = process.env.WEBAPP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:' + PORT);

// ---------- start ----------
server.listen(PORT, () => {
  console.log(`✅ UNO server listening on port ${PORT}`);
  console.log(`   WebApp URL: ${WEBAPP_URL}`);
  if (BOT_TOKEN) {
    tgCall('getMe', {}).then(res => {
      if (res.ok) {
        console.log(`🤖 Bot connected: @${res.result.username}`);
        if (!BOT_USERNAME) BOT_USERNAME = res.result.username;
        botLoop();
      } else {
        console.error('❌ Bot token invalid:', JSON.stringify(res));
      }
    });
  } else {
    console.log('⚠️  BOT_TOKEN not set — bot disabled');
  }
});

