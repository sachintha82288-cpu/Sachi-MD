/**
 * `.sessions` — the main number's view of every bot this process is running.
 *
 * Shows the primary session, each paired session (with whose branding it is
 * wearing), anything still WAITING for a code, and how close the bot is to
 * its session cap — plus the pair page link to hand out.
 */
const sessionManager = require('../../whatsapp/sessionManager');
const pairing = require('../../services/pairing');
const branding = require('../../services/branding');
const mainGate = require('../../utils/mainGate');

function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const dot = (s) => (s.connected || String(s.state).toLowerCase() === 'connected' ? '🟢'
  : String(s.state).toLowerCase() === 'connecting' ? '🟡' : '🔴');

module.exports = {
  name: 'sessions',
  aliases: ['bots', 'paired', 'mysessions'],
  category: 'owner',
  emoji: '📱',
  description: 'List primary and paired bot sessions',
  ownerOnly: true,
  mainOnly: true,
  async execute(ctx) {
    // The router already refuses this for a non-main caller; a command that
    // DELETES files checks once more for itself.
    const blocked = mainGate.notice(ctx);
    if (blocked) return ctx.reply({ text: blocked });
    const prefix = ctx.prefix || '.';
    const list = sessionManager.listSessions();
    const st = pairing.stats();
    const pend = pairing.listPending().filter((p) => p.state === 'waiting');

    const lines = [];
    let n = 0;
    for (const s of list) {
      n++;
      const brand = s.isPrimary ? branding.forKey('primary') : branding.forKey(s.phone || s.id);
      const custom = brand.customised ? ` · 🎨 ${brand.name}` : '';
      lines.push(`${n}. ${dot(s)} *${s.isPrimary ? 'MAIN' : 'PAIRED'}* +${s.phone || '—'}\n   ${s.name || '—'} · ${s.state} · up ${ago(s.startedAt)}${custom}`);
    }

    const parts = [];
    parts.push(`📱 *Bot sessions* — ${st.inUse}/${st.maxSessions} paired slots used\n`);
    parts.push(lines.length ? lines.join('\n\n') : '_No sessions yet._');

    if (pend.length) {
      parts.push(`\n\n⏳ *Waiting to link* (${pend.length})\n${pend.map((p) =>
        `• +${p.phone} — \`${p.code}\` (${p.secondsLeft}s left, via ${p.source || 'chat'})`).join('\n')}`);
    }

    parts.push(`\n\n📊 codes issued ${st.issued} · linked ${st.linked} · refused ${st.refused} · refreshed ${st.refreshed}`);

    let url = null;
    try { url = (await require('../../web/server').pairUrl())?.url; } catch { url = null; }
    parts.push(`\n🌐 Pair page: ${url || `http://<your-server-ip>:${require('../../config').port}/`}`);
    if (url && st.inUse >= st.maxSessions) parts.push('\n⚠️ The bot is FULL — nobody can pair until you remove a session.');

    parts.push(`\n\n${prefix}pair <number> — add a session\n${prefix}unpair <number> — remove one\n${prefix}settings — modes, branding, limits`);

    await ctx.reply({ text: parts.join('') });
  },
};
