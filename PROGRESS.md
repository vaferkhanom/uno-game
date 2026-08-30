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
