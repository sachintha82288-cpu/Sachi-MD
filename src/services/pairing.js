/**
 * Pairing orchestration — one code path for BOTH entrances.
 *
 *   • WhatsApp: `.pair` (own number) / `.pair <number>` (main number only)
 *   • Website : the liquid-glass pair page on the panel's public IP
 *
 * Everything risky lives here instead of being copy-pasted into the HTTP
 * handler and the command: phone validation, "never pair the primary number
 * again" (that duplicates every reply), a hard session cap, per-number and
 * per-IP rate limits, a code TTL, and a janitor that tears a session down
 * when nobody finished linking — so an abandoned attempt cannot leave a
 * half-open socket and a directory of dead credentials behind.
 */
const crypto = require('crypto');
const log = require('../utils/logger');
const sessionManager = require('../whatsapp/sessionManager');

const envInt = (name, def, min = 0) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
};

/** How many paired sessions the bot will carry at once. */
const MAX_SESSIONS = () => envInt('PAIR_MAX_SESSIONS', 8, 1);
/** A code lives about a minute on WhatsApp's side. */
const CODE_TTL_MS = () => envInt('PAIR_CODE_TTL_MS', 60_000, 10_000);
/**
 * How long an unfinished attempt keeps its socket before it is torn down.
 * WhatsApp closes an unregistered socket after about a minute; the session
 * manager re-opens it and rotates the code (up to PAIR_MAX_CODE_ROTATIONS
 * times), so this is the outer bound on the whole attempt — 15 minutes,
 * because a human has to find "Linked devices → link with phone number".
 */
const PENDING_TTL_MS = () => envInt('PAIR_PENDING_TTL_MS', 900_000, 30_000);
/** Two requests for the same number this close together are refused. */
const COOLDOWN_MS = () => envInt('PAIR_COOLDOWN_MS', 30_000, 0);
const RATE_WINDOW_MS = () => envInt('PAIR_RATE_WINDOW_MS', 600_000, 60_000);
const MAX_PER_PHONE = () => envInt('PAIR_MAX_PER_PHONE', 3, 1);
const MAX_PER_IP = () => envInt('PAIR_MAX_PER_IP', 6, 1);
/** How often unfinished attempts are swept up (tests run this much faster). */
const JANITOR_MS = () => envInt('PAIR_JANITOR_MS', 15_000, 250);

/** Thrown with a machine-readable `.reason` so the web UI can react. */
function fail(message, reason, extra = {}) {
  const e = new Error(message);
  e.reason = reason;
  counters.refused++;
  Object.assign(e, extra);
  return e;
}

const counters = { issued: 0, refreshed: 0, refused: 0, linked: 0, cancelled: 0 };
const pending = new Map();          // id → record
const byPhone = new Map();          // phone → id
const attempts = new Map();         // phone|ip → [timestamps]
let janitor = null;

/**
 * WhatsApp drops an unregistered pairing socket after ~a minute. The session
 * manager re-opens it and asks for a NEW code; this listener publishes that
 * code into the attempt, so the website (which polls every 2 s) and `.pair`
 * show the fresh code by themselves instead of leaving a dead one on screen —
 * the "I got a code but the phone says it is invalid" bug.
 */
/**
 * Install a freshly issued code onto an attempt and restart its TTL. Both
 * rotation sources (WhatsApp dropping the socket, and a code simply expiring
 * while somebody is still reading the steps) go through here, so a code on
 * screen and the record the page polls can never disagree.
 */
/** One code per attempt per few seconds — two rotation sources must not race. */
const ROTATE_MIN_GAP_MS = () => envInt('PAIR_ROTATE_GAP_MS', 5_000, 0);
/** Total codes one attempt may use up (WhatsApp's own QR refreshes ~3/min). */
const MAX_ROTATIONS = () => envInt('PAIR_MAX_CODE_ROTATIONS', 20, 1);

function publishCode(rec, code, why, now = Date.now()) {
  if (!rec || !code) return false;
  // `now` is passed in by the sweep so one decision and its publication share
  // a clock; callers that have no clock of their own get the real one.
  if (stateOf(rec, now) !== 'waiting') return false;
  // The socket-close path and the expiry sweep can fire in the same
  // millisecond. Without this the second code instantly invalidates the first,
  // and a user who read the first one is told "invalid code".
  if (rec.lastCodeAt && now - rec.lastCodeAt < ROTATE_MIN_GAP_MS()) return false;
  if ((rec.rotations || 0) >= MAX_ROTATIONS()) return false;
  // Store it UNGROUPED, exactly like `request()` does: `rawCode` stays the
  // 8 characters the phone needs, `code` is the grouped view the page shows.
  rec.code = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
  rec.createdAt = now;                       // the cooldown follows the code
  rec.codeIssuedAt = now;
  rec.expiresAt = now + CODE_TTL_MS();
  rec.pendingUntil = Math.max(rec.pendingUntil, now + PENDING_TTL_MS());
  rec.rotations = (rec.rotations || 0) + 1;
  rec.lastCodeAt = now;
  counters.issued++;
  log.info(`[pair] code rotated for +${rec.phone} (${why}, rotation ${rec.rotations}/${MAX_ROTATIONS()})`);
  return true;
}

if (typeof sessionManager.onPairingCode === 'function') {
  sessionManager.onPairingCode(({ phone, code }) => publishCode(getByPhone(phone), code, 'socket re-opened'));
}

const group = (code) => {
  const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : (c || '');
};
/**
 * +94 77 123 4567 — the way the number appears inside WhatsApp itself, so the
 * code and the number on screen read like the official screen. Sri Lankan
 * numbers get their own grouping (most installs are here); everything else
 * falls back to a plain 3-3-rest split rather than a wrong guess.
 */
const PHONE_CC = ['971', '972', '966', '974', '965', '968', '880', '977', '94', '91', '92',
  '60', '65', '61', '62', '44', '33', '49', '39', '34', '7', '1', '20', '27', '90', '86', '81',
  '82', '84', '66', '63', '55', '52', '54', '57', '51', '48', '46', '45', '47', '31', '32',
  '36', '30', '43', '41', '40', '380', '375', '995', '998', '994'];
/**
 * The country code of a number, using the same table `prettyPhone` groups by.
 * The pair page uses it to preselect the country the bot itself is registered
 * in, instead of guessing from the visitor's browser.
 */
function ccOf(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return '';
  return PHONE_CC.find((c) => d.startsWith(c) && d.length > c.length) || '';
}

function prettyPhone(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (!d) return '';
  // +94 77 123 4567 for Sri Lanka; every other country is split the same way
  // a phone keypad groups it (last seven digits as 3+4), which reads well for
  // any length instead of guessing wrong.
  if (d.startsWith('94') && d.length === 11) return `+94 ${d.slice(2, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  const cc = PHONE_CC.find((c) => d.startsWith(c) && d.length > c.length) || d.slice(0, 2);
  const rest = d.slice(cc.length);
  if (rest.length < 7) return `+${cc}${rest ? ' ' + rest : ''}`;
  const head = rest.slice(0, rest.length - 7);
  const parts = [head, rest.slice(-7, -4), rest.slice(-4)].filter(Boolean);
  return `+${cc} ${parts.join(' ')}`;
}
const newId = () => crypto.randomBytes(6).toString('hex');

function bump(key, now = Date.now()) {
  const list = (attempts.get(key) || []).filter((t) => t > now - RATE_WINDOW_MS());
  list.push(now);
  attempts.set(key, list);
  while (attempts.size > 500) attempts.delete(attempts.keys().next().value);
  return list.length;
}
function hits(key, now = Date.now()) {
  return (attempts.get(key) || []).filter((t) => t > now - RATE_WINDOW_MS()).length;
}

/** Live state of one attempt — recomputed, never trusted from the record. */
function stateOf(rec, now = Date.now()) {
  if (!rec) return null;
  if (rec.state === 'cancelled') return 'cancelled';
  // `rec.state === 'linked'` is sticky on purpose: a session whose credentials
  // were already on disk (restored) is linked from the first moment, and a
  // number that linked once must never be reported as waiting again.
  if (rec.state === 'linked' || sessionManager.isLinked(rec.phone)) return 'linked';
  if (rec.state === 'expired' || now > rec.pendingUntil) return 'expired';
  return 'waiting';
}

function publicView(rec, now = Date.now()) {
  if (!rec) return null;
  const state = stateOf(rec, now);
  // A code past its TTL is dead on WhatsApp's side even though the socket is
  // still open, so it is never shown again — the caller offers "new code"
  // instead of letting somebody type a code that can no longer work.
  const codeAlive = state === 'waiting' && !!rec.code && now <= rec.expiresAt;
  return {
    id: rec.id,
    phone: rec.phone,
    phonePretty: prettyPhone(rec.phone),
    state,
    code: codeAlive ? group(rec.code) : '',
    // Stripped, never trusted verbatim: `publicView` is idempotent, so a
    // caller that passes an already-rendered view back in cannot end up with
    // "OLDC-CODE" as the thing a phone is supposed to type.
    rawCode: codeAlive ? String(rec.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '') : '',
    codeExpired: state === 'waiting' && !codeAlive,
    expiresAt: rec.expiresAt,
    pendingUntil: rec.pendingUntil,
    name: rec.name || null,
    source: rec.source,
    refreshes: rec.refreshes,
    rotations: rec.rotations || 0,
    secondsLeft: Math.max(0, Math.round((rec.expiresAt - now) / 1000)),
  };
}

function get(id) { return pending.get(String(id || '')) || null; }
function getByPhone(phone) {
  const id = byPhone.get(sessionManager.normalizePhone(phone));
  return id ? get(id) : null;
}

/**
 * One pass over every attempt. Exported (as `tick`) so a test can drive it
 * without waiting fifteen seconds for the interval.
 */
function janitorTick(now = Date.now()) {
  for (const rec of pending.values()) {
      const st = stateOf(rec, now);
      if (st === 'linked') {
        if (rec.state !== 'linked') counters.linked++;
        rec.state = 'linked';
        rec.linkedAt = rec.linkedAt || now;
        try { rec.name = sessionManager.listSessions().find((s) => s.phone === rec.phone)?.name || rec.name; } catch {}
        // keep the record for a while so the page can show the success state
        if (now - rec.linkedAt > 10 * 60_000) drop(rec);
        continue;
      }
      if (st === 'expired' && rec.state !== 'expired') {
        rec.state = 'expired';
        log.info(`[pair] +${rec.phone} never finished linking — session torn down`);
        try { sessionManager.teardownPending(rec.phone); } catch {}
        if (now - rec.pendingUntil > 10 * 60_000) drop(rec);
        continue;
      }
      // Still waiting, socket still open, but the code on screen is dead. That
      // is the ordinary case (WhatsApp codes live 60 s and a human needs longer
      // to open Linked devices), and it is exactly when a user gives up. Ask
      // WhatsApp for another code and let the page pick it up from the poll —
      // no button press, no reload.
      if (st === 'waiting' && rec.code && now > rec.expiresAt && !rec.rotating
          && (rec.rotations || 0) < MAX_ROTATIONS()) {
        rec.rotating = true;
        Promise.resolve()
          .then(() => sessionManager.refreshPairingCode(rec.phone))
          .then((code) => { publishCode(rec, code, 'expired on screen', Math.max(now, Date.now())); })
          .catch((e) => log.info(`[pair] could not rotate the code for +${rec.phone}: ${e.message}`))
          .finally(() => { rec.rotating = false; });
      }
    }
}

function startJanitor() {
  if (janitor) return;
  janitor = setInterval(() => janitorTick(), JANITOR_MS());
  janitor.unref?.();
}

function drop(rec) {
  if (!rec) return;
  pending.delete(rec.id);
  if (byPhone.get(rec.phone) === rec.id) byPhone.delete(rec.phone);
}

/** How many sessions the bot is carrying right now (linked + pending). */
function load() {
  const live = sessionManager.listSessions().filter((s) => !s.isPrimary).length;
  return Math.max(live, pending.size);
}

/**
 * Ask for a pairing code. `source` is 'chat' | 'web' | 'terminal'.
 * Throws with `.reason` — callers turn that into a friendly message.
 */
async function request({ phone, source = 'chat', ip = null, notifyJid = null, notifySend = null } = {}) {
  startJanitor();
  const digits = sessionManager.normalizePhone(phone);
  if (!sessionManager.isValidPhone(digits)) {
    throw fail('Enter the full number with country code, digits only — e.g. 94771234567', 'invalid');
  }
  const now = Date.now();

  // The primary number must never be paired again: two linked devices of the
  // same account answer every message twice.
  const primary = sessionManager.getPrimary();
  const primaryPhone = sessionManager.normalizePhone(primary?.phone || require('../config').phoneNumber || '');
  if (digits === primaryPhone) {
    throw fail('That is the bot\'s own number — it is already connected.', 'primary');
  }
  if (sessionManager.isLinked(digits)) {
    throw fail(`+${digits} is already paired and online.`, 'exists');
  }
  if (load() >= MAX_SESSIONS()) {
    throw fail(`This bot is full (${MAX_SESSIONS()} paired sessions). Ask the owner to remove one.`, 'cap', { max: MAX_SESSIONS() });
  }
  if (hits(`p:${digits}`, now) >= MAX_PER_PHONE()) {
    throw fail(`Too many attempts for +${digits}. Try again in a few minutes.`, 'rate-phone', {
      retryMs: RATE_WINDOW_MS(),
    });
  }
  if (ip && hits(`i:${ip}`, now) >= MAX_PER_IP()) {
    throw fail('Too many attempts from your connection. Try again in a few minutes.', 'rate-ip', {
      retryMs: RATE_WINDOW_MS(),
    });
  }
  // Counted BEFORE the reuse path: handing out a refreshed code is still a
  // code handed out, so it spends the same budget as a fresh attempt.
  bump(`p:${digits}`, now);
  if (ip) bump(`i:${ip}`, now);

  const existing = getByPhone(digits);
  if (existing) {
    const st = stateOf(existing, now);
    if (st === 'waiting' && now - existing.createdAt < COOLDOWN_MS()) {
      throw fail(`A code for +${digits} is already on screen — wait ${Math.ceil((existing.createdAt + COOLDOWN_MS() - now) / 1000)}s or refresh it.`, 'cooldown', {
        id: existing.id, retryMs: existing.createdAt + COOLDOWN_MS() - now,
      });
    }
    if (st === 'waiting') return { ...(await refresh(existing.id, { source, ip })), reused: true };
    drop(existing);
  }

  let result;
  try {
    result = await sessionManager.pairNumber(digits, { notifyJid, notifySend });
  } catch (e) {
    throw fail(e.message || 'WhatsApp refused the pairing request.', 'pair-failed');
  }

  if (result.restored) {
    // Credentials were already on disk: the session comes back online by itself.
    const id = newId();
    const rec = {
      id, phone: digits, code: null, createdAt: now, expiresAt: 0,
      pendingUntil: now + PENDING_TTL_MS(), source, ip, state: 'linked',
      linkedAt: now, refreshes: 0, name: null, notifyJid, notifySend,
    };
    pending.set(id, rec); byPhone.set(digits, id);
    return publicView(rec);
  }

  const id = newId();
  const rec = {
    id,
    phone: digits,
    code: String(result.code || ''),
    createdAt: now,
    expiresAt: now + CODE_TTL_MS(),
    pendingUntil: now + PENDING_TTL_MS(),
    source, ip, state: 'waiting', refreshes: 0, rotations: 0, name: null,
    notifyJid, notifySend,
  };
  pending.set(id, rec);
  byPhone.set(digits, id);
  counters.issued++;
  log.info(`[pair] code issued for +${digits} (${source}${ip ? ` · ${ip}` : ''}) — ${pending.size} pending`);
  return publicView(rec);
}

/** A fresh code for the same attempt (the old one expired on screen). */
async function refresh(id, { source, ip } = {}) {
  const rec = get(id);
  if (!rec) throw fail('That pairing attempt is gone — start a new one.', 'not-found');
  const now = Date.now();
  const st = stateOf(rec, now);
  // Already linked → hand back the success view instead of an error, so the
  // page's "new code" button can never undo a finished pairing.
  if (st === 'linked') { rec.state = 'linked'; return publicView(rec, now); }
  if (st !== 'waiting') throw fail('That attempt is no longer waiting for a code.', 'not-waiting');
  if (ip && hits(`i:${ip}`, now) >= MAX_PER_IP() * 3) {
    throw fail('Slow down — too many codes requested.', 'rate-ip');
  }
  let code = null;
  try { code = await sessionManager.refreshPairingCode(rec.phone); }
  catch (e) { throw fail(e.message || 'Could not get a new code.', 'refresh-failed'); }
  if (code === null) { rec.state = 'linked'; return publicView(rec); }
  rec.code = String(code);
  rec.codeIssuedAt = now;
  rec.expiresAt = now + CODE_TTL_MS();
  rec.pendingUntil = Math.max(rec.pendingUntil, now + PENDING_TTL_MS());
  rec.refreshes++;
  counters.refreshed++;
  if (source) rec.source = source;
  return publicView(rec);
}

/** Give up on an attempt — by its id, or by the phone number behind it
 *  (the page's "cancel", `.unpair`, or the owner console). */
function cancel(idOrPhone) {
  const rec = get(idOrPhone) || getByPhone(idOrPhone);
  if (!rec) return false;
  rec.state = 'cancelled';
  counters.cancelled++;
  try { sessionManager.teardownPending(rec.phone); } catch {}
  drop(rec);
  return true;
}

/** One attempt, or by phone number when the id is unknown. */
function state(idOrPhone) {
  const rec = get(idOrPhone) || getByPhone(idOrPhone);
  return publicView(rec);
}

function listPending() {
  return [...pending.values()].map((r) => publicView(r)).filter(Boolean);
}

function stats() {
  const now = Date.now();
  const all = [...pending.values()];
  return {
    pending: all.filter((r) => stateOf(r, now) === 'waiting').length,
    linked: all.filter((r) => stateOf(r, now) === 'linked').length,
    expired: all.filter((r) => stateOf(r, now) === 'expired').length,
    sessions: sessionManager.listSessions().filter((s) => !s.isPrimary).length,
    maxSessions: MAX_SESSIONS(),
    codeTtlMs: CODE_TTL_MS(),
    pendingTtlMs: PENDING_TTL_MS(),
    window: {
      perPhone: MAX_PER_PHONE(), perIp: MAX_PER_IP(), ms: RATE_WINDOW_MS(),
    },
    issued: counters.issued,
    rotations: [...pending.values()].reduce((n, r) => n + (r.rotations || 0), 0),
    refreshed: counters.refreshed,
    refused: counters.refused,
    cancelled: counters.cancelled,
    inUse: load(),
  };
}

/** Test hook: forget every in-memory attempt (sockets are left alone). */
function reset() {
  counters.issued = counters.refreshed = counters.refused = counters.linked = counters.cancelled = 0;
  pending.clear(); byPhone.clear(); attempts.clear();
  if (janitor) { clearInterval(janitor); janitor = null; }
}

module.exports = {
  request, refresh, cancel, state, listPending, stats, reset,
  // `publicView` is the record as the page sees it (grouped code, seconds
  // left, expired codes blanked) — exported so the lifecycle can be asserted.
  publicView, group, prettyPhone, ccOf, MAX_SESSIONS, CODE_TTL_MS, PENDING_TTL_MS,
  // the sweep is also driven directly by tests (no 15 s wait)
  tick: janitorTick, publishCode, MAX_ROTATIONS, ROTATE_MIN_GAP_MS,
};
