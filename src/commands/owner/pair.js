/**
 * `.pair` — get a WhatsApp pairing code.
 *
 *   .pair              → pair the number that SENT the command (anyone)
 *   .pair 94771234567  → pair another number (MAIN number only)
 *   .pair refresh      → a fresh code for the attempt already on screen
 *
 * All the risky rules live in `services/pairing.js` (validation,
 * "never pair the primary number", session cap, per-number and per-IP rate
 * limits, code TTL) — this file only turns them into a readable reply.
 */
const pairing = require('../../services/pairing');
const sessionManager = require('../../whatsapp/sessionManager');
const config = require('../../config');

const digitsOf = (v) => String(v == null ? '' : v).split('@')[0].split(':')[0].replace(/\D/g, '');

/**
 * The pair page link. The web server works the address out at boot (env →
 * panel vars → a public-IP lookup → the bound port), so by the time anyone
 * types `.pair` there is normally a real, openable URL to hand them.
 */
async function siteLine() {
  try {
    const info = await require('../../web/server').pairUrl();
    if (info?.url) {
      const warn = info.isPublic ? '' : '\n⚠️ That address is private — set PAIR_PUBLIC_URL in .env to the panel\'s public IP:port.';
      return `\n🌐 Or open the pair page: ${info.url}${warn}`;
    }
  } catch { /* fall through to the generic hint */ }
  return `\n🌐 Pair page: http://<your-server-ip>:${config.port}/`;
}

function codeCard(view, prefix, site = '') {
  const secs = Math.max(0, view.secondsLeft || 0);
  const num = view.phonePretty || `+${view.phone}`;
  const name = (() => { try { return require('../../config').botName || 'the bot'; } catch { return 'the bot'; } })();
  // WhatsApp renders a ``` fenced block as monospace on every client, so the
  // code sits in its own box exactly the way the official screen shows it.
  return `🔗 *Your pairing code*

*${name}* · ${num}

\`\`\`
${view.code || '·· —— ——··'}
\`\`\`
⏱ about ${secs}s left — a fresh code replaces this one automatically

*On that phone*
1. WhatsApp → Settings
2. *Linked devices*
3. *Link a device* → Link with phone number instead
4. Type the code above

🔒 Never share this code — it links a device to that account.
Expired? ${prefix}pair refresh

After it links, that number runs *its own bot*: ${prefix}mybot renames it and
changes its logo.${site}`;
}

module.exports = {
  name: 'pair',
  aliases: ['link', 'addbot', 'paircode', 'pairagain'],
  category: 'tools',
  emoji: '🔗',
  description: 'Get a pairing code — no number means your own',
  ownerOnly: false,
  async execute(ctx) {
    const prefix = ctx.prefix || '.';
    const arg = String(ctx.args[0] || '').trim();
    const notify = { notifyJid: ctx.jid, notifySend: ctx.send };
    // Resolved once per command: the boot-time lookup is cached, so this is
    // normally just "what did the server bind to".
    const site = await siteLine();

    /* .pair refresh → a new code for the attempt that is already waiting */
    if (/^(refresh|new|again|retry)$/i.test(arg)) {
      const mine = pairing.state(digitsOf(ctx.sender || ctx.jid));
      if (!mine || mine.state !== 'waiting') {
        return ctx.reply({ text: `ℹ️ Nothing is waiting for a code right now.\nUse ${prefix}pair to start.` });
      }
      try {
        const view = await pairing.refresh(mine.id, { source: 'chat' });
        return ctx.reply({ text: codeCard(view, prefix, site) });
      } catch (e) {
        return ctx.reply({ text: `❌ ${e.message}` });
      }
    }

    /* whose number are we pairing? */
    let phone;
    if (!arg) {
      phone = digitsOf(ctx.sender || ctx.jid);
      if (!phone || phone.length < 8) {
        return ctx.reply({ text: `❌ I could not read your number from this chat.\nType it yourself: ${prefix}pair 94771234567` });
      }
    } else {
      if (!ctx.isMain) {
        return ctx.reply({ text:
`⛔ Only the *main* bot number can pair somebody else's number.

You can still pair your own — just type:
${prefix}pair` });
      }
      phone = sessionManager.normalizePhone(arg);
    }

    await ctx.reply({ text: `⏳ Asking WhatsApp for a code for *+${phone}*…` });
    try {
      const view = await pairing.request({ phone, source: 'chat', ...notify });
      if (view.state === 'linked') {
        return ctx.reply({ text: `✅ *+${view.phone}* is already linked — that number is online as its own bot session.\n\n${prefix}mybot — customise it\n${ctx.isMain ? `${prefix}sessions — every session` : ''}` });
      }
      return ctx.reply({ text: codeCard(view, prefix, site) });
    } catch (e) {
      const hint = {
        invalid: `Example: ${prefix}pair 94771234567 (country code, digits only)`,
        primary: `That is the bot's own number.\nUse ${prefix}pair with no number to pair YOUR phone, or give a different number.`,
        exists: 'It is already paired and online.',
        cap: `${ctx.isMain ? `Remove one with ${prefix}unpair <number>.` : 'Ask the bot owner to free a slot.'}`,
        'rate-phone': 'Wait a few minutes, then try again.',
        'rate-ip': 'Wait a few minutes, then try again.',
        cooldown: e.retryMs ? `Try again in ${Math.ceil(e.retryMs / 1000)}s — or ${prefix}pair refresh.` : 'Try again shortly.',
      }[e.reason] || '';
      return ctx.reply({ text: `❌ ${e.message}${hint ? `\n\n${hint}` : ''}` });
    }
  },
};
