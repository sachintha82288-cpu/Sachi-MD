const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../src/router/router');
const config = require('../src/config');
const mode = require('../src/services/mode');

router.loadCommands();

const OWNER = '94700000001@s.whatsapp.net';   // the number the bot runs on
const FRIEND = '94700000002@s.whatsapp.net';
const GROUP = '1234567890@g.us';

function sock(sent) {
  return {
    sendMessage: async (jid, content, opts) => {
      sent.push({ jid, content, kind: content && content.image ? 'image' : 'text' });
      return { key: { id: 'BOT-' + (sent.length + 1) } };
    },
    waUploadToServer: async () => ({ mediaUrl: 'https://example.invalid/x' })
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

/** A config copy where the bot's own number is the owner. */
function asOwner() {
  return { ...config, owner: OWNER };
}

test('in "groups" mode a private chat is ignored (one notice only)', async () => {
  mode.set('groups');
  try {
    const sent = [];
    await run(sock(sent), msg('.ping', FRIEND), asOwner());
    const texts = sent.filter((s) => s.kind === 'text').map((s) => s.content.text);
    assert.equal(texts.length, 1, 'one notice');
    assert.ok(/🔕/.test(texts[0]), 'the notice explains the mode');
    // a second message in the same chat stays quiet
    await run(sock(sent), msg('.ping', FRIEND), asOwner());
    assert.equal(sent.filter((s) => s.kind === 'text').length, 1, 'no second notice');
  } finally { mode.set('all'); }
});

test('in "groups" mode a group chat is answered', async () => {
  mode.set('groups');
  try {
    const sent = [];
    await run(sock(sent), msg('.ping', GROUP, FRIEND), asOwner());
    const texts = sent.filter((s) => s.kind === 'text').map((s) => s.content.text);
    assert.ok(texts.length >= 1);
    assert.ok(!/🔕/.test(texts[0]), 'no mode notice');
  } finally { mode.set('all'); }
});

test('in "self" mode only the own chat is answered', async () => {
  mode.set('self');
  try {
    const sent = [];
    await run(sock(sent), msg('.ping', OWNER), asOwner());
    assert.ok(sent.filter((s) => s.kind === 'text').length >= 1, 'the own chat works');
    const sent2 = [];
    await run(sock(sent2), msg('.ping', FRIEND), asOwner());
    assert.ok(sent2.filter((s) => /🔕/.test(s.content.text || '')).length === 1, 'a friend chat is blocked');
  } finally { mode.set('all'); }
});

test('owner commands always work in the own chat — the bot cannot be locked out', async () => {
  mode.set('groups');
  try {
    const sent = [];
    await run(sock(sent), msg('.mode', OWNER), asOwner());
    const texts = sent.filter((s) => s.kind === 'text').map((s) => s.content.text);
    assert.ok(texts.some((t) => /Bot mode/.test(t)), 'the mode command answered');
  } finally { mode.set('all'); }
});

test('in "all" mode (default) every chat is answered', async () => {
  mode.set('all');
  const sent = [];
  await run(sock(sent), msg('.ping', FRIEND), asOwner());
  const texts = sent.filter((s) => s.kind === 'text').map((s) => s.content.text);
  assert.ok(texts.length >= 1);
  assert.ok(!/🔕/.test(texts[0]), 'no mode notice');
});
