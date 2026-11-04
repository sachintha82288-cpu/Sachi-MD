const test = require('node:test');
const assert = require('node:assert/strict');

// Anti-ban pacing would add seconds of wall time to every send in this
// file — the wire format does not care.
process.env.ANTIBAN_ENABLED = 'false';

const { generateWAMessageFromContent, proto, prepareWAMessageMedia } = require('@whiskeysockets/baileys');
const mb = require('../src/services/menubuttons');
const router = require('../src/router/router');

router.loadCommands();
const COMMANDS = router.list();

/** Fake WhatsApp media upload — no network, but a realistic result. */
async function fakeUpload() {
  return {
    mediaUrl: 'https://mmg.whatsapp.net/v/t62/logo',
    mediaKey: Buffer.alloc(32, 7),
    directPath: '/v/t62/logo',
    handle: 'logo',
    fileEncSha256: Buffer.alloc(32, 1),
    fileSha256: Buffer.alloc(32, 2)
  };
}

function fakeSession(relay) {
  return {
    id: 'test',
    sock: {
      user: { id: '947700000000:1@s.whatsapp.net' },
      waUploadToServer: fakeUpload,
      relayMessage: relay
    },
    ackWaiters: new Map(),
    sentIds: new Set(),
    messageCache: new Map()
  };
}

test('the logo card survives the proto encode/decode round trip', () => {
  const built = mb.homePayload({ commands: COMMANDS, name: 'Tester', isOwner: true });
  const msg = generateWAMessageFromContent('947700000000@s.whatsapp.net', built.content, {
    userJid: '947700000000:1@s.whatsapp.net'
  });
  const decoded = proto.Message.decode(proto.Message.encode(msg.message).finish());
  const interactive = decoded.viewOnceMessage.message.interactiveMessage;
  assert.ok(interactive, 'interactive message on the wire');
  assert.equal(interactive.header.hasMediaAttachment, false, 'no media flag before the upload');
  assert.equal(interactive.nativeFlowMessage.buttons.length, 9, '8 categories + help');
  const first = JSON.parse(interactive.nativeFlowMessage.buttons[0].buttonParamsJson);
  assert.equal(first.id, 'menu:cat:1');
  const last = JSON.parse(interactive.nativeFlowMessage.buttons[8].buttonParamsJson);
  assert.equal(last.id, 'menu:help', 'help button last on the wire');
  const context = decoded.viewOnceMessage.message.messageContextInfo;
  assert.equal(context.deviceListMetadataVersion, 2, 'device list metadata on the wire');
});

test('the logo card carries the uploaded image on the wire', async () => {
  const built = mb.homePayload({ commands: COMMANDS, name: 'Tester', isOwner: true });
  const prepared = await prepareWAMessageMedia(built.media, { upload: fakeUpload });
  const payload = require('../src/services/menu/envelope').attachMedia(built.content, prepared);
  const msg = generateWAMessageFromContent('947700000000@s.whatsapp.net', payload, {
    userJid: '947700000000:1@s.whatsapp.net'
  });
  const decoded = proto.Message.decode(proto.Message.encode(msg.message).finish());
  const header = decoded.viewOnceMessage.message.interactiveMessage.header;
  assert.equal(header.hasMediaAttachment, true);
  assert.ok(header.imageMessage, 'image on the wire');
  assert.equal(header.imageMessage.mimetype, 'image/jpeg');
  assert.equal(header.imageMessage.fileLength > 0, true, 'real file size on the wire');
  assert.ok(header.imageMessage.mediaKey.length, 'media key on the wire');
});

test('the legacy list card survives the round trip too', () => {
  const built = mb.homeListPayload({ commands: COMMANDS, name: 'Tester', isOwner: true });
  const msg = generateWAMessageFromContent('947700000000@s.whatsapp.net', built.content, {
    userJid: '947700000000:1@s.whatsapp.net'
  });
  const decoded = proto.Message.decode(proto.Message.encode(msg.message).finish());
  assert.ok(decoded.listMessage, 'list message on the wire');
  assert.equal(decoded.listMessage.listType, 1, 'SINGLE_SELECT');
  assert.ok(decoded.listMessage.sections[0].rows.length > 0);
});

test('relayMessage receives the binary wrapper nodes and the logo', async () => {
  const sessionManager = require('../src/whatsapp/sessionManager');
  let captured = null;
  const session = fakeSession(async (jid, message, opts) => { captured = { jid, message, opts }; return 'MSGID'; });
  const send = sessionManager.createSend(session);
  const built = mb.homePayload({ commands: COMMANDS, name: 'Tester', isOwner: true });
  const sent = await send('947700000000@s.whatsapp.net', built, { trackDelivery: true });

  assert.ok(captured, 'relayMessage called');
  assert.ok(captured.opts.additionalNodes, 'additionalNodes passed through');
  const biz = captured.opts.additionalNodes.find((n) => n.tag === 'biz');
  assert.ok(biz, 'biz node');
  assert.equal(biz.content[0].content[0].attrs.v, '9');
  assert.equal(biz.content[0].content[0].attrs.name, 'mixed');
  assert.ok(captured.opts.additionalNodes.find((n) => n.tag === 'bot'), 'bot node for direct chats');
  assert.ok(sent.delivery, 'delivery promise attached');

  const decoded = proto.Message.decode(proto.Message.encode(captured.message).finish());
  const header = decoded.viewOnceMessage.message.interactiveMessage.header;
  assert.equal(header.hasMediaAttachment, true, 'logo header on the relayed stanza');
  assert.ok(header.imageMessage, 'logo image on the relayed stanza');
});

test('the delivery waiter is registered before the relay (no lost ack)', async () => {
  const sessionManager = require('../src/whatsapp/sessionManager');
  let waiterAtRelay = null;
  const session = fakeSession(async (jid, message, opts) => {
    waiterAtRelay = session.ackWaiters.has(opts.messageId);
    return 'MSGID';
  });
  const send = sessionManager.createSend(session);
  const built = mb.homePayload({ commands: COMMANDS, name: 'Tester', isOwner: true });
  await send('947700000000@s.whatsapp.net', built, { trackDelivery: true });
  assert.equal(waiterAtRelay, true, 'waiter exists while the stanza is on the wire');
});

test('a broken media upload fails the card instead of sending an empty header', async () => {
  const sessionManager = require('../src/whatsapp/sessionManager');
  const session = fakeSession(async () => 'MSGID');
  session.sock.waUploadToServer = async () => { throw new Error('network down'); };
  const send = sessionManager.createSend(session);
  const built = mb.homePayload({ commands: COMMANDS, name: 'Tester', isOwner: true });
  await assert.rejects(
    () => send('947700000000@s.whatsapp.net', built, { trackDelivery: true }),
    /media upload failed/
  );
});
