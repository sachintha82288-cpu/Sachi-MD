const branding = require('../../services/branding');

module.exports = {
  name: 'setfooter',
  aliases: ['footer'],
  category: 'settings',
  emoji: '📄',
  description: 'Change the line shown below the menu card',
  ownerOnly: true,
  execute: async (ctx) => {
    const { args, reply, prefix } = ctx;
    const key = ctx.isMain ? 'primary' : (ctx.brandKey || 'primary');
    const current = branding.forKey(key);
    const text = String(args.join(' ')).trim();
    if (!text) return reply({ text: `Current footer: ${current.footer ? `_${current.footer}_` : '_not set_'}\nUsage: \`${prefix}setfooter Fast • Simple • Yours\`` });
    if (text.length > 60) return reply({ text: '❌ The footer is too long (60 characters max).' });
    branding.set(key, { footer: text });
    return reply({ text: `✅ Menu footer set to _${text}_${key === 'primary' ? '' : ' (your session only)'}` });
  }
};
