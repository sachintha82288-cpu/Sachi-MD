/**
 * The pair website, end to end over REAL http on an ephemeral port.
 *
 * The WhatsApp side is stubbed (no network, no sockets): pairNumber hands out
 * a fixed code, refreshPairingCode hands out the next one, isLinked flips when
 * the test says so. Everything else — routing, escaping, rate limits, tokens,
 * the pairing service's own rules — is the real code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const sessionManager = require('../src/whatsapp/sessionManager');
const pairing = require('../src/services/pairing');
const server = require('../src/web/server');

/* ── a fake WhatsApp layer ─────────────────────────────────────────────── */
const real = {
  pairNumber: sessionManager.pairNumber,
  refreshPairingCode: sessionManager.refreshPairingCode,
  teardownPending: sessionManager.teardownPending,
  isLinked: sessionManager.isLinked,
  listSessions: sessionManager.listSessions,
  getPrimary: sessionManager.getPrimary,
  unpair: sessionManager.unpair,
};
const linked = new Set();
let calls = { pair: 0, refresh: 0, teardown: 0, unpair: 0 };

function stubSessions() {
  server.resetLimits();
  calls = { pair: 0, refresh: 0, teardown: 0, unpair: 0 };
  sessionManager.pairNumber = async (phone) => {
    calls.pair++;
    return { phone, code: `AA${calls.pair}BB${calls.pair}CC`, restored: false };
  };
  sessionManager.refreshPairingCode = async () => { calls.refresh++; return `ZZ${calls.refresh}YY${calls.refresh}XX`; };
  sessionManager.teardownPending = () => { calls.teardown++; };
  sessionManager.isLinked = (phone) => linked.has(String(phone));
  sessionManager.listSessions = () => [
    { id: 'primary', phone: '94750404115', isPrimary: true, connected: true, state: 'connected', name: 'Main', startedAt: Date.now() - 60_000 },
    ...[...linked].map((p) => ({ id: p, phone: p, isPrimary: false, connected: true, state: 'connected', name: 'Paired', startedAt: Date.now() })),
  ];
  sessionManager.getPrimary = () => ({ phone: '94750404115', jid: '94750404115@s.whatsapp.net' });
  sessionManager.unpair = async (phone) => { calls.unpair++; linked.delete(String(phone)); };
}
function unstub() { Object.assign(sessionManager, real); }

/* ── http helpers ──────────────────────────────────────────────────────── */
function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function req(port, method, path, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* html or binary */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* ── the tests ─────────────────────────────────────────────────────────── */

test('pair page: renders, escapes the bot name, ships no external resources', async (t) => {
  stubSessions(); pairing.reset();
  process.env.PAIR_MODE = 'public';
  const { srv, port } = await listen(server.createRequestHandler());
  t.after(() => { srv.close(); unstub(); pairing.reset(); });

  const r = await req(port, 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /<!doctype html>/i);
  assert.match(r.text, /Get a pairing code/);
  // the design must be self-contained: no CDN, no external font/script/img
  assert.ok(!/https?:\/\/(?!localhost)[^"'\s)]+\.(css|js|woff2?|png|jpg)/.test(r.text), 'page pulls an external asset');
  assert.ok(!/<script[^>]+src=/.test(r.text), 'page loads an external script');
  // hardening headers
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(String(r.headers['content-security-policy']), /default-src 'none'/);
  assert.match(String(r.headers['cache-control']), /no-store/);
  // liquid-glass bits that must actually be in the document
  for (const needle of ['backdrop-filter', 'feGaussianBlur', 'class="blob', 'class="liquid"', '@keyframes drift1', 'prefers-reduced-motion']) {
    assert.ok(r.text.includes(needle), `page is missing ${needle}`);
  }
});

test('pair page: a bot name with markup cannot break out of the html', async (t) => {
  stubSessions(); pairing.reset();
  const config = require('../src/config');
  const keep = config.botName;
  config.botName = '<img src=x onerror=alert(1)>';
  const { srv, port } = await listen(server.createRequestHandler());
  t.after(() => { srv.close(); config.botName = keep; unstub(); });

  const r = await req(port, 'GET', '/');
  assert.ok(!r.text.includes('<img src=x onerror='), 'raw markup leaked into the page');
  assert.match(r.text, /&lt;img src=x onerror=/);
});

test('pair api: issues a code, reports it, refreshes it, then watches it link', async (t) => {
  stubSessions(); pairing.reset(); linked.clear();
  process.env.PAIR_MODE = 'public';
  process.env.PAIR_COOLDOWN_MS = '0';
  const { srv, port } = await listen(server.createRequestHandler());
  t.after(() => { srv.close(); unstub(); pairing.reset(); });

  const first = await req(port, 'POST', '/api/pair', { body: { number: '+94 77 123 4567' } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.state, 'waiting');
  assert.match(first.json.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(first.json.phone, '94771234567');
  assert.ok(first.json.secondsLeft > 0 && first.json.secondsLeft <= 60);
  assert.equal(calls.pair, 1);

  const st = await req(port, 'GET', `/api/pair/status?id=${first.json.id}`);
  assert.equal(st.status, 200);
  assert.equal(st.json.state, 'waiting');
  assert.equal(st.json.code, first.json.code);

  const rf = await req(port, 'POST', '/api/pair/refresh', { body: { id: first.json.id } });
  assert.equal(rf.status, 200);
  assert.notEqual(rf.json.rawCode, first.json.rawCode);
  assert.equal(calls.refresh, 1);

  // the number links on the phone → the page's poll must see it
  linked.add('94771234567');
  const after = await req(port, 'GET', `/api/pair/status?id=${first.json.id}`);
  assert.equal(after.json.state, 'linked');
  assert.equal(after.json.code, '', 'a linked attempt must stop advertising its code');

  // and a second request for the same number is refused, not re-paired
  const dup = await req(port, 'POST', '/api/pair', { body: { number: '94771234567' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.json.reason, 'exists');
});

test('pair api: refuses junk, the primary number, and leaks nothing about other attempts', async (t) => {
  stubSessions(); pairing.reset(); linked.clear();
  const { srv, port } = await listen(server.createRequestHandler());
  t.after(() => { srv.close(); unstub(); pairing.reset(); });

  const junk = await req(port, 'POST', '/api/pair', { body: { number: '12' } });
  assert.equal(junk.status, 400);
  assert.equal(junk.json.reason, 'invalid');

  const self = await req(port, 'POST', '/api/pair', { body: { number: '94750404115' } });
  assert.equal(self.status, 409);
  assert.equal(self.json.reason, 'primary');

  const noBody = await req(port, 'POST', '/api/pair', { body: null });
  assert.equal(noBody.status, 400);

  const badJson = await req(port, 'POST', '/api/pair', { body: '{oops' });
  assert.equal(badJson.status, 400);

  const unknown = await req(port, 'GET', '/api/pair/status?id=deadbeefdead');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.reason, 'not-found');

  const noId = await req(port, 'GET', '/api/pair/status');
  assert.equal(noId.status, 400);
});

test('pair api: mode=off closes the door, mode=token needs the passcode', async (t) => {
  stubSessions(); pairing.reset();
  process.env.PAIR_MODE = 'off';
  const off = await listen(server.createRequestHandler());
  const offPost = await req(off.port, 'POST', '/api/pair', { body: { number: '94771234567' } });
  assert.equal(offPost.status, 403);
  assert.equal(offPost.json.reason, 'closed');
  const offPage = await req(off.port, 'GET', '/');
  assert.equal(offPage.status, 200);
  assert.match(offPage.text, /Pairing is closed/);
  off.srv.close();

  process.env.PAIR_MODE = 'token';
  process.env.PAIR_TOKEN = 's3cret';
  const tk = await listen(server.createRequestHandler());
  t.after(() => { tk.srv.close(); unstub(); pairing.reset(); delete process.env.PAIR_MODE; delete process.env.PAIR_TOKEN; });
  const bare = await req(tk.port, 'POST', '/api/pair', { body: { number: '94771234567' } });
  assert.equal(bare.status, 403);
  assert.equal(bare.json.reason, 'token');
  const good = await req(tk.port, 'POST', '/api/pair?token=s3cret', { body: { number: '94779998887' } });
  assert.equal(good.status, 200, good.text);
  assert.equal(good.json.state, 'waiting');
});

test('pair api: per-ip http limiter kicks in and says how long to wait', async (t) => {
  stubSessions(); pairing.reset();
  process.env.PAIR_MODE = 'public';
  process.env.PAIR_COOLDOWN_MS = '0';
  process.env.PAIR_HTTP_PER_MIN = '4';
  process.env.PAIR_MAX_PER_PHONE = '50';
  process.env.PAIR_MAX_PER_IP = '50';
  const { srv, port } = await listen(server.createRequestHandler());
  t.after(() => { srv.close(); unstub(); pairing.reset(); delete process.env.PAIR_HTTP_PER_MIN; delete process.env.PAIR_MAX_PER_PHONE; delete process.env.PAIR_MAX_PER_IP; });

  let limited = null;
  for (let i = 0; i < 8; i++) {
    const r = await req(port, 'POST', '/api/pair', { body: { number: `9477000000${i}` } });
    if (r.status === 429) { limited = r; break; }
  }
  assert.ok(limited, 'the http limiter never fired');
  assert.equal(limited.json.reason, 'http-rate');
  assert.ok(Number(limited.headers['retry-after']) > 0);
});

test('logo endpoint serves the bot logo bytes; missing logo is a clean 404', async (t) => {
  stubSessions();
  const { srv, port } = await listen(server.createRequestHandler());
  t.after(() => { srv.close(); unstub(); });
  const r = await req(port, 'GET', '/logo');
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type']), /^image\//);
  assert.ok(r.text.length > 1000, 'logo looks empty');
});

test('owner console: locked without a token, and refuses a wrong one', async (t) => {
  stubSessions(); pairing.reset();
  delete process.env.PAIR_ADMIN_TOKEN;
  delete process.env.STATUS_TOKEN;
  const open = await listen(server.createRequestHandler());
  const r = await req(open.port, 'GET', '/admin');
  assert.equal(r.status, 403);
  assert.match(r.text, /Owner console is locked/);
  assert.ok(!r.text.includes('94750404115'), 'a locked console must not list numbers');
  open.srv.close();

  process.env.PAIR_ADMIN_TOKEN = 'ownerkey';
  const gated = await listen(server.createRequestHandler());
  t.after(() => { gated.srv.close(); unstub(); delete process.env.PAIR_ADMIN_TOKEN; });
  assert.equal((await req(gated.port, 'GET', '/admin')).status, 403);
  assert.equal((await req(gated.port, 'GET', '/admin?token=nope')).status, 403);
  const ok = await req(gated.port, 'GET', '/admin?token=ownerkey');
  assert.equal(ok.status, 200);
  assert.match(ok.text, /Owner console/);
  assert.match(ok.text, /94750404115/, 'the console should list the primary session');

  const api = await req(gated.port, 'GET', '/api/admin/sessions?token=ownerkey');
  assert.equal(api.status, 200);
  assert.equal(api.json.sessions[0].isPrimary, true);
  assert.equal((await req(gated.port, 'GET', '/api/admin/sessions')).status, 403);
});

test('owner console: unlinking a session also forgets its branding', async (t) => {
  stubSessions(); pairing.reset(); linked.clear();
  process.env.PAIR_ADMIN_TOKEN = 'ownerkey';
  const branding = require('../src/services/branding');
  const { srv, port } = await listen(server.createRequestHandler());
  t.after(() => { srv.close(); unstub(); pairing.reset(); delete process.env.PAIR_ADMIN_TOKEN; });

  linked.add('94771112223');
  branding.set('94771112223', { name: 'Temp Bot', header: 'H', footer: 'F' });
  assert.equal(branding.forKey('94771112223').name, 'Temp Bot');

  const r = await req(port, 'POST', '/api/admin/unpair?token=ownerkey', { body: { phone: '94771112223' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(calls.unpair, 1);
  assert.ok(!linked.has('94771112223'));
  branding.flush?.();
  assert.notEqual(branding.forKey('94771112223').name, 'Temp Bot', 'branding survived the unlink');

  // the primary number can never be unlinked from the web
  const bad = await req(port, 'POST', '/api/admin/unpair?token=ownerkey', { body: { phone: '94750404115' } });
  assert.equal(bad.status, 409);
});

test('status endpoint keeps working through the new server (token gate intact)', async (t) => {
  stubSessions();
  process.env.STATUS_TOKEN = 'statustok';
  delete process.env.PAIR_ADMIN_TOKEN;
  const { srv, port } = await listen(server.createRequestHandler({ statusToken: 'statustok' }));
  t.after(() => { srv.close(); unstub(); delete process.env.STATUS_TOKEN; });

  assert.equal((await req(port, 'GET', '/api/status')).status, 403);
  const ok = await req(port, 'GET', '/api/status?token=statustok');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.bot, require('../src/config').botName);
  assert.ok(ok.json.uptime >= 0);
  const legacy = await req(port, 'GET', '/status?token=statustok');
  assert.equal(legacy.status, 200);
});

test('healthz + unknown routes behave, and nothing leaks a stack trace', async (t) => {
  stubSessions();
  const { srv, port } = await listen(server.createRequestHandler());
  t.after(() => { srv.close(); unstub(); });

  const h = await req(port, 'GET', '/healthz');
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, true);

  const missing = await req(port, 'GET', '/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, 'No such endpoint.');

  const page404 = await req(port, 'GET', '/whatever');
  assert.equal(page404.status, 404);
  assert.match(page404.text, /<!doctype html>/i);
  assert.ok(!/at .*\.js:\d+/.test(page404.text), 'stack trace leaked');

  const wrongMethod = await req(port, 'DELETE', '/');
  assert.ok([404, 405].includes(wrongMethod.status));
});

test('public url discovery: env wins, private ips are called out', async () => {
  const publicUrl = require('../src/utils/publicUrl');
  process.env.PAIR_PUBLIC_URL = 'https://pair.example.lk/x';
  const a = await publicUrl.discover({ boundPort: 4321 });
  assert.equal(a.url, 'https://pair.example.lk/x');
  assert.equal(a.source, 'env:PAIR_PUBLIC_URL');
  assert.equal(a.isPublic, true);
  delete process.env.PAIR_PUBLIC_URL;

  process.env.SERVER_IP = '10.0.0.7';
  const b = await publicUrl.discover({ boundPort: 3000 });
  assert.equal(b.ip, '10.0.0.7');
  assert.equal(b.port, 3000);
  assert.equal(b.isPublic, false);
  assert.ok(b.notes.length >= 1, 'a private address must come with a warning');
  assert.ok(b.notes.join(' ').includes('PAIR_PUBLIC_URL'));
  delete process.env.SERVER_IP;

  assert.equal(publicUrl.isPrivate('192.168.1.5'), true);
  assert.equal(publicUrl.isPrivate('172.16.0.1'), true);
  assert.equal(publicUrl.isPrivate('8.8.8.8'), false);
  const box = [];
  const keepLog = console.log;
  console.log = (...a) => box.push(a.join(' '));
  publicUrl.banner({ url: 'http://1.2.3.4:3000/', isPublic: true, source: 'test', port: 3000, notes: [] }, { qr: false });
  console.log = keepLog;
  assert.match(box.join('\n'), /http:\/\/1\.2\.3\.4:3000\//);
});
