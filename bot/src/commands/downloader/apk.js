const apkService = require('../../services/downloader/apk');
const selections = require('../../services/selection');
const { createProgressReporter } = require('../../services/downloader/progress');
const { human } = require('../../services/downloader/cleanup');
const { bold } = require('../../menu/menu');

const MAX_MB = () => (Number.isFinite(Number(process.env.MAX_APK_MB)) && Number(process.env.MAX_APK_MB) > 0
  ? Number(process.env.MAX_APK_MB)
  : 500);

function header() {
  return `📦 ${bold('APK Downloader')}`;
}

async function downloadAndSend(ctx, item, label) {
  const maxMB = MAX_MB();
  const status = await ctx.reply({ text: `${header()}\n⬇️ *Preparing download…*\n\n${label}` });
  const reporter = createProgressReporter({
    send: ctx.send, edit: ctx.edit, jid: ctx.jid, quoted: ctx.msg, title: 'APK Download',
  });
  reporter.setKey(status?.key);
  let result;
  try {
    result = await apkService.downloadApk(item, {
      maxMB,
      onProgress: (p) => reporter.update({ ...p, phase: p.phase || 'Receiving APK…' }),
    });
    await reporter.done({ downloaded: result.size, total: result.size, phase: `Ready • ${result.sizeLabel}` });
  } catch (e) {
    await reporter.fail(e.message || 'The APK download failed.');
    return;
  }
  try {
    await ctx.send(ctx.jid, {
      document: result.buffer,
      mimetype: 'application/vnd.android.package-archive',
      fileName: result.fileName,
      caption: `${header()}\n📱 *${result.name}*${result.version ? `  ·  v${result.version}` : ''}\n`
        + `${result.package ? `🔎 \`${result.package}\`\n` : ''}💾 ${result.sizeLabel} · 🌐 ${result.source}`
        + `${result.isBundle ? '\n📦 _XAPK bundle — install with an XAPK-capable installer (e.g. SAI)._' : ''}`
        + `\n\n⚠️ _APKs can carry malware — scan before installing._`,
    }, { quoted: ctx.msg });
  } catch {
    await ctx.reply({ text: '❌ The APK was downloaded but could not be sent to WhatsApp.' });
  }
}

function buildSelectionHandler(items, msgId) {
  return async (ctx) => {
    const n = Number(String(ctx.text || '').trim());
    if (n === 0) {
      selections.cancel(msgId);
      await ctx.reply({ text: `${header()}\n❎ Selection cancelled.` });
      return;
    }
    const item = items[n - 1];
    if (!item) {
      await ctx.reply({ text: `${header()}\n❓ Reply with a number between *1-${items.length}* (or *0* to cancel).` });
      return;
    }
    const title = item.name || item.package;
    const sizeLabel = item.sizeBytes ? ` · ${human(item.sizeBytes)}` : '';
    await downloadAndSend(ctx, item, `📱 *${title}*${item.version ? `  ·  v${item.version}` : ''}${sizeLabel}`);
  };
}

module.exports = {
  name: 'apk',
  aliases: ['app', 'apkdl'],
  category: 'download',
  emoji: '📦',
  description: `Search and download Android APKs (max ${MAX_MB()} MB)`,
  execute: async (ctx) => {
    const input = apkService.resolveInput((ctx.args || []).join(' '));
    if (input.type === 'empty') {
      return ctx.reply({
        text: `${header()}\n\nUsage: ${ctx.prefix}${bold('apk')} <app name / package / URL>\n\n`
          + `_Example:_ ${ctx.prefix}apk _whatsapp_\n`
          + `${ctx.prefix}apk _\`com.whatsapp\`_\n`
          + `${ctx.prefix}apk _https://f-droid.org/repo/….apk_`,
      });
    }

    // Direct URL or explicit package → download straight away
    if (input.type === 'url') {
      return downloadAndSend(ctx, { url: input.value, source: 'direct' }, '🔗 Direct URL');
    }
    if (input.type === 'package') {
      return downloadAndSend(ctx, { source: 'apkpure', package: input.value }, `🔎 \`${input.value}\``);
    }

    // Search query → results list → numbered selection
    const status = await ctx.reply({ text: `${header()}\n🔎 *Searching…* _${input.value}_` });
    let items = [];
    try {
      items = await apkService.search(input.value, { limit: 6 });
    } catch { /* handled below */ }
    if (!items.length) {
      const text = `${header()}\n ❌ No APKs found for *${input.value}*. Try the app's package name or a direct URL.`;
      try { await ctx.edit(status?.key, text); } catch { await ctx.reply({ text }); }
      return;
    }

    const lines = items.map((it, i) => {
      const name = it.name || it.package;
      const bits = [it.name ? `\`${it.package}\`` : '', it.version ? `v${it.version}` : '', it.sizeBytes ? human(it.sizeBytes) : ''].filter(Boolean);
      return `*${i + 1}.* 📱 *${name}*${bits.length ? `\n     ${bits.join('  ·  ')}` : ''}`;
    });
    const listText = `${header()}\n🔎 *Results for ${input.value}* (${items.length})\n\n${lines.join('\n')}\n\n`
      + `━━━━━━━━━━━━━━━━━\nReply with a *number* to download · *0* cancel\n_Only you can pick — valid for 5 minutes._`;

    const sent = await ctx.reply({ text: listText });
    if (!sent?.key?.id) return;
    const msgId = sent.key.id;
    selections.remember(msgId, {
      type: 'apk',
      chat: ctx.jid,
      sender: ctx.sender,
      handler: buildSelectionHandler(items, msgId),
    });
  },
};
