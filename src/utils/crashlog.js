/**
 * Crash report file — `data/crash.log`.
 *
 * Written by app.js when the process sees an uncaught exception, an
 * unhandled rejection or a failed startup; read by `.health` so the owner
 * can see WHY the bot restarted without opening the panel.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');

const FILE = path.join(config.paths.data, 'crash.log');
const MAX_BYTES = 256 * 1024;

function write(kind, err, recent = []) {
  try {
    const body = [
      `${new Date().toISOString()} ${kind}: ${err?.stack || err}`,
      '--- recent log ---',
      ...recent.map((e) => `[${e.level}] ${e.text}`),
      '',
      '',
    ].join('\n');
    // a runaway crash loop must not fill the disk
    if (fs.existsSync(FILE) && fs.statSync(FILE).size > MAX_BYTES) fs.writeFileSync(FILE, body);
    else fs.appendFileSync(FILE, body);
    return true;
  } catch { return false; }
}

/** The first line of the newest crash block (or null). */
function last() {
  try {
    if (!fs.existsSync(FILE)) return null;
    const blocks = fs.readFileSync(FILE, 'utf8').split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
    if (!blocks.length) return null;
    return blocks[blocks.length - 1].split('\n')[0].slice(0, 180);
  } catch { return null; }
}

function clear() { try { fs.rmSync(FILE, { force: true }); return true; } catch { return false; } }

module.exports = { FILE, write, last, clear };
