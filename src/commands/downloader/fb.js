const { downloadFacebook } = require('../../services/downloader/social');
const { createProgressReporter } = require('../../services/downloader/progress');
const FB_RE = /^https?:\/\/((www|m|web|mbasic)\.)?(facebook\.com|fb\.watch|fb\.com|fb\.me)\//i;
module.exports = {
  name: 'fb', aliases: ['facebook', 'fbdl'], category: 'download', emoji: '📘',
  description: 'Download a public Facebook video',
  execute: async (ctx) => {
    const url = (ctx.args[0] || '').trim();
    if (!FB_RE.test(url)) return ctx.reply({ text: `Usage: ${ctx.prefix}fb <Facebook video URL>` });
    const status = await ctx.reply({ text: '🔎 *Reading Facebook video…*' });
    const reporter = createProgressReporter({ send: ctx.send, edit: ctx.edit, jid: ctx.jid, quoted: ctx.msg, title: 'Facebook Download' });
    reporter.setKey(status?.key);
    try {
      const r = await downloadFacebook(url, { onProgress: (p) => reporter.update({ ...p, phase: p.phase || 'Downloading…' }) });
      await reporter.done({ downloaded: r.size, total: r.size, phase: r.via === 'proxy' ? 'Ready • proxy' : 'Ready' });
      await ctx.send(ctx.jid, { video: r.buffer, mimetype: r.mimeType || 'video/mp4', caption: `📘 *${String(r.title || 'Facebook video').slice(0, 150)}*` }, { quoted: ctx.msg });
    } catch (e) { await reporter.fail(`Download failed: ${e.message}`); }
  },
};
