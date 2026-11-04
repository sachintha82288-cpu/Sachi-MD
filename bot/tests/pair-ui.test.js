/**
 * v1.3.0 — the pairing system.
 *
 * Three promises are tested here, because each one was asked for by name:
 *
 *   1. the code is eight digits a person can actually type (1234-5678),
 *   2. the flow reads like WhatsApp's own "Linked devices" screen — number,
 *      code, confirm, and the terminal prints the same card,
 *   3. the pair page asks for the country first and never leaves a dead end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* ── 1. the code ──────────────────────────────────────────────────────── */

test('pairing codes are eight digits — nothing to spell, nothing to confuse', () => {
  const sm = require('../src/whatsapp/sessionManager');
  const gen = sm.generateEasyPairingCode;
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const c = gen();
    assert.match(c, /^[1-9][0-9]{7}$/, `bad code ${c}`);
    seen.add(c);
  }
  // a collision-heavy generator would be a bug, not bad luck
  assert.ok(seen.size > 4900, `only ${seen.size}/5000 codes were unique`);
});

test('PAIR_FIXED_CODE pins the code, and a malformed pin is ignored', () => {
  const keep = process.env.PAIR_FIXED_CODE;
  try {
    const sm = require('../src/whatsapp/sessionManager');
    process.env.PAIR_FIXED_CODE = '1111-1111';
    assert.equal(sm.generateEasyPairingCode(), '11111111', 'the dash is optional for the owner');
    process.env.PAIR_FIXED_CODE = '1234';
    assert.match(sm.generateEasyPairingCode(), /^[1-9][0-9]{7}$/, 'a short pin must not become the code');
    process.env.PAIR_FIXED_CODE = 'abcd1111';
    assert.match(sm.generateEasyPairingCode(), /^[1-9][0-9]{7}$/, 'letters are stripped, not accepted');
    delete process.env.PAIR_FIXED_CODE;
  } finally {
    if (keep === undefined) delete process.env.PAIR_FIXED_CODE;
    else process.env.PAIR_FIXED_CODE = keep;
  }
});

test('a code is grouped 4-4 everywhere it is shown', () => {
  const pairing = require('../src/services/pairing');
  assert.equal(pairing.group('48210937'), '4821-0937');
  assert.equal(pairing.group('4821-0937'), '4821-0937', 'grouping is idempotent');
  assert.equal(pairing.group(''), '');
  assert.equal(pairing.group('MILUKOTA'), 'MILU-KOTA', 'a server-issued code still groups');
});

/* ── 2. the terminal card ─────────────────────────────────────────────── */

test('the terminal banner carries the number, the code and the four steps', () => {
  const sm = require('../src/whatsapp/sessionManager');
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    sm.pairingBanner('4821-0937', '94771234567');
  } finally {
    process.stdout.write = write;
  }
  const out = lines.join('');
  assert.match(out, /LINK A DEVICE/i);
  assert.match(out, /\+94771234567/, 'the number it is for');
  assert.match(out, /4821-0937/, 'the code, grouped');
  assert.match(out, /4 8 2 1\s+-\s+0 9 3 7/, 'and spaced out for reading aloud');
  assert.match(out, /Linked devices/i);
  assert.match(out, /Never share this code/i);
});

test('prettyPhone and ccOf agree with each other', () => {
  const pairing = require('../src/services/pairing');
  assert.equal(pairing.prettyPhone('94771234567'), '+94 77 123 4567');
  assert.equal(pairing.prettyPhone('919876543210'), '+91 987 654 3210');
  assert.equal(pairing.prettyPhone('447700900123'), '+44 770 090 0123');
  assert.equal(pairing.ccOf('94771234567'), '94');
  assert.equal(pairing.ccOf('919876543210'), '91');
  assert.equal(pairing.ccOf(''), '');
  // the grouped number and the phone view must not disagree about the country
  for (const n of ['94771234567', '919876543210', '447700900123', '966501234567']) {
    assert.ok(pairing.prettyPhone(n).startsWith(`+${pairing.ccOf(n)} `), n);
  }
});

/* ── 3. the page ──────────────────────────────────────────────────────── */

function page(extra = {}) {
  const pairPage = require('../src/web/pages/pair');
  return pairPage.render({
    botName: 'Sachi MD', version: '1.3.0', mode: 'public', token: '',
    maxSessions: 8, sessions: 2, codeTtlSec: 60, tagline: 'Fast • Smart • Clean',
    country: '94', ...extra,
  });
}

test('the pair page is a form, not a poster: steps, country, code cells', () => {
  const html = page();
  assert.match(html, /class="rail"/, 'the three-step rail');
  for (const step of ['Your number', 'Pairing code', 'Confirm on the phone']) {
    assert.ok(html.includes(step), `missing step: ${step}`);
  }
  assert.match(html, /id="cc"/, 'the country selector');
  assert.match(html, /var BOT_CC = "94"/, 'the bot\'s own country is the default');
  assert.match(html, /id="code"/, 'the code grid');
  assert.match(html, /Different number/, 'a way back to the form');
  assert.match(html, /Link another number/, 'and a way to do it again');
  assert.match(html, /never gives it your\s*password/i, 'the privacy note stays');
});

test('the page never depends on an external asset', () => {
  const html = page();
  assert.ok(!/<script[^>]+src=/.test(html), 'no external script');
  assert.ok(!/<link[^>]+href="http/.test(html), 'no external stylesheet');
  assert.ok(!/https?:\/\/(?!w3\.org)[^"' )]+\.(css|js|woff2?)/.test(html), 'no external font/css');
});

test('the inline page script parses (a broken escape cannot ship silently)', () => {
  const html = page();
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(m, 'the page has an inline script');
  // `new Function` compiles without running: this catches a stray backslash,
  // which is how a template-literal page breaks in production and nowhere else.
  assert.doesNotThrow(() => new Function(m[1]));
});

test('a country code in the query string is understood, not rejected', () => {
  const html = page();
  // the detector exists and prefers the longest match (a 3-digit code beats a
  // 1-digit one that happens to be a prefix of it)
  assert.match(html, /function detectCountry/, 'the detector ships');
  assert.match(html, /cc\.length > String\(best\[2\]\)\.length/, 'longest match wins');
  assert.match(html, /function withCountry/, 'the trunk-zero handler ships');
  assert.match(html, /replace\(\/\^0\+\/, ''\)/, 'a leading 0 is dropped, not doubled');
});

test('the closed and locked states still explain themselves', () => {
  const off = page({ mode: 'off' });
  assert.match(off, /Pairing is closed/);
  assert.ok(!off.includes('id="form"'), 'no form when pairing is off');
  const locked = page({ mode: 'locked', tagline: 'Owner console locked' });
  assert.match(locked, /Owner console is locked/);
});

test('the owner console lists sessions and waiting codes with the new grouping', () => {
  const adminPage = require('../src/web/pages/admin');
  const html = adminPage.render({
    botName: 'Sachi MD', version: '1.3.0', token: 't',
    sessions: [{ phone: '94750404115', isPrimary: true, connected: true, state: 'connected', name: 'Ratman' }],
    pending: [{ phone: '94770005678', code: '4821-0937', secondsLeft: 41 }],
    stats: { maxSessions: 8, inUse: 1 }, info: { url: 'https://1.2.3.4:3000/' },
  });
  assert.match(html, /94750404115/);
  assert.match(html, /4821-0937/);
  assert.match(html, /Owner console/);
});
