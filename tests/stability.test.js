const test = require('node:test');
const assert = require('node:assert/strict');

process.env.REACTIONS_ENABLED = 'false';

const router = require('../src/router/router');
const config = require('../src/config');
const mode = require('../src/services/mode');
const antiban = require('../src/services/antiban');
const settings = require('../src/services/settings');

router.loadCommands();

const OWNER = '94700000001@s.whatsapp.net';
const FRIEND = '94700000002@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

function makeSock(sent, presence) {
  return {
    sendMessage: async (jid, content) => {
      sent.push({ jid, content, kind: content && content.__interactive ? 'card' : 'text' });
      return { key: { id: 'BOT-' + (sent.length + 1) } };
    },
    sendPresenceUpdate: async (type, jid) => { presence.push({ type, jid }); },
    relayMessage: async () => ({}),
    waUploadToServer: async () => ({ mediaUrl: 'https://example.invalid/x' }),
    user: { id: OWNER, name: 'Test' }
  };
}
function msg(text, jid, participant) {
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random(), fromMe: false, participant },
    pushName: 'T',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  };
}
const run = (s, m, cfg = config) => router.handle(s, m, cfg, (j, c, o) => s.sendMessage(j, c, o));

/** The owner replies in their own chat. */
async function ownerSays(text, jid = OWNER) {
  const sent = [];
  await run(makeSock(sent, []), msg(text, jid), { ...config, owner: OWNER });
  return sent.map((s) => s.content && s.content.text).filter(Boolean);
}

test('the mode never locks the owner out of their own private chat', async () => {
  const before = mode.current();
  try {
    for (const m of mode.MODES) {
      mode.set(m);
      // the owner writes from a private chat — owner commands must work
      const texts = await ownerSays('.mode', OWNER);
      assert.ok(texts.some((t) => /Bot mode/.test(t)), `${m}: the mode command answered`);
    }
  } finally { mode.set(before); }
});

test('a guest in a private chat is still blocked in "self" mode', async () => {
  const before = mode.current();
  try {
    mode.set('self');
    const sent = [];
    await run(makeSock(sent, []), msg('.ping', FRIEND), { ...config, owner: OWNER });
    const texts = sent.map((s) => s.content && s.content.text).filter(Boolean);
    assert.ok(texts.some((t) => /🔕/.test(t)), 'the guest gets the mode notice');
    assert.ok(!texts.some((t) => /Pong/.test(t)), 'the guest gets no answer');
  } finally { mode.set(before); }
});

test('the mode command tells the owner what happens in THIS chat', async () => {
  const before = mode.current();
  try {
    mode.set('groups');
    const texts = await ownerSays('.mode', OWNER);
    assert.ok(texts.some((t) => /stays quiet|answers/.test(t)), 'the current chat is explained');
  } finally { mode.set(before); }
});

test('a failing command names the command and the reason', async () => {
  const cmd = router.list().find((c) => c.name === 'ping');
  const original = cmd.execute;
  cmd.execute = async () => { throw new Error('the socket exploded'); };
  try {
    const texts = await ownerSays('.ping', OWNER);
    assert.ok(texts.some((t) => /ping/.test(t) && /exploded/.test(t)), 'the error is explained: ' + texts.join(' | '));
  } finally { cmd.execute = original; }
});

test('the health report is available and shows the anti-ban state', async () => {
  const texts = await ownerSays('.health', OWNER);
  const body = texts.join('\n');
  assert.ok(/Anti-ban/.test(body), 'the anti-ban block is there');
  assert.ok(/Risk/.test(body), 'the risk score is there');
  assert.ok(/Mode/.test(body), 'the mode is there');
});

test('the settings summary lists everything that can be customised', async () => {
  const texts = await ownerSays('.settings', OWNER);
  const body = texts.join('\n');
  for (const key of ['Mode', 'Name', 'Logo', 'Header', 'Footer', 'Prefix', 'Auto seen', 'Auto react', 'Anti-ban']) {
    assert.ok(body.includes(key), key + ' is listed');
  }
});

test('the status reaction can be changed from the settings', async () => {
  const status = require('../src/services/status/manager');
  const before = status.getSettings();
  try {
    const texts = await ownerSays('.setreaction 🧨', OWNER);
    assert.ok(texts.some((t) => /🧨/.test(t)), 'the reaction is set');
    assert.equal(status.getSettings().reaction, '🧨');
  } finally {
    status.setAutoReact(before.autoReact, before.reaction);
  }
});

test('the anti-ban preset can be changed at runtime', async () => {
  const before = antiban.status().preset;
  const texts = await ownerSays('.antiban conservative', OWNER);
  assert.ok(texts.some((t) => /conservative/.test(t)), 'the preset changed');
  assert.equal(antiban.status().preset, 'conservative');
  antiban.setPreset(before);
});
