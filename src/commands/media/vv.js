const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
const { unwrapMessage } = require('../../utils/messages');
async function mediaFromMessage(message) {
  const m = unwrapMessage(message || {});
  if (m.imageMessage) return ['image', m.imageMessage];
  if (m.videoMessage) return ['video', m.videoMessage];
  if (m.audioMessage) return ['audio', m.audioMessage];
  if (m.documentMessage) return ['document', m.documentMessage];
  if (m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension) {
    return mediaFromMessage(m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessageV2Extension?.message);
  }
  return [null, null];
}
async function toBuffer(content, type) {
  const stream = await downloadContentFromMessage(content, type === 'document' ? 'document' : type);
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) throw new Error('Media too large (100 MB).');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
module.exports = {
  name: 'vv',
  aliases: ['viewonce', 'reveal', 'antiviewonce'],
  category: 'media',
  emoji: '🕵️',
  description: 'Reveal / save view-once or quoted media',
  async execute(ctx) {
    const m = unwrapMessage(ctx.msg.message || {});
    let source = ctx.msg.message;
    const q = m.extendedTextMessage?.contextInfo?.quotedMessage || m.imageMessage?.contextInfo?.quotedMessage || m.videoMessage?.contextInfo?.quotedMessage;
    if (q) source = q;
    const [type, content] = await mediaFromMessage(source);
    if (!type || !content) {
      return ctx.reply({ text: `🕵️ *View-once / media reveal*\n\nReply to a view-once image/video (or any media) with:\n*${ctx.prefix}vv*` });
    }
    try {
      const buffer = await toBuffer(content, type);
      const caption = content.caption || `🕵️ Revealed · ${type}`;
      if (type === 'image') await ctx.send(ctx.jid, { image: buffer, caption }, { quoted: ctx.msg });
      else if (type === 'video') await ctx.send(ctx.jid, { video: buffer, caption }, { quoted: ctx.msg });
      else if (type === 'audio') await ctx.send(ctx.jid, { audio: buffer, mimetype: content.mimetype || 'audio/ogg; codecs=opus', ptt: !!content.ptt }, { quoted: ctx.msg });
      else await ctx.send(ctx.jid, { document: buffer, mimetype: content.mimetype || 'application/octet-stream', fileName: content.fileName || 'media.bin', caption }, { quoted: ctx.msg });
    } catch (e) {
      await ctx.reply({ text: `❌ Could not reveal media: ${e.message}` });
    }
  },
};
