/**
 * Round 11 — WhatsApp replays old messages, and the bot must not answer them.
 *
 * The report: a phone with background data off opens WhatsApp, everything
 * syncs, and the bot answers commands from hours ago. The old guard only ran
 * for the first 60 s after the socket opened, so any replay that arrived later
 * walked straight into the router.
 *
 * `inboundDecision()` is the gate and these are its rules — including the ones
 * that must NOT block real traffic: a message from 5 seconds ago is a live
 * command even when the socket reconnected a moment earlier, and a message with
 * no timestamp is treated as new rather than silently dropped.
 */
const { test, after } = require('node:test');
const assert = require('node:assert');

const sessionManager = require('../src/whatsapp/sessionManager');

const now = Date.now();
const msg = (ageSec, over = {}) => ({
  key: { id: `id-${ageSec}-${Math.random().toString(16).slice(2, 8)}`, remoteJid: '94771234567@s.whatsapp.net', ...(over.key || {}) },
  message: { conversation: '.menu' },
  messageTimestamp: Math.floor((now - ageSec * 1000) / 1000),
  ...over,
});
const session = (connectedAgoSec, over = {}) => ({
  id: '94771234567', phone: '94771234567', isPrimary: false,
  connectedAt: now - connectedAgoSec * 1000,
  sentIds: new Set(), seenIds: new Set(),
  ...over,
});

after(() => {
  delete process.env.STALE_COMMAND_SEC;
  delete process.env.SYNC_GRACE_MS;
});

test('a live command is handled', () => {
  const s = session(3600);
  assert.equal(sessionManager.inboundDecision(msg(1), s).action, 'handle');
  assert.equal(sessionManager.inboundDecision(msg(60), s).action, 'handle');
});

test('a message older than STALE_COMMAND_SEC is ignored even hours after connecting', () => {
  const s = session(3 * 3600);                       // connected 3 hours ago
  assert.equal(sessionManager.inboundDecision(msg(10 * 60), s).action, 'stale');
  assert.equal(sessionManager.inboundDecision(msg(6 * 3600), s).action, 'backlog');
});

test('the exact bug: a backlog synced long after connect is dropped', () => {
  // The phone was offline overnight. The bot connected at 08:00 and stayed up;
  // the phone comes online at 14:00 and WhatsApp pushes yesterday's traffic.
  const connectedSixHoursAgo = session(6 * 3600);
  const yesterday = msg(20 * 3600);
  assert.equal(sessionManager.inboundDecision(yesterday, connectedSixHoursAgo).action, 'backlog');
  // …and it stays dropped even if it is replayed again a minute later.
  assert.notEqual(sessionManager.inboundDecision(yesterday, connectedSixHoursAgo).action, 'handle');
});

test('anything stamped before the socket opened is backlog, whatever its age', () => {
  const justConnected = session(2);                  // socket opened 2 s ago
  assert.equal(sessionManager.inboundDecision(msg(30), justConnected).action, 'backlog');
  assert.equal(sessionManager.inboundDecision(msg(600), justConnected).action, 'backlog');
  // …but a genuinely new message that lands right after the handshake is served
  assert.equal(sessionManager.inboundDecision(msg(0), justConnected).action, 'handle');
});

test('clock skew does not make fresh messages look like backlog', () => {
  process.env.SYNC_GRACE_MS = '10000';
  const justConnected = session(1);                  // open one second ago
  // sender's clock is 5 s behind ours: the message looks 5 s old
  assert.equal(sessionManager.inboundDecision(msg(5), justConnected).action, 'handle');
  delete process.env.SYNC_GRACE_MS;
});

test('STALE_COMMAND_SEC is honoured', () => {
  process.env.STALE_COMMAND_SEC = '30';
  const s = session(3600);
  assert.equal(sessionManager.inboundDecision(msg(20), s).action, 'handle');
  assert.equal(sessionManager.inboundDecision(msg(45), s).action, 'stale');
});

test('the same message id is only ever handled once — across sessions too', () => {
  const first = session(3600);
  const m = msg(1);
  assert.equal(sessionManager.inboundDecision(m, first).action, 'handle');
  sessionManager.rememberSeen(first, m.key.id);
  assert.equal(sessionManager.inboundDecision(m, first).action, 'duplicate');

  // a reconnect builds a NEW session object with an empty seenIds — the
  // process-wide cache is what keeps the replay out
  const reconnected = session(0);
  assert.equal(sessionManager.inboundDecision(m, reconnected).action, 'duplicate');
});

test('a message this session sent itself never reaches the router', () => {
  const s = session(60);
  const m = msg(1);
  s.sentIds.add(m.key.id);
  assert.equal(sessionManager.inboundDecision(m, s).action, 'own');
});

test('status updates obey the same rules (no reacting to yesterday\'s status)', () => {
  const s = session(3600);
  const status = (ageSec) => ({
    key: { id: `status-${ageSec}-${Math.random().toString(16).slice(2, 8)}`, remoteJid: 'status@broadcast' },
    message: { conversation: 'status text' },
    messageTimestamp: Math.floor((now - ageSec * 1000) / 1000),
  });
  assert.equal(sessionManager.inboundDecision(status(5), s).action, 'status');
  assert.equal(sessionManager.inboundDecision(status(20 * 3600), s).action, 'backlog');
  assert.equal(sessionManager.inboundDecision(status(15 * 60), s).action, 'stale');
});

test('a message with no timestamp is treated as new, never as a replay', () => {
  const s = session(3600);
  const m = msg(1);
  delete m.messageTimestamp;
  assert.equal(sessionManager.inboundDecision(m, s).action, 'handle');
});

test('a socket that has not connected yet does not turn everything into backlog', () => {
  const notYet = session(0, { connectedAt: 0 });
  assert.equal(sessionManager.inboundDecision(msg(1), notYet).action, 'handle');
  assert.equal(sessionManager.inboundDecision(msg(600), notYet).action, 'stale');
});

test('end to end: the upsert handler never passes a replay to the router', async (t) => {
  const router = require('../src/router/router');
  const realHandle = router.handle;
  const seen = [];
  router.handle = async (_sock, m) => { seen.push(m.key.id); };
  t.after(() => { router.handle = realHandle; });

  const { EventEmitter } = require('node:events');
  const sock = { ev: new EventEmitter(), user: { id: '94771234567@s.whatsapp.net' }, end() {}, sendMessage: async () => ({ key: { id: 'x' } }) };
  const s = {
    id: 'backlog-e2e', phone: '94771234567', isPrimary: false, sock,
    connected: true, connectedAt: now - 6 * 3600_000, jid: '94771234567@s.whatsapp.net',
    sentIds: new Set(), seenIds: new Set(), ackWaiters: new Map(), messageCache: new Map(),
    skipped: { backlog: 0, stale: 0, duplicate: 0 }, send: async () => ({ key: { id: 'x' } }),
  };
  sessionManager.attachHandlers(s);

  // the overnight backlog, pushed when the phone finally comes online
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [msg(20 * 3600), msg(9 * 3600)] });
  // a history-sync batch, which is not 'notify' at all
  sock.ev.emit('messages.upsert', { type: 'append', messages: [msg(30 * 3600)] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, [], 'no replay may reach the router');
  assert.equal(s.skipped.backlog, 3, 'all three are counted as backlog');

  // and a real command still works
  const live = msg(0);
  sock.ev.emit('messages.upsert', { type: 'notify', messages: [live] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, [live.key.id], 'a live message still reaches the router');
});

test('the skip counters are reported per session', () => {
  const list = sessionManager.listSessions();
  assert.ok(Array.isArray(list));
  for (const s of list) {
    assert.ok(s.skipped, 'every session reports how much it ignored');
    for (const k of ['backlog', 'stale', 'duplicate']) assert.equal(typeof s.skipped[k], 'number');
  }
});
