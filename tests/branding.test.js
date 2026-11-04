/**
 * Per-session branding — "everybody can make their own bot menu info".
 *
 * The rule that must never slip: `primary` is the GLOBAL identity in
 * data/settings.json, a paired number is an override in data/branding.json,
 * and a session that customised nothing inherits the global one completely.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const config = require('../src/config');
const settings = require('../src/services/settings');
const branding = require('../src/services/branding');

const SETTINGS_FILE = path.join(config.paths.data, 'settings.json');
const BRAND_FILE = path.join(config.paths.data, 'branding.json');
const BRAND_DIR = path.join(config.paths.data, 'branding');

// Snapshot the real files ONCE, before any test writes to them, and put them
// back at the very end: a suite that renames the bot would leave the next
// test file (and a real deployment) reading "Global Bot" out of settings.json.
const ORIG_SETTINGS = snapshot0(SETTINGS_FILE);
const ORIG_BRAND = snapshot0(BRAND_FILE);
function snapshot0(f) { try { return fs.existsSync(f) ? fs.readFileSync(f) : null; } catch { return null; } }
after(() => {
  const put = (f, buf) => { try { if (buf == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, buf); } catch {} };
  put(SETTINGS_FILE, ORIG_SETTINGS);
  put(BRAND_FILE, ORIG_BRAND);
  try { branding.reload(); } catch {}
});

function snapshot(file) {
  try { return fs.existsSync(file) ? fs.readFileSync(file) : null; } catch { return null; }
}
function restore(file, buf) {
  try {
    if (buf == null) { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); }
    else fs.writeFileSync(file, buf);
  } catch { /* best effort */ }
}
/** The store is cached in memory — put it back in step with the restored file. */
function resync() { try { branding.reload(); } catch { /* older build */ } }

test('branding: a fresh session inherits the global identity, and says so', (t) => {
  const sFile = snapshot(SETTINGS_FILE), bFile = snapshot(BRAND_FILE);
  t.after(() => { restore(SETTINGS_FILE, sFile); restore(BRAND_FILE, bFile); resync(); });

  settings.update({ botName: 'Global Bot', header: 'GH', footer: 'GF' });
  const fresh = branding.forKey('94770001111');
  assert.equal(fresh.name, 'Global Bot');
  assert.equal(fresh.header, 'GH');
  assert.equal(fresh.footer, 'GF');
  assert.equal(fresh.customised, false, 'nothing stored yet');
  assert.equal(fresh.isPrimary, false);
  assert.equal(fresh.key, '94770001111');
});

test('branding: overrides are per session and never leak sideways', (t) => {
  const sFile = snapshot(SETTINGS_FILE), bFile = snapshot(BRAND_FILE);
  t.after(() => { restore(SETTINGS_FILE, sFile); restore(BRAND_FILE, bFile); resync(); });

  settings.update({ botName: 'Global Bot', header: 'GH', footer: 'GF' });
  branding.set('94770002222', { name: 'Mine', footer: 'My footer' });
  branding.flush();

  const mine = branding.forKey('94770002222');
  assert.equal(mine.name, 'Mine');
  assert.equal(mine.footer, 'My footer');
  assert.equal(mine.header, 'GH', 'an unset field still inherits');
  assert.equal(mine.customised, true);
  assert.equal(mine.upperName, 'MINE');

  const other = branding.forKey('94770003333');
  assert.equal(other.name, 'Global Bot', 'another session is untouched');
  assert.equal(other.footer, 'GF');
  assert.equal(other.customised, false);

  const global = branding.forKey('primary');
  assert.equal(global.name, 'Global Bot', 'the global identity is untouched');
  assert.equal(global.isPrimary, true);
});

test('branding: the primary key writes the GLOBAL settings, not an override', (t) => {
  const sFile = snapshot(SETTINGS_FILE), bFile = snapshot(BRAND_FILE);
  t.after(() => { restore(SETTINGS_FILE, sFile); restore(BRAND_FILE, bFile); resync(); });

  branding.set('primary', { name: 'Renamed Bot', header: 'NH' });
  assert.equal(settings.name(), 'Renamed Bot', '.setname from the main number still lands in settings.json');
  assert.equal(settings.header(), 'NH');
  assert.equal(branding.raw('primary'), null, 'primary must never be stored as an override');
  // branding.json may not exist at all yet — nothing has been overridden.
  const stored = fs.existsSync(BRAND_FILE) ? JSON.parse(fs.readFileSync(BRAND_FILE, 'utf8')) : { items: {} };
  assert.ok(!stored.items || !stored.items.primary, 'no primary entry in branding.json');
});

test('branding: junk is cleaned — control characters, over-long fields, weird keys', () => {
  const out = branding.set('94770004444', {
    name: 'A'.repeat(120),
    header: 'line\u0000one\u0007two',
    footer: null,
    tagline: 'ok tagline',
    bogus: 'ignored',
  });
  branding.flush();
  assert.equal(out.name.length, 40, 'name capped at 40');
  assert.ok(!/[\u0000-\u0008]/.test(out.header), 'control characters stripped');
  assert.equal(out.header, 'lineonetwo');
  assert.equal(out.tagline, 'ok tagline');
  assert.ok(!('bogus' in (branding.raw('94770004444') || {})), 'unknown fields are dropped');

  // a jid, a "+94 (0) 77…" string and plain digits all mean the same session
  assert.equal(branding.keyOf('+94 (0) 770-004-444'), '94770004444');
  assert.equal(branding.keyOf('94770004444:11@s.whatsapp.net'), '94770004444');
  assert.equal(branding.keyOf(''), 'primary');
  assert.equal(branding.keyOf('main'), 'primary');
  branding.forget('94770004444');
});

test('branding: an empty string inherits that field again', () => {
  settings.update({ botName: 'Global Bot', footer: 'GF' });
  branding.set('94770005555', { footer: 'Mine' });
  assert.equal(branding.forKey('94770005555').footer, 'Mine');
  branding.set('94770005555', { footer: '' });
  assert.equal(branding.forKey('94770005555').footer, 'GF', 'back to the global footer');
  assert.equal(branding.raw('94770005555'), null, 'an all-empty override is removed entirely');
  branding.flush();
});

test('branding: a logo is stored per session, overwritten in place, and forgotten on unpair', (t) => {
  const bFile = snapshot(BRAND_FILE);
  const dirBefore = fs.existsSync(BRAND_DIR) ? fs.readdirSync(BRAND_DIR) : [];
  t.after(() => {
    restore(BRAND_FILE, bFile);
    for (const f of fs.existsSync(BRAND_DIR) ? fs.readdirSync(BRAND_DIR) : []) {
      if (!dirBefore.includes(f)) fs.rmSync(path.join(BRAND_DIR, f), { force: true });
    }
  });

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const rel = branding.setLogoBuffer('94770006666', png, 'png');
  assert.match(rel, /branding[\\/]94770006666\.png$/);
  assert.ok(fs.existsSync(path.join(config.paths.root, rel)));
  assert.equal(branding.forKey('94770006666').logoPath, path.join(config.paths.root, rel));

  // a second upload for the same session replaces the file (no orphans)
  const rel2 = branding.setLogoBuffer('94770006666', Buffer.concat([png, png]), 'jpg');
  assert.match(rel2, /94770006666\.jpg$/);
  assert.ok(!fs.existsSync(path.join(config.paths.root, rel)), 'the old logo file is gone');

  // another session gets its own file, and the primary one keeps the global logo
  branding.setLogoBuffer('94770007777', png, 'png');
  assert.notEqual(branding.forKey('94770007777').logoPath, branding.forKey('94770006666').logoPath);

  assert.throws(() => branding.setLogoBuffer('94770008888', Buffer.alloc(0), 'png'), /empty/i);
  assert.throws(() => branding.setLogoBuffer('94770008888', Buffer.alloc(13 * 1024 * 1024), 'png'), /too large/i);

  assert.equal(branding.forget('94770006666'), true);
  assert.ok(!fs.existsSync(path.join(config.paths.root, rel2)), 'unpairing removes the stored logo too');
  assert.equal(branding.forKey('94770006666').customised, false);
  assert.equal(branding.forget('primary'), false, 'the global identity can never be forgotten by accident');
  branding.forget('94770007777');
});

test('branding: list()/status() describe what is customised, for .sessions and /admin', () => {
  branding.set('94770009999', { name: 'Listed', header: 'LH' });
  branding.flush();
  const items = branding.list();
  const mine = items.find((i) => i.key === '94770009999');
  assert.ok(mine, 'the customised session is listed');
  assert.equal(mine.name, 'Listed');
  assert.equal(mine.customised, true);
  assert.ok(mine.updatedAt > 0);
  const st = branding.status();
  assert.ok(st.sessions >= 1);
  assert.match(st.file, /branding\.json$/);
  branding.forget('94770009999');
});

test('branding: the store survives a reload from disk (atomic write)', (t) => {
  const bFile = snapshot(BRAND_FILE);
  t.after(() => { restore(BRAND_FILE, bFile); resync(); });

  branding.set('94770001234', { name: 'Persisted', tagline: 'still here' });
  assert.equal(branding.flush(), true);
  const onDisk = JSON.parse(fs.readFileSync(BRAND_FILE, 'utf8'));
  assert.equal(onDisk.items['94770001234'].name, 'Persisted');
  assert.equal(onDisk.v, 1);

  branding.reload();                       // what a restart does
  assert.equal(branding.forKey('94770001234').name, 'Persisted', 'a restart keeps per-session branding');
  assert.equal(branding.forKey('94770001234').tagline, 'still here');
  branding.forget('94770001234');
});
