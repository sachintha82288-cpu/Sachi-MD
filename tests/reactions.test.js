const test = require('node:test');
const assert = require('node:assert/strict');
const reactions = require('../src/services/reactions');

test('limiter: global per-minute cap', async () => {
  reactions.reset();
  reactions.setHealthProbe(() => false);
  const sock = { sendMessage: async () => {} };
  for (let i = 0; i < 20; i++) {
    assert.equal(await reactions.react(sock, 'jid' + i, { id: 'K' + i }, '⚡'), true, 'send ' + i);
  }
  assert.equal(reactions.check('jidX').allowed, false);
  assert.equal(reactions.check('jidX').reason, 'global_cap');
});

test('limiter: per-chat cooldown, other chats unaffected', async () => {
  reactions.reset();
  reactions.setHealthProbe(() => false);
  const sock = { sendMessage: async () => {} };
  assert.equal(await reactions.react(sock, 'a', { id: '1' }, '⚡'), true);
  assert.equal(reactions.check('a').reason, 'cooldown');
  assert.equal(await reactions.react(sock, 'a', { id: '2' }, '⚡'), false);
  assert.equal(await reactions.react(sock, 'b', { id: '3' }, '⚡'), true);
});

test('disabled via setEnabled and health-paused probe both block', () => {
  reactions.reset();
  reactions.setEnabled(false);
  assert.equal(reactions.check('a').reason, 'disabled');
  reactions.setEnabled(true);
  reactions.setHealthProbe(() => true);
  assert.equal(reactions.check('a').reason, 'paused');
  reactions.setHealthProbe(() => false);
  assert.equal(reactions.check('a').allowed, true);
  reactions.reset();
});

test('react() sends through the sock with the given key and emoji', async () => {
  reactions.reset();
  reactions.setHealthProbe(() => false);
  const sent = [];
  const sock = { sendMessage: async (jid, content) => sent.push({ jid, content }) };
  const key = { remoteJid: 'j@s.whatsapp.net', id: 'MSG1', fromMe: false };
  const ok = await reactions.react(sock, 'j@s.whatsapp.net', key, '🤖');
  assert.equal(ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].content, { react: { text: '🤖', key } });
});

test('react() swallows sock failures and never throws', async () => {
  reactions.reset();
  const sock = { sendMessage: async () => { throw new Error('boom'); } };
  const ok = await reactions.react(sock, 'j', { id: 'K' }, '⚡');
  assert.equal(ok, false);
});

test('react() respects the limiter (second call inside cooldown is skipped)', async () => {
  reactions.reset();
  const sent = [];
  const sock = { sendMessage: async (j, c) => sent.push(c) };
  const key = { id: 'K1' };
  await reactions.react(sock, 'same-jid', key, '⚡');
  const ok2 = await reactions.react(sock, 'same-jid', { id: 'K2' }, '⚡');
  assert.equal(ok2, false);
  assert.equal(sent.length, 1);
});
