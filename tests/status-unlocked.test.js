/**
 * Round 6 — the status saver with its restrictions removed.
 *
 * Covers: emoji validation (ZWJ/flags/keycaps), multi-emoji random
 * reactions, the cache paths (.status all / me / save / clear), the live
 * refresh (presence subscribe), auto-forward, sticker+document statuses and
 * batch resilience when one media download fails.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const fs = require('fs');

process.env.REACTIONS_ENABLED = 'false';
process.env.STATUS_FRESH_WAIT_MS = '1000';

const status = require('../src/services/status/manager');
const selections = require('../src/services/selection');
const statusCmd = require('../src/commands/status/status');
const forwardCmd = require('../src/commands/status/autoforward');
const reactCmd = require('../src/commands/status/autoreact');
const config = require('../src/config');

const OWNER = '94700000001@s.whatsapp.net';
const FRIEND = '94771234567@s.whatsapp.net';
const OTHER = '94779998888@s.whatsapp.net';
const settingsFile = require('path').join(config.paths.data, 'status-settings.json');
const settingsBackup = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null;

/* media downloads are faked — the sandbox has no WhatsApp CDN */
let downloadCalls = 0;
let failOn = -1;
status.setDownloader(async () => {
  downloadCalls++;
  if (downloadCalls === failOn) throw new Error('404 media expired');
  return Readable.from([Buffer.from('fake-media-bytes')]);
});

function sock(rec = { presence: [], sent: [] }) {
  return {
    rec,
    sendMessage: async (jid, content) => { rec.sent.push({ jid, content }); return { key: { id: 'S' + rec.sent.length } }; },
    readMessages: async () => {},
    sendPresenceUpdate: async (type, jid) => { rec.presence.push({ type, jid }); },
    presenceSubscribe: async (jid) => { rec.presence.push({ subscribe: jid }); },
  };
}

function ctxFor({ args = [], quoted = null, isOwner = false, sender = FRIEND, jid = FRIEND, target = null, sockOverride = null } = {}) {
  const sent = [];
  const s = sockOverride || sock();
  const ctx = {
    sock: s,
    jid,
    sender,
    args,
    isOwner,
    isGroup: false,
    quotedMsg: quoted,
    target,
    config: { ...config, owner: OWNER },
    prefix: '.',
    send: async (to, content, opts) => {
      const out = { to, content, opts, key: { id: 'MSG' + (sent.length + 1) } };
      sent.push(out);
      return out;
    },
  };
  ctx.reply = async (content) => ctx.send(jid, content, { quoted: true, reply: true });
  ctx.edit = async (key, content) => { const out = { to: jid, content, edit: key, key }; sent.push(out); return out; };
  return { ctx, sent, sock: s };
}

function statusMsg(number, message, { id = 'ST' + Math.random().toString(36).slice(2), fromMe = false } = {}) {
  return {
    key: { remoteJid: 'status@broadcast', id, fromMe, participant: `${number}@s.whatsapp.net` },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

const texts = (sent) => sent.map((s) => s.content && s.content.text).filter(Boolean);

test.after(() => {
  if (settingsBackup === null) { try { fs.unlinkSync(settingsFile); } catch {} }
  else fs.writeFileSync(settingsFile, settingsBackup);
  status.clearCache();
  status.setSender(null);
});

/* ── emoji handling ─────────────────────────────────────────────────── */

test('complex emoji survive: ZWJ families, flags and keycaps are not cut in half', () => {
  for (const e of ['👨‍👩‍👧‍👦', '🇱🇰', '1️⃣', '👍🏽', '🫠']) {
    assert.equal(status.isEmoji(e), true, `${e} should be a valid reaction`);
    const next = status.setAutoReact(true, e);
    assert.deepEqual(next.reactions, [e], `${e} must be stored whole`);
    assert.equal(next.reaction, e);
  }
});

test('plain words are rejected instead of being sent to WhatsApp', () => {
  for (const bad of ['lol', 'nice one', 'a🔥']) assert.equal(status.isEmoji(bad), false, bad);
  const list = status.parseReactions('🔥, 😍 💯 ok hello');
  assert.deepEqual(list, ['🔥', '😍', '💯']);
});

test('several emojis are stored and one of them is picked per status', () => {
  const next = status.setAutoReact(true, '🔥 😍 💯');
  assert.equal(next.reactions.length, 3);
  const picks = new Set();
  for (let i = 0; i < 60; i++) picks.add(status.pickReaction());
  for (const p of picks) assert.ok(next.reactions.includes(p), `${p} came from the saved list`);
  assert.ok(picks.size > 1, 'the pick is randomised, not always the first emoji');
});

test('.setreaction explains itself and refuses non-emoji input', async () => {
  const { ctx, sent } = ctxFor({ args: ['hello'], isOwner: true, sender: OWNER, jid: OWNER });
  await require('../src/commands/settings/setreaction').execute(ctx);
  const out = texts(sent).join('\n');
  assert.match(out, /not an emoji/);
  assert.match(out, /setreaction 🔥/);
});

test('.setreaction with no argument offers the picker and a number reply applies it', async () => {
  selections.reset();
  const { ctx, sent } = ctxFor({ args: [], isOwner: true, sender: OWNER, jid: OWNER });
  await require('../src/commands/settings/setreaction').execute(ctx);
  const out = texts(sent).join('\n');
  assert.match(out, /Pick one — reply with a number/);
  const id = sent[0].key.id;
  const pending = selections.get(id, OWNER, OWNER);
  assert.ok(pending, 'the picker is registered as a pending selection');
  const replied = [];
  await pending.handler({
    sock: null, send: async (to, content) => { replied.push({ to, content }); }, msg: {}, jid: OWNER,
    sender: OWNER, text: '2', config, isOwner: true, reply: async (c) => replied.push(c),
  });
  assert.match(texts(replied).join('\n'), /Status reaction: \*🔥\*/);
  assert.equal(status.getSettings().reactions[0], '🔥');
});

test('.autoreact on without an emoji keeps the saved list (no reset to ❤️)', async () => {
  status.setAutoReact(true, '💀');
  const { ctx, sent } = ctxFor({ args: ['on'], isOwner: true, sender: OWNER, jid: OWNER });
  await reactCmd.execute(ctx);
  assert.match(texts(sent).join('\n'), /💀/);
  assert.deepEqual(status.getSettings().reactions, ['💀']);
});

/* ── cache + delivery ───────────────────────────────────────────────── */

test('a text status is cached and sent back by number', async () => {
  status.clearCache();
  downloadCalls = 0;
  await status.handleStatus(statusMsg('94771234567', { extendedTextMessage: { text: 'Good morning ☀️' } }), sock());
  const { ctx, sent } = ctxFor({ args: ['94771234567'] });
  await statusCmd.execute(ctx);
  const out = texts(sent).join('\n');
  assert.match(out, /Good morning/);
});

test('an image status is downloaded and sent as an image', async () => {
  status.clearCache();
  downloadCalls = 0; failOn = -1;
  await status.handleStatus(statusMsg('94771234567', { imageMessage: { caption: 'beach', mimetype: 'image/jpeg' } }), sock());
  const { ctx, sent } = ctxFor({ args: ['+94 77 123 4567'] });
  await statusCmd.execute(ctx);
  const image = sent.find((s) => s.content && s.content.image);
  assert.ok(image, 'the image buffer was sent');
  assert.ok(Buffer.isBuffer(image.content.image) && image.content.image.length > 0);
  assert.match(image.content.caption, /beach/);
});

test('sticker and document statuses are supported (they used to be dropped)', async () => {
  status.clearCache();
  downloadCalls = 0; failOn = -1;
  await status.handleStatus(statusMsg('94771234567', { stickerMessage: { mimetype: 'image/webp' } }), sock());
  await status.handleStatus(statusMsg('94771234567', { documentMessage: { mimetype: 'application/pdf', fileName: 'paper.pdf' } }), sock());
  const { ctx, sent } = ctxFor({ args: ['94771234567'] });
  await statusCmd.execute(ctx);
  assert.ok(sent.some((s) => s.content && s.content.sticker), 'sticker status sent');
  const doc = sent.find((s) => s.content && s.content.document);
  assert.ok(doc, 'document status sent');
  assert.equal(doc.content.fileName, 'paper.pdf');
});

test('.status all walks every cached user, newest first', async () => {
  status.clearCache();
  await status.handleStatus(statusMsg('94771234567', { conversation: 'first' }), sock());
  await new Promise((r) => setTimeout(r, 5));
  await status.handleStatus(statusMsg('94779998888', { conversation: 'second' }), sock());
  const { ctx, sent } = ctxFor({ args: ['all', '5'] });
  await statusCmd.execute(ctx);
  const out = texts(sent).join('\n');
  assert.match(out, /first/);
  assert.match(out, /second/);
  assert.equal(status.latest(1)[0].number, '94779998888', 'newest first');
});

test('.status save downloads a quoted status with an empty cache', async () => {
  status.clearCache();
  downloadCalls = 0; failOn = -1;
  const quoted = { imageMessage: { caption: 'quoted one', mimetype: 'image/jpeg' } };
  const { ctx, sent } = ctxFor({ args: ['save'], quoted });
  await statusCmd.execute(ctx);
  assert.ok(sent.some((s) => s.content && s.content.image), 'the quoted image was sent');
});

test('a quoted status with no argument at all is saved too', async () => {
  status.clearCache();
  const quoted = { extendedTextMessage: { text: 'just text' } };
  const { ctx, sent } = ctxFor({ args: [], quoted });
  await statusCmd.execute(ctx);
  assert.match(texts(sent).join('\n'), /just text/);
});

test('mentioning a person works as well as typing the number', async () => {
  status.clearCache();
  await status.handleStatus(statusMsg('94779998888', { conversation: 'mentioned status' }), sock());
  const { ctx, sent } = ctxFor({ args: [], target: OTHER });
  await statusCmd.execute(ctx);
  assert.match(texts(sent).join('\n'), /mentioned status/);
});

test('one broken media file never kills the rest of the batch', async () => {
  status.clearCache();
  downloadCalls = 0; failOn = 2;               // the second download throws
  await status.handleStatus(statusMsg('94771234567', { imageMessage: { mimetype: 'image/jpeg' } }), sock());
  await status.handleStatus(statusMsg('94771234567', { imageMessage: { mimetype: 'image/jpeg' } }), sock());
  const { ctx, sent } = ctxFor({ args: ['94771234567'] });
  await statusCmd.execute(ctx);
  const out = texts(sent).join('\n');
  assert.ok(sent.filter((s) => s.content && s.content.image).length === 1, 'the good one still went out');
  assert.match(out, /could not be sent|404 media expired/);
});

test('an empty cache triggers a live refresh request instead of a flat no', async () => {
  status.clearCache();
  const s = sock();
  const { ctx, sent } = ctxFor({ args: ['94770001111'], sockOverride: s });
  await statusCmd.execute(ctx);
  assert.ok(s.rec.presence.some((p) => p.subscribe === '94770001111@s.whatsapp.net'), 'presence subscribed');
  assert.ok(s.rec.presence.some((p) => p.type === 'available'), 'marked available');
  assert.match(texts(sent).join('\n'), /asking WhatsApp|No status in RAM/);
});

test('.status with no argument is a dashboard with a pick-a-user list', async () => {
  selections.reset();
  status.clearCache();
  await status.handleStatus(statusMsg('94771234567', { conversation: 'dash one' }), sock());
  const { ctx, sent } = ctxFor({ args: [] });
  await statusCmd.execute(ctx);
  const out = texts(sent).join('\n');
  assert.match(out, /Status Saver/);
  assert.match(out, /\+94771234567/);
  assert.match(out, /Reply with a number/);
  const pending = selections.get(sent[0].key.id, FRIEND, FRIEND);
  assert.ok(pending, 'the numbered list is interactive');
});

test('.status clear empties the cache but only for the owner', async () => {
  status.clearCache();
  await status.handleStatus(statusMsg('94771234567', { conversation: 'x' }), sock());
  const guest = ctxFor({ args: ['clear'] });
  await statusCmd.execute(guest.ctx);
  assert.match(texts(guest.sent).join('\n'), /Owner only/);
  assert.equal(status.find('94771234567').length, 1, 'a guest cannot wipe the cache');
  const owner = ctxFor({ args: ['clear'], isOwner: true, sender: OWNER, jid: OWNER });
  await statusCmd.execute(owner.ctx);
  assert.match(texts(owner.sent).join('\n'), /cache cleared/);
  assert.equal(status.find('94771234567').length, 0);
});

/* ── automations ────────────────────────────────────────────────────── */

test('auto-react uses the saved emoji and ignores the owner\'s own status', async () => {
  status.clearCache();
  status.setAutoReact(true, '🔥');
  const s = sock();
  await status.handleStatus(statusMsg('94771234567', { conversation: 'react me' }, { id: 'R1' }), s);
  const reacted = s.rec.sent.find((x) => x.jid === 'status@broadcast' && x.content?.react);
  assert.equal(reacted?.content?.react?.text, '🔥');
  const mine = sock();
  await status.handleStatus(statusMsg('94700000001', { conversation: 'my own' }, { id: 'R2', fromMe: true }), mine);
  assert.ok(!mine.rec.sent.some((x) => x.content?.react), 'no reaction on the owner\'s own status');
  status.setAutoReact(false);
});

test('.autoforward sends every new status to the owner chat through the wrapped send', async () => {
  status.clearCache();
  const forwarded = [];
  status.setSender(async (jid, content) => { forwarded.push({ jid, content }); return { key: { id: 'F' } }; });
  config.owner = OWNER;
  const { ctx, sent } = ctxFor({ args: ['on'], isOwner: true, sender: OWNER, jid: OWNER });
  await forwardCmd.execute(ctx);
  assert.match(texts(sent).join('\n'), /Auto Status Forward: \*ON\*/);
  await status.handleStatus(statusMsg('94771234567', { conversation: 'forward me' }), sock());
  assert.equal(forwarded.length, 1, 'the status reached the owner chat');
  assert.equal(forwarded[0].jid, OWNER);
  assert.match(forwarded[0].content.text, /forward me/);
  // the owner's own status is cached but never echoed back
  await status.handleStatus(statusMsg('94700000001', { conversation: 'mine' }, { fromMe: true }), sock());
  assert.equal(forwarded.length, 1, 'no echo of the owner\'s own status');
  await forwardCmd.execute(ctxFor({ args: ['off'], isOwner: true, sender: OWNER, jid: OWNER }).ctx);
  assert.equal(status.getSettings().autoForward, false);
  status.setSender(null);
});

test('.autoforward accepts another number as the destination', async () => {
  const { ctx, sent } = ctxFor({ args: ['on', '94779998888'], isOwner: true, sender: OWNER, jid: OWNER });
  await forwardCmd.execute(ctx);
  assert.match(texts(sent).join('\n'), /\+94779998888/);
  assert.equal(status.getSettings().forwardTo, OTHER);
  status.setAutoForward(false, '');
});

test('a redelivered status id is not cached, reacted to or forwarded twice', async () => {
  status.clearCache();
  status.setAutoReact(true, '🔥');
  const s = sock();
  const m = statusMsg('94771234567', { conversation: 'dup' }, { id: 'DUP1' });
  await status.handleStatus(m, s);
  await status.handleStatus(m, s);
  assert.equal(status.find('94771234567').length, 1);
  assert.equal(s.rec.sent.filter((x) => x.content?.react).length, 1);
  status.setAutoReact(false);
});
