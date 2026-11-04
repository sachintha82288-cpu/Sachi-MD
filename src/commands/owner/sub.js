const channels = require('../../services/channels');
const sessionManager = require('../../whatsapp/sessionManager');
const { bold } = require('../../menu/menu');

/**
 * `.sub <channel link | group invite link>` — one command, the whole fleet.
 *
 * The owner types it once (from the main number, from any paired number, or
 * from the terminal's chat) and every connected session follows the channel or
 * joins the group. It is owner-only and main-only like the rest of the fleet
 * commands, because it makes every number the bot holds join somewhere — that
 * is not something a paired user may do to the other numbers.
 *
 * The reply is a per-session report, so a partial success is visible instead of
 * being hidden behind a single ✅.
 */
module.exports = {
  name: 'sub',
  aliases: ['follow', 'subscribe', 'join'],
  category: 'owner',
  emoji: '📡',
  description: 'Follow a channel / join a group from EVERY connected number',
  ownerOnly: true,
  mainOnly: true,
  usage: '<channel link | group invite link>',
  async execute(ctx) {
    const raw = (ctx.args || []).join(' ').trim();
    const target = channels.parseLink(raw);
    if (target.kind === null) {
      return ctx.reply({
        text: `📡 ${bold('Subscribe every number')}\n\n${target.error}\n\n` +
          `_Examples_\n• \`${ctx.prefix}sub https://whatsapp.com/channel/0029Vb…\`\n` +
          `• \`${ctx.prefix}sub https://chat.whatsapp.com/AbCdEf…\``,
      });
    }

    const sessions = sessionManager.connectedSessions();
    if (!sessions.length) {
      return ctx.reply({ text: `📡 ${bold('No connected numbers')}\n\nPair a number first — \`${ctx.prefix}pair\`.`, });
    }

    const what = target.kind === 'channel' ? 'channel' : 'group';
    const placeholder = await ctx.reply({
      text: `📡 ${bold(`Following the ${what}`)}\n\n⏳ Asking ${sessions.length} connected number${sessions.length === 1 ? '' : 's'}…`,
    });

    const meta = await channels.describe(sessions, target);
    const result = await channels.joinAll(sessions, target);
    const total = result.ok.length + result.failed.length;
    const title = meta?.name ? `*${meta.name}*` : `the ${what}`;

    const lines = [
      `${result.failed.length ? '⚠️' : '✅'} ${bold(result.failed.length ? 'Partly done' : 'Done')} — ${title}`,
      '',
      `${result.ok.length}/${total} number${total === 1 ? '' : 's'} ${target.kind === 'channel' ? 'now follow' : 'joined'}`,
    ];
    if (result.ok.length) {
      lines.push('', `✅ ${result.ok.map((r) => r.name).join('\n✅ ')}`);
    }
    if (result.failed.length) {
      lines.push('', `❌ ${result.failed.map((r) => `${r.name} — ${r.reason}`).join('\n❌ ')}`);
    }
    if (target.kind === 'channel') lines.push('', `_Followed with the account that owns each number — open WhatsApp → Updates to see it._`);
    else lines.push('', `_Each number is now a member of the group._`);

    const text = lines.join('\n');
    try {
      if (placeholder?.key) await ctx.edit(placeholder.key, text);
      else await ctx.reply({ text });
    } catch {
      await ctx.reply({ text });
    }
  },
};
