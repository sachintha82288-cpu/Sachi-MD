const mode = require('../../services/mode');

const ICONS = { self: '📱', inbox: '📥', public: '🌍', groups: '👥', all: '✨' };

module.exports = {
  name: 'mode',
  aliases: ['setmode', 'botmode', 'chatmode'],
  category: 'settings',
  emoji: '🎚️',
  description: 'Where the bot listens (self, inbox, public, groups, all)',
  ownerOnly: true, mainOnly: true,
  execute: async (ctx) => {
    const { args, reply, prefix } = ctx;
    const current = mode.current();
    const wanted = String(args[0] || '').toLowerCase();
    // What happens in THIS chat right now?
    const here = mode.allows({
      isSelf: !!ctx.isSelf,
      isGroup: !!ctx.isGroup,
      isOwner: !!ctx.isOwner,
      isOwnerCommand: false
    });
    const hereLine = here
      ? '🟢 *In this chat the bot answers.*'
      : '🔕 *In this chat the bot stays quiet* (owner commands still work).';
    if (!wanted) {
      const lines = mode.MODES.map((m) => `${m === current ? '✅' : '▫️'} ${ICONS[m] || '•'} *${m}* — ${mode.desc(m)}`);
      return reply({
        text: `🎚️ *Bot mode*\n\n${lines.join('\n')}\n\n${mode.hint()}\n\n${hereLine}\n\nSet a new one with \`${prefix}mode <${mode.MODES.join('|')}>\``
      });
    }
    if (!mode.isValid(wanted)) {
      return reply({ text: `❌ Unknown mode *${wanted}*.\nUse one of: ${mode.MODES.join(', ')}` });
    }
    const before = current;
    mode.set(wanted);
    const after = mode.allows({
      isSelf: !!ctx.isSelf,
      isGroup: !!ctx.isGroup,
      isOwner: !!ctx.isOwner,
      isOwnerCommand: false
    });
    return reply({
      text: `🎚️ Mode changed: *${before}* → *${mode.current()}*\n\n${mode.hint()}\n\n${after ? '🟢 The bot answers in this chat.' : '🔕 The bot stays quiet in this chat (owner commands still work).'}`
    });
  }
};
