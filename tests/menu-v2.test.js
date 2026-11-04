const test = require('node:test');
const assert = require('node:assert/strict');

const mb = require('../src/services/menubuttons');
const env = require('../src/services/menu/envelope');
const menu = require('../src/menu/menu');
const capabilities = require('../src/services/menu/capabilities');
const confirmSvc = require('../src/services/menu/confirm');

const router = require('../src/router/router');
const config = require('../src/config');

router.loadCommands();
const COMMANDS = router.list();

// The real shutdown command ends the process — stub it so the suite can
// confirm it without killing the test runner.
const shutdownCmd = COMMANDS.find((c) => c.name === 'shutdown');
if (shutdownCmd) shutdownCmd.execute = async ({ reply }) => { await reply({ text: '⛔ Shutting down...' }); };

/* ── helpers ─────────────────────────────────────────────────────────── */

function fakeSock(sent, { cardOutcome = 'delivered' } = {}) {
  return {
    sendMessage: async (jid, content, opts) => {
      const key = { id: 'BOT-' + (sent.length + 1) };
      sent.push({ key, content, opts });
      const isCard = content && content.__interactive;
      if (opts && opts.trackDelivery) {
        if (isCard) {
          return { key, delivery: Promise.resolve(cardOutcome) };
        }
        return { key, delivery: Promise.resolve(cardOutcome) };
      }
      return { key };
    }
  };
}

function plain(text, jid = 'u@s.whatsapp.net') {
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random(), fromMe: false },
    pushName: 'Tester',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  };
}

function tap(id, jid = 'u@s.whatsapp.net') {
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random(), fromMe: false },
    pushName: 'Tester',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { name: 'menu_options', paramsJson: JSON.stringify({ id }) },
        contextInfo: { stanzaId: 'X' }
      }
    }
  };
}

/* ── rows + limits ───────────────────────────────────────────────────── */

test('home rows: one per visible category plus navigation, inside the limits', () => {
  const rows = mb.homeRows(COMMANDS, true);
  assert.ok(rows.length <= env.LIMITS.rowsPerList, 'row budget respected');
  assert.ok(rows.length >= 8, 'all categories listed');
  assert.equal(rows[0].id, 'menu:cat:1');
  assert.equal(rows[rows.length - 1].id, 'menu:home');
  assert.ok(rows.some((r) => r.id === 'menu:refresh'), 'refresh row present');
  for (const r of rows) {
    assert.ok(r.title.length <= env.LIMITS.rowTitle, `title "${r.title}" <= 24`);
    assert.ok((r.description || '').length <= env.LIMITS.rowDescription, 'description <= 72');
    assert.ok(r.id.length <= env.LIMITS.rowId);
    assert.match(r.id, /^(menu|cmd):/);
  }
});

test('non-owner does not see the owner category in the button menu', () => {
  const rows = mb.homeRows(COMMANDS, false);
  const ownerRow = rows.find((r) => r.id === `menu:cat:${menu.categories.length}`);
  assert.equal(ownerRow, undefined, 'owner category hidden');
});

test('category rows: commands + home, paginated when a category is long', () => {
  const cat = menu.category(1); // downloaders
  const page0 = mb.categoryRows(cat, COMMANDS, true, 0, 1);
  assert.ok(page0.length <= env.LIMITS.rowsPerList, 'row budget respected');
  assert.equal(page0[page0.length - 1].id, 'menu:home');
  const pages = menu.pageCount(menu.categoryCommands(cat, COMMANDS, true).length);
  if (pages > 1) {
    const more = page0.find((r) => r.id.startsWith('menu:cat:1:'));
    assert.ok(more, 'more-pages row present');
    const page1 = mb.categoryRows(cat, COMMANDS, true, 1, 1);
    assert.ok(page1.some((r) => r.id === 'menu:home'), 'home reachable on every page');
  }
});

test('command rows carry the command id and a bounded description', () => {
  const cat = menu.category(1);
  const rows = mb.categoryRows(cat, COMMANDS, true, 0, 1);
  const cmdRow = rows.find((r) => r.id.startsWith('cmd:'));
  assert.ok(cmdRow, 'command row present');
  assert.match(cmdRow.title, /\./, 'title shows the prefix');
  assert.ok(cmdRow.title.length <= env.LIMITS.rowTitle);
});

/* ── envelopes ───────────────────────────────────────────────────────── */

test('wrapped envelope: viewOnce wrapper with messageContextInfo inside', () => {
  const p = mb.homePayload({ commands: COMMANDS, name: 'T', isOwner: true, variant: 'wrapped' });
  assert.equal(p.kind, 'native-wrapped');
  assert.ok(p.content.viewOnceMessage.message.interactiveMessage, 'interactive inside the wrapper');
  assert.ok(p.content.viewOnceMessage.message.messageContextInfo.deviceListMetadataVersion, 'context inside');
  assert.equal(p.content.messageContextInfo, undefined, 'no top-level context in the wrapped shape');
  const buttons = p.content.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons;
  assert.equal(buttons.length, menu.categories.length + 1, 'one button per category + help');
  for (const b of buttons) assert.equal(b.name, 'quick_reply', 'real buttons, no select-options list');
});

test('the menu buttons are English, inside the label limit, and Help is last', () => {
  const p = mb.homePayload({ commands: COMMANDS, name: 'T', isOwner: true });
  const buttons = p.content.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons;
  assert.ok(buttons.length <= env.LIMITS.buttons, 'inside the native-flow button budget');
  const parsed = buttons.map((b) => JSON.parse(b.buttonParamsJson));
  for (const p2 of parsed) {
    assert.ok(p2.display_text.length <= env.LIMITS.quickReplyText, `label "${p2.display_text}" <= 20`);
    assert.ok(!/[඀-෿]/.test(p2.display_text), 'english only: ' + p2.display_text);
  }
  assert.equal(parsed[parsed.length - 1].id, 'menu:help', 'help button is last');
  assert.ok(parsed[0].id.startsWith('menu:cat:'), 'categories come first');
});

test('the category card lists the commands and ends with help', () => {
  const cat = menu.category(1);
  const p = mb.categoryPayload({ cat, catIndex: 1, commands: COMMANDS, isOwner: true, page: 0 });
  const buttons = p.content.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons;
  const parsed = buttons.map((b) => JSON.parse(b.buttonParamsJson));
  assert.ok(buttons.length <= env.LIMITS.buttons, 'inside the native-flow button budget');
  assert.ok(parsed.some((x) => x.id.startsWith('cmd:')), 'command buttons');
  assert.equal(parsed[parsed.length - 1].id, 'menu:help', 'help button is last');
  assert.ok(parsed.some((x) => x.id === 'menu:home'), 'home button present');
});

test('bare envelope: top-level interactiveMessage + top-level context', () => {
  const p = mb.homePayload({ commands: COMMANDS, name: 'T', isOwner: true, variant: 'bare' });
  assert.equal(p.kind, 'native-bare');
  assert.ok(p.content.interactiveMessage, 'top-level interactive message');
  assert.equal(p.content.messageContextInfo.deviceListMetadataVersion, 2);
  assert.equal(p.content.viewOnceMessage, undefined);
});

test('binary wrapper nodes: biz → interactive(native_flow) → native_flow(v9,mixed) + bot in DMs', () => {
  const p = mb.homePayload({ commands: COMMANDS, name: 'T', isOwner: true });
  const biz = p.nodes.find((n) => n.tag === 'biz');
  assert.ok(biz, 'biz node present');
  const interactive = biz.content[0];
  assert.equal(interactive.tag, 'interactive');
  assert.equal(interactive.attrs.type, 'native_flow');
  assert.equal(interactive.attrs.v, '1');
  assert.equal(interactive.content[0].tag, 'native_flow');
  assert.equal(interactive.content[0].attrs.v, '9');
  assert.equal(interactive.content[0].attrs.name, 'mixed');
  const bot = p.nodes.find((n) => n.tag === 'bot');
  assert.ok(bot, 'bot node present for direct chats');
  assert.equal(bot.attrs.biz_bot, '1');
});

test('legacy list envelope: SINGLE_SELECT list + biz/list node', () => {
  const p = mb.homeListPayload({ commands: COMMANDS, name: 'T', isOwner: true });
  assert.equal(p.kind, 'list');
  assert.ok(p.content.listMessage, 'listMessage payload');
  const list = p.content.listMessage;
  assert.equal(list.listType, 1, 'SINGLE_SELECT');
  assert.ok(list.sections[0].rows.length <= env.LIMITS.rowsPerList);
  const biz = p.nodes.find((n) => n.tag === 'biz');
  assert.equal(biz.content[0].tag, 'list');
  assert.equal(biz.content[0].attrs.type, 'product_list');
  assert.equal(biz.content[0].attrs.v, '2');
});

test('candidate ladder: media card → plain card → list, preferred envelope first', () => {
  const spec = { screen: 'home', commands: COMMANDS, name: 'T', isOwner: true };
  const plain = mb.candidates(spec).map((c) => c.id);
  assert.deepEqual(plain, ['native-media', 'native-media-bare', 'native-plain', 'native-plain-bare', 'list']);
  const preferred = mb.candidates({ ...spec, preferred: 'list' }).map((c) => c.id);
  assert.deepEqual(preferred, ['list', 'native-media', 'native-media-bare', 'native-plain', 'native-plain-bare']);
  const skipped = mb.candidates({ ...spec, skip: ['native-media', 'native-media-bare'] }).map((c) => c.id);
  assert.deepEqual(skipped, ['native-plain', 'native-plain-bare', 'list']);
});

test('the logo card carries the logo as media header and a one-line body', () => {
  const p = mb.homePayload({ commands: COMMANDS, name: 'T', isOwner: true });
  const im = p.content.viewOnceMessage.message.interactiveMessage;
  assert.ok(p.media, 'media attached to the payload');
  assert.equal(p.media.image.url, mb.LOGO_PATH);
  assert.equal(im.header.hasMediaAttachment, false, 'flag only after the upload');
  const body = im.body.text;
  assert.ok(body.length < 80, 'short body: ' + body);
  assert.ok(body.includes('Tap a category'));
});

test('the plain card (no media) carries the full classic text menu', () => {
  const p = mb.homePayload({ commands: COMMANDS, name: 'T', isOwner: true, withMedia: false });
  const im = p.content.viewOnceMessage.message.interactiveMessage;
  assert.equal(p.media, null, 'no media');
  assert.equal(im.header.hasMediaAttachment, false);
  const body = im.body.text;
  assert.ok(body.length > 200, 'full menu text');
  assert.ok(body.includes(menu.sansB('SACHI MD')));
});

/* ── reply parsing ───────────────────────────────────────────────────── */

test('reply parsing covers every interactive reply shape', () => {
  assert.equal(mb.parseFlowResponse(tap('menu:home').message), 'menu:home');
  assert.equal(mb.parseFlowResponse(tap('cmd:apk').message), 'cmd:apk');
  assert.equal(mb.parseFlowResponse({ listResponseMessage: { singleSelectReply: { selectedRowId: 'menu:cat:2' } } }), 'menu:cat:2');
  assert.equal(mb.parseFlowResponse({ buttonsResponseMessage: { selectedButtonId: 'cmd:ping' } }), 'cmd:ping');
  assert.equal(mb.parseFlowResponse({ templateButtonReplyMessage: { selectedId: 'cmd:ping' } }), 'cmd:ping');
});

test('foreign or malformed ids are ignored', () => {
  assert.equal(mb.parseFlowResponse({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: 'not json' } } }), null);
  assert.equal(mb.parseFlowResponse({ interactiveResponseMessage: { nativeFlowResponseMessage: { paramsJson: JSON.stringify({ id: 'evil' }) } } }), null);
  assert.equal(mb.parseFlowResponse({ conversation: 'hello' }), null);
});

/* ── router behaviour ────────────────────────────────────────────────── */

// The MAIN number (the one linked from the terminal). `.shutdown` is a
// `mainOnly` command since multi-session landed, so these tests have to speak
// as that number — a jid with no digits in it can never be the main number.
const MAIN = '94750404115@s.whatsapp.net';

test('router: a category tap opens the category card', async () => {
  const sent = [];
  const sock = fakeSock(sent);
  await router.handle(sock, tap('menu:cat:1'), config, (j, c, o) => sock.sendMessage(j, c, o));
  const last = sent[sent.length - 1];
  assert.ok(last.content.__interactive, 'a card was sent');
  const im = last.content.content.viewOnceMessage.message.interactiveMessage;
  assert.ok(im.body.text.includes('Tap a command'), 'short card body: ' + im.body.text);
  assert.ok(last.content.media, 'the logo rides along with the category card');
  const buttons = im.nativeFlowMessage.buttons.map((b) => JSON.parse(b.buttonParamsJson));
  assert.ok(buttons.some((b) => b.id.startsWith('cmd:')), 'command buttons inside the card');
  assert.ok(im.footer.text.includes('Downloaders'), 'category name in the footer: ' + im.footer.text);
});

test('router: a command tap runs the command', async () => {
  const sent = [];
  const sock = fakeSock(sent);
  await router.handle(sock, tap('cmd:ping'), config, (j, c, o) => sock.sendMessage(j, c, o));
  const texts = sent.filter((s) => s.content && s.content.text).map((s) => s.content.text).join('\n');
  assert.ok(texts.includes('Pong'), 'ping answered: ' + texts.slice(0, 80));
});

test('router: typed "cmd:ping" text never executes a command', async () => {
  const sent = [];
  const sock = fakeSock(sent);
  await router.handle(sock, plain('cmd:ping'), config, (j, c, o) => sock.sendMessage(j, c, o));
  assert.equal(sent.length, 0);
});

test('router: destructive commands need a confirmation', async () => {
  confirmSvc.reset();
  const owner = config.owner;
  config.owner = MAIN;
  const sent = [];
  const sock = fakeSock(sent);
  await router.handle(sock, tap('cmd:shutdown', MAIN), config, (j, c, o) => sock.sendMessage(j, c, o));
  const card = sent.find((s) => s.content && s.content.__interactive);
  assert.ok(card, 'confirm card sent');
  const body = card.content.content.viewOnceMessage.message.interactiveMessage.body.text;
  assert.ok(body.includes('Confirm'), 'confirmation text');
  const buttons = card.content.content.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons;
  assert.equal(buttons[0].buttonParamsJson.includes('cmd:shutdown:confirm'), true);
  config.owner = owner;
});

test('router: a non-owner never gets the destructive confirmation card', async () => {
  confirmSvc.reset();
  const owner = config.owner;
  config.owner = 'owner@s.whatsapp.net';
  const sent = [];
  const sock = fakeSock(sent);
  await router.handle(sock, tap('cmd:shutdown'), config, (j, c, o) => sock.sendMessage(j, c, o));
  const texts = sent.filter((s) => s.content && s.content.text).map((s) => s.content.text).join('\n');
  assert.ok(/owner only/i.test(texts), 'blocked before the confirmation: ' + texts);
  assert.equal(sent.filter((s) => s.content && s.content.__interactive).length, 0, 'no card for non-owners');
  config.owner = owner;
});

test('router: confirm runs the command, cancel does not', async () => {
  confirmSvc.reset();
  const owner = config.owner;
  config.owner = MAIN;
  const sent = [];
  const sock = fakeSock(sent);
  await router.handle(sock, tap('cmd:shutdown', MAIN), config, (j, c, o) => sock.sendMessage(j, c, o));
  sent.length = 0;
  await router.handle(sock, tap('cmd:shutdown:cancel', MAIN), config, (j, c, o) => sock.sendMessage(j, c, o));
  const texts = sent.filter((s) => s.content && s.content.text).map((s) => s.content.text).join('\n');
  assert.ok(/Cancelled/i.test(texts), 'cancel acknowledged: ' + texts);

  sent.length = 0;
  await router.handle(sock, tap('cmd:shutdown', MAIN), config, (j, c, o) => sock.sendMessage(j, c, o));
  sent.length = 0;
  await router.handle(sock, tap('cmd:shutdown:confirm', MAIN), config, (j, c, o) => sock.sendMessage(j, c, o));
  const after = sent.filter((s) => s.content && s.content.text).map((s) => s.content.text).join('\n');
  assert.ok(/Shutting down/i.test(after), 'command executed after confirmation: ' + after);
  config.owner = owner;
});

test('router: an expired confirmation is refused', async () => {
  confirmSvc.reset();
  const sent = [];
  const sock = fakeSock(sent);
  await router.handle(sock, tap('cmd:shutdown:confirm'), config, (j, c, o) => sock.sendMessage(j, c, o));
  const texts = sent.filter((s) => s.content && s.content.text).map((s) => s.content.text).join('\n');
  assert.ok(/expired/i.test(texts), 'expired confirmation refused: ' + texts);
});

test('router: a typed "cmd confirm" runs the destructive command', async () => {
  confirmSvc.reset();
  const owner = config.owner;
  config.owner = MAIN;
  const sent = [];
  const sock = fakeSock(sent);
  await router.handle(sock, plain('.shutdown', MAIN), config, (j, c, o) => sock.sendMessage(j, c, o));
  const after = sent.filter((s) => s.content && s.content.text).map((s) => s.content.text).join('\n');
  assert.ok(/Confirm action/i.test(after), 'confirmation asked: ' + after);
  assert.ok(!/Shutting down/i.test(after), 'not executed yet');

  sent.length = 0;
  await router.handle(sock, plain('.shutdown confirm', MAIN), config, (j, c, o) => sock.sendMessage(j, c, o));
  const done = sent.filter((s) => s.content && s.content.text).map((s) => s.content.text).join('\n');
  assert.ok(/Shutting down/i.test(done), 'executed after the typed confirmation: ' + done);
  config.owner = owner;
});

test('router: the "More" pager opens the next category page', async () => {
  capabilities.reset();
  const sent = [];
  const sock = fakeSock(sent);
  const cat = menu.category(1); // downloaders — the longest category
  const pages = menu.pageCount(menu.categoryCommands(cat, COMMANDS, true).length);
  if (pages < 2) return; // no pager needed
  await router.handle(sock, tap('menu:cat:1:1'), config, (j, c, o) => sock.sendMessage(j, c, o));
  const card = sent.find((s) => s.content && s.content.__interactive);
  assert.ok(card, 'page 2 card sent');
  const buttons = card.content.content.viewOnceMessage.message.interactiveMessage
    .nativeFlowMessage.buttons.map((b) => JSON.parse(b.buttonParamsJson));
  assert.equal(buttons[0].id.startsWith('cmd:'), true, 'page 2 starts with a command button');
  assert.equal(buttons[buttons.length - 1].id, 'menu:help', 'help stays last');
});

/* ── capability memory ──────────────────────────────────────────────── */

test('capability memory remembers the working envelope per chat', () => {
  capabilities.reset();
  assert.equal(capabilities.preferredEnvelope('x@s.whatsapp.net'), null);
  capabilities.remember('x@s.whatsapp.net', { envelope: 'list', receipts: false });
  assert.equal(capabilities.preferredEnvelope('x@s.whatsapp.net'), 'list');
  assert.equal(capabilities.receiptsAlive('x@s.whatsapp.net'), false);
  capabilities.reset();
  assert.equal(capabilities.preferredEnvelope('x@s.whatsapp.net'), null);
});

/* ── confirm registry ────────────────────────────────────────────────── */

test('confirmations are per chat + sender and expire', () => {
  confirmSvc.reset();
  confirmSvc.request('c1@s.whatsapp.net', 'u1@s.whatsapp.net', 'shutdown', 'Stop the bot');
  assert.ok(confirmSvc.peek('c1@s.whatsapp.net', 'u1@s.whatsapp.net'));
  assert.equal(confirmSvc.peek('c1@s.whatsapp.net', 'u2@s.whatsapp.net'), null, 'other sender blocked');
  assert.equal(confirmSvc.peek('c2@s.whatsapp.net', 'u1@s.whatsapp.net'), null, 'other chat blocked');
  assert.ok(confirmSvc.consume('c1@s.whatsapp.net', 'u1@s.whatsapp.net'));
  assert.equal(confirmSvc.peek('c1@s.whatsapp.net', 'u1@s.whatsapp.net'), null, 'consumed once');
});

test('destructive set covers the dangerous commands', () => {
  for (const name of ['shutdown', 'restart', 'unpair', 'setprefix', 'cleanup']) {
    assert.equal(confirmSvc.isDestructive(name), true, name);
  }
  // .antiban only needs a confirmation for the parts that change the
  // protection — reading the status must not ask for one.
  assert.equal(confirmSvc.isDestructive('antiban', ['off']), true);
  assert.equal(confirmSvc.isDestructive('antiban', ['reset']), true);
  assert.equal(confirmSvc.isDestructive('antiban', ['status']), false);
  assert.equal(confirmSvc.isDestructive('antiban', ['conservative']), false);
  assert.equal(confirmSvc.isDestructive('ping'), false);
});
