const { findMedia, downloadMedia, removeBackgroundPng, circleCropPng, imageToStickerWebp } = require('../../services/media/stickerKit');
const { bold } = require('../../menu/menu');

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

function progress(stage, frame) {
  return `🖼️ ${bold('Img → Sticker')}\n✂️ ${stage} ${SPIN[frame % SPIN.length]}`;
}

module.exports = {
  name: 'img2sticker',
  aliases: ['i2s', 'cutout'],
  category: 'tools',
  emoji: '✂️',
  description: 'Turn an image into a sticker — AI background cutout (falls back to circle crop)',
  async execute(ctx) {
    const { type, content } = findMedia(ctx.msg.message);
    if (type !== 'image') {
      return ctx.reply({
        text: `✂️ ${bold('Img → Sticker')}\n\nSend an image with \`${ctx.prefix}img2sticker\` in the caption, or reply to an image with \`${ctx.prefix}img2sticker\`.\n\n_For videos use ${ctx.prefix}sticker._`,
      });
    }

    let buf;
    try {
      buf = await downloadMedia(content, 'image');
    } catch (e) {
      return ctx.reply({ text: `❌ ${e.message}` });
    }

    const placeholder = await ctx.reply({ text: progress('Preparing…', 0) });
    let frame = 0;
    const stage = async (s) => {
      if (!placeholder?.key) return;
      try { await ctx.edit(placeholder.key, progress(s, ++frame)); } catch {}
    };

    let source = null;
    let via = 'circle-crop';
    let aiFailed = false;
    let aiMissing = false;
    try {
      const cutout = await removeBackgroundPng(buf, { onStage: stage });
      if (cutout) { source = cutout; via = 'ai-cutout'; }
      else aiMissing = true;              // the optional model is not installed
    } catch {
      aiFailed = true;
    }

    if (!source) {
      try {
        await stage('Framing a circle crop…');
        source = await circleCropPng(buf);
      } catch (e) {
        const text = `❌ Could not build the sticker: ${e.message}`;
        try { await ctx.edit(placeholder.key, text); } catch { await ctx.reply({ text }); }
        return;
      }
    }

    try {
      const sticker = await imageToStickerWebp(source, { quality: 90 });
      await ctx.send(ctx.jid, { sticker }, { quoted: ctx.msg });
      const label = via === 'ai-cutout' ? '✂️ AI background cutout' : '⭕ circle crop';
      // Be honest about which one was used. The AI model is an OPTIONAL 130 MB
      // dependency (@imgly/background-removal-node) and is not installed by
      // default, so saying "AI cutout" would be a lie and saying nothing
      // leaves the owner wondering why the background is still there.
      const note = aiMissing
        ? `\n\n_AI cutout is not installed on this bot — a circle crop was sent.\nRun_ \`npm i @imgly/background-removal-node\` _to enable it (130 MB). One-time download, then it works offline._`
        : aiFailed
          ? '\n\n⚠️ _AI cutout failed — sent a circle crop instead._'
          : '';
      try { await ctx.edit(placeholder.key, `✅ ${bold('Sticker ready')} · ${label}${note}`); }
      catch {}
    } catch (e) {
      const text = `❌ Sticker conversion failed: ${e.message}`;
      try { await ctx.edit(placeholder.key, text); } catch { await ctx.reply({ text }); }
    }
  },
};
