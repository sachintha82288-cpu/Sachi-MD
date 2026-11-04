/**
 * Ban-risk health monitor.
 *
 * The old version treated every send failure the same, so a missing ffmpeg
 * or an expired status media file pushed the score up exactly like a real
 * 403 from WhatsApp — and three ordinary reconnects (code 515, "restart
 * required") were enough to pause the whole bot. Measured: 6 harmless
 * content errors → risk 48 → 20 s pause, while 3 REAL ban signals produced
 * the very same score. No discrimination in either direction.
 *
 * Now every signal is classified first:
 *
 *   ban      → 401/403/429/"rate limit"/"not authorized"/"blocked" …  (+25, escalates)
 *   transient→ timeouts, socket resets, 5xx                            (+4)
 *   benign   → media, ffmpeg, yt-dlp, validation, DNS, bad URLs        (+0, counted)
 *
 * Risk decays with TIME (not only when a call happens), and genuine ban
 * signals escalate: 1 → 30 s cool-off, 2 → 2 min, 3+ → 10 min.
 */
const BAN_PATTERNS = [
  '401', '403', '411', '419', '428', '429', '440',
  'forbidden', 'unauthorized', 'not authorized', 'rate limit', 'rate-limit',
  'too many requests', 'blocked', 'banned', 'ban ', 'logged out', 'logout',
  'credentials', 'not paired', 'paired with another', 'multidevice mismatch',
];
const TRANSIENT_PATTERNS = [
  'timeout', 'timed out', 'etimedout', 'econnreset', 'econnrefused', 'econnaborted',
  'socket hang up', 'socket error', 'epipe', 'eai_again', 'ehostunreach', 'enetunreach',
  'network', 'connection', 'fetch failed', 'upstream', '500', '502', '503', '504',
  'unavailable', 'temporarily', 'stream errored', 'closed', 'restart required', 'try again',
];

/**
 * A genuine account-level signal must never be masked by a benign keyword
 * ("403 forbidden while downloading media" is still a 403 from WhatsApp).
 * Checked before everything else.
 */
const STRONG_BAN = new RegExp([
  '\\b(401|403|411|419|428|429|440)\\b[^.]*?(forbidden|unauthori[sz]ed|not authorized|rate.?limit|too many requests|banned|logged ?out|multidevice mismatch)',
  '(not authorized|account banned|too many requests|rate.?limit(ed)?|multidevice mismatch|logged ?out|bad.?token|session closed)',
].join('|'), 'i');
const BENIGN_PATTERNS = [
  '404', 'media expired', 'no media', 'ffmpeg', 'yt-dlp', 'ytdlp', 'sticker',
  'webp', 'too large', 'exceeds', 'download', 'could not be downloaded',
  'invalid url', 'the url', 'bad url', 'url could not', 'malformed url', 'unsupported url',
  'ssrf', 'dns', 'enotfound', 'getaddrinfo',
  'json', 'parse', 'not a function', 'undefined', 'no such', 'missing',
  'give me', 'usage:', 'not supported', 'unsupported', 'quality', 'apk',
  'wikipedia', 'no results', 'empty', 'caption', 'mimetype', 'convert',
];

/** Signals that WhatsApp itself is unhappy with this account. */
const BAN_DISCONNECT_CODES = new Set([401, 403, 411, 419, 428, 440]);
/** Ordinary reconnects: Baileys asks for a restart, the network blinked. */
const BENIGN_DISCONNECT_CODES = new Set([515, 408, 400, 500, 502, 503, 504, 505, 404]);

function classifyError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return 'benign';
  if (STRONG_BAN.test(msg)) return 'ban';
  for (const p of BENIGN_PATTERNS) if (msg.includes(p)) return 'benign';
  for (const p of BAN_PATTERNS) if (msg.includes(p)) return 'ban';
  for (const p of TRANSIENT_PATTERNS) if (msg.includes(p)) return 'transient';
  return 'unknown';
}

function classifyDisconnect(code) {
  const n = Number(code);
  if (BAN_DISCONNECT_CODES.has(n)) return 'ban';
  if (BENIGN_DISCONNECT_CODES.has(n)) return 'benign';
  return 'transient';
}

/** risk points per class */
const POINTS = { ban: 25, transient: 4, benign: 0, unknown: 8 };
/** how much a genuine ban signal escalates the cool-off */
const BAN_PAUSES_MS = [30_000, 2 * 60_000, 10 * 60_000];

class HealthMonitor {
  constructor(opts = {}) {
    this.risk = Number(opts.risk) || 0;
    this.events = [];
    this.maxEvents = 80;
    this.disconnects = 0;
    this.sendFails = 0;
    this.counts = { ban: 0, transient: 0, benign: 0, unknown: 0 };
    this.banSignals = 0;
    this.lastSignalAt = 0;
    this.lastDisconnectAt = 0;
    this.lastFailAt = 0;
    this.lastDecayAt = Date.now();
    this.onHighRisk = opts.onHighRisk || null;
    /** Fires for a real ban signal even when the score is still low. */
    this.onBanSignal = opts.onBanSignal || null;
    this.highThreshold = opts.highThreshold ?? 55;
    this.criticalThreshold = opts.criticalThreshold ?? 80;
    /** 1 risk point per this many ms without trouble. */
    this.decayMsPerPoint = Math.max(1000, Number(process.env.ANTIBAN_DECAY_MS_PER_POINT) || 15_000);
    /** A ban signal older than this no longer escalates the cool-off. */
    this.banMemoryMs = Math.max(60_000, Number(process.env.ANTIBAN_BAN_MEMORY_MS) || 30 * 60_000);
  }

  _push(type, detail) {
    this.events.push({ type, detail, at: Date.now() });
    if (this.events.length > this.maxEvents) this.events.shift();
  }

  /** Time-based decay — the score drops even while nothing is happening. */
  _decay(now = Date.now()) {
    const elapsed = now - (this.lastDecayAt || now);
    this.lastDecayAt = now;
    if (elapsed <= 0 || this.risk <= 0) return;
    const points = elapsed / this.decayMsPerPoint;
    if (points >= 1) this.risk = Math.max(0, this.risk - points);
    // an old ban signal stops escalating
    if (this.banSignals && this.lastSignalAt && now - this.lastSignalAt > this.banMemoryMs) {
      this.banSignals = Math.max(0, this.banSignals - 1);
      this.lastSignalAt = now;
    }
  }

  noteDisconnect(code) {
    const kind = classifyDisconnect(code);
    this.disconnects++;
    this.lastDisconnectAt = Date.now();
    this._decay();
    this._push('disconnect', { code, kind });
    if (kind === 'ban') {
      this.risk = Math.min(100, this.risk + 30);
      this.banSignals++;
      this.lastSignalAt = Date.now();
      this.counts.ban++;
      this._escalate('disconnect ' + code);
    } else if (kind === 'transient') {
      this.risk = Math.min(100, this.risk + 6);
      this.counts.transient++;
    } else {
      this.risk = Math.min(100, this.risk + 1);
      this.counts.benign++;
    }
    this._maybeAlert();
  }

  noteSendFail(err) {
    const kind = classifyError(err);
    this.sendFails++;
    this.lastFailAt = Date.now();
    this.counts[kind] = (this.counts[kind] || 0) + 1;
    const msg = String(err?.message || err || '').slice(0, 120);
    this._decay();
    this._push('send_fail', { message: msg, kind });
    this.risk = Math.min(100, this.risk + (POINTS[kind] ?? 8));
    if (kind === 'ban') {
      this.banSignals++;
      this.lastSignalAt = Date.now();
      this._escalate(msg);
    }
    this._maybeAlert();
    return kind;
  }

  /** A real ban signal always cools the bot down, even at a low score. */
  _escalate(detail) {
    const idx = Math.min(this.banSignals - 1, BAN_PAUSES_MS.length - 1);
    const pause = BAN_PAUSES_MS[Math.max(0, idx)];
    this._push('ban_signal', { detail, pause });
    try { this.onBanSignal?.(pause, this.banSignals, detail); } catch {}
  }

  noteSendOk() {
    this._decay();
    if (this.risk > 0) this.risk = Math.max(0, this.risk - 1);
  }
  noteGoodConnection() { this._decay(); this.risk = Math.max(0, this.risk - 5); }

  _maybeAlert() {
    if (this.risk >= this.highThreshold) {
      try { this.onHighRisk?.(this.level(), this.risk); } catch {}
    }
  }

  level() {
    this._decay();
    if (this.risk >= this.criticalThreshold) return 'critical';
    if (this.risk >= this.highThreshold) return 'high';
    if (this.risk >= 30) return 'elevated';
    return 'low';
  }

  suggestedPauseMs() {
    const level = this.level();
    if (level === 'critical') return 5 * 60_000;
    if (level === 'high') return 90_000;
    if (level === 'elevated') return 20_000;
    return 0;
  }

  /**
   * How much of the preset throughput the bot may currently use.
   * Healthy + warm → a little faster than the preset; in trouble → much
   * slower. This is what makes "stronger protection" and "more speed"
   * compatible instead of a trade-off.
   */
  throughputFactor(warmupFactor = 1) {
    const level = this.level();
    const byLevel = { low: 1.25, elevated: 0.8, high: 0.5, critical: 0.25 }[level] ?? 1;
    return Math.max(0.15, Math.min(1.5, byLevel * warmupFactor));
  }

  status() {
    this._decay();
    return {
      risk: Math.round(this.risk),
      level: this.level(),
      disconnects: this.disconnects,
      sendFails: this.sendFails,
      banSignals: this.banSignals,
      classified: { ...this.counts },
      recent: this.events.slice(-8),
      coolOff: this.coolOff(),
      suggestedPauseMs: this.suggestedPauseMs(),
      throughputFactor: Number(this.throughputFactor().toFixed(2)),
    };
  }

  /**
   * Escalation state: how many real ban signals were seen, how long the
   * last cool-off was, and whether the bot still remembers them (a signal
   * older than banMemoryMs no longer escalates the next one).
   */
  coolOff(now = Date.now()) {
    const sigs = this.events.filter((e) => e.type === 'ban_signal');
    const last = sigs[sigs.length - 1];
    return {
      pauses: sigs.length,
      banSignals: this.banSignals,
      lastAt: this.lastSignalAt || (last ? last.at : 0),
      lastPauseMs: last && last.detail ? Number(last.detail.pause) || 0 : 0,
      remembered: !!this.lastSignalAt && (now - this.lastSignalAt) < this.banMemoryMs,
      nextPauseMs: BAN_PAUSES_MS[Math.min(this.banSignals, BAN_PAUSES_MS.length - 1)],
    };
  }

  /** Serializable state — protection must survive a restart. */
  serialize() {
    this._decay();
    return {
      risk: Math.round(this.risk * 100) / 100,
      banSignals: this.banSignals,
      lastSignalAt: this.lastSignalAt,
      lastFailAt: this.lastFailAt,
      lastDisconnectAt: this.lastDisconnectAt,
      disconnects: this.disconnects,
      sendFails: this.sendFails,
      counts: { ...this.counts },
      savedAt: Date.now(),
    };
  }

  restore(state) {
    if (!state || typeof state !== 'object') return false;
    // a saved score older than an hour is stale — start clean
    if (state.savedAt && Date.now() - state.savedAt > 60 * 60_000) return false;
    this.risk = Math.max(0, Math.min(100, Number(state.risk) || 0));
    this.banSignals = Math.max(0, Number(state.banSignals) || 0);
    this.lastSignalAt = Number(state.lastSignalAt) || 0;
    this.lastFailAt = Number(state.lastFailAt) || 0;
    this.lastDisconnectAt = Number(state.lastDisconnectAt) || 0;
    this.disconnects = Number(state.disconnects) || 0;
    this.sendFails = Number(state.sendFails) || 0;
    this.counts = { ban: 0, transient: 0, benign: 0, unknown: 0, ...(state.counts || {}) };
    this.lastDecayAt = Date.now();
    return true;
  }

  reset() {
    this.risk = 0;
    this.events = [];
    this.disconnects = 0;
    this.sendFails = 0;
    this.banSignals = 0;
    this.lastSignalAt = 0;
    this.lastFailAt = 0;
    this.lastDisconnectAt = 0;
    this.counts = { ban: 0, transient: 0, benign: 0, unknown: 0 };
    this.lastDecayAt = Date.now();
  }
}

module.exports = { HealthMonitor, classifyError, classifyDisconnect, POINTS, BAN_PAUSES_MS };
