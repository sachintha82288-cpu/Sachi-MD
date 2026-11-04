/**
 * Bug hunt — throws hostile input at the two features that were just
 * unlocked (.tagall and the status downloader) and reports every crash,
 * every silent no-op and every nonsensical result.
 *
 *   node scripts/bug-hunt.js
 *
 * Unlike the audit (one happy-ish call per command) this one fuzzes the
 * argument space, the participant lists and the status message shapes.
 */
process.env.REACTIONS_ENABLED = 'false';
process.env.ANTIBAN_ENABLED = 'false';
process.env.STATUS_FRESH_WAIT_MS = '120';
process.env.TAGALL_CHUNK = '10';

const { Readable } = require('stream');
const router = require('../src/router/router');
const config = require('../src/config');
const settings = require('../src/services/settings');
const statusManager = require('../src/services/status/manager');

statusManager.setDownloader(async () => Readable.from([Buffer.from('fake-media')]));
router.loadCommands();

const OWNER = '94700000001@s.whatsapp.net';
const MEMBER = '94700000009@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';
const DM = '94771234567@s.whatsapp.net';
config.owner = OWNER;

const problems = [];
function note(where, what, detail = '') {
  problems.push({ where, what, detail });
  console.log(`🐞 ${where} — ${what}${detail ? ` (${detail})` : ''}`);
}

function sock(sink, opts = {}) {
  return {
    sendMessage: async (jid, content) => { sink.push({ jid, content }); return { key: { id: 'B' + sink.length } }; },
    relayMessage: async () => ({}),
    sendPresenceUpdate: async (type, jid) => sink.push({ jid, presence: type }),
    presenceSubscribe: async (jid) => sink.push({ jid, subscribe: true }),
    readMessages: async () => sink.push({ read: true }),
    groupMetadata: opts.metadata === 'throw'
      ? async () => { throw new Error('403 not a member'); }
      : async () => opts.metadata !== undefined ? opts.metadata : { subject: 'G', participants: opts.participants || [] },
    waUploadToServer: async () => ({ mediaUrl: 'https://example.invalid/x' }),
    user: { id: OWNER, name: 'Hunt' },
    ev: { on: () => {} },
  };
}

function msg(text, jid, { participant, quoted } = {}) {
  const message = quoted
    ? { extendedTextMessage: { text, contextInfo: { stanzaId: 'Q1', participant: jid, quotedMessage: quoted } } }
    : { conversation: text };
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random().toString(36).slice(2), fromMe: false, participant },
    pushName: 'Hunt', messageTimestamp: Math.floor(Date.now() / 1000), message,
  };
}

let seq = 0;
async function say(text, jid, opts = {}) {
  const sink = [];
  let error = null;
  try {
    await router.handle(sock(sink, opts), msg(text, jid, opts), { ...config, owner: OWNER },
      (j, c) => { const out = { jid: j, content: c, key: { id: 'S' + (++seq) } }; sink.push(out); return out; });
  } catch (e) { error = e; }
  return { sink, error, texts: sink.filter((s) => s.content?.text).map((s) => s.content.text).join(' | ') };
}

function participants(n, { admins = 0, dupes = false, weird = false } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = weird && i % 7 === 3 ? undefined : `947000${String(100000 + i)}@s.whatsapp.net`;
    out.push({ id: i % 5 === 1 ? `${id}`.replace('@', ':11@') : id, admin: i < admins ? 'admin' : null });
  }
  if (dupes) out.push({ id: OWNER, admin: null }, { id: OWNER, admin: 'admin' });
  return out;
}

(async () => {
  const restoreSettings = settings.get();
  const restoreStatus = statusManager.getSettings();

  console.log('\n═══ .tagall ═══');
  const tagallArgs = [
    [], [''], ['   '], ['hide'], ['admins'], ['hide', 'admins'], ['admins', 'hide'],
    ['-h'], ['--hide'], ['hidetag'], ['admin'], ['staff'],
    ['x'.repeat(9000)], ['🔥'.repeat(500)], ['‮ arabic rtl'], ['meeting', 'at', '8'],
    ['hide', 'x'.repeat(5000)], ['ALL'], ['Hide'], ['undefined'], ['null'],
  ];
  for (const args of tagallArgs) {
    const label = `.tagall ${JSON.stringify(args).slice(0, 40)}`;
    const r = await say('.' + ['tagall', ...args].join(' '), GROUP, { participant: MEMBER, participants: participants(23, { admins: 2 }) });
    if (r.error) { note(label, 'THROWS', r.error.message); continue; }
    const tagged = r.sink.reduce((n, s) => n + (s.content?.mentions?.length || 0), 0);
    const texts = r.texts;
    if (/⛔|❌/.test(texts) && !/Could not read/.test(texts)) { note(label, 'refused unexpectedly', texts.slice(0, 70)); continue; }
    if (tagged === 0) { note(label, 'tagged nobody', texts.slice(0, 60)); continue; }
    const long = texts.split('\n').some((l) => l.length > 4000);
    if (long) note(label, 'a single line is longer than WhatsApp allows');
    if (args[0] === 'admins' && tagged !== 2) note(label, `admins-only tagged ${tagged} instead of 2`);
  }

  /* participant shapes */
  const shapes = [
    ['empty group', []],
    ['one member', participants(1)],
    ['1000 members', participants(1000)],
    ['duplicates', participants(5, { dupes: true })],
    ['device suffixes', participants(6, { weird: true })],
    ['string entries', ['94700000002@s.whatsapp.net', OWNER]],
    ['null metadata', null],
    ['metadata without participants', { subject: 'G' }],
    ['metadata throws', 'throw'],
  ];
  for (const [name, value] of shapes) {
    const opts = value === 'throw' ? { metadata: 'throw' } : { participants: Array.isArray(value) ? value : undefined, metadata: Array.isArray(value) ? undefined : value };
    const r = await say('.tagall hello', GROUP, { participant: MEMBER, ...opts });
    if (r.error) { note(`.tagall (${name})`, 'THROWS', r.error.message); continue; }
    if (!r.sink.length) { note(`.tagall (${name})`, 'silent — no reply at all'); continue; }
    if (name === 'duplicates') {
      const mentions = r.sink.flatMap((s) => s.content?.mentions || []);
      if (new Set(mentions).size !== mentions.length) note('.tagall (duplicates)', 'tagged the same person twice', mentions.join(','));
    }
    if (name === 'device suffixes') {
      const mentions = r.sink.flatMap((s) => s.content?.mentions || []);
      if (mentions.some((m) => /:\d+@/.test(m))) note('.tagall (device suffixes)', 'kept a device suffix in a mention', mentions.join(','));
      if (mentions.some((m) => !m.includes('@'))) note('.tagall (device suffixes)', 'a mention lost its domain', mentions.join(','));
    }
    if (name === '1000 members') {
      const mentions = r.sink.flatMap((s) => s.content?.mentions || []);
      if (mentions.length !== 1000) note('.tagall (1000 members)', `only ${mentions.length} of 1000 tagged`);
      if (r.sink.some((s) => s.content?.text?.length > 4000)) note('.tagall (1000 members)', 'one message exceeds the WhatsApp text limit');
    }
  }

  /* permission model */
  for (const perm of ['all', 'admin', 'owner', 'bogus', '']) {
    settings.update({ tagallPerm: perm });
    const r = await say('.tagall hello', GROUP, { participant: MEMBER, participants: participants(4, { admins: 1 }) });
    if (r.error) { note(`.tagperm ${perm || '(empty)'}`, 'THROWS', r.error.message); continue; }
    const tagged = r.sink.reduce((n, s) => n + (s.content?.mentions?.length || 0), 0);
    if (perm === 'bogus' || perm === '') {
      if (tagged === 0) note(`.tagperm ${perm || '(empty)'}`, 'an invalid level locked tagall out completely');
    }
    const ownerRun = await say('.tagall hello', GROUP, { participant: OWNER, participants: participants(4, { admins: 1 }) });
    const ownerTagged = ownerRun.sink.reduce((n, s) => n + (s.content?.mentions?.length || 0), 0);
    if (ownerTagged === 0) note(`.tagperm ${perm || '(empty)'}`, 'the OWNER was blocked from tagall');
  }
  settings.update({ tagallPerm: 'all' });

  console.log('\n═══ status downloader ═══');
  const statusArgs = [
    [], ['all'], ['ALL'], ['all', '0'], ['all', '-3'], ['all', 'abc'], ['all', '1e9'],
    ['latest'], ['me'], ['own'], ['save'], ['save', 'extra'], ['clear'], ['settings'],
    ['0'], ['00'], ['+'], ['abc'], ['94'], ['94771234567'], ['+94 77 123 4567'], ['0094771234567'],
    ['94771234567@s.whatsapp.net'], ['9'.repeat(30)], ['94771234567', '0'], ['94771234567', '-2'],
    ['94771234567', 'abc'], ['94771234567', '1e9'], ['‮'], ['\u0000'], ['status'], ['info'],
  ];
  statusManager.clearCache();
  await statusManager.handleStatus({ key: { remoteJid: 'status@broadcast', id: 'A1', fromMe: false, participant: '94771234567@s.whatsapp.net' }, message: { conversation: 'cached one' } }, sock([]));
  for (const args of statusArgs) {
    const label = `.status ${JSON.stringify(args).slice(0, 40)}`;
    const r = await say('.' + ['status', ...args].join(' '), DM);
    if (r.error) { note(label, 'THROWS', r.error.message); continue; }
    if (!r.sink.length) { note(label, 'silent — no reply at all'); continue; }
    if (/undefined|NaN|\[object Object\]/.test(r.texts)) note(label, 'leaks a raw value into the reply', r.texts.slice(0, 80));
    if (args[0] === 'clear' && !/Owner only|cleared/.test(r.texts)) note(label, 'clear answered strangely', r.texts.slice(0, 60));
  }

  /* a guest must not be able to wipe the cache */
  await statusManager.handleStatus({ key: { remoteJid: 'status@broadcast', id: 'A2', fromMe: false, participant: '94771234567@s.whatsapp.net' }, message: { conversation: 'still here' } }, sock([]));
  const guestClear = await say('.status clear', DM);
  if (statusManager.find('94771234567').length === 0) note('.status clear (guest)', 'a guest wiped the cache');
  if (!/Owner only/.test(guestClear.texts)) note('.status clear (guest)', 'no refusal message', guestClear.texts.slice(0, 50));

  /* hostile status message shapes */
  const shapes2 = [
    ['empty message', {}],
    ['null message', null],
    ['view once image', { viewOnceMessage: { message: { imageMessage: { mimetype: 'image/jpeg' } } } }],
    ['view once v2', { viewOnceMessageV2: { message: { videoMessage: { mimetype: 'video/mp4' } } } }],
    ['ephemeral text', { ephemeralMessage: { message: { conversation: 'ephemeral' } } }],
    ['document with caption', { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'application/pdf', fileName: 'f.pdf', caption: 'cap' } } } }],
    ['sticker', { stickerMessage: { mimetype: 'image/webp', isAnimated: true } }],
    ['audio ptt', { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } }],
    ['audio without mimetype', { audioMessage: {} }],
    ['document without filename', { documentMessage: { mimetype: 'application/pdf' } }],
    ['reaction message', { reactionMessage: { text: '🔥', key: { id: 'X' } } }],
    ['protocol revoke', { protocolMessage: { type: 0, key: { remoteJid: 'status@broadcast', id: 'A1' } } }],
    ['edited message', { editedMessage: { message: { conversation: 'edited text' } } }],
    ['image with a very long caption', { imageMessage: { caption: 'x'.repeat(5000), mimetype: 'image/jpeg' } }],
    ['no participant', { conversation: 'who is this' }],
  ];
  for (const [name, message] of shapes2) {
    const key = { remoteJid: 'status@broadcast', id: 'S-' + name.replace(/\W/g, ''), fromMe: false,
      ...(name === 'no participant' ? {} : { participant: '94778888888@s.whatsapp.net' }) };
    let error = null;
    try { await statusManager.handleStatus(message === null ? { key, message: null } : { key, message }, sock([])); } catch (e) { error = e; }
    if (error) { note(`handleStatus (${name})`, 'THROWS', error.message); continue; }
    const cached = statusManager.find('94778888888');
    const last = cached[cached.length - 1];
    const r = await say('.status 94778888888', DM);
    if (r.error) { note(`.status after (${name})`, 'THROWS', r.error.message); continue; }
    if (/undefined|NaN|\[object Object\]/.test(r.texts)) note(`.status after (${name})`, 'leaks a raw value', r.texts.slice(0, 90));
    if (name === 'protocol revoke' && statusManager.find('94771234567').length) {
      note('handleStatus (protocol revoke)', 'a deleted status stays in the cache and is offered for download');
    }
    if (name === 'reaction message' && last) note('handleStatus (reaction message)', 'a reaction notification was cached as a status');
    if (name === 'no participant' && last) note('handleStatus (no participant)', 'cached under an unknown number');
    statusManager.clearCache();
  }

  /* cache limits + TTL */
  statusManager.clearCache();
  for (let i = 0; i < 40; i++) {
    await statusManager.handleStatus({ key: { remoteJid: 'status@broadcast', id: 'L' + i, fromMe: false, participant: `9470000${String(i).padStart(4, '0')}@s.whatsapp.net` }, message: { conversation: 'bulk ' + i } }, sock([]));
  }
  const many = await say('.status all 1e9', DM);
  if (many.error) note('.status all 1e9', 'THROWS', many.error.message);
  const sentCount = many.sink.filter((s) => s.content && (s.content.text || s.content.image)).length;
  if (sentCount < 2) note('.status all 1e9', `only ${sentCount} replies for 40 cached statuses`);
  if (sentCount > 200) note('.status all 1e9', `${sentCount} messages for 40 statuses — no sane cap`, 'rate-limit risk');

  /* an expired status must not be offered */
  statusManager.clearCache();
  const staleNumber = '94776666666';
  await statusManager.handleStatus({ key: { remoteJid: 'status@broadcast', id: 'OLD1', fromMe: false, participant: `${staleNumber}@s.whatsapp.net` }, message: { conversation: 'ancient' } }, sock([]));
  const cachedList = statusManager.find(staleNumber);
  if (cachedList.length) cachedList[0].receivedAt = Date.now() - 400 * 24 * 3600 * 1000; // 400 days old
  const staleRun = await say(`.status ${staleNumber}`, DM);
  if (/ancient/.test(staleRun.texts)) note('.status (expired entry)', 'a status older than the TTL window was still served');


  console.log('\n═══ deeper probes ═══');

  /* a quoted NON-status message must not blow up or leak */
  const notStatus = await say('.status save', DM, { quoted: { conversation: 'just a chat message' } });
  if (notStatus.error) note('.status save (plain quoted text)', 'THROWS', notStatus.error.message);
  else if (!notStatus.texts) note('.status save (plain quoted text)', 'silent');
  const weirdQuote = await say('.status save', DM, { quoted: { protocolMessage: { type: 0 } } });
  if (weirdQuote.error) note('.status save (quoted revoke)', 'THROWS', weirdQuote.message);
  if (/undefined|\[object Object\]/.test(weirdQuote.texts)) note('.status save (quoted revoke)', 'leaks a raw value', weirdQuote.texts.slice(0, 70));

  /* the bot's own number as a target */
  const own = await say(`.status ${OWNER.split('@')[0]}`, OWNER);
  if (own.error) note('.status <own number>', 'THROWS', own.error.message);
  if (!own.texts) note('.status <own number>', 'silent');

  /* every download fails → the summary must still make sense */
  statusManager.clearCache();
  const realDownloader = null;
  statusManager.setDownloader(async () => { throw new Error('CDN unreachable'); });
  for (let i = 0; i < 3; i++) {
    await statusManager.handleStatus({ key: { remoteJid: 'status@broadcast', id: 'F' + i, fromMe: false, participant: '94775555555@s.whatsapp.net' }, message: { imageMessage: { mimetype: 'image/jpeg' } } }, sock([]));
  }
  const allFail = await say('.status 94775555555', DM);
  if (allFail.error) note('.status (all downloads fail)', 'THROWS', allFail.error.message);
  if (!/could not be sent|CDN unreachable/.test(allFail.texts)) note('.status (all downloads fail)', 'no explanation for the failure', allFail.texts.slice(0, 80));
  statusManager.setDownloader(async () => Readable.from([Buffer.from('fake-media')]));

  /* a huge group must not take forever or eat the heap */
  statusManager.clearCache();
  const t0 = Date.now();
  const heap0 = process.memoryUsage().heapUsed;
  const huge = await say('.tagall census', GROUP, { participant: MEMBER, participants: participants(20000) });
  const ms = Date.now() - t0;
  const heapMb = (process.memoryUsage().heapUsed - heap0) / 1048576;
  if (huge.error) note('.tagall (20 000 members)', 'THROWS', huge.error.message);
  const hugeTagged = huge.sink.reduce((n, x) => n + (x.content?.mentions?.length || 0), 0);
  if (hugeTagged !== 20000) note('.tagall (20 000 members)', `only ${hugeTagged} tagged`);
  if (ms > 20000) note('.tagall (20 000 members)', `took ${ms} ms — too slow`);
  if (heapMb > 250) note('.tagall (20 000 members)', `used ${heapMb.toFixed(0)} MB of heap`);
  console.log(`   (20 000-member tagall: ${ms} ms, ${huge.sink.length} messages, +${heapMb.toFixed(0)} MB heap)`);

  /* concurrent status commands must not interleave into nonsense */
  statusManager.clearCache();
  for (let i = 0; i < 12; i++) {
    await statusManager.handleStatus({ key: { remoteJid: 'status@broadcast', id: 'C' + i, fromMe: false, participant: `9470000${String(i).padStart(4, '0')}@s.whatsapp.net` }, message: { conversation: 'concurrent ' + i } }, sock([]));
  }
  const runs = await Promise.all([say('.status all 5', DM), say('.status all 5', DM), say('.status all 5', DM)]);
  if (runs.some((r) => r.error)) note('.status all (3 in parallel)', 'THROWS', runs.find((r) => r.error)?.error.message);
  const counts = runs.map((r) => r.sink.filter((x) => x.content?.text?.includes('Status from')).length);
  if (new Set(counts).size !== 1) note('.status all (3 in parallel)', `inconsistent results: ${counts.join('/')}`);

  /* the safety cap must actually cap */
  statusManager.clearCache();
  for (let i = 0; i < 140; i++) {
    await statusManager.handleStatus({ key: { remoteJid: 'status@broadcast', id: 'CAP' + i, fromMe: false, participant: `947000${String(200000 + i)}@s.whatsapp.net` }, message: { conversation: 'cap ' + i } }, sock([]));
  }
  const capped = await say('.status all 9999', DM);
  const cappedCount = capped.sink.filter((x) => x.content?.text?.includes('Status from')).length;
  if (cappedCount > statusManager.SEND_MAX) note('.status all 9999', `sent ${cappedCount} messages — the ${statusManager.SEND_MAX} cap did not hold`);
  if (!/STATUS_SEND_MAX|kept back/.test(capped.texts)) note('.status all 9999', 'the cap is applied silently — the user is not told', capped.texts.slice(0, 60));

  /* the cache must survive a simulated restart */
  statusManager.persistNow();
  const beforeRestart = statusManager.status().statuses;
  for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
  const reborn = require('../src/services/status/manager');
  reborn.setDownloader(async () => Readable.from([Buffer.from('fake-media')]));
  if (reborn.status().statuses !== beforeRestart) {
    note('restart', `the cache lost statuses: ${beforeRestart} → ${reborn.status().statuses}`);
  } else {
    console.log(`   (cache survived a restart: ${reborn.status().statuses} statuses restored)`);
  }

  console.log('\n═══ summary ═══');
  if (!problems.length) console.log('no problems found');
  else console.log(`${problems.length} problem(s):\n` + problems.map((p) => `  • ${p.where}: ${p.what}${p.detail ? ` — ${p.detail}` : ''}`).join('\n'));

  settings.update(restoreSettings);
  statusManager.setAutoSeen(restoreStatus.autoSeen);
  statusManager.setAutoReact(restoreStatus.autoReact, restoreStatus.reactions);
  statusManager.setAutoForward(restoreStatus.autoForward, restoreStatus.forwardTo);
  statusManager.clearCache();
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error('HUNT CRASH:', e && e.stack || e); process.exit(2); });
