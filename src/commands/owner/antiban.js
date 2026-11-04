const antiban = require('../../services/antiban');

const PRESETS = Object.keys(antiban.PRESETS || {});

/** How long ago, in words a person can read on a phone. */
function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

module.exports = {
  name: 'antiban',
  aliases: ['risk', 'abstatus'],
  category: 'owner',
  emoji: '🛡️',
  description: 'Show anti-ban status or change the protection',
  ownerOnly: true, mainOnly: true,
  async execute(ctx) {
    const sub = String(ctx.args[0] || '').toLowerCase();
    if (sub === 'on') { antiban.setEnabled(true); return ctx.reply({ text: '🛡️ Anti-ban: *ON*' }); }
    if (sub === 'off') { antiban.setEnabled(false); return ctx.reply({ text: '🛡️ Anti-ban: *OFF*\n⚠️ Sends are no longer rate-limited.' }); }
    if (sub === 'reset') {
      const s = antiban.reset();
      return ctx.reply({ text: `🛡️ Reset done.\nRisk: *${s.health.risk}/100* · pause: *none* · ban flags: *cleared*\nSpeed: *×${s.adaptive.factor.toFixed(2)}* — the bot is sending again.` }); }
    if (sub === 'save') {
      const ok = antiban.saveNow();
      return ctx.reply({ text: ok ? '🛡️ Protection state written to disk (`data/antiban-state.json`).' : '⚠️ Could not write the protection state.' }); }
    if (PRESETS.includes(sub)) {
      const preset = antiban.setPreset(sub);
      const s = antiban.status();
      return ctx.reply({ text: `🛡️ Anti-ban preset: *${preset}*\nPacing and rate limits are updated right away.\n• ${s.rate.limits.minute}/min · ${s.rate.limits.hour}/hr · ${s.rate.limits.day}/day\n• Reply budget: ${s.caps.shortReplyMs} ms (short) / ${s.caps.knownChatMs} ms` });
    }

    const s = antiban.status();
    const r = s.rate; const h = s.health; const w = s.warmup; const a = s.adaptive || {};
    const pc = r.perChat || {}; const pb = r.probes || {};
    const cls = h.classified || {};
    const lastBan = (h.recent || []).filter((e) => e.type === 'ban_signal').pop();
    const cool = h.coolOff || {};

    return ctx.reply({ text:
`╭━━〔 🛡️ ANTI-BAN 〕━━╮
┃ Status   : ${s.enabled ? '🟢 ON' : '⚪ OFF'}
┃ Preset   : ${s.preset}
┃ Typing   : ${s.typing ? '🟢 shown' : '⚪ hidden'}
┃ Risk     : ${h.level} (${h.risk}/100)
┃ Pause    : ${r.paused ? `yes · ${Math.ceil(r.pausedRemainingMs / 1000)}s` : 'no'}
╰━━━━━━━━━━━━━━━━━━━━━━╯

*Speed (adaptive)*
• Throughput : ×${Number(a.factor || 1).toFixed(2)} of the ${s.preset} preset
• Health     : ×${Number(h.throughputFactor || 1).toFixed(2)} · warm-up ×${Number(a.warmupFactor || 1).toFixed(2)}
• Reply cap  : ${s.caps ? s.caps.shortReplyMs : '—'} ms short · ${s.caps ? s.caps.knownChatMs : '—'} ms long
• Typing     : shown from the moment your message arrives, so the wait overlaps the work
${s.restored ? '• Restored : 🟢 protection state survived the last restart\n' : ''}
*Rate (used / limit)*
• Minute : ${r.minute} / ${r.limits.minute}  _(base ${r.base ? r.base.maxPerMinute : '—'})_
• Hour   : ${r.hour} / ${r.limits.hour}
• Day    : ${r.day} / ${r.limits.day}
• Per chat: max ${pc.limit || '—'}/min · ${pc.minGapMs || '—'} ms apart
• Known chats : ${r.knownChats}
• Sent (session) : ${r.stats.sent} · delayed ${r.stats.delayed} · held ${r.stats.blocked}${r.stats.overruns ? ` · ⚠️ ${r.stats.overruns} over-cap` : ''}

*Menu envelopes*
• Tried : ${s.probes.tried} · delivered : ${s.probes.delivered} · rejected : ${s.probes.rejected}
• Budget: ${pb.used || 0} / ${pb.limit || '—'} per ${Math.round((pb.windowMs || 0) / 1000)}s${s.probes.budgetBlocked ? ` · ⚠️ ${s.probes.budgetBlocked} held back` : ''}
  _Rejected envelopes are normal — they never raise the risk score._

*Warm-up*
• Account day : ${w.accountDay}
• Daily cap   : ${w.fullyWarmed ? 'full' : w.dailyCap}
• Today       : ${w.todayCount}
• Warmed      : ${w.fullyWarmed ? 'yes' : 'no'}

*Health — what those failures actually were*
• Ban signals : ${h.banSignals || 0}${lastBan ? ` (last ${ago(lastBan.at)}: ${String(lastBan.detail && lastBan.detail.detail || 'flagged').slice(0, 60)})` : ''}
• Transient   : ${cls.transient || 0}  _(network hiccups — small score)_
• Benign      : ${cls.benign || 0}  _(media/ffmpeg/usage problems — score 0)_
• Unknown     : ${cls.unknown || 0}
• Disconnects : ${h.disconnects} · send fails : ${h.sendFails}
• Cool-off    : ${cool.pauses ? `${cool.pauses} escalation(s) · last ${Math.round((cool.lastPauseMs || 0) / 1000)}s` : 'none'}${cool.lastAt ? ` · ${ago(cool.lastAt)}` : ''}
• Memory      : ${cool.remembered ? `⚠️ still angry — next signal pauses ${Math.round((cool.nextPauseMs || 0) / 1000)}s` : '🟢 clear'}

\`${ctx.prefix}antiban on|off|reset|save\`
\`${ctx.prefix}antiban ${PRESETS.join('|')}\`` });
  },
};
