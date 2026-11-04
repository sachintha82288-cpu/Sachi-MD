const { test } = require('node:test');
const assert = require('node:assert/strict');

test('config: built-in default pairing number is 94750404115', () => {
  const saved = process.env.WA_PHONE_NUMBER;
  delete process.env.WA_PHONE_NUMBER;
  delete require.cache[require.resolve('../src/utils/envLoader')];
  delete require.cache[require.resolve('../src/config')];
  const config = require('../src/config');
  assert.equal(config.phoneNumber, '94750404115');
  assert.equal(config.ownerNumber, '94750404115');
  if (saved !== undefined) process.env.WA_PHONE_NUMBER = saved;
  else delete process.env.WA_PHONE_NUMBER;
});

test('unpair: only the owner number may unpair sessions', async () => {
  const config = require('../src/config');
  const sessionManager = require('../src/whatsapp/sessionManager');
  const unpairCmd = require('../src/commands/owner/unpair');
  assert.equal(unpairCmd.ownerOnly, true);

  // a DIFFERENT number → denied
  const replies = [];
  const deniedCtx = {
    sender: '94771234567@s.whatsapp.net', jid: '94771234567@s.whatsapp.net',
    config, args: ['94770000000'],
    reply: async (c) => { replies.push(c.text); return { key: { id: 'x' } }; },
  };
  await unpairCmd.execute(deniedCtx);
  assert.ok(replies[0].includes('⛔') && replies[0].includes('+94750404115'), 'denied with owner-number message');

  // the OWNER number → allowed (sessionManager.unpair mocked)
  const calls = [];
  const realUnpair = sessionManager.unpair;
  sessionManager.unpair = async (phone) => { calls.push(phone); };
  const okCtx = {
    sender: '94750404115@s.whatsapp.net', jid: '94750404115@s.whatsapp.net',
    config: { ...config, owner: '94750404115@s.whatsapp.net' }, prefix: '.', args: ['94771234567'],
    reply: async (c) => { replies.push(c.text); return { key: { id: 'y' } }; },
  };
  await unpairCmd.execute(okCtx);
  assert.deepEqual(calls, ['94771234567'], 'owner number proceeds to unpair');
  sessionManager.unpair = realUnpair;
});
