/**
 * test-stack.js — تست قاعدهٔ هم‌انبار (+۲ روی ۲+) روی موتور uno.js
 * اجرا: node test-stack.js
 */
const { Room, canPlay } = require('./uno');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  — ' + JSON.stringify(detail) : ''}`);
  if (!cond) failed++;
}
function mkCard(color, value, id) { return { id: 'test_' + id, color, value }; }

// ---- ساخت اتاق ۳ نفره با دست‌های کنترل‌شده ----
const room = new Room('STACK', { id: 'A', first_name: 'A' });
room.addPlayer({ id: 'B', first_name: 'B' });
room.addPlayer({ id: 'C', first_name: 'C' });
room.startGame('A');

// دست‌ها را کنترل می‌کنیم
room.players[0].hand = [mkCard('red', 'draw2', 'd2r1'), mkCard('red', '2', 'fillA1'), mkCard('blue', '4', 'fillA2')];
room.players[1].hand = [mkCard('blue', 'draw2', 'd2b1'), mkCard('green', '5', 'g5')];
room.players[2].hand = [mkCard('red', '7', 'r7'), mkCard('green', '5', 'g5c')];
// کارت روی میز را هم کنترل می‌کنیم تا رنگ فعلی قرمز باشد
room.discard = [mkCard('red', '9', 'top0')];
room.currentColor = 'red';
room.turnIndex = 0; // نوبت A
room.pendingDraw = 0;
room.drawnThisTurn = false;

// ۱) A یک ۲+ می‌گذارد → هم‌انبار = ۲، نوبت B
const r1 = room.playCard('A', 'test_d2r1');
check('+2 played: ok', r1.ok === true);
check('stack = 2 after first +2', room.pendingDraw === 2, room.pendingDraw);
check('turn is B now', room.currentPlayerId() === 'B', room.currentPlayerId());
check('B hand count still 2 (not drawn yet)', room.players[1].hand.length === 2, room.players[1].hand.length);

// ۲) B دست دارد که نتواند ۲+ پاسخ دهد؟ — B یک ۲+ آبی دارد → می‌تواند پاسخ دهد
//    (قاعده: هر ۲+‌ای پاسخ می‌دهد، صرف‌نظر از رنگ)
check('canPlay: blue +2 answers a stack', canPlay({ color: 'blue', value: 'draw2' }, room.topCard(), 'red', room.pendingDraw) === true);
check('canPlay: non-+2 blocked during stack', canPlay({ color: 'blue', value: '5' }, room.topCard(), 'red', room.pendingDraw) === false);

// ۳) B هم ۲+ می‌گذارد → هم‌انبار به ۴ می‌رسد؛ C نمی‌تواند پاسخ دهد → فوراً ۴ کارت برمی‌دارد
const r3 = room.playCard('B', 'test_d2b1');
check('B stacked +2: ok', r3.ok === true);
check('pile resolved: stack = 0, C took all 4', room.pendingDraw === 0, room.pendingDraw);
check('C has no +2 → pile auto-resolved to C', room.pendingDraw === 0 && room.players[2].hand.length === 6, { pending: room.pendingDraw, cHand: room.players[2].hand.length });
check('turn is A after C auto-skip', room.currentPlayerId() === 'A', room.currentPlayerId());
check('C color = blue (last played +2 color)', room.currentColor === 'blue', room.currentColor);

// ۴) B (دارای ۲+) می‌تواند به‌جای پاسخ، پشته را بردارد: سناریوی تازه
room.players[0].hand = [mkCard('red', 'draw2', 'd2r2'), mkCard('red', '2', 'fillB1'), mkCard('blue', '4', 'fillB2')];
room.players[1].hand = [mkCard('blue', 'draw2', 'd2b2')];
room.players[2].hand = [mkCard('red', '3', 'r3')];
room.discard.push(mkCard('red', '8', 'top1'));
room.currentColor = 'red';
room.turnIndex = 0;
room.pendingDraw = 0;
room.colorPickPending = false;
room.drawnThisTurn = false;

room.playCard('A', 'test_d2r2');          // stack = 2, turn B
const r4 = room.drawCard('B');            // B تصمیم می‌گیرد به‌جای ۲+، پشته را بردارد
check('B chose to take the pile: ok', r4.ok === true);
check('B drew exactly 2 penalty cards', room.players[1].hand.length === 3, room.players[1].hand.length);
check('stack cleared after taking', room.pendingDraw === 0, room.pendingDraw);
check('turn passed to C after taking', room.currentPlayerId() === 'C', room.currentPlayerId());

// ۵) guard: پاس کردن هنگام پشتهٔ باز ممنوع است
room.players[0].hand = [mkCard('red', 'draw2', 'd2r3'), mkCard('red', '2', 'fillC1'), mkCard('blue', '4', 'fillC2')];
room.discard.push(mkCard('red', '5', 'top2'));
room.currentColor = 'red';
room.turnIndex = 0;
room.pendingDraw = 0;
room.colorPickPending = false;
room.drawnThisTurn = false;
room.playCard('A', 'test_d2r3');
const r5 = room.passTurn('B');
check('pass during open stack rejected', !!(r5 && r5.error), r5);

// ۶) کارت شروع +۲: بازیکن اول باید پاسخ دهد (هم‌انبار = ۲ از ابتدا)
const room2 = new Room('STACK2', { id: 'A', first_name: 'A' });
room2.addPlayer({ id: 'B', first_name: 'B' });
room2.startGame('A');
room2.discard = [mkCard('red', 'draw2', 'starter')];
room2.currentColor = 'red';
room2.pendingDraw = 2;
room2.colorPickPending = false;
check('starter +2 leaves turn with first player', room2.currentPlayerId() === 'A');
const r6 = room2.drawCard('A');
check('first player takes starter +2 pile (2 cards)', r6.ok === true && room2.players[0].hand.length === 9, room2.players[0].hand.length);
check('stack cleared and turn passed', room2.pendingDraw === 0 && room2.currentPlayerId() === 'B');

// ۷) برد با آخرین کارت ۲+ هنوز کار می‌کند (پشته بی‌اثر می‌شود)
const room3 = new Room('STACK3', { id: 'A', first_name: 'A' });
room3.addPlayer({ id: 'B', first_name: 'B' });
room3.startGame('A');
room3.players[0].hand = [mkCard('red', 'draw2', 'last')];
room3.players[1].hand = [mkCard('blue', '4', 'b4')];
room3.discard = [mkCard('red', '9', 'top3')];
room3.currentColor = 'red';
room3.turnIndex = 0;
room3.pendingDraw = 0;
room3.colorPickPending = false;
room3.drawnThisTurn = false;
const r7 = room3.playCard('A', 'test_last');
check('playing last card +2 wins the round', r7.won === true && room3.state === 'ended' && room3.winnerId === 'A');

console.log(failed ? `\n${failed} FAILURES` : '\nALL STACK RULE TESTS PASSED');
process.exit(failed ? 1 : 0);
