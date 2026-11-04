/**
 * Multi-session manager — primary bot + paired numbers as independent bots.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { generateWAMessageFromContent, prepareWAMessageMedia } = require('@whiskeysockets/baileys');
const {
  useMultiFileAuthState, DisconnectReason, Browsers,
  fetchLatestBaileysVersion, makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const config = require('../config');
const router = require('../router/router');
const log = require('../utils/logger');
const phone = require('../utils/phone');
const { ensureDir } = require('../utils/files');
const { normalizeJid, messageAgeMs } = require('../utils/messages');
const statusManager = require('../services/status/manager');
const antiban = require('../services/antiban');
const branding = require('../services/branding');
const envelope = require('../services/menu/envelope');

const PAIRED_ROOT = path.join(config.paths.root, config.sessionName || 'sessions', 'paired');
const MAX_CACHE = 150;
const SEEN_CACHE = 500;
/**
 * Messages older than this are silently ignored. When the bot (re)connects,
 * WhatsApp replays everything the number received while we were offline —
 * without this guard the bot would answer commands from hours ago.
 */
const STALE_MS = () => (Number(process.env.STALE_COMMAND_SEC) > 0
  ? Number(process.env.STALE_COMMAND_SEC) * 1000
  : 180_000);
/** How long to wait for a delivery ack before probing/falling back. */
const MENU_FALLBACK_MS = () => (Number(process.env.MENU_FALLBACK_MS) > 0
  ? Number(process.env.MENU_FALLBACK_MS)
  : 12000);
const sessions = new Map();
let baileysVersion = null;
let stopping = false;

// One rule for the whole bot (utils/phone.js) — the trunk prefix in
// "+94 (0) 77 …" used to survive here and vanish elsewhere, which is how a
// session ends up stored under a key nobody looks up again.
function normalizePhone(raw) { return phone.normalize(raw); }
function isValidPhone(p) { return phone.isValid(p); }
async function getVersion() {
  if (baileysVersion) return baileysVersion;
  try { baileysVersion = (await fetchLatestBaileysVersion()).version; }
  catch { baileysVersion = [2, 3000, 1033899548]; }
  return baileysVersion;
}
/**
 * The config a session routes with.
 *
 * Every session carries its own identity (name / logo / header / footer) and
 * whether it is the MAIN number — the router hides session management and the
 * bot-wide settings from everybody else, and the menu a paired number sees is
 * rendered with THAT number's branding. A paired session's "owner" is the
 * person who linked it, so they can customise their own bot but never
 * anybody else's.
 */
function sessionConfigFor(session, baseConfig = config) {
  const isPrimary = !!(session && session.isPrimary);
  const brandKey = isPrimary ? 'primary' : String((session && (session.phone || session.id)) || 'primary');
  return {
    ...baseConfig,
    owner: isPrimary ? baseConfig.owner : ((session && session.jid) || baseConfig.owner),
    sessionIsPrimary: isPrimary,
    sessionId: (session && session.id) || (isPrimary ? 'primary' : brandKey),
    brandKey,
    brand: branding.forKey(brandKey),
  };
}

function sessionDir(id) {
  if (id === 'primary') return config.paths.session;
  return path.join(PAIRED_ROOT, id);
}
function isRegistered(dir) {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8'));
    return !!creds?.registered;
  } catch { return false; }
}
function listPairedDirs() {
  try {
    if (!fs.existsSync(PAIRED_ROOT)) return [];
    return fs.readdirSync(PAIRED_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidPhone(d.name))
      .map((d) => d.name);
  } catch { return []; }
}
function remember(session, msg) {
  if (!msg?.key?.id) return;
  session.messageCache.set(msg.key.id, msg);
  while (session.messageCache.size > MAX_CACHE) {
    session.messageCache.delete(session.messageCache.keys().next().value);
  }
}
/**
 * Message ids already handled — PROCESS-WIDE, not per session.
 *
 * `seenIds` lives on the session object, and a reconnect builds a NEW session
 * object, so the old cache was thrown away exactly when WhatsApp replays the
 * backlog. One map for the whole process means a replayed id is recognised
 * even when the socket under it has been replaced.
 */
const handledIds = new Map();
function rememberSeen(session, id) {
  if (!id) return;
  session.seenIds.add(id);
  while (session.seenIds.size > SEEN_CACHE) {
    session.seenIds.delete(session.seenIds.values().next().value);
  }
  handledIds.set(id, Date.now());
  while (handledIds.size > SEEN_CACHE * 4) {
    handledIds.delete(handledIds.keys().next().value);
  }
}
function alreadyHandled(id) { return !!id && handledIds.has(id); }

/**
 * Should this inbound message reach the router? A pure decision so the rule can
 * be tested without WhatsApp, and one place to reason about it:
 *
 *   status    → the status handler (never a command)
 *   own       → something this session sent itself
 *   duplicate → the same message id seen before (multi-device re-sync,
 *               reconnect replay, history sync)
 *   backlog   → stamped BEFORE this socket finished connecting: WhatsApp is
 *               replaying what arrived while the number was offline. Answering
 *               these is the "bot replies to old commands" bug — it is worst
 *               when the *phone* was offline (background data off) and comes
 *               online hours later, because then the backlog arrives long after
 *               the bot connected and the old 60-second window had expired.
 *   stale     → simply too old to be a live command (STALE_COMMAND_SEC)
 *   handle    → a real, recent message
 *
 * Backlog and stale are deliberately unconditional. The previous version armed
 * the guard only for the first minute after connect, which answered any replay
 * that arrived later.
 */
function inboundDecision(msg, session, now = Date.now()) {
  const jid = msg?.key?.remoteJid;
  if (!msg?.message || !msg.key?.id) return { action: 'ignore' };
  if (session?.sentIds?.has(msg.key.id)) return { action: 'own' };
  if (alreadyHandled(msg.key.id) || session?.seenIds?.has(msg.key.id)) return { action: 'duplicate' };

  // A status is still a message: reacting to (or downloading) a status that
  // WhatsApp replayed from a day ago is the same bug wearing a different hat.
  const age = messageAgeMs(msg, now);
  const stampedAt = now - age;
  const connectedAt = Number(session?.connectedAt) || 0;
  // A backlog message is one that existed before we opened this socket. The
  // grace absorbs clock skew between the sender's phone and this server.
  if (connectedAt && stampedAt < connectedAt - SYNC_GRACE_MS()) {
    return { action: 'backlog', age };
  }
  if (age > STALE_MS()) return { action: 'stale', age };
  if (jid === 'status@broadcast') return { action: 'status', age };
  return { action: 'handle', age };
}

/** Clock-skew allowance when deciding whether a message predates the socket. */
const SYNC_GRACE_MS = () => (Number(process.env.SYNC_GRACE_MS) >= 0
  ? Number(process.env.SYNC_GRACE_MS)
  : 10_000);
// Delivery receipt tracking shared by interactive menus and tracked image
// menus: resolves 'delivered' | 'error' | 'timeout' via messages.update.
function attachDelivery(session, id, timeoutMs) {
  const waiter = { resolve: null };
  const delivery = new Promise((res) => {
    waiter.resolve = res;
    session.ackWaiters.set(id, waiter);
    const t = setTimeout(() => {
      if (session.ackWaiters.delete(id)) res('timeout');
    }, timeoutMs || MENU_FALLBACK_MS());
    t.unref?.();
  });
  return delivery;
}

/** Interactive cards get a shorter window than the image/text menu. */
const ENVELOPE_TIMEOUT_MS = () => Math.max(1500, Number(process.env.MENU_ENVELOPE_TIMEOUT_MS) || 7000);
function createSend(session) {
  return async function send(jid, content, opts) {
    if (!session.sock) throw new Error('WhatsApp socket is not ready');
    // Interactive (native-flow buttons / legacy list) message: 6.7.x
    // sendMessage() cannot build these, so build + relay manually and keep
    // the same bookkeeping. Any failure here must bubble up so callers can
    // use their text fallback.
    if (content && content.__interactive && content.content) {
      try {
        // A menu envelope is a PROBE: it must never block the bot, never
        // eat the rate budget and never raise the ban-risk score when the
        // server rejects this envelope shape.
        // The probe budget is spent? Throw with `.probeBudget` so the router
        // stops the envelope ladder and falls back to the image/text menu
        // instead of hammering WhatsApp with cards nobody will see.
        const gate = await antiban.probeGate(jid, { text: content.typingText || '' }, { sock: session.sock });
        if (gate) throw gate;
        let payload = content.content;
        if (content.media) {
          // The logo rides along as the card's media header. It has to be
          // uploaded to WhatsApp first, so a failure here means "no media
          // card" — the caller falls back to the plain card.
          try {
            const prepared = await prepareWAMessageMedia(content.media, {
              upload: session.sock.waUploadToServer
            });
            payload = envelope.attachMedia(payload, prepared);
          } catch (e) {
            const err = new Error(`media upload failed: ${e.message}`);
            err.mediaFailed = true;
            throw err;
          }
        }
        const built = generateWAMessageFromContent(jid, payload, { userJid: session.sock.user?.id });
        const keyId = built?.key?.id;
        // Register the receipt waiter BEFORE the relay. An ack can land
        // between the relay and the registration — a missed ack turns a
        // delivered card into a false 'timeout', and the menu then sends a
        // duplicate (the exact bug the v1.1.0 fix was meant to kill).
        const delivery = keyId ? attachDelivery(session, keyId, ENVELOPE_TIMEOUT_MS()) : null;
        // The binary wrapper nodes (biz → interactive → native_flow, plus
        // bot in DMs) are what makes the client render the card at all.
        await session.sock.relayMessage(jid, built.message, {
          messageId: keyId,
          additionalNodes: Array.isArray(content.nodes) ? content.nodes : undefined
        });
        if (keyId) {
          session.sentIds.add(keyId);
          while (session.sentIds.size > 300) session.sentIds.delete(session.sentIds.values().next().value);
          remember(session, built);
          // Delivery tracking: callers (menus) await built.delivery —
          // 'delivered' | 'error' | 'timeout' — and can fall back.
          if (delivery) built.delivery = delivery;
        }
        antiban.afterOutbound(jid, true, null, { probe: true });
        return built;
      } catch (e) {
        try { antiban.afterOutbound(jid, false, e, { probe: true }); } catch {}
        log.error(`[menu] interactive send failed (falling back to text): ${e.message}`);
        throw e;
      }
    }
    const isEdit = !!(opts && opts.edit) || !!(content && content.edit);
    try {
      await antiban.beforeOutbound(jid, content, {
        isEdit,
        skipPresence: isEdit || !!(opts && opts.skipPresence),
        sock: session.sock
      });
      const sent = await session.sock.sendMessage(jid, content, opts);
      if (sent?.key?.id) {
        session.sentIds.add(sent.key.id);
        while (session.sentIds.size > 300) session.sentIds.delete(session.sentIds.values().next().value);
        remember(session, sent);
        // Optional delivery receipt tracking (menu image fallback uses it).
        if (!isEdit && opts?.trackDelivery) sent.delivery = attachDelivery(session, sent.key.id);
      }
      if (!isEdit) antiban.afterOutbound(jid, true);
      return sent;
    } catch (e) {
      if (!isEdit) antiban.afterOutbound(jid, false, e);
      throw e;
    }
  };
}
async function buildSocket(sessionPath, messageCache) {
  ensureDir(sessionPath);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const version = await getVersion();
  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    // Full history sync also pulls recent STATUSES, which is what makes the
    // status saver work right after a restart. It costs a heavier boot, so
    // it is opt-in: SYNC_FULL_HISTORY=true.
    syncFullHistory: process.env.SYNC_FULL_HISTORY === 'true',
    markOnlineOnConnect: false,
    shouldIgnoreJid: (j) => j?.endsWith('@newsletter'),
    getMessage: async (key) => messageCache.get(key?.id)?.message,
  });
  sock.ev.on('creds.update', saveCreds);
  return { sock, state };
}
function attachHandlers(session) {
  const { sock } = session;
  const send = session.send;
  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect } = u;
    // A QR means the socket finished its handshake and is in PAIRING mode —
    // only now is `requestPairingCode` meaningful. Asking earlier produces a
    // code WhatsApp has never heard of ("invalid code" on the phone).
    if (u.qr) session.qrSeen = Date.now();
    if (connection === 'open') {
      session.connected = true;
      session.connectedAt = Date.now();
      session.state = 'open';
      session.jid = normalizeJid(sock.user?.id);
      session.name = sock.user?.name || null;
      if (!session.phone || session.phone === session.id) {
        session.phone = String(session.jid || '').split('@')[0];
      }
      if (session.isPrimary) {
        statusManager.setSocket(sock);
        // Auto-forwarded statuses must go through the antiban-wrapped send
        // (typing indicator + rate limiter), not the raw socket.
        statusManager.setSender(send);
        antiban.setSocket(sock);
        antiban.noteConnected();
        config.owner = session.jid;
      }
      // NOTE: a paired session must NOT call `antiban.setSocket(sock)`. That
      // slot is the FALLBACK socket used when a caller does not pass one, and
      // overwriting it with the newest session sent typing indicators and
      // presence out through the WRONG account. Every paired-session code path
      // passes its own `session.sock` explicitly (createSend, the router's
      // onInbound/finishInbound, the status handler), so nothing is lost.
      log.success(`[${session.isPrimary ? 'primary' : session.phone}] Connected as ${session.name || 'user'} (${session.jid})`);
      if (session.isPrimary) {
        const ab = antiban.status();
        log.info(`Anti-ban: ${ab.enabled ? 'ON' : 'OFF'} · preset=${ab.preset} · risk=${ab.health.level}`);
        try {
          const botName = require('../services/settings').name();
          await send(config.owner, {
            text: `✅ *${botName} is online*\n\nUse ${config.prefix}menu to open the menu.\n🛡️ Anti-ban: ${ab.enabled ? ab.preset : 'off'}`,
          });
        } catch {}
      } else if (session.notifyJid && session.notifySend) {
        try {
          await session.notifySend(session.notifyJid, {
            text: `✅ *Paired session online*\n\n📱 +${session.phone}\n👤 ${session.name || 'WhatsApp user'}\nThis number can now use the bot independently.`,
          });
        } catch {}
        session.notifyJid = null;
        session.notifySend = null;
      }
    }
    if (connection === 'close') {
      session.connected = false;
      session.state = 'close';
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (stopping) return;
      if (session.isPrimary) antiban.noteDisconnect(code);
      if (code === DisconnectReason.loggedOut) {
        log.warn(`[${session.id}] Logged out.`);
        sessions.delete(session.id);
        if (session.isPrimary) {
          try { fs.rmSync(sessionDir('primary'), { recursive: true, force: true }); } catch {}
          log.error('Primary session was logged out by WhatsApp. Restart the bot — a fresh pairing code will be shown; link the number again.');
          process.exit(0);
        }
        return;
      }
      if (code === DisconnectReason.connectionReplaced) {
        log.warn(`[${session.id}] Connection replaced.`);
        if (session.isPrimary) {
          log.error('This session was taken over by another running bot instance with the same number. Stop the OTHER bot process, then start this one again.');
          process.exit(0);
        }
        sessions.delete(session.id);
        return;
      }
      // A session that never finished linking is a PENDING PAIRING attempt.
      // WhatsApp closes those sockets on a timer (~a minute), and rebuilding
      // the socket the way a linked session is rebuilt silently invalidates
      // the code that is sitting on somebody's screen — the number could then
      // never link, which is exactly "I got a code but it does not work".
      // Pending attempts are re-opened AND handed a fresh code, and the code
      // is published so the website/chat shows the new one by itself.
      const plan = pendingCloseAction(session, code);
      if (plan.action === 'drop') {
        log.warn(`[${session.id}] Pairing attempt expired after ${plan.rotations - 1} code rotations — tearing down.`);
        try { teardownPending(session.phone || session.id); } catch {}
        return;
      }
      if (plan.action === 'reopen') {
        session.state = 're-pairing';
        const rotations = plan.rotations;
        log.info(`[${session.id}] Pairing socket closed (${code || 'unknown'}) — reopening and rotating the code (${rotations}/${PENDING_MAX_ROTATIONS()})…`);
        const carry = { notifyJid: session.notifyJid, notifySend: session.notifySend, rotations };
        session.restartTimer = setTimeout(() => {
          session.restartTimer = null;
          if (stopping) return;
          reopenPendingSession(session.phone || session.id, carry)
            .catch((e) => log.warn(`[${session.id}] Could not reopen the pairing socket: ${e.message}`));
        }, 1200);
        session.restartTimer.unref?.();
        return;
      }
      log.warn(`[${session.id}] Closed (${code || 'unknown'}). Reconnecting in 5s...`);
      session.restartTimer = setTimeout(() => {
        session.restartTimer = null;
        if (stopping) return;
        startSession(session.id, { phone: session.phone, isPrimary: session.isPrimary })
          .catch((e) => log.error(`[${session.id}] Reconnect: ${e.message}`));
      }, 5000);
      session.restartTimer.unref?.();
    }
  });
  // Delivery receipts for our interactive (button) messages.
  sock.ev.on('messages.update', (updates) => {
    for (const up of updates || []) {
      const id = up?.key?.id;
      const waiter = id && session.ackWaiters.get(id);
      if (!waiter) continue;
      const st = up.update?.status;
      if (typeof st !== 'number') continue;
      if (st >= 5) { session.ackWaiters.delete(id); waiter.resolve('error'); }
      else if (st >= 2) { session.ackWaiters.delete(id); waiter.resolve('delivered'); }
      // status 1 = server accepted; keep waiting for a real delivery ack
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = live traffic. 'append' = history/offline sync, which is
    // exactly the replay that must never be answered.
    if (type !== 'notify') {
      if (type === 'append' && Array.isArray(messages) && messages.length) {
        session.skipped = session.skipped || { backlog: 0, stale: 0, duplicate: 0 };
        session.skipped.backlog += messages.length;
        log.info(`[${session.id}] Ignoring ${messages.length} message(s) from WhatsApp history sync (type=append)`);
      }
      return;
    }
    for (const msg of messages) {
      if (!msg?.message) continue;
      remember(session, msg);
      const decision = inboundDecision(msg, session);
      if (decision.action === 'ignore') continue;
      if (decision.action === 'own') {
        session.sentIds.delete(msg.key.id);
        continue;
      }
      if (decision.action === 'duplicate' || decision.action === 'backlog' || decision.action === 'stale') {
        // Counted, not silent: `.health` and the logs can show that the bot
        // deliberately ignored a replay instead of looking dead.
        session.skipped = session.skipped || { backlog: 0, stale: 0, duplicate: 0 };
        session.skipped[decision.action]++;
        const secs = decision.age ? Math.round(decision.age / 1000) : 0;
        if (decision.action === 'backlog') {
          log.info(`[${session.id}] Ignoring ${secs}s-old message replayed by WhatsApp (backlog, not a live command) from ${msg.key?.remoteJid}`);
        } else if (decision.action === 'stale') {
          log.info(`[${session.id}] Ignoring stale message (${secs}s old) from ${msg.key?.remoteJid}`);
        }
        continue;
      }
      if (decision.action === 'status') {
        try {
          statusManager.setSocket(session.sock);
          await statusManager.handleStatus(msg, session.sock);
        } catch (e) {
          log.warn(`Status handler: ${e.message}`);
        }
        continue;
      }
      // De-dupe redelivered incoming messages (multi-device re-syncs and
      // history syncs replay ids — without this the bot would reply twice).
      rememberSeen(session, msg.key.id);
      try {
        const sessionConfig = sessionConfigFor(session, config);
        try {
          await router.handle(sock, msg, sessionConfig, send);
        } finally {
          // The router raises "typing…" when a command starts. If it ended up
          // answering nothing (mode gate, error, confirmation card skipped),
          // take the indicator back down — the bot must not look like it is
          // typing and then stay silent.
          antiban.finishInbound(msg.key.remoteJid, { sock: session.sock });
        }
      } catch (e) {
        log.error(`[${session.id}] Message handler: ${e.message}`);
      }
    }
  });
}
async function startSession(id, { phone = '', isPrimary = false } = {}) {
  if (sessions.has(id)) {
    const existing = sessions.get(id);
    if (existing.restartTimer) { clearTimeout(existing.restartTimer); existing.restartTimer = null; }
    try { existing.sock?.end?.(undefined); } catch {}
    sessions.delete(id);
  }
  const dir = sessionDir(id);
  const messageCache = new Map();
  const { sock, state } = await buildSocket(dir, messageCache);
  const session = {
    id,
    phone: normalizePhone(phone) || (id !== 'primary' ? id : ''),
    isPrimary,
    sock,
    connected: false,
    jid: null,
    name: null,
    sentIds: new Set(),
    seenIds: new Set(),
    ackWaiters: new Map(),
    messageCache,
    startedAt: Date.now(),
    connectedAt: 0,
    state: state.creds?.registered ? 'connecting' : 'pairing',
    notifyJid: null,
    notifySend: null,
    qrSeen: 0,
    skipped: { backlog: 0, stale: 0, duplicate: 0 },
    currentCode: null,
    codeIssuedAt: 0,
    rotations: 0,
    restartTimer: null,
  };
  session.send = createSend(session);
  sessions.set(id, session);
  attachHandlers(session);
  return session;
}
// The terminal side of the pairing flow, laid out like the screen it mirrors:
// one card, the number, the code, the four steps. ASCII only, so a panel's
// log viewer cannot break the alignment.
function pairingBanner(codeText, forNumber = '') {
  const raw = String(codeText || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const grouped = raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
  const spaced = raw.length === 8
    ? `${raw.slice(0, 4).split('').join(' ')}  -  ${raw.slice(4).split('').join(' ')}`
    : grouped;
  const W = 47;
  const line = (s = '') => '│ ' + String(s).padEnd(W) + '│';
  const top = '┌' + '─'.repeat(W + 1) + '┐';
  const mid = '├' + '─'.repeat(W + 1) + '┤';
  const bot = '└' + '─'.repeat(W + 1) + '┘';
  const out = ['', top, line('  WHATSAPP  ·  LINK A DEVICE'), mid];
  if (forNumber) out.push(line(`  Number   +${forNumber}`));
  out.push(line(''), line(`  Code     ${grouped}`), line(''), line(`  ${spaced}`), line(''));
  out.push(line('  Valid for about 1 minute'), bot);
  out.push('', '  1. Open WhatsApp on that phone', '  2. Settings  >  Linked devices', '  3. Link a device  >  Link with phone number instead', '  4. Type the code above, exactly as shown');
  out.push('', '  A new code prints by itself when this one expires.',
    '  Never share this code: it links a device to that WhatsApp account.', '');
  console.log(out.join('\n'));
}

// WhatsApp lets us CHOOSE the pairing code (exactly 8 characters). A phone
// keypad only has digits, so the default is 8 digits shown as 1234-5678 —
// nothing to spell, nothing to confuse (no O/0, no I/1, no B/8).
//
// PAIR_FIXED_CODE pins one code (e.g. 11111111) for private testing. It is
// OFF unless set, because a code that never changes is a code somebody else
// can memorise: everyone who can open the pair page could then link a device.
const fixedPairingCode = () => {
  const raw = String(process.env.PAIR_FIXED_CODE || '').replace(/\D/g, '');
  return raw.length === 8 ? raw : '';
};
function generateEasyPairingCode() {
  const fixed = fixedPairingCode();
  if (fixed) return fixed;
  let out = String(crypto.randomInt(1, 10));          // never lead with 0
  for (let i = 1; i < 8; i++) out += String(crypto.randomInt(0, 10));
  return out;
}
async function connectPrimary(getPhoneFn) {
  stopping = false;
  ensureDir(config.paths.session);
  ensureDir(PAIRED_ROOT);
  const session = await startSession('primary', { isPrimary: true, phone: '' });
  const { sock } = session;
  let pairingLock = false;
  sock.ev.on('connection.update', async (u) => {
    const { qr } = u;
    if (!qr || pairingLock) return;
    if (isRegistered(sessionDir('primary'))) return;
    pairingLock = true;
    try {
      const p = normalizePhone(await getPhoneFn());
      if (!isValidPhone(p)) { log.error('Invalid phone number.'); process.exit(1); }
      session.phone = p;
      for (let i = 0; i < 2; i++) {
        try {
          // Attempt 1: our own eight-digit code (1234-5678, or PAIR_FIXED_CODE).
          // Attempt 2 (fallback): WhatsApp's own random code.
          const code = await sock.requestPairingCode(p, i === 0 ? generateEasyPairingCode() : undefined);
          // Display grouping XXXX-XXXX regardless of what the server returns.
          const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          const grouped = clean.length === 8 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : String(code);
          pairingBanner(grouped, p);
          log.success(`PAIRING CODE: ${grouped} (valid ~1 minute)`);
          break;
        } catch (e) {
          if (i === 1) log.error(`Pairing failed: ${e.message}`);
          else await new Promise((r) => setTimeout(r, 3000));
        }
      }
    } catch (e) {
      log.error(`Pairing setup: ${e.message}`);
    } finally {
      // A pairing code only lives as long as its QR tunnel (~1 minute).
      // The old code locked pairing forever after the first QR rotation —
      // the user typed a dead code and the bot never showed a fresh one.
      // Re-request on every QR cycle until the number is linked.
      pairingLock = false;
    }
  });
  for (const phone of listPairedDirs()) {
    if (!isRegistered(sessionDir(phone))) continue;
    try {
      await startSession(phone, { phone, isPrimary: false });
      log.info(`Restoring paired session +${phone}`);
    } catch (e) {
      log.warn(`Could not restore +${phone}: ${e.message}`);
    }
  }
  return session.sock;
}
/**
 * What to do when a socket closes. This is the core of the "I got a code but it
 * does not work" bug, kept as a pure function so it can be asserted directly:
 *
 *   • primary                 → 'reconnect' (normal, persistent session)
 *   • a LINKED paired session → 'reconnect' (creds are on disk)
 *   • a PENDING pairing attempt → 'reopen' — rebuilding it silently would
 *     invalidate the code on the user's screen, so it is re-opened AND given a
 *     fresh code, up to PAIR_MAX_CODE_ROTATIONS times
 *   • past that budget       → 'drop' (stop orbiting WhatsApp with a number
 *     nobody is waiting on)
 */
function pendingCloseAction(session, code) {
  if (session.isPrimary) return { action: 'reconnect' };
  if (isRegistered(sessionDir(session.id))) return { action: 'reconnect' };
  if (isRegistered(sessionDir(session.phone || session.id))) return { action: 'reconnect' };
  const rotations = (session.rotations || 0) + 1;
  if (rotations > PENDING_MAX_ROTATIONS()) return { action: 'drop', rotations };
  return { action: 'reopen', rotations };
}

/** How many times a pending attempt may re-open and rotate its code. */
function PENDING_MAX_ROTATIONS() {
  // Matches the pairing layer's own budget: one number, one ceiling, so an
  // attempt cannot rotate codes twice as often as either layer intended.
  const n = Number(process.env.PAIR_MAX_CODE_ROTATIONS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20;
}

/**
 * Wait until a socket is actually in PAIRING mode (WhatsApp sent us a QR, or
 * the socket is already registered). Requesting a code before that produces a
 * code the server has never issued — the phone says "invalid code".
 */
async function waitForPairingReady(session, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (session.qrSeen) return true;
    if (session.sock?.user?.id) return true;         // already registered
    if (session.state === 'open') return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/** Publish a rotated code so the website / chat shows the new one by itself. */
const codeListeners = [];
function onPairingCode(fn) { if (typeof fn === 'function') codeListeners.push(fn); }
function emitPairingCode(phone, code, extra = {}) {
  for (const fn of codeListeners) {
    try { fn({ phone, code, ...extra }); } catch (e) { log.warn(`[pair] code listener failed: ${e.message}`); }
  }
}

/**
 * Re-open a pending pairing attempt on a fresh socket and ask WhatsApp for a
 * NEW code. Keeps the notify target (so the "✅ Paired session online" DM
 * still arrives) and the rotation counter.
 */
async function reopenPendingSession(rawPhone, carry = {}) {
  const phone = normalizePhone(rawPhone);
  if (!isValidPhone(phone)) throw new Error('Invalid number.');
  if (isRegistered(sessionDir(phone))) return null;   // it linked in the meantime
  const session = await startSession(phone, { phone, isPrimary: false });
  session.state = 'pairing';
  session.notifyJid = carry.notifyJid || null;
  session.notifySend = carry.notifySend || null;
  session.rotations = carry.rotations || 0;
  const code = await requestSessionCode(session, phone);
  return code ? { phone, code, rotated: true } : null;
}

/** Ask for a code on a session socket, waiting for pairing mode first. */
async function requestSessionCode(session, phone, { attempts = 3 } = {}) {
  const ready = await waitForPairingReady(session);
  if (!ready) log.warn(`[${session.id}] Socket never reached pairing mode — trying for a code anyway`);
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      // The code is chosen by us. A WhatsApp build that refuses a custom code
      // must not turn into "pairing is broken": fall back to its own random
      // one, which the page groups 4-4 just the same.
      let code;
      try {
        code = await session.sock.requestPairingCode(phone, generateEasyPairingCode());
      } catch (customErr) {
        log.info(`[${session.id}] custom code refused (${customErr?.message || customErr}) — using the server's code`);
        code = await session.sock.requestPairingCode(phone);
      }
      const clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!clean) throw new Error('WhatsApp returned an empty code');
      session.currentCode = clean;
      session.codeIssuedAt = Date.now();
      emitPairingCode(phone, clean, { rotated: (session.rotations || 0) > 0 });
      return clean;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr || new Error('Could not generate a pairing code.');
}

/** The code a pending session is currently showing (for the website's poll). */
function currentPairingCode(rawPhone) {
  const s = sessions.get(normalizePhone(rawPhone));
  return s?.currentCode || null;
}

async function pairNumber(rawPhone, { notifyJid, notifySend } = {}) {
  const phone = normalizePhone(rawPhone);
  if (!isValidPhone(phone)) throw new Error('Invalid number. Use full international digits, e.g. 94771234567');
  // Pairing the PRIMARY number again creates a second linked device of the
  // SAME account: both sessions receive every chat and the bot answers
  // everything TWICE (the "two menus" bug). Refuse it with a clear message.
  if (phone === normalizePhone(config.phoneNumber)) {
    throw new Error('This number is already the primary bot number (WA_PHONE_NUMBER). Pairing it again would duplicate every reply — use a DIFFERENT number.');
  }
  const primary = sessions.get('primary');
  if (primary?.phone && phone === primary.phone) {
    throw new Error('This number is already the primary bot number. Pairing it again would duplicate every reply — use a DIFFERENT number.');
  }
  const existing = sessions.get(phone);
  if (existing?.connected) throw new Error(`+${phone} is already connected.`);
  if (isRegistered(sessionDir(phone))) {
    const session = await startSession(phone, { phone, isPrimary: false });
    session.notifyJid = notifyJid || null;
    session.notifySend = notifySend || null;
    return { phone, code: null, restored: true };
  }
  const dir = sessionDir(phone);
  if (fs.existsSync(dir) && !isRegistered(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  const session = await startSession(phone, { phone, isPrimary: false });
  session.notifyJid = notifyJid || null;
  session.notifySend = notifySend || null;
  session.state = 'pairing';
  session.rotations = 0;
  let code = null;
  let lastErr = null;
  try {
    // Waits for the socket to reach PAIRING mode instead of sleeping a fixed
    // second and hoping — a code requested too early is a code the phone will
    // reject.
    code = await requestSessionCode(session, phone);
  } catch (e) { lastErr = e; }
  if (!code) {
    try { session.sock?.end?.(undefined); } catch {}
    sessions.delete(phone);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw new Error(lastErr?.message || 'Could not generate pairing code.');
  }
  return { phone, code, restored: false };
}
async function unpair(rawPhone) {
  const phone = normalizePhone(rawPhone);
  if (!isValidPhone(phone)) throw new Error('Invalid number.');
  const session = sessions.get(phone);
  if (session) {
    if (session.restartTimer) { clearTimeout(session.restartTimer); session.restartTimer = null; }
    try { session.sock?.end?.(undefined); } catch {}
    sessions.delete(phone);
  }
  const dir = sessionDir(phone);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return phone;
}
/** Has this number finished linking (creds registered or socket open)? */
function isLinked(rawPhone) {
  const phone = normalizePhone(rawPhone);
  const s = sessions.get(phone);
  if (s?.connected || s?.jid) return true;
  return isRegistered(sessionDir(phone));
}

/**
 * Ask WhatsApp for a FRESH code on an existing pending session — the code
 * only lives ~1 minute, so the website and `.pair` both need a regenerate
 * button instead of a dead code on screen.
 */
async function refreshPairingCode(rawPhone) {
  const phone = normalizePhone(rawPhone);
  const s = sessions.get(phone);
  if (!s?.sock) throw new Error('that pairing session is gone — request a new code');
  if (isLinked(phone)) return null;                 // already linked: no code needed
  try {
    return await requestSessionCode(s, phone, { attempts: 2 });
  } catch (e) {
    throw new Error(e?.message || 'WhatsApp refused to issue a new code');
  }
}

/** Drop a session that never finished linking (pairing TTL expired). */
function teardownPending(rawPhone) {
  const phone = normalizePhone(rawPhone);
  const s = sessions.get(phone);
  if (s && s.connected) return false;                // it linked in the meantime
  if (s) {
    // A reopen timer that survives the teardown resurrects a zombie socket
    // (and keeps rotating codes for a number nobody is waiting on).
    if (s.restartTimer) { clearTimeout(s.restartTimer); s.restartTimer = null; }
    try { s.sock?.end?.(undefined); } catch {}
    sessions.delete(phone);
  }
  const dir = sessionDir(phone);
  try { if (fs.existsSync(dir) && !isRegistered(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  return true;
}

function listSessions() {
  return [...sessions.values()].map((s) => ({
    id: s.id, phone: s.phone, isPrimary: s.isPrimary, connected: s.connected,
    state: s.state, jid: s.jid, name: s.name, startedAt: s.startedAt,
    skipped: s.skipped || { backlog: 0, stale: 0, duplicate: 0 },
  }));
}
function getPrimary() { return sessions.get('primary') || null; }

/**
 * Every OPEN session, primary first — used by commands that must act on the
 * whole fleet at once (`.sub`, broadcasts). A session that is still pairing has
 * no usable socket yet, so it is left out rather than failing the batch.
 */
function connectedSessions() {
  const out = [];
  const primary = sessions.get('primary');
  if (primary?.sock && primary.connected) out.push(primary);
  for (const s of sessions.values()) {
    if (s === primary) continue;
    if (s.sock && s.connected) out.push(s);
  }
  return out;
}
function status() {
  const primary = getPrimary();
  return {
    connected: !!primary?.connected,
    number: primary?.jid || config.owner || null,
    name: primary?.name || null,
    sessions: listSessions(),
  };
}
async function stopAll() {
  stopping = true;
  antiban.stop();
  for (const s of sessions.values()) {
    try { s.sock?.end?.(undefined); } catch {}
  }
  sessions.clear();
}
module.exports = {
  connectPrimary, pairNumber, unpair, listSessions, listPairedDirs,
  getPrimary, status, stopAll, normalizePhone, isValidPhone, PAIRED_ROOT,
  attachHandlers, createSend,
  // pairing orchestration (services/pairing.js + the pair website)
  isLinked, isRegistered, refreshPairingCode, teardownPending, sessionDir,
  connectedSessions,
  sessionConfigFor, generateEasyPairingCode, pairingBanner,
  // pairing lifecycle (services/pairing.js subscribes to code rotations)
  onPairingCode, emitPairingCode, currentPairingCode, reopenPendingSession,
  waitForPairingReady, requestSessionCode, pendingCloseAction, attachHandlers,
  inboundDecision, alreadyHandled, handledIds, rememberSeen, SYNC_GRACE_MS,
  PENDING_MAX_ROTATIONS,
};
