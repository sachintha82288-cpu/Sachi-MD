const path = require('path');
const branding = require('../../services/branding');
const { findMedia, downloadMedia } = require('../../services/media/stickerKit');

/** The real file type — WhatsApp images arrive as JPEG, PNG or WebP and
 *  Baileys picks the mime type from the extension. */
function sniff(buffer) {
  if (!buffer || buffer.length < 12) return 'jpg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return 'jpg';
}

module.exports = {
  name: 'setlogo',
  aliases: ['logo', 'setlogoimage'],
  category: 'settings',
  emoji: '🖼️',
  description: 'Change your bot logo (reply to an image)',
  ownerOnly: true,
  execute: async (ctx) => {
    const { msg, reply, prefix } = ctx;
    const key = ctx.isMain ? 'primary' : (ctx.brandKey || 'primary');
    const { type, content } = findMedia(msg.message || msg);
    if (!content || type !== 'image') {
      return reply({ text: `🖼️ Reply to an image with \`${prefix}setlogo\` to use it as your bot logo.\n\n*Tip:* send the picture, then reply to it with \`${prefix}setlogo\`.` });
    }
    let buffer;
    try {
      buffer = await downloadMedia(content, 'image', 12);
    } catch (e) {
      return reply({ text: `❌ Could not download that image: ${e.message}` });
    }
    if (!buffer || !buffer.length) return reply({ text: '❌ That image came back empty.' });
    if (buffer.length > 12 * 1024 * 1024) return reply({ text: '❌ The image is too large (12 MB max).' });
    let rel;
    try {
      rel = branding.setLogoBuffer(key, buffer, sniff(buffer));
    } catch (e) {
      return reply({ text: `❌ ${e.message}` });
    }
    const ext = path.extname(rel).slice(1).toUpperCase();
    return reply({ text: key === 'primary'
      ? `✅ Logo updated (${ext}, ${Math.round(buffer.length / 1024)} KB).\nSend \`${prefix}menu\` to see it.`
      : `✅ *Your* bot logo is updated (${ext}, ${Math.round(buffer.length / 1024)} KB).\nSend \`${prefix}menu\` to see it.\n\n_Only your session changed — \`${prefix}resetlogo\` puts the shared logo back._` });
  }
};
