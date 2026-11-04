const status = require('../../services/status/manager');

module.exports = {
  name: 'autoreact',
  aliases: ['statusreact'],
  category: 'status',
  emoji: '❤️',
  description: 'Turn automatic status reactions on or off (emoji list supported)',
  ownerOnly: true, mainOnly: true,
  execute: async (ctx) => {
    const value = String(ctx.args[0] || '').toLowerCase();
    const s = status.getSettings();

    if (value === 'off' || value === 'disable') {
      status.setAutoReact(false);
      return ctx.reply({ text: `⚪ Auto Status React: *OFF*\n_Emoji list kept: ${s.reactions.join(' ')} — \`${ctx.prefix}autoreact on\` to resume._` });
    }

    if (value === 'on' || value === 'enable') {
      const rest = ctx.args.slice(1).join(' ').trim();
      // "on" with no emoji keeps the saved list instead of resetting to ❤️
      if (!rest) {
        const next = status.setAutoReact(true);
        return ctx.reply({ text: `❤️ Auto Status React: *ON*\nReaction(s): ${next.reactions.join(' ')}\n\nChange them: \`${ctx.prefix}setreaction 🔥 😍 💯\`` });
      }
      const list = status.parseReactions(rest);
      if (!list.length) {
        return ctx.reply({ text: `❌ That is not an emoji.\n\n${ctx.prefix}autoreact on ❤️\n${ctx.prefix}autoreact on 🔥 😍 💯   _(random per status)_\n${ctx.prefix}autoreact off` });
      }
      const next = status.setAutoReact(true, list);
      return ctx.reply({ text: `❤️ Auto Status React: *ON*\nReaction(s): ${next.reactions.join(' ')}` });
    }

    return ctx.reply({ text:
`❤️ *Auto status react*

State: ${s.autoReact ? '🟢 ON' : '⚪ OFF'}
Emoji(s): ${s.reactions.join(' ')}${s.reactions.length > 1 ? '  _(random per status)_' : ''}

${ctx.prefix}autoreact on            keep the saved emoji(s)
${ctx.prefix}autoreact on 🔥 😍 💯   set + enable
${ctx.prefix}autoreact off
${ctx.prefix}setreaction             emoji picker` });
  },
};
