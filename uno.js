/**
 * uno.js — موتور کامل بازی یونو (قوانین رسمی)
 * UNO official rules engine:
 *  - 108 cards (4 colors, 0-9, Skip, Reverse, Draw Two, Wild, Wild Draw Four)
 *  - Deal 7, starter-card handling per official rules
 *  - Draw-one-may-play rule, UNO call & catch penalty, pile reshuffle, scoring
 */

const COLORS = ['red', 'yellow', 'green', 'blue'];
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;

let cardSeq = 0;
function makeCard(color, value) {
  return { id: 'c' + (++cardSeq), color, value };
}

function buildDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push(makeCard(color, '0'));
    for (let n = 1; n <= 9; n++) { deck.push(makeCard(color, String(n))); deck.push(makeCard(color, String(n))); }
    for (const v of ['skip', 'reverse', 'draw2']) { deck.push(makeCard(color, v)); deck.push(makeCard(color, v)); }
  }
  for (let i = 0; i < 4; i++) {
    deck.push(makeCard('wild', 'wild'));
    deck.push(makeCard('wild', 'wild4'));
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardLabel(card) {
  return card.color + '_' + card.value;
}

function cardScore(card) {
  if (card.color === 'wild') return 50;
  if (['skip', 'reverse', 'draw2'].includes(card.value)) return 20;
  return parseInt(card.value, 10) || 0;
}

function canPlay(card, topCard, currentColor) {
  if (card.color === 'wild') return true;
  if (card.color === currentColor) return true;
  if (card.value === topCard.value) return true;
  return false;
}

class Room {
  constructor(code, host) {
    this.code = code;
    this.hostId = String(host.id);
    this.players = [this.newPlayer(host)];
    this.players[0].isHost = true;
    this.state = 'lobby'; // lobby | playing | ended
    this.createdAt = Date.now();
    this.lastActivity = Date.now();

    // game state
    this.deck = [];
    this.discard = [];
    this.currentColor = null;
    this.direction = 1; // 1 = clockwise, -1 = counter-clockwise
    this.turnIndex = 0;
    this.drawnThisTurn = false;
    this.roundScores = {}; // playerId -> accumulated score
    this.winnerId = null;
    this.log = []; // recent events feed
    this.colorPickPending = false; // waiting for wild color choice
    this.unoStates = {}; // playerId -> { called, until }
    this.turnStartedAt = Date.now();
  }

  newPlayer(user) {
    return {
      id: String(user.id),
      name: user.first_name || user.username || 'بازیکن',
      username: user.username || null,
      avatar: user.photo_url || null,
      hand: [],
      isHost: false,
      connected: true,
    };
  }

  touch() { this.lastActivity = Date.now(); }

  addPlayer(user) {
    this.touch();
    if (this.state !== 'lobby') return { error: 'بازی در جریان است، بعداً وارد شوید.' };
    if (this.players.length >= MAX_PLAYERS) return { error: 'اتاق پر است (حداکثر ۶ بازیکن).' };
    const existing = this.players.find(p => p.id === String(user.id));
    if (existing) {
      existing.connected = true;
      return { rejoin: true };
    }
    const p = this.newPlayer(user);
    this.players.push(p);
    this.pushLog(`${p.name} به اتاق پیوست 👋`);
    return { ok: true };
  }

  removePlayer(playerId) {
    this.touch();
    const idx = this.players.findIndex(p => p.id === String(playerId));
    if (idx === -1) return;
    const name = this.players[idx].name;
    if (this.state === 'lobby') {
      this.players.splice(idx, 1);
      if (this.players.length) {
        this.players[0].isHost = true;
        this.hostId = this.players[0].id;
      }
      this.pushLog(`${name} اتاق را ترک کرد.`);
    } else {
      this.players[idx].connected = false;
      this.players[idx].hand = [];
      this.pushLog(`${name} از بازی خارج شد 💨`);
      if (this.players[idx].id === this.currentPlayerId()) this.advanceTurn();
      this.checkGameEndOnLeave();
    }
  }

  checkGameEndOnLeave() {
    const active = this.players.filter(p => p.connected);
    if (this.state === 'playing' && active.length < 2) {
      if (active.length === 1) this.endGame(active[0].id, 'بقیه بازیکنان خارج شدند');
      else this.endGame(null, 'همه بازیکنان خارج شدند');
    }
  }

  currentPlayer() { return this.players[this.turnIndex]; }
  currentPlayerId() { return this.players[this.turnIndex] ? this.players[this.turnIndex].id : null; }

  pushLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 30) this.log.shift();
  }

  isHost(playerId) { return String(playerId) === String(this.hostId); }

  startGame(playerId) {
    this.touch();
    if (!this.isHost(playerId)) return { error: 'فقط میزبان می‌تواند بازی را شروع کند.' };
    if (this.players.length < MIN_PLAYERS) return { error: 'حداقل ۲ بازیکن لازم است.' };
    if (this.state === 'playing') return { error: 'بازی در جریان است.' };

    this.state = 'playing';
    this.winnerId = null;
    this.log = [];
    this.direction = 1;
    this.turnIndex = 0;
    this.drawnThisTurn = false;
    this.colorPickPending = false;
    this.unoStates = {};
    for (const p of this.players) { p.hand = []; p.connected = true; }

    this.deck = shuffle(buildDeck());
    this.discard = [];

    for (let r = 0; r < 7; r++) {
      for (const p of this.players) p.hand.push(this.deck.pop());
    }

    // starter card per official rules
    let starter = this.deck.pop();
    while (starter.value === 'wild4') {
      this.deck.unshift(starter); // return to bottom, flip another
      starter = this.deck.pop();
    }
    this.discard.push(starter);
    this.currentColor = starter.color === 'wild' ? null : starter.color;
    this.pushLog('بازی شروع شد! 🎉');

    if (starter.value === 'wild') {
      this.colorPickPending = true;
      this.pushLog('کارت اول وایلد است؛ بازیکن اول رنگ را انتخاب می‌کند.');
    } else if (starter.color !== 'wild') {
      if (starter.value === 'draw2') {
        const p = this.currentPlayer();
        this.drawCards(p, 2);
        this.pushLog('کارت اول +۲ بود؛ بازیکن اول ۲ کارت برداشت و رد شد.');
        this.advanceTurn();
      } else if (starter.value === 'skip') {
        this.pushLog('کارت اول رد (Skip) بود؛ بازیکن اول رد شد.');
        this.advanceTurn();
      } else if (starter.value === 'reverse') {
        this.direction = -1;
        if (this.players.length === 2) this.advanceTurn();
        this.pushLog('جهت بازی معکوس شد! 🔄');
      }
    }
    this.turnStartedAt = Date.now();
    return { ok: true };
  }

  drawCards(player, n) {
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) this.reshuffle();
      if (this.deck.length === 0) break;
      player.hand.push(this.deck.pop());
    }
  }

  reshuffle() {
    if (this.discard.length <= 1) return;
    const top = this.discard.pop();
    const rest = this.discard.splice(0);
    for (const c of rest) if (c.color === 'wild') c.chosenColor = null;
    this.deck = shuffle(rest);
    this.discard = [top];
    this.pushLog('برگ‌ها مخلوط شدند ♻️');
  }

  nextIndex(from = this.turnIndex) {
    return (from + this.direction + this.players.length) % this.players.length;
  }

  advanceTurn() {
    this.turnIndex = this.nextIndex();
    this.drawnThisTurn = false;
    this.colorPickPending = false;
    this.turnStartedAt = Date.now();
  }

  playerById(id) { return this.players.find(p => p.id === String(id)); }

  topCard() { return this.discard[this.discard.length - 1]; }

  playCard(playerId, cardId, chosenColor) {
    this.touch();
    if (this.state !== 'playing') return { error: 'بازی فعال نیست.' };
    const p = this.playerById(playerId);
    if (!p || p.id !== this.currentPlayerId()) return { error: 'نوبت شما نیست.' };
    if (this.colorPickPending) return { error: 'اول رنگ را انتخاب کنید.' };
    const ci = p.hand.findIndex(c => c.id === cardId);
    if (ci === -1) return { error: 'کارت یافت نشد.' };
    const card = p.hand[ci];
    const top = this.topCard();
    if (!canPlay(card, top, this.currentColor)) return { error: 'این کارت قابل بازی نیست.' };

    p.hand.splice(ci, 1);
    if (card.color === 'wild') {
      card.chosenColor = COLORS.includes(chosenColor) ? chosenColor : 'red';
    }
    this.discard.push(card);
    this.currentColor = card.color === 'wild' ? card.chosenColor : card.color;
    this.drawnThisTurn = false;

    this.pushLog(`${p.name} کارت ${cardLabel(card)} را بازی کرد.`);

    // UNO window: down to exactly 1 card
    if (p.hand.length === 1) {
      this.unoStates[p.id] = { called: false, until: Date.now() + 6000 };
    } else if (this.unoStates[p.id] && p.hand.length !== 1) {
      delete this.unoStates[p.id];
    }

    if (p.hand.length === 0) {
      this.endGame(p.id);
      return { ok: true, won: true };
    }

    if (card.value === 'skip') {
      const skipped = this.players[this.nextIndex()];
      this.pushLog(`${skipped.name} رد شد! ⛔`);
      this.advanceTurn(); this.advanceTurn();
    } else if (card.value === 'reverse') {
      this.direction *= -1;
      this.pushLog('جهت بازی معکوس شد! 🔄');
      if (this.players.length === 2) {
        this.advanceTurn(); this.advanceTurn(); // reverse acts as skip in 2-player
      } else {
        this.advanceTurn();
      }
    } else if (card.value === 'draw2') {
      const victim = this.players[this.nextIndex()];
      this.drawCards(victim, 2);
      this.pushLog(`${victim.name} ۲ کارت برداشت! 🃏🃏`);
      this.advanceTurn(); this.advanceTurn();
    } else if (card.value === 'wild4') {
      const victim = this.players[this.nextIndex()];
      this.drawCards(victim, 4);
      this.pushLog(`${victim.name} ۴ کارت برداشت! 😱`);
      this.advanceTurn(); this.advanceTurn();
    } else {
      this.advanceTurn();
    }
    return { ok: true };
  }

  chooseColor(playerId, color) {
    this.touch();
    if (this.state !== 'playing') return { error: 'بازی فعال نیست.' };
    if (!COLORS.includes(color)) return { error: 'رنگ نامعتبر.' };
    if (String(playerId) !== this.currentPlayerId()) return { error: 'نوبت شما نیست.' };
    if (!this.colorPickPending) return { error: 'الان نیازی به انتخاب رنگ نیست.' };
    this.currentColor = color;
    this.colorPickPending = false;
    const p = this.currentPlayer();
    this.pushLog(`${p.name} رنگ ${color} را انتخاب کرد 🎨`);
    this.turnStartedAt = Date.now();
    return { ok: true };
  }


  drawCard(playerId) {
    this.touch();
    if (this.state !== 'playing') return { error: 'بازی فعال نیست.' };
    const p = this.playerById(playerId);
    if (!p || p.id !== this.currentPlayerId()) return { error: 'نوبت شما نیست.' };
    if (this.colorPickPending) return { error: 'اول رنگ را انتخاب کنید.' };
    if (this.drawnThisTurn) return { error: 'شما در این نوبت کارت برداشتید.' };

    this.drawCards(p, 1);
    this.drawnThisTurn = true;
    const drawn = p.hand[p.hand.length - 1];
    this.pushLog(`${p.name} یک کارت برداشت.`);
    const playable = drawn ? canPlay(drawn, this.topCard(), this.currentColor) : false;
    return { ok: true, playable };
  }

  passTurn(playerId) {
    this.touch();
    if (this.state !== 'playing') return { error: 'بازی فعال نیست.' };
    const p = this.playerById(playerId);
    if (!p || p.id !== this.currentPlayerId()) return { error: 'نوبت شما نیست.' };
    if (!this.drawnThisTurn) return { error: 'اول باید یک کارت بردارید.' };
    this.pushLog(`${p.name} نوبت را رد کرد.`);
    this.advanceTurn();
    return { ok: true };
  }

  callUno(playerId) {
    this.touch();
    const st = this.unoStates[String(playerId)];
    if (!st) return { error: 'شرایط یونو ندارید.' };
    st.called = true;
    const p = this.playerById(playerId);
    this.pushLog(`${p.name} گفت: یونو! 📢`);
    return { ok: true };
  }

  catchUno(catcherId, accusedId) {
    this.touch();
    const st = this.unoStates[String(accusedId)];
    if (!st) return { error: 'امکان گرفتن نیست.' };
    if (st.called) return { error: 'او یونو گفته بود!' };
    if (Date.now() > st.until) { delete this.unoStates[String(accusedId)]; return { error: 'فرصت تمام شد.' }; }
    const accused = this.playerById(accusedId);
    const catcher = this.playerById(catcherId);
    if (!accused || !catcher) return { error: 'بازیکن یافت نشد.' };
    if (accused.hand.length !== 1) { delete this.unoStates[String(accusedId)]; return { error: 'شرایط یونو دیگر برقرار نیست.' }; }
    this.drawCards(accused, 2);
    delete this.unoStates[String(accusedId)];
    this.pushLog(`${catcher.name} ${accused.name} را گیر انداخت! ۲ کارت جریمه 🚨`);
    return { ok: true };
  }

  getUnoCatchables(viewerId) {
    const out = [];
    for (const [pid, st] of Object.entries(this.unoStates)) {
      if (pid === String(viewerId)) continue;
      if (!st.called && Date.now() < st.until) {
        const p = this.playerById(pid);
        if (p && p.hand.length === 1) out.push(pid);
      }
    }
    return out;
  }

  endGame(winnerId, note) {
    this.state = 'ended';
    this.winnerId = winnerId ? String(winnerId) : null;
    // official scoring: winner gains sum of opponents' card values
    let pts = 0;
    for (const p of this.players) {
      if (p.id !== this.winnerId) for (const c of p.hand) pts += cardScore(c);
    }
    if (this.winnerId) {
      this.roundScores[this.winnerId] = (this.roundScores[this.winnerId] || 0) + pts;
      const w = this.playerById(this.winnerId);
      this.pushLog(`${w ? w.name : 'بازیکن'} برنده شد! 🏆 (+${pts} امتیاز)${note ? ' — ' + note : ''}`);
    } else {
      this.pushLog(note || 'بازی پایان یافت.');
    }
    for (const pid of Object.keys(this.unoStates)) delete this.unoStates[pid];
  }

  resetToLobby(playerId) {
    this.touch();
    if (!this.isHost(playerId)) return { error: 'فقط میزبان.' };
    this.state = 'lobby';
    this.winnerId = null;
    for (const p of this.players) p.hand = [];
    this.pushLog('بازگشت به لابی.');
    return { ok: true };
  }

  /** Serialize full state for a specific viewer (hides other hands). */
  serialize(viewerId) {
    const viewerIdStr = String(viewerId);
    const self = this;
    const v = this.playerById(viewerIdStr);
    return {
      code: this.code,
      hostId: String(this.hostId),
      state: this.state,
      maxPlayers: MAX_PLAYERS,
      minPlayers: MIN_PLAYERS,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        username: p.username,
        avatar: p.avatar,
        isHost: p.id === String(this.hostId),
        connected: p.connected,
        handCount: p.hand.length,
        score: this.roundScores[p.id] || 0,
        isCurrent: this.state === 'playing' && p.id === this.currentPlayerId(),
        hasUno: !!(this.unoStates[p.id] && this.unoStates[p.id].called),
      })),
      viewer: v ? {
        id: v.id,
        name: v.name,
        hand: v.hand,
        isTurn: this.state === 'playing' && v.id === this.currentPlayerId(),
        drawnThisTurn: this.drawnThisTurn && v.id === this.currentPlayerId(),
        canCallUno: !!(this.unoStates[v.id] && !this.unoStates[v.id].called && v.hand.length === 1),
        canCatch: this.getUnoCatchables(v.id),
      } : null,
      game: this.state === 'lobby' ? null : {
        topCard: this.topCard() || null,
        currentColor: this.currentColor,
        direction: this.direction,
        deckCount: this.deck.length,
        turnPlayerId: this.currentPlayerId(),
        colorPickPending: this.colorPickPending && viewerIdStr === this.currentPlayerId(),
        colorPickPendingPublic: this.colorPickPending,
        drawnCardPlayable: (() => {
          if (!self.drawnThisTurn || viewerIdStr !== self.currentPlayerId()) return null;
          const vv = self.playerById(viewerIdStr);
          if (!vv || !vv.hand.length) return null;
          return canPlay(vv.hand[vv.hand.length - 1], self.topCard(), self.currentColor);
        })(),
      },
      log: this.log.slice(-12),
      winnerId: this.winnerId,
      roundScores: this.roundScores,
    };
  }
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

module.exports = { Room, generateRoomCode, COLORS, MAX_PLAYERS, MIN_PLAYERS, cardLabel, cardScore, canPlay };

