const test = require('node:test');
const assert = require('node:assert/strict');

const antiban = require('../src/services/antiban');
const { PresenceHelper } = require('../src/services/antiban/presence');
const router = require('../src/router/router');
const config = require('../src/config');

router.loadCommands();

/** A socket that only records the presence updates. */
function presenceSock() {
  const seen = [];
  return {
    seen,
    sock: {
      sendPresenceUpdate: async (type, jid) => { seen.push({ type, jid }); },
      sendMessage: async () => ({ key: { id: 'X' } })
    }
  };
}

test('a text reply shows the typing indicator', async () => {
  const p = presenceSock();
  const presence = new PresenceHelper({ enabled: true });
  presence.setSocket(p.sock);
  const slept = await presence.beforeSend('u@s.whatsapp.net', { text: 'hello there' }, { maxMs: 1600 });
  assert.equal(p.seen[0].type, 'composing', 'composing was sent');
  assert.equal(p.seen[0].jid, 'u@s.whatsapp.net');
  assert.ok(slept >= 400, 'the indicator stays visible for a moment');
  await presence.afterSend('u@s.whatsapp.net');
  assert.equal(p.seen[p.seen.length - 1].type, 'paused', 'the indicator is switched off');
});

test('the indicator is visible for at least a moment, even for a short text', async () => {
  const p = presenceSock();
  const presence = new PresenceHelper({ enabled: true });
  presence.setSocket(p.sock);
  const slept = await presence.beforeSend('u@s.whatsapp.net', { text: 'ok' }, { maxMs: 0 });
  assert.ok(slept >= 600, 'a flash would not be noticed: ' + slept);
});

test('the per-call socket wins — paired sessions use their own connection', async () => {
  const a = presenceSock();
  const b = presenceSock();
  const presence = new PresenceHelper({ enabled: true });
  presence.setSocket(a.sock);
  await presence.beforeSend('u@s.whatsapp.net', { text: 'hi' }, { maxMs: 700, sock: b.sock });
  assert.equal(a.seen.length, 0, 'the default socket was not used');
  assert.equal(b.seen[0].type, 'composing', 'the session socket was used');
});

test('a menu card (a probe) also shows the typing indicator', async () => {
  const p = presenceSock();
  const before = p.seen.length;
  await antiban.beforeOutbound('u@s.whatsapp.net', { text: '👇 Tap a category to open it' },
    { probe: true, sock: p.sock });
  assert.ok(p.seen.length > before, 'the menu shows "typing…" too');
  assert.equal(p.seen[0].type, 'composing');
});

test('a probe never blocks and never eats the rate budget', async () => {
  antiban.reset();
  const started = Date.now();
  await antiban.beforeOutbound('u@s.whatsapp.net', { text: 'x' }, { probe: true, probeMaxMs: 50 });
  assert.ok(Date.now() - started < 3000, 'a probe returns fast');
  assert.equal(antiban.status().rate.minute, 0, 'no rate budget was used');
});

test('the menu path sends the body text with the card (so the indicator has a length)', () => {
  const mb = require('../src/services/menubuttons');
  const p = mb.homePayload({ commands: router.list(), name: 'T', isOwner: true });
  assert.ok(p.typingText && p.typingText.length > 0, 'the card carries its body text');
});
