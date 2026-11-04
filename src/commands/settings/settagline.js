const branding = require('../../services/branding');

module.exports = {
  name: 'settagline',
  aliases: ['tagline', 'slogan'],
  category: 'settings',
  emoji: '✨',
  description: 'Change the small line under the bot name in the text menu',
  ownerOnly: true,
  execute: async (ctx) => {
    const { args, reply, prefix } = ctx;
    const key = ctx.isMain ? 'primary' : (ctx.brandKey || 'primary');
    const current = branding.forKey(key);
    const text = String(args.join(' ')).trim();
    if (!text) return reply({ text: `Current tagline: ${current.tagline ? `_${current.tagline}_` : '_premium whatsapp bot_'}\nUsage: \`${prefix}settagline Fast • Smart • Clean\`` });
    if (text.length > 60) return reply({ text: '❌ The tagline is too long (60 characters max).' });
    branding.set(key, { tagline: text });
    return reply({ text: `✨ Tagline set to _${text}_${key === 'primary' ? '' : ' (your session only)'}` });
  }
};
