/**
 * Bot settings — everything the owner can change from the Settings menu.
 *
 * Persisted in data/settings.json (same file the command prefix uses) and
 * mirrored into `config` so the rest of the bot sees the live values.
 *
 *   mode     → where the bot listens (self | inbox | public | groups | all)
 *   botName  → the name shown in menus, help and the pairing banner
 *   header   → the title above the menu card body
 *   footer   → the line below the menu card
 *   logo     → a custom logo file (relative to the project root)
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { save: saveSettings } = require('../database/settings');

const DEFAULTS = {
  mode: 'all',
  botName: '',
  header: '',
  footer: '',
  logo: '',
  tagallPerm: 'all'
};

/** Valid values for the .tagall permission model. */
const TAGALL_PERMS = ['owner', 'admin', 'all'];

/** Live values — the config mirror is updated on every change. */
function get() {
  return {
    mode: mode(),
    botName: name(),
    header: header(),
    footer: footer(),
    logo: logoFile(),
    tagallPerm: tagallPerm()
  };
}

function raw(key) {
  const value = config[key];
  return value === undefined || value === null ? '' : String(value);
}

function mode() {
  const m = raw('mode').toLowerCase() || DEFAULTS.mode;
  return m;
}
function name() { return raw('botName') || config.botName || 'Sachi MD'; }
function header() { return raw('header'); }
function footer() { return raw('footer'); }

/** Who may tag the whole group: owner | admin | all. */
function tagallPerm() {
  const v = raw('tagallPerm').toLowerCase();
  return TAGALL_PERMS.includes(v) ? v : DEFAULTS.tagallPerm;
}

/** Absolute path of the logo that should be used, or '' when there is none. */
function logoFile() {
  const custom = raw('logo');
  if (custom) {
    const p = path.isAbsolute(custom) ? custom : path.join(config.paths.root, custom);
    if (fs.existsSync(p)) return p;
  }
  return '';
}

/** The logo for the menu cards + the image menu. */
function logoPath() {
  const custom = logoFile();
  if (custom) return custom;
  const assets = path.join(config.paths.root, 'assets');
  for (const name of ['logo.jpg', 'logo.jpeg', 'logo.png']) {
    const p = path.join(assets, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(assets, 'logo.png');
}

/** Save a patch — the file AND the in-memory config are updated. */
function update(patch = {}) {
  const clean = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    clean[k] = String(v == null ? '' : v).slice(0, 400);
  }
  if (!Object.keys(clean).length) return get();
  saveSettings(clean);
  if ('mode' in clean) config.mode = clean.mode || DEFAULTS.mode;
  if ('botName' in clean) config.botName = clean.botName || config.defaultBotName || 'Sachi MD';
  if ('header' in clean) config.header = clean.header;
  if ('footer' in clean) config.footer = clean.footer;
  if ('logo' in clean) config.logo = clean.logo;
  if ('tagallPerm' in clean) config.tagallPerm = (clean.tagallPerm || DEFAULTS.tagallPerm).toLowerCase();
  return get();
}

/** Clear one setting (back to the default). */
function reset(key) {
  if (!(key in DEFAULTS)) return get();
  const patch = { [key]: DEFAULTS[key] };
  return update(patch);
}

module.exports = {
  DEFAULTS, TAGALL_PERMS, get, update, reset, mode, name, header, footer,
  tagallPerm, logoFile, logoPath, raw
};
