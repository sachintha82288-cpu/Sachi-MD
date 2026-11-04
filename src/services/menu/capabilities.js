/**
 * Per-chat menu capability memory.
 *
 * Every chat is different:
 *   • some phones ack every message, some never ack anything
 *   • some render native-flow cards, some only render the legacy list
 *   • some need the viewOnce wrapper, some need the bare shape
 *
 * Instead of paying the full fallback timeout on every menu, the menu
 * remembers what worked for this chat and tries that first. Persisted to
 * data/menu-capabilities.json (atomic write, pruned).
 */
const path = require('path');
const config = require('../../config');
const { atomicJsonWrite, safeJsonRead } = require('../../utils/files');

const FILE = path.join(config.paths.data, 'menu-capabilities.json');
const MAX_ENTRIES = 800;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

const memory = safeJsonRead(FILE, {});
const dirty = { value: false };

function prune(now = Date.now()) {
  for (const [jid, rec] of Object.entries(memory)) {
    if (!rec || !rec.at || now - rec.at > TTL_MS) delete memory[jid];
  }
  const keys = Object.keys(memory);
  if (keys.length > MAX_ENTRIES) {
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete memory[key];
  }
}

function persist() {
  try {
    atomicJsonWrite(FILE, memory);
    dirty.value = false;
  } catch { /* disk hiccup — memory still works for this process */ }
}

function get(jid) {
  const rec = memory[String(jid || '')];
  if (!rec) return null;
  if (Date.now() - (rec.at || 0) > TTL_MS) {
    delete memory[String(jid)];
    dirty.value = true;
    return null;
  }
  return rec;
}

/** Envelope that worked for this chat last time (null when unknown). */
function preferredEnvelope(jid) {
  const rec = get(jid);
  return rec && rec.envelope ? rec.envelope : null;
}

/** False when this chat never acknowledges anything (renders but no acks). */
function receiptsAlive(jid) {
  const rec = get(jid);
  if (!rec || rec.receipts === undefined) return null; // unknown
  return !!rec.receipts;
}

function remember(jid, patch) {
  const key = String(jid || '');
  if (!key) return null;
  const next = { ...(memory[key] || {}), ...patch, at: Date.now() };
  memory[key] = next;
  dirty.value = true;
  prune();
  if (dirty.value) persist();
  return next;
}

/** Envelopes the server rejected for this chat — do not try them again. */
function markFailed(jid, envelope) {
  const rec = get(jid);
  const failed = new Set([...(rec?.failed || []), envelope]);
  while (failed.size > 4) failed.delete(failed.values().next().value);
  return remember(jid, { failed: [...failed] });
}

function failedEnvelopes(jid) {
  const rec = get(jid);
  return rec?.failed || [];
}

function forget(jid) {
  delete memory[String(jid || '')];
  dirty.value = true;
  persist();
}

function flush() { if (dirty.value) persist(); }

function reset() {
  for (const key of Object.keys(memory)) delete memory[key];
  dirty.value = true;
  persist();
}

module.exports = {
  get, remember, forget, preferredEnvelope, receiptsAlive, flush, prune, reset,
  markFailed, failedEnvelopes, FILE
};
