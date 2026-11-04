/**
 * .tagall — mention the whole group.
 *
 * Restrictions removed:
 *   • no admin wall — who may run it is a setting (.tagperm owner|admin|all,
 *     default: everyone). The owner can always use it.
 *   • large groups work: mentions are chunked (TAGALL_CHUNK, default 100)
 *     instead of one giant message WhatsApp refuses to deliver.
 *   • optional message, hidden mentions (hidetag), admins-only, and the
 *     quoted message is used as the text when none is typed.
 *
 *   .tagall                       default notice + everyone
 *   .tagall meeting at 8          custom message
 *   .tagall hide meeting at 8     notify everyone without the visible @list
 *   .tagall admins                tag the admins only
 */
const settings = require('../../services/settings');
const { normalizeJid } = require('../../utils/messages');

const CHUNK = Math.max(10, Number(process.env.TAGALL_CHUNK) || 100);
/**
 * WhatsApp rejects an over-long text message, which used to make a long
 * announcement silently kill the whole tag. 100 mentions take ~1 400
 * characters, so the announcement is clamped well under the 4 096 limit.
 */
const MAX_TEXT = Math.max(200, Number(process.env.TAGALL_MAX_TEXT) || 2400);
/**
 * Never turn one tagall into hundreds of messages: the rate limiter would
 * throttle them for minutes. A group that is too big to PRINT gets tagged
 * silently instead (mentions still notify everybody).
 */
const MAX_MESSAGES = Math.max(1, Number(process.env.TAGALL_MAX_MESSAGES) || 10);
/** Rough width of one "@94771234567 " mention in the printed list. */
const MENTION_WIDTH = 14;
const HIDE = new Set(['hide', 'hidden', 'silent', 'hidetag', '-h', '--hide']);
const ADMINS = new Set(['admins', 'admin', 'staff', 'mods']);

/** A participant entry is only usable when it really carries a jid. */
function jidOf(p) {
  const raw = typeof p === 'string' ? p : (p && typeof p.id === 'string' ? p.id : '');
  if (!raw.includes('@')) return '';
  const jid = normalizeJid(raw);
  return /\d/.test(jid.split('@')[0]) ? jid : '';
}

function uniqueParticipants(list) {
  const out = [];
  const seen = new Set();
  for (const p of list || []) {
    const jid = jidOf(p);
    // Broken entries used to become "[object Object]" mentions, which made
    // WhatsApp reject the ENTIRE message — one bad row killed the tag.
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    out.push({ jid, admin: (p && p.admin) || null });
  }
  return out;
}

module.exports = {
  name: 'tagall',
  aliases: ['everyone', 'hidetag', 'tag', 'tagallmembers'],
  category: 'group',
  emoji: '📢',
  description: 'Mention all group members — custom text, hidden tags or admins only',
  groupOnly: true,
  execute: async (ctx) => {
    const { sock, send, msg, jid, sender, args, isOwner, reply, prefix, quotedMsg } = ctx;

    let meta;
    try { meta = await sock.groupMetadata(jid); } catch (e) {
      return reply({ text: `❌ Could not read the group info — ${String(e?.message || e).slice(0, 80)}` });
    }
    const people = uniqueParticipants(meta?.participants);
    if (!people.length) return reply({ text: '❌ This group has no readable participant list.' });

    /* ── who may tag: owner | admin | all (a runtime setting) ───────── */
    const me = people.find((p) => p.jid === normalizeJid(sender));
    const isAdmin = !!me?.admin;
    const perm = String(settings.tagallPerm() || 'all').toLowerCase();
    const allowed = isOwner || perm === 'all' || (perm === 'admin' && isAdmin) || (perm === 'owner' && isOwner);
    if (!allowed) {
      return reply({ text:
`⛔ Tagging everyone is limited to *${perm === 'owner' ? 'the owner' : 'admins'}* in this bot.
The owner can open it up with \`${prefix}tagperm all\`.` });
    }

    /* ── parse flags + message ──────────────────────────────────────── */
    let hide = false;
    let adminsOnly = false;
    const words = [];
    for (const a of args) {
      const low = String(a).toLowerCase();
      if (HIDE.has(low)) { hide = true; continue; }
      if (ADMINS.has(low) && !words.length) { adminsOnly = true; continue; }
      words.push(String(a));
    }
    let message = words.join(' ').trim();
    if (!message && quotedMsg) {
      const { extractText } = require('../../utils/messages');
      message = extractText(quotedMsg) || '';
    }
    const targets = adminsOnly ? people.filter((p) => p.admin) : people;
    if (!targets.length) return reply({ text: 'ℹ️ This group has no admins to tag.' });
    if (message.length > MAX_TEXT) {
      message = message.slice(0, MAX_TEXT - 1).trimEnd() + '…';
    }
    if (!message) {
      message = adminsOnly
        ? `📢 Tagging the *${targets.length}* admin(s) of ${meta?.subject || 'this group'}`
        : `📢 *${meta?.subject || 'This group'}* — tagging all *${targets.length}* members`;
    }

    /* ── how to split the mentions ─────────────────────────────────── */
    const mentions = targets.map((p) => p.jid);
    const total = mentions.length;
    let silent = hide;
    let forcedSilent = false;
    let chunk;

    if (silent) {
      // nothing is printed, so a message can carry a lot of mentions
      chunk = Math.max(CHUNK, Math.ceil(total / MAX_MESSAGES));
    } else {
      const room = Math.max(MENTION_WIDTH, MAX_TEXT - message.length - 40);
      const fitsPerMessage = Math.max(1, Math.floor(room / MENTION_WIDTH));
      chunk = Math.min(Math.max(CHUNK, Math.ceil(total / MAX_MESSAGES)), fitsPerMessage);
      if (Math.ceil(total / chunk) > MAX_MESSAGES) {
        // Too many people to print every @ — tag silently instead of
        // firing 200 messages at WhatsApp.
        silent = true;
        forcedSilent = true;
        chunk = Math.max(1, Math.ceil(total / MAX_MESSAGES));
      }
    }
    const chunks = Math.max(1, Math.ceil(total / chunk));

    for (let i = 0; i < chunks; i++) {
      const slice = mentions.slice(i * chunk, (i + 1) * chunk);
      // Each chunk shows only ITS OWN mentions, so a 1000-member group never
      // produces one 14 000-character message WhatsApp refuses to deliver.
      const tags = silent ? '' : `\n\n${slice.map((x) => `@${x.split('@')[0]}`).join(' ')}`;
      const body = i === 0 ? `${message}${tags}` : `📢 tagall (${i + 1}/${chunks})${tags}`;
      // Baileys drops empty texts — keep a space so hidden tags still notify.
      await send(jid, { text: body || ' ', mentions: slice }, i === 0 ? { quoted: msg } : {});
    }

    if (forcedSilent) {
      return reply({ text:
`✅ Tagged *${total}* member(s) in *${chunks}* messages.
🔕 Too many people to print every @ — everyone is still notified, the list is just hidden.
_Print the list anyway: ${prefix}tagall … with TAGALL_MAX_MESSAGES raised in .env._` });
    }
    if (chunks > 1) {
      return reply({ text: `✅ Tagged *${total}* member(s) in *${chunks}* messages.` });
    }
    return undefined;
  },
};
