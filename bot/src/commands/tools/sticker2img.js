const { findMedia, downloadMedia, isWebp, isAnimatedWebp, isTgs, webpToPng, webpToMp4 } = require('../../services/media/stickerKit');
const { bold } = require('../../menu/menu');

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

function progress(stage, frame) {
  return `🖼️ ${bold('Sticker → Image')}\n🎞️ ${stage} ${SPIN[frame % SPIN.length]}`;
}

module.exports = {
  name: 'sticker2img',
  aliases: ['toimg', 's2i'],
  category: 'tools',
  emoji: '🖼️',
  description: 'Convert a sticker back to an image (static → PNG, animated → MP4)',
  async execute(ctx) {
    const { type, content } = findMedia(ctx.msg.message);
    if (type !== 'sticker') {
      return ctx.reply({
        text: `🖼️ ${bold('Sticker → Image')}\n\nSend a sticker with \`${ctx.prefix}sticker2img\` in its caption, or reply to a sticker with \`${ctx.prefix}sticker2img\`.`,
      });
    }

    let buf;
    try {
      buf = await downloadMedia(content, 'sticker');
    } catch (e) {
      return ctx.reply({ text: `❌ ${e.message}` });
    }

    if (isTgs(buf)) {
      return ctx.reply({ text: 'ℹ️ That is an animated Lottie (.tgs) sticker — this converter supports WebP stickers only.' });
    }
    if (!isWebp(buf)) {
      return ctx.reply({ text: 'ℹ️ Unsupported sticker format — WebP stickers only.' });
    }

    const animated = isAnimatedWebp(buf);
    const placeholder = await ctx.reply({ text: progress(animated ? 'Decoding animation…' : 'Decoding image…', 0) });
    let stage2 = animated ? 'Encoding MP4…' : 'Encoding PNG…';
    try {
      let out;
      let caption;
      if (animated) {
        try { await ctx.edit(placeholder.key, progress(stage2, 2)); } catch {}
        out = await webpToMp4(buf);
        caption = `🎞️ Sticker → MP4 · ${bold(require('../../services/settings').name())}`;
      } else {
        out = await webpToPng(buf);
        caption = `🖼️ Sticker → PNG · ${bold(require('../../services/settings').name())}`;
      }
      if (animated) {
        await ctx.send(ctx.jid, { video: out, mimetype: 'video/mp4', caption }, { quoted: ctx.msg });
      } else {
        await ctx.send(ctx.jid, { image: out, caption }, { quoted: ctx.msg });
      }
      const label = animated ? '🎞️ animated → MP4' : '🖼️ static → PNG';
      try { await ctx.edit(placeholder.key, `✅ ${bold('Converted')} · ${label}`); } catch {}
    } catch (e) {
      const text = `❌ Conversion failed: ${e.message}`;
      try { await ctx.edit(placeholder.key, text); } catch { await ctx.reply({ text }); }
    }
  },
};
