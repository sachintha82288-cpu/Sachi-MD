const config = require('../../config');
const { downloadToMemory } = require('../../services/downloader/http');
const dl = require('../../services/downloader/manager');
const { assertPublicHttpUrl } = require('../../utils/network');
const { createProgressReporter } = require('../../services/downloader/progress');

module.exports = {
  name: 'download', aliases: ['dl', 'fetch'], category: 'download', emoji: '⬇️',
  description: 'Download a direct media URL into RAM',
  execute: async ({ send, edit, msg, jid, args, reply }) => {
    const url = args[0];
    if (!url) return reply({ text: `Usage: ${config.prefix}download <direct URL>\nMax ${config.limits.directMB} MB` });
    const status = await reply({ text: '⬇️ *Direct Download*\n\nPreparing…' });
    const reporter = createProgressReporter({ send, edit, jid, quoted: msg, title: 'Direct Download' });
    reporter.setKey(status?.key);
    let result;
    try {
      await assertPublicHttpUrl(url);
      result = await downloadToMemory(url, { maxBytes: config.limits.directMB * 1024 * 1024, timeout: 120000, onProgress: p => reporter.update({ ...p, phase: 'Receiving into RAM…' }) });
      await reporter.done({ downloaded: result.size, total: result.size, phase: `Ready to send • ${result.size ? `${(result.size / 1048576).toFixed(1)} MB` : '0 MB'}` });
    } catch (directError) {
      if (!dl.proxyManager.enabled) { await reporter.fail('The URL could not be downloaded safely or is unavailable.'); return; }
      const lease = await dl.proxyManager.acquire();
      if (!lease) { await reporter.fail('The URL is unavailable and no working proxy is available.'); return; }
      try {
        result = await downloadToMemory(url, { maxBytes: config.limits.directMB * 1024 * 1024, timeout: 120000, proxyUrl: lease.url, onProgress: p => reporter.update({ ...p, phase: 'Receiving through proxy into RAM…' }) });
        await dl.proxyManager.release(lease, true);
        await reporter.done({ downloaded: result.size, total: result.size, phase: 'Ready to send • proxy fallback' });
      } catch {
        await dl.proxyManager.release(lease, false);
        await reporter.fail('The direct download failed, including proxy fallback.');
        return;
      }
    }
    try {
      const name = result.fileName || 'download';
      const ct = result.mimeType || 'application/octet-stream';
      const content = ct.startsWith('image/') ? { image: result.buffer, mimetype: ct, caption: `📷 ${name}` }
        : ct.startsWith('video/') ? { video: result.buffer, mimetype: ct, caption: `🎬 ${name}` }
        : ct.startsWith('audio/') ? { audio: result.buffer, mimetype: ct, ptt: false }
        : { document: result.buffer, mimetype: ct, fileName: name };
      await send(jid, content, { quoted: msg });
    } catch { await reply({ text: '❌ The file was downloaded but could not be sent to WhatsApp.' }); }
  }
};
