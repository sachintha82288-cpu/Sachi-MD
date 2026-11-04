const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { unwrapMessage } = require('../../utils/messages');
const { imageToStickerWebp, videoToStickerWebp } = require('../../services/media/stickerKit');
const { friendlyError } = require('../../services/binaries/manager');
/** A readable error for the user. */
function friendly(e) { return friendlyError(e, 'the FFmpeg helper'); }

// wa-sticker-formatter v1.0.23 shells out to system `cwebp`/`mogrify`, which
// are not provisioned anywhere, so conversion goes through services/media/stickerKit
// (the self-downloaded FFmpeg build) instead.
async function mediaBuffer(msg) {
  const m = unwrapMessage(msg.message || msg);
  let type = null;
  let data = null;
  if (m.imageMessage) { type = 'image'; data = m.imageMessage; }
  else if (m.videoMessage) { type = 'video'; data = m.videoMessage; }
  else if (m.extendedTextMessage?.contextInfo?.quotedMessage) {
    const q = unwrapMessage(m.extendedTextMessage.contextInfo.quotedMessage);
    if (q.imageMessage) { type = 'image'; data = q.imageMessage; }
    else if (q.videoMessage) { type = 'video'; data = q.videoMessage; }
  }
  if (!data) return null;
  const stream = await downloadContentFromMessage(data, type);
  const chunks = [];
  let size = 0;
  for await (const c of stream) {
    size += c.length;
    if (size > 50 * 1024 * 1024) throw new Error('Media too large (50 MB).');
    chunks.push(Buffer.from(c));
  }
  return { buffer: Buffer.concat(chunks, size), isVideo: type === 'video' };
}

module.exports = {
  name: 'sticker',
  aliases: ['s', 'stiker'],
  category: 'media',
  emoji: '🎨',
  description: 'Convert an image/video into a sticker',
  execute: async ({ msg, send, jid, reply }) => {
    let media;
    try { media = await mediaBuffer(msg); }
    catch (e) { return reply({ text: `❌ ${friendly(e)}` }); }
    if (!media) return reply({ text: '🖼️ Send/reply to an image or short video with .sticker' });
    try {
      const sticker = media.isVideo
        ? await videoToStickerWebp(media.buffer)
        : await imageToStickerWebp(media.buffer);
      await send(jid, { sticker }, { quoted: msg });
    } catch (e) {
      await reply({ text: `❌ Sticker conversion failed: ${e.message}` });
    }
  },
};
