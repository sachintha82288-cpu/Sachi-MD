function unwrapMessage(message) {
  let m = message;
  for (let i = 0; i < 6 && m; i++) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    else if (m.editedMessage) m = m.editedMessage.message;
    else break;
  }
  return m || {};
}
function extractText(message) {
  const m = unwrapMessage(message);
  return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || m.buttonsResponseMessage?.selectedButtonId || m.listResponseMessage?.singleSelectReply?.selectedRowId || '').trim();
}
/**
 * Strip the multi-device suffix: `94771234567:12@s.whatsapp.net` →
 * `94771234567@s.whatsapp.net`. Splitting on ':' alone used to eat the
 * domain too, which made owner/sender comparisons fail for device jids.
 */
function normalizeJid(jid) {
  const raw = String(jid || '');
  if (!raw) return raw;
  const at = raw.indexOf('@');
  if (at < 0) return raw.split(':')[0];
  return raw.slice(0, at).split(':')[0] + raw.slice(at);
}

/**
 * Age of a WAMessage in ms (Long-safe — Baileys may hand us a Long).
 * Unknown/missing timestamps are treated as brand-new (age 0) so a
 * malformed stamp can never make the bot deaf to fresh traffic.
 */
function messageAgeMs(msg, now = Date.now()) {
  const raw = msg?.messageTimestamp;
  let secs = 0;
  if (raw && typeof raw === 'object' && typeof raw.toNumber === 'function') secs = raw.toNumber();
  else secs = Number(raw) || 0;
  if (!secs) return 0;
  return now - secs * 1000;
}

module.exports = { unwrapMessage, extractText, normalizeJid, messageAgeMs };
