# UNO Mini App — Bot Investigation Progress

Task: After the previous fix (commit 07e74b9), none of the Telegram bot commands respond.
This file logs every step so a future session can resume.


## [2025-01-29 step 1] Check bot is running and getMe succeeded
- What I did: Hit /healthz, /api/config, and Telegram getWebhookInfo
- What I found: 
  - healthz: uptime 806s (running for 13+ min, stable), 18 rooms in memory
  - config: botUsername=Echounobot, maxPlayers=6 (loaded fine)
  - getWebhookInfo: url is EMPTY (good — no webhook blocking long-polling)
  - pending_update_count: 0
- Current hypothesis: Server is up and stable. Webhook is empty. Move to step 3 (check for 409 polling conflict) since server appears healthy.
- Next step: Step 3 — search logs for 409/Conflict; also look for the [bot] startup line to confirm getMe succeeded

## [2025-01-29 step 3] FOUND IT — 409 polling conflict
- What I did: Queried Railway environmentLogs for env 3a6edb48-4f1f-42d3-860d-5411ff9e8d57
- What I found: 
  - 14:55:57 deploy completed, server up, "🤖 Bot connected: @Echounobot", "[bot] starting long-polling, offset=0"
  - 14:56:01: "[bot] getUpdates error: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"
  - 14:56:02: SIGTERM, process killed
  - BUT /healthz at 14:55:57+ shows server still up (uptime 806s = ~13min), so it must have been restarted since
  - Lots of [io] connected/disconnected entries for the socket.io side (the WebSocket server is fine)
  - No further [bot] log lines after 14:56:01 — meaning the bot polling has been DEAD for the entire uptime
- Current hypothesis: Step 3 confirmed. Two polling instances are competing on the same BOT_TOKEN. The newer instance can't get a slot because another (older or local) instance is still polling. When polling fails, the bot code likely exits the process. This is why no commands work — the bot's getUpdates loop is dead.
- Next step: 
  1. Read the bot code to see how it handles getUpdates errors (does it crash? does it retry?)
  2. Check for any local instance running with the same token
  3. Check Railway's instance count (could be 2 replicas)
  4. Fix the bot to either be resilient to 409 or to recover


## [2025-01-29 step 3 deep-dive] Root cause: 409 conflict on every redeploy, takes ~10min to recover
- What I did: Pulled all bot-related log lines from the last 5 hours (77 entries)
- What I found (chronological pattern):
  - 10:32:35 deploy → 409 immediately
  - 11:13:27 deploy (BOT_TOKEN empty) → bot disabled
  - 11:46:37 deploy → 409 after 2s
  - 11:52:40 deploy → 409 repeated multiple times (3 instances of "Bot connected" too!?)
  - 12:00:02 → 409
  - 12:03:15 → 409 then RECOVERS (1 successful /start at 12:06:56)
  - 12:47:05 → 409 again, recovers at 12:52:00
  - 13:07:19 → 409, recovers 13:17:34
  - 13:36:14 → 409, recovers 13:42:06 — full working session
  - 14:55:57 (my fix deploy) → 409, NO RECOVERY until 15:05:38 (9 minutes!)
  - 15:05:38 onward → bot works fine, all commands succeed
  
- Key insight: EVERY deploy causes a 409 conflict because the previous container's long-polling connection is still alive when the new container starts. The new container's getUpdates is rejected. The bot's retry logic (5s sleep) keeps trying but the conflict only resolves when the OLD container is finally killed (Railway's graceful shutdown timeout). This takes anywhere from seconds to 9 minutes depending on the kill speed.

- Current hypothesis: This is the actual root cause. The user sent commands between 14:56 and 15:05 and got no response because of the 409. The bot was alive but UNABLE to receive updates. After ~9 minutes Railway killed the old instance, and the new one got a clean slot.

- Next step: The fix should be:
  1. **Bot should keep trying even on 409** (it does — but the user sees no feedback)
  2. **Better: only one polling attempt at a time, no parallel runs** — make the new instance wait or call deleteWebhook/getUpdates sequentially
  3. **Best fix for the user experience: when bot can't get updates, respond with a clear error** OR **detect 409 and treat it as "previous instance is still running" and back off gracefully**
  
  Actually, the SIMPLEST and most reliable fix: use a `BOT_LOCK` mechanism so even if 2 instances are alive, only one polls. We can use Railway's environment to set a lock file or just have a single shared variable. But for now, the bot RECOVERS on its own within ~10 minutes — the question is: was the user just impatient, or is there a code-side fix that would speed up recovery?

  Actually re-reading the task: the user says "None of the bot's Telegram commands work anymore (this is AFTER the previous fix was deployed and verified working once)". The user said "verified working once" — meaning after my fix they tested once and it worked. Then they tested again and it didn't. The 409 is a transient deploy-time issue, not a permanent bug.


## [2025-01-29 step 4 plan] Implement SIGTERM handler
- What I did: Analyzed the bot loop and confirmed there's NO SIGTERM handler
- What I found: When Railway redeploys, it sends SIGTERM to the old container. The old container's in-flight getUpdates long-poll is still in flight (10s timeout). The NEW container starts immediately, calls getUpdates, and Telegram responds 409 because the old one is technically still in flight.
- Current hypothesis: Add a SIGTERM handler that:
  1. Marks the bot as "shutting down" so it stops the long-poll loop immediately
  2. Aborts the in-flight fetch via AbortController
  3. The Node process can exit cleanly without the 10s long-poll holding it
  
  This should prevent the 409 entirely. Additionally, the 409 retry logic should be exponential backoff, not fixed 5s.
  
- Next step: Apply the fix to server.js

## [2025-01-29 step 4 fix] SIGTERM handler + backoff implemented and deployed
- What I did:
  1. Added AbortController to the getUpdates fetch (only for polling calls)
  2. Added SIGTERM/SIGINT handler: sets botShuttingDown, aborts in-flight long-poll, closes HTTP server + socket.io, hard-exits after 2s
  3. Added exponential backoff on 409 (1s→2s→4s…→30s cap); fixed a self-bug where backoff reset on every response (moved reset into res.ok branch)
  4. Verified locally: SIGTERM produces '[bot] received SIGTERM, cancelling in-flight getUpdates and exiting' and clean exit
  5. Committed 2c6e911, pushed, auto-deployed
- What I found on the new deploy's transition logs:
  - 13:51:43 new container polling starts
  - 13:51:46 exactly ONE 409 (old container still held slot)
  - 13:51:47 old container SIGTERMed and stopped
  - NO further 409s → retry succeeded, polling healthy
  - vs. previous deploys: 409 storms lasting minutes (worst: 9-min outage 14:56→15:05)
- Current hypothesis: Root cause fixed. The historical 'commands don't work' windows were deploy-transition 409 conflicts. Historical user commands DO process when polling is healthy (logs 15:05-15:06 show /start, 🎮 ساخت اتاق جدید, /play, /new, 🏠 اتاق من, /rules, /list all working with rooms created).
- Next step: Commit backoff fix, verify deploy, then live-verify all 9 commands

## [2025-01-29 push] Network flakiness during push — resolved
- What I did: Retried git push several times; DNS to github.com was intermittently failing
- What I found: A background retry succeeded; origin/main is now at 99afb18 (backoff fix). Both bot commits (2c6e911 + 99afb18) are on GitHub and will auto-deploy.
- Next step: Watch deploy, verify transition is clean, then live-verify all 9 commands

## [2025-01-29 step 5 begin] Live verification setup
- What I did: Sent a diagnostic Telegram message to the reporting user (chat 6437188126) listing commands to test. sendMessage returned ok:true → outbound path works.
- What I found: Deploy of 99afb182 transitioned with only ~4 transient 409s over ~9 seconds (old container needed 8s to die), then clean polling. Historical logs already prove the router works live: at 15:05-15:06 the user's /start, 🎮 ساخت اتاق جدید, /play, /new, 🏠 اتاق من, /rules, /list ALL processed correctly (rooms created, replies sent). Commits 2c6e911/99afb18 changed only the polling loop + shutdown, not handlers.
- Next step: Watch logs for the user's test commands; log each command's live result; then finalize.

## [2025-01-29 FINAL] Root cause found, fixed, deployed, verified

### Root cause (definitive)
Every Railway redeploy produced a Telegram 409 polling conflict:
- The OLD container's in-flight getUpdates long-poll (10s timeout) kept the bot's polling slot occupied
- There was NO SIGTERM handler, so the old process never released the slot quickly
- The NEW container's polling loop was blocked by repeated 409s for the entire overlap window
- Worst observed outage: ~9 minutes (14:56→15:05) — during this window ALL bot commands were silently ignored (updates never reached the server). This is exactly the user-reported symptom.

### Fixes (2 commits, both deployed)
1. 2c6e911 — SIGTERM/SIGINT graceful shutdown: aborts in-flight long-poll via AbortController, closes HTTP + socket.io, hard-exits within 2s → frees Telegram polling slot almost instantly on redeploys. Plus 409 exponential backoff (1s→30s cap).
2. 99afb18 — backoff reset moved into res.ok branch (409 backoff now actually grows).

### Verification evidence
- Local SIGTERM test: '[bot] received SIGTERM, cancelling in-flight getUpdates and exiting' + clean exit ✅
- Deploy transition of 99afb182: 4 transient 409s over ~9s while old container died (15:47:32→15:47:41), then ZERO 409s — polling recovered in seconds (previously: minutes) ✅
- healthz: ok, uptime growing, process stable ✅
- getWebhookInfo: url empty (no webhook blocking polling) ✅
- Only ONE Railway service instance (serviceInstances.edges.length = 1) ✅
- Local dev instance uses BOT_TOKEN='' (not polling) — no competing poller ✅
- Outbound sendMessage: ok:true (delivered diagnostic message to user's chat) ✅

### Live command results (from production logs, user Vlniqqa id 6437188126)
These ran LIVE while polling was healthy (15:05:38–15:06:17, on handler code identical to current — commits 2c6e911/99afb18 touched only polling loop + shutdown, zero handler changes):
- /start          → processed (main menu sent) ✅
- /play           → '[bot] /play: created room 3FVSM' ✅ (also verified with rooms MSCMV, GDDH3, 7X2WE on repeats)
- /new            → '[bot] /play: created room GDDH3' ✅
- 🎮 ساخت اتاق جدید (keyboard) → routed to /play, room 3FVSM created ✅
- 🏠 اتاق من (keyboard) → processed ✅
- /rules          → message received, processed ✅
- /list           → message received, processed ✅
- /join, /room, /leave, /invite, /stats → same handler code path, verified in earlier sessions; not re-exercised in the 15:05 window because the user didn't send them
- User notified via bot message to run a full live re-test (/play, /room, /invite, /rules, /stats)

### Status: RESOLVED
No further action needed unless the user's live re-test shows a specific command failing — if so, check PROGRESS.md history and logs filtered by '[bot]'.

## [2025-01-29 modal-fix] ROOT CAUSE: .modal display:flex overrides [hidden] — all modals always visible
- What I did: Verified live CSS (line 280 .modal display:flex, no [hidden] rule) and live HTML (4 modals with hidden attr). Confirmed bot logs at user's test time (16:24-16:25 UTC): /play created room WCTYW+EECV9, /room //invite//rules//stats all received+processed. Bot was working; Mini App UI was broken.
- What I found: Author .modal{display:flex} beats UA [hidden]{display:none} → all 4 modals permanently rendered; joinModal (last in DOM) covers every screen. Join actions actually succeeded but the stuck modal made it look like nothing happened.
- Current hypothesis: N/A — root cause proven.
- Next step: Applied fixes: (1) style.css global [hidden]{display:none!important}; (2) app.js startapp fallback via location.search. Verifying + deploying.

## [2025-01-29 modal-fix deployed+verified] UI modal bug FIXED and live
- What I did: Applied + deployed two fixes. Commits 9b231a3 (style.css [hidden]{display:none!important}; app.js startapp fallback) and b799c45 (test harness fix + cleanup).
- What I found:
  - Live CSS now shows line 2: `[hidden] { display: none !important; }` ✅
  - Live app.js shows startapp fallback via location.search ✅
  - Live E2E (websocket): fresh client state=home → createRoom JDE82 → B join → lobby players=2 → game start → all working; full game ran 60 plays/7 UNO with correct server rejections ✅
  - test-game.js updated to wait for a lobby-state (not any state) since fresh clients now get the new home state
- Current hypothesis: N/A — both fixes verified live.
- Next step: User to re-test in Telegram: /play → open room → no code-entry modal; should land in lobby with room code. If any modal still appears, add a JS init that forces all modal elements hidden on startup.

## [2025-01-30 FINAL] Play with bots — feature complete and live
- What I did: Implemented 4 of 5 planned changes; the cosmetic "hide code-input flow" was absorbed by the much stronger playWithBotsBtn primary CTA.
- Commits: 3e782a4 (feat: play with bots) deployed to Railway.
- What I found (live verification):
  - live HTML: <button id="playWithBotsBtn">🤖 بازی با ربات</button> present
  - live app.js: handler at line 494 emits 'playWithBots' to server
  - live server: playWithBots event creates room + 2 AI bots + auto-startGame
  - live AI behavior: bot acts in 1.5-2.5s, picks wild color, draws if unplayable, passes after draw
  - end-to-end test: room SCGBV, 3 players (1 human + 2 bots), game state = playing, hands progressing correctly
  - isBot: false/true correctly reported to client (now included in serialize)
- User instructions:
  - Open the Mini App in Telegram (or browser)
  - Hard-refresh to clear any stale cache (cache-bust version was added: ?v=1a2b3c4d)
  - Tap "🤖 بازی با ربات" — game starts immediately
  - The user can also tap "🎮 ساخت اتاق (با دوستان)" to create a normal room, or "🔑 پیوستن با کد" for the code-input flow
- What was NOT changed: game engine (uno.js) rules, bot handlers, CSS color palette, fonts, existing card SVGs.

## [2025-01-30 PART1-DONE] #game grid layout redesign — structural fix deployed
- Fixed: grid-template-areas `topbar/table/actions/hand` replaces 10 position:absolute/fixed elements
- table-center: position:absolute removed, now grid-area:table flex child
- turn-banner: moved inside .table-center, order:-1 to render above pile
- direction-badge: moved inside .discard-area, right:-10px, 36x36px circle (not pixel top:88px)
- game-actions: grid-area:actions (no longer right/left/bottom absolute)
- hand-wrap: grid-area:hand (no longer bottom:absolute)
- catch-banner: fixed center (no longer top:34% absolute)
- exit button: removed dynamic creation from app.js; wired existing #gameExitBtn in HTML
- HTML: renamed .game-table -> .table-center for consistency
- app.js: exit button wired to existing HTML element instead of dynamically created
- game-topbar already had grid-area:topbar from previous work
- Committed: 63a688e | Pushed -> Railway (uptime: 167s)
- E2E: RESTART TEST PASSED on production

## [2026-08-31 REGRESSION-FIX] #game always visible on top of every screen — duplicate rule blocks
- Bug: game screen rendered on top of home (hero, buttons, rules visible under floating game HUD)
- Root cause: redesign commit 63a688e ADDED a new #game block (line 70) but never deleted the
  pre-existing #game block (line 211). Two unconditional `display: grid` on an id selector beat
  `.screen/.screen.active` (specificity 1-0-0 > 0-2-0), so #game was ALWAYS visible. The
  `#game.active { display: grid; }` that followed the old block was dead code.
- Fix: exactly ONE #game visibility pair now — `#game.active { display: grid; ...grid props... }`,
  no unconditional display on #game. Falls back to `.screen` display:none when not active.
  Grid props merged from both old blocks (kept effective deployed values: minmax(0,1fr) row,
  100dvh, safe-area padding, columns 1fr, gap 0).
- Duplicate-selector scan of whole style.css (incl. media queries): #game was the ONLY duplicated
  selector; no other conflicts introduced by the redesign.
- Extra functional fix found during E2E: client never handled the server's `left` event, so the
  in-game exit button (gameExitBtn -> emit leaveRoom) returned nowhere. Added
  `socket.on('left') -> showScreen('home')` in app.js (pre-existing gap, not redesign-caused).
- E2E (headless Chrome + real server, 31/31 checks): splash->home, home->lobby (2nd player joins
  via code), lobby->game, full bot game to win modal, again->game, exit->home, play-with-bots->game.
  Every hidden screen computed display:none with 0x0 paint box (no partial/transparent bleed).
- Noted (NOT fixed, out of scope): turn watchdog skips disconnected players' seats — a dropped
  human soft-locks a running game (server.js watchdog `if (!p || !p.connected) continue;`).
- Cache-bust: style.css?v=g20250130-2

## [2026-08-31 REDESIGN-P2] De-emoji + epic typography + seated table layout
- Emoji ban: every emoji removed from UI (index.html, app.js), game log strings (uno.js) and
  Telegram bot messages + keyboard labels (server.js; matchers and labels stay in sync).
- Replacement system: public/js/icons.js — stroke-based inline SVG icon set (currentColor),
  injected via [data-icon] spans at boot; avatars = initial letters (no emoji avatars).
- Typography: Vazirmatn Black (900) display scale — hero clamp(44px,13vw,62px), splash 42,
  room-code 54 monospace, section headers with gold SVG accent, buttons 900 with icon slot.
- Game layout rebuilt as a table: .table-zone CSS grid seats opponents around the pile —
  1 opp: left | 2: left+right | 3: left+top+right | 4-5: corners added. Viewer is bottom (hand).
  Active seat: gold ring + pulsing avatar + "نوبت" pip; turn banner "نوبت: X" / "نوبت شماست";
  direction badge now SVG with slow spin, mirrors on reverse and flashes on direction change.
- Overlap safety: pile sizes fluid clamp(64px,20vw,92px) + aspect-ratio 2/3; seat columns
  minmax(60px,1fr); side seats capped min(84px,100%) with 6px outer margin; removed scale
  transform on current seat (it caused 3px rect overlap); verified no-intersection at
  390x844 / 360x640 / 320x568 / 414x896, incl. seats-vs-pile/hand/banner/each-other.
- deckBack now renders the SVG card back (was an empty dashed box).
- E2E updated: 46/46 — all screen-toggle chains + seated layout + zero-emoji render check
  (body.innerText scanned for emoji ranges) + Vazirmatn/weight-900 assertions. Production
  socket test (test-game.js vs Railway) passed pre-push.
- Cache-bust: style.css + app.js + icons.js ?v=g20260831-1

## [2026-08-31 STACK-RULE + UCHO] +2 stacking mechanic & full rebrand to UCHO
- Stack rule implemented (house rule): playing +2 accumulates room.pendingDraw (+2 each);
  next player must answer with their own +2 (any color) or take the whole pile and is skipped.
  Chosen option: take-pile = drawCard while pendingDraw>0 (draws N, clears stack, skips).
  passTurn is blocked while a stack is open. Starter +2 now gives first player the choice.
  Engine guards: canPlay() gates to draw2 during a stack; last-card +2 still wins (pile void).
- AI: bots stack when they hold +2, otherwise take the pile; watchdog auto-takes on 90s stall.
- Client: draw button becomes "برداشت N کارت جریمه", red stack badge (+N) on discard pile,
  banner explains the decision, hand highlights only +2 as playable during a stack.
- Rebrand UNO→UCHO everywhere displayed: card back wordmark "UCHO / ONLINE" (Arial Black,
  letter-spaced, stroke), splash+hero <span class="brand-latin">UCHO</span>, big pop "UCHO!",
  UCHO! button, help/rules texts, bot messages/keyboard, package.json, README. No 'یونو'/'UNO'
  remains in any shipped file. Cache-bust ?v=g20260831-2.
- Tests: new test-stack.js — 20/20 (3-player chain 2→4→auto-take+skip, choose-to-take,
  pass-blocked, starter +2, last-card +2 win). E2E 46/46 incl. updated second-player bot
  driver that stacks. Production socket test passed. TDZ bug (stackN before init) found by
  E2E and fixed.
