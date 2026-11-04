const dl = require('../../services/downloader/manager');
const { createProgressReporter } = require('../../services/downloader/progress');
const { parseVideoQuality, parseAudioQuality, videoUsage, audioUsage } = require('../../services/downloader/quality');

function dur(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`;
}

async function sendYoutube(ctx, url, mode = 'video', maxMB, qualityArg) {
  const isAudio = mode === 'audio';
  const rawQ = qualityArg === undefined || qualityArg === null ? 'auto' : String(qualityArg).trim();
  const parsed = isAudio ? parseAudioQuality(rawQ || 'auto') : parseVideoQuality(rawQ || 'auto');
  if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url || '')) {
    return ctx.reply({ text: isAudio ? audioUsage(ctx.prefix) : videoUsage(ctx.prefix) });
  }
  if (!parsed) {
    return ctx.reply({ text: isAudio ? audioUsage(ctx.prefix) : videoUsage(ctx.prefix) });
  }
  const selected = parsed.best
    ? 'best'
    : parsed.auto
      ? (isAudio ? `auto (${parsed.value} kbps)` : `auto (${parsed.value}p)`)
      : (isAudio ? `${parsed.value} kbps` : `${parsed.value}p`);
  const status = await ctx.reply({ text: `🔎 *Reading media information…*\n🎯 Target: ${selected}` });
  const reporter = createProgressReporter({
    send: ctx.send, edit: ctx.edit, jid: ctx.jid, quoted: ctx.msg,
    title: isAudio ? 'YouTube Audio' : 'YouTube Video',
  });
  reporter.setKey(status?.key);
  let meta;
  try {
    meta = await dl.info(url, { onProgress: (p) => p && reporter.update({ ...p, phase: 'Reading metadata…' }) });
  } catch (e) {
    await reporter.fail(`Could not read media information: ${e.message}`);
    return;
  }
  const title = (meta.title || 'YouTube').slice(0, 120);
  const duration = dur(meta.duration);
  const channel = meta.uploader || meta.channel || '—';
  await reporter.update({ percent: 0, phase: `${title}\n👤 ${channel}  •  ⏱️ ${duration}\n🎯 ${selected}` }, true);
  try {
    const r = await dl.download(url, {
      mode, maxMB, quality: parsed.best ? 'best' : parsed.value,
      onProgress: (p) => reporter.update({ ...p, phase: p.phase || `Downloading ${isAudio ? 'audio' : 'video'}…` }),
    });
    await reporter.done({
      downloaded: r.size, total: r.size,
      phase: `Ready to send • ${r.via === 'proxy' ? 'proxy fallback' : 'RAM download'} • ${selected}`,
    });
    const caption = `${isAudio ? '🎧' : '🎬'} *${title}*\n👤 ${channel} · ⏱️ ${duration}\n🎯 ${selected}${r.via === 'proxy' ? '\n🌐 proxy fallback' : ''}`;
    if (isAudio) {
      await ctx.send(ctx.jid, { audio: r.buffer, mimetype: r.mimeType || 'audio/mp4', ptt: false, caption }, { quoted: ctx.msg });
    } else {
      await ctx.send(ctx.jid, { video: r.buffer, mimetype: r.mimeType || 'video/mp4', caption }, { quoted: ctx.msg });
    }
  } catch (e) {
    await reporter.fail(`Download failed: ${e.message}`);
  }
}

module.exports = {
  name: 'ytv', aliases: ['ytvideo', 'video'], category: 'download', emoji: '🎬',
  description: 'Download YouTube video with quality selection',
  execute: async (ctx) => sendYoutube(ctx, ctx.args[0], 'video', undefined, ctx.args[1]),
  sendYoutube,
};
