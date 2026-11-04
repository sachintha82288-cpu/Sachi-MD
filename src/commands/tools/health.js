const log = require('../../utils/logger');
const antiban = require('../../services/antiban');
const mode = require('../../services/mode');
const settings = require('../../services/settings');
const statusCentre = require('../../services/status/manager');
const whatsapp = require('../../whatsapp/client');
const capabilities = require('../../services/menu/capabilities');
const crashlog = require('../../utils/crashlog');

/**
 * A health report the owner can read straight from WhatsApp:
 * why is the bot slow / quiet / not answering?
 */
module.exports = {
  name: 'health',
  aliases: ['bothealth', 'diagnose', 'why'],
  category: 'owner',
  emoji: '🩺',
  description: 'Show why the bot is slow, quiet or not answering',
  ownerOnly: true, mainOnly: true,
  execute: async ({ reply }) => {
    const ab = antiban.status();
    const wa = whatsapp.status();
    const recent = log.recent(6);
    const errors = recent.filter((e) => e.level === 'error');
    const lines = recent.map((e) => `${e.level === 'error' ? '❌' : '⚠️'} _${e.text}_`).join('\n') || '_nothing logged yet_';
    const caps = capabilities.status ? capabilities.status() : null;
    const st = statusCentre.status();
    const crash = crashlog.last();
    // How much junk WhatsApp replayed at us (old commands, history syncs,
    // duplicate ids). Non-zero is normal and healthy — it means the bot is
    // refusing to answer messages from the past.
    const ignored = (wa.sessions || []).reduce((n, x) => {
      const k = x.skipped || {};
      return n + (k.backlog || 0) + (k.stale || 0) + (k.duplicate || 0);
    }, 0);
    return reply({
      text: `🩺 *Bot health*

*WhatsApp*
• Connected : ${wa.connected ? '🟢 yes' : '🟡 not yet'}
• Sessions  : ${(wa.sessions || []).length || 1}
• Replays   : ${ignored} old message(s) ignored (backlog / stale / duplicate)

*Anti-ban*
• Protection: ${ab.enabled ? '🟢 ON' : '⚪ OFF'} · preset *${ab.preset}*${ab.restored ? ' · 🟢 state survived the restart' : ''}
• Risk      : ${ab.health.risk}/100 (${ab.health.level})${ab.health.banSignals ? ` · ⚠️ ${ab.health.banSignals} ban signal(s)` : ''}
• Paused    : ${ab.rate.paused ? `🔴 yes · ${Math.ceil(ab.rate.pausedRemainingMs / 1000)}s` : '🟢 no'}
• Rate      : ${ab.rate.minute}/${ab.rate.limits.minute} per minute · ${ab.rate.hour}/${ab.rate.limits.hour} per hour
• Speed     : ×${Number((ab.adaptive || {}).factor || 1).toFixed(2)} throughput (health ×${Number(ab.health.throughputFactor || 1).toFixed(2)}, warm-up ×${Number((ab.adaptive || {}).warmupFactor || 1).toFixed(2)})
• Failures  : benign ${(ab.health.classified || {}).benign || 0} · transient ${(ab.health.classified || {}).transient || 0} · unknown ${(ab.health.classified || {}).unknown || 0}
• Typing    : ${ab.typing ? '🟢 shown' : '⚪ hidden'} · ${(ab.presence || {}).typingNow || 0} chat(s) typing now

*Settings*
• Mode      : *${mode.current()}*
• Name      : ${settings.name()}
• Header    : ${settings.header() || '—'} · Footer: ${settings.footer() || '—'}
• Tagall    : open to *${settings.tagallPerm()}*

*Status centre*
• Cached    : ${st.statuses} status(es) from ${st.users} user(s) · ${st.sockets} session(s)
• Seen      : ${st.autoSeen ? '🟢 ON' : '⚪ OFF'} · React: ${st.autoReact ? `🟢 ${st.reactions.join(' ')}` : '⚪ OFF'}
• Forward   : ${st.autoForward ? `🟢 ON → ${st.forwardTo ? '+' + String(st.forwardTo).replace(/\D/g, '') : 'your chat'}` : '⚪ OFF'}

*Recent log*
${lines}${crash ? `

*Last crash* (data/crash.log)
❗ ${crash}` : ''}

${errors.length ? `_${errors.length} error(s) in the last ${recent.length} log lines._` : ''}`
    });
  }
};
