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

app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size }));
app.get('/api/config', (req, res) => res.json({ botUsername: BOT_USERNAME, maxPlayers: MAX_PLAYERS }));

// ---------- REST API: room management ----------
function authUser(req) {
  const initData = req.body && req.body.initData;
  return validateInitData(initData);
}

app.post('/api/rooms', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const room = createRoom(user);
  console.log(`[api] user ${user.id} created room ${room.code}`);
  res.json({ code: room.code, webAppUrl: WEBAPP_URL + '?startapp=' + room.code });
});

app.get('/api/rooms/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  const summary = roomSummary(code);
  if (!summary) return res.status(404).json({ error: 'not_found' });
  res.json(summary);
});

app.post('/api/rooms/:code/join', (req, res) => {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const code = String(req.params.code || '').trim().toUpperCase();
  const room = findRoomByCode(code);
  if (!room) return res.status(404).json({ error: 'not_found' });
  if (room.state !== 'lobby') return res.status(409).json({ error: 'game_in_progress' });
  if (room.players.length >= MAX_PLAYERS) return res.status(409).json({ error: 'room_full' });
  res.json({ code: room.code, webAppUrl: WEBAPP_URL + '?startapp=' + room.code });
});

// ---------- GitHub push webhook → خودکار deploy روی Railway ----------
const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN || '';
const RAILWAY_SERVICE_ID = process.env.RAILWAY_SERVICE_ID || '';
const RAILWAY_ENV_ID = process.env.RAILWAY_ENV_ID || '';
const GH_WEBHOOK_SECRET = process.env.GH_WEBHOOK_SECRET || '';

app.post('/railway/deploy', (req, res) => {
  // بررسی امضای وب‌هوک گیت‌هاب
  const sig = req.headers['x-hub-signature-256'];
  if (GH_WEBHOOK_SECRET) {
    if (!sig || !req.rawBody) return res.status(401).json({ error: 'missing signature' });
    const computed = 'sha256=' + crypto.createHmac('sha256', GH_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
    if (computed !== sig) return res.status(401).json({ error: 'bad signature' });
  }
  const event = req.headers['x-github-event'] || '';
  if (event !== 'push') return res.status(200).json({ ok: true, ignored: event });
  const sha = req.body && req.body.head_commit ? req.body.head_commit.id : null;
  const ref = req.body && req.body.ref;
  if (!sha || (ref && !ref.endsWith('/main'))) return res.status(200).json({ ok: true, ignored: 'non-main push' });
  if (!RAILWAY_TOKEN || !RAILWAY_SERVICE_ID || !RAILWAY_ENV_ID) {
    console.warn('[deploy-webhook] Railway env not configured');
    return res.status(500).json({ error: 'railway not configured' });
  }
  const query = `mutation { serviceInstanceDeployV2(serviceId: "${RAILWAY_SERVICE_ID}", environmentId: "${RAILWAY_ENV_ID}", commitSha: "${sha}") }`;
  fetch(RAILWAY_API, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RAILWAY_TOKEN, 'Content-Type': 'application/json' },
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
    canJoin: room.state === 'lobby' && room.players.length < MAX_PLAYERS,
  };
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

  // create a brand-new personal room (hosted by this user)
  socket.on('createRoom', (cb) => {
    // remove user from any existing room
    leaveCurrentRoom(socket);
    const room = createRoom(user);
    socket.join('room:' + room.code);
    socket.emit('joined', { code: room.code });
    broadcastRoom(room);
    if (typeof cb === 'function') cb({ code: room.code });
  });

  socket.on('joinRoom', ({ code }) => {
    const room = findRoomByCode(code);
    if (!room) {
      socket.emit('error_msg', { message: 'اتاقی با این کد پیدا نشد.' });
      return;
    }
    if (room.state !== 'lobby') {
      socket.emit('error_msg', { message: 'بازی این اتاق شروع شده است.' });
      return;
    }
    if (room.players.length >= MAX_PLAYERS) {
      socket.emit('error_msg', { message: 'ظرفیت اتاق تکمیل است.' });
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
      const res = await tgCall('getUpdates', { offset: botOffset, timeout: 10, allowed_updates: ['message'] });
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
  const fromUser = msg.from;
  console.log(`[bot] message from ${fromUser.username || fromUser.first_name}: ${text}`);

  if (text.startsWith('/start')) {
    // ممکن است /start <code> برای پیوستن به اتاق از طریق ربات باشد
    const parts = text.split(/\s+/);
    if (parts.length >= 2) {
      const code = parts[1].toUpperCase();
      return handleJoinViaBot(chatId, fromUser, code);
    }
    return showMainMenu(chatId);
  }
  if (text === '/help') return showMainMenu(chatId);
  if (text === '🎮 بازی یونو' || text === '/play' || text === 'ساخت اتاق') {
    return handleCreateViaBot(chatId, fromUser);
  }
  if (text.startsWith('/play')) {
    return handleCreateViaBot(chatId, fromUser);
  }
  if (text.startsWith('/join') || text.startsWith('/room')) {
    const parts = text.split(/\s+/);
    if (parts.length >= 2) return handleJoinViaBot(chatId, fromUser, parts[1].toUpperCase());
    return tgCall('sendMessage', { chat_id: chatId, text: 'برای پیوستن، کد اتاق را بعد از دستور وارد کنید.\nمثال: <code>/join ABCDE</code>', parse_mode: 'HTML' }).catch(() => {});
  }
  // پیام‌های متنی که فقط ۵ حرف لاتین دارند → تلاش برای پیوستن
  if (/^[A-Z0-9]{4,6}$/i.test(text) && !text.startsWith('/')) {
    return handleJoinViaBot(chatId, fromUser, text.toUpperCase());
  }
  // پیش‌فرض: منوی اصلی
  showMainMenu(chatId);
}

function showMainMenu(chatId) {
  return tgCall('sendMessage', {
    chat_id: chatId,
    text:
      '🎲 <b>به یونو آنلاین خوش آمدید!</b>\n\n' +
      'برای شروع یکی از گزینه‌های زیر را انتخاب کنید:\n\n' +
      '• 🎮 <b>ساخت اتاق جدید</b> ← یک کد ۵ حرفی می‌گیرید و آن را برای دوستانتان می‌فرستید\n' +
      '• 🔑 <b>پیوستن با کد</b> ← کد اتاق دوستتان را وارد کنید\n\n' +
      '<i>بعد از ساخت اتاق، روی دکمهٔ «باز کردن اتاق» بزنید تا بازی شروع شود.</i>',
    parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [{ text: '🎮 ساخت اتاق جدید' }],
        [{ text: '🔑 پیوستن با کد' }],
      ],
      resize_keyboard: true,
    },
  }).catch(e => console.error('[bot] send error:', e.message));
}

async function handleCreateViaBot(chatId, fromUser) {
  // ربات اتاق را مستقیماً نمی‌سازد چون باید با حساب واقعی کاربر ساخته شود
  // تا سایر بازیکنان بتوانند او را به‌عنوان میزبان بشناسند
  const webAppLink = `https://t.me/${BOT_USERNAME}?startapp=create`;
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
      `🎮 <b>ساخت اتاق جدید</b>\n\n` +
      `برای ساخت اتاق، روی دکمهٔ زیر بزنید. وقتی بازی باز شد، یک کد ۵ حرفی به شما نشان می‌دهد که می‌توانید آن را برای دوستانتان بفرستید.\n\n` +
      `ظرفیت هر اتاق: ۲ تا ${MAX_PLAYERS} بازیکن`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🎮 ساخت اتاق و شروع', web_app: { url: webAppLink } }]],
    },
  }).catch(e => console.error('[bot] create error:', e.message));
  console.log(`[bot] send create instruction to chat ${chatId}`);
}

async function handleJoinViaBot(chatId, fromUser, code) {
  const room = rooms.get(code);
  if (!room) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `❌ اتاقی با کد <code>${code}</code> پیدا نشد.\n\nممکن است منقضی شده باشد. از میزبان بخواهید اتاق جدیدی بسازد.`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  if (room.state !== 'lobby') {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `⏳ اتاق <code>${room.code}</code> در حال بازی است.`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  if (room.players.length >= MAX_PLAYERS) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `🚫 اتاق <code>${room.code}</code> پُر است.`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  const link = `https://t.me/${BOT_USERNAME}?startapp=${room.code}`;
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
      `🚪 <b>اتاق پیدا شد!</b>\n\n` +
      `🎯 کد: <code>${room.code}</code>\n` +
      `👥 بازیکنان فعلی: ${room.players.length} از ${MAX_PLAYERS}\n\n` +
      `روی دکمهٔ زیر بزنید تا وارد اتاق شوید:`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🎮 پیوستن به اتاق', web_app: { url: link } }]],
    },
  }).catch(e => console.error('[bot] join error:', e.message));
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

