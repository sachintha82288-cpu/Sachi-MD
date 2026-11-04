/**
 * Round 7 — the bugs the hunt found in the unlocked status downloader.
 *
 *   • reaction / protocol noise was cached as a "status"
 *   • a deleted (revoked) status stayed in the cache and was offered again
 *   • one command could blast hundreds of messages (ban risk)
 *   • the cache died on every restart
 *   • a quoted message with no content produced a confusing "sent 0"
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

process.env.REACTIONS_ENABLED = 'false';
process.env.STATUS_FRESH_WAIT_MS = '200';

const config = require('../src/config');
const status = require('../src/services/status/manager');
const statusCmd = require('../src/commands/status/status');

const FRIEND = '94771234567@s.whatsapp.net';
const cacheFile = path.join(config.paths.data, 'status-cache.json');
const cacheBackup = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, 'utf8') : null;

status.setDownloader(async () => Readable.from([Buffer.from('fake-media')]));

function ctxFor({ args = [], quoted = null, isOwner = false, jid = FRIEND } = {}) {
  const sent = [];
  const ctx = {
    sock: { sendPresenceUpdate: async () => {}, presenceSubscribe: async () => {}, sendMessage: async () => ({ key: { id: 'X' } }) },
    jid, sender: jid, args, isOwner, isGroup: false, quotedMsg: quoted, target: null,
    config: { ...config, owner: FRIEND }, prefix: '.',
    send: async (to, content) => { const out = { to, content, key: { id: 'M' + (sent.length + 1) } }; sent.push(out); return out; },
  };
  ctx.reply = async (content) => ctx.send(jid, content);
  ctx.edit = async (key, content) => { const out = { to: jid, content, edit: key, key }; sent.push(out); return out; };
  return { ctx, sent };
}
const texts = (sent) => sent.map((s) => s.content && s.content.text).filter(Boolean).join('\n');

function statusMsg(id, message, number = '94771234567', extra = {}) {
  return {
    key: { remoteJid: 'status@broadcast', id, fromMe: false, participant: `${number}@s.whatsapp.net`, ...extra },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}
const noopSock = { sendMessage: async () => ({}), readMessages: async () => {} };

test.after(() => {
  status.clearCache();
  if (cacheBackup === null) { try { fs.rmSync(cacheFile, { force: true }); } catch {} }
  else fs.writeFileSync(cacheFile, cacheBackup);
});

test('reaction and protocol noise is not cached as a status', async () => {
  status.clearCache();
  await status.handleStatus(statusMsg('N1', { reactionMessage: { text: '🔥', key: { id: 'X' } } }), noopSock);
  await status.handleStatus(statusMsg('N2', { protocolMessage: { type: 1 } }), noopSock);
  await status.handleStatus(statusMsg('N3', {}), noopSock);
  await status.handleStatus(statusMsg('N4', null), noopSock);
  await status.handleStatus(statusMsg('N5', { extendedTextMessage: { text: '   ' } }), noopSock);
  assert.equal(status.find('94771234567').length, 0, 'nothing but real content is cached');
  // real content still is
  await status.handleStatus(statusMsg('N6', { conversation: 'a real one' }), noopSock);
  assert.equal(status.find('94771234567').length, 1);
});

test('a revoked status disappears from the saver', async () => {
  status.clearCache();
  await status.handleStatus(statusMsg('R1', { imageMessage: { mimetype: 'image/jpeg' } }), noopSock);
  await status.handleStatus(statusMsg('R2', { conversation: 'keeps this one' }), noopSock);
  assert.equal(status.find('94771234567').length, 2);
  // WhatsApp sends a revoke notice when somebody deletes their status
  await status.handleStatus(statusMsg('R3', {
    protocolMessage: { type: 0, key: { remoteJid: 'status@broadcast', id: 'R1', participant: '94771234567@s.whatsapp.net' } },
  }), noopSock);
  const left = status.find('94771234567');
  assert.equal(left.length, 1, 'the deleted status is gone');
  assert.equal(left[0].key.id, 'R2');
});

test('one command can never blast more than the safety cap', async () => {
  status.clearCache();
  for (let i = 0; i < status.SEND_MAX + 40; i++) {
    await status.handleStatus(statusMsg(`C${i}`, { conversation: `bulk ${i}` }, `947000${String(200000 + i)}`), noopSock);
  }
  const { ctx, sent } = ctxFor({ args: ['all', '99999'] });
  await statusCmd.execute(ctx);
  const delivered = sent.filter((s) => s.content && /Status from/.test(s.content.text || '')).length;
  assert.ok(delivered <= status.SEND_MAX, `${delivered} messages — the cap is ${status.SEND_MAX}`);
  assert.match(texts(sent), /kept back|STATUS_SEND_MAX/, 'the user is told that some were kept back');
});

test('a per-user request is capped too, and a small limit still works', async () => {
  status.clearCache();
  for (let i = 0; i < 12; i++) {
    await status.handleStatus(statusMsg(`U${i}`, { conversation: `one ${i}` }), noopSock);
  }
  const few = ctxFor({ args: ['94771234567', '3'] });
  await statusCmd.execute(few.ctx);
  const delivered = few.sent.filter((s) => s.content && /Status from/.test(s.content.text || '')).length;
  assert.equal(delivered, 3, 'the newest 3 only');
});

test('a quoted message with no status content explains itself', async () => {
  status.clearCache();
  const { ctx, sent } = ctxFor({ args: ['save'], quoted: { protocolMessage: { type: 0 } } });
  await statusCmd.execute(ctx);
  assert.match(texts(sent), /no status content|Nothing could be sent/i);
});

test('the cache survives a restart with working media keys', () => {
  // Run in a child process: a restart means a brand-new module instance.
  const script = `
    const { Readable } = require('stream');
    const sm = require('${path.join(__dirname, '..', 'src', 'services', 'status', 'manager')}');
    const { unwrapMessage } = require('${path.join(__dirname, '..', 'src', 'utils', 'messages')}');
    (async () => {
      sm.setDownloader(async () => Readable.from([Buffer.from('x')]));
      const mediaKey = Buffer.from([9, 8, 7, 6, 5]);
      await sm.handleStatus({
        key: { remoteJid: 'status@broadcast', id: 'BOOT1', fromMe: false, participant: '94771234567@s.whatsapp.net' },
        message: { imageMessage: { caption: 'after restart', mimetype: 'image/jpeg', mediaKey, directPath: '/d' } },
        messageTimestamp: Math.floor(Date.now() / 1000),
      }, { sendMessage: async () => ({}), readMessages: async () => {} });
      sm.persistNow();
      for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
      const sm2 = require('${path.join(__dirname, '..', 'src', 'services', 'status', 'manager')}');
      const list = sm2.find('94771234567');
      const key = unwrapMessage(list[0].message).imageMessage.mediaKey;
      console.log(JSON.stringify({
        restored: list.length,
        isBuffer: Buffer.isBuffer(key),
        sameBytes: Buffer.isBuffer(key) && key.equals(mediaKey),
        caption: unwrapMessage(list[0].message).imageMessage.caption,
      }));
      sm2.clearCache(); sm2.persistNow();
    })();
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  const json = JSON.parse(out.trim().split('\n').pop());
  assert.equal(json.restored, 1, 'the status came back after the restart');
  assert.equal(json.isBuffer, true, 'the media key is a real Buffer again');
  assert.equal(json.sameBytes, true, 'the media key bytes survived');
  assert.equal(json.caption, 'after restart');
});

test('an expired entry is not restored from disk', () => {
  const script = `
    const fs = require('fs');
    const sm = require('${path.join(__dirname, '..', 'src', 'services', 'status', 'manager')}');
    const file = '${cacheFile}';
    fs.writeFileSync(file, JSON.stringify({ v: 1, savedAt: Date.now(), count: 1, entries: [
      { number: '94771234567', item: { key: { id: 'OLD', remoteJid: 'status@broadcast' }, message: { conversation: 'ancient' }, receivedAt: Date.now() - 400 * 86400000 } },
    ] }));
    for (const k of Object.keys(require.cache)) if (k.includes('/src/')) delete require.cache[k];
    const sm2 = require('${path.join(__dirname, '..', 'src', 'services', 'status', 'manager')}');
    console.log(JSON.stringify({ restored: sm2.find('94771234567').length }));
    sm2.clearCache(); sm2.persistNow();
  `;
  const json = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(json.restored, 0, 'a 400-day-old entry is dropped on load');
});

test('a corrupt cache file cannot stop the bot from booting', () => {
  const script = `
    const fs = require('fs');
    fs.writeFileSync('${cacheFile}', '{ this is not json');
    const sm = require('${path.join(__dirname, '..', 'src', 'services', 'status', 'manager')}');
    console.log(JSON.stringify({ loaded: typeof sm.status().statuses === 'number', users: sm.status().users }));
  `;
  const json = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.equal(json.loaded, true);
  assert.equal(json.users, 0);
});
