const { downloadTikTok } = require('../../services/downloader/social');
const { createProgressReporter } = require('../../services/downloader/progress');
const TT_RE = /^https?:\/\/((www|m|vm|vt)\.)?tiktok\.com\//i;
module.exports = {
  name: 'tiktok', aliases: ['tt', 'tik'], category: 'download', emoji: '🎵',
  description: 'Download a public TikTok video',
  execute: async (ctx) => {
    const url = (ctx.args[0] || '').trim();
    if (!TT_RE.test(url)) return ctx.reply({ text: `Usage: ${ctx.prefix}tiktok <TikTok URL>` });
    const status = await ctx.reply({ text: '🔎 *Reading TikTok…*' });
    const reporter = createProgressReporter({ send: ctx.send, edit: ctx.edit, jid: ctx.jid, quoted: ctx.msg, title: 'TikTok Download' });
    reporter.setKey(status?.key);
    try {
      const r = await downloadTikTok(url, { onProgress: (p) => reporter.update({ ...p, phase: p.phase || 'Downloading…' }) });
      await reporter.done({ downloaded: r.size, total: r.size, phase: r.via === 'api-fallback' ? 'Ready • API fallback' : 'Ready' });
      await ctx.send(ctx.jid, { video: r.buffer, mimetype: r.mimeType || 'video/mp4', caption: `🎵 *${String(r.title || 'TikTok').slice(0, 180)}*\n👤 ${r.uploader || 'unknown'}` }, { quoted: ctx.msg });
    } catch (e) { await reporter.fail(`Download failed: ${e.message}`); }
  },
};
