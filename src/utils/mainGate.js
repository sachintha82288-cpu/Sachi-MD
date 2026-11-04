/**
 * The MAIN number gate — one definition, used everywhere.
 *
 * Multi-session changed who "the owner" is: every paired session is the owner
 * of ITSELF (it may rename its own bot, change its own logo), but only the
 * number that was linked from the terminal is the MAIN number, and only the
 * main number may manage sessions or change bot-wide settings.
 *
 * This lives in `utils/` (not in the router) so a command can double-check the
 * gate for itself without `require`-ing the router back — commands are loaded
 * BY the router, so that import would be a cycle at load time.
 */
const config = require('../config');

/** "94771234567:12@s.whatsapp.net" → "94771234567" (device suffix and domain gone). */
function digitsOf(v) {
  return String(v == null ? '' : v).split('@')[0].split(':')[0].replace(/\D/g, '');
}

/**
 * Is this caller the main number? A paired session is never the main number,
 * even when the same phone somehow linked both (which pairing refuses anyway).
 */
function isMainNumber(ctx) {
  const cfg = ctx?.config || config;
  // Two independent signals that this is NOT the main session, because a
  // paired session's `owner` is the person who linked it — matching the
  // sender — and one flag should never be the only thing standing between a
  // paired user and the bot-wide settings.
  if (cfg.sessionIsPrimary === false) return false;
  if (cfg.sessionId && String(cfg.sessionId) !== 'primary') return false;
  const me = digitsOf(ctx?.sender || ctx?.jid);
  if (!me) return false;
  const lock = digitsOf(cfg.ownerNumber);
  if (lock && me === lock) return true;
  const primary = digitsOf(cfg.owner);
  return !!primary && me === primary;
}

/** The refusal a non-main caller gets, with the way forward spelled out. */
function MAIN_ONLY_NOTICE(cfg) {
  const c = cfg || config;
  const p = c.prefix || '.';
  const main = digitsOf(c.ownerNumber);
  return `⛔ Only the main bot number${main ? ` (*+${main}*)` : ''} can manage sessions and change the bot-wide settings.

You can still make this bot yours:
• ${p}setname <name> · ${p}setheader <text>
• ${p}setfooter <text> · ${p}setlogo (reply to an image)
• ${p}mybot — your session + your menu identity
• ${p}pair — pair another number of YOUR own`;
}

/**
 * Defence in depth for destructive commands: `null` when the caller is the
 * main number, otherwise the notice to send. The router already gates
 * `mainOnly` commands; this is for anything that reaches `execute` directly
 * (tests, the web console, a future code path).
 */
function notice(ctx) {
  return isMainNumber(ctx) ? null : MAIN_ONLY_NOTICE(ctx?.config);
}

module.exports = { digitsOf, isMainNumber, MAIN_ONLY_NOTICE, notice };
