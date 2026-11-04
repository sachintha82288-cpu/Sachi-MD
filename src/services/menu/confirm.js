/**
 * Destructive-action confirmations.
 *
 * A tap on a menu row must not instantly kill the bot. Every destructive
 * command (.shutdown, .restart, .unpair, .setprefix, .cleanup, .antiban
 * off/reset) goes through a two-step card:
 *
 *   tap row  →  "⚠️ Confirm <action>?"  +  ✅ Confirm / ❌ Cancel
 *   confirm  →  the command actually runs
 *
 * Pending confirmations are per chat + per sender (a group member cannot
 * confirm somebody else's tap) and expire in 60 s.
 */
const TTL_MS = Math.max(15_000, Number(process.env.MENU_CONFIRM_TTL_MS) || 60_000);
const MAX_ENTRIES = 200;

const pending = new Map(); // key → { name, label, at }

/** Commands that must be confirmed before they run. */
const DESTRUCTIVE = new Set([
  'shutdown', 'restart', 'unpair', 'setprefix', 'cleanup', 'antiban'
]);

/**
 * Is this command destructive?
 *
 * `.antiban` is only destructive for the parts that change the protection
 * (off / reset) — asking for a confirmation to *see* the status was one
 * of the most annoying "the bot is broken" moments.
 */
function isDestructive(name, args = []) {
  const n = String(name || '').toLowerCase();
  if (!DESTRUCTIVE.has(n)) return false;
  if (n === 'antiban') {
    const sub = String(args[0] || '').toLowerCase();
    return sub === 'off' || sub === 'reset';
  }
  return true;
}

function key(jid, sender) {
  return `${jid}|${sender || jid}`;
}

function prune(now = Date.now()) {
  for (const [k, v] of pending) {
    if (now - v.at > TTL_MS) pending.delete(k);
  }
  while (pending.size > MAX_ENTRIES) pending.delete(pending.keys().next().value);
}

function request(jid, sender, name, label) {
  prune();
  pending.set(key(jid, sender), { name, label, at: Date.now() });
  return pending.get(key(jid, sender));
}

function peek(jid, sender) {
  prune();
  return pending.get(key(jid, sender)) || null;
}

function consume(jid, sender) {
  prune();
  const k = key(jid, sender);
  const entry = pending.get(k);
  if (entry) pending.delete(k);
  return entry || null;
}

function cancel(jid, sender) {
  const k = key(jid, sender);
  const had = pending.delete(k);
  return had;
}

function reset() { pending.clear(); }

module.exports = { TTL_MS, DESTRUCTIVE, isDestructive, request, peek, consume, cancel, reset };
