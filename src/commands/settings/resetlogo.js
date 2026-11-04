const branding = require('../../services/branding');

module.exports = {
  name: 'resetlogo',
  aliases: ['defaultlogo'],
  category: 'settings',
  emoji: '♻️',
  description: 'Go back to the default bot logo',
  ownerOnly: true,
  execute: async (ctx) => {
    const { reply, prefix } = ctx;
    const key = ctx.isMain ? 'primary' : (ctx.brandKey || 'primary');
    const current = branding.forKey(key);
    if (!current.logo) return reply({ text: '♻️ The default logo is already in use.' });
    branding.set(key, { logo: '' });
    return reply({ text: `♻️ Default logo restored. Send \`${prefix}menu\` to see it.` });
  }
};
