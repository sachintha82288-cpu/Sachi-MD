const branding = require('../../services/branding');

module.exports = {
  name: 'setheader',
  aliases: ['header'],
  category: 'settings',
  emoji: '📝',
  description: 'Change the title shown on the menu card',
  ownerOnly: true,
  execute: async (ctx) => {
    const { args, reply, prefix } = ctx;
    const key = ctx.isMain ? 'primary' : (ctx.brandKey || 'primary');
    const current = branding.forKey(key);
    const text = String(args.join(' ')).trim();
    if (!text) return reply({ text: `Current header: ${current.header ? `_${current.header}_` : '_not set_'}\nUsage: \`${prefix}setheader My Bot\`` });
    if (text.length > 60) return reply({ text: '❌ The header is too long (60 characters max).' });
    branding.set(key, { header: text });
    return reply({ text: `✅ Menu header set to _${text}_${key === 'primary' ? '' : ' (your session only)'}` });
  }
};
