/**
 * Crash watchdog — decides whether the process should give up and let the
 * panel restart it.
 *
 * Limping on after an uncaught exception is how a bot ends up "online but
 * dead": the socket is there, the handlers are not. So after CRASH_LIMIT
 * crashes inside CRASH_WINDOW_MS the process exits(1) and comes back clean.
 *
 *   CRASH_RESTART=false  → old behaviour (log and keep running)
 *   CRASH_LIMIT=3        → how many crashes are tolerated
 *   CRASH_WINDOW_MS=60s  → inside which window
 */
const LIMIT = Math.max(1, Number(process.env.CRASH_LIMIT) || 3);
const WINDOW_MS = Math.max(5000, Number(process.env.CRASH_WINDOW_MS) || 60000);
const ENABLED = process.env.CRASH_RESTART !== 'false';

let stamps = [];

/**
 * Record a crash. Returns true when the process should exit(1) now.
 * `now` is injectable so the window can be tested without waiting.
 */
function noteCrash(now = Date.now()) {
  if (!ENABLED) return false;
  stamps.push(now);
  while (stamps.length && now - stamps[0] > WINDOW_MS) stamps.shift();
  return stamps.length >= LIMIT;
}

/** `now` is injectable so tests can use a fake clock. */
function state(now = Date.now()) {
  stamps = stamps.filter((t) => now - t <= WINDOW_MS);
  return { enabled: ENABLED, limit: LIMIT, windowMs: WINDOW_MS, recent: stamps.length };
}

function reset() { stamps = []; }

module.exports = { noteCrash, state, reset, LIMIT, WINDOW_MS, ENABLED };
