const test = require('node:test');
const assert = require('node:assert/strict');

/** Build a fake Baileys socket that captures event handlers. */
function fakeSock() {
  const handlers = {};
  return {
    ev: { on: (name, fn) => { (handlers[name] ||= []).push(fn); } },
    emit: (name, payload) => (handlers[name] || []).forEach((fn) => fn(payload)),
    user: { id: '947700000000:1@s.whatsapp.net', name: 'Test' },
  };
}

function msg(text, { ageSec = 0, id = 'ID' + Math.random().toString(36).slice(2), jid = '947811111111@s.whatsapp.net' } = {}) {
  return {
    key: { remoteJid: jid, id, fromMe: false },
    pushName: 'Tester',
    messageTimestamp: ageSec ? Math.floor((Date.now() - ageSec * 1000) / 1000) : Math.floor(Date.now() / 1000),
    message: { conversation: text },
  };
}

function buildSession() {
  const sessionManager = require('../src/whatsapp/sessionManager');
  const router = require('../src/router/router');
  const statusManager = require('../src/services/status/manager');
  const sock = fakeSock();
  const session = {
    id: 'primary', isPrimary: true, phone: '', sock,
    send: async (jid, content) => ({ key: { id: 'OUT' + Math.random() } }),
    sentIds: new Set(), seenIds: new Set(),
    messageCache: new Map(),
    // the backlog replay only happens right after a connect
    connectedAt: Date.now(),
  };
  const calls = { router: [], status: [] };
  const realRouterHandle = router.handle;
  const realStatus = statusManager.handleStatus;
  router.handle = async (...a) => { calls.router.push(a[1]); };
  statusManager.handleStatus = async (...a) => { calls.status.push(a[0]); };
  sessionManager.attachHandlers(session);
  return {
    session, calls, sock,
    restore: () => { router.handle = realRouterHandle; statusManager.handleStatus = realStatus; },
  };
}

test('messageAgeMs: numbers, Long-like objects, missing stamps', () => {
  const { messageAgeMs } = require('../src/utils/messages');
  const now = Date.now();
  assert.ok(Math.abs(messageAgeMs({ messageTimestamp: Math.floor(now / 1000) }, now)) < 1_500);
  assert.equal(messageAgeMs({ messageTimestamp: { toNumber: () => Math.floor((now - 60_000) / 1000) } }, now) > 55_000, true);
  assert.equal(messageAgeMs({}, now), 0, 'missing stamp → treated as fresh');
  assert.equal(messageAgeMs({ messageTimestamp: 0 }, now), 0);
});

test('upsert guard: stale backlog is never routed, fresh messages are', async () => {
  const t = buildSession();
  try {
    // offline-backlog replay: a command "sent" 2 hours ago
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [msg('.ping', { ageSec: 7200, id: 'OLD1' })] });
    assert.equal(t.calls.router.length, 0, 'stale command must NOT reach the router');

    // 2 minutes old, arriving on a socket that just opened → still a replay:
    // it existed before this connection did. (v1.2.2: this used to be routed
    // because the guard only looked at age, and only for the first minute.)
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [msg('.ping', { ageSec: 120, id: 'MID1' })] });
    assert.equal(t.calls.router.length, 0, 'a message from before the socket opened is backlog');

    // fresh live command → routed
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [msg('.ping', { id: 'NEW1' })] });
    assert.equal(t.calls.router.length, 1);

    // other upsert types (history sync 'append') are already filtered
    await t.sock.emit('messages.upsert', { type: 'append', messages: [msg('.ping', { id: 'APP1' })] });
    assert.equal(t.calls.router.length, 1, 'non-notify types untouched');
  } finally { t.restore(); }
});

test('a command from hours ago is never answered, however long the session has been up', async () => {
  const t = buildSession();
  try {
    // The session has been connected for ten minutes — the old code stopped
    // guarding after one, and answered this with a full menu. That is the bug
    // this test now pins shut.
    t.session.connectedAt = Date.now() - 10 * 60_000;
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [msg('.ping', { ageSec: 7200, id: 'LATE1' })] });
    assert.equal(t.calls.router.length, 0, 'an hours-old command is a replay, not a request');
    assert.equal(t.session.skipped.backlog >= 1, true, 'and it is counted as backlog');

    // A message that is a few minutes old but arrived while we were connected —
    // still inside STALE_COMMAND_SEC — is answered: that is a real, late user.
    t.session.connectedAt = Date.now() - 60 * 60_000;
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [msg('.ping', { ageSec: 120, id: 'LATE2' })] });
    assert.equal(t.calls.router.length, 1, 'a genuinely recent message still reaches the router');
  } finally { t.restore(); }
});

test('upsert guard: redelivered message ids are processed once only', async () => {
  const t = buildSession();
  try {
    const dup = msg('.ping', { id: 'DUP1' });
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [dup] });
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [dup] });
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [msg('.ping', { id: 'DUP1' })] });
    assert.equal(t.calls.router.length, 1, 'same id delivered 3× → routed once');
  } finally { t.restore(); }
});

test('upsert guard: old statuses skipped, fresh statuses handled', async () => {
  const t = buildSession();
  try {
    const oldStatus = msg('status text', { ageSec: 7200, id: 'ST1', jid: 'status@broadcast' });
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [oldStatus] });
    assert.equal(t.calls.status.length, 0, 'stale status must not be re-processed');
    const freshStatus = msg('status text', { id: 'ST2', jid: 'status@broadcast' });
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [freshStatus] });
    assert.equal(t.calls.status.length, 1, 'fresh status reaches the status manager');
  } finally { t.restore(); }
});

test('STALE_COMMAND_SEC env overrides the window', async () => {
  process.env.STALE_COMMAND_SEC = '60';
  delete require.cache[require.resolve('../src/whatsapp/sessionManager')];
  const t = buildSession();
  try {
    await t.sock.emit('messages.upsert', { type: 'notify', messages: [msg('.ping', { ageSec: 120, id: 'WIN1' })] });
    assert.equal(t.calls.router.length, 0, '2min-old msg is stale when window is 60s');
  } finally {
    t.restore();
    delete process.env.STALE_COMMAND_SEC;
    delete require.cache[require.resolve('../src/whatsapp/sessionManager')];
  }
});
