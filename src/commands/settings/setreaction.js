/**
 * .setreaction — pick the emoji the bot reacts with on status updates.
 *
 * Fully customisable:
 *   .setreaction            → a picker list (reply with a number)
 *   .setreaction 🔥         → one emoji
 *   .setreaction 🔥 😍 💯   → several: one is chosen at random per status
 *   .setreaction off        → stop reacting
 *
 * ZWJ families (👨‍👩‍👧‍👦), flags (🇱🇰) and keycaps (1️⃣) are kept whole —
 * the old fixed slice() cut them in half and WhatsApp rejected the reaction.
 */
const status = require('../../services/status/manager');
const selections = require('../../services/selection');

const PICKER = ['❤️', '🔥', '😍', '💯', '👍', '😂', '🥹', '✨', '🎉', '👀', '🙏', '💀'];

function current(s) {
  return `Current: *${s.reactions.join(' ')}* · auto-react ${s.autoReact ? '🟢 ON' : '⚪ OFF'}`;
}

module.exports = {
  name: 'setreaction',
  aliases: ['reaction', 'statusreaction', 'setemoji'],
  category: 'settings',
  emoji: '❤️',
  description: 'Choose the emoji (or emojis) used for automatic status reactions',
  ownerOnly: true, mainOnly: true,
  execute: async (ctx) => {
    const s = status.getSettings();
    const raw = ctx.args.join(' ').trim();

    /* off / disable */
    if (/^(off|disable|none|stop)$/i.test(raw)) {
      status.setAutoReact(false);
      return ctx.reply({ text: `⚪ Auto status react: *OFF*\nThe emoji list is kept — turn it back on with \`${ctx.prefix}autoreact on\`.` });
    }

    /* no argument → picker list, reply with a number */
    if (!raw) {
      const text =
`❤️ *Status reaction*

${current(s)}

*Pick one — reply with a number:*
${PICKER.map((e, i) => `*${i + 1}.* ${e}`).join('   ')}
*0.* ⚪ turn auto-react off

Or send your own: \`${ctx.prefix}setreaction 🦄\`
Several at once (one is picked at random): \`${ctx.prefix}setreaction 🔥 😍 💯\``;
      const sent = await ctx.reply({ text });
      if (!sent?.key?.id) return undefined;
      selections.remember(sent.key.id, {
        type: 'setreaction',
        chat: ctx.jid,
        sender: ctx.sender,
        handler: async ({ send, jid, msg, text: pick }) => {
          selections.cancel(sent.key.id);
          const n = Number(pick);
          if (n === 0) {
            status.setAutoReact(false);
            return send(jid, { text: '⚪ Auto status react: *OFF*' }, { quoted: msg });
          }
          const emoji = PICKER[n - 1];
          if (!emoji) return send(jid, { text: 'ℹ️ Pick a number from the list.' }, { quoted: msg });
          const next = status.setAutoReact(true, emoji);
          return send(jid, { text: `✅ Status reaction: *${next.reactions.join(' ')}* · auto-react *ON*` }, { quoted: msg });
        },
      });
      return undefined;
    }

    /* explicit emoji(s) */
    const list = status.parseReactions(raw);
    if (!list.length) {
      const bad = raw.length > 24 ? raw.slice(0, 24) + '…' : raw;
      return ctx.reply({ text:
`❌ *${bad}* is not an emoji — WhatsApp only accepts emoji reactions.

${current(s)}
Try: \`${ctx.prefix}setreaction 🔥\` or \`${ctx.prefix}setreaction 🔥 😍 💯\`
_Send \`${ctx.prefix}setreaction\` for the picker._` });
    }
    const next = status.setAutoReact(true, list);
    const many = next.reactions.length > 1
      ? `\n${next.reactions.length} emojis saved — one is chosen at random for every status.`
      : '';
    return ctx.reply({ text: `✅ Status reaction set to *${next.reactions.join(' ')}* · auto-react *ON*${many}` });
  },
};
