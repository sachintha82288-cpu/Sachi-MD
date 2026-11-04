module.exports = {
  name: 'getdp', aliases: ['dp', 'profilepic', 'pp'], category: 'tools', emoji: '🖼️',
  description: 'Get the highest-resolution profile picture available to the bot',
  async execute(ctx) {
    const raw = String(ctx.args?.[0] || '').trim();
    if (!raw) return ctx.reply({ text: `🖼️ *Get Profile Picture*\n\nUsage: ${ctx.prefix}getdp <number>\nExample: ${ctx.prefix}getdp 94771234567` });
    const number = raw.replace(/\D/g, '').replace(/^00/, '');
    if (!number || number.length < 8 || number.length > 15) return ctx.reply({ text: '❌ Invalid number. Use the full international number without + or spaces.' });
    try {
      const results = await ctx.sock.onWhatsApp(`${number}@s.whatsapp.net`);
      const match = Array.isArray(results) ? results.find(x => x?.exists && x?.jid) : null;
      if (!match?.jid) return ctx.reply({ text: '❌ That number does not appear to be available on WhatsApp.' });
      const url = await ctx.sock.profilePictureUrl(match.jid, 'image');
      if (!url) return ctx.reply({ text: 'ℹ️ No profile picture is available to the bot for this account.' });
      await ctx.send(ctx.jid, { image: { url }, caption: `🖼️ *Profile Picture*\n📱 +${number}` }, { quoted: ctx.msg });
    } catch (e) {
      const message = String(e?.message || e).toLowerCase();
      if (message.includes('not-authorized') || message.includes('forbidden') || message.includes('privacy')) return ctx.reply({ text: '🔒 The profile picture is unavailable because of the account privacy settings.' });
      throw e;
    }
  }
};
