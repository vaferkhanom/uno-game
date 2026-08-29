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
  try {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.lastActivity > 6 * 60 * 60 * 1000 || room.players.length === 0) {
        rooms.delete(code);
        for (const [uid, c] of userRoom) if (c === code) userRoom.delete(uid);
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
  } else {
    // No room: tell the client to show the home screen
    socket.emit('state', { viewer: null, state: 'home' });
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
try { botOffset = parseInt(process.env.BOT_OFFSET || '0', 10) || 0; } catch (e) {}
const BOT_OFFSET_FILE = process.env.BOT_OFFSET_FILE || '/tmp/uno-bot-offset';

async function loadBotOffset() {
  try {
    const fs = require('fs');
    if (fs.existsSync(BOT_OFFSET_FILE)) {
      const v = parseInt(fs.readFileSync(BOT_OFFSET_FILE, 'utf8'), 10);
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
  await loadBotOffset();
  console.log(`[bot] starting long-polling, offset=${botOffset}`);
  while (true) {
    try {
      const res = await tgCall('getUpdates', { offset: botOffset, timeout: 10, allowed_updates: ['message'] });
      if (res.ok) {
        for (const upd of res.result) {
          botOffset = upd.update_id + 1;
          saveBotOffset();
          try { await handleBotUpdate(upd); }
          catch (e) { console.error('[bot] handler error:', e.message); }
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
    case 'start':   return cmdStart(chatId, fromUser, args);
    case 'help':    return cmdHelp(chatId);
    case 'play':
    case 'new':
    case 'create':
    case 'newgame': return cmdPlay(chatId, fromUser);
    case 'join':
    case 'enter':   return cmdJoin(chatId, fromUser, args);
    case 'room':
    case 'code':
    case 'mycode':
    case 'myr':     return cmdMyCode(chatId, userKey);
    case 'list':
    case 'rooms':
    case 'myrooms': return cmdMyRooms(chatId, userKey);
    case 'leave':
    case 'exit':
    case 'quit':    return cmdLeave(chatId, userKey);
    case 'rules':
    case 'قوانین':  return cmdRules(chatId);
    case 'stats':
    case 'profile':
    case 'me':      return cmdStats(chatId, userKey);
    case 'invite':
    case 'share':   return cmdInvite(chatId, userKey);
  }

  // --- دکمه‌های کیبورد ---
  if (text === '🎮 ساخت اتاق جدید' || text === 'ساخت اتاق' || text === '🎮 بازی یونو') return cmdPlay(chatId, fromUser);
  if (text === '🔑 پیوستن با کد' || text === 'پیوستن') return cmdJoinPrompt(chatId);
  if (text === '📜 قوانین') return cmdRules(chatId);
  if (text === '📊 آمار من') return cmdStats(chatId, userKey);
  if (text === '🏠 اتاق من') return cmdMyCode(chatId, userKey);
  if (text === '🚪 ترک اتاق') return cmdLeave(chatId, userKey);

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
  const firstName = escapeHtml(fromUser.first_name || 'دوست من');
  const text =
    `👋 سلام <b>${firstName}</b>!\n\n` +
    `🎲 به ربات <b>یونو آنلاین</b> خوش آمدی.\n` +
    `اینجا می‌تونی با دوستانت یونوی آنلاین بازی کنی.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📖 <b>راهنمای کامل دستورات:</b>\n━━━━━━━━━━━━━━━━━━\n\n` +
    `🎮 <b>ساخت اتاق</b>\n` +
    `<code>/play</code>  یا  <code>/new</code>\n` +
    `→ یک اتاق می‌سازد و کد ۵ حرفی آن را بهت می‌دهد.\n\n` +
    `🔑 <b>پیوستن به اتاق</b>\n` +
    `<code>/join ABCDE</code>\n` +
    `→ کد اتاق دوستت را وارد کن تا به او ملحق شوی.\n` +
    `→ یا فقط کد را بفرست: <code>ABCDE</code>\n\n` +
    `🏠 <b>کد اتاق فعلی من</b>\n` +
    `<code>/room</code>  یا  <code>/code</code>\n` +
    `→ اگر الان در اتاقی هستی، کدش را نشانت می‌دهد.\n\n` +
    `📋 <b>لیست اتاق‌های فعال من</b>\n` +
    `<code>/list</code>  یا  <code>/myrooms</code>\n` +
    `→ همهٔ اتاق‌هایی که الان در آنها هستی.\n\n` +
    `🚪 <b>ترک اتاق</b>\n` +
    `<code>/leave</code>\n` +
    `→ از اتاق فعلی‌ات خارج می‌شوی.\n\n` +
    `📤 <b>دعوت دوستان</b>\n` +
    `<code>/invite</code>\n` +
    `→ یک لینک دعوت‌نامه برای اتاق فعلی‌ات می‌سازد.\n\n` +
    `📜 <b>قوانین بازی</b>\n` +
    `<code>/rules</code>\n` +
    `→ خلاصه‌ای از قوانین یونو.\n\n` +
    `📊 <b>آمار من</b>\n` +
    `<code>/stats</code>\n` +
    `→ اطلاعات حساب شما.\n\n` +
    `❓ <b>راهنما</b>\n` +
    `<code>/help</code>\n` +
    `→ همین پیام را دوباره نشانت می‌دهد.\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💡 <b>شروع سریع:</b> اول بزن <code>/play</code> تا یک اتاق بسازی، بعد کدش رو برای دوستت بفرست.`;
  await tgCall('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    reply_markup: {
      keyboard: [
        [{ text: '🎮 ساخت اتاق جدید' }, { text: '🔑 پیوستن با کد' }],
        [{ text: '🏠 اتاق من' }, { text: '🚪 ترک اتاق' }],
        [{ text: '📜 قوانین' }, { text: '📊 آمار من' }],
      ],
      resize_keyboard: true,
    },
  }).catch(e => console.error('[bot] /start send error:', e.message));
}

async function cmdHelp(chatId) { return cmdStart(chatId, { first_name: 'دوست من' }, []); }

async function cmdPlay(chatId, fromUser) {
  const user = tgUserToRoomUser(fromUser);
  const room = createRoom(user);
  console.log(`[bot] /play: created room ${room.code} for ${user.id}`);
  const link = `https://t.me/${BOT_USERNAME}?startapp=${room.code}`;
  const text =
    `✅ <b>اتاق ساخته شد!</b>\n\n` +
    `🎯 کد اتاق شما:  <code>${room.code}</code>\n\n` +
    `👥 ظرفیت: ۲ تا ${MAX_PLAYERS} بازیکن\n` +
    `📊 بازیکنان فعلی: ۱ نفر (خودتان)\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `<b>گام بعدی:</b>\n` +
    `۱. کد بالا را برای دوستانتان بفرستید.\n` +
    `۲. یا دکمهٔ «باز کردن اتاق» را بزنید تا وارد بازی شوید.\n` +
    `۳. وقتی حداقل ۲ بازیکن باشند، میزبان می‌تواند بازی را شروع کند.\n\n` +
    `💡 دوستتان برای پیوستن در همین ربات می‌فرستد: <code>/join ${room.code}</code>`;
  await tgCall('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎮 باز کردن اتاق', web_app: { url: link } }],
        [{ text: '📤 اشتراک‌گذاری کد', switch_inline_query: room.code }],
      ],
    },
  }).catch(e => console.error('[bot] /play send error:', e.message));
}

async function cmdJoinPrompt(chatId) {
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
      `🔑 <b>پیوستن به اتاق</b>\n\n` +
      `کد ۵ حرفی اتاق را بفرست.\n` +
      `مثال: <code>ABCDE</code>\n\n` +
      `یا دستور کامل: <code>/join ABCDE</code>`,
    parse_mode: 'HTML',
  }).catch(e => console.error('[bot] /join prompt error:', e.message));
}

async function cmdJoin(chatId, fromUser, args) {
  if (!args || !args[0]) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `⚠️ <b>کد اتاق را وارد نکردی!</b>\n\nنحوهٔ استفاده:\n<code>/join ABCDE</code>\n\nیا فقط کد را بفرست: <code>ABCDE</code>`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  const code = String(args[0]).toUpperCase().trim();
  if (!/^[A-Z0-9]{4,6}$/.test(code)) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `❌ کد «<code>${code}</code>» معتبر نیست. کد اتاق ۴ تا ۶ کاراکتر (حرف و عدد) است.\n\nمثال درست: <code>ABCDE</code>`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  const room = rooms.get(code);
  if (!room) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `❌ اتاقی با کد <code>${code}</code> پیدا نشد.\n\nممکن است:\n• منقضی شده باشد (اتاق‌ها ۶ ساعت بی‌استفاده می‌مانند)\n• کد را اشتباه وارد کرده باشی\n\nاز میزبان بخواه دوباره اتاق بسازد: <code>/play</code>`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  if (room.state !== 'lobby') {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `⏳ اتاق <code>${room.code}</code> در حال بازی است. صبر کن تا دست تمام شود.`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  if (room.players.length >= MAX_PLAYERS) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `🚫 اتاق <code>${room.code}</code> پُر است (${room.players.length}/${MAX_PLAYERS}).`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  const user = tgUserToRoomUser(fromUser);
  userRoom.set(user.id, room.code);
  console.log(`[bot] /join: user ${user.id} queued for room ${room.code}`);
  const link = `https://t.me/${BOT_USERNAME}?startapp=${room.code}`;
  const hostName = room.players[0] ? escapeHtml(room.players[0].name) : '—';
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
      `🚪 <b>اتاق پیدا شد!</b>\n\n` +
      `🎯 کد: <code>${room.code}</code>\n` +
      `👥 بازیکنان فعلی: ${room.players.length} از ${MAX_PLAYERS}\n` +
      `👑 میزبان: ${hostName}\n\n` +
      `برای ورود روی دکمهٔ زیر بزن:`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🎮 پیوستن به اتاق', web_app: { url: link } }]],
    },
  }).catch(e => console.error('[bot] /join send error:', e.message));
}

async function cmdMyCode(chatId, userKey) {
  const code = userRoom.get(userKey);
  if (!code) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `ℹ️ الان در هیچ اتاقی نیستی.\n\nبرای ساخت اتاق: <code>/play</code>\nبرای پیوستن: <code>/join ABCDE</code>`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  const room = rooms.get(code);
  if (!room) {
    userRoom.delete(userKey);
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: `ℹ️ اتاق قبلی‌ات منقضی شده. <code>/play</code> برای ساخت اتاق جدید.`,
      parse_mode: 'HTML',
    }).catch(() => {});
  }
  const link = `https://t.me/${BOT_USERNAME}?startapp=${room.code}`;
  const status = room.state === 'lobby' ? '🟢 منتظر بازیکن' : room.state === 'playing' ? '🔵 در حال بازی' : '🔴 پایان‌یافته';
  const hostName = room.players[0] ? escapeHtml(room.players[0].name) : '—';
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
      `🏠 <b>اتاق فعلی شما</b>\n\n` +
      `🎯 کد: <code>${room.code}</code>\n` +
      `📊 وضعیت: ${status}\n` +
      `👥 بازیکنان: ${room.players.length} از ${MAX_PLAYERS}\n` +
      `👑 میزبان: ${hostName}\n\n` +
      `👇 روی دکمهٔ زیر بزن تا وارد بازی شوی:`,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: '🎮 باز کردن اتاق', web_app: { url: link } }]],
    },
  }).catch(e => console.error('[bot] /room send error:', e.message));
}

async function cmdMyRooms(chatId, userKey) {
  const inRoom = userRoom.get(userKey);
  let lines;
  if (inRoom && rooms.has(inRoom)) {
    const r = rooms.get(inRoom);
    lines = [`🏠 <code>${r.code}</code> — وضعیت: ${r.state} — ${r.players.length}/${MAX_PLAYERS} بازیکن`];
  } else {
    if (inRoom) userRoom.delete(userKey);
    lines = ['(الان در هیچ اتاقی نیستی)'];
  }
  await tgCall('sendMessage', {
    chat_id: chatId,
    text: `📋 <b>اتاق‌های فعال شما</b>\n\n${lines.join('\n')}\n\n💡 با <code>/play</code> اتاق جدید بساز یا <code>/join ABCDE</code> به اتاق دوستت بپیوند.`,
    parse_mode: 'HTML',
  }).catch(() => {});
}

async function cmdLeave(chatId, userKey) {
  const code = userRoom.get(userKey);
  if (!code) {
    return tgCall('sendMessage', {
      chat_id: chatId, text: 'ℹ️ الان در هیچ اتاقی نیستی.', parse_mode: 'HTML',
    }).catch(() => {});
  }
  const room = rooms.get(code);
  if (room) {
    room.removePlayer(userKey);
    broadcastRoom(room);
  }
  userRoom.delete(userKey);
  await tgCall('sendMessage', {
    chat_id: chatId, text: `✅ از اتاق <code>${code}</code> خارج شدی.`, parse_mode: 'HTML',
  }).catch(() => {});
}

async function cmdInvite(chatId, userKey) {
  const code = userRoom.get(userKey);
  if (!code || !rooms.has(code)) {
    return tgCall('sendMessage', {
      chat_id: chatId, text: 'ℹ️ اول باید یک اتاق بسازی: <code>/play</code>', parse_mode: 'HTML',
    }).catch(() => {});
  }
  const link = `https://t.me/${BOT_USERNAME}?startapp=${code}`;
  await tgCall('sendMessage', {
    chat_id: chatId,
    text: `📤 <b>دعوت دوستان به اتاق</b>\n\n🎯 کد: <code>${code}</code>\n\n🔗 <b>لینک دعوت:</b>\n${link}\n\nاین لینک را برای دوستانت بفرست. وقتی باز کنند، مستقیماً وارد اتاق تو می‌شوند.`,
    parse_mode: 'HTML',
  }).catch(() => {});
}

async function cmdRules(chatId) {
  const text =
    `📜 <b>قوانین یونو</b>\n\n` +
    `🎯 <b>هدف:</b> اولین نفری که همهٔ کارت‌هایش را بازی کند.\n\n` +
    `▶️ <b>نوبت:</b> کارتی بازی کن که هم‌رنگ، هم‌عدد یا هم‌نماد کارت روی میز باشد. اگر نداشتی، یک کارت بردار.\n\n` +
    `⛔ <b>رد (Skip):</b> بازیکن بعدی یک نوبت رد می‌شود.\n` +
    `🔄 <b>معکوس (Reverse):</b> جهت بازی برعکس می‌شود.\n` +
    `🃏 <b>+۲ (Draw Two):</b> بازیکن بعدی ۲ کارت برمی‌دارد و نوبتش رد می‌شود.\n` +
    `🌈 <b>وایلد (Wild):</b> رنگ دلخواه انتخاب می‌کنی.\n` +
    `😱 <b>وایلد +۴:</b> رنگ انتخاب می‌کنی و بازیکن بعدی ۴ کارت جریمه می‌گیرد.\n\n` +
    `📢 <b>یونو!</b> وقتی یک کارت برایت مانده، دکمهٔ «یونو!» را بزن. اگر کسی قبل از نوبت بعدی متوجه شود و «بگیرش» بزند، ۲ کارت جریمه می‌گیری!\n\n` +
    `🏆 <b>امتیاز:</b> برنده، امتیاز کارت‌های دیگران را می‌گیرد (عددی = خودش، ویژه = ۲۰، وایلد = ۵۰).`;
  await tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }).catch(() => {});
}

async function cmdStats(chatId, userKey) {
  const code = userRoom.get(userKey);
  const inRoom = code && rooms.has(code);
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
      `📊 <b>آمار شما</b>\n\n` +
      `👤 شناسه: <code>${userKey}</code>\n` +
      `🏠 اتاق فعلی: ${inRoom ? '<code>' + code + '</code>' : '—'}\n` +
      `📈 تعداد بازی‌ها: (به‌زودی)\n` +
      `🏆 بردها: (به‌زودی)\n` +
      `⭐ مجموع امتیاز: (به‌زودی)\n\n` +
      `💡 برای شروع بازی: <code>/play</code>`,
    parse_mode: 'HTML',
  }).catch(() => {});
}

async function cmdUnknown(chatId, text) {
  await tgCall('sendMessage', {
    chat_id: chatId,
    text:
      `🤔 پیام «<i>${escapeHtml(text.slice(0, 60))}</i>» را نفهمیدم.\n\n` +
      `📌 <b>دستورهای موجود:</b>\n` +
      `<code>/play</code> — ساخت اتاق جدید\n` +
      `<code>/join ABCDE</code> — پیوستن به اتاق\n` +
      `<code>/room</code> — کد اتاق فعلی من\n` +
      `<code>/list</code> — لیست اتاق‌های فعال\n` +
      `<code>/leave</code> — ترک اتاق\n` +
      `<code>/invite</code> — لینک دعوت\n` +
      `<code>/rules</code> — قوانین بازی\n` +
      `<code>/stats</code> — آمار من\n` +
      `<code>/help</code> — راهنمای کامل\n\n` +
      `یا از کیبورد پایین یکی از گزینه‌ها را انتخاب کن.`,
    parse_mode: 'HTML',
  }).catch(() => {});
}

function tgUserToRoomUser(tgUser) {
  return {
    id: String(tgUser.id), // همان شناسه‌ای که initData در Mini App می‌فرستد
    first_name: tgUser.first_name || 'بازیکن',
    username: tgUser.username || null,
    photo_url: tgUser.photo_url || null,
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

