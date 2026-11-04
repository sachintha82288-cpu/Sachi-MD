/**
 * Round 10 — the pairing lifecycle.
 *
 * The complaint behind this file: "I got a code from the website but it does
 * not link", and "the site only opens once the developer's number is paired".
 * Both are lifecycle bugs, not UI bugs, so they are pinned down here:
 *
 *   1. a code may only be requested once the socket reached PAIRING mode;
 *   2. WhatsApp closing an unlinked socket must NOT silently invalidate the
 *      code on screen — the attempt is reopened and rotated instead;
 *   3. the rotated code must reach the page (the pairing record is updated);
 *   4. a paired session must never install itself as the global fallback
 *      socket (that is how typing/presence leaked onto the wrong account).
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const sessionManager = require('../src/whatsapp/sessionManager');
const pairing = require('../src/services/pairing');
const antiban = require('../src/services/antiban');

after(() => {
  try { pairing.reset(); } catch {}
  delete process.env.PAIR_MAX_CODE_ROTATIONS;
});

/** A socket that only knows how to emit events and hand out codes. */
function fakeSession(over = {}) {
  const ev = new EventEmitter();
  const sock = {
    ev,
    user: null,
    requestPairingCode: async () => 'MILUKOTA',
    end: () => {},
    sendMessage: async () => ({ key: { id: 'x' } }),
  };
  return {
    id: over.id || '94771234567',
    phone: over.phone || '94771234567',
    isPrimary: false,
    sock,
    connected: false,
    jid: null,
    name: null,
    state: 'pairing',
    sentIds: new Set(),
    seenIds: new Set(),
    ackWaiters: new Map(),
    messageCache: new Map(),
    startedAt: Date.now(),
    connectedAt: 0,
    notifyJid: null,
    notifySend: null,
    qrSeen: 0,
    rotations: 0,
    restartTimer: null,
    send: async () => ({ key: { id: 'x' } }),
    ...over,
  };
}

test('a code is not requested before the socket reaches pairing mode', async () => {
  const session = fakeSession();
  let asked = 0;
  session.sock.requestPairingCode = async () => { asked++; return 'ABCDWXYZ'; };

  // No QR yet: the helper must wait. Prove it waits by emitting the QR after a
  // moment and checking the code arrives afterwards.
  setTimeout(() => session.sock.ev.emit('connection.update', { qr: 'qr-string' }), 120);
  // attachHandlers is what records qrSeen; use its listener directly.
  sessionManager.attachHandlers(session);
  const code = await sessionManager.requestSessionCode(session, '94771234567', { attempts: 1 });
  assert.equal(code, 'ABCDWXYZ');
  assert.equal(asked, 1, 'exactly one code request');
  assert.ok(session.qrSeen > 0, 'the pairing-mode marker was recorded');
  assert.equal(session.currentCode, 'ABCDWXYZ', 'the session remembers what it issued');
});

test('waitForPairingReady gives up instead of hanging forever', async () => {
  const session = fakeSession();
  const ready = await sessionManager.waitForPairingReady(session, 250);
  assert.equal(ready, false);
});

test('a pending socket close reopens and rotates — it never just reconnects', () => {
  const session = fakeSession({ rotations: 0 });
  assert.deepEqual(sessionManager.pendingCloseAction(session, 428), { action: 'reopen', rotations: 1 });
  // the second close of the same attempt keeps counting up
  session.rotations = 3;
  assert.deepEqual(sessionManager.pendingCloseAction(session, 428), { action: 'reopen', rotations: 4 });
});

test('the primary session and linked sessions reconnect normally', () => {
  assert.equal(sessionManager.pendingCloseAction({ isPrimary: true, id: 'primary' }, 428).action, 'reconnect');
});

test('the rotation budget is finite, then the attempt is dropped', (t) => {
  process.env.PAIR_MAX_CODE_ROTATIONS = '2';
  t.after(() => { delete process.env.PAIR_MAX_CODE_ROTATIONS; });
  const session = fakeSession({ rotations: 0 });
  assert.equal(sessionManager.pendingCloseAction(session, 428).action, 'reopen');
  session.rotations = 1;
  assert.equal(sessionManager.pendingCloseAction(session, 428).action, 'reopen');
  session.rotations = 2;
  const plan = sessionManager.pendingCloseAction(session, 428);
  assert.equal(plan.action, 'drop', 'after the budget the bot stops orbiting WhatsApp');
  assert.equal(plan.rotations, 3);
});

test('a rotated code is published into the pairing record the page polls', async (t) => {
  pairing.reset();
  // The WhatsApp layer is stubbed: this test is about the record the page
  // reads, never about opening a real socket.
  const realPair = sessionManager.pairNumber;
  sessionManager.pairNumber = async (phone) => ({ phone, code: 'OLDCCODE', restored: false });
  t.after(() => { sessionManager.pairNumber = realPair; });

  const request = await pairing.request({ phone: '94771239999', source: 'web', ip: '203.0.113.9' });
  const view = () => pairing.listPending().find((r) => r.id === request.id);
  const before = view();
  assert.equal(before.rawCode, 'OLDCCODE', 'the first code came from the socket');

  // This is what the session manager calls when WhatsApp drops the socket.
  sessionManager.emitPairingCode('94771239999', 'NEWWCODE');

  const afterChange = view();
  assert.equal(afterChange.state, 'waiting');
  assert.equal(afterChange.rawCode, 'NEWWCODE', 'the page shows the rotated code');
  assert.equal(afterChange.code, 'NEWW-CODE', 'grouped for display, ungrouped for typing');
  assert.ok(afterChange.rotations >= 1, 'the rotation is counted');
  assert.equal(afterChange.codeExpired, false, 'the rotation restarts the TTL');
  assert.ok(afterChange.secondsLeft > 50, 'a fresh TTL of ~60 s');

  // A linked number must never be rotated back to 'waiting': the listener
  // ignores rotations for anything that is not still waiting, and a linked
  // attempt never shows a code at all.
  const realLinked = sessionManager.isLinked;
  sessionManager.isLinked = () => true;
  sessionManager.emitPairingCode('94771239999', 'ZZZZZZZZ');
  assert.equal(view().state, 'linked');
  assert.equal(view().rawCode, '', 'a linked attempt shows no code');
  sessionManager.isLinked = realLinked;
  assert.equal(view().rawCode, 'NEWWCODE', 'and the rotation never overwrote the real one');
});

test('an expired code is rotated by the sweep, so the page never dies waiting', async (t) => {
  pairing.reset();
  const realPair = sessionManager.pairNumber;
  const realRefresh = sessionManager.refreshPairingCode;
  let refreshes = 0;
  sessionManager.pairNumber = async (phone) => ({ phone, code: 'FIRSTCOD', restored: false });
  sessionManager.refreshPairingCode = async () => { refreshes++; return 'FRESHCOD'; };
  t.after(() => {
    sessionManager.pairNumber = realPair;
    sessionManager.refreshPairingCode = realRefresh;
  });

  const rec = await pairing.request({ phone: '94771239911', source: 'web', ip: '203.0.113.11' });
  const view = () => pairing.listPending().find((r) => r.id === rec.id);
  assert.equal(view().rawCode, 'FIRSTCOD');

  // Two rotation sources firing back to back must not burn two codes: the
  // second one would invalidate the code the user is already typing.
  sessionManager.emitPairingCode('94771239911', 'SAMEMS01');
  sessionManager.emitPairingCode('94771239911', 'SAMEMS02');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(view().rawCode, 'SAMEMS01', 'the first code survives the race');
  assert.equal(refreshes, 0, 'and no extra code was requested from WhatsApp');

  // 61 s later the code is dead on WhatsApp's side — but the attempt still has
  // minutes to live and the person is still on the page.
  const later = Date.now() + 61_000;
  assert.equal(pairing.publicView(view(), later).rawCode, '', 'an expired code is never shown');

  pairing.tick(later);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(refreshes, 1, 'the sweep asked WhatsApp for exactly one new code');
  const after = view();
  assert.equal(after.rawCode, 'FRESHCOD', 'the page shows it on its next poll, with no button press');
  assert.ok(after.rotations >= 2, 'the rotation is counted');
  assert.equal(after.codeExpired, false, 'and the TTL restarted');
  assert.ok(after.secondsLeft > 50);

  // The sweep must not hammer WhatsApp: an attempt has one shared ceiling.
  const budget = pairing.MAX_ROTATIONS();
  assert.ok(budget >= 10, 'a 15 minute attempt needs room to rotate');
  for (let i = 0; i < 3; i++) {
    pairing.tick(Date.now() + (i + 2) * 61_000);
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.ok(refreshes <= budget, `rotated ${refreshes} times, budget is ${budget}`);
});

test('a paired session never becomes the global fallback socket', async () => {
  const session = fakeSession({ phone: '94771230001', id: '94771230001' });
  let installed = 0;
  const realSet = antiban.setSocket;
  antiban.setSocket = () => { installed++; };
  try {
    sessionManager.attachHandlers(session);
    session.sock.user = { id: '94771230001:3@s.whatsapp.net', name: 'Paired User' };
    session.sock.ev.emit('connection.update', { connection: 'open' });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(installed, 0, 'antiban.setSocket must not be called by a paired session');
    assert.equal(session.connected, true, 'but the session does come online');
    assert.match(String(session.jid), /94771230001/, 'and it knows its own jid');
  } finally {
    antiban.setSocket = realSet;
  }
});

test('the primary session still installs itself as the fallback socket', async () => {
  const session = fakeSession({ id: 'primary', phone: '', isPrimary: true });
  let installed = 0;
  const realSet = antiban.setSocket;
  const realStatus = require('../src/services/status/manager').setSocket;
  require('../src/services/status/manager').setSocket = () => {};
  antiban.setSocket = () => { installed++; };
  try {
    sessionManager.attachHandlers(session);
    session.sock.user = { id: '94750404115:1@s.whatsapp.net', name: 'Owner' };
    session.sock.ev.emit('connection.update', { connection: 'open' });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(installed, 1, 'the primary is the fallback socket');
  } finally {
    antiban.setSocket = realSet;
    require('../src/services/status/manager').setSocket = realStatus;
  }
});
