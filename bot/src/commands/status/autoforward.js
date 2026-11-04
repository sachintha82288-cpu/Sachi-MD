/**
 * .autoforward — every status WhatsApp delivers is re-sent to the owner's
 * chat, so nothing is lost when nobody asks for it. This is what makes the
 * status saver work even for statuses posted while you were away.
 *
 *   .autoforward on            → forward to the owner chat
 *   .autoforward on 9477xxxx   → forward to another number
 *   .autoforward off
 */
const status = require('../../services/status/manager');

module.exports = {
  name: 'autoforward',
  aliases: ['statusforward', 'autosave', 'autodownload'],
  category: 'status',
  emoji: '📤',
  description: 'Forward every new status to your chat automatically',
  ownerOnly: true, mainOnly: true,
  execute: async (ctx) => {
    const value = String(ctx.args[0] || '').toLowerCase();
    const s = status.getSettings();

    if (value === 'off' || value === 'disable' || value === 'stop') {
      status.setAutoForward(false);
      return ctx.reply({ text: '⚪ Auto Status Forward: *OFF*\nUse `' + ctx.prefix + 'status <number>` to pull statuses on demand.' });
    }

    if (value === 'on' || value === 'enable') {
      const target = String(ctx.args[1] || '').trim();
      if (target) {
        const number = status.normalizeNumber(target);
        if (number.length < 4 || number.length > 20) {
          return ctx.reply({ text: `❌ *${target}* is not a phone number.\n\n${ctx.prefix}autoforward on 94771234567` });
        }
        const next = status.setAutoForward(true, number);
        return ctx.reply({ text: `📤 Auto Status Forward: *ON* → +${status.normalizeNumber(next.forwardTo)}\nEvery new status is sent there as it arrives.` });
      }
      const next = status.setAutoForward(true, '');
      return ctx.reply({ text: `📤 Auto Status Forward: *ON* → your chat${next.forwardTo ? ` (+${status.normalizeNumber(next.forwardTo)})` : ''}\nEvery new status is re-sent as it arrives — nothing is missed.` });
    }

    return ctx.reply({ text:
`📤 *Auto status forward*

State: ${s.autoForward ? '🟢 ON' : '⚪ OFF'}${s.forwardTo ? ` → +${status.normalizeNumber(s.forwardTo)}` : s.autoForward ? ' → owner chat' : ''}

${ctx.prefix}autoforward on            forward to your chat
${ctx.prefix}autoforward on 9477xxxx   forward to another number
${ctx.prefix}autoforward off

_Forwarded statuses are also cached, so ${ctx.prefix}status <number> keeps working._` });
  },
};
