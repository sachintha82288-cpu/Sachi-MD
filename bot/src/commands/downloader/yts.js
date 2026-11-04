const yts = require('yt-search');
module.exports = {
  name: 'yts', aliases: ['ytsearch', 'search'], category: 'download', emoji: '🔎',
  description: 'Search YouTube',
  execute: async ({ reply, args, prefix }) => {
    const q = args.join(' ').trim();
    if (!q) return reply({ text: `Usage: ${prefix}yts <query>` });
    try {
      const r = await yts(q);
      const v = (r.videos || []).slice(0, 5);
      if (!v.length) return reply({ text: '❌ No results.' });
      return reply({ text: `🔎 *YouTube Search: ${q}*\n\n${v.map((x, i) => `${i + 1}. *${x.title.slice(0, 70)}*\n⏱️ ${x.timestamp || '—'}\n🔗 ${x.url}`).join('\n\n')}` });
    } catch {
      return reply({ text: '❌ YouTube search is temporarily unavailable.' });
    }
  },
};
