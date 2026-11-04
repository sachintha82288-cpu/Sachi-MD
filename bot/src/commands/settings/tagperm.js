/**
 * .tagperm — who is allowed to run .tagall.
 *
 * The bot ships wide open (everyone may tag the whole group) because that
 * was an explicit restriction removal. The owner can tighten it again:
 *
 *   .tagperm all      any member        (default)
 *   .tagperm admin    group admins + owner
 *   .tagperm owner    the bot owner only
 */
const settings = require('../../services/settings');

const EXPLAIN = {
  all: 'any member of the group',
  admin: 'group admins (and the owner)',
  owner: 'the bot owner only',
};

module.exports = {
  name: 'tagperm',
  aliases: ['tagallperm', 'settagperm'],
  category: 'settings',
  emoji: '📢',
  description: 'Choose who may use .tagall (owner, admins or everyone)',
  ownerOnly: true, mainOnly: true,
  execute: async ({ args, reply, prefix }) => {
    const current = settings.tagallPerm();
    const value = String(args[0] || '').toLowerCase();

    if (!value || value === 'status' || value === 'info') {
      return reply({ text:
`📢 *.tagall permission*

Now: *${current}* — ${EXPLAIN[current]}

${prefix}tagperm all     any member (default)
${prefix}tagperm admin   admins + owner
${prefix}tagperm owner   owner only

_The owner can always use ${prefix}tagall, whatever this is set to._` });
    }

    if (!settings.TAGALL_PERMS.includes(value)) {
      return reply({ text: `❌ Unknown level *${value}*.\n\nUse: ${prefix}tagperm <${settings.TAGALL_PERMS.join('|')}>` });
    }

    settings.update({ tagallPerm: value });
    return reply({ text: `✅ *.tagall* is now open to *${EXPLAIN[value]}*.` });
  },
};
