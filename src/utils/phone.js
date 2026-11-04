/**
 * Phone numbers — ONE normalisation rule for the whole bot.
 *
 * It used to be written three times (terminal prompt, session manager,
 * branding keys) and they disagreed about the national trunk prefix:
 * `+94 (0) 77 123 4567` became `940771234567` in one place and
 * `94771234567` in another, which is enough to store a session's branding
 * under a key nobody will ever look up again.
 *
 * Rules:
 *   • drop the written trunk prefix — `(0)`, `-0-`, ` 0 ` right after a `+CC`
 *   • drop everything that is not a digit
 *   • `00` in front means "international" (0094…) → drop it
 *   • a local `077…` number is left alone: we cannot guess the country
 */

/**
 * Digits only, trunk prefix gone: "+94 (0) 771-234-567" → "94771234567".
 * A jid is understood too — "94771234567:12@s.whatsapp.net" → "94771234567"
 * (the device suffix and the domain must never become part of the number).
 */
function digits(raw) {
  let s = String(raw == null ? '' : raw).trim();
  if (s.includes('@')) s = s.split('@')[0];
  if (s.includes(':')) s = s.split(':')[0];
  return s
    .replace(/\(\s*0\s*\)/g, '')            // +94 (0) 77 …
    .replace(/(\+\d{1,3})[\s.-]*0[\s.-]+/g, '$1')   // +94 0 77 … / +94-0-77…
    .replace(/\D/g, '');
}

/** What a session is called everywhere: its digits, `00` prefix removed. */
function normalize(raw) {
  let p = digits(raw);
  if (p.startsWith('00')) p = p.slice(2);
  return p;
}

/** 8–15 digits is what WhatsApp accepts. */
function isValid(p) {
  const d = String(p || '').replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15;
}

/** "94771234567:12@s.whatsapp.net" → "94771234567" (digits() does this too). */
function fromJid(jid) { return digits(jid); }

module.exports = { digits, normalize, isValid, fromJid };
