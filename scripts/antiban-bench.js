/**
 * Anti-ban benchmark — measures what the protection layer actually COSTS
 * (latency, throughput) and how well it DETECTS trouble (risk scoring).
 *
 *   node scripts/antiban-bench.js
 *
 * Every scenario runs against a fresh AntiBan instance with a fake socket,
 * so the numbers are the pure cost of the layer — no network involved.
 */
process.env.ANTIBAN_ENABLED = 'true';

const path = require('path');
const fs = require('fs');
const os = require('os');
const antibanModule = require('../src/services/antiban');
const { AntiBan, PRESETS } = antibanModule;

const CHAT_A = '94770000001@s.whatsapp.net';
const CHAT_B = '94770000002@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

function fakeSock() {
  return { sendPresenceUpdate: async () => {}, ws: { readyState: 1 } };
}
function tmpData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-bench-'));
  return dir;
}
function newAb(preset = 'moderate', dir = tmpData()) {
  const ab = new AntiBan({ dataDir: dir });
  ab.setPreset(preset);
  ab.warmup = new (require('../src/services/antiban/warmup').WarmUp)(dir, { enabled: false });
  ab.setSocket(fakeSock());
  return ab;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortText = { text: '🏓 Pong! 42 ms' };
const longText = { text: 'x'.repeat(1200) };
const media = { image: Buffer.from('x'), caption: 'here you go' };

function pct(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const rows = [];
function row(area, metric, value, note = '') { rows.push({ area, metric, value, note }); }

async function time(fn) { const t = Date.now(); await fn(); return Date.now() - t; }

(async () => {
  console.log('\n═══ 1. latency the layer adds to ONE reply ═══');
  for (const preset of ['conservative', 'moderate', 'aggressive']) {
    const samples = { short: [], long: [], media: [], edit: [], newChat: [] };
    for (let i = 0; i < 12; i++) {
      const ab = newAb(preset);
      // warm the chat so it counts as "known"
      await ab.beforeOutbound(CHAT_A, shortText, { sock: fakeSock() });
      ab.afterOutbound(CHAT_A, true);
      const measure = async (jid, content, opts = {}) => {
        const t = await time(() => ab.beforeOutbound(jid, content, { sock: fakeSock(), ...opts }));
        ab.afterOutbound(jid, true, null, opts);   // a real send clears the indicator
        return t;
      };
      samples.short.push(await measure(CHAT_A, shortText));
      samples.long.push(await measure(CHAT_A, longText));
      samples.media.push(await measure(CHAT_A, media));
      samples.edit.push(await measure(CHAT_A, shortText, { isEdit: true }));
      samples.newChat.push(await measure('9477999999' + i + '@s.whatsapp.net', shortText));
      ab.stop();
    }
    for (const [k, v] of Object.entries(samples)) {
      row(`latency · ${preset}`, k, `${pct(v, 50)} ms (p95 ${pct(v, 95)})`);
    }
    console.log(`  ${preset.padEnd(13)} short p50=${pct(samples.short, 50)}ms  long p50=${pct(samples.long, 50)}ms  media p50=${pct(samples.media, 50)}ms  edit p50=${pct(samples.edit, 50)}ms  new-chat p50=${pct(samples.newChat, 50)}ms`);
  }

  console.log('\n═══ 1b. end-to-end: message arrives → reply is sent ═══');
  for (const work of [[5, 'instant command (.ping)'], [400, 'slow command (ai/download)'], [1200, 'very slow command']]) {
    const [workMs, label] = work;
    const totals = []; const added = [];
    for (let i = 0; i < 8; i++) {
      const ab = newAb('moderate');
      const s = fakeSock();
      await ab.beforeOutbound(CHAT_A, shortText, { sock: s });   // warm the chat
      ab.afterOutbound(CHAT_A, true);
      const t0 = Date.now();
      ab.onInbound(CHAT_A, { sock: s });                          // typing starts NOW
      await sleep(workMs);                                        // the command works
      const extra = await time(() => ab.beforeOutbound(CHAT_A, shortText, { sock: s }));
      ab.afterOutbound(CHAT_A, true);
      totals.push(Date.now() - t0); added.push(extra);
      ab.stop();
    }
    row(`end-to-end · moderate`, `${label}`, `${pct(totals, 50)} ms total`, `antiban added ${pct(added, 50)} ms on top of ${workMs} ms of work`);
    console.log(`  ${label.padEnd(28)} user waits ${pct(totals, 50)} ms (work ${workMs} + antiban ${pct(added, 50)})`);
  }

  console.log('\n═══ 2. throughput: how long a burst takes ═══');
  {
    const ab = newAb('moderate');
    const s = fakeSock();
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
      await ab.beforeOutbound(i % 2 ? CHAT_A : CHAT_B, shortText, { sock: s });
      ab.afterOutbound(i % 2 ? CHAT_A : CHAT_B, true);
    }
    const total = Date.now() - t0;
    row('throughput', '20 replies / 2 chats', `${(total / 1000).toFixed(1)} s`, `${(total / 20).toFixed(0)} ms each`);
    console.log(`  20 replies across 2 chats: ${(total / 1000).toFixed(1)}s total (${(total / 20).toFixed(0)} ms per reply)`);
    console.log(`  rate stats: ${JSON.stringify(ab.limiter.status().stats)} · minute=${ab.limiter.status().minute}/${ab.limiter.status().limits.minute}`);
    ab.stop();
  }
  {
    // one busy group must not starve a private chat
    const ab = newAb('moderate');
    const s = fakeSock();
    for (let i = 0; i < 14; i++) { await ab.beforeOutbound(GROUP, shortText, { sock: s }); ab.afterOutbound(GROUP, true); }
    const dmWait = await time(() => ab.beforeOutbound(CHAT_A, shortText, { sock: s }));
    ab.afterOutbound(CHAT_A, true);
    row('fairness', 'DM after a 14-message group burst', `${dmWait} ms`, dmWait > 5000 ? 'the group starved the DM' : 'ok');
    console.log(`  after a 14-message group burst, a private reply waited ${dmWait} ms`);
    ab.stop();
  }
  {
    // menu ladder cost: 6 envelope probes for ONE .menu request
    const ab = newAb('moderate');
    const s = fakeSock();
    let allowed = 0; let held = 0;
    const t = await time(async () => {
      for (let i = 0; i < 6; i++) {
        const r = await ab.beforeOutbound(CHAT_A, { __interactive: true, typingText: 'Menu' }, { probe: true, sock: s });
        if (r.probeBlocked) { held++; continue; }
        allowed++;
        ab.afterOutbound(CHAT_A, i === 5, null, { probe: true });
      }
    });
    row('probes', 'one 6-envelope menu ladder', `${t} ms`, `${allowed} sent · ${held} held by the budget`);
    console.log(`  one .menu request = 6 envelope probes in ${t} ms (${allowed} sent, ${held} held back)`);
    let allowed2 = 0; let held2 = 0;
    const t2 = await time(async () => {
      for (let m = 0; m < 5; m++) for (let i = 0; i < 6; i++) {
        const r = await ab.beforeOutbound(CHAT_A, { __interactive: true }, { probe: true, sock: s });
        if (r.probeBlocked) { held2++; continue; }
        allowed2++;
        ab.afterOutbound(CHAT_A, i === 5, null, { probe: true });
      }
    });
    row('probes', '5 menu requests back to back', `${t2} ms`, `${allowed2 + allowed} cards out, ${held2} held`);
    console.log(`  5 more menu requests = ${allowed2} cards actually sent, ${held2} held back by the ${(ab.limiter.status().probes.limit)}-per-${Math.round(ab.limiter.status().probes.windowMs / 1000)}s budget — ${ab.limiter.status().minute} counted against the rate limit`);
    ab.stop();
  }

  console.log('\n═══ 3. risk scoring: does it punish the right things? ═══');
  {
    const benign = [
      ['media expired (404)', new Error('404 media expired')],
      ['ffmpeg missing', new Error('ffmpeg not found — install it to make stickers')],
      ['sticker too big', new Error('sticker exceeds 15 MB')],
      ['yt-dlp failed', new Error('yt-dlp exited with code 1')],
      ['bad URL', new Error('The URL could not be downloaded safely')],
      ['validation', new Error('Give me a number')],
    ];
    const ab = newAb();
    for (const [, err] of benign) ab.afterOutbound(CHAT_A, false, err);
    const st = ab.status();
    row('risk · benign errors', '6 content errors (media/ffmpeg/validation)', `risk ${st.health.risk} → ${st.health.level}`,
      st.rate.paused ? `PAUSED ${Math.round(st.rate.pausedRemainingMs / 1000)}s` : 'no pause');
    console.log(`  6 harmless content errors → risk=${st.health.risk} (${st.health.level}) paused=${st.rate.paused}`);
    ab.stop();
  }
  {
    const ab = newAb();
    for (const code of [515, 408, 515]) ab.noteDisconnect(code);
    const st = ab.status();
    row('risk · reconnects', '3 normal reconnects (515/408)', `risk ${st.health.risk} → ${st.health.level}`,
      st.rate.paused ? `PAUSED ${Math.round(st.rate.pausedRemainingMs / 1000)}s` : 'no pause');
    console.log(`  3 ordinary reconnects (restartRequired/timedOut) → risk=${st.health.risk} (${st.health.level}) paused=${st.rate.paused}`);
    ab.stop();
  }
  {
    const ab = newAb();
    for (const err of [new Error('403 forbidden'), new Error('429 rate limited'), new Error('not authorized')]) {
      ab.afterOutbound(CHAT_A, false, err);
    }
    const st = ab.status();
    row('risk · real signals', '3 ban signals (403/429/not authorized)', `risk ${st.health.risk} → ${st.health.level}`,
      st.rate.paused ? `PAUSED ${Math.round(st.rate.pausedRemainingMs / 1000)}s` : 'no pause');
    console.log(`  3 real ban signals → risk=${st.health.risk} (${st.health.level}) paused=${st.rate.paused} (${Math.round(st.rate.pausedRemainingMs / 1000)}s)`);
    ab.stop();
  }
  {
    // does risk decay while the bot sits idle?
    const ab = newAb();
    ab.afterOutbound(CHAT_A, false, new Error('403 forbidden'));
    ab.afterOutbound(CHAT_A, false, new Error('403 forbidden'));
    const before = ab.status().health.risk;
    ab.health.lastDecayAt = Date.now() - 10 * 60_000;  // simulate 10 idle minutes
    const after = ab.status().health.risk;
    row('risk · decay', 'risk after 10 idle minutes', `${before} → ${after}`, after === before ? 'no time-based decay' : 'decays');
    console.log(`  risk after 10 idle minutes: ${before} → ${after}`);
    ab.stop();
  }

  console.log('\n═══ 4. does protection survive a restart? ═══');
  {
    const dir = tmpData();
    const ab = newAb('moderate', dir);
    const s = fakeSock();
    ab.afterOutbound(CHAT_A, false, new Error('403 forbidden'));   // a real ban signal
    for (let i = 0; i < 10; i++) { await ab.beforeOutbound(CHAT_A, shortText, { sock: s }); ab.afterOutbound(CHAT_A, true); }
    const beforeRestart = ab.limiter.status().minute;
    const beforeRisk = ab.status().health.risk;
    ab.stop();                                                     // flush, like a clean shutdown
    const fresh = newAb('moderate', dir);
    row('restart', 'rate history after a restart', `${beforeRestart} → ${fresh.limiter.status().minute} in the last minute`,
      fresh.limiter.status().minute === 0 ? 'a restart wipes the limits' : 'kept');
    row('restart', 'risk score after a restart', `${beforeRisk} → ${fresh.status().health.risk}`,
      fresh.status().restored ? 'state file restored' : 'wiped');
    console.log(`  10 sends + 1 ban signal, then a restart: minute ${beforeRestart} → ${fresh.limiter.status().minute}, risk ${beforeRisk} → ${fresh.status().health.risk} (restored=${fresh.status().restored})`);
    ab.stop(); fresh.stop();
  }

  console.log('\n═══ 5. hidden costs on the hot path ═══');
  {
    const { WarmUp } = require('../src/services/antiban/warmup');
    const dir = tmpData();
    const wu = new WarmUp(dir, { enabled: true });
    const t = await time(() => { for (let i = 0; i < 50; i++) wu.recordSend(); });
    row('disk I/O', 'warm-up bookkeeping for 50 sends', `${t} ms`, `${(t / 50).toFixed(2)} ms per message (debounced write)`);
    console.log(`  warm-up recordSend() × 50 = ${t} ms (${(t / 50).toFixed(2)} ms of disk I/O per message)`);
    const caps = require('../src/services/menu/capabilities');
    const t2 = await time(() => { for (let i = 0; i < 50; i++) caps.remember(CHAT_A, { envelope: 'native-media' }); });
    row('disk I/O', 'menu capability writes × 50', `${t2} ms`, `${(t2 / 50).toFixed(2)} ms per menu interaction`);
    console.log(`  capabilities.remember() × 50 = ${t2} ms (${(t2 / 50).toFixed(2)} ms of SYNC disk I/O each)`);
  }

  console.log('\n═══ table ═══');
  console.log('area'.padEnd(24) + 'metric'.padEnd(46) + 'value'.padEnd(26) + 'note');
  for (const r of rows) console.log(String(r.area).padEnd(24) + String(r.metric).padEnd(46) + String(r.value).padEnd(26) + r.note);
})().catch((e) => { console.error('BENCH CRASH:', e && e.stack || e); process.exit(2); });
