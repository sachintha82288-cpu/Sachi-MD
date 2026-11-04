const readline = require('readline');
const config = require('../config');
const log = require('../utils/logger');
const sessionManager = require('./sessionManager');
const mainNumber = require('../utils/mainNumber');

// The stdin readline interface is created LAZILY: opening it eagerly (old
// behaviour) held process.stdin open forever — even when the phone number
// was configured — which also keeps spawned test/process children alive.
let rl = null;
function getRl() {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}
const ask = (q) => new Promise((r) => getRl().question(q, r));
function phone(raw) { return sessionManager.normalizePhone(raw); }
async function getPhone() {
  // The number is asked ONCE at startup (see utils/mainNumber.js) and
  // cached — the pairing code is re-requested every minute while the phone
  // is not linked, and the user must not be asked again each time.
  const resolved = mainNumber.current();
  if (resolved) return phone(resolved);
  if (config.phoneNumber) return phone(config.phoneNumber);
  // Non-interactive hosting (Pterodactyl panels, docker, CI): stdin never
  // answers the prompt, so the bot used to hang silently at this prompt
  // forever and NEVER connect. Fail fast with an actionable message instead.
  if (!process.stdin.isTTY) {
    log.error('WA_PHONE_NUMBER is not set and there is no interactive terminal to ask for it.');
    log.error('Fix: add WA_PHONE_NUMBER=9476xxxxxxx to .env (international format, no +) and restart.');
    process.exit(1);
  }
  return phone(await ask('📱 WhatsApp phone number (country code + number): '));
}
async function connect() {
  // Terminal setup: the main number can be typed straight into the console.
  await mainNumber.resolve();
  return sessionManager.connectPrimary(getPhone);
}
async function stop() {
  await sessionManager.stopAll();
  try { rl?.close(); } catch {}
}
async function send(jid, content, opts) {
  const primary = sessionManager.getPrimary();
  if (!primary?.send) throw new Error('WhatsApp socket is not ready');
  return primary.send(jid, content, opts);
}
async function edit(jid, key, text) {
  return send(jid, { text, edit: key });
}
function status() { return sessionManager.status(); }
module.exports = {
  connect, stop, send, edit, status,
  pairNumber: (...a) => sessionManager.pairNumber(...a),
  unpair: (...a) => sessionManager.unpair(...a),
  listSessions: () => sessionManager.listSessions(),
};
