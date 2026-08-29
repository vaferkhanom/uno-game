/**
 * app.js — کلاینت بازی یونو آنلاین
 */
(function () {
  const U = window.UNOCards;
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const $ = (id) => document.getElementById(id);

  if (tg) {
    tg.ready();
    tg.expand();
    try { tg.setHeaderColor('#0b0b1e'); tg.setBackgroundColor('#0b0b1e'); } catch (e) {}
  }

  const me = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  const botUsername = { name: null };

  // ---------- صداهای کوچک ----------
  let audioCtx = null;
  function beep(freq, dur, type, vol, delay) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime + (delay || 0);
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(vol || 0.12, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + (dur || 0.1));
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t0); o.stop(t0 + (dur || 0.1) + 0.02);
    } catch (e) {}
  }
  const SFX = {
    play:  () => { beep(620, .09, 'triangle', .14); beep(880, .07, 'triangle', .1, .05); },
    draw:  () => beep(300, .12, 'sine', .12),
    turn:  () => { beep(520, .1, 'sine', .12); beep(700, .12, 'sine', .12, .1); },
    uno:   () => { beep(660, .12, 'square', .1); beep(990, .18, 'square', .1, .12); },
    caught:() => { beep(200, .2, 'sawtooth', .12); beep(150, .25, 'sawtooth', .1, .15); },
    win:   () => { [523, 659, 784, 1046].forEach((f, i) => beep(f, .22, 'triangle', .13, i * .13)); },
    error: () => beep(160, .18, 'square', .1),
    deal:  () => beep(440 + Math.random() * 200, .05, 'triangle', .06),
  };

  // ---------- توست ----------
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    $('toastWrap').appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = $(name);
    if (el) el.classList.add('active');
  }

  function faNum(n) {
    return String(n).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[d]);
  }

  function avatarHTML(player) {
    if (player.avatar) return `<img src="${player.avatar}" alt="" onerror="this.remove()">`;
    const letter = (player.name || '؟').trim().charAt(0).toUpperCase();
    return letter;
  }

  // ---------- سوکت ----------
  let socket = null;
  let state = null;           // آخرین state دریافتی برای همین بیننده
  let myRoomCode = null;
  let prevHandIds = null;     // برای انیمیشن پخش کارت
  let joinedOnce = false;

  function connect() {
    socket = io({ auth: { initData: (tg && tg.initData) || '' } });

    socket.on('connect', () => {
      // اگر لینک دعوت دارد (startapp)
      const sp = tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param;
      if (sp && !joinedOnce) {
        socket.emit('joinRoom', { code: String(sp).toUpperCase() });
        joinedOnce = true;
      } else if (!joinedOnce) {
        socket.emit('getPersonalRoom');
      } else {
        socket.emit('getPersonalRoom');
      }
    });

    socket.on('connect_error', (err) => {
      $('splashError').hidden = false;
      $('splashError').textContent = 'خطای احراز هویت! لطفاً بازی را از داخل تلگرام باز کنید.';
      console.error('connect_error', err.message);
    });

    socket.on('joined', ({ code }) => { myRoomCode = code; });

    socket.on('state', (s) => {
      const first = !state;
      const prevScreen = document.querySelector('.screen.active');
      state = s;
      if (s.state === 'playing' || s.state === 'ended') {
        renderGame(s, first);
        showScreen('game');
      } else {
        renderLobby(s);
        showScreen('lobby');
      }
      // پروفایل
      $('homeName').textContent = (me && me.first_name) || s.viewerName || 'بازیکن';
      if (s.viewer && s.viewer.name) $('homeName').textContent = s.viewer.name;
    });

    socket.on('event', handleEvent);
    socket.on('error_msg', (e) => { toast(e.message || 'خطا', 'bad'); SFX.error(); });
    socket.on('disconnect', () => toast('اتصال قطع شد… در حال تلاش مجدد', 'bad'));
  }

  function emit(ev, data) { if (socket && socket.connected) socket.emit(ev, data || {}); }

  // ---------- رندر خانه ----------
  function renderHome() {
    $('splashLogo').innerHTML = U.logoSVG(120);
    if (me) {
      const av = $('homeAvatar');
      if (me.photo_url) av.innerHTML = `<img src="${me.photo_url}" onerror="this.remove()">`;
      else av.textContent = (me.first_name || '؟').charAt(0);
      $('homeName').textContent = me.first_name || 'بازیکن';
    }
    const hero = $('heroCards');
    const demo = [
      { color: 'red', value: '7' },
      { color: 'wild', value: 'wild' },
      { color: 'blue', value: '2' },
    ];
    hero.innerHTML = demo.map(c => `<div class="hcard">${U.cardSVG(c)}</div>`).join('');
  }

  // ---------- رندر لابی ----------
  function renderLobby(s) {
    $('roomCode').textContent = s.code;
    $('playerCount').textContent = faNum(s.players.length);
    const list = $('playersList');
    list.innerHTML = '';
    s.players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'player-row card-glass';
      row.style.animationDelay = (i * 60) + 'ms';
      row.innerHTML = `
        <div class="avatar">${avatarHTML(p)}</div>
        <span class="player-row-name">${escapeHTML(p.name)}${p.connected ? '' : ' 💤'}</span>
        ${p.isHost ? '<span class="badge host">میزبان 👑</span>' : ''}
        ${p.id === (s.viewer && s.viewer.id) ? '<span class="badge you">شما</span>' : ''}
      `;
      list.appendChild(row);
    });
    const isHost = s.hostId === (s.viewer && s.viewer.id);
    const canStart = isHost && s.players.length >= s.minPlayers;
    $('startGameBtn').disabled = !canStart;
    $('startGameBtn').style.display = isHost ? '' : 'none';
    $('lobbyHint').textContent = isHost
      ? (s.players.length < s.minPlayers ? 'حداقل ۲ بازیکن لازم است — کد را برای دوستانتان بفرستید!' : 'همه آماده‌اند! بازی را شروع کن 🚀')
      : 'منتظر میزبان برای شروع بازی… ⏳';
  }

  function escapeHTML(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }


  // ---------- رندر بازی ----------
  function canPlayCard(card, game) {
    if (!game || !game.topCard) return false;
    if (card.color === 'wild') return true;
    if (card.color === game.currentColor) return true;
    if (card.value === game.topCard.value) return true;
    return false;
  }

  function renderGame(s, first) {
    const game = s.game;
    const v = s.viewer;

    // --- حریف‌ها ---
    const oppsWrap = $('opponents');
    oppsWrap.innerHTML = '';
    s.players.filter(p => p.id !== v.id).forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'opp' + (p.isCurrent ? ' is-current' : '') + (p.hasUno ? ' has-uno' : '') + (p.connected ? '' : ' offline');
      el.style.animationDelay = (i * 70) + 'ms';
      el.dataset.pid = p.id;
      el.innerHTML = `
        <div class="avatar">${avatarHTML(p)}</div>
        <span class="opp-name">${escapeHTML(p.name)}</span>
        <span class="opp-cards">🃏${faNum(p.handCount)}</span>
      `;
      oppsWrap.appendChild(el);
    });

    // --- دیسکارد و دیک ---
    if (game && game.topCard) {
      $('discardPile').innerHTML = U.cardSVG(game.topCard);
    }
    $('deckCount').textContent = faNum(game ? game.deckCount : '—');
    const ring = $('colorRing');
    ring.className = 'color-ring' + (game && game.currentColor ? ' ' + game.currentColor : '');

    // --- جهت ---
    const dir = $('directionBadge');
    dir.classList.toggle('ccw', !!(game && game.direction === -1));
    dir.textContent = game && game.direction === -1 ? '⟲' : '⟳';

    // --- بنر نوبت ---
    const banner = $('turnBanner');
    if (game && game.turnPlayerId) {
      const tp = s.players.find(p => p.id === game.turnPlayerId);
      banner.classList.add('show');
      if (v.isTurn) {
        banner.classList.add('me');
        banner.textContent = 'نوبت شماست! 🔥';
      } else {
        banner.classList.remove('me');
        banner.textContent = `نوبت ${tp ? tp.name : '…'}`;
      }
    } else {
      banner.classList.remove('show', 'me');
    }

    // --- اکشن‌ها ---
    const drawBtn = $('drawBtn');
    const passBtn = $('passBtn');
    const unoBtn = $('unoBtn');
    const myTurn = !!v.isTurn && s.state === 'playing';
    drawBtn.disabled = !myTurn || !!v.drawnThisTurn || !!(game && game.colorPickPending);
    drawBtn.classList.toggle('can', myTurn && !v.drawnThisTurn);
    passBtn.disabled = !myTurn || !v.drawnThisTurn;
    unoBtn.hidden = !(v.hand && v.hand.length === 1 && v.canCallUno && s.state === 'playing');

    // دیک قابل برداشتن
    $('deckPile').classList.toggle('can-draw', myTurn && !v.drawnThisTurn);

    // --- دست ---
    renderHand(s, myTurn, first);

    // --- بنر گرفتن یونو ---
    const cb = $('catchBanner');
    if (v.canCatch && v.canCatch.length && s.state === 'playing') {
      const names = v.canCatch.map(pid => {
        const p = s.players.find(pp => pp.id === pid);
        return p ? p.name : '';
      });
      cb.hidden = false;
      cb.innerHTML = `<button id="catchBtn">🚨 ${escapeHTML(names[0])} یونو نگفت — بگیرش!</button>`;
      $('catchBtn').onclick = () => emit('catchUno', { accusedId: v.canCatch[0] });
    } else {
      cb.hidden = true;
      cb.innerHTML = '';
    }

    // --- انتخاب رنگ ---
    $('colorModal').hidden = !(game && game.colorPickPending);

    // --- برنده ---
    if (s.state === 'ended') {
      showWinner(s);
    } else {
      hideWinner();
    }
  }

  function renderHand(s, myTurn, first) {
    const handEl = $('hand');
    const v = s.viewer;
    const game = s.game;
    handEl.innerHTML = '';
    const hand = v.hand || [];
    const idsNow = hand.map(c => c.id).join(',');

    hand.forEach((card, i) => {
      const slot = document.createElement('div');
      slot.className = 'card-slot';
      const playable = myTurn && canPlayCard(card, game);
      if (playable) slot.classList.add('playable');
      else if (myTurn) slot.classList.add('dimmed');
      if (game && v.drawnThisTurn && i === hand.length - 1) slot.classList.add('dealing');
      slot.dataset.cid = card.id;
      slot.innerHTML = U.cardSVG(card);

      slot.addEventListener('click', () => {
        if (!myTurn || !canPlayCard(card, game)) {
          if (myTurn) toast('این کارت الان قابل بازی نیست!', 'bad');
          return;
        }
        playCardFlow(card);
      });
      handEl.appendChild(slot);
    });

    // انیمیشن پخش اولیه
    if (first || idsNow !== prevHandIds) {
      const isNewGame = prevHandIds === null || (s.state === 'playing' && hand.length === 7);
      [...handEl.children].forEach((el, i) => {
        if (isNewGame) {
          el.classList.add('dealing');
          el.style.animationDelay = (i * 55) + 'ms';
          if (i < 3) setTimeout(() => SFX.deal(), i * 55);
        }
      });
    }
    prevHandIds = idsNow;
  }

  function playCardFlow(card) {
    if (card.color === 'wild') {
      pendingWildCard = card.id;
      $('colorModal').hidden = false;
    } else {
      doPlay(card.id);
    }
  }

  function doPlay(cardId, color) {
    emit('playCard', { cardId, color });
  }

  let pendingWildCard = null;


  // ---------- رویدادها و انیمیشن‌ها ----------
  function handleEvent(ev) {
    if (!state) return;
    switch (ev.type) {
      case 'gameStart':
        SFX.deal();
        toast('بازی شروع شد! 🎉', 'good');
        break;
      case 'play': {
        SFX.play();
        flyCardToDiscard(ev);
        if (ev.chosenColor) setTimeout(() => toast(`رنگ ${colorName(ev.chosenColor)} انتخاب شد 🎨`), 600);
        break;
      }
      case 'draw': {
        SFX.draw();
        if (ev.auto) {
          const p = state.players.find(pp => pp.id === ev.playerId);
          toast(`${p ? p.name : 'بازیکن'} ۹۰ ثانیه بی‌حرکت بود — خودکار رد شد ⏱`);
        }
        break;
      }
      case 'color':
        toast(`رنگ: ${colorName(ev.color)} 🎨`);
        break;
      case 'uno':
        SFX.uno();
        bigUnoPop();
        toast('یونو! 📢', 'good');
        break;
      case 'caught':
        SFX.caught();
        toast('۲ کارت جریمه! 🚨', 'bad');
        break;
    }
  }

  function colorName(c) {
    return { red: 'قرمز', yellow: 'زرد', green: 'سبز', blue: 'آبی' }[c] || c;
  }

  function flyCardToDiscard(ev) {
    try {
      const discardRect = $('discardPile').getBoundingClientRect();
      let fromRect;
      if (ev.playerId === (state.viewer && state.viewer.id)) {
        // از پایین صفحه
        fromRect = { left: window.innerWidth / 2 - 55, top: window.innerHeight - 160, width: 110, height: 165 };
      } else {
        const el = document.querySelector(`.opp[data-pid="${ev.playerId}"]`);
        fromRect = el ? el.getBoundingClientRect() : { left: 40, top: 60, width: 40, height: 40 };
      }
      const wrap = document.createElement('div');
      wrap.className = 'fly-card';
      wrap.style.cssText = `left:${fromRect.left}px; top:${fromRect.top}px; position:fixed;`;
      wrap.innerHTML = U.cardSVG(ev.card || { color: 'red', value: '0' });
      document.body.appendChild(wrap);
      requestAnimationFrame(() => {
        wrap.style.left = discardRect.left + 'px';
        wrap.style.top = discardRect.top + 'px';
        wrap.style.transform = 'rotate(360deg) scale(.85)';
      });
      setTimeout(() => wrap.remove(), 620);
    } catch (e) {}
  }

  function bigUnoPop() {
    const el = document.createElement('div');
    el.className = 'big-uno';
    el.innerHTML = '<span>UNO!</span>';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  // ---------- برنده ----------
  let confettiRAF = null;
  function showWinner(s) {
    const modal = $('winModal');
    if (!modal.hidden) return;
    const winner = s.players.find(p => p.id === s.winnerId);
    const isMeWinner = s.winnerId === (s.viewer && s.viewer.id);
    $('winTitle').textContent = isMeWinner ? 'تو بردی! 🎉' : `${winner ? winner.name : 'بازیکن'} برد!`;
    $('winSub').textContent = isMeWinner ? 'آفرین! فوق‌العاده بازی کردی 👏' : 'دست بعدی شانست میاره! 💪';
    const scores = Object.entries(s.roundScores || {}).sort((a, b) => b[1] - a[1]);
    $('winScores').innerHTML = scores.map(([pid, sc]) => {
      const p = s.players.find(pp => pp.id === pid);
      return p ? `<div class="win-score-row"><span>${escapeHTML(p.name)}</span><b>${faNum(sc)} امتیاز</b></div>` : '';
    }).join('') || '<div class="win-score-row"><span>اولین دست</span><b>آماده‌ای؟</b></div>';

    const isHost = s.hostId === (s.viewer && s.viewer.id);
    $('againBtn').style.display = isHost ? '' : 'none';
    if (!isHost) $('winSub').textContent += ' — منتظر میزبان…';
    modal.hidden = false;
    if (isMeWinner) { SFX.win(); launchConfetti(); }
  }

  function hideWinner() {
    $('winModal').hidden = true;
    if (confettiRAF) { cancelAnimationFrame(confettiRAF); confettiRAF = null; }
  }

  function launchConfetti() {
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    const colors = ['#ff4757', '#ffd32a', '#2ed573', '#3742fa', '#7d5fff'];
    const parts = Array.from({ length: 160 }, () => ({
      x: Math.random() * canvas.width,
      y: -20 - Math.random() * canvas.height * 0.5,
      w: 6 + Math.random() * 8,
      h: 8 + Math.random() * 10,
      c: colors[Math.floor(Math.random() * colors.length)],
      vy: 2 + Math.random() * 3.5,
      vx: -1.5 + Math.random() * 3,
      rot: Math.random() * Math.PI,
      vr: -0.12 + Math.random() * 0.24,
    }));
    let frames = 0;
    function tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      parts.forEach(p => {
        p.y += p.vy; p.x += p.vx; p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      });
      frames++;
      if (frames < 400) confettiRAF = requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    tick();
  }


  // ---------- اتصال دکمه‌ها ----------
  function wireUI() {
    // خانه
    $('myRoomBtn').onclick = () => emit('getPersonalRoom');
    $('helpBtn').onclick = () => { $('helpModal').hidden = false; };
    $('helpClose').onclick = () => { $('helpModal').hidden = true; };

    // پیوستن
    $('joinBtn').onclick = () => {
      $('joinModal').hidden = false;
      setTimeout(() => $('joinInput').focus(), 100);
    };
    $('joinCancel').onclick = () => { $('joinModal').hidden = true; };
    $('joinGo').onclick = doJoin;
    $('joinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
    $('joinInput').addEventListener('input', (e) => {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    // لابی
    $('startGameBtn').onclick = () => emit('startGame');
    $('lobbyBack').onclick = () => showScreen('home');
    $('copyCodeBtn').onclick = async () => {
      const code = state ? state.code : myRoomCode;
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(code);
        else {
          const ta = document.createElement('textarea');
          ta.value = code; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
        }
        toast('کد کپی شد! 📋', 'good');
      } catch (e) { toast('کد: ' + code); }
    };
    $('shareBtn').onclick = () => {
      const code = state ? state.code : myRoomCode;
      const inviter = (me && me.first_name) || 'دوستت';
      const text = `🎲 ${inviter} تو را به بازی یونو دعوت کرد!\n\nکد اتاق: ${code}\n\nهمین حالا بپیوند! 🔥`;
      const url = `https://t.me/share/url?url=${encodeURIComponent(inviteLink(code))}&text=${encodeURIComponent(text)}`;
      if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
      else window.open(url, '_blank');
    };

    // بازی
    $('drawBtn').onclick = () => emit('drawCard');
    $('passBtn').onclick = () => emit('passTurn');
    $('unoBtn').onclick = () => emit('callUno');
    $('deckPile').onclick = () => { if (!$('drawBtn').disabled) emit('drawCard'); };

    // انتخاب رنگ
    document.querySelectorAll('.color-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.color;
        if (pendingWildCard) {
          const cid = pendingWildCard;
          pendingWildCard = null;
          $('colorModal').hidden = true;
          doPlay(cid, color);
        } else if (state && state.game && state.game.colorPickPending) {
          emit('chooseColor', { color });
          $('colorModal').hidden = true;
        }
      });
    });

    // برنده
    $('againBtn').onclick = () => {
      hideWinner();
      emit('startGame');
    };

    // دکمه خروج در صفحه بازی
    const exitBtn = document.createElement('button');
    exitBtn.className = 'btn-icon';
    exitBtn.style.cssText = 'position:absolute; top:calc(10px + var(--sat)); left:12px; z-index:20; width:38px; height:38px; font-size:16px;';
    exitBtn.textContent = '→';
    exitBtn.onclick = () => emit('leaveRoom');
    $('game').appendChild(exitBtn);
  }

  async function doJoin() {
    const code = $('joinInput').value.trim().toUpperCase();
    if (code.length < 4) { toast('کد اتاق معتبر نیست!', 'bad'); return; }
    $('joinModal').hidden = true;
    joinedOnce = true;
    emit('joinRoom', { code });
  }

  function inviteLink(code) {
    const bot = botUsername.name;
    return bot ? `https://t.me/${bot}?startapp=${code}` : `https://t.me/share/url?url=${encodeURIComponent('کد اتاق: ' + code)}`;
  }

  // ---------- بوت ----------
  async function boot() {
    renderHome();
    wireUI();
    try {
      const cfg = await fetch('/api/config').then(r => r.json());
      if (cfg.botUsername) botUsername.name = cfg.botUsername;
    } catch (e) {}
    connect();
  }

  boot();
})();

