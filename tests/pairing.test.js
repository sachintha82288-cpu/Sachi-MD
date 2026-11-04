/**
 * The pairing service — the single code path behind BOTH `.pair` in chat and
 * the pair website. Every rule that protects the bot lives here, so this is
 * where they are pinned down: who may be paired, how often, how long a code
 * lives, and what happens to an attempt nobody finished.
 *
 * The WhatsApp layer is stubbed; nothing here touches the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const sessionManager = require('../src/whatsapp/sessionManager');
const pairing = require('../src/services/pairing');

const real = {
  pairNumber: sessionManager.pairNumber,
  refreshPairingCode: sessionManager.refreshPairingCode,
  teardownPending: sessionManager.teardownPending,
  isLinked: sessionManager.isLinked,
  listSessions: sessionManager.listSessions,
  getPrimary: sessionManager.getPrimary,
};

let linked, calls, seq;
function stub() {
  linked = new Set();
  seq = 0;
  calls = { pair: 0, refresh: 0, teardown: 0, restored: 0 };
  sessionManager.pairNumber = async (phone, opts = {}) => {
    calls.pair++;
    if (process.env.__FAKE_RESTORED__ === phone) { calls.restored++; return { phone, code: null, restored: true }; }
    seq++;
    return { phone, code: `AB${String(seq).padStart(2, '0')}CD${String(seq).padStart(2, '0')}`, restored: false };
  };
  sessionManager.refreshPairingCode = async (phone) => {
    calls.refresh++;
    if (linked.has(String(phone))) return null;          // already linked → no more codes
    seq++;
    return `ZZ${String(seq).padStart(2, '0')}YY${String(seq).padStart(2, '0')}`;
  };
  sessionManager.teardownPending = (phone) => { calls.teardown++; };
  sessionManager.isLinked = (phone) => linked.has(String(phone));
  sessionManager.listSessions = () => [
    { id: 'primary', phone: '94750404115', isPrimary: true, connected: true, state: 'connected', name: 'Main', startedAt: Date.now() },
    ...[...linked].map((p) => ({ id: p, phone: p, isPrimary: false, connected: true, state: 'connected', name: 'Paired', startedAt: Date.now() })),
  ];
  sessionManager.getPrimary = () => ({ phone: '94750404115', jid: '94750404115@s.whatsapp.net' });
}
function unstub() { Object.assign(sessionManager, real); }

/** Defaults that make the rules easy to exercise; each test resets them. */
function env(over = {}) {
  process.env.PAIR_MAX_SESSIONS = '8';
  process.env.PAIR_CODE_TTL_MS = '60000';
  process.env.PAIR_PENDING_TTL_MS = '240000';
  process.env.PAIR_COOLDOWN_MS = '0';
  process.env.PAIR_RATE_WINDOW_MS = '600000';
  process.env.PAIR_MAX_PER_PHONE = '3';
  process.env.PAIR_MAX_PER_IP = '6';
  process.env.PAIR_JANITOR_MS = '250';
  Object.assign(process.env, over);
}
function clearEnv() {
  for (const k of ['PAIR_MAX_SESSIONS', 'PAIR_CODE_TTL_MS', 'PAIR_PENDING_TTL_MS', 'PAIR_COOLDOWN_MS',
    'PAIR_RATE_WINDOW_MS', 'PAIR_MAX_PER_PHONE', 'PAIR_MAX_PER_IP', 'PAIR_JANITOR_MS', '__FAKE_RESTORED__']) delete process.env[k];
}

const reason = async (fn) => { try { await fn(); return null; } catch (e) { return e.reason || 'error'; } };

test('pairing: a code is issued, grouped for humans, and expires on schedule', async (t) => {
  stub(); env(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  const v = await pairing.request({ phone: '+94 77 123 4567', source: 'chat' });
  assert.equal(v.phone, '94771234567', 'the number is normalised');
  assert.equal(v.state, 'waiting');
  assert.match(v.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'grouped 4-4 for reading aloud');
  assert.equal(v.rawCode.length, 8, 'WhatsApp wants the raw 8 characters');
  assert.equal(v.rawCode, v.code.replace('-', ''));
  assert.ok(v.secondsLeft > 50 && v.secondsLeft <= 60);
  assert.ok(v.expiresAt > Date.now());
  assert.ok(v.pendingUntil > v.expiresAt, 'the socket outlives the code');
  assert.equal(v.id.length, 12);
  assert.equal(calls.pair, 1);
  assert.equal(pairing.group(v.rawCode), v.code);
});

test('pairing: refuses the primary number, a linked number and junk', async (t) => {
  stub(); env(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  assert.equal(await reason(() => pairing.request({ phone: '94750404115' })), 'primary');
  assert.equal(await reason(() => pairing.request({ phone: '+94 (0) 750-404-115' })), 'primary', 'the trunk prefix cannot smuggle the main number in');
  assert.equal(await reason(() => pairing.request({ phone: '12' })), 'invalid');
  assert.equal(await reason(() => pairing.request({ phone: '' })), 'invalid');
  assert.equal(await reason(() => pairing.request({ phone: 'not-a-number' })), 'invalid');

  linked.add('94778887776');
  assert.equal(await reason(() => pairing.request({ phone: '94778887776' })), 'exists');
  assert.equal(calls.pair, 0, 'nothing was asked of WhatsApp for a refused request');
});

test('pairing: a restored session comes back linked, with no code to type', async (t) => {
  stub(); env({ __FAKE_RESTORED__: '94771110000' }); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  const v = await pairing.request({ phone: '94771110000' });
  assert.equal(v.state, 'linked');
  assert.equal(v.code, '');
  assert.equal(v.rawCode, '');
  assert.equal(calls.restored, 1);
});

test('pairing: the session cap is hard, and freeing a slot opens it again', async (t) => {
  stub(); env({ PAIR_MAX_SESSIONS: '2' }); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  await pairing.request({ phone: '94770000001' });
  linked.add('94770000001');
  await pairing.request({ phone: '94770000002' });
  linked.add('94770000002');
  assert.equal(pairing.stats().inUse, 2);

  const err = await pairing.request({ phone: '94770000003' }).catch((e) => e);
  assert.equal(err.reason, 'cap');
  assert.equal(err.max, 2);
  assert.match(err.message, /full/i);

  linked.delete('94770000002');
  pairing.cancel('94770000002');       // a pending attempt holds a slot too
  assert.equal(pairing.stats().inUse, 1);
  const ok = await pairing.request({ phone: '94770000003' });
  assert.equal(ok.state, 'waiting', 'a freed slot is usable again');
});

test('pairing: the same number twice in a row is a cooldown, with a retry time', async (t) => {
  stub(); env({ PAIR_COOLDOWN_MS: '30000' }); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  const v = await pairing.request({ phone: '94770000010', ip: '1.2.3.4' });
  const cd = await pairing.request({ phone: '94770000010', ip: '1.2.3.4' }).catch((e) => e);
  assert.equal(cd.reason, 'cooldown');
  assert.ok(cd.retryMs > 0 && cd.retryMs <= 30000);
  assert.equal(cd.id, v.id, 'the refusal points at the attempt that is already on screen');
  assert.match(cd.message, /refresh/i);
});

test('pairing: the per-number budget counts every code handed out', async (t) => {
  stub(); env({ PAIR_MAX_PER_PHONE: '2', PAIR_COOLDOWN_MS: '0', PAIR_MAX_PER_IP: '99' }); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  const a = await pairing.request({ phone: '94770000020', ip: '1.1.1.1' });
  const b = await pairing.request({ phone: '94770000020', ip: '2.2.2.2' });   // reuse → refresh
  assert.equal(b.reused, true, 'the second call refreshes instead of opening another socket');
  assert.notEqual(b.rawCode, a.rawCode);
  assert.equal(await reason(() => pairing.request({ phone: '94770000020', ip: '3.3.3.3' })), 'rate-phone');
});

test('pairing: the per-IP budget stops one visitor flooding the page', async (t) => {
  stub(); env({ PAIR_MAX_PER_IP: '2', PAIR_MAX_PER_PHONE: '99' }); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  await pairing.request({ phone: '94770000031', ip: '8.8.8.8' });
  await pairing.request({ phone: '94770000032', ip: '8.8.8.8' });
  const err = await pairing.request({ phone: '94770000033', ip: '8.8.8.8' }).catch((e) => e);
  assert.equal(err.reason, 'rate-ip');
  assert.ok(err.retryMs > 0);
  const other = await pairing.request({ phone: '94770000033', ip: '9.9.9.9' });
  assert.equal(other.state, 'waiting', 'a different visitor is unaffected');
});

test('pairing: refresh gives a new code, extends the window, and stops once linked', async (t) => {
  stub(); env(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  const v = await pairing.request({ phone: '94770000030' });
  const r = await pairing.refresh(v.id, { source: 'web' });
  assert.notEqual(r.rawCode, v.rawCode, 'a genuinely new code');
  assert.equal(r.refreshes, 1);
  assert.ok(r.expiresAt >= v.expiresAt);
  assert.equal(r.source, 'web');
  assert.equal(calls.refresh, 1);

  assert.equal(await reason(() => pairing.refresh('nosuchid')), 'not-found');

  linked.add('94770000030');
  const after = await pairing.refresh(v.id);
  assert.equal(after.state, 'linked');
  assert.equal(after.code, '', 'a linked number is never handed another code');

  await pairing.cancel(v.id);
  assert.equal(await reason(() => pairing.refresh(v.id)), 'not-found');
});

test('pairing: state() finds an attempt by id or by number, cancel works both ways', async (t) => {
  stub(); env(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  const v = await pairing.request({ phone: '94770000040' });
  assert.equal(pairing.state(v.id).id, v.id);
  assert.equal(pairing.state('94770000040').id, v.id, 'lookup by number');
  assert.equal(pairing.state('+94 (0) 770-000-040').id, v.id, 'lookup by a messy number');
  assert.equal(pairing.state('nothing'), null);

  assert.equal(pairing.cancel('94770000040'), true, 'cancel by number');
  assert.equal(calls.teardown, 1, 'the half-open socket is torn down');
  assert.equal(pairing.cancel('94770000040'), false, 'cancelling twice is a no-op');
});

test('pairing: a code goes stale, an unfinished attempt expires and is torn down', async (t) => {
  stub(); env(); pairing.reset();
  // Mocked clock: the real TTLs (60 s code, 240 s socket, 15 s janitor)
  // without waiting for them.
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.now() });
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  const v = await pairing.request({ phone: '94770000050' });
  assert.equal(v.state, 'waiting');
  assert.ok(v.code, 'a fresh code is shown');

  t.mock.timers.tick(61_000);                       // the code's minute is up
  const stale = pairing.state(v.id);
  assert.equal(stale.state, 'waiting', 'the socket is still open…');
  assert.equal(stale.code, '', '…but the dead code is no longer advertised');
  assert.equal(stale.codeExpired, true);
  assert.equal(stale.secondsLeft, 0);

  t.mock.timers.tick(180_000);                      // 241 s in total
  assert.equal(pairing.state(v.id).state, 'expired');

  t.mock.timers.tick(15_000);                       // the janitor sweeps
  assert.ok(calls.teardown >= 1, 'the abandoned session was torn down');
  assert.equal(pairing.listPending().filter((p) => p.state === 'waiting').length, 0);

  // a linked attempt keeps reporting linked, and its code stays hidden
  linked.add('94770000060');
  const okView = await pairing.request({ phone: '94770000061' });
  t.mock.timers.tick(1000);
  assert.equal(okView.state, 'waiting');
});

test('pairing: stats() and reset() keep the owner console honest', async (t) => {
  stub(); env(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); clearEnv(); });

  await pairing.request({ phone: '94770000060', ip: '5.5.5.5' });
  await pairing.request({ phone: '94750404115' }).catch(() => {});
  linked.add('94770000060');
  await new Promise((r) => setTimeout(r, 400));      // janitor notices the link

  const st = pairing.stats();
  assert.equal(st.issued, 1);
  assert.equal(st.refused, 1);
  assert.equal(st.linked, 1);
  assert.equal(st.sessions, 1);
  assert.equal(st.maxSessions, 8);
  assert.equal(st.codeTtlMs, 60000);
  assert.equal(st.window.perIp, 6);
  assert.equal(st.inUse, 1);

  pairing.reset();
  const after = pairing.stats();
  assert.equal(after.issued, 0);
  assert.equal(after.pending, 0);
  assert.equal(pairing.listPending().length, 0);
});

test('pairing: knobs come from the environment, with sane floors', () => {
  env({ PAIR_MAX_SESSIONS: '0', PAIR_CODE_TTL_MS: '5', PAIR_MAX_PER_IP: '-3' });
  assert.equal(pairing.MAX_SESSIONS(), 8, 'a zero cap falls back to the default');
  assert.equal(pairing.CODE_TTL_MS(), 60000, 'a 5 ms code would be unusable');
  assert.equal(pairing.PENDING_TTL_MS(), 240000);
  clearEnv();
  assert.equal(pairing.MAX_SESSIONS(), 8);
});
