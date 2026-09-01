/**
 * app.js — کلاینت بازی UCHO آنلاین
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
  // ---------- آیکون‌ها ----------
  function injectIcons(root) {
    const ICON = window.UNOIcons;
    if (!ICON) return;
    (root || document).querySelectorAll('[data-icon]').forEach(el => {
      el.innerHTML = ICON.icon(el.dataset.icon);
    });
  }

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
    return `<span>${escapeHTML(letter)}</span>`;
  }

  // ---------- سوکت ----------
  let socket = null;
  let state = null;           // آخرین state دریافتی برای همین بیننده
  let myRoomCode = null;
  let prevHandIds = null;     // برای انیمیشن پخش کارت
  let prevDirection = 0;      // برای فلاش نشان جهت
  let joinedOnce = false;
  let fetchingRoom = false;

  function connect() {
    if (typeof io === 'undefined') {
      $('splashError').hidden = false;
      $('splashError').textContent = 'خطا در بارگذاری بازی. دوباره تلاش کنید.';
      $('retryBtn').hidden = false;
      return;
    }
    socket = io({ auth: { initData: (tg && tg.initData) || '' } });

    socket.on('connect', () => {
      $('splashError').hidden = true;
      $('retryBtn').hidden = true;
      // اگر لینک دعوت دارد (startapp) — از initDataUnsafe یا از query string
      const sp = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param)
        || new URLSearchParams(window.location.search).get('startapp')
        || null;
      if (sp && !joinedOnce) {
        joinedOnce = true;
        if (String(sp).toLowerCase() === 'create') {
          // دستور ساخت اتاق از ربات
          socket.emit('createRoom', ({ code }) => {
            myRoomCode = code;
          });
        } else {
          socket.emit('joinRoom', { code: String(sp).toUpperCase() });
        }
      } else {
        // بدون startapp → مستقیماً به خانه برو
        showScreen('home');
      }
    });

    socket.on('connect_error', (err) => {
      $('splashError').hidden = false;
      $('retryBtn').hidden = false;
      const isAuth = /unauthorized/i.test((err && err.message) || '');
      $('splashError').textContent = isAuth
        ? 'خطای احراز هویت! لطفاً بازی را از داخل تلگرام باز کنید.'
        : 'اتصال برقرار نشد. اینترنت خود را بررسی کنید.';
      console.error('connect_error', err.message);
    });

    socket.on('joined', ({ code }) => { myRoomCode = code; });

    socket.on('state', (s) => {
      const first = !state;
      state = s;
      if ((s.state === 'playing' || s.state === 'ended') && s.viewer) {
        renderGame(s, first);
        showScreen('game');
        if (s.code) { $('gameRoomCode').textContent = s.code; $('gameRoomChip').hidden = false; }
      } else {
        hideWinner();
        if (s.viewer) { renderLobby(s); showScreen('lobby'); if (s.code) $('roomCode').textContent = s.code; }
        // بدون viewer → در خانه می‌مانیم
      }
      // پروفایل
      $('homeName').textContent = (me && me.first_name) || s.viewerName || 'بازیکن';
      if (s.viewer && s.viewer.name) $('homeName').textContent = s.viewer.name;
    });

    socket.on('event', handleEvent);
    socket.on('left', () => { state = null; hideWinner(); showScreen('home'); });
    socket.on('error_msg', (e) => { toast(e.message || 'خطا', 'bad'); SFX.error(); });
    socket.on('disconnect', () => toast('اتصال قطع شد… در حال تلاش مجدد', 'bad'));
  }

  function emit(ev, data) { if (socket && socket.connected) socket.emit(ev, data || {}); }

  // ---------- رندر خانه ----------
  function renderHome() {
    $('splashLogo').innerHTML = U.logoSVG(120);
    $('deckBack').innerHTML = U.cardBackSVG();
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
        <span class="player-row-name">${escapeHTML(p.name)}${p.connected ? '' : '<span class="badge off">آفلاین</span>'}</span>
        ${p.isHost ? '<span class="badge host">میزبان</span>' : ''}
        ${p.id === (s.viewer && s.viewer.id) ? '<span class="badge you">شما</span>' : ''}
      `;
      list.appendChild(row);
    });
    const isHost = s.hostId === (s.viewer && s.viewer.id);
    const canStart = isHost && s.players.length >= s.minPlayers;
    $('startGameBtn').disabled = !canStart;
    $('startGameBtn').style.display = isHost ? '' : 'none';
    $('lobbyHint').textContent = isHost
      ? (s.players.length < s.minPlayers ? 'حداقل ۲ بازیکن لازم است — کد را برای دوستانتان بفرستید' : 'همه آماده‌اند! بازی را شروع کن')
      : 'منتظر میزبان برای شروع بازی…';
  }

  function escapeHTML(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }


  // ---------- رندر بازی ----------
  function canPlayCard(card, game) {
    if (!game || !game.topCard) return false;
    if (game.pendingDraw > 0) return card.value === 'draw2'; // فقط ۲+ به هم‌انبار پاسخ می‌دهد
    if (card.color === 'wild') return true;
    if (card.color === game.currentColor) return true;
    if (card.value === game.topCard.value) return true;
    return false;
  }

  /*
   * صندلی‌ها دور میز (مثل میز بازی واقعی):
   *   ۱ بازیکن حریف → بالای میز
   *   ۲ بازیکن  → چپ و راست میز (عمودی)
   *   ۳ بازیکن  → چپ، بالا، راست
   *   ۴+ بازیکن → چپ، بالا-چپ، بالا-راست، راست (بالا دو صندلی می‌پذیرد)
   * خود بازیکن صندلی ندارد؛ کارت‌هایش پایین صفحه است.
   */
  const SEAT_SLOTS = {
    1: ['Left'],
    2: ['Left', 'Right'],
    3: ['Left', 'Top', 'Right'],
    4: ['Left', 'TopLeft', 'TopRight', 'Right'],
    5: ['Left', 'TopLeft', 'Top', 'TopRight', 'Right'],
  };

  function seatHTML(p) {
    return `
      <span class="seat-turn">نوبت</span>
      <div class="avatar">${avatarHTML(p)}</div>
      <div class="seat-info">
        <span class="seat-name">${escapeHTML(p.name)}</span>
        <span class="seat-sub">
          <span class="seat-fan"><i></i><i></i><i></i></span>
          <span class="seat-count">${faNum(p.handCount)}</span>
        </span>
      </div>
    `;
  }

  function renderSeats(s) {
    const v = s.viewer;
    const others = s.players.filter(p => p.id !== v.id);
    // همهٔ اسلات‌ها را خالی کن
    ['TL', 'Top', 'TR', 'Left', 'Right'].forEach(k => { $('seatSlot' + k).innerHTML = ''; });
    const slots = SEAT_SLOTS[Math.min(others.length, 5)] || SEAT_SLOTS[5];
    others.slice(0, slots.length).forEach((p, i) => {
      const key = slots[i];
      const area = $('seatSlot' + key);
      const vertical = (key === 'Left' || key === 'Right');
      const el = document.createElement('div');
      el.className = 'seat' + (vertical ? ' vert' : '') +
        (p.isCurrent ? ' is-current' : '') +
        (p.hasUno ? ' has-uno' : '') +
        (p.connected ? '' : ' offline');
      el.dataset.pid = p.id;
      el.innerHTML = seatHTML(p);
      area.appendChild(el);
    });
  }

  function renderGame(s, first) {
    const game = s.game;
    const v = s.viewer;
    const stackN = (game && game.pendingDraw) || 0; // پشتهٔ ۲+ باز

    // --- صندلی‌های دور میز ---
    renderSeats(s);

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
    if (game && game.direction && game.direction !== prevDirection) {
      if (prevDirection !== 0 && !first) {
        dir.classList.remove('flash');
        void dir.offsetWidth;
        dir.classList.add('flash');
        toast('جهت بازی عوض شد');
      }
      prevDirection = game.direction;
    }

    // --- بنر نوبت ---
    const banner = $('turnBanner');
    if (game && game.turnPlayerId) {
      const tp = s.players.find(p => p.id === game.turnPlayerId);
      if (v.isTurn) {
        banner.classList.add('me');
        $('turnBannerText').textContent = stackN > 0
          ? `نوبت شماست — ۲+ بازی کن یا ${faNum(stackN)} کارت بردار`
          : 'نوبت شماست';
      } else {
        banner.classList.remove('me');
        $('turnBannerText').textContent = stackN > 0
          ? `${tp ? tp.name : '…'} — ۲+ یا برداشت ${faNum(stackN)} کارت`
          : `نوبت: ${tp ? tp.name : '…'}`;
      }
    } else {
      banner.classList.remove('me');
      $('turnBannerText').textContent = 'منتظر شروع…';
    }

    // --- اکشن‌ها ---
    const drawBtn = $('drawBtn');
    const passBtn = $('passBtn');
    const unoBtn = $('unoBtn');
    const myTurn = !!v.isTurn && s.state === 'playing';
    drawBtn.disabled = !myTurn || !!(game && game.colorPickPending) || (!!v.drawnThisTurn && !stackN);
    drawBtn.classList.toggle('can', myTurn && (!v.drawnThisTurn || !!stackN));
    passBtn.disabled = !myTurn || !v.drawnThisTurn || !!stackN;
    unoBtn.hidden = !(v.hand && v.hand.length === 1 && v.canCallUno && s.state === 'playing');

    // هم‌انبار: برچسب و دکمهٔ برداشت پشته
    const drawLabel = $('drawBtnLabel');
    if (drawLabel) {
      drawLabel.textContent = stackN > 0
        ? `برداشت ${faNum(stackN)} کارت جریمه`
        : 'برداشتن کارت';
    }
    const stackBadge = $('stackBadge');
    if (stackBadge) {
      stackBadge.hidden = !stackN;
      if (stackN) $('stackBadgeCount').textContent = faNum(stackN);
    }

    // دیک قابل برداشتن
    $('deckPile').classList.toggle('can-draw', myTurn && !v.drawnThisTurn);

    // --- دست ---
    renderHand(s, myTurn, first);

    // --- بنر گرفتن UCHO ---
    const cb = $('catchBanner');
    if (v.canCatch && v.canCatch.length && s.state === 'playing') {
      const names = v.canCatch.map(pid => {
        const p = s.players.find(pp => pp.id === pid);
        return p ? p.name : '';
      });
      cb.hidden = false;
      cb.innerHTML = `<button id="catchBtn"><span class="icon">${window.UNOIcons.icon('siren')}</span>${escapeHTML(names[0])} UCHO نگفت — بگیرش!</button>`;
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
        toast('بازی شروع شد', 'good');
        break;
      case 'play': {
        SFX.play();
        flyCardToDiscard(ev);
        if (ev.chosenColor) setTimeout(() => toast(`رنگ ${colorName(ev.chosenColor)} انتخاب شد`), 600);
        if (ev.card && ev.card.value === 'reverse') { SFX.turn(); }
        break;
      }
      case 'draw': {
        SFX.draw();
        if (ev.auto) {
          const p = state.players.find(pp => pp.id === ev.playerId);
          toast(`${p ? p.name : 'بازیکن'} مدتی بی‌حرکت بود — خودکار رد شد`);
        }
        break;
      }
      case 'color':
        toast(`رنگ: ${colorName(ev.color)}`);
        break;
      case 'uno':
        SFX.uno();
        bigUchoPop();
        toast('UCHO!', 'good');
        break;
      case 'caught':
        SFX.caught();
        toast('۲ کارت جریمه!', 'bad');
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
        const el = document.querySelector(`.seat[data-pid="${ev.playerId}"]`);
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

  function bigUchoPop() {
    const el = document.createElement('div');
    el.className = 'big-uno';
    el.innerHTML = '<span>UCHO!</span>';
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
    $('winTitle').textContent = isMeWinner ? 'تو بردی!' : `${winner ? winner.name : 'بازیکن'} برد!`;
    $('winSub').textContent = isMeWinner ? 'آفرین، فوق‌العاده بازی کردی' : 'دست بعدی شانست می‌آورد';
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
    $('playWithBotsBtn').onclick = () => {
      // شروع فوری بازی با ۲ ربات — کاربر مستقیماً وارد میز بازی می‌شود
      SFX.play();
      socket.emit('playWithBots', ({ code }) => {
        if (code) { myRoomCode = code; toast('در حال آماده‌سازی بازی…', 'good'); }
      });
    };
    $('myRoomBtn').onclick = () => {
      // ساخت یک اتاق جدید (اگر قبلاً در اتاقی هستیم، از آن خارج می‌شویم)
      SFX.play();
      socket.emit('createRoom', ({ code }) => {
        if (code) { myRoomCode = code; toast('اتاق ساخته شد!', 'good'); }
      });
    };
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
    $('lobbyJoinBtn').onclick = () => {
      $('joinModal').hidden = false;
      setTimeout(() => $('joinInput').focus(), 100);
    };
    $('copyCodeBtn').onclick = async () => {
      const code = state ? state.code : myRoomCode;
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(code);
        else {
          const ta = document.createElement('textarea');
          ta.value = code; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); ta.remove();
        }
        toast('کد کپی شد!', 'good');
      } catch (e) { toast('کد: ' + code); }
    };
    $('shareBtn').onclick = () => {
      const code = state ? state.code : myRoomCode;
      const inviter = (me && me.first_name) || 'دوستت';
      const text = `${inviter} تو را به بازی UCHO دعوت کرد!\n\nکد اتاق: ${code}\n\nهمین حالا بپیوند!`;
      const url = `https://t.me/share/url?url=${encodeURIComponent(inviteLink(code))}&text=${encodeURIComponent(text)}`;
      if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
      else window.open(url, '_blank');
    };

    // بازی
    $('drawBtn').onclick = () => emit('drawCard');
    $('passBtn').onclick = () => emit('passTurn');
    $('unoBtn').onclick = () => emit('callUno');
    $('deckPile').onclick = () => { if (!$('drawBtn').disabled) emit('drawCard'); };
    $('gameRoomChip').onclick = async () => {
      const code = $('gameRoomCode').textContent.trim();
      if (!code || code === '-----') return;
      try { await navigator.clipboard.writeText(code); toast('کد اتاق کپی شد!', 'good'); }
      catch (e) { toast('کد: ' + code); }
    };

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

    // دکمه خروج در صفحه بازی (از قبل در HTML داخل .game-topbar وجود دارد)
    const exitBtn = $('gameExitBtn');
    if (exitBtn) exitBtn.onclick = () => emit('leaveRoom');
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
    injectIcons(document);
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

