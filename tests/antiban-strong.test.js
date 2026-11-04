/**
 * Round 8: the anti-ban subsystem has to be BOTH stronger and faster.
 *
 * Stronger  — errors are classified (a missing ffmpeg binary is not a ban
 *             signal, a 403 is), risk decays with time, a real ban signal
 *             always cools the bot down and escalates, one loud chat cannot
 *             starve the others, menu probes have their own budget, and the
 *             whole protection state survives a restart.
 * Faster    — throughput adapts to health and account age, the typing
 *             indicator starts when the message ARRIVES so the pacing
 *             overlaps the command work, and the reply budget is capped.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const antiban = require('../src/services/antiban');
const { AntiBan } = antiban;
const { HealthMonitor, classifyError, classifyDisconnect, BAN_PAUSES_MS } = require('../src/services/antiban/health');
const { RateLimiter } = require('../src/services/antiban/rateLimiter');
const { PresenceHelper } = require('../src/services/antiban/presence');

const ROOT = path.join(__dirname, '..');
const CHAT = 'u@s.whatsapp.net';
const GROUP = '1234567890-123456@g.us';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sachi-ab-'));

/** A socket that only records presence updates. */
function presenceSock() {
  const seen = [];
  return { seen, sock: { sendPresenceUpdate: async (type, jid) => { seen.push({ type, jid }); } } };
}

/** An isolated antiban instance: no shared state, no writes to data/. */
function fresh(preset = 'moderate') {
  const ab = new AntiBan({ dataDir: tmpDir() });
  ab.setPreset(preset);
  const p = presenceSock();
  ab.setSocket(p.sock);
  ab.warmup.enabled = false;          // the warm-up cap is tested separately
  return { ab, presence: p };
}

/* ── 1. error classification ─────────────────────────────────────────── */

test('harmless content errors are classified benign', () => {
  for (const msg of [
    '404 media expired', 'ffmpeg not found — install it', 'sticker exceeds 15 MB',
    'yt-dlp exited with code 1', 'The URL could not be downloaded safely',
    'Give me a number', 'usage: .play <song>', 'no results found', 'webp convert failed',
  ]) {
    assert.equal(classifyError(new Error(msg)), 'benign', msg);
  }
});

test('real ban signals are classified as ban signals', () => {
  for (const msg of ['403 forbidden', '429 rate limited', 'not authorized', '401 unauthorized', 'account banned']) {
    assert.equal(classifyError(new Error(msg)), 'ban', msg);
  }
});

test('network hiccups are transient, not ban signals', () => {
  for (const msg of ['socket hang up', 'ETIMEDOUT', 'ECONNRESET', 'read ECONNRESET']) {
    assert.equal(classifyError(new Error(msg)), 'transient', msg);
  }
});

test('disconnect codes are classified too', () => {
  for (const code of [401, 403, 411, 419, 428, 440]) assert.equal(classifyDisconnect(code), 'ban', String(code));
  for (const code of [515, 408, 500, 502, 503, 504]) assert.equal(classifyDisconnect(code), 'benign', String(code));
  assert.equal(classifyDisconnect(999), 'transient');
});

test('six benign content errors never raise the risk and never pause the bot', () => {
  const { ab } = fresh();
  for (const msg of ['404 media expired', 'ffmpeg not found', 'sticker too big', 'yt-dlp failed', 'bad URL', 'Give me a number']) {
    ab.afterOutbound(CHAT, false, new Error(msg));
  }
  const s = ab.status();
  assert.equal(s.health.risk, 0, 'benign errors score nothing');
  assert.equal(s.health.classified.benign, 6, 'they are counted for diagnostics');
  assert.equal(s.rate.paused, false, 'the bot keeps sending');
  ab.stop();
});

test('three ordinary reconnects do not pause the bot', () => {
  const { ab } = fresh();
  for (const code of [515, 408, 515]) ab.noteDisconnect(code);
  const s = ab.status();
  assert.equal(s.rate.paused, false, 'restartRequired/timedOut is normal');
  assert.ok(s.health.risk < 30, 'the score stays low: ' + s.health.risk);
  ab.stop();
});

test('ONE real ban signal cools the bot down even at a low risk score', () => {
  const { ab } = fresh();
  assert.equal(ab.status().health.risk, 0);
  ab.afterOutbound(CHAT, false, new Error('403 forbidden'));
  const s = ab.status();
  assert.equal(s.health.banSignals, 1, 'the signal is remembered');
  assert.equal(s.rate.paused, true, 'the bot stops sending');
  assert.ok(s.rate.pausedRemainingMs <= BAN_PAUSES_MS[0] + 500, 'the first cool-off is ~30s');
  ab.stop();
});

test('ban signals escalate: 30s → 2min → 10min', () => {
  const h = new HealthMonitor({});
  const pauses = [];
  h.onBanSignal = (pause) => pauses.push(pause);
  h.noteSendFail(new Error('403 forbidden'));
  h.noteSendFail(new Error('429 rate limited'));
  h.noteSendFail(new Error('not authorized'));
  assert.deepEqual(pauses, BAN_PAUSES_MS, 'each signal cools down longer');
  assert.equal(h.coolOff().pauses, 3);
  assert.equal(h.coolOff().remembered, true, 'still angry');
});

test('the ban memory expires — an old signal does not escalate the next one', () => {
  const h = new HealthMonitor({});
  h.noteSendFail(new Error('403 forbidden'));
  h.lastSignalAt = Date.now() - 31 * 60_000;      // older than banMemoryMs
  assert.equal(h.coolOff().remembered, false, 'forgotten');
});

test('risk decays while the bot sits idle', () => {
  const h = new HealthMonitor({});
  for (let i = 0; i < 4; i++) h.noteSendFail(new Error('socket hang up'));
  const before = h.risk;
  assert.ok(before > 0);
  h.lastDecayAt = Date.now() - 10 * 60_000;        // 10 idle minutes
  const after = h.status().risk;
  assert.ok(after < before, `${before} → ${after}`);
  assert.ok(after <= Math.max(0, before - 30), 'a point per 15s of quiet');
});

/* ── 2. adaptive throughput: stronger AND faster ─────────────────────── */

test('a healthy, warm number gets MORE throughput than the preset', () => {
  const h = new HealthMonitor({});
  assert.ok(h.throughputFactor(1) > 1, 'low risk → faster than the preset');
  const { ab } = fresh('moderate');
  ab.warmup.enabled = false;
  ab.applyAdaptive();
  const s = ab.status();
  assert.ok(s.rate.limits.minute >= s.rate.base.maxPerMinute, `minute limit ${s.rate.limits.minute} vs base ${s.rate.base.maxPerMinute}`);
  ab.stop();
});

test('a number in trouble gets much LESS throughput', () => {
  const h = new HealthMonitor({});
  for (let i = 0; i < 25; i++) h.noteSendFail(new Error('socket hang up'));
  assert.ok(['high', 'critical'].includes(h.level()), 'the level escalated: ' + h.level());
  assert.ok(h.throughputFactor(1) < 0.6, 'throughput is throttled hard');
});

test('a brand-new account is held back, a week-old one is not', () => {
  const { ab } = fresh();
  ab.warmup.enabled = true;
  const stub = (day) => { ab.warmup.status = () => ({ accountDay: day, todayCount: 0, dailyCap: 100, fullyWarmed: day >= 7 }); };
  stub(0); const d0 = ab.warmupFactor();
  stub(3); const d3 = ab.warmupFactor();
  stub(9); const d9 = ab.warmupFactor();
  assert.ok(d0 < d3 && d3 < d9, `${d0} < ${d3} < ${d9}`);
  assert.equal(d9, 1, 'a warm account runs at full speed');
  ab.stop();
});

test('the turbo preset is faster than aggressive (and still limited)', () => {
  const { ab } = fresh('turbo');
  const turbo = ab.status().rate.base;
  ab.setPreset('aggressive');
  const aggr = ab.status().rate.base;
  assert.ok(turbo.maxPerMinute > aggr.maxPerMinute, `${turbo.maxPerMinute} > ${aggr.maxPerMinute}`);
  assert.ok(turbo.minDelayMs < aggr.minDelayMs, `shorter gaps: ${turbo.minDelayMs} < ${aggr.minDelayMs}`);
  assert.ok(turbo.maxPerDay <= 3000, 'still a hard daily ceiling');
  ab.stop();
});

/* ── 3. fairness: one loud chat cannot starve the others ─────────────── */

test('a private chat is not starved by a busy group', async () => {
  const { ab } = fresh('moderate');
  ab.applyAdaptive();          // warm-up off → the healthy factor applies
  // 8 group messages inside the last minute (recorded directly: the test
  // must not spend a minute of real pacing to prove the point).
  for (let i = 0; i < 8; i++) ab.limiter.record(GROUP);
  assert.ok(ab.limiter.status().minute < ab.limiter.status().limits.minute, 'the global minute cap is NOT the reason');
  const plan = ab.limiter.compute(GROUP, { text: 'again' });
  assert.equal(plan.blocked, true, 'the loud group is the one that waits');
  assert.equal(plan.reason, 'per_chat', 'because of the per-chat cap');

  const t = Date.now();
  const dm = await ab.beforeOutbound(CHAT, { text: 'hello' }, {});
  const waited = Date.now() - t;
  assert.ok(!dm.blocked, 'the DM went out');
  assert.ok(waited < 6000, `the DM waited only ${waited} ms`);
  ab.stop();
});

test('the limiter holds back a chat that floods the bot', () => {
  const lim = new RateLimiter({ maxPerMinute: 60, maxPerHour: 600, maxPerDay: 2000, minDelayMs: 10, maxDelayMs: 20 });
  lim.maxPerJidMinute = 3;
  for (let i = 0; i < 3; i++) lim.record(CHAT);
  const plan = lim.compute(CHAT, { text: 'again' });
  assert.equal(plan.blocked, true, 'the 4th message in the same minute is held');
  assert.equal(plan.reason, 'per_chat');
  const other = lim.compute('other@s.whatsapp.net', { text: 'hi' });
  assert.equal(other.blocked, false, 'a different chat is unaffected');
});

/* ── 4. menu probes have their own budget ───────────────────────────── */

test('menu probes never eat the rate budget', async () => {
  const { ab } = fresh();
  ab.reset();
  await ab.beforeOutbound(CHAT, { __interactive: true }, { probe: true });
  assert.equal(ab.status().rate.minute, 0, 'a probe is not a counted send');
  ab.stop();
});

test('the probe budget stops a storm of menu requests', async () => {
  const { ab } = fresh();
  const limit = ab.status().rate.probes.limit;
  let blocked = null;
  for (let i = 0; i < limit + 2; i++) {
    const r = await ab.beforeOutbound(CHAT, { __interactive: true }, { probe: true });
    if (r.probeBlocked) { blocked = r; break; }
  }
  assert.ok(blocked, 'the budget ran out and said so');
  assert.ok(blocked.retryMs > 0, 'it tells the caller when to retry: ' + blocked.retryMs);
  assert.equal(ab.status().rate.minute, 0, 'no rate budget was burned');
  ab.stop();
});

test('router: a spent card budget falls back to the image menu', async () => {
  const router = require('../src/router/router');
  const config = require('../src/config');
  const capabilities = require('../src/services/menu/capabilities');
  router.loadCommands();
  const jid = 'budget-' + Date.now() + '@s.whatsapp.net';
  if (capabilities.forget) capabilities.forget(jid);

  const spent = antiban.status().rate.probes.limit;
  for (let i = 0; i < spent + 1; i++) antiban.limiter.recordProbe();
  assert.equal(antiban.probeBudget().allowed, false, 'the budget is spent');

  const sent = [];
  const sock = {
    sendMessage: async (j, content, opts) => {
      const key = { id: 'BOT-' + (sent.length + 1) };
      sent.push({ key, content, opts });
      return opts && opts.trackDelivery ? { key, delivery: Promise.resolve('delivered') } : { key };
    },
    sendPresenceUpdate: async () => {},
  };
  // This is exactly what sessionManager.createSend() does for a card: gate it
  // through antiban.probeGate() and throw when the budget is gone.
  const send = async (j, content, opts) => {
    if (content && content.__interactive) {
      const gate = await antiban.probeGate(j, { text: content.typingText || '' }, { sock });
      if (gate) throw gate;
    }
    return sock.sendMessage(j, content, opts);
  };
  const msg = {
    key: { remoteJid: jid, id: 'IN1', fromMe: false },
    pushName: 'Tester', messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: '.menu' },
  };
  await router.handle(sock, msg, config, send);

  assert.ok(sent.length > 0, 'the user still got a menu');
  assert.equal(sent.some((s) => s.content && s.content.__interactive), false, 'no card was attempted');
  assert.equal(capabilities.preferredEnvelope(jid) !== 'failed', true, 'the envelopes were not blamed');

  antiban.limiter.probeStamps = [];      // give the budget back for other tests
});

/* ── 5. speed: the wait overlaps the work ───────────────────────────── */

test('the typing indicator starts on arrival, so a slow command pays nothing', async () => {
  const { ab, presence } = fresh('moderate');
  await ab.beforeOutbound(CHAT, { text: 'warm' }, {}); ab.afterOutbound(CHAT, true);   // known chat
  ab.onInbound(CHAT, {});
  assert.ok(presence.seen.some((p) => p.type === 'composing'), 'typing… goes up immediately');
  await sleep(900);                                          // the command does real work
  const t = Date.now();
  await ab.beforeOutbound(CHAT, { text: '🏓 Pong! 42 ms' }, {});
  const added = Date.now() - t;
  assert.ok(added < 250, `antiban added only ${added} ms on top of 900 ms of work`);
  ab.afterOutbound(CHAT, true);
  assert.equal(ab.presence.elapsed(CHAT), 0, 'the indicator is cleared after the send');
  ab.stop();
});

test('an instant command still shows the indicator for a human moment', async () => {
  const { ab } = fresh('moderate');
  await ab.beforeOutbound(CHAT, { text: 'warm' }, {}); ab.afterOutbound(CHAT, true);
  ab.onInbound(CHAT, {});
  await sleep(20);
  const t = Date.now();
  await ab.beforeOutbound(CHAT, { text: 'ok' }, {});
  const waited = Date.now() - t;
  assert.ok(waited >= 400, `a flash nobody sees: ${waited} ms`);
  assert.ok(waited <= 1200, `but it is capped: ${waited} ms`);
  ab.stop();
});

test('a reply nobody asked for does not leave "typing…" hanging', async () => {
  const { ab, presence } = fresh('moderate');
  ab.onInbound(CHAT, {});
  assert.equal(ab.presence.isTyping(CHAT), true, 'the indicator is up');
  const dropped = ab.finishInbound(CHAT, {});
  assert.equal(dropped, true, 'finishInbound reports that it cleared something');
  await sleep(30);
  assert.equal(presence.seen[presence.seen.length - 1].type, 'paused', 'typing… was taken back down');
  assert.equal(ab.finishInbound(CHAT, {}), false, 'nothing left to clear');
  ab.stop();
});

test('presence never blocks when it is disabled or the socket is missing', async () => {
  const p = new PresenceHelper({ enabled: false });
  assert.equal(await p.beforeSend(CHAT, { text: 'x' }, {}), 0);
  const q = new PresenceHelper({ enabled: true });            // no socket at all
  const t = Date.now();
  await q.beforeSend(CHAT, { text: 'x' }, {});
  assert.ok(Date.now() - t < 2000, 'it still paces, but it cannot hang');
});

/* ── 6. protection survives a restart ───────────────────────────────── */

test('risk, ban signals and rate history survive a restart', () => {
  const dir = tmpDir();
  const a = new AntiBan({ dataDir: dir });
  a.setPreset('moderate');
  a.afterOutbound(CHAT, false, new Error('403 forbidden'));
  for (let i = 0; i < 5; i++) a.limiter.record(CHAT);
  a.stop();                                     // what app.js does on shutdown

  const b = new AntiBan({ dataDir: dir });
  const s = b.status();
  assert.equal(s.restored, true, 'the state file was read back');
  assert.equal(s.health.banSignals, 1, 'the ban signal is remembered');
  assert.ok(s.health.risk > 0, 'the risk score survived: ' + s.health.risk);
  assert.equal(s.rate.minute, 5, 'the rate counters survived');
  assert.equal(s.rate.paused, true, 'the cool-off is still running');
  b.stop();
});

test('a crash-loop restart does not wipe the warm-up day counter', () => {
  const dir = tmpDir();
  const a = new AntiBan({ dataDir: dir });
  for (let i = 0; i < 7; i++) a.warmup.recordSend();
  a.warmup.flush();
  const b = new AntiBan({ dataDir: dir });
  assert.equal(b.warmup.status().todayCount, 7, 'today still counts');
  b.stop();
});

test('state older than an hour is ignored (no zombie pauses)', () => {
  const dir = tmpDir();
  const old = Date.now() - 2 * 3_600_000;
  fs.writeFileSync(path.join(dir, 'antiban-state.json'), JSON.stringify({
    v: 1,
    health: { risk: 90, banSignals: 3, savedAt: old, counts: { ban: 3 } },
    limiter: { timestamps: [old], pausedUntil: old + 600_000, savedAt: old },
  }));
  const ab = new AntiBan({ dataDir: dir });
  assert.equal(ab.status().health.risk, 0, 'a stale score is dropped');
  assert.equal(ab.status().rate.paused, false, 'an ancient pause does not mute the bot');
  ab.stop();
});

/* ── 7. housekeeping ────────────────────────────────────────────────── */

test('reset clears the score, the counters, the ban memory and the probe budget', async () => {
  const { ab } = fresh();
  ab.afterOutbound(CHAT, false, new Error('403 forbidden'));
  await ab.beforeOutbound(CHAT, { __interactive: true }, { probe: true });
  ab.limiter.noteOverrun();
  const s = ab.reset();
  assert.equal(s.health.risk, 0);
  assert.equal(s.health.banSignals, 0);
  assert.equal(s.health.coolOff.remembered, false);
  assert.equal(s.rate.minute, 0);
  assert.equal(s.rate.stats.overruns, 0);
  assert.equal(s.probes.budget.used, 0);
  assert.equal(s.rate.paused, false);
  ab.stop();
});

test('the status report exposes everything .antiban prints', () => {
  const { ab } = fresh();
  const s = ab.status();
  for (const key of ['adaptive', 'caps', 'probes', 'presence', 'restored']) assert.ok(key in s, key);
  assert.ok(s.adaptive.factor > 0 && s.adaptive.factor <= 1.5, 'factor: ' + s.adaptive.factor);
  assert.ok(s.caps.shortReplyMs <= s.caps.knownChatMs, 'short replies get the tighter cap');
  assert.ok(s.rate.perChat.limit > 0 && s.rate.perChat.minGapMs > 0, 'per-chat fairness is configured');
  assert.ok(s.health.coolOff && typeof s.health.coolOff.nextPauseMs === 'number', 'escalation state');
  ab.stop();
});

test('env caps are honoured (child process: the constants are read at load)', () => {
  const out = execFileSync(process.execPath, ['-e', `
    process.env.ANTIBAN_FAST_MAX_MS = '250';
    process.env.ANTIBAN_REPLY_MAX_MS = '400';
    process.env.ANTIBAN_MAX_BLOCK_MS = '3000';
    const ab = require('./src/services/antiban');
    const s = ab.status();
    console.log(JSON.stringify({ caps: s.caps, maxBlock: ab.MAX_BLOCK_WAIT_MS }));
    try { require('fs').unlinkSync(require('./src/config').paths.data + '/antiban-state.json'); } catch {}
  `], { cwd: ROOT, encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.caps.shortReplyMs, 250);
  assert.equal(r.caps.knownChatMs, 400);
  assert.equal(r.maxBlock, 3000);
});

test('the singleton still answers the old API (nothing downstream broke)', () => {
  for (const fn of ['beforeOutbound', 'afterOutbound', 'noteDisconnect', 'noteConnected', 'onInbound',
    'finishInbound', 'status', 'reset', 'setPreset', 'setEnabled', 'probeBudget', 'saveNow', 'stop']) {
    assert.equal(typeof antiban[fn], 'function', fn);
  }
});
