/**
 * Per-session branding — "own bot menu info".
 *
 * Every paired number runs its own bot session, so it gets its own identity:
 * name, logo, card header and footer. Nothing is shared by accident:
 *
 *   primary  → the GLOBAL identity in `data/settings.json` (`.setname` etc.
 *              from the main number keep writing there, exactly as before)
 *   <phone>  → that session's own overrides in `data/branding.json`
 *
 * A session that has not customised anything simply inherits the global
 * identity, so a fresh pair looks like the main bot until its owner makes it
 * their own. Only the main number can change the global one; a paired number
 * changes only its own (see the `mainOnly` gate in the router).
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const settings = require('./settings');
const { atomicJsonWrite, safeJsonRead } = require('../utils/files');
const phone = require('../utils/phone');

const FIELDS = ['name', 'header', 'footer', 'tagline', 'logo'];
const MAX_LEN = { name: 40, header: 60, footer: 90, tagline: 60, logo: 300 };
const LOGO_DIR = () => path.join(config.paths.data, 'branding');
const FILE = () => path.join(config.paths.data, 'branding.json');
const SAVE_DEBOUNCE_MS = 600;

let store = null;
let saveTimer = null;

/** 'primary' for the main session, digits for a paired number. */
/** 'primary' for the main session, digits for a paired number. */
function keyOf(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s === 'primary' || s === 'main') return 'primary';
  // Same normalisation as sessionManager.normalizePhone, so the key a
  // session is stored under is always the key the router looks up.
  const digits = phone.normalize(s);
  return digits || s.slice(0, 40).toLowerCase();
}

function load() {
  if (store) return store;
  const read = safeJsonRead(FILE(), null);
  store = read && typeof read === 'object' ? read : {};
  if (!store.v) store = { v: 1, items: store.items && typeof store.items === 'object' ? store.items : {} };
  return store;
}

function persist() {
  try { atomicJsonWrite(FILE(), load()); return true; } catch { return false; }
}
/** Debounced write — a logo upload must not turn into a dozen sync writes. */
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; persist(); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}
function flush() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  return persist();
}

function items() { return load().items || (load().items = {}); }

/** The stored override for a key, or null when it inherits everything. */
function raw(key) {
  const k = keyOf(key);
  if (k === 'primary') return null;               // the global identity lives in settings.json
  const it = items()[k];
  return it && typeof it === 'object' ? it : null;
}

function cleanPatch(patch = {}) {
  const out = {};
  for (const f of FIELDS) {
    if (!(f in patch)) continue;
    const v = patch[f];
    out[f] = v == null ? '' : String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, MAX_LEN[f]);
  }
  return out;
}

/** Absolute logo path for a key — its own file, else the global logo. */
function logoPathFor(key) {
  const k = keyOf(key);
  const own = raw(k);
  if (own && own.logo) {
    const p = path.isAbsolute(own.logo) ? own.logo : path.join(config.paths.root, own.logo);
    if (fs.existsSync(p)) return p;
  }
  if (k === 'primary') return settings.logoPath();
  // A paired session with no logo of its own inherits the global one.
  return settings.logoPath();
}

/**
 * The identity a session should render with. Always complete — callers never
 * have to fall back to `settings` themselves.
 */
function forKey(key) {
  const k = keyOf(key);
  const own = raw(k) || {};
  const name = own.name || settings.name();
  return {
    key: k,
    isPrimary: k === 'primary',
    name,
    upperName: String(name || 'Sachi MD').toUpperCase(),
    header: own.header || settings.header(),
    footer: own.footer || settings.footer(),
    tagline: own.tagline || '',
    logo: own.logo || (k === 'primary' ? settings.logoFile() : ''),
    logoPath: logoPathFor(k),
    customised: FIELDS.some((f) => !!own[f]),
    fields: FIELDS.slice(),
  };
}

/** Save overrides for one session. Empty string = inherit that field again. */
function set(key, patch = {}) {
  const k = keyOf(key);
  if (k === 'primary') {
    // The main identity IS the global settings — keep one source of truth.
    const map = { name: 'botName', header: 'header', footer: 'footer', logo: 'logo' };
    const global = {};
    for (const [f, v] of Object.entries(cleanPatch(patch))) if (map[f]) global[map[f]] = v;
    if (Object.keys(global).length) settings.update(global);
    return forKey(k);
  }
  const clean = cleanPatch(patch);
  if (!Object.keys(clean).length) return forKey(k);
  const it = { ...(items()[k] || {}) };
  for (const [f, v] of Object.entries(clean)) {
    if (v === '') delete it[f]; else it[f] = v;
  }
  it.updatedAt = Date.now();
  if (Object.keys(it).length <= 1) delete items()[k]; else items()[k] = it;
  scheduleSave();
  return forKey(k);
}

/** Clear one field (or everything) for a session. */
function reset(key, field = null) {
  const k = keyOf(key);
  if (k === 'primary') {
    if (!field || field === 'name') settings.reset('botName');
    if (!field || field === 'header') settings.reset('header');
    if (!field || field === 'footer') settings.reset('footer');
    if (!field || field === 'logo') settings.reset('logo');
    return forKey(k);
  }
  if (field) return set(k, { [field]: '' });
  const it = items()[k];
  if (it && it.logo) removeLogoFile(it.logo);
  delete items()[k];
  flush();
  return forKey(k);
}

/**
 * Store an image as this session's logo. Returns the relative path that was
 * written (so it can be shown/verified) or throws with a readable reason.
 */
function setLogoBuffer(key, buffer, ext = 'jpg') {
  const k = keyOf(key);
  if (!buffer || !buffer.length) throw new Error('that image came back empty');
  if (buffer.length > 12 * 1024 * 1024) throw new Error('the image is too large (12 MB max)');
  const dir = LOGO_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const safeExt = ['jpg', 'jpeg', 'png', 'webp'].includes(String(ext).toLowerCase()) ? String(ext).toLowerCase() : 'jpg';
  // One logo per session, overwritten in place — no orphan files.
  const file = k === 'primary' ? path.join(dir, `logo.${safeExt}`) : path.join(dir, `${k.replace(/[^a-z0-9]/gi, '')}.${safeExt}`);
  if (k === 'primary') {
    for (const f of fs.readdirSync(dir)) if (/^logo\.(jpg|jpeg|png|webp)$/i.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  } else {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${path.basename(file, path.extname(file))}.`) && f !== path.basename(file)) fs.rmSync(path.join(dir, f), { force: true });
    }
  }
  fs.writeFileSync(file, buffer);
  set(k, { logo: path.relative(config.paths.root, file) });
  flush();
  return path.relative(config.paths.root, file);
}

function removeLogoFile(rel) {
  if (!rel) return;
  try {
    const p = path.isAbsolute(rel) ? rel : path.join(config.paths.root, rel);
    if (p.startsWith(LOGO_DIR()) && fs.existsSync(p)) fs.rmSync(p, { force: true });
  } catch {}
}

/** Drop everything a session owned — called when it is unpaired. */
function forget(key) {
  const k = keyOf(key);
  if (k === 'primary') return false;
  const it = items()[k];
  if (it && it.logo) removeLogoFile(it.logo);
  delete items()[k];
  flush();
  return true;
}

/** Every customised session, for the owner's overview. */
function list() {
  return Object.entries(items()).map(([k, v]) => ({
    key: k,
    name: v.name || '',
    header: v.header || '',
    footer: v.footer || '',
    logo: v.logo || '',
    updatedAt: v.updatedAt || 0,
    customised: FIELDS.some((f) => !!v[f]),
  }));
}

/**
 * Drop the in-memory store and read it back from disk. Used after a restore
 * (tests) and safe at runtime — nothing is lost, the file is the source.
 */
function reload() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  store = null;
  return load();
}

function status() {
  return { file: FILE(), logoDir: LOGO_DIR(), sessions: list().length, items: list() };
}

module.exports = {
  FIELDS, forKey, raw, set, reset, setLogoBuffer, forget, list, status,
  logoPathFor, keyOf, flush, reload,
};
