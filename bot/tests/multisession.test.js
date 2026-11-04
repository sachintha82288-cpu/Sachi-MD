/**
 * Multi-session behaviour — the round-9 contract:
 *
 *   • anybody may `.pair`, and with no number it pairs THEIR OWN number
 *   • only the MAIN number (the one linked from the terminal) manages
 *     sessions and the bot-wide settings — the commands are hidden from the
 *     menu AND refused at execution time
 *   • everybody may customise their OWN bot (name / header / footer / logo)
 *   • a paired session's menu, cards and help wear that session's branding
 *
 * WhatsApp is stubbed; the router, the commands and the branding store are
 * the real ones.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const router = require('../src/router/router');
const branding = require('../src/services/branding');
const settings = require('../src/services/settings');
const pairing = require('../src/services/pairing');
const sessionManager = require('../src/whatsapp/sessionManager');
const mb = require('../src/services/menubuttons');
const menu = require('../src/menu/menu');

const MAIN = '94750404115';
const MAIN_JID = `${MAIN}@s.whatsapp.net`;
const PAIRED = '94771234567';
const PAIRED_JID = `${PAIRED}@s.whatsapp.net`;

router.loadCommands();
const ALL = router.list();

const SETTINGS_FILE = path.join(config.paths.data, 'settings.json');
const BRAND_FILE = path.join(config.paths.data, 'branding.json');
const origSettings = fs.existsSync(SETTINGS_FILE) ? fs.readFileSync(SETTINGS_FILE) : null;
const origBrand = fs.existsSync(BRAND_FILE) ? fs.readFileSync(BRAND_FILE) : null;
// Whatever these tests wrote, the data files go back to how they were —
// a test suite must not leave a renamed bot behind in a deployment.
after(() => {
  const put = (f, buf) => { try { if (buf == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, buf); } catch {} };
  put(SETTINGS_FILE, origSettings);
  put(BRAND_FILE, origBrand);
  try { branding.reload(); } catch {}
});

/* ── stubs ─────────────────────────────────────────────────────────────── */
const realSm = {
  pairNumber: sessionManager.pairNumber,
  refreshPairingCode: sessionManager.refreshPairingCode,
  teardownPending: sessionManager.teardownPending,
  isLinked: sessionManager.isLinked,
  listSessions: sessionManager.listSessions,
  getPrimary: sessionManager.getPrimary,
  unpair: sessionManager.unpair,
};
let linked, calls, seq;
function stub() {
  linked = new Set(); seq = 0;
  calls = { pair: [], refresh: 0, teardown: 0, unpair: [] };
  sessionManager.pairNumber = async (phone) => { calls.pair.push(String(phone)); seq++; return { phone, code: `QQ${String(seq).padStart(2, '0')}WW${String(seq).padStart(2, '0')}`, restored: false }; };
  sessionManager.refreshPairingCode = async () => { calls.refresh++; seq++; return `RR${String(seq).padStart(2, '0')}TT${String(seq).padStart(2, '0')}`; };
  sessionManager.teardownPending = () => { calls.teardown++; };
  sessionManager.isLinked = (p) => linked.has(String(p));
  sessionManager.listSessions = () => [
    { id: 'primary', phone: MAIN, isPrimary: true, connected: true, state: 'connected', name: 'Main', jid: MAIN_JID, startedAt: Date.now() - 5000 },
    ...[...linked].map((p) => ({ id: p, phone: p, isPrimary: false, connected: true, state: 'connected', name: 'Paired', jid: `${p}@s.whatsapp.net`, startedAt: Date.now() })),
  ];
  sessionManager.getPrimary = () => ({ phone: MAIN, jid: MAIN_JID });
  sessionManager.unpair = async (p) => { calls.unpair.push(String(p)); linked.delete(String(p)); };
}
function unstub() { Object.assign(sessionManager, realSm); }

function resetEnv() {
  for (const k of ['PAIR_MAX_SESSIONS', 'PAIR_COOLDOWN_MS', 'PAIR_MAX_PER_PHONE', 'PAIR_MAX_PER_IP', 'PAIR_PUBLIC_URL', 'SERVER_IP', 'PAIR_MODE']) delete process.env[k];
  process.env.PAIR_COOLDOWN_MS = '0';
  process.env.PAIR_MAX_PER_PHONE = '50';
  process.env.PAIR_MAX_PER_IP = '50';
}

/** A chat ctx shaped like the router builds it, for calling a command directly. */
function ctxFor({ jid, isMain = false, args = [], brandKey = null, prefix = '.' }) {
  const key = brandKey || (isMain ? 'primary' : jid);
  const replies = [];
  const sessionCfg = {
    ...config,
    owner: isMain ? MAIN_JID : jid,
    ownerNumber: MAIN,
    sessionIsPrimary: isMain,
    sessionId: isMain ? 'primary' : key,
    brandKey: key,
    brand: branding.forKey(key),
    prefix,
  };
  return {
    replies,
    sock: {}, msg: { key: { id: 'M1', remoteJid: jid, fromMe: false } },
    jid, sender: jid, isGroup: false, isOwner: true, isSelf: false, isMain,
    brand: sessionCfg.brand, brandKey: key, config: sessionCfg, prefix,
    cmdName: 'x', args, quotedMsg: null, target: null, pushName: 'Tester',
    commands: router.visibleList(sessionCfg, jid, jid),
    reply: async (c) => { replies.push(typeof c === 'string' ? c : c.text || JSON.stringify(c)); return { key: { id: 'R' + replies.length } }; },
    send: async (j, c) => { replies.push(typeof c === 'string' ? c : c.text || ''); return { key: { id: 'S1' } }; },
    edit: async () => ({ key: { id: 'E1' } }),
  };
}

/* ── .pair ─────────────────────────────────────────────────────────────── */

test('.pair with no number pairs the number that SENT it', async (t) => {
  stub(); resetEnv(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  const pair = ALL.find((c) => c.name === 'pair');

  const ctx = ctxFor({ jid: PAIRED_JID, isMain: false });
  await pair.execute(ctx);
  assert.deepEqual(calls.pair, [PAIRED], 'the sender\'s own number was paired');
  const text = ctx.replies.join('\n');
  assert.match(text, /pairing code/i);
  assert.match(text, /\+\s?94771234567/);
  assert.match(text, /[A-Z0-9]{4}-[A-Z0-9]{4}/, 'the code is printed grouped');
  assert.match(text, /Linked devices/i, 'and the three steps to use it');
});

test('.pair understands a jid, a device suffix and a trunk prefix as "my number"', async (t) => {
  stub(); resetEnv(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  const pair = ALL.find((c) => c.name === 'pair');
  const ctx = ctxFor({ jid: '94779998887:14@s.whatsapp.net', isMain: false });
  await pair.execute(ctx);
  assert.deepEqual(calls.pair, ['94779998887'], 'the device suffix never becomes part of the number');
});

test('.pair <another number> is main-only, and says what to do instead', async (t) => {
  stub(); resetEnv(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  const pair = ALL.find((c) => c.name === 'pair');

  const ctx = ctxFor({ jid: PAIRED_JID, isMain: false, args: ['94770001111'] });
  await pair.execute(ctx);
  assert.deepEqual(calls.pair, [], 'WhatsApp was never asked');
  assert.match(ctx.replies.join('\n'), /⛔/);
  assert.match(ctx.replies.join('\n'), /main/i);
  assert.match(ctx.replies.join('\n'), /\.pair/, 'it still tells them how to pair their own');

  const main = ctxFor({ jid: MAIN_JID, isMain: true, args: ['+94 (0) 770-001-111'] });
  await pair.execute(main);
  assert.deepEqual(calls.pair, ['94770001111'], 'the main number may pair somebody else');
  assert.match(main.replies.join('\n'), /pairing code/i);
});

test('.pair refuses to re-pair the bot\'s own number with a helpful reason', async (t) => {
  stub(); resetEnv(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  const pair = ALL.find((c) => c.name === 'pair');
  const ctx = ctxFor({ jid: MAIN_JID, isMain: true, args: [MAIN] });
  await pair.execute(ctx);
  assert.deepEqual(calls.pair, []);
  const text = ctx.replies.join('\n');
  assert.match(text, /❌/);
  assert.match(text, /bot's own number/i);
});

test('.pair refresh gets a new code, and explains itself when nothing is waiting', async (t) => {
  stub(); resetEnv(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  const pair = ALL.find((c) => c.name === 'pair');

  const empty = ctxFor({ jid: PAIRED_JID, args: ['refresh'] });
  await pair.execute(empty);
  assert.equal(calls.refresh, 0);
  assert.match(empty.replies.join('\n'), /Nothing is waiting/i);

  const first = ctxFor({ jid: PAIRED_JID });
  await pair.execute(first);
  const before = first.replies.join('\n');

  const again = ctxFor({ jid: PAIRED_JID, args: ['again'] });
  await pair.execute(again);
  assert.equal(calls.refresh, 1, 'refresh went to WhatsApp');
  const after = again.replies.join('\n');
  assert.match(after, /pairing code/i);
  assert.notEqual(after.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0], before.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0], 'a different code');
});

test('.pair reports an already-linked number instead of pairing it twice', async (t) => {
  stub(); resetEnv(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  linked.add(PAIRED);
  const pair = ALL.find((c) => c.name === 'pair');
  const ctx = ctxFor({ jid: PAIRED_JID });
  await pair.execute(ctx);
  assert.deepEqual(calls.pair, []);
  assert.match(ctx.replies.join('\n'), /already paired/i);
});

test('.pair points at the pair website, and warns when the address is private', async (t) => {
  stub(); resetEnv(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  const pair = ALL.find((c) => c.name === 'pair');

  process.env.PAIR_PUBLIC_URL = 'http://203.0.113.9:3000/';
  const pub = ctxFor({ jid: PAIRED_JID });
  await pair.execute(pub);
  assert.match(pub.replies.join('\n'), /203\.0\.113\.9:3000/, 'the detected link is in the reply');
  assert.ok(!/private/i.test(pub.replies.join('\n')), 'a public address needs no warning');
  delete process.env.PAIR_PUBLIC_URL;

  process.env.SERVER_IP = '10.0.0.4';
  const priv = ctxFor({ jid: '94770002222@s.whatsapp.net' });
  await pair.execute(priv);
  const text = priv.replies.join('\n');
  assert.match(text, /10\.0\.0\.4/);
  assert.match(text, /PAIR_PUBLIC_URL/, 'the owner is told how to fix a private address');
  delete process.env.SERVER_IP;
});

/* ── the main-number gate ──────────────────────────────────────────────── */

test('mainOnly: the commands exist, and only the main number can see them', () => {
  const mainOnly = ALL.filter((c) => c.mainOnly);
  assert.ok(mainOnly.length >= 12, 'session/bot-wide commands are gated: ' + mainOnly.length);
  for (const name of ['sessions', 'unpair', 'restart', 'shutdown', 'antiban', 'health', 'setprefix', 'mode']) {
    const c = ALL.find((x) => x.name === name);
    assert.ok(c, `${name} exists`);
    assert.equal(c.mainOnly, true, `${name} is main-only`);
  }
  // things everybody needs must NOT be gated
  for (const name of ['pair', 'menu', 'mybot', 'setname', 'setheader', 'setfooter', 'setlogo', 'settagline', 'ping']) {
    const c = ALL.find((x) => x.name === name);
    assert.ok(c, `${name} exists`);
    assert.notEqual(c.mainOnly, true, `${name} is available to every session`);
  }

  const asMain = router.visibleList({ ownerNumber: MAIN, owner: MAIN_JID, sessionIsPrimary: true, sessionId: 'primary', prefix: '.' }, MAIN_JID, MAIN_JID);
  const asPaired = router.visibleList({ ownerNumber: MAIN, owner: PAIRED_JID, sessionIsPrimary: false, sessionId: PAIRED, prefix: '.' }, PAIRED_JID, PAIRED_JID);
  assert.ok(asMain.length > asPaired.length, 'the main number sees more');
  assert.equal(asMain.filter((c) => c.mainOnly).length, mainOnly.length);
  assert.equal(asPaired.filter((c) => c.mainOnly).length, 0, 'a paired session sees none of them');
  assert.ok(asPaired.some((c) => c.name === 'pair') && asPaired.some((c) => c.name === 'mybot'));
});

test('mainOnly: typing a gated command from a paired number is refused, not executed', async (t) => {
  stub(); resetEnv();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  const sessionsCmd = ALL.find((c) => c.name === 'sessions');
  const realExec = sessionsCmd.execute;
  let ran = 0;
  sessionsCmd.execute = async (ctx) => { ran++; return realExec.call(sessionsCmd, ctx); };

  const sent = [];
  const sock = { sendMessage: async (jid, content) => { sent.push(content); return { key: { id: 'X' } }; } };
  const pairedCfg = { ...config, owner: PAIRED_JID, ownerNumber: MAIN, sessionIsPrimary: false, brandKey: PAIRED, brand: branding.forKey(PAIRED), prefix: '.' };
  await router.handle(sock, textMsg('.sessions', PAIRED_JID), pairedCfg, (j, c, o) => sock.sendMessage(j, c, o));
  assert.equal(ran, 0, 'the command never ran');
  const text = sent.filter((c) => c && c.text).map((c) => c.text).join('\n');
  assert.match(text, /⛔/);
  assert.match(text, /main bot number/i);
  assert.match(text, /\+94750404115/, 'it names the number that may do it');
  assert.match(text, /\.mybot/, 'and points at what the caller CAN do');

  // the main number gets through
  sent.length = 0;
  const mainCfg = { ...config, owner: MAIN_JID, ownerNumber: MAIN, sessionIsPrimary: true, brandKey: 'primary', brand: branding.forKey('primary'), prefix: '.' };
  await router.handle(sock, textMsg('.sessions', MAIN_JID), mainCfg, (j, c, o) => sock.sendMessage(j, c, o));
  assert.equal(ran, 1, 'the main number runs it');
  sessionsCmd.execute = realExec;
});

function textMsg(text, jid) {
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random().toString(36).slice(2), fromMe: false },
    pushName: 'Tester', messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text },
  };
}
function tapMsg(id, jid) {
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random().toString(36).slice(2), fromMe: false },
    pushName: 'Tester', messageTimestamp: Math.floor(Date.now() / 1000),
    message: {
      interactiveResponseMessage: {
        nativeFlowResponseMessage: { name: 'menu_options', paramsJson: JSON.stringify({ id }) },
        contextInfo: { stanzaId: 'X' },
      },
    },
  };
}

test('the menu cards a paired session gets contain no main-only command', async (t) => {
  stub(); resetEnv();
  t.after(() => { unstub(); resetEnv(); });
  const sent = [];
  const sock = { sendMessage: async (jid, content) => { sent.push(content); return { key: { id: 'X' }, delivery: Promise.resolve('delivered') }; } };
  const send = (j, c, o) => sock.sendMessage(j, c, o);
  const buttonsOf = (card) => card.content.viewOnceMessage.message.interactiveMessage.nativeFlowMessage.buttons
    .map((b) => JSON.parse(b.buttonParamsJson).id);
  const cardIn = () => sent.find((c) => c && c.__interactive);

  /** Every `cmd:` button reachable from the home card, one category tap at a time. */
  async function allCommandButtons(cfg, jid) {
    sent.length = 0;
    await router.handle(sock, textMsg('.menu', jid), cfg, send);
    const home = cardIn();
    assert.ok(home, 'a home card was sent');
    const homeIds = buttonsOf(home);
    assert.ok(homeIds.length > 3, 'the home card has buttons: ' + homeIds.length);
    assert.equal(homeIds[homeIds.length - 1], 'menu:help', 'Help is the last button');
    const cmdIds = [];
    for (const id of homeIds.filter((x) => /^menu:cat:\d+$/.test(x))) {
      sent.length = 0;
      await router.handle(sock, tapMsg(id, jid), cfg, send);
      const card = cardIn();
      if (card) cmdIds.push(...buttonsOf(card).filter((x) => x.startsWith('cmd:')));
    }
    return { homeIds, cmdIds };
  }

  const pairedCfg = { ...config, owner: PAIRED_JID, ownerNumber: MAIN, sessionIsPrimary: false, sessionId: PAIRED, brandKey: PAIRED, brand: branding.forKey(PAIRED), prefix: '.' };
  const paired = await allCommandButtons(pairedCfg, PAIRED_JID);
  assert.ok(paired.cmdIds.length > 5, 'a paired session still gets plenty of command buttons: ' + paired.cmdIds.length);
  for (const id of paired.cmdIds) {
    const name = id.replace(/^cmd:/, '').replace(/:(confirm|cancel)$/, '');
    const cmd = ALL.find((c) => c.name === name);
    assert.ok(!cmd || !cmd.mainOnly, `a main-only command (${name}) was offered to a paired session`);
  }
  for (const banned of ['cmd:sessions', 'cmd:unpair', 'cmd:restart', 'cmd:antiban', 'cmd:shutdown', 'cmd:setprefix']) {
    assert.ok(!paired.cmdIds.includes(banned), `${banned} must not be offered`);
  }

  const mainCfg = { ...config, owner: MAIN_JID, ownerNumber: MAIN, sessionIsPrimary: true, sessionId: 'primary', brandKey: 'primary', brand: branding.forKey('primary'), prefix: '.' };
  const main = await allCommandButtons(mainCfg, MAIN_JID);
  const mainNames = main.cmdIds.map((x) => x.replace(/^cmd:/, ''));
  assert.ok(mainNames.length > 0, 'the main number gets command buttons inside its category cards');
  assert.ok(['sessions', 'unpair', 'antiban', 'health', 'restart'].some((n) => mainNames.includes(n)),
    'the main number sees its management commands: ' + mainNames.slice(0, 14).join(','));
  assert.ok(main.cmdIds.length > paired.cmdIds.length, 'the main number sees strictly more');
  assert.ok(ALL.filter((c) => c.mainOnly).length >= 12);
});
test('help text: a paired session is not told about the main number\'s commands', () => {
  const asPaired = router.visibleList({ ownerNumber: MAIN, owner: PAIRED_JID, sessionIsPrimary: false, sessionId: PAIRED }, PAIRED_JID, PAIRED_JID);
  const asMain = router.visibleList({ ownerNumber: MAIN, owner: MAIN_JID, sessionIsPrimary: true, sessionId: 'primary' }, MAIN_JID, MAIN_JID);
  const pairedHelp = menu.help(asPaired, '', branding.forKey(PAIRED));
  const mainHelp = menu.help(asMain, '', branding.forKey('primary'));
  assert.ok(!/\.sessions\b/.test(pairedHelp), 'no .sessions in the paired help');
  assert.ok(!/\.unpair\b/.test(pairedHelp), 'no .unpair in the paired help');
  assert.match(pairedHelp, /\.pair\b/, '.pair is still documented');
  assert.match(pairedHelp, /\.mybot\b/, '.mybot is still documented');
  assert.match(mainHelp, /\.sessions\b/, 'the main number sees it');
});

test('the router hands a command its session identity (isMain, brand, commands)', async (t) => {
  stub(); resetEnv();
  t.after(() => { unstub(); resetEnv(); });
  const ping = ALL.find((c) => c.name === 'ping');
  const realExec = ping.execute;
  let seen = null;
  ping.execute = async (ctx) => { seen = ctx; return ctx.reply({ text: 'Pong' }); };

  branding.set(PAIRED, { name: 'My Own Bot', footer: 'My footer', header: 'My header' });
  branding.flush();

  const sent = [];
  const sock = { sendMessage: async (jid, content) => { sent.push(content); return { key: { id: 'X' } }; } };
  const pairedCfg = { ...config, owner: PAIRED_JID, ownerNumber: MAIN, sessionIsPrimary: false, brandKey: PAIRED, brand: branding.forKey(PAIRED), prefix: '.' };
  await router.handle(sock, textMsg('.ping', PAIRED_JID), pairedCfg, (j, c, o) => sock.sendMessage(j, c, o));
  assert.ok(seen, 'the command ran');
  assert.equal(seen.isMain, false);
  assert.equal(seen.brandKey, PAIRED);
  assert.equal(seen.brand.name, 'My Own Bot');
  assert.equal(seen.brand.footer, 'My footer');
  assert.equal(seen.commands.filter((c) => c.mainOnly).length, 0, 'its command list is already filtered');
  assert.equal(seen.isOwner, true, 'a paired number owns ITS OWN session');

  seen = null;
  const mainCfg = { ...config, owner: MAIN_JID, ownerNumber: MAIN, sessionIsPrimary: true, brandKey: 'primary', brand: branding.forKey('primary'), prefix: '.' };
  await router.handle(sock, textMsg('.ping', MAIN_JID), mainCfg, (j, c, o) => sock.sendMessage(j, c, o));
  assert.equal(seen.isMain, true);
  assert.equal(seen.brandKey, 'primary');
  assert.ok(seen.commands.some((c) => c.mainOnly));
  ping.execute = realExec;
  branding.forget(PAIRED);
});

/* ── per-session branding in the real menu plumbing ────────────────────── */

test('sessionConfigFor: each session gets its own owner, key and brand', () => {
  const base = { ...config, owner: MAIN_JID, ownerNumber: MAIN, prefix: '.' };
  branding.set(PAIRED, { name: 'Session Bot', tagline: 'My tagline' });
  branding.flush();

  const prim = sessionManager.sessionConfigFor({ isPrimary: true, id: 'primary', phone: MAIN, jid: MAIN_JID }, base);
  assert.equal(prim.brandKey, 'primary');
  assert.equal(prim.sessionIsPrimary, true);
  assert.equal(prim.owner, MAIN_JID);
  assert.equal(prim.brand.isPrimary, true);

  const paired = sessionManager.sessionConfigFor({ isPrimary: false, id: PAIRED, phone: PAIRED, jid: PAIRED_JID }, base);
  assert.equal(paired.brandKey, PAIRED);
  assert.equal(paired.sessionIsPrimary, false);
  assert.equal(paired.owner, PAIRED_JID, 'the paired session answers to whoever linked it');
  assert.equal(paired.brand.name, 'Session Bot');
  assert.equal(paired.brand.tagline, 'My tagline');
  assert.equal(router.isMainNumber({ config: paired, sender: PAIRED_JID, jid: PAIRED_JID }), false);
  assert.equal(router.isMainNumber({ config: prim, sender: MAIN_JID, jid: MAIN_JID }), true);
  branding.forget(PAIRED);
});

test('menu text and card chrome wear the session branding', () => {
  settings.update({ botName: 'Global Bot', header: 'Global Header', footer: 'Global Footer' });
  branding.set(PAIRED, { name: 'Session Bot', header: 'S Header', footer: 'S Footer', tagline: 'S Tagline' });
  branding.flush();
  const brand = branding.forKey(PAIRED);
  const cmds = router.visibleList({ ownerNumber: MAIN, owner: PAIRED_JID, sessionIsPrimary: false, sessionId: PAIRED }, PAIRED_JID, PAIRED_JID);

  // The text menu is styled (sans-serif bold + small caps), so compare through
  // the same helpers the menu uses instead of looking for plain ASCII.
  const text = menu.main({ commands: cmds, name: 'Tester', isOwner: true, brand });
  assert.ok(text.includes(menu.sansB(menu.botName(brand))), 'the text menu shows the session name');
  assert.ok(!text.includes(menu.sansB('GLOBAL BOT')), 'and not the global one');
  assert.ok(text.includes(menu.caps(brand.tagline)), 'the tagline is the session one');
  assert.ok(cmds.length < ALL.length, 'the paired menu is the filtered list');

  const id = mb.ident(brand);
  assert.equal(id.name, 'Session Bot');
  assert.equal(id.header, 'S Header');
  assert.equal(id.footer, 'S Footer');
  const chrome = mb.cardChrome('default footer', brand);
  assert.equal(chrome.footer, 'S Footer');
  assert.equal(chrome.name, 'Session Bot');

  const payload = mb.homePayload({ commands: cmds, name: 'Tester', isOwner: true, brand });
  const im = payload.content.viewOnceMessage.message.interactiveMessage;
  assert.equal(im.footer.text, 'S Footer', 'the card footer is the session one');
  assert.equal(im.header.title, 'S Header', 'and so is the card header');
  assert.ok(payload.media, 'the logo rides along');
  const globalPayload = mb.homePayload({ commands: ALL, name: 'Tester', isOwner: true, brand: branding.forKey('primary') });
  assert.equal(globalPayload.content.viewOnceMessage.message.interactiveMessage.footer.text, 'Global Footer',
    'the main session card keeps the global footer');

  // the global identity still renders for the main session
  const globalBrand = branding.forKey('primary');
  assert.equal(globalBrand.name, 'Global Bot');
  const globalChrome = mb.cardChrome('default footer', globalBrand);
  assert.equal(globalChrome.footer, 'Global Footer');
  assert.notEqual(globalChrome.footer, 'S Footer', 'the main bot keeps its own footer');
  const globalText = menu.main({ commands: ALL, name: 'Tester', isOwner: true, brand: globalBrand });
  assert.ok(globalText.includes(menu.sansB('GLOBAL BOT')), 'the main session renders the global name');
  branding.forget(PAIRED);
  settings.update({ botName: 'Sachi MD', header: '', footer: '' });
});
test('.setname from a paired session changes ONLY that session', async (t) => {
  stub(); resetEnv();
  t.after(() => { unstub(); resetEnv(); branding.forget(PAIRED); });
  settings.update({ botName: 'Global Bot' });
  const setname = ALL.find((c) => c.name === 'setname');

  const ctx = ctxFor({ jid: PAIRED_JID, isMain: false, args: ['My', 'Own', 'Bot'] });
  await setname.execute(ctx);
  assert.equal(branding.forKey(PAIRED).name, 'My Own Bot');
  assert.equal(settings.name(), 'Global Bot', 'the bot-wide name is untouched');
  assert.equal(branding.forKey('primary').name, 'Global Bot');
  assert.match(ctx.replies.join('\n'), /Your\*?\*? bot is now called/i);

  const main = ctxFor({ jid: MAIN_JID, isMain: true, args: ['Renamed', 'Globally'] });
  await setname.execute(main);
  assert.equal(settings.name(), 'Renamed Globally', 'the main number writes the global identity');
  assert.equal(branding.raw('primary'), null, 'and never stores a primary override');
  assert.equal(branding.forKey(PAIRED).name, 'My Own Bot', 'the paired session keeps its own');
  settings.update({ botName: 'Global Bot' });
});

test('.setheader / .setfooter / .settagline stay inside the session too', async (t) => {
  stub(); resetEnv();
  t.after(() => { unstub(); resetEnv(); branding.forget(PAIRED); settings.update({ header: '', footer: '' }); });
  const header = ALL.find((c) => c.name === 'setheader');
  const footer = ALL.find((c) => c.name === 'setfooter');
  const tagline = ALL.find((c) => c.name === 'settagline');
  assert.ok(header && footer && tagline, 'all three commands exist');
  for (const c of [header, footer, tagline]) assert.notEqual(c.mainOnly, true, `${c.name} is not main-only`);

  const ctx = ctxFor({ jid: PAIRED_JID, args: ['Mine'] });
  await header.execute({ ...ctx, args: ['My Header'] });
  await footer.execute({ ...ctx, args: ['My Footer'] });
  await tagline.execute({ ...ctx, args: ['My Tagline'] });
  const b = branding.forKey(PAIRED);
  assert.equal(b.header, 'My Header');
  assert.equal(b.footer, 'My Footer');
  assert.equal(b.tagline, 'My Tagline');
  assert.notEqual(settings.header(), 'My Header', 'the global header is untouched');
  assert.notEqual(settings.footer(), 'My Footer', 'the global footer is untouched');
});

test('.mybot shows the session identity and resets only that session', async (t) => {
  stub(); resetEnv();
  t.after(() => { unstub(); resetEnv(); branding.forget(PAIRED); });
  const mybot = ALL.find((c) => c.name === 'mybot');
  assert.equal(mybot.ownerOnly, false, 'anybody may inspect their own bot');
  branding.set(PAIRED, { name: 'Temp Name', header: 'Temp Header' });
  branding.flush();

  const ctx = ctxFor({ jid: PAIRED_JID });
  await mybot.execute(ctx);
  const text = ctx.replies.join('\n');
  assert.match(text, /Your bot/i);
  assert.match(text, /Temp Name/);
  assert.match(text, /Temp Header/);
  assert.match(text, /customised by you/i);
  assert.match(text, /main number/i, 'it is honest about what belongs to the main number');

  const reset = ctxFor({ jid: PAIRED_JID, args: ['reset'] });
  await mybot.execute(reset);
  assert.equal(branding.forKey(PAIRED).customised, false, 'the session went back to the defaults');
  assert.match(reset.replies.join('\n'), /reset/i);

  const main = ctxFor({ jid: MAIN_JID, isMain: true });
  await mybot.execute(main);
  assert.match(main.replies.join('\n'), /MAIN session/i);
});

/* ── session management ────────────────────────────────────────────────── */

test('.sessions lists sessions, waiting codes, limits and the pair link', async (t) => {
  stub(); resetEnv(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  process.env.PAIR_PUBLIC_URL = 'http://203.0.113.9:3000/';
  linked.add('94770009999');
  await pairing.request({ phone: '94770008888', source: 'web', ip: '4.4.4.4' });
  const sessions = ALL.find((c) => c.name === 'sessions');

  const ctx = ctxFor({ jid: MAIN_JID, isMain: true });
  await sessions.execute(ctx);
  const text = ctx.replies.join('\n');
  assert.match(text, /Bot sessions/);
  assert.match(text, /MAIN/);
  assert.match(text, /PAIRED/);
  assert.match(text, /94770009999/);
  assert.match(text, /Waiting to link/);
  assert.match(text, /94770008888/);
  assert.match(text, /203\.0\.113\.9:3000/, 'the pair page link is in the reply');
  assert.match(text, /codes issued/, 'and the counters');
  delete process.env.PAIR_PUBLIC_URL;
});

test('.unpair removes the session, its pending code and its stored branding', async (t) => {
  stub(); resetEnv(); pairing.reset();
  t.after(() => { unstub(); pairing.reset(); resetEnv(); });
  const unpair = ALL.find((c) => c.name === 'unpair');
  linked.add(PAIRED);
  branding.set(PAIRED, { name: 'Doomed Bot' });
  branding.flush();
  await pairing.request({ phone: '94770006666', source: 'chat' });

  // not the main number → refused before anything is touched
  const denied = ctxFor({ jid: PAIRED_JID, args: ['94770006666'] });
  await unpair.execute(denied);
  assert.deepEqual(calls.unpair, []);
  assert.match(denied.replies.join('\n'), /⛔/);

  // no argument → a readable list instead of a guess
  const listing = ctxFor({ jid: MAIN_JID, isMain: true });
  await unpair.execute(listing);
  assert.match(listing.replies.join('\n'), /Remove a session/);
  assert.match(listing.replies.join('\n'), new RegExp(PAIRED));

  // the real thing
  const ctx = ctxFor({ jid: MAIN_JID, isMain: true, args: [PAIRED] });
  await unpair.execute(ctx);
  assert.deepEqual(calls.unpair, [PAIRED]);
  assert.equal(branding.forKey(PAIRED).customised, false, 'its branding went with it');
  assert.match(ctx.replies.join('\n'), /Unpaired/);
  assert.match(ctx.replies.join('\n'), /forgotten/i);

  // a pending attempt can be cancelled the same way
  const pend = ctxFor({ jid: MAIN_JID, isMain: true, args: ['94770006666'] });
  await unpair.execute(pend);
  assert.ok(calls.teardown >= 1, 'the half-finished socket was torn down');
  assert.match(pend.replies.join('\n'), /pending pairing code was cancelled/);

  // the main session itself is never removable from chat
  const self = ctxFor({ jid: MAIN_JID, isMain: true, args: [MAIN] });
  await unpair.execute(self);
  assert.match(self.replies.join('\n'), /MAIN session/);
});
