/**
 * `.mybot` — the identity of the bot session YOU are talking to.
 *
 * Every paired number runs its own bot, so it gets its own name, logo, card
 * header and footer. This is the place a paired user sees what theirs looks
 * like and how to change it; on the main number it shows the bot-wide
 * identity (the one every session inherits until it sets its own).
 */
const branding = require('../../services/branding');
const sessionManager = require('../../whatsapp/sessionManager');

const line = (label, value) => `• ${label.padEnd(8)}: ${value && String(value).trim() ? value : '_default_'}`;

module.exports = {
  name: 'mybot',
  aliases: ['mybots', 'botinfo2', 'identity', 'mybrand'],
  category: 'settings',
  emoji: '🪪',
  description: 'Your bot session: name, logo, header and footer',
  ownerOnly: false,
  async execute(ctx) {
    const prefix = ctx.prefix || '.';
    const key = ctx.brandKey || 'primary';
    const brand = ctx.brand || branding.forKey(key);
    const reset = /^(reset|clear|default)$/i.test(String(ctx.args[0] || ''));

    if (reset) {
      branding.reset(key);
      const fresh = branding.forKey(key);
      return ctx.reply({ text:
`↩️ *${brand.isPrimary ? 'Bot identity reset' : 'Your bot identity reset'}*

Everything is back to the defaults.
Name now: *${fresh.name}*` });
    }

    const who = brand.isPrimary
      ? '👑 MAIN session — this identity is the bot-wide default'
      : `📱 Your own session (+${key.replace(/\D/g, '')})`;
    const logoState = brand.logo ? `custom (\`${String(brand.logo).split('/').pop()}\`)` : 'the shipped logo';

    const sessions = brand.isPrimary ? sessionManager.listSessions().filter((s) => !s.isPrimary) : [];
    const sessionLine = brand.isPrimary && sessions.length
      ? `\n*Paired sessions* (${sessions.length})\n${sessions.map((s) => `• ${s.connected ? '🟢' : '🟡'} +${s.phone || '—'}${s.name ? ` · ${s.name}` : ''}`).join('\n')}\n${prefix}sessions — manage them`
      : '';

    return ctx.reply({ text:
`🪪 *Your bot*

${who}

*Menu identity*
${line('Name', brand.name)}
${line('Header', brand.header)}
${line('Footer', brand.footer)}
${line('Tagline', brand.tagline)}
• Logo    : ${logoState}
• Status  : ${brand.customised ? '🎨 customised by you' : '⚪ inheriting the defaults'}

*Make it yours*
${prefix}setname <name>        — up to 40 chars
${prefix}setheader <text>      — title above the menu card
${prefix}setfooter <text>      — line under the menu card
${prefix}settagline <text>     — the small line in the text menu
${prefix}setlogo               — reply to an image with it
${prefix}resetlogo             — back to the shipped logo
${prefix}mybot reset           — reset everything
${prefix}menu                  — see it right away
${sessionLine}${brand.isPrimary ? '' : `\n_Session management and the bot-wide settings belong to the main number._`}` });
  },
};
