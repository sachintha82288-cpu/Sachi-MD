/**
 * Follow / join on behalf of EVERY connected session. `.sub` in one chat has to
 * act for the whole fleet, and that is not one call: following a WhatsApp
 * Channel uses the newsletter API (`newsletterFollow`), joining a group uses
 * the invite API (`groupAcceptInvite`). They are different protocols, so the
 * link is resolved first and then each socket does the thing that fits.
 *
 * Everything here is best-effort per session: one number that is banned from
 * following a channel, has no data, or is still connecting must not stop the
 * other seven from succeeding. That is why the result is a list, not a throw.
 */
const log = require('../utils/logger');

const CHANNEL_HOSTS = /(?:whatsapp\.com|whatsapp\.net)\/channel\//i;
const INVITE_HOSTS = /chat\.whatsapp\.com\//i;

/**
 * Turn whatever the owner pasted into `{ kind, value }`.
 *   channel → `https://whatsapp.com/channel/0029Vb…` (also `/channel/…` alone)
 *   group   → `https://chat.whatsapp.com/AbCdEf…`      (also a bare invite code)
 * Anything else is rejected with a message that says what was expected.
 */
function parseLink(raw) {
  const text = String(raw || '').trim();
  if (!text) return { kind: null, error: 'Paste a channel link or a group invite link.' };
  if (CHANNEL_HOSTS.test(text) || /^[0-9A-Za-z]{20,}$/.test(text) && text.startsWith('0029')) {
    const m = text.match(/channel\/([0-9A-Za-z_-]+)/i) || text.match(/^([0-9A-Za-z_-]{20,})$/);
    if (!m) return { kind: null, error: 'That channel link is missing its id.' };
    return { kind: 'channel', value: m[1] };
  }
  if (INVITE_HOSTS.test(text) || /^([0-9A-Za-z]{18,24})$/.test(text)) {
    const m = text.match(/chat\.whatsapp\.com\/([0-9A-Za-z_-]+)/i) || text.match(/^([0-9A-Za-z]{18,24})$/);
    if (!m) return { kind: null, error: 'That invite link is missing its code.' };
    return { kind: 'group', value: m[1] };
  }
  return {
    kind: null,
    error: 'Unrecognised link. Send a channel link (whatsapp.com/channel/…) or a group invite link (chat.whatsapp.com/…).',
  };
}

/** A short reason, because "Error: 400" tells the owner nothing. */
function friendly(e) {
  const raw = String(e?.message || e || 'unknown error');
  if (/not-authorized|forbidden|403|banned/i.test(raw)) return 'WhatsApp refused it for this number (not allowed / banned from it)';
  if (/gone|item-not-found|404/i.test(raw)) return 'that channel or group no longer exists, or the link expired';
  if (/conflict|already/i.test(raw)) return 'it was already joined';
  if (/timeout|timed out|ETIMEDOUT/i.test(raw)) return 'the request timed out';
  if (/not connected|socket/i.test(raw)) return 'that session is not connected';
  return raw.slice(0, 120);
}

function labelOf(session) {
  if (!session) return '?';
  if (session.isPrimary) return `main${session.phone ? ` +${session.phone}` : ''}`;
  return `+${session.phone || session.id}`;
}

/**
 * Follow a channel / join a group from every connected session.
 *
 * @param {Array} sessions  from sessionManager.connectedSessions()
 * @param {{kind:'channel'|'group', value:string}} target
 * @param {{concurrency?:number}} opts
 * @returns {Promise<{ok:Array, failed:Array, kind:string, value:string}>}
 */
async function joinAll(sessions, target, { concurrency = 3 } = {}) {
  const list = Array.isArray(sessions) ? sessions.slice() : [];
  const ok = [];
  const failed = [];
  let index = 0;
  async function worker() {
    while (index < list.length) {
      const session = list[index++];
      const name = labelOf(session);
      try {
        if (!session?.sock) throw new Error('not connected');
        if (target.kind === 'channel') {
          const jid = target.value.includes('@newsletter') ? target.value : `${target.value}@newsletter`;
          await session.sock.newsletterFollow(jid);
        } else {
          const res = await session.sock.groupAcceptInvite(target.value);
          // `groupAcceptInvite` returns the group's jid on success, and an
          // empty/undefined result when the code was already used by this
          // account — which is a success for our purposes, not a failure.
          if (!res) log.info(`[sub] ${name}: the invite reported no new group (already a member)`);
        }
        ok.push({ name, id: session.id, isPrimary: !!session.isPrimary });
      } catch (e) {
        failed.push({ name, id: session.id, reason: friendly(e) });
        log.warn(`[sub] ${name} could not ${target.kind === 'channel' ? 'follow' : 'join'}: ${friendly(e)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  return { ok, failed, kind: target.kind, value: target.value };
}

/** Look the target up so the confirmation can say WHAT was joined. */
async function describe(sessions, target) {
  const sock = (sessions || []).find((s) => s?.sock);
  if (!sock) return null;
  try {
    if (target.kind === 'channel') {
      const jid = `${target.value}@newsletter`;
      const meta = await sock.sock.newsletterMetadata('jid', jid);
      return meta ? { name: meta.name || null, subscribers: meta.subscriberCount || null } : null;
    }
    return { name: null };
  } catch { return null; }
}

module.exports = { parseLink, joinAll, describe, friendly, labelOf };
