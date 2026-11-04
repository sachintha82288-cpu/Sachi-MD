const mode = require('../../services/mode');
const settings = require('../../services/settings');
const branding = require('../../services/branding');
const status = require('../../services/status/manager');
const antiban = require('../../services/antiban');
const sessionManager = require('../../whatsapp/sessionManager');
const pairing = require('../../services/pairing');
const config = require('../../config');

module.exports = {
  name: 'settings',
  aliases: ['config', 'botsettings', 'preferences'],
  category: 'settings',
  emoji: '⚙️',
  description: 'Show the settings you may change (your bot, or the whole bot)',
  ownerOnly: true,
  execute: async (ctx) => {
    const { reply, prefix } = ctx;
    const key = ctx.isMain ? 'primary' : (ctx.brandKey || 'primary');
    const brand = ctx.brand || branding.forKey(key);

    /* ── a paired session: your own bot, your own menu identity ── */
    if (!ctx.isMain) {
      const mine = sessionManager.listSessions().find((s) => String(s.phone) === String(key).replace(/\D/g, ''));
      return reply({ text:
`⚙️ *Your bot — ${brand.name}*

📱 Session    : +${String(key).replace(/\D/g, '')}${mine ? ` · ${mine.connected ? '🟢 online' : '🟡 reconnecting'}` : ''}
👤 Name       : *${mine?.name || 'WhatsApp user'}*
🏷️ Bot name   : *${brand.name}*
🖼️ Logo       : ${brand.logo ? 'custom (yours)' : 'the shared logo'}
📝 Header     : ${brand.header ? `_${brand.header}_` : '_not set_'}
📄 Footer     : ${brand.footer ? `_${brand.footer}_` : '_not set_'}
✨ Tagline    : ${brand.tagline ? `_${brand.tagline}_` : '_not set_'}

*Make it yours*
${prefix}setname <name>
${prefix}setheader <text>
${prefix}setfooter <text>
${prefix}settagline <text>
${prefix}setlogo — reply to an image
${prefix}resetlogo · ${prefix}mybot reset
${prefix}menu — see it now

_Sessions, modes, prefix, status automation and the anti-ban panel belong to the main number (${prefix}pair tells you more)._` });
    }

    /* ── the main number: the whole bot ── */
    const s = settings.get();
    const st = status.getSettings();
    const ab = antiban.status();
    const ps = pairing.stats();
    const sessions = sessionManager.listSessions().filter((x) => !x.isPrimary);
    const customised = branding.list();
    const url = String(process.env.PAIR_PUBLIC_URL || '').trim() || `http://<your-server-ip>:${config.port}/`;
    const text =
`⚙️ *${brand.name} — settings*

🎚️ Mode       : *${mode.current()}* — ${mode.hint()}
🏷️ Name       : *${brand.name}*
🖼️ Logo       : ${brand.logo ? 'custom' : 'default (assets/logo.jpg)'}
📝 Header     : ${brand.header ? `_${brand.header}_` : '_not set_'}
📄 Footer     : ${brand.footer ? `_${brand.footer}_` : '_not set_'}
🔰 Prefix     : *${prefix}*
📢 Tagall     : open to *${s.tagallPerm}*

*Sessions*
📱 Paired     : ${sessions.length}/${ps.maxSessions}${sessions.length ? ` — ${sessions.map((x) => `${x.connected ? '🟢' : '🟡'}+${x.phone || '?'}`).join(' ')}` : ''}
⏳ Pairing now : ${ps.pending} waiting · ${ps.linked} linked
🎨 Own identity: ${customised.length} session(s)
🔗 ${prefix}pair <number> — add one (or send ${prefix}pair from any phone)
🌐 Pair page  : ${url}

*Status center*
👁️ Auto seen   : ${st.autoSeen ? '🟢 ON' : '⚪ OFF'}
❤️ Auto react  : ${st.autoReact ? `🟢 ON · ${st.reactions.join(' ')}` : '⚪ OFF'}
📤 Auto forward: ${st.autoForward ? `🟢 ON → ${st.forwardTo ? '+' + String(st.forwardTo).replace(/\D/g, '') : 'your chat'}` : '⚪ OFF'}

*Anti-ban*
🛡️ Protection : ${ab.enabled ? '🟢 ON' : '⚪ OFF'} · preset *${ab.preset}* · ×${Number((ab.adaptive || {}).factor || 1).toFixed(2)} speed
⌨️ Typing      : ${ab.typing ? '🟢 shown' : '⚪ hidden'}
📊 Risk       : ${ab.health.level} (${ab.health.risk}/100)${ab.rate.paused ? ` · paused ${Math.ceil(ab.rate.pausedRemainingMs / 1000)}s` : ''}

*Change something (main number only):*
${prefix}mode <self|inbox|public|groups|all>
${prefix}setname <name> · ${prefix}setheader <text>
${prefix}setfooter <text> · ${prefix}settagline <text>
${prefix}setlogo — reply to an image · ${prefix}resetlogo
${prefix}setreaction 🔥 😍 💯   (or just ${prefix}setreaction for the picker)
${prefix}autoseen on|off · ${prefix}autoreact on|off
${prefix}autoforward on|off [number]
${prefix}tagperm <owner|admin|all>
${prefix}antiban <conservative|moderate|aggressive|turbo|reset>
${prefix}sessions · ${prefix}unpair <number>`;
    return reply({ text });
  }
};
