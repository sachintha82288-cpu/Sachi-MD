const { downloadMediafire } = require('../../services/downloader/social');
const { human } = require('../../services/downloader/cleanup');
const { safeName } = require('../../services/downloader/http');
const { createProgressReporter } = require('../../services/downloader/progress');
module.exports = {
  name: 'mediafire', aliases: ['mf', 'mfire'], category: 'download', emoji: '☁️',
  description: 'Download a public MediaFire file',
  execute: async ({ send, edit, msg, jid, args, reply, prefix }) => {
    const url = (args[0] || '').trim();
    if (!/^https?:\/\/(www\.)?mediafire\.com\//i.test(url)) return reply({ text: `Usage: ${prefix}mf <MediaFire file URL>` });
    const status = await reply({ text: '🔎 *Opening MediaFire…*' });
    const reporter = createProgressReporter({ send, edit, jid, quoted: msg, title: 'MediaFire Download' });
    reporter.setKey(status?.key);
    try {
      const result = await downloadMediafire(url, { onProgress: (p) => reporter.update({ ...p, phase: p.phase || 'Receiving…' }) });
      await reporter.done({ downloaded: result.size, total: result.size, phase: `Ready • ${human(result.size)}` });
      await send(jid, { document: result.buffer, fileName: safeName(result.title || 'mediafire_file'), mimetype: result.mimeType || 'application/octet-stream', caption: `☁️ *${safeName(result.title || 'file')}*\n📦 ${human(result.size)}` }, { quoted: msg });
    } catch (e) { await reporter.fail(`MediaFire download failed: ${e.message}`); }
  },
};
