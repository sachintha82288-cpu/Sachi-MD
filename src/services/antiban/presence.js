/**
 * Typing-presence simulation — and the single biggest speed win in the bot.
 *
 * Before: the indicator was started when the reply was READY, then awaited,
 * so its whole duration was added to the latency of every answer (measured:
 * a `.ping` cost ~1.5 s of pure artificial delay).
 *
 * Now: `startTyping()` fires the moment an inbound message arrives, so the
 * indicator is on screen while the command actually works (AI, download,
 * sticker…). `beforeSend()` then only waits for the REMAINDER of the human
 * pacing budget. A 2-second command therefore adds ~0 ms, and the typing
 * indicator is visible for the whole time — better UX *and* more human.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textLength(content) {
  if (!content || typeof content !== 'object') return 0;
  if (typeof content.text === 'string') return content.text.length;
  if (typeof content.caption === 'string') return content.caption.length;
  return 0;
}
function envInt(name, def, min) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : def;
}
const TYPING_MAX_MS = envInt('ANTIBAN_TYPING_MAX_MS', 1600, 300);
/** The indicator has to be on screen long enough to be noticed. */
const MIN_VISIBLE_MS = envInt('ANTIBAN_TYPING_MIN_MS', 650, 0);
/** Forget a typing start after this long (a stalled command must not leak). */
const TYPING_TTL_MS = envInt('ANTIBAN_TYPING_TTL_MS', 120_000, 5000);

class PresenceHelper {
  constructor(opts = {}) {
    this.enabled = opts.enabled !== false;
    this.wpm = opts.wpm ?? 42;
    this.wpmStd = opts.wpmStd ?? 12;
    this.minComposeMs = opts.minComposeMs ?? 350;
    this.maxComposeMs = Math.min(opts.maxComposeMs ?? TYPING_MAX_MS, TYPING_MAX_MS);
    /** jid → the moment the indicator went up for this chat */
    this.typingSince = new Map();
    this.sock = null;
  }

  /** Pure: how long the typing indicator would be shown for this text. */
  composeTime(len) { return this._composeMs(len || 20); }
  setSocket(sock) { this.sock = sock; }

  /**
   * How long a human would take to type this. `capMs` lifts the usual
   * ceiling for the first message to a brand-new chat.
   */
  _composeMs(len, capMs = null) {
    const cap = Number.isFinite(capMs)
      ? Math.max(300, Math.min(4000, Number(capMs)))
      : this.maxComposeMs;
    if (len < 12) return Math.min(cap, this.minComposeMs + Math.floor(Math.random() * 250));
    const wpm = Math.max(20, this.wpm + (Math.random() - 0.5) * 2 * this.wpmStd);
    const charsPerSec = (wpm * 5) / 60;
    const ms = Math.round((len / charsPerSec) * 1000 * (0.75 + Math.random() * 0.4));
    return Math.min(cap, Math.max(this.minComposeMs, ms));
  }

  _prune(now = Date.now()) {
    for (const [jid, at] of this.typingSince) if (now - at > TYPING_TTL_MS) this.typingSince.delete(jid);
  }

  /** Is the indicator currently up for this chat? (elapsed can be 0 ms.) */
  isTyping(jid) {
    this._prune();
    return this.typingSince.has(String(jid || ''));
  }

  /** How long the indicator has already been visible for this chat. */
  elapsed(jid, now = Date.now()) {
    const at = this.typingSince.get(String(jid || ''));
    return at ? Math.max(0, now - at) : 0;
  }

  /**
   * Raise the indicator as soon as a message arrives. Never throws, never
   * blocks the caller: the whole point is that the wait overlaps the work.
   */
  async startTyping(jid, sock = null, content = null) {
    const target = sock || this.sock;
    const key = String(jid || '');
    if (!this.enabled || !target || !key) return false;
    this._prune();
    // Already typing for this chat — keep the original start time so a
    // multi-message reply does not restart the clock.
    if (!this.typingSince.has(key)) this.typingSince.set(key, Date.now());
    try { await target.sendPresenceUpdate('composing', key); } catch { return false; }
    return true;
  }

  /**
   * Wait out whatever is LEFT of the human pacing budget, then send.
   * `maxMs` is the wall-time budget from the limiter; the time the indicator
   * has already been up counts towards it.
   */
  async beforeSend(jid, content, { skip = false, maxMs = Infinity, sock = null, composeCapMs = null } = {}) {
    const target = sock || this.sock;
    const key = String(jid || '');
    if (!this.enabled || skip || !target || !key) return 0;
    const len = textLength(content);
    const isTextLike = len > 0 || (content && (content.text || content.caption));
    if (!isTextLike) return 0;

    const already = this.elapsed(key);
    // A brand-new chat gets a longer compose window than a familiar one —
    // `composeCapMs` lifts the usual cap for exactly that case.
    const cap = Number.isFinite(composeCapMs)
      ? Math.max(300, Math.min(4000, Number(composeCapMs)))
      : this.maxComposeMs;
    const composed = Math.min(this._composeMs(len || 20, cap), cap, Number.isFinite(maxMs) ? maxMs : cap);
    // The indicator must have been visible for at least MIN_VISIBLE_MS in
    // TOTAL — but time already spent counts, so a slow command pays nothing.
    const wanted = Math.max(composed, MIN_VISIBLE_MS);
    const remaining = Math.max(0, wanted - already);

    if (!this.typingSince.has(key)) {
      this.typingSince.set(key, Date.now());
      try { await target.sendPresenceUpdate('composing', key); } catch {}
    }
    if (remaining <= 0) return 0;

    // Long composition gets an occasional pause — people re-read things.
    if (remaining > 1800 && Math.random() < 0.25) {
      const first = Math.floor(remaining * (0.35 + Math.random() * 0.25));
      await sleep(first);
      try { await target.sendPresenceUpdate('paused', key); } catch {}
      await sleep(200 + Math.floor(Math.random() * 600));
      try { await target.sendPresenceUpdate('composing', key); } catch {}
      await sleep(Math.max(0, remaining - first - 800));
      return remaining;
    }
    await sleep(remaining);
    return remaining;
  }

  /**
   * Drop the indicator without sending anything — for inbound messages the
   * bot deliberately ignores (ordinary chat, wrong mode, unknown command).
   * Without this the phone would show "typing…" for 25 s and never answer.
   */
  async cancelTyping(jid, sock = null) {
    const target = sock || this.sock;
    const key = String(jid || '');
    if (!key) return false;
    const was = this.typingSince.delete(key);
    if (!was || !this.enabled || !target) return was;
    try { await target.sendPresenceUpdate('paused', key); } catch {}
    return true;
  }

  async afterSend(jid, sock = null) {
    const target = sock || this.sock;
    const key = String(jid || '');
    this.typingSince.delete(key);
    if (!this.enabled || !target || !key) return;
    try { await target.sendPresenceUpdate('paused', key); } catch {}
  }

  async pulseAvailable() {
    if (!this.enabled || !this.sock) return;
    try { await this.sock.sendPresenceUpdate('available'); } catch {}
  }

  status() {
    this._prune();
    return { enabled: this.enabled, typingNow: this.typingSince.size, minVisibleMs: MIN_VISIBLE_MS, maxComposeMs: this.maxComposeMs };
  }
}

module.exports = { PresenceHelper, MIN_VISIBLE_MS, TYPING_MAX_MS };
