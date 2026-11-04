/**
 * .status — the status saver.
 *
 * Unrestricted on purpose:
 *   .status                 → dashboard (cached users as a numbered list)
 *   .status <number> [n]    → that person's statuses, newest first
 *   .status all [n]         → the newest n statuses of EVERYONE
 *   .status me              → statuses posted by this account
 *   .status save            → the quoted / forwarded status (no cache needed)
 *   .status clear           → empty the RAM cache (owner)
 *   .status settings        → automation settings
 *
 * When a number has nothing cached the bot actively asks WhatsApp for a
 * fresh push (presence subscribe) before giving up.
 */
const status = require('../../services/status/manager');
const selections = require('../../services/selection');

const DASH_USERS = Number(process.env.STATUS_DASH_USERS) || 8;

function miniCtx({ sock, send, msg, jid, sender }) {
  return {
    sock, send, msg, jid, sender,
    reply: (content) => send(jid, content, { quoted: msg }),
    edit: async (key, content) => {
      const payload = typeof content === 'string' ? { text: content } : { ...content };
      return send(jid, { ...payload, edit: key });
    },
  };
}

function age(ms) {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function dashboard(ctx) {
  const s = status.status();
  const rows = status.topUsers(DASH_USERS);
  const lines = rows.map((r, i) =>
    `*${i + 1}.* 👤 +${r.number} — ${r.count} status(es) · ${age(r.newest)}`);
  const text =
`👁️ *Status Saver*

📦 In RAM: *${s.statuses}* status(es) from *${s.users}* user(s)
⏳ Window: ${s.ttlHours}h · up to ${s.maxPerUser} per user · ${s.sockets} session(s) feeding the cache
🔒 Per command: up to ${s.sendMax} statuses · 💾 restart: ${s.persist ? 'cache is kept' : 'RAM only'}
❤️ Auto react: ${s.autoReact ? `ON · ${s.reactions.join(' ')}` : 'OFF'} · 👀 auto seen: ${s.autoSeen ? 'ON' : 'OFF'}
📤 Auto forward: ${s.autoForward ? `ON → ${s.forwardTo || 'owner chat'}` : 'OFF'}

${rows.length ? `${lines.join('\n')}\n\n_Reply with a number to download that person's statuses._` : '_Nothing cached yet — statuses appear as soon as WhatsApp delivers them to a linked session._'}

*Get statuses*
${ctx.prefix}status <number>        e.g. ${ctx.prefix}status 94771234567
${ctx.prefix}status <number> 3      newest 3 only
${ctx.prefix}status all 10           newest 10 of everyone
${ctx.prefix}status me               this account's own statuses
${ctx.prefix}status save             the status you quoted/forwarded
${ctx.prefix}status clear            empty the cache (owner)`;
  return text;
}

async function sendDashboard(ctx) {
  const rows = status.topUsers(DASH_USERS);
  const sent = await ctx.reply({ text: dashboard(ctx) });
  if (!sent?.key?.id || !rows.length) return;
  selections.remember(sent.key.id, {
    type: 'status-user',
    chat: ctx.jid,
    sender: ctx.sender,
    handler: async ({ sock, send, msg, jid, sender, text }) => {
      const n = Number(text);
      selections.cancel(sent.key.id);
      const row = rows[n - 1];
      if (!row) return send(jid, { text: 'ℹ️ That number is not on the list.' }, { quoted: msg });
      const result = await status.sendAll(miniCtx({ sock, send, msg, jid, sender }), row.number);
      if (!result.count && !result.failed) {
        return send(jid, { text: `ℹ️ No status in RAM for +${row.number} any more.` }, { quoted: msg });
      }
      return undefined;
    },
  });
}

/** Pull the number out of anything a user may type or mention. */
function targetNumber(ctx) {
  const raw = String(ctx.args[0] || '');
  if (ctx.target && /@s\.whatsapp\.net|@c\.us/.test(ctx.target)) return status.normalizeNumber(ctx.target);
  return status.normalizeNumber(raw);
}

module.exports = {
  name: 'status',
  aliases: ['statusdl', 'savestatus', 'statussave', 'sstatus'],
  category: 'status',
  emoji: '👁️',
  description: 'Download statuses — one number, everyone, or the one you quoted',
  execute: async (ctx) => {
    const arg = String(ctx.args[0] || '').toLowerCase();
    const limitArg = Number(ctx.args[1]) > 0 ? Number(ctx.args[1]) : 0;

    /* a mentioned person counts as the target: .status @someone */
    const mentioned = !arg && ctx.target && /@s\.whatsapp\.net|@c\.us/.test(ctx.target)
      ? status.normalizeNumber(ctx.target) : '';

    /* nothing typed → dashboard with a pick-a-user list */
    if (!arg && !mentioned && !ctx.quotedMsg) return sendDashboard(ctx);

    /* a quoted/forwarded status is always downloadable, cache or not */
    if (!arg && ctx.quotedMsg) return status.sendQuoted(ctx, ctx.quotedMsg);
    if (arg === 'save' || arg === 'quoted' || arg === 'q') {
      if (!ctx.quotedMsg) {
        return ctx.reply({ text: `ℹ️ Quote or forward the status message, then send \`${ctx.prefix}status save\`.` });
      }
      return status.sendQuoted(ctx, ctx.quotedMsg);
    }

    if (arg === 'all' || arg === 'latest' || arg === 'new' || arg === 'recent') {
      const n = limitArg || status.DEFAULT_LATEST;
      const cached = status.latest(n);
      if (!cached.length) {
        return ctx.reply({ text: 'ℹ️ No status is cached yet.\n\nStatuses arrive while the bot is online — turn on auto-forward so nothing is missed:\n`' + ctx.prefix + 'autoforward on`' });
      }
      return status.sendLatest(ctx, n);
    }

    if (arg === 'me' || arg === 'own' || arg === 'self' || arg === 'my') {
      const own = status.normalizeNumber(ctx.config.owner || ctx.sender);
      const list = status.find(own);
      if (!list.length) {
        return ctx.reply({ text: 'ℹ️ No status of your own is cached.\n\nWhatsApp does not always deliver your own posts to linked devices — quote one and use `' + ctx.prefix + 'status save` instead.' });
      }
      return status.sendItems(ctx, list.slice(0, limitArg || list.length).map((item) => ({ number: own, item })), { label: ' (yours)' });
    }

    if (arg === 'clear' || arg === 'reset' || arg === 'empty') {
      if (!ctx.isOwner) return ctx.reply({ text: '⛔ Owner only.' });
      const n = status.clearCache();
      return ctx.reply({ text: `🧹 Status cache cleared — ${n} user(s) removed from RAM.` });
    }

    if (arg === 'settings' || arg === 'config' || arg === 'info') {
      const s = status.status();
      return ctx.reply({ text:
`╭━━〔 👁️ STATUS CENTER 〕━━╮
┃ Auto seen    : ${s.autoSeen ? '🟢 ON' : '⚪ OFF'}
┃ Auto react   : ${s.autoReact ? '🟢 ON' : '⚪ OFF'}
┃ Reaction(s)  : ${s.reactions.join(' ')}
┃ Auto forward : ${s.autoForward ? `🟢 ON → ${s.forwardTo || 'owner chat'}` : '⚪ OFF'}
┃ Cached       : ${s.statuses} from ${s.users} user(s)
┃ Window       : ${s.ttlHours}h · ${s.maxPerUser}/user · ${s.maxMediaMB} MB max
╰━━━━━━━━━━━━━━━━━━━━━━╯

${ctx.prefix}autoseen on|off
${ctx.prefix}autoreact on|off
${ctx.prefix}setreaction 🔥 😍 💯
${ctx.prefix}autoforward on|off [number]` });
    }

    /* one number — the classic path, with a live refresh when empty */
    const number = mentioned || targetNumber(ctx);
    if (!number || number.length < 4 || number.length > 20) {
      return ctx.reply({ text:
`ℹ️ Give me a number.

${ctx.prefix}status <number>     e.g. ${ctx.prefix}status 94771234567
${ctx.prefix}status all 10       newest 10 of everyone
${ctx.prefix}status save         the status you quoted
${ctx.prefix}status              dashboard

_You can also mention the person: ${ctx.prefix}status @user_` });
    }

    let list = status.find(number);
    if (!list.length) {
      const note = await ctx.reply({ text: `🔎 Nothing cached for +${number} — asking WhatsApp for the latest…` });
      const found = await status.requestFresh(ctx.sock, number);
      list = status.find(number);
      if (!list.length) {
        const text = found
          ? `ℹ️ Still nothing usable for +${number}.`
          : `ℹ️ No status in RAM for +${number}.

WhatsApp only delivers statuses to a linked session while the bot is online.
• Keep the bot running and try again later
• Turn on auto-forward: \`${ctx.prefix}autoforward on\`
• Or forward me the status and use \`${ctx.prefix}status save\``;
        if (note?.key && ctx.edit) { try { return await ctx.edit(note.key, { text }); } catch {} }
        return ctx.reply({ text });
      }
      if (note?.key && ctx.edit) { try { await ctx.edit(note.key, { text: `✅ Got *${list.length}* status(es) for +${number}.` }); } catch {} }
    }
    const slice = limitArg ? list.slice(0, limitArg) : list;
    return status.sendItems(ctx, slice.map((item) => ({ number, item })), { label: ` from +${number}` });
  },
};
