const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const router = require('../src/router/router');
const config = require('../src/config');
const settings = require('../src/services/settings');
const mode = require('../src/services/mode');

router.loadCommands();

const OWNER = '94700000001@s.whatsapp.net';
const FRIEND = '94700000002@s.whatsapp.net';

function sock(sent) {
  return {
    sendMessage: async (jid, content) => {
      sent.push({ jid, text: content && content.text, content });
      return { key: { id: 'BOT-' + (sent.length + 1) } };
    },
    waUploadToServer: async () => ({ mediaUrl: 'https://example.invalid/x' })
  };
}
function msg(text, jid) {
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random(), fromMe: false },
    pushName: 'T',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  };
}
const run = (s, m) => router.handle(s, m, { ...config, owner: OWNER }, (j, c, o) => s.sendMessage(j, c, o));

/** Run a command as the owner and return the texts it produced. */
async function asOwner(text) {
  const sent = [];
  await run(sock(sent), msg(text, OWNER));
  return sent.map((s) => s.text).filter(Boolean);
}

/** Put the persisted settings back after the test. */
async function keepSettings(fn) {
  const file = config.paths.settings;
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const before = { ...settings.get() };
  try { return await fn(); } finally {
    settings.update(before);            // the live values too
    if (backup === null) { try { fs.rmSync(file, { force: true }); } catch {} }
    else fs.writeFileSync(file, backup);
  }
}

test('the owner switches the mode with .mode <name>', async () => {
  await keepSettings(async () => {
    const texts = await asOwner('.mode groups');
    assert.ok(texts.some((t) => /Mode changed/.test(t)), 'the mode changed');
    assert.equal(mode.current(), 'groups');
    const list = await asOwner('.mode');
    assert.ok(list.some((t) => /self/.test(t) && /groups/.test(t)), 'the modes are listed');
  });
});

test('the owner renames the bot, sets the header and the footer', async () => {
  await keepSettings(async () => {
    await asOwner('.setname Sachi Prime');
    assert.equal(settings.name(), 'Sachi Prime');
    await asOwner('.setheader Prime Header');
    assert.equal(settings.header(), 'Prime Header');
    await asOwner('.setfooter Prime Footer');
    assert.equal(settings.footer(), 'Prime Footer');
    const summary = await asOwner('.settings');
    assert.ok(summary.some((t) => /Sachi Prime/.test(t)), 'the summary shows the name');
    assert.ok(summary.some((t) => /Prime Header/.test(t)), 'the summary shows the header');
    assert.ok(summary.some((t) => /Prime Footer/.test(t)), 'the summary shows the footer');
  });
});

test('a guest cannot change the settings', async () => {
  await keepSettings(async () => {
    const sent = [];
    await router.handle(sock(sent), msg('.mode groups', FRIEND), { ...config, owner: OWNER }, (j, c, o) => sock(sent).sendMessage(j, c, o));
    const texts = sent.map((s) => s.text).filter(Boolean);
    assert.ok(texts.some((t) => /owner only/i.test(t)), 'the guest is refused');
    assert.notEqual(mode.current(), 'groups', 'the mode did not change');
  });
});

test('the settings survive a restart (they are on disk)', async () => {
  await keepSettings(async () => {
    await asOwner('.setname Persisted Bot');
    const onDisk = JSON.parse(fs.readFileSync(config.paths.settings, 'utf8'));
    assert.equal(onDisk.botName, 'Persisted Bot');
    assert.equal(onDisk.mode || 'all', mode.current());
  });
});
