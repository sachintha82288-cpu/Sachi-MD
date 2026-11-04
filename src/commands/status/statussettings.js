const status = require('../../services/status/manager');

module.exports = {
  name: 'statussettings',
  aliases: ['statusconfig', 'statuscenter'],
  category: 'status',
  emoji: '⚙️',
  description: 'Show and change the status automations (seen, react, forward)',
  ownerOnly: true, mainOnly: true,
  execute: async (ctx) => {
    const s = status.status();
    await ctx.reply({ text:
`╭━━〔 👁️ STATUS CENTER 〕━━╮
┃ Auto seen    : ${s.autoSeen ? '🟢 ON' : '⚪ OFF'}
┃ Auto react   : ${s.autoReact ? '🟢 ON' : '⚪ OFF'}
┃ Reaction(s)  : ${s.reactions.join(' ')}${s.reactions.length > 1 ? ' _(random)_' : ''}
┃ Auto forward : ${s.autoForward ? `🟢 ON → ${s.forwardTo ? '+' + status.normalizeNumber(s.forwardTo) : 'owner chat'}` : '⚪ OFF'}
╰━━━━━━━━━━━━━━━━━━━━━━╯

📦 Cached: *${s.statuses}* status(es) from *${s.users}* user(s)
⏳ Window: ${s.ttlHours}h · ${s.maxPerUser} per user · ${s.maxMediaMB} MB per file
🔌 Sessions feeding the cache: ${s.sockets}

*Commands*
${ctx.prefix}autoseen on|off
${ctx.prefix}autoreact on|off
${ctx.prefix}setreaction 🔥 😍 💯      picker: ${ctx.prefix}setreaction
${ctx.prefix}autoforward on|off [number]
${ctx.prefix}status <number>|all|me|save|clear` });
  },
};
