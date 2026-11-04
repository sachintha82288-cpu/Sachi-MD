/**
 * Command-detection reactions — instant "bot is alive" feedback.
 *
 * When a command is recognised, the user's message gets a reaction with that
 * command's emoji, so a slow reply never looks like a dead bot.
 *
 * Reactions are metadata-light, so they are sent straight through the socket
 * (the antiban wrapper adds 0.9–4.2 s gaussian typing delays, and 15 s+
 * warm-up sleeps on young accounts — both would defeat the purpose here).
 * A small self-contained limiter keeps them polite:
 *   • global cap of 20 reactions / rolling minute
 *   • per-chat cooldown of 1 s
 *   • skipped entirely while the antiban health monitor has sends paused
 * Every send failure is swallowed — reactions must never break a command.
 */
function envInt(name, def, min) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : def;
}
function envBool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v !== 'false' && v !== '0';
}

const MAX_PER_MINUTE = envInt('REACTION_MAX_PER_MINUTE', 20, 1);
const PER_CHAT_COOLDOWN_MS = envInt('REACTION_COOLDOWN_MS', 1000, 0);
const state = { enabled: envBool('REACTIONS_ENABLED', true) };

const timestamps = [];
const jidLast = new Map();

/** Default health probe: skip reactions while antiban has sends paused. */
function defaultPausedProbe() {
  try { return !!require('../antiban').status().rate.paused; } catch { return false; }
}
let pausedProbe = defaultPausedProbe;

function prune(now) {
  const cutoff = now - 60_000;
  while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
  if (jidLast.size > 2000) jidLast.clear();
}

/** Pure check (no side effects) — exported for tests. */
function check(jid, now = Date.now()) {
  if (!state.enabled) return { allowed: false, reason: 'disabled' };
  if (pausedProbe()) return { allowed: false, reason: 'paused' };
  prune(now);
  if (timestamps.length >= MAX_PER_MINUTE) return { allowed: false, reason: 'global_cap' };
  const last = jidLast.get(String(jid || '')) || 0;
  if (now - last < PER_CHAT_COOLDOWN_MS) return { allowed: false, reason: 'cooldown' };
  return { allowed: true, reason: 'ok' };
}

/** React to a message. Resolves true when the reaction was actually sent. */
async function react(sock, jid, msgKey, emoji) {
  const verdict = check(jid);
  if (!verdict.allowed || !sock || !msgKey || !emoji) return false;
  const now = Date.now();
  timestamps.push(now);
  jidLast.set(String(jid || ''), now);
  try {
    await sock.sendMessage(jid, { react: { text: emoji, key: msgKey } });
    return true;
  } catch {
    return false;
  }
}

function setEnabled(value) { state.enabled = !!value; }
function setHealthProbe(fn) { pausedProbe = typeof fn === 'function' ? fn : defaultPausedProbe; }
function reset() { timestamps.length = 0; jidLast.clear(); }

module.exports = { react, check, setEnabled, setHealthProbe, reset };
