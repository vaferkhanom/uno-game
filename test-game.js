/**
 * test-game.js — شبیه‌سازی کامل بازی دو نفره روی سوکت
 */
const { io } = require('socket.io-client');

const URL = 'http://localhost:3111';
let done = 0;

function makeClient(name) {
  const sock = io(URL, { auth: { initData: '' } });
  const c = { sock, name, state: null, events: [] };
  sock.on('state', s => { c.state = s; });
  sock.on('event', e => c.events.push(e));
  sock.on('connect', () => console.log(`[${name}] connected`));
  return c;
}

function canPlay(card, top, color) {
  if (!top) return false;
  if (card.color === 'wild') return true;
  if (card.color === color) return true;
  return card.value === top.value;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function turnAction(c) {
  const s = c.state;
  if (!s || s.state !== 'playing' || !s.viewer) return false;
  if (!s.viewer.isTurn) return false;
  if (s.game.colorPickPending) {
    const colors = ['red', 'green', 'blue', 'yellow'];
    // choose most common color in hand
    const counts = {};
    s.viewer.hand.forEach(h => { if (h.color !== 'wild') counts[h.color] = (counts[h.color] || 0) + 1; });
    const best = colors.sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0];
    c.sock.emit('chooseColor', { color: best });
    await sleep(60);
    return true;
  }
  if (s.viewer.canCallUno) c.sock.emit('callUno');
  // play first playable non-wild, then wild
  const playables = s.viewer.hand.filter(h => canPlay(h, s.game.topCard, s.game.currentColor));
  const pick = playables.find(h => h.color !== 'wild') || playables[0];
  if (pick) {
    c.sock.emit('playCard', { cardId: pick.id, color: pick.color === 'wild' ? 'blue' : undefined });
    await sleep(60);
    return true;
  }
  if (!s.viewer.drawnThisTurn) {
    c.sock.emit('drawCard');
    await sleep(60);
    return true;
  }
  c.sock.emit('passTurn');
  await sleep(60);
  return true;
}

async function main() {
  const a = makeClient('A');
  const b = makeClient('B');
  await sleep(500);

  // A creates personal room
  a.sock.emit('getPersonalRoom', ({ code }) => {
    console.log('[A] personal room:', code);
    // B joins A's room
    setTimeout(() => b.sock.emit('joinRoom', { code }), 300);
  });
  await sleep(900);

  if (!b.state) { console.log('❌ B has no state'); process.exit(1); }
  console.log('[lobby] players:', b.state.players.length, 'state:', b.state.state);

  // B tries to start (should fail - not host)
  b.sock.emit('startGame');
  await sleep(300);
  if (b.state.state !== 'lobby') { console.log('❌ non-host started game!'); process.exit(1); }
  console.log('[ok] non-host cannot start');

  a.sock.emit('startGame');
  await sleep(500);
  console.log('[game] state:', a.state.state, 'turn:', a.state.game.turnPlayerId, 'top:', a.state.game.topCard.color, a.state.game.topCard.value);

  // auto-play until someone wins (max 400 turns)
  for (let i = 0; i < 500; i++) {
    let acted = false;
    if (a.state.viewer && a.state.viewer.isTurn && a.state.state === 'playing') acted = await turnAction(a);
    else if (b.state.viewer && b.state.viewer.isTurn && b.state.state === 'playing') acted = await turnAction(b);
    if (a.state.state === 'ended' || b.state.state === 'ended') break;
    if (!acted) await sleep(80);
  }

  const fs = a.state;
  console.log('[result] state:', fs.state, 'winner:', fs.winnerId, 'log tail:', fs.log.slice(-3).map(l => l.text).join(' | '));
  const unoEvents = a.events.filter(e => e.type === 'uno').length;
  const catchEvents = a.events.filter(e => e.type === 'caught').length;
  console.log('[events] uno calls:', unoEvents, 'caught:', catchEvents, 'plays:', a.events.filter(e => e.type === 'play').length);

  if (fs.state === 'ended' && fs.winnerId) {
    console.log('✅ FULL GAME TEST PASSED');
  } else {
    console.log('❌ game did not end properly');
    process.exit(1);
  }

  // test back to lobby + restart
  a.sock.emit('backToLobby');
  await sleep(300);
  console.log('[back to lobby]', a.state.state, 'hands:', a.state.players.map(p => p.handCount));
  a.sock.emit('startGame');
  await sleep(400);
  console.log('[restart]', a.state.state, 'hands:', a.state.players.map(p => p.handCount));
  console.log('[log]', a.state.log.map(l => l.text).join(' | '));
  await sleep(500);
  console.log('[restart+500ms]', a.state.state, 'hands:', a.state.players.map(p => p.handCount));
  console.log('[log+500ms]', a.state.log.map(l => l.text).join(' | '));
  if (a.state.state === 'playing' && a.state.players.every(p => p.handCount === 7)) {
    console.log('✅ RESTART TEST PASSED');
  } else {
    console.log('❌ restart failed'); process.exit(1);
  }
  a.sock.disconnect(); b.sock.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
