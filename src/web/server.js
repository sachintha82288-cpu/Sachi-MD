/**
 * The bot's web face — ONE server, three jobs:
 *
 *   /            the liquid-glass pair page (public by default)
 *   /api/pair*   issue, refresh and watch a pairing code
 *   /logo        the bot's logo for that page
 *   /admin       owner console: sessions, pending pairings, limits  (token)
 *   /api/status  the original JSON status endpoint (token, unchanged)
 *   /healthz     liveness probe for the panel / uptime monitors
 *
 * It deliberately owns the port instead of the old status-only server, but
 * `/api/status` and `/status` still delegate to `src/web/status.js` so that
 * endpoint keeps exactly the behaviour (and the token gate) it always had.
 *
 * Hardening, because this thing is reachable from the whole internet:
 *   • request bodies capped at 4 KB and must be JSON
 *   • a per-IP sliding-window limiter on every route, tighter on POST
 *   • CSP / nosniff / no-frame / no-referrer / no-store headers
 *   • every interpolation into HTML goes through `esc()`
 *   • the pairing service does the real validation, rate limiting and caps —
 *     this layer never decides on its own who may link a number
 */
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const log = require('../utils/logger');
const pairing = require('../services/pairing');
const branding = require('../services/branding');
const publicUrl = require('../utils/publicUrl');
const sessionManager = require('../whatsapp/sessionManager');
const statusWeb = require('./status');
const tlsMaterial = require('./tls');
const pairPage = require('./pages/pair');
const adminPage = require('./pages/admin');

const BODY_LIMIT = 4 * 1024;
const MODE = () => String(process.env.PAIR_MODE || 'public').trim().toLowerCase();   // public | token | off
const pairToken = () => String(process.env.PAIR_TOKEN || '').trim();
const adminToken = () => String(process.env.PAIR_ADMIN_TOKEN || process.env.STATUS_TOKEN || '').trim();
const statusToken = () => String(process.env.STATUS_TOKEN || '').trim();
const trustProxy = () => /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ''));

/**
 * How many requests per IP per minute, by route family. Read at call time —
 * an env knob that only applies at require() time cannot be changed by the
 * owner without a restart, and cannot be tested.
 */
const envInt = (name, def, min = 1) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
};
const LIMITS = () => ({
  pair: envInt('PAIR_HTTP_PER_MIN', 12),
  api: envInt('PAIR_HTTP_API_PER_MIN', 90),
  page: envInt('PAIR_HTTP_PAGE_PER_MIN', 60),
});
const hits = new Map();      // `${ip}:${family}` → [ts]
function allowed(ip, family) {
  const L = LIMITS();
  const cap = L[family] || L.page;
  const key = `${ip}:${family}`;
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => t > now - 60_000);
  if (list.length >= cap) {
    hits.set(key, list);
    return { ok: false, retryMs: 60_000 - (now - list[0]) };
  }
  list.push(now);
  hits.set(key, list);
  while (hits.size > 2000) hits.delete(hits.keys().next().value);
  return { ok: true };
}

/** Forget the per-IP counters (tests, or an owner who just got rate limited). */
function resetLimits() { hits.clear(); }

function ipOf(req) {
  if (trustProxy()) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff.replace(/^::ffff:/, '');
  }
  return String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const kill = setTimeout(() => { reject(new Error('body timeout')); req.destroy(); }, 6000);
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { clearTimeout(kill); reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      clearTimeout(kill);
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', (e) => { clearTimeout(kill); reject(e); });
  });
}

/* ────────────────────────────  tiny responders  ─────────────────────────── */

/** How long a browser should remember to use HTTPS (default 30 days). */
const HSTS_MAX_AGE = () => {
  const n = Number(process.env.HTTPS_HSTS_MAX_AGE);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2592000;
};

function secureHeaders(res, { html = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (state.tls) {
    // HTTPS-only was the choice: tell the browser to come back on TLS.
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE()}`);
  }
  if (html) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Content-Security-Policy', [
      "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
      "img-src 'self' data:", "connect-src 'self'", "form-action 'none'",
      "base-uri 'none'", "frame-ancestors 'none'",
    ].join('; '));
  } else {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
}

function sendHtml(res, code, html) {
  secureHeaders(res, { html: true });
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
  res.end(html);
}

function sendJson(res, code, obj) {
  secureHeaders(res);
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  secureHeaders(res);
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function tokenFrom(req, url) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  return String(url.searchParams.get('token') || '').trim() || bearer;
}

/* ───────────────────────────────  handlers  ─────────────────────────────── */

/** The country the primary number belongs to — the pair page's default. */
function botCountry() {
  try {
    const primary = sessionManager.getPrimary?.()?.phone || config.phoneNumber || '';
    return pairing.ccOf(primary) || '94';
  } catch { return '94'; }
}

function pairInfo() {
  const st = pairing.stats();
  // `ready` tells the page whether the bot's own session has finished its
  // handshake. The page must load and explain itself even while the bot is
  // still connecting — "the website only works after the owner pairs" was the
  // complaint that started this whole round, so the page never depends on it.
  let ready = false;
  try { ready = !!sessionManager.status().connected; } catch {}
  return {
    mode: MODE(),
    ready,
    closed: MODE() === 'off',
    full: st.inUse >= st.maxSessions,
    sessions: st.inUse,
    maxSessions: st.maxSessions,
    codeTtlSec: Math.round(st.codeTtlMs / 1000),
    pending: st.pending,
    url: publicUrl.current()?.url || null,
  };
}

async function handlePairPost(req, res, url) {
  let body = {};
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `Bad request (${e.message}).` }); }
  const number = String(body.number || body.phone || url.searchParams.get('number') || '').replace(/\D/g, '');
  const ip = ipOf(req);
  try {
    const view = await pairing.request({ phone: number, source: 'web', ip });
    log.info(`[web] pair code issued to +${view.phone} from ${ip}`);
    return sendJson(res, 200, view);
  } catch (e) {
    const code = e.reason === 'rate-ip' || e.reason === 'rate-phone' || e.reason === 'cooldown' ? 429
      : e.reason === 'cap' ? 503
      : e.reason === 'invalid' ? 400 : 409;
    return sendJson(res, code, { error: e.message, reason: e.reason || 'refused', retryMs: e.retryMs || null });
  }
}

async function handleRefresh(req, res, url) {
  let body = {};
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `Bad request (${e.message}).` }); }
  const id = String(body.id || url.searchParams.get('id') || '').trim();
  if (!id) return sendJson(res, 400, { error: 'Missing id.', reason: 'invalid' });
  try {
    const view = await pairing.refresh(id, { source: 'web', ip: ipOf(req) });
    return sendJson(res, 200, view);
  } catch (e) {
    return sendJson(res, 409, { error: e.message, reason: e.reason || 'refused' });
  }
}

function logoBytes() {
  let p = null;
  try { p = branding.logoPathFor('primary'); } catch { p = null; }
  if (!p) p = path.join(__dirname, '..', '..', 'assets', 'logo.jpg');
  try {
    if (!p || !fs.existsSync(p)) return null;
    const ext = path.extname(p).toLowerCase();
    const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
    return { buf: fs.readFileSync(p), type };
  } catch { return null; }
}

function handleLogo(req, res) {
  const l = logoBytes();
  if (!l) return sendJson(res, 404, { error: 'no logo' });
  secureHeaders(res);
  res.writeHead(200, {
    'Content-Type': l.type, 'Content-Length': l.buf.length,
    'Cache-Control': 'public, max-age=300',
  });
  res.end(l.buf);
}

function handleAdmin(req, res, url) {
  const want = adminToken();
  if (!want) {
    return sendHtml(res, 403, pairPage.render({
      botName: config.botName, version: config.version, mode: 'locked',
      tagline: 'Owner console locked',
    }));
  }
  if (tokenFrom(req, url) !== want) return sendJson(res, 403, { error: 'forbidden' });

  const st = pairing.stats();
  const info = publicUrl.current() || { url: '', ip: '', port: '', source: '', notes: [], isPublic: false };
  const health = (() => {
    try {
      const h = require('../services/antiban').status?.()?.health || {};
      return `${h.level || 'ok'} · risk ${h.risk != null ? h.risk : 0} · speed ×${h.throughputFactor != null ? h.throughputFactor : 1}`;
    } catch { return 'unknown'; }
  })();
  return sendHtml(res, 200, adminPage.render({
    botName: config.botName,
    version: config.version,
    token: want,
    sessions: sessionManager.listSessions(),
    pending: pairing.listPending(),
    info,
    stats: {
      maxSessions: st.maxSessions, inUse: st.inUse, pending: st.pending,
      issued: st.issued, refreshed: st.refreshed, linked: st.linked, refused: st.refused,
      health,
      uptime: humanUptime(process.uptime()),
    },
  }));
}

function humanUptime(s) {
  const n = Math.max(0, Math.floor(Number(s) || 0));
  const d = Math.floor(n / 86400), h = Math.floor((n % 86400) / 3600), m = Math.floor((n % 3600) / 60);
  return [d ? `${d}d` : null, h ? `${h}h` : null, `${m}m`].filter(Boolean).join(' ');
}

async function handleAdminUnpair(req, res, url) {
  const want = adminToken();
  if (!want || tokenFrom(req, url) !== want) return sendJson(res, 403, { error: 'forbidden' });
  let body = {};
  try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: e.message }); }
  const phone = sessionManager.normalizePhone(String(body.phone || ''));
  if (!sessionManager.isValidPhone(phone)) return sendJson(res, 400, { error: 'Invalid number.' });
  const primary = sessionManager.normalizePhone(sessionManager.getPrimary()?.phone || config.owner || '');
  if (phone === primary) return sendJson(res, 409, { error: 'The primary session cannot be unlinked.' });
  try {
    pairing.cancel(phone);                 // drop any half-finished attempt first
    await sessionManager.unpair(phone);
    branding.forget(phone);                // and their stored name/logo/header/footer
    log.warn(`[web] admin unlinked +${phone} from ${ipOf(req)}`);
    return sendJson(res, 200, { ok: true, phone });
  } catch (e) {
    return sendJson(res, 500, { error: e.message || 'Unlink failed.' });
  }
}

/** Build the router. `deps` lets tests swap the pieces out. */
function createRequestHandler(deps = {}) {
  const statusHandler = statusWeb.createRequestHandler(deps.statusToken !== undefined ? deps.statusToken : statusToken());

  return async function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'Bad URL.' }); }
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const method = String(req.method || 'GET').toUpperCase();
    const ip = ipOf(req);

    // Everything that is not a plain GET on a page is rate limited harder.
    const family = p.startsWith('/api/pair') ? 'pair' : p.startsWith('/api') ? 'api' : 'page';
    const gate = allowed(ip, family);
    if (!gate.ok) {
      res.setHeader('Retry-After', String(Math.ceil(gate.retryMs / 1000)));
      return sendJson(res, 429, { error: 'Slow down — too many requests.', reason: 'http-rate', retryMs: gate.retryMs });
    }

    try {
      /* ── pages ── */
      if (method === 'GET' && (p === '/' || p === '/pair' || p === '/index.html' || p === '/pair.html')) {
        const info = pairInfo();
        return sendHtml(res, 200, pairPage.render({
          botName: config.botName, version: config.version, tagline: config.tagline || branding.forKey('primary').tagline,
          mode: info.mode, token: MODE() === 'token' ? pairToken() : '',
          maxSessions: info.maxSessions, sessions: info.sessions, codeTtlSec: info.codeTtlSec,
          country: botCountry(),
        }));
      }
      if (method === 'GET' && p === '/favicon.ico') return sendJson(res, 204, {});
      if (method === 'GET' && (p === '/logo' || p === '/logo.jpg' || p === '/logo.png')) return handleLogo(req, res);
      if (method === 'GET' && p === '/healthz') {
        const st = pairing.stats();
        return sendJson(res, 200, { ok: true, uptime: Math.floor(process.uptime()), sessions: st.inUse, pending: st.pending, bot: config.botName });
      }

      /* ── pair api ── */
      if (p === '/api/pair' && method === 'POST') {
        if (MODE() === 'off') return sendJson(res, 403, { error: 'Pairing is closed on this bot.', reason: 'closed' });
        if (MODE() === 'token' && tokenFrom(req, url) !== pairToken()) return sendJson(res, 403, { error: 'This bot needs an access passcode.', reason: 'token' });
        return await handlePairPost(req, res, url);
      }
      if (p === '/api/pair/refresh' && method === 'POST') {
        if (MODE() === 'off') return sendJson(res, 403, { error: 'Pairing is closed on this bot.', reason: 'closed' });
        return await handleRefresh(req, res, url);
      }
      if (p === '/api/pair/status' && method === 'GET') {
        const id = String(url.searchParams.get('id') || '').trim();
        if (!id) return sendJson(res, 400, { error: 'Missing id.', reason: 'invalid' });
        const view = pairing.state(id);
        if (!view) return sendJson(res, 404, { error: 'Unknown pairing attempt.', reason: 'not-found' });
        return sendJson(res, 200, view);
      }
      if (p === '/api/pair/info' && method === 'GET') return sendJson(res, 200, pairInfo());
      if (p === '/api/pair/cancel' && method === 'POST') {
        let body = {};
        try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Bad request.' }); }
        const id = String(body.id || url.searchParams.get('id') || '').trim();
        return sendJson(res, 200, { ok: pairing.cancel(id) });
      }

      /* ── owner console ── */
      if (p === '/admin' && method === 'GET') return handleAdmin(req, res, url);
      if (p === '/api/admin/unpair' && method === 'POST') return await handleAdminUnpair(req, res, url);
      if (p === '/api/admin/sessions' && method === 'GET') {
        const want = adminToken();
        if (!want || tokenFrom(req, url) !== want) return sendJson(res, 403, { error: 'forbidden' });
        return sendJson(res, 200, { sessions: sessionManager.listSessions(), pending: pairing.listPending(), stats: pairing.stats(), info: publicUrl.current() });
      }

      /* ── the original status endpoint, untouched ── */
      if ((p === '/api/status' || p === '/status') && method === 'GET') return statusHandler(req, res);

      if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'No such endpoint.' });
      return sendHtml(res, 404, pairPage.render({ botName: config.botName, version: config.version, mode: MODE(), tagline: '404 — page not found' }));
    } catch (e) {
      log.error(`[web] ${method} ${p} failed: ${e?.message || e}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error.' });
      else try { res.end(); } catch { /* already gone */ }
      return undefined;
    }
  };
}

/**
 * Runtime shape of the listener: one port that speaks BOTH protocols.
 *
 * A panel allocates one port, and people type `http://ip:port` into a phone
 * browser without thinking. So the socket's first byte decides: 0x16 is a TLS
 * handshake and goes to the HTTPS server, anything else gets a 301 to the
 * https:// address instead of a confusing "this site can't be reached".
 */
const state = {
  listener: null, httpsServer: null, httpServer: null, redirectServer: null,
  tls: false, port: 0, started: false,
};

function scheme() { return state.tls ? 'https' : 'http'; }

/** A plain-HTTP request on the TLS port: point the browser at https. */
function redirectToHttps(req, res) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '') || 'localhost';
  const port = state.port;
  const defaultPort = port === 443;
  const target = `https://${host}${defaultPort ? '' : `:${port}`}${req.url || '/'}`;
  res.writeHead(301, {
    'Location': target,
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end(`This bot serves HTTPS only — opening ${target}\n`);
}

async function start({ banner = true, port = null } = {}) {
  if (state.started) return state.listener;
  // `port: 0` means "any free port" (tests, a second instance). Absent / null
  // must mean "the configured port" — Number(null) is 0, which would silently
  // bind an ephemeral port and leave the panel's allocated port dead.
  const listenPort = (port === null || port === undefined || port === '')
    ? config.port
    : (Number.isFinite(Number(port)) ? Number(port) : config.port);
  const handler = createRequestHandler();

  // Work out the address first so the certificate can cover it. With
  // `banner:false` (tests, embedded use) the network lookup is skipped
  // entirely — the certificate then covers localhost and the local IPs.
  const probe = banner
    ? await publicUrl.discover({ boundPort: listenPort, path: '/', scheme: 'https' }).catch(() => null)
    : null;
  const hosts = [probe?.ip, process.env.PAIR_PUBLIC_URL].filter(Boolean);
  let material = { tls: false };
  if (String(process.env.HTTPS_ENABLED || 'true') !== 'false') {
    try { material = await tlsMaterial.load({ extraHosts: hosts }); }
    catch (e) { log.error(`[tls] ${e.message}`); }
  }
  state.tls = !!material.tls;

  state.httpServer = http.createServer(state.tls ? redirectToHttps : handler);
  state.httpsServer = state.tls ? https.createServer({ cert: material.cert, key: material.key, honorCipherOrder: true, minVersion: 'TLSv1.2' }, handler) : null;
  // Fed sockets by hand — never listens on its own.
  state.redirectServer = http.createServer(redirectToHttps);

  const onError = (e) => {
    if (e && e.code === 'EADDRINUSE') {
      log.error(`Web server could not start: port ${listenPort} is already in use (another bot copy running?). The bot itself keeps running — the pair page will be unavailable.`);
    } else log.error(`Web server error: ${e?.message || e}`);
  };

  if (state.tls) {
    state.listener = net.createServer((socket) => {
      socket.once('error', () => { try { socket.destroy(); } catch {} });
      socket.once('data', (buf) => {
        socket.pause();
        const isTls = buf && buf.length > 0 && buf[0] === 0x16;
        const target = isTls ? state.httpsServer : state.redirectServer;
        try { target.emit('connection', socket); }
        catch (e) { log.warn(`[web] handoff failed: ${e.message}`); try { socket.destroy(); } catch {} return; }
        socket.unshift(buf);
        process.nextTick(() => socket.resume());
      });
    });
  } else {
    state.listener = state.httpServer;
  }
  state.listener.on('error', onError);

  await new Promise((resolve) => {
    state.listener.listen(listenPort, '0.0.0.0', resolve);
    // If the port is taken the 'error' handler logs it; stop waiting either way.
    state.listener.once('error', resolve);
  });
  state.port = state.listener.address?.()?.port || listenPort;
  state.started = true;

  const mode = MODE();
  log.info(`[web] ${state.tls ? 'HTTPS' : 'HTTP'} listening on 0.0.0.0:${state.port} · tls: ${tlsMaterial.describe(material)} · pair mode: ${mode}${mode === 'token' ? ' (passcode required)' : ''}${adminToken() ? ' · owner console: token-protected' : ' · owner console: LOCKED (set PAIR_ADMIN_TOKEN)'}`);
  if (state.tls && material.source !== 'env') {
    log.info('[web] the browser will warn once about the self-signed certificate — Advanced → Continue. Put a real cert in SSL_CERT_PATH/SSL_KEY_PATH to remove the warning.');
  }
  if (!state.tls) {
    log.error('[web] HTTPS is NOT available — no certificate could be loaded or generated. Check the [tls] lines above.');
  }

  if (banner) {
    try {
      const info = await publicUrl.discover({ boundPort: state.port, path: '/', scheme: scheme() });
      publicUrl.banner(info, { tls: state.tls, certSource: material.source });
    } catch (e) {
      log.warn(`[web] could not work out the public pair URL: ${e?.message || e}`);
    }
  }
  return state.listener;
}

async function stop() {
  if (!state.started) return;
  state.started = false;
  const closes = [];
  for (const srv of [state.listener, state.httpsServer, state.httpServer, state.redirectServer]) {
    if (!srv) continue;
    closes.push(new Promise((r) => { try { srv.close(() => r()); } catch { r(); } }));
  }
  state.listener = state.httpsServer = state.httpServer = state.redirectServer = null;
  state.tls = false;
  await Promise.race([Promise.all(closes), new Promise((r) => setTimeout(r, 2500))]);
}

/**
 * The URL to print in chat (.pair / .settings). Always re-resolved against the
 * port the server ACTUALLY bound to and the protocol it is actually serving:
 * a value discovered before `listen()` would otherwise be cached with the
 * wrong port (and http:// while we serve https://). The expensive part — the
 * public-IP lookup — is cached inside `publicUrl`, so this stays cheap.
 */
async function pairUrl() {
  const bound = state.port || config.port;
  try { return await publicUrl.discover({ boundPort: bound, path: '/', scheme: scheme() }); }
  catch { return publicUrl.current(); }
}

module.exports = { start, stop, createRequestHandler, pairUrl, pairInfo, ipOf, resetLimits, MODE, scheme, state };
