/**
 * Process bootstrap + the crash watchdog.
 *
 * An uncaught exception used to be logged and ignored, so the bot could
 * keep running in a half-broken state — exactly the "it is online but
 * nothing works" complaint. Now:
 *
 *   • every crash is written to `data/crash.log` (with the recent log ring)
 *     so it can still be read after a restart,
 *   • after CRASH_LIMIT crashes inside CRASH_WINDOW_MS the process exits(1)
 *     and the panel/systemd brings it back cleanly,
 *   • `CRASH_RESTART=false` keeps the old "log and limp on" behaviour.
 */
const config = require('./config');
const log = require('./utils/logger');
const router = require('./router/router');
const whatsapp = require('./whatsapp/client');
const downloader = require('./services/downloader/manager');
// The web face: pair page + owner console + the original /api/status endpoint.
const web = require('./web/server');
const crashlog = require('./utils/crashlog');
const crashwatch = require('./utils/crashwatch');
const antiban = require('./services/antiban');

/**
 * Write the anti-ban protection state to disk (risk score, rate counters,
 * warm-up day count) so a restart cannot "forget" that the number was in
 * trouble — forgetting is how a restart loop turns into a ban.
 */
function flushProtection() {
  try { antiban.stop(); } catch (e) { log.warn(`Anti-ban flush: ${e.message}`); }
}


async function start() {
  // The web server comes FIRST — before the command load, before the
  // downloader's binary checks and long before WhatsApp pairing. Anything
  // that can hang (a missing yt-dlp, a slow network, a number nobody has
  // typed yet) must not be able to keep the pair page offline: the page is
  // the owner's way IN, so it has to be up within milliseconds of boot.
  try { await web.start(); } catch (e) { log.error(`Web server: ${e.message}`); }
  router.loadCommands();
  await downloader.init();
  await whatsapp.connect();
}

async function stop(signal) {
  log.info(`Stopping (${signal})...`);
  flushProtection();
  try { await web.stop(); } catch (e) { log.warn(`Web shutdown: ${e.message}`); }
  try { await downloader.shutdown(); } catch (e) { log.warn(`Downloader shutdown: ${e.message}`); }
  try { await whatsapp.stop(); } catch (e) { log.warn(`WhatsApp shutdown: ${e.message}`); }
  setTimeout(() => process.exit(0), 250);
}

/** Keep the last crash readable after the process is gone. */
function writeCrashReport(kind, err) {
  crashlog.write(kind, err, log.recent(20));
}

process.on('exit', () => flushProtection());   // last resort: sync write
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

process.on('unhandledRejection', (e) => {
  log.error(`Unhandled rejection: ${e?.stack || e}`);
  writeCrashReport('unhandledRejection', e);
});

process.on('uncaughtException', (e) => {
  log.error(`Uncaught exception: ${e?.stack || e}`);
  writeCrashReport('uncaughtException', e);
  if (crashwatch.noteCrash()) {
    const st = crashwatch.state();
    log.error(`${st.recent} crashes in ${Math.round(st.windowMs / 1000)}s — exiting so the panel restarts the bot cleanly (see data/crash.log).`);
    flushProtection();
    setTimeout(() => process.exit(1), 200);
  }
});

start().catch((e) => {
  log.error(`Startup failed: ${e.stack || e.message}`);
  writeCrashReport('startup', e);
  process.exit(1);
});

module.exports = { start, stop, writeCrashReport, flushProtection };
