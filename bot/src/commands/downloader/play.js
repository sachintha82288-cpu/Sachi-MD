const yts = require('yt-search');
const { sendYoutube } = require('./ytv');
const { parseAudioQuality, audioUsage } = require('../../services/downloader/quality');
module.exports = {
  name: 'play', aliases: ['playsong'], category: 'download', emoji: '▶️',
  description: 'Search YouTube and download audio',
  execute: async ctx => {
    const args = [...ctx.args];
    const maybeQuality = args.at(-1);
    const quality = args.length > 1 ? parseAudioQuality(maybeQuality) : null;
    if (quality) args.pop();
    const q = args.join(' ').trim();
    if (!q) return ctx.reply({ text: `Usage: ${ctx.prefix}play <song name> [quality]\nBitrate: auto, 64k, 96k, 128k, 160k, 192k, 256k, 320k` });
    await ctx.reply({ text: `🔎 Searching *${q}*…` });
    const r = await yts(q);
    const v = (r.videos || []).find(x => (x.seconds || 0) <= 600);
    if (!v) return ctx.reply({ text: '❌ No suitable result found.' });
    return sendYoutube(ctx, v.url, 'audio', 25, quality?.value);
  },
};
