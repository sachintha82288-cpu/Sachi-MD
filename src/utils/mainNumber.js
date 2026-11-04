/**
 * Main WhatsApp number — typed straight into the terminal at startup.
 *
 * The number used to be reachable only through .env / WA_PHONE_NUMBER.
 * Now the bot asks for it in the console (when a real terminal is
 * attached), validates what was typed and remembers it in .env so the
 * next boot is silent.
 *
 * Rules that must never break:
 *  • No TTY (Pterodactyl, docker, CI) → NEVER ask, never hang.
 *  • The answer is cached — the pairing code is re-requested every minute
 *    while the phone is not linked yet, and the user must not be asked
 *    again for every new QR code.
 */
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const log = require('./logger');
const { setEnvValue } = require('./envLoader');
const { digits: phoneDigits } = require('./phone');

const DEFAULT_NUMBER = '94750404115';
const MAX_TRIES = 3;
/** An unattended terminal must never block the boot forever. */
const ASK_TIMEOUT_MS = () => Math.max(0, Number(process.env.WA_ASK_TIMEOUT_MS || 30000));

/** Digits only — "+94 (0) 771-234-567" → "94771234567" (utils/phone.js). */
const digits = phoneDigits;
const isValid = (p) => String(p || '').length >= 8 && String(p || '').length <= 15;
/** A real terminal is attached (not a pipe, not a panel without console). */
function interactive() {
  return !!(process.stdin.isTTY && process.stdout.isTTY);
}

/** The primary session is already linked — the number is known by then. */
function alreadyLinked() {
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(config.paths.session, 'creds.json'), 'utf8'));
    return !!creds?.registered;
  } catch { return false; }
}

let cached = null;
let rl = null;
let pending = null;
const buffered = [];

/** One readline interface for the whole prompt. Lines that arrive before
 *  their question is asked are queued — otherwise a pasted number (or a
 *  wrong number followed by a right one) would lose input. */
function getRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
      if (pending) { const p = pending; pending = null; p(line); }
      else buffered.push(line);
    });
  }
  return rl;
}
function closeRl() {
  try { rl?.close(); } catch { /* already closed */ }
  rl = null;
  pending = null;
  buffered.length = 0;
}

function ask(question) {
  return new Promise((resolve) => {
    getRl();
    if (buffered.length) {
      process.stdout.write(question);
      resolve(buffered.shift());
      return;
    }
    pending = resolve;
    process.stdout.write(question);
  });
}

/** ask() with a deadline — an unattended terminal must not block forever. */
function askWithTimeout(question, timeoutMs) {
  let timer = null;
  const read = ask(question).then((value) => {
    if (timer) clearTimeout(timer);
    return { value, timedOut: false };
  });
  if (!timeoutMs) return read;
  return Promise.race([
    read,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ value: '', timedOut: true }), timeoutMs);
    })
  ]);
}

function banner() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  📱  ${String(require('../services/settings').name()).toUpperCase()} — main WhatsApp number               ║`);
  console.log('║                                                  ║');
  console.log('║  The number the bot runs on.                      ║');
  console.log('║  International format, digits only.               ║');
  console.log('║  Example: 94771234567                             ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

/**
 * Resolve the main number. Returns the digits.
 * Asks in the terminal when possible, otherwise falls back to .env.
 */
async function resolve({ force = false, save = true } = {}) {
  if (cached && !force) return cached;
  const fromEnv = digits(process.env.WA_PHONE_NUMBER || '');
  const configured = digits(config.phoneNumber || '') || fromEnv || DEFAULT_NUMBER;
  const mode = String(process.env.WA_ASK_PHONE || 'always').toLowerCase();

  if (mode === 'never' || !interactive()) {
    cached = configured;
    return cached;
  }
  // Once the phone is linked the number is known — no prompt (unless the
  // user forces it with WA_ASK_PHONE=always).
  if (mode !== 'always' && alreadyLinked()) {
    cached = configured;
    return cached;
  }
  if (mode === 'if-unset' && fromEnv) {
    cached = configured;
    return cached;
  }

  banner();
  let answer = configured;
  try {
    for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
      const res = await askWithTimeout(`  Number [${configured}]: `, ASK_TIMEOUT_MS());
      if (res.timedOut) {
        // nobody typed (panel console, cron start) — keep the configured number
        log.warn(`  No input — keeping +${configured}.`);
        break;
      }
      const raw = String(res.value || '');
      const typed = digits(raw);
      if (!typed) { answer = configured; break; }        // Enter → keep default
      if (!isValid(typed)) {
        log.warn(`  ✗ "${raw.trim()}" is not a valid number (8–15 digits, country code first).`);
        continue;
      }
      answer = typed;
      break;
    }
  } finally {
    closeRl();
  }
  if (!isValid(answer)) answer = configured;

  if (answer !== configured) {
    try {
      if (save) setEnvValue('WA_PHONE_NUMBER', answer);
      process.env.WA_PHONE_NUMBER = answer;
      config.phoneNumber = answer;
      config.ownerNumber = answer;
      log.success(save
        ? `Main number set to +${answer} — saved to .env`
        : `Main number set to +${answer}`);
    } catch (e) {
      log.warn(`Could not save the number to .env (${e.message}) — set WA_PHONE_NUMBER manually.`);
      config.phoneNumber = answer;
      config.ownerNumber = answer;
      process.env.WA_PHONE_NUMBER = answer;
    }
  } else {
    config.phoneNumber = answer;
    config.ownerNumber = answer;
  }
  cached = answer;
  return cached;
}

/** The resolved number without ever asking (used by non-interactive code). */
function current() {
  return cached || digits(process.env.WA_PHONE_NUMBER || config.phoneNumber || '') || DEFAULT_NUMBER;
}

function reset() { cached = null; }

module.exports = { resolve, current, reset, digits, isValid, interactive, DEFAULT_NUMBER };
