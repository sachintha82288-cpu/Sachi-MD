/**
 * `.unpair <number>` — cut a paired bot loose.
 *
 * MAIN number only (the number typed in the terminal). It does the whole job:
 * cancel any half-finished pairing attempt, disconnect and delete the session
 * credentials, and forget that number's stored branding — otherwise the next
 * person who pairs that number inherits the previous owner's name and logo.
 */
const sessionManager = require('../../whatsapp/sessionManager');
const pairing = require('../../services/pairing');
const branding = require('../../services/branding');
const config = require('../../config');
const mainGate = require('../../utils/mainGate');

module.exports = {
  name: 'unpair',
  aliases: ['unlink', 'removesession', 'unpairbot'],
  category: 'owner',
  emoji: '🔓',
  description: 'Disconnect and delete a paired bot session (main number only)',
  ownerOnly: true,
  mainOnly: true,
  async execute(ctx) {
    // The router already refuses this for a non-main caller; a command that
    // DELETES files checks once more for itself.
    const blocked = mainGate.notice(ctx);
    if (blocked) return ctx.reply({ text: blocked });
    const prefix = ctx.prefix || '.';
    const raw = String(ctx.args[0] || '').trim();

    if (!raw) {
      const list = sessionManager.listSessions().filter((s) => !s.isPrimary);
      if (!list.length) return ctx.reply({ text: `ℹ️ No paired sessions to remove.\nAdd one with ${prefix}pair <number>.` });
      return ctx.reply({ text:
`🔓 *Remove a session*

${list.map((s, i) => `${i + 1}. +${s.phone || '—'} · ${s.name || '—'} · ${s.connected ? '🟢 online' : s.state}`).join('\n')}

Usage: ${prefix}unpair <number>
Example: ${prefix}unpair 94771234567` });
    }

    const phone = sessionManager.normalizePhone(raw);
    if (!sessionManager.isValidPhone(phone)) {
      return ctx.reply({ text: `❌ That is not a valid number.\nExample: ${prefix}unpair 94771234567` });
    }
    const primary = sessionManager.normalizePhone(sessionManager.getPrimary()?.phone || config.owner || config.phoneNumber || '');
    if (phone === primary) {
      return ctx.reply({ text: '❌ That is the MAIN session — it cannot be unpaired from chat. Stop the bot instead.' });
    }

    const cancelled = pairing.cancel(phone);        // a code nobody finished linking
    try {
      await sessionManager.unpair(phone);
    } catch (e) {
      return ctx.reply({ text: `❌ ${e.message || 'Could not remove that session.'}${cancelled ? '\n(The pending pairing attempt was cancelled.)' : ''}` });
    }
    const hadBrand = (() => { try { return branding.raw(phone) ? true : false; } catch { return false; } })();
    try { branding.forget(phone); } catch {}
    try { branding.flush?.(); } catch {}

    await ctx.reply({ text:
`🔓 *Unpaired +${phone}*

• session disconnected and its files deleted
${cancelled ? '• the pending pairing code was cancelled\n' : ''}${hadBrand ? '• its stored name / logo / header / footer were forgotten\n' : ''}
Slots free: ${pairing.stats().maxSessions - pairing.stats().inUse}/${pairing.stats().maxSessions}` });
  },
};
