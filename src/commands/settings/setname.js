const branding = require('../../services/branding');

module.exports = {
  name: 'setname',
  aliases: ['botname', 'name'],
  category: 'settings',
  emoji: '🏷️',
  description: 'Change the bot name shown in menus and cards',
  ownerOnly: true,
  execute: async (ctx) => {
    const { args, reply, prefix } = ctx;
    const key = ctx.isMain ? 'primary' : (ctx.brandKey || 'primary');
    const current = branding.forKey(key);
    const name = String(args.join(' ')).trim();
    if (!name) return reply({ text: `Current name: *${current.name}*\nUsage: \`${prefix}setname My Bot\`` });
    if (name.length > 32) return reply({ text: '❌ The name is too long (32 characters max).' });
    branding.set(key, { name });
    return reply({ text: key === 'primary'
      ? `✅ Bot name changed to *${name}* — every session that has no name of its own now shows it.`
      : `✅ *Your* bot is now called *${name}*.\nSend \`${prefix}menu\` to see it.\n\n_Only your session changed — the main bot keeps its own name._` });
  }
};
