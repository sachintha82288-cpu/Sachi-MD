/**
 * Command audit — runs EVERY registered command through the router with a
 * fake socket and reports the ones that blow up, stay silent or answer
 * with an error instead of doing their job.
 *
 *   node scripts/audit-commands.js            # every command
 *   node scripts/audit-commands.js mode       # one command
 *
 * The goal: find dead features (commands that can never work) and the
 * commands that answer with an error instead of doing their job.
 *
 * The persisted settings are restored afterwards — the audit must never
 * leave the bot in a strange state.
 */
const fs = require('fs');
const router = require('../src/router/router');
const config = require('../src/config');
const settings = require('../src/services/settings');

const OWNER = '94700000001@s.whatsapp.net';
const FRIEND = '94700000002@s.whatsapp.net';
const GROUP = '120363000000000000@g.us';

process.env.REACTIONS_ENABLED = 'false';
process.env.ANTIBAN_ENABLED = 'false';
// the status saver would otherwise wait 6s per number for a live push
process.env.STATUS_FRESH_WAIT_MS = '300';

router.loadCommands();
const commands = router.list();

/** Commands that must not run in the audit (they start real sessions). */
const SKIP = new Set(['pair', 'unpair', 'shutdown', 'restart']);

/** A socket that records what was sent and never touches the network. */
function makeSock(sink) {
  return {
    sendMessage: async (jid, content, opts) => {
      const text = content && (content.text || content.caption) || '';
      sink.push({ kind: content && content.__interactive ? 'card' : content && content.image ? 'image' : 'text', text });
      return { key: { id: 'AUDIT-' + Math.random().toString(36).slice(2) } };
    },
    sendPresenceUpdate: async () => {},
    presenceSubscribe: async () => {},
    relayMessage: async () => ({}),
    waUploadToServer: async () => ({ mediaUrl: 'https://example.invalid/x' }),
    groupMetadata: async () => ({ participants: [{ id: FRIEND, admin: 'admin' }], id: 'g', subject: 'Audit' }),
    groupAcceptInvite: async () => {},
    groupUpdateSubject: async () => {},
    groupPromote: async () => {},
    groupDemote: async () => {},
    groupLeave: async () => {},
    groupInviteCode: async () => 'AUDIT',
    groupRequestParticipantsUpdate: async () => {},
    profilePictureUrl: async () => null,
    onWhatsApp: async () => [{ jid: `${FRIEND.split('@')[0]}@s.whatsapp.net`, exists: true }],
    readMessages: async () => {},
    user: { id: OWNER, name: 'Audit' },
    ev: { on: () => {} }
  };
}

function msg(text, jid, participant) {
  return {
    key: { remoteJid: jid, id: 'AUDIT-' + Math.random().toString(36).slice(2), fromMe: false, participant },
    pushName: 'Audit',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: { conversation: text }
  };
}

/** Arguments that give each command something to work with. */
const ARGS = {
  download: ['https://example.invalid/file.mp4'],
  ytv: ['dQw4w9WgXcQ'], yta: ['dQw4w9WgXcQ'],
  yts: ['test query'], play: ['test song'],
  tiktok: ['https://example.invalid/video'], fb: ['https://example.invalid/video'],
  mediafire: ['https://example.invalid/file'], apk: ['com.example.app'],
  gitclone: ['owner/repo'], wiki: ['Colombo'],
  status: ['94700000002'], getdp: ['94700000002'],
  autoforward: [''], statussettings: [''], tagperm: [''],
  tagall: [''], kick: ['94700000002'], promote: ['94700000002'], demote: ['94700000002'],
  antiban: ['status'], proxystatus: [''], sessions: [''],
  mode: [''], setname: ['Audit Bot'], setheader: ['Audit Header'], setfooter: ['Audit Footer'],
  setprefix: ['.'], cleanup: [''], ai: ['hello'], vv: [''], sticker: [''], sticker2img: [''],
  setreaction: ['🔥'], autoreact: ['on', '🔥'], autoseen: ['on']
};

const only = process.argv[2];
const list = only ? commands.filter((c) => c.name === only) : commands;

/** Restore the persisted settings when the audit is done. */
function snapshot() {
  const path = require('path');
  // both persisted files: bot settings AND the status automations
  const files = [config.paths.settings, path.join(config.paths.data, 'status-settings.json')];
  const backups = files.map((f) => ({ f, data: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null }));
  return () => {
    settings.update({ mode: 'all', botName: '', header: '', footer: '', logo: '', tagallPerm: 'all' });
    for (const { f, data } of backups) {
      if (data === null) { try { fs.rmSync(f, { force: true }); } catch {} }
      else fs.writeFileSync(f, data);
    }
  };
}

(async () => {
  const restore = snapshot();
  const rows = [];
  try {
    for (const cmd of list) {
      if (SKIP.has(cmd.name)) { rows.push({ name: cmd.name, skipped: true }); continue; }
      const sent = [];
      const sock = makeSock(sent);
      const args = ARGS[cmd.name] || [];
      // owner commands run in the owner's chat, guests in a private chat,
      // group commands inside a group.
      const inGroup = !!cmd.groupOnly;
      const jid = inGroup ? GROUP : (cmd.ownerOnly ? OWNER : FRIEND);
      const participant = inGroup ? FRIEND : undefined;
      let error = null;
      const started = Date.now();
      try {
        await router.handle(sock, msg('.' + cmd.name + (args.length ? ' ' + args.join(' ') : ''), jid, participant),
          { ...config, owner: OWNER }, (j, c, o) => sock.sendMessage(j, c, o));
      } catch (e) {
        error = e;
      }
      const ms = Date.now() - started;
      const texts = sent.filter((s) => s.kind === 'text').map((s) => s.text);
      const body = texts.join(' | ');
      rows.push({
        name: cmd.name,
        ownerOnly: !!cmd.ownerOnly,
        ms,
        replies: sent.length,
        silent: sent.length === 0,
        error: error ? (error.message || String(error)).slice(0, 140) : null,
        snippet: body.replace(/\s+/g, ' ').slice(0, 100),
        isError: /❌|⛔|error|failed|unavailable|not supported|cannot|unable/i.test(body)
      });
    }
  } finally {
    restore();
  }

  console.log('\n=== command audit ===');
  let problems = 0;
  for (const r of rows) {
    if (r.skipped) { console.log(`${r.name.padEnd(14)} — skipped (starts a real session)`); continue; }
    const flags = [];
    if (r.error) flags.push('THROW:' + r.error);
    if (r.silent) flags.push('SILENT');
    if (r.isError) flags.push('ERROR-REPLY');
    if (flags.length) problems++;
    console.log(
      `${r.name.padEnd(14)} ${String(r.replies).padStart(2)} rep ${String(r.ms).padStart(6)}ms ` +
      `${flags.length ? '⚠ ' + flags.join(' | ') : 'ok  '} ${r.snippet}`
    );
  }
  console.log(`\n${rows.length - problems}/${rows.length} commands look healthy, ${problems} need a look.`);
})().catch((e) => { console.error('AUDIT CRASH:', e && e.stack || e); process.exit(2); });
