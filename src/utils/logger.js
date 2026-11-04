const levels = { info: 36, success: 32, warn: 33, error: 31, debug: 90 };

/**
 * A small ring buffer of the last warnings/errors.
 *
 * The panel log is the first place to look, but the bot itself can show
 * what went wrong — ".health" answers "why did the bot go quiet?" without
 * opening the server console.
 */
const HISTORY_MAX = 40;
const history = [];

function remember(level, message) {
  if (level !== 'error' && level !== 'warn') return;
  const text = String(message || '').replace(/\s+/g, ' ').slice(0, 160);
  if (!text) return;
  history.push({ at: Date.now(), level, text });
  while (history.length > HISTORY_MAX) history.shift();
}

function log(level, message, meta) {
  const code = levels[level] || levels.info;
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  const extra = meta ? ` ${typeof meta === 'string' ? meta : JSON.stringify(meta)}` : '';
  remember(level, message);
  console.log(`\x1b[${code}m[${ts}] [Sachi MD] [${level.toUpperCase()}]\x1b[0m ${message}${extra}`);
}

/** The last warnings/errors (newest first). */
function recent(limit = 10) {
  return history.slice(-limit).reverse();
}

function clearHistory() { history.length = 0; }

module.exports = {
  info: m => log('info', m),
  success: m => log('success', m),
  warn: m => log('warn', m),
  error: m => log('error', m),
  debug: m => log('debug', m),
  recent,
  clearHistory
};
