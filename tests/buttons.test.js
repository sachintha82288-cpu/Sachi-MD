const test = require('node:test');
const assert = require('node:assert/strict');

// Delivery-ladder regression suite: card → logo image → plain text.
// The duplicate-menu bug (a rendered-but-unacked card followed by a second
// menu) must never come back.

process.env.MENU_BUTTONS = 'true';

const router = require('../src/router/router');
const config = require('../src/config');
const capabilities = require('../src/services/menu/capabilities');

router.loadCommands();

function sock(sent, { card = 'delivered', image = 'delivered', receipts = 'delivered' } = {}) {
  return {
    sendMessage: async (jid, content, opts) => {
      const key = { id: 'BOT-' + (sent.length + 1) };
      // 'react' = the instant command reaction, 'probe' = the tracked
      // receipt probe (only the probe carries trackDelivery).
      const kind = content && content.__interactive ? 'card'
        : content && content.image ? 'image'
          : content && content.react ? (opts && opts.trackDelivery ? 'probe' : 'react')
            : 'text';
      sent.push(kind);
      if (!opts || !opts.trackDelivery) return { key };
      const outcome = kind === 'card' ? card : kind === 'image' ? image : receipts;
      return { key, delivery: Promise.resolve(outcome) };
    }
  };
}

function msg(text = '.menu', jid = 'u@s.whatsapp.net') {
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random(), fromMe: false },
    pushName: 'T',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  };
}

const run = (s, m) => router.handle(s, m, config, (j, c, o) => s.sendMessage(j, c, o));

test('delivered card → nothing else is sent', async () => {
  capabilities.reset();
  const sent = [];
  await run(sock(sent), msg());
  assert.equal(sent.filter((k) => k === 'card').length, 1);
  assert.equal(sent.filter((k) => k === 'image').length, 0);
  assert.equal(sent.filter((k) => k === 'text').length, 0);
});

test('card rejected (error ack) → logo image menu', async () => {
  capabilities.reset();
  const sent = [];
  await run(sock(sent, { card: 'error' }), msg());
  assert.ok(sent.includes('card'));
  assert.ok(sent.includes('image'), 'image fallback');
  assert.equal(sent.filter((k) => k === 'image').length, 1);
});

test('card rejected AND image rejected → plain text menu', async () => {
  capabilities.reset();
  const sent = [];
  await run(sock(sent, { card: 'error', image: 'error' }), msg());
  assert.ok(sent.includes('text'), 'text fallback');
  assert.equal(sent.filter((k) => k === 'text').length, 1);
});

test('DM timeout with dead receipts → card kept, NO duplicate', async () => {
  capabilities.reset();
  const sent = [];
  await run(sock(sent, { card: 'timeout', receipts: 'timeout' }), msg());
  const cards = sent.filter((k) => k === 'card').length;
  const images = sent.filter((k) => k === 'image').length;
  const texts = sent.filter((k) => k === 'text').length;
  assert.equal(cards, 1);
  assert.equal(images + texts, 0, 'no duplicate menu');
});

test('DM timeout with working receipts → card replaced by the image menu', async () => {
  capabilities.reset();
  const sent = [];
  await run(sock(sent, { card: 'timeout', receipts: 'delivered' }), msg());
  assert.ok(sent.includes('image'), 'single image fallback');
  assert.equal(sent.filter((k) => k === 'image').length, 1);
});

test('group timeout → card kept, no probe, no duplicate', async () => {
  capabilities.reset();
  const sent = [];
  await run(sock(sent, { card: 'timeout' }), msg('.menu', 'g@g.us'));
  assert.equal(sent.filter((k) => k === 'card').length, 1);
  assert.equal(sent.filter((k) => k === 'probe').length, 0, 'no receipt probe in groups');
  assert.equal(sent.filter((k) => k === 'image').length, 0);
});

test('a chat that rejects the cards goes straight to the image menu next time', async () => {
  capabilities.reset();
  const sent = [];
  await run(sock(sent, { card: 'error' }), msg('.menu', 'a@s.whatsapp.net'));
  assert.ok(sent.includes('image'), 'image fallback used');
  const rec = capabilities.get('a@s.whatsapp.net');
  assert.ok(rec, 'capability recorded');

  sent.length = 0;
  await run(sock(sent, { card: 'error' }), msg('.menu', 'a@s.whatsapp.net'));
  assert.equal(sent.filter((k) => k === 'card').length, 0, 'rejected envelopes are not retried');
  assert.ok(sent.includes('image'), 'image menu used straight away');
});
