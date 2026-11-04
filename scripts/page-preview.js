/**
 * A clickable preview of the pair website — no bot, no WhatsApp, no network.
 *
 * Renders the real page (`src/web/pages/pair.js`) with the logo inlined as a
 * data URI and a small `fetch` simulator injected in front of it, so the whole
 * flow can be clicked through in a browser or in the file viewer:
 *
 *     type a number → Get code → the code flips in → the ring counts down →
 *     "New code" issues another → after a few polls the page reports LINKED
 *
 * Run: node scripts/page-preview.js [out.html]
 * It writes `pair-page-preview.html` (and `admin-page-preview.html`) and never
 * touches the bot itself.
 */
const fs = require('fs');
const path = require('path');

const pairPage = require('../src/web/pages/pair');
const adminPage = require('../src/web/pages/admin');

const ROOT = path.join(__dirname, '..');
const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'pair-page-preview.html');
const adminOut = path.join(path.dirname(out), 'admin-page-preview.html');

function logoDataUri() {
  for (const name of ['logo.jpg', 'logo.jpeg', 'logo.png']) {
    const p = path.join(ROOT, 'assets', name);
    if (!fs.existsSync(p)) continue;
    const type = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${type};base64,${fs.readFileSync(p).toString('base64')}`;
  }
  return '';
}

/** A fake backend, injected BEFORE the page's own script. */
const SIM = `
<script>
/* ── preview simulator: stands in for the bot's /api/pair endpoints ── */
(function(){
  var attempts = {}, polls = 0;
  /* numeric codes, exactly like the bot issues them (1234-5678) */
  function code(){
    var s = String(1 + Math.floor(Math.random() * 9));
    for (var i = 1; i < 8; i++) s += String(Math.floor(Math.random() * 10));
    return s;
  }
  function pretty(d){
    d = String(d || '').replace(/\\D/g, '');
    if (d.indexOf('94') === 0 && d.length === 11) return '+94 ' + d.slice(2,4) + ' ' + d.slice(4,7) + ' ' + d.slice(7);
    return '+' + d;
  }
  function json(obj, status){
    return Promise.resolve({ ok: (status || 200) < 400, status: status || 200,
      json: function(){ return Promise.resolve(obj); } });
  }
  window.fetch = function(url, opt){
    var u = String(url).split('?')[0];
    if (u === '/api/pair/info') return json({ mode: 'preview', ready: true, closed: false, full: false, sessions: 2, maxSessions: 8, codeTtlSec: 60 });
    if (u === '/api/pair' && opt && opt.method === 'POST'){
      var body = {}; try { body = JSON.parse(opt.body || '{}'); } catch(e){}
      var digits = String(body.number || '').replace(/\\D/g,'');
      if (digits.length < 8) return json({ error: 'Enter the full number with country code, digits only — e.g. 94771234567', reason: 'invalid' }, 400);
      if (digits === '94750404115') return json({ error: "That is the bot's own number — it is already connected.", reason: 'primary' }, 409);
      if (digits === '94770000000') return json({ error: 'This bot is full (8 paired sessions). Ask the owner to remove one.', reason: 'cap', retryMs: 0 }, 503);
      if (digits === '94771111111') return json({ error: 'Too many attempts from your connection. Try again in a few minutes.', reason: 'rate-ip', retryMs: 180000 }, 429);
      var id = 'prev' + Math.random().toString(16).slice(2, 10);
      var raw = code();
      attempts[id] = { phone: digits, raw: raw, polls: 0 };
      return json({ id: id, phone: digits, phonePretty: pretty(digits), state: 'waiting', code: raw.slice(0,4) + '-' + raw.slice(4),
        rawCode: raw, secondsLeft: 60, expiresAt: Date.now() + 60000, refreshes: 0, source: 'web' });
    }
    if (u === '/api/pair/refresh'){
      var b2 = {}; try { b2 = JSON.parse(opt.body || '{}'); } catch(e){}
      var rec = attempts[b2.id];
      if (!rec) return json({ error: 'That pairing attempt is gone — start a new one.', reason: 'not-found' }, 404);
      rec.raw = code(); rec.polls = 0;
      return json({ id: b2.id, phone: rec.phone, phonePretty: pretty(rec.phone), state: 'waiting', code: rec.raw.slice(0,4) + '-' + rec.raw.slice(4),
        rawCode: rec.raw, secondsLeft: 60, expiresAt: Date.now() + 60000, refreshes: 1, source: 'web' });
    }
    if (u === '/api/pair/status'){
      var id2 = new URL(String(url), 'http://preview').searchParams.get('id');
      var r2 = attempts[id2];
      if (!r2) return json({ error: 'Unknown pairing attempt.', reason: 'not-found' }, 404);
      r2.polls++;
      /* after ~6 s of polling the preview "links" so the success state can be seen */
      if (r2.polls >= 3) return json({ id: id2, phone: r2.phone, phonePretty: pretty(r2.phone), state: 'linked', code: '', rawCode: '', secondsLeft: 0, name: 'Preview User' });
      return json({ id: id2, phone: r2.phone, phonePretty: pretty(r2.phone), state: 'waiting', code: r2.raw.slice(0,4) + '-' + r2.raw.slice(4),
        rawCode: r2.raw, secondsLeft: Math.max(0, 60 - r2.polls * 2), expiresAt: Date.now() + 60000, refreshes: 0, source: 'web' });
    }
    return json({ error: 'preview: no such endpoint' }, 404);
  };
})();
</script>`;

const BANNER = `
<div style="position:relative;z-index:2;max-width:1000px;margin:0 auto;padding:0 18px">
  <div style="border-radius:16px;padding:12px 16px;font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#ffe9b8;
       background:rgba(255,190,90,.14);border:1px solid rgba(255,200,110,.4);backdrop-filter:blur(14px)">
    🔎 <b>Preview</b> — this is the real page with a fake backend, so you can click the whole flow.
    Try <b>94771234567</b> (works), <b>94750404115</b> (the bot's own number), <b>94771111111</b> (rate limited),
    <b>94770000000</b> (bot full) or <b>12</b> (invalid). About 6 seconds after a code appears it "links" so you can see the success state.
  </div>
</div>`;

function buildPair() {
  const logo = logoDataUri();
  let html = pairPage.render({
    botName: 'Sachi MD', version: '1.3.0', mode: 'public', token: '',
    maxSessions: 8, sessions: 2, codeTtlSec: 60, tagline: 'Fast • Smart • Clean', country: '94',
  });
  if (logo) html = html.replace('src="/logo"', `src="${logo}"`);
  html = html.replace('<main class="shell">', BANNER + '\n<main class="shell">');
  html = html.replace('<script>\n(function(){', SIM + '\n<script>\n(function(){');
  html = html.replace(/href="\/api\/status"/, 'href="#"').replace(/href="\/admin"/, 'href="#"');
  fs.writeFileSync(out, html);
  return html.length;
}

function buildAdmin() {
  const now = Date.now();
  const html = adminPage.render({
    botName: 'Sachi MD', version: '1.3.0', token: '',
    sessions: [
      { id: 'primary', phone: '94750404115', isPrimary: true, connected: true, state: 'connected', name: 'Ratman', startedAt: now - 3 * 3600_000 },
      { id: '94771234567', phone: '94771234567', isPrimary: false, connected: true, state: 'connected', name: 'My Session Bot', startedAt: now - 42 * 60_000 },
      { id: '94770009999', phone: '94770009999', isPrimary: false, connected: false, state: 'connecting', name: null, startedAt: now - 90_000 },
    ],
    pending: [
      { phone: '94770005678', code: '4821-0937', secondsLeft: 41, source: 'web' },
      { phone: '94770004321', code: '7305-6612', secondsLeft: 12, source: 'chat' },
    ],
    info: { url: 'https://136.67.120.86:3000/', ip: '136.67.120.86', port: 3000, source: 'lookup:dns', isPublic: true, notes: [] },
    stats: { maxSessions: 8, inUse: 2, pending: 2, issued: 7, refreshed: 3, linked: 2, refused: 4, health: 'ok · risk 0 · speed ×1.25', uptime: '3h 12m' },
  });
  fs.writeFileSync(adminOut, html);
  return html.length;
}

const a = buildPair();
const b = buildAdmin();
console.log(`pair page preview : ${out} (${(a / 1024).toFixed(0)} KB)`);
console.log(`admin preview     : ${adminOut} (${(b / 1024).toFixed(0)} KB)`);
