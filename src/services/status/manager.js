/**
 * Status centre.
 *
 * Every status WhatsApp delivers to a linked session is kept in RAM
 * (data never touches the disk) so `.status <number>` can hand it back.
 * On top of the cache this module owns the three automations:
 *
 *   autoSeen    → mark every status as viewed
 *   autoReact   → react with the owner's emoji (a LIST — one is picked at random)
 *   autoForward → re-send every new status to the owner's chat
 *
 * Nothing here is restricted to one number: the cache holds every user
 * whose status reached the bot, and `.status all` walks the whole cache.
 */
const path = require('path');
const config = require('../../config');
const { unwrapMessage, normalizeJid } = require('../../utils/messages');
const { atomicJsonWrite, safeJsonRead } = require('../../utils/files');
const log = require('../../utils/logger');

const file = path.join(config.paths.data, 'status-settings.json');

const num = (key, fallback) => {
  const v = Number(process.env[key]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const MAX_PER_USER = num('STATUS_MAX_PER_USER', 200);
const MAX_USERS = num('STATUS_MAX_USERS', 5000);
const TTL = num('STATUS_TTL_HOURS', 72) * 60 * 60 * 1000;
const MAX_MEDIA_MB = num('STATUS_MAX_MEDIA_MB', 100);
/** How many statuses `.status all` sends by default. */
const DEFAULT_LATEST = num('STATUS_LATEST', 10);
/** How long `.status <number>` waits for a live push when the cache is empty. */
const FRESH_WAIT_MS = Math.max(1000, num('STATUS_FRESH_WAIT_MS', 6000));
/**
 * Safety cap on how many statuses ONE command may blast into a chat.
 * This is an anti-ban guard, not a feature limit — raise it in .env.
 */
const SEND_MAX = Math.max(1, num('STATUS_SEND_MAX', 100));
/** Keep the cache across restarts (media keys only, no media bytes). */
const PERSIST = process.env.STATUS_PERSIST !== 'false';
const PERSIST_MAX = Math.max(10, num('STATUS_PERSIST_MAX', 300));
const PERSIST_FILE = path.join(config.paths.data, 'status-cache.json');
const PERSIST_DEBOUNCE_MS = Math.max(500, num('STATUS_PERSIST_DEBOUNCE_MS', 2000));

const DEFAULT_SETTINGS = {
  autoSeen: false,
  autoReact: false,
  reaction: '❤️',
  reactions: ['❤️'],
  autoForward: false,
  forwardTo: '',
};

const cache = new Map();
const sockets = new Set();
let sender = null;               // antiban-wrapped send() from sessionManager
let downloader = null;           // optional custom media downloader
let settings = { ...DEFAULT_SETTINGS, ...safeJsonRead(file, {}) };
if (!Array.isArray(settings.reactions) || !settings.reactions.length) {
  settings.reactions = [settings.reaction || DEFAULT_SETTINGS.reaction];
}

function persist() { atomicJsonWrite(file, settings); }

// Restored lazily at the end of the module — see loadPersisted() below.

/* ── emoji handling ─────────────────────────────────────────────────── */

let segmenter = null;
try { segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' }); } catch { /* older node */ }

/** Split into user-perceived characters (ZWJ families, flags, skin tones). */
function graphemes(str) {
  const s = String(str || '');
  if (segmenter) return [...segmenter.segment(s)].map((x) => x.segment);
  return [...s];
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const FLAG = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u;
const KEYCAP = /^[#*0-9]\uFE0F?\u20E3$/u;

/** One emoji? (a single grapheme that WhatsApp accepts as a reaction) */
function isEmoji(str) {
  const g = graphemes(String(str || '').trim());
  if (g.length !== 1) return false;
  const one = g[0];
  return PICTOGRAPHIC.test(one) || FLAG.test(one) || KEYCAP.test(one);
}

/**
 * Parse "🔥, 😍 💯" (or an array) into a clean list of single emojis.
 * Invalid entries are dropped, never truncated mid-character.
 */
function parseReactions(input) {
  const parts = Array.isArray(input)
    ? input.map((x) => String(x).trim())
    : String(input || '').split(/[\s,]+/).map((x) => x.trim());
  const out = [];
  for (const p of parts) {
    if (!p) continue;
    if (isEmoji(p) && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 20);
}

function normalizeNumber(raw) {
  return String(raw || '').replace(/[^\d]/g, '').replace(/^00/, '');
}
function jidToNumber(jid) { return normalizeNumber(String(jid || '').split('@')[0].split(':')[0]); }
function toJid(raw) {
  const n = normalizeNumber(raw);
  return n ? `${n}@s.whatsapp.net` : '';
}

/* ── cache ──────────────────────────────────────────────────────────── */

function prune() {
  const now = Date.now();
  for (const [number, list] of cache) {
    const fresh = list.filter((x) => now - x.receivedAt <= TTL);
    if (fresh.length) cache.set(number, fresh); else cache.delete(number);
  }
  while (cache.size > MAX_USERS) cache.delete(cache.keys().next().value);
}

function setSocket(value) {
  if (!value) return;
  sockets.add(value);
  for (const s of [...sockets]) {
    if (s === value) continue;
    if (s?.ws?.readyState === 3 || s?.ws?.readyState === 2) sockets.delete(s);
  }
}

/** The antiban-aware send() of the primary session (used by auto-forward). */
function setSender(fn) { sender = typeof fn === 'function' ? fn : null; }

function liveSocket() {
  for (const s of [...sockets]) {
    const ready = s?.ws?.readyState;
    if (ready === undefined || ready === 1) return s;
  }
  return [...sockets][0] || null;
}

function getSettings() {
  return {
    autoSeen: !!settings.autoSeen,
    autoReact: !!settings.autoReact,
    reaction: settings.reactions[0] || DEFAULT_SETTINGS.reaction,
    reactions: [...settings.reactions],
    autoForward: !!settings.autoForward,
    forwardTo: settings.forwardTo || '',
  };
}

function setAutoSeen(enabled) { settings.autoSeen = !!enabled; persist(); return getSettings(); }

/**
 * Turn auto-react on/off and (optionally) set the emoji list.
 * `reaction` may be a string with several emojis or an array.
 */
function setAutoReact(enabled, reaction) {
  settings.autoReact = !!enabled;
  if (reaction !== undefined && reaction !== null && String(reaction).trim() !== '') {
    const list = parseReactions(reaction);
    if (list.length) {
      settings.reactions = list;
      settings.reaction = list[0];
    }
  }
  persist();
  return getSettings();
}

/** Only change the emoji list (auto-react stays as it was). */
function setReactions(reaction) {
  const list = parseReactions(reaction);
  if (!list.length) return { ok: false, settings: getSettings() };
  settings.reactions = list;
  settings.reaction = list[0];
  persist();
  return { ok: true, settings: getSettings() };
}

/** The emoji used for the next reaction (random when a list is set). */
function pickReaction() {
  const list = settings.reactions.length ? settings.reactions : [DEFAULT_SETTINGS.reaction];
  return list[Math.floor(Math.random() * list.length)];
}

/** Forward every new status to the owner (or a custom number). */
function setAutoForward(enabled, target) {
  settings.autoForward = !!enabled;
  if (target !== undefined) {
    const jid = String(target || '').trim() === '' ? '' : toJid(target);
    settings.forwardTo = jid;
  }
  persist();
  return getSettings();
}

function forwardTarget() {
  if (settings.forwardTo) return settings.forwardTo;
  return config.owner ? normalizeJid(config.owner) : '';
}

/* ── media helpers ──────────────────────────────────────────────────── */

function mediaType(message) {
  const m = unwrapMessage(message);
  if (m.imageMessage) return ['image', m.imageMessage];
  if (m.videoMessage) return ['video', m.videoMessage];
  if (m.audioMessage) return ['audio', m.audioMessage];
  if (m.stickerMessage) return ['sticker', m.stickerMessage];
  if (m.documentMessage) return ['document', m.documentMessage];
  return [null, null];
}

/** Test/proxy seam: replace the Baileys media downloader. */
function setDownloader(fn) { downloader = typeof fn === 'function' ? fn : null; }

async function toBuffer(content, type) {
  const download = downloader || require('@whiskeysockets/baileys').downloadContentFromMessage;
  const stream = await download(content, type);
  const chunks = []; let size = 0;
  const maxBytes = MAX_MEDIA_MB * 1024 * 1024;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`status media is larger than ${MAX_MEDIA_MB} MB`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function textOf(message) {
  const m = unwrapMessage(message);
  return (m.extendedTextMessage?.text || m.conversation || m.imageMessage?.caption
    || m.videoMessage?.caption || m.documentMessage?.caption || '').trim();
}

/* ── incoming statuses ──────────────────────────────────────────────── */

/**
 * Only real status content is worth caching. WhatsApp also pushes
 * reaction notifications and revoke (delete) notices on status@broadcast —
 * caching those polluted the list and made every download report a failure.
 */
function contentOf(message) {
  const m = unwrapMessage(message);
  if (!m || typeof m !== 'object') return null;
  if (m.imageMessage || m.videoMessage || m.audioMessage || m.stickerMessage || m.documentMessage) return m;
  if ((m.conversation || m.extendedTextMessage?.text || '').trim()) return m;
  return null;
}

/** A revoke notice: `{ protocolMessage: { type: 0, key: { id } } }`. */
function revokedId(message) {
  const m = unwrapMessage(message);
  const pm = m?.protocolMessage;
  if (!pm) return null;
  const isRevoke = pm.type === 0 || pm.type === 'REVOKE' || pm.type?.toString?.() === '0';
  return isRevoke ? String(pm.key?.id || '') || null : null;
}

/** Drop a deleted status from the cache. */
function dropById(id) {
  if (!id) return false;
  let dropped = false;
  for (const [number, list] of cache) {
    const kept = list.filter((x) => x.key?.id !== id);
    if (kept.length !== list.length) {
      dropped = true;
      if (kept.length) cache.set(number, kept); else cache.delete(number);
    }
  }
  return dropped;
}

async function handleStatus(msg, sockHint) {
  if (!msg?.key) return;

  // A deleted status disappears from the saver too — nobody wants to be
  // offered a status WhatsApp already revoked.
  const revoked = revokedId(msg.message);
  if (revoked) {
    if (dropById(revoked)) schedulePersist();
    return;
  }
  if (!contentOf(msg.message)) return;   // reactions, protocol noise, empties

  const mine = msg.key.fromMe === true;
  const participant = msg.key.participant || msg.participant || msg.key.remoteJid;
  const number = jidToNumber(participant);
  if (!number) return;
  const entry = {
    key: msg.key,
    message: msg.message,
    receivedAt: Date.now(),
    mine,
  };
  const list = cache.get(number) || [];
  // Redeliveries of the same status id (multi-device syncs) must not be
  // seen-marked, reacted to or forwarded a second time.
  const isNew = !list.some((x) => x.key?.id === msg.key.id);
  if (isNew) {
    list.push(entry);
    while (list.length > MAX_PER_USER) list.shift();
    cache.set(number, list);
    schedulePersist();
  }
  prune();
  const sock = sockHint || liveSocket();
  if (!isNew) return;

  // Never react to / mark as seen the bot owner's own status.
  if (!mine) {
    if (settings.autoSeen && sock) {
      try { await sock.readMessages([msg.key]); } catch {}
    }
    if (settings.autoReact && sock) {
      const emoji = pickReaction();
      try { await sock.sendMessage('status@broadcast', { react: { text: emoji, key: msg.key } }); } catch {}
    }
  }
  // The owner's own status is cached (for `.status me`) but never echoed back.
  if (settings.autoForward && !mine) {
    try { await forwardOne(entry, number); } catch (e) { log.warn(`Status forward failed: ${e.message}`); }
  }
}

/** Re-send one cached status to the forward target (owner chat by default). */
async function forwardOne(entry, number) {
  const jid = forwardTarget();
  if (!jid) return false;
  const label = entry.mine ? '👤 your status' : `👁️ status • +${number}`;
  const out = await buildPayload(entry, number, label);
  if (!out.length) return false;
  for (const content of out) {
    if (sender) await sender(jid, content);
    else {
      const sock = liveSocket();
      if (!sock) return false;
      await sock.sendMessage(jid, content);
    }
  }
  return true;
}

/**
 * Turn a cached status into sendMessage() payloads.
 * Text-only statuses come back as one text message.
 */
async function buildPayload(entry, number, label) {
  const m = unwrapMessage(entry.message);
  const caption = textOf(entry.message);
  const [type, content] = mediaType(entry.message);
  if (type === 'image' || type === 'video') {
    const buffer = await toBuffer(content, type);
    return [{ [type]: buffer, caption: caption || label }];
  }
  if (type === 'audio') {
    const buffer = await toBuffer(content, 'audio');
    return [{ audio: buffer, mimetype: content.mimetype || 'audio/ogg; codecs=opus', ptt: !!content.ptt }];
  }
  if (type === 'sticker') {
    const buffer = await toBuffer(content, 'sticker');
    return [{ sticker: buffer }];
  }
  if (type === 'document') {
    const buffer = await toBuffer(content, 'document');
    return [{
      document: buffer,
      mimetype: content.mimetype || 'application/octet-stream',
      fileName: content.fileName || `status-${number}`,
      caption: caption || label,
    }];
  }
  if (caption) return [{ text: `📝 *Status from +${number}*\n\n${caption}` }];
  void m;
  return [];
}

/* ── lookups ────────────────────────────────────────────────────────── */

function find(number) {
  const n = normalizeNumber(number);
  if (!n) return [];
  prune();
  return [...(cache.get(n) || [])].sort((a, b) => b.receivedAt - a.receivedAt);
}

/** Newest statuses across every cached user. */
function latest(limit = DEFAULT_LATEST) {
  prune();
  const all = [];
  for (const [number, list] of cache) for (const item of list) all.push({ number, item });
  all.sort((a, b) => b.item.receivedAt - a.item.receivedAt);
  return all.slice(0, Math.max(1, Number(limit) || DEFAULT_LATEST));
}

/** Who is in the cache, newest first — used by the `.status` dashboard. */
function topUsers(limit = 8) {
  prune();
  const rows = [];
  for (const [number, list] of cache) {
    const newest = Math.max(...list.map((x) => x.receivedAt));
    rows.push({ number, count: list.length, newest });
  }
  rows.sort((a, b) => b.newest - a.newest);
  return rows.slice(0, Math.max(1, Number(limit) || 8));
}

function clearCache() {
  const n = cache.size;
  cache.clear();
  schedulePersist();
  return n;
}

/* ── persistence (statuses survive a restart) ───────────────────────── */

/**
 * Baileys message objects carry Buffer/Uint8Array media keys. JSON would
 * flatten them into byte dictionaries and the download would fail after a
 * reload, so binary fields are stored base64 and restored as Buffers.
 */
function enc(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(enc);
  if (typeof v.toJSON === 'function') return enc(v.toJSON());   // protobuf Long → string
  const out = {};
  for (const k of Object.keys(v)) out[k] = enc(v[k]);
  return out;
}
function dec(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(dec);
  const keys = Object.keys(v);
  if (keys.length === 1 && typeof v.__b64 === 'string') return Buffer.from(v.__b64, 'base64');
  const out = {};
  for (const k of keys) out[k] = dec(v[k]);
  return out;
}

let persistTimer = null;
/** Debounced save — a burst of statuses writes the file once. */
function schedulePersist() {
  if (!PERSIST) return;
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

/** Write the newest PERSIST_MAX entries (keys + metadata only, never bytes). */
function persistNow() {
  if (!PERSIST) return 0;
  try {
    prune();
    const rows = [];
    for (const [number, list] of cache) for (const item of list) rows.push({ number, item });
    rows.sort((a, b) => b.item.receivedAt - a.item.receivedAt);
    const keep = rows.slice(0, PERSIST_MAX).map((r) => ({
      number: r.number,
      item: { key: enc(r.item.key), message: enc(r.item.message), receivedAt: r.item.receivedAt, mine: !!r.item.mine },
    }));
    atomicJsonWrite(PERSIST_FILE, { v: 1, savedAt: Date.now(), count: keep.length, entries: keep });
    return keep.length;
  } catch (e) {
    log.warn(`Status cache save failed: ${e.message}`);
    return 0;
  }
}

/** Reload after a restart. Anything past the TTL window is dropped. */
function loadPersisted() {
  if (!PERSIST) return 0;
  const data = safeJsonRead(PERSIST_FILE, null);
  if (!data || !Array.isArray(data.entries)) return 0;
  const now = Date.now();
  let loaded = 0;
  for (const row of data.entries) {
    const number = normalizeNumber(row?.number);
    const item = row?.item;
    if (!number || !item?.key?.id || !item.message) continue;
    const receivedAt = Number(item.receivedAt) || 0;
    if (!receivedAt || now - receivedAt > TTL) continue;
    const message = dec(item.message);
    if (!contentOf(message)) continue;
    const key = dec(item.key);
    const list = cache.get(number) || [];
    if (list.some((x) => x.key?.id === key.id)) continue;
    while (list.length >= MAX_PER_USER) list.shift();
    list.push({ key, message, receivedAt, mine: !!item.mine });
    cache.set(number, list);
    loaded++;
  }
  prune();
  if (loaded) log.info(`Status cache: ${loaded} status(es) restored from disk`);
  return loaded;
}

/**
 * Ask WhatsApp for this contact's fresh statuses: subscribing to their
 * presence usually makes the server push what they posted recently.
 * Resolves with the number of cached statuses once something arrives
 * (or after `waitMs`).
 */
async function requestFresh(sock, number, waitMs = FRESH_WAIT_MS) {
  const jid = toJid(number);
  const before = find(number).length;
  if (!sock || !jid) return before;
  // Being "available" + subscribed is what makes WhatsApp push a contact's
  // recent statuses to a linked device.
  try { await sock.sendPresenceUpdate('available', jid); } catch {}
  try { await sock.presenceSubscribe(jid); } catch {}
  const deadline = Date.now() + Math.max(500, waitMs);
  while (Date.now() < deadline) {
    const now = find(number).length;
    if (now > before) return now;
    await new Promise((r) => setTimeout(r, 250));
  }
  return find(number).length;
}

/* ── sending ────────────────────────────────────────────────────────── */

/**
 * Send cached statuses to the caller. One bad item never kills the batch —
 * it is counted and reported at the end.
 */
async function sendItems(ctx, items, { label = '', progress = true, skipped = 0 } = {}) {
  const total = items.length;
  let count = 0; let failed = 0;
  let note = null;
  if (progress && total > 1) {
    try { note = await ctx.reply({ text: `📤 Sending *${total}* status${total === 1 ? '' : 'es'}${label}…` }); } catch {}
  }
  const errors = [];
  for (const { number, item } of items) {
    try {
      const payloads = await buildPayload(item, number, `👁️ Status • +${number}`);
      if (!payloads.length) { failed++; continue; }
      for (const content of payloads) {
        await ctx.send(ctx.jid, content, { quoted: ctx.msg });
        count++;
      }
    } catch (e) {
      failed++;
      errors.push(String(e?.message || e).replace(/\s+/g, ' ').slice(0, 90));
      log.warn(`Status send failed (+${number}): ${e.message}`);
    }
  }
  const summary = { count, failed, total, skipped, errors: [...new Set(errors)].slice(0, 3) };
  const capNote = skipped ? `\n🔒 ${skipped} older one(s) kept back — the safety cap is ${SEND_MAX} per command (\`STATUS_SEND_MAX\`). Ask for a smaller number to page through them.` : '';
  const text = count
    ? `✅ Sent *${count}* status${count === 1 ? '' : 'es'}${label}.${failed ? `\n⚠️ ${failed} could not be sent${summary.errors.length ? ` (${summary.errors[0]})` : ''}.` : ''}${capNote}`
    : `ℹ️ Nothing could be sent${label}.${failed ? `\n${summary.errors[0] || 'The media is no longer available on WhatsApp.'}` : ''}${capNote}`;
  if (note?.key && ctx.edit) {
    try { await ctx.edit(note.key, { text }); return summary; } catch {}
  }
  await ctx.reply({ text });
  return summary;
}

/** Clamp a requested count to the anti-ban cap. Returns [items, skipped]. */
function clamp(list, limit) {
  const wanted = Number(limit) > 0 ? Number(limit) : list.length;
  const cap = Math.min(wanted, SEND_MAX);
  return [list.slice(0, cap), Math.max(0, list.length - cap)];
}

async function sendAll(ctx, number, limit) {
  const all = find(number).map((item) => ({ number: normalizeNumber(number), item }));
  if (!all.length) return { count: 0, failed: 0, total: 0, skipped: 0, errors: [] };
  const [list, skipped] = clamp(all, limit);
  return sendItems(ctx, list, { label: ` from +${normalizeNumber(number)}`, skipped });
}

async function sendLatest(ctx, limit) {
  const all = latest(Number(limit) > 0 ? Number(limit) : DEFAULT_LATEST);
  if (!all.length) return { count: 0, failed: 0, total: 0, skipped: 0, errors: [] };
  const [list, skipped] = clamp(all, limit);
  return sendItems(ctx, list, { label: '', skipped });
}

/** Save a status the user quoted/forwarded — works even with an empty cache. */
async function sendQuoted(ctx, quotedMessage) {
  if (!quotedMessage) return { count: 0, failed: 0, total: 0, errors: ['No quoted status message.'] };
  const number = jidToNumber(quotedMessage.key?.participant || quotedMessage.key?.remoteJid || ctx.sender || '');
  if (!contentOf(quotedMessage)) {
    // Never end in silence — say why nothing was sent.
    const reason = 'That message has no status content to save (no media and no text).';
    try { await ctx.reply({ text: `ℹ️ ${reason}\n\nQuote a status (photo, video, audio, sticker or text) and send \`${ctx.prefix || '.'}status save\` again.` }); } catch {}
    return { count: 0, failed: 1, total: 1, skipped: 0, errors: [reason] };
  }
  return sendItems(ctx, [{
    number: number || 'unknown',
    item: { key: quotedMessage.key || {}, message: quotedMessage, receivedAt: Date.now() },
  }], { label: ' (quoted)', progress: false });
}

function status() {
  prune();
  return {
    users: cache.size,
    statuses: [...cache.values()].reduce((n, x) => n + x.length, 0),
    ttlHours: TTL / 3600000,
    maxPerUser: MAX_PER_USER,
    maxUsers: MAX_USERS,
    maxMediaMB: MAX_MEDIA_MB,
    defaultLatest: DEFAULT_LATEST,
    freshWaitMs: FRESH_WAIT_MS,
    sendMax: SEND_MAX,
    persist: PERSIST,
    persistMax: PERSIST_MAX,
    sockets: sockets.size,
    ...getSettings(),
  };
}

module.exports = {
  setSocket, setSender, setDownloader, getSettings, setAutoSeen, setAutoReact, setReactions, setAutoForward,
  pickReaction, parseReactions, isEmoji, graphemes, handleStatus, buildPayload,
  sendAll, sendLatest, sendQuoted, sendItems, requestFresh,
  normalizeNumber, toJid, jidToNumber, status, find, latest, topUsers, clearCache,
  contentOf, revokedId, dropById, persistNow, loadPersisted,
  DEFAULT_LATEST, MAX_PER_USER, SEND_MAX, PERSIST,
};

/* Boot: bring back whatever was cached before the restart. */
loadPersisted();
