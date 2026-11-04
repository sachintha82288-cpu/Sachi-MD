/**
 * Generic pending-selection registry.
 *
 * Lets a command post a "reply with a number" list (like the built-in menu)
 * and handle the chosen number when the user replies to that message.
 * One active selection per chat: a new search silently replaces the old one.
 * Entries expire after SELECTION_TTL_MS and are pruned lazily.
 */
const TTL = Number(process.env.SELECTION_TTL_MS) >= 30_000
  ? Number(process.env.SELECTION_TTL_MS)
  : 5 * 60 * 1000;
const MAX_ENTRIES = 500;

const entries = new Map();   // botMessageId -> { type, chat, sender, handler, expiresAt }
const chatIndex = new Map(); // chat jid      -> botMessageId

function prune(now = Date.now()) {
  for (const [id, e] of entries) if (e.expiresAt <= now) { entries.delete(id); }
}

function remember(msgId, { type, chat, sender, handler }) {
  if (!msgId || typeof handler !== 'function') return false;
  prune();
  // one active selection per chat — invalidate the previous one
  const prev = chatIndex.get(chat);
  if (prev) entries.delete(prev);
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  entries.set(msgId, { type, chat, sender: sender || null, handler, expiresAt: Date.now() + TTL });
  chatIndex.set(chat, msgId);
  return true;
}

/**
 * Look up a pending selection for a number-reply.
 * Returns null when: unknown id, expired, different chat, or (in groups)
 * a different sender than the one who started it.
 */
function get(msgId, chat, sender) {
  const e = entries.get(String(msgId || ''));
  if (!e) return null;
  if (e.expiresAt <= Date.now()) { entries.delete(String(msgId || '')); return null; }
  if (e.chat !== chat) return null;
  if (e.sender && sender && e.sender !== sender) return null;
  return e;
}

function cancel(msgId) {
  const e = entries.get(String(msgId || ''));
  if (!e) return false;
  entries.delete(String(msgId || ''));
  if (chatIndex.get(e.chat) === String(msgId || '')) chatIndex.delete(e.chat);
  return true;
}

function reset() { entries.clear(); chatIndex.clear(); }

module.exports = { remember, get, cancel, reset, TTL };
