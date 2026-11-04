/**
 * Status + tagall end-to-end simulation.
 *
 * Everything goes through the REAL router (button taps, number replies,
 * quoted messages, group context) with a fake socket, so it proves the
 * unlocked features work the way a phone would use them:
 *
 *   node scripts/status-e2e-sim.js
 */
process.env.REACTIONS_ENABLED = 'false';
process.env.ANTIBAN_ENABLED = 'false';
process.env.STATUS_FRESH_WAIT_MS = '300';
process.env.TAGALL_CHUNK = '10';

const { Readable } = require('stream');
const router = require('../src/router/router');
const config = require('../src/config');
const settings = require('../src/services/settings');
const statusManager = require('../src/services/status/manager');

/* media downloads are faked — no WhatsApp CDN in a test sandbox */
statusManager.setDownloader(async () => Readable.from([Buffer.from('fake-media')]));

const OWNER = '94700000001@s.whatsapp.net';
const FRIEND = '94771234567@s.whatsapp.net';
const GROUP = '120363000000000001@g.us';

router.loadCommands();
// production sets this when the primary session connects — auto-forward
// needs it to know whose chat to send statuses to
config.owner = OWNER;

function sock(sink, opts = {}) {
  return {
    sendMessage: async (jid, content) => {
      sink.push({ jid, content });
      return { key: { id: 'BOT' + sink.length } };
    },
    relayMessage: async () => ({}),
    sendPresenceUpdate: async (type, jid) => sink.push({ jid, presence: type }),
    presenceSubscribe: async (jid) => sink.push({ jid, subscribe: true }),
    readMessages: async () => sink.push({ read: true }),
    groupMetadata: async () => ({
      subject: 'Sim Group',
      participants: opts.participants || [
        { id: OWNER, admin: null },
        { id: FRIEND, admin: 'admin' },
        { id: '94700000009@s.whatsapp.net', admin: null },
      ],
    }),
    waUploadToServer: async () => ({ mediaUrl: 'https://example.invalid/x' }),
    user: { id: OWNER, name: 'Sim' },
    ev: { on: () => {} },
  };
}

function msg(text, jid, { participant, quoted, stanzaId, mentioned } = {}) {
  const message = { conversation: text };
  if (quoted || stanzaId) {
    message.extendedTextMessage = {
      text,
      contextInfo: { stanzaId: stanzaId || 'Q1', participant: jid, quotedMessage: quoted || { conversation: 'q' } },
    };
    delete message.conversation;
  }
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random().toString(36).slice(2), fromMe: false, participant },
    pushName: 'Sim',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message,
    ...(mentioned ? { mentioned } : {}),
  };
}

function statusUpdate(number, message, id = 'ST' + Math.random().toString(36).slice(2)) {
  return {
    key: { remoteJid: 'status@broadcast', id, fromMe: false, participant: `${number}@s.whatsapp.net` },
    message,
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
const textsOf = (sink) => sink.filter((s) => s.content && s.content.text).map((s) => s.content.text);

let seq = 0;
async function say(text, jid, opts = {}) {
  const sink = [];
  await router.handle(sock(sink, opts), msg(text, jid, opts), { ...config, owner: OWNER },
    (j, c) => { const out = { jid: j, content: c, key: { id: 'S' + (++seq) } }; sink.push(out); return out; });
  return sink;
}

/** Send a plain number reply quoting one of the bot's messages. */
async function replyNumber(n, jid, botMessageId) {
  const sink = [];
  await router.handle(sock(sink), msg(String(n), jid, { stanzaId: botMessageId }), { ...config, owner: OWNER },
    (j, c) => { const out = { jid: j, content: c, key: { id: 'S' + (++seq) } }; sink.push(out); return out; });
  return sink;
}

(async () => {
  const restore = { settings: settings.get(), status: statusManager.getSettings() };

  try {
    /* 1 — .status with nothing cached explains itself and asks WhatsApp */
    statusManager.clearCache();
    let sink = await say('.status 94770001111', FRIEND);
    let out = textsOf(sink).join('\n');
    check('1. empty cache → live refresh request, not a flat no',
      sink.some((s) => s.subscribe) && /asking WhatsApp|No status in RAM/.test(out),
      `presence=${sink.some((s) => s.subscribe)}`);

    /* 2 — a cached text status comes back by number */
    await statusManager.handleStatus(statusUpdate('94771234567', { conversation: 'hello from the sim' }), sock([]));
    sink = await say('.status 94771234567', FRIEND);
    check('2. .status <number> returns the cached status',
      textsOf(sink).join('\n').includes('hello from the sim'));

    /* 3 — .status all walks every user */
    await statusManager.handleStatus(statusUpdate('94779998888', { conversation: 'second user status' }), sock([]));
    sink = await say('.status all 5', FRIEND);
    out = textsOf(sink).join('\n');
    check('3. .status all covers everyone', out.includes('hello from the sim') && out.includes('second user status'));

    /* 4 — a quoted status is downloadable with an empty cache */
    statusManager.clearCache();
    sink = await say('.status save', FRIEND, { quoted: { imageMessage: { caption: 'quoted pic', mimetype: 'image/jpeg' } } });
    check('4. .status save downloads the quoted status', sink.some((s) => s.content && s.content.image));

    /* 5 — the dashboard lists users and a number reply downloads one */
    await statusManager.handleStatus(statusUpdate('94771234567', { conversation: 'dashboard status' }), sock([]));
    sink = await say('.status', FRIEND);
    out = textsOf(sink).join('\n');
    const dashMsg = sink.find((s) => s.content && s.content.text && /Reply with a number/.test(s.content.text));
    check('5. .status is a dashboard with a numbered list',
      /Status Saver/.test(out) && /\+94771234567/.test(out) && !!dashMsg);

    sink = await replyNumber(1, FRIEND, dashMsg.key.id);
    check('6. replying "1" to the dashboard downloads that user',
      textsOf(sink).join('\n').includes('dashboard status'), textsOf(sink).join(' | ').slice(0, 60));

    /* 7 — auto-forward delivers a new status to the owner chat */
    statusManager.clearCache();
    const forwarded = [];
    statusManager.setSender(async (jid, content) => { forwarded.push({ jid, content }); return { key: { id: 'F' } }; });
    await say('.autoforward on', OWNER);
    await statusManager.handleStatus(statusUpdate('94771234567', { conversation: 'forwarded to owner' }), sock([]));
    check('7. .autoforward on sends new statuses to the owner chat',
      forwarded.length === 1 && forwarded[0].jid === OWNER && /forwarded to owner/.test(forwarded[0].content.text || ''));
    await say('.autoforward off', OWNER);

    /* 8 — the reaction picker works through a number reply */
    sink = await say('.setreaction', OWNER);
    out = textsOf(sink).join('\n');
    const pickerMsg = sink.find((s) => s.content && s.content.text && /Pick one/.test(s.content.text));
    check('8. .setreaction opens the emoji picker', !!pickerMsg);
    sink = await replyNumber(3, OWNER, pickerMsg.key.id);
    check('9. a number reply sets that emoji',
      /😍/.test(textsOf(sink).join('\n')) && statusManager.getSettings().reactions.includes('😍'));

    /* 10 — several emojis are stored whole and used at random */
    await say('.setreaction 👨‍👩‍👧‍👦 🇱🇰 1️⃣', OWNER);
    const st = statusManager.getSettings();
    check('10. complex emoji survive (ZWJ / flag / keycap)',
      st.reactions.length === 3 && st.reactions[0] === '👨‍👩‍👧‍👦', st.reactions.join(' '));

    /* 11 — auto-react reacts with one of the saved emojis */
    statusManager.setAutoReact(true);
    const reactSink = [];
    await statusManager.handleStatus(statusUpdate('94771234567', { conversation: 'react now' }), sock(reactSink));
    const reacted = reactSink.find((s) => s.content && s.content.react);
    check('11. auto-react uses an emoji from the saved list',
      !!reacted && st.reactions.includes(reacted.content.react.text), reacted?.content?.react?.text);
    statusManager.setAutoReact(false);

    /* 12 — tagall: any member may tag (no admin wall) */
    settings.update({ tagallPerm: 'all' });
    sink = await say('.tagall meeting at 8', GROUP, { participant: '94700000009@s.whatsapp.net' });
    const mentions = sink.reduce((n, s) => n + ((s.content && s.content.mentions) || []).length, 0);
    check('12. a normal member can tag everyone', mentions === 3 && /meeting at 8/.test(textsOf(sink).join('\n')),
      `mentions=${mentions}`);

    /* 13 — hide mode notifies without printing the @list */
    sink = await say('.tagall hide quiet notice', GROUP, { participant: FRIEND });
    out = textsOf(sink).join('\n');
    check('13. .tagall hide keeps the mentions but prints no @list',
      sink.some((s) => s.content && s.content.mentions && s.content.mentions.length === 3) && !out.includes('@9470'));

    /* 14 — admins only */
    sink = await say('.tagall admins check this', GROUP, { participant: FRIEND });
    check('14. .tagall admins tags only the admins',
      JSON.stringify(sink[0]?.content?.mentions) === JSON.stringify([FRIEND]));

    /* 15 — big groups are chunked */
    const big = [{ id: OWNER, admin: null }];
    for (let i = 2; i <= 45; i++) big.push({ id: `947000000${String(i).padStart(2, '0')}@s.whatsapp.net`, admin: null });
    sink = await say('.tagall roll call', GROUP, { participant: FRIEND, participants: big });
    const tagMsgs = sink.filter((s) => s.content && s.content.mentions);
    check('15. 45 members are tagged in chunks of 10',
      tagMsgs.length === 5 && sink.reduce((n, s) => n + ((s.content && s.content.mentions) || []).length, 0) === 45,
      `messages=${tagMsgs.length}`);

    /* 16 — .tagperm admin closes it again for members, not for the owner */
    await say('.tagperm admin', OWNER);
    sink = await say('.tagall hello', GROUP, { participant: '94700000009@s.whatsapp.net' });
    const blocked = /⛔/.test(textsOf(sink).join('\n'));
    sink = await say('.tagall hello', GROUP, { participant: OWNER, participants: big });
    const ownerOk = sink.reduce((n, x) => n + ((x.content && x.content.mentions) || []).length, 0) === 45;
    check('16. .tagperm admin blocks members but never the owner', blocked && ownerOk,
      `member blocked=${blocked} owner tagged=${ownerOk}`);
    settings.update({ tagallPerm: 'all' });

    /* 17 — the settings card + health show the new state */
    sink = await say('.settings', OWNER);
    out = textsOf(sink).join('\n');
    check('17. .settings shows auto-forward and the tagall permission',
      /Auto forward/.test(out) && /Tagall/.test(out));
    sink = await say('.health', OWNER);
    out = textsOf(sink).join('\n');
    check('18. .health reports the status centre', /Status centre/.test(out) && /Cached/.test(out));
  } finally {
    settings.update(restore.settings);
    statusManager.setAutoSeen(restore.status.autoSeen);
    statusManager.setAutoReact(restore.status.autoReact, restore.status.reactions);
    statusManager.setAutoForward(restore.status.autoForward, restore.status.forwardTo);
    statusManager.setSender(null);
    statusManager.clearCache();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== ${results.length - failed.length}/${results.length} scenarios OK ==`);
  if (failed.length) { console.log('FAILED: ' + failed.map((f) => f.name).join(' | ')); process.exit(1); }
})().catch((e) => { console.error('SIM CRASH:', e && e.stack || e); process.exit(2); });
