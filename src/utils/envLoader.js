// Zero-dependency .env loader.
// Loads KEY=VALUE pairs from <project root>/.env into process.env.
//  • Real environment variables always win (we never override them).
//  • Supports: comments (#), blank lines, "quoted" and 'quoted' values,
//    export KEY=VALUE, and inline comments after a space.
//  • Idempotent: requiring/loading twice is a no-op.
const fs = require('fs');
const path = require('path');

let loaded = false;
function loadEnv(dir = path.join(__dirname, '..', '..')) {
  if (loaded) return {};
  const file = path.join(dir, '.env');
  const applied = {};
  try {
    if (fs.existsSync(file)) {
      for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) continue;
        let value = m[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        } else {
          const hash = value.indexOf(' #');
          if (hash !== -1) value = value.slice(0, hash).trim();
        }
        if (!(m[1] in process.env)) {
          process.env[m[1]] = value;
          applied[m[1]] = value;
        }
      }
    }
  } catch { /* a broken .env must never crash the bot */ }
  loaded = true;
  return applied;
}
module.exports = { loadEnv, setEnvValue };

/**
 * Write KEY=VALUE into .env — the file is created when missing and every
 * other line is kept as it is. Used by the terminal setup (the main
 * number the user types at startup is remembered for the next boot).
 */
function setEnvValue(key, value, dir = path.join(__dirname, '..', '..')) {
  const file = path.join(dir, '.env');
  let text = '';
  try { if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const line = `${key}=${value}`;
  const re = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*$`, 'm');
  const out = re.test(text)
    ? text.replace(re, () => line)
    : (text.trimEnd() ? text.trimEnd() + '\n' : '') + line + '\n';
  fs.writeFileSync(file, out);
  return true;
}
