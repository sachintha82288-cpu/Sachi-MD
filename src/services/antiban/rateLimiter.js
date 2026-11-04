/**
 * Human-like rate limiter — sliding windows, per-chat fairness, adaptive
 * throughput and a budget for menu probes.
 *
 * Why per-chat? The old limiter had one global budget, so a busy group
 * could eat all 12 messages/minute and a private chat then sat in the
 * queue for the full 15 s block cap (measured: 17.5 s wait after a
 * 14-message group burst). Now every chat has its own small budget and a
 * quiet chat is never starved by a loud one.
 *
 * Why adaptive? `applyFactor()` scales the preset limits with the health
 * monitor: a healthy, warmed-up account gets up to 1.25× the throughput
 * (faster bot), an account in trouble drops to 0.25× (safer bot).
 */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function gaussianDelay(minMs, maxMs) {
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const mid = (minMs + maxMs) / 2;
  const spread = (maxMs - minMs) / 4;
  return clamp(Math.round(mid + z * spread), minMs, maxMs);
}
function textLength(content) {
  if (!content || typeof content !== 'object') return 0;
  if (typeof content.text === 'string') return content.text.length;
  if (typeof content.caption === 'string') return content.caption.length;
  return 0;
}
const envInt = (name, def, min) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.floor(n)) : def;
};

class RateLimiter {
  constructor(opts = {}) {
    this.base = {
      maxPerMinute: opts.maxPerMinute ?? 12,
      maxPerHour: opts.maxPerHour ?? 150,
      maxPerDay: opts.maxPerDay ?? 1000,
    };
    this.maxPerMinute = this.base.maxPerMinute;
    this.maxPerHour = this.base.maxPerHour;
    this.maxPerDay = this.base.maxPerDay;
    this.minDelayMs = opts.minDelayMs ?? 900;
    this.maxDelayMs = opts.maxDelayMs ?? 4200;
    this.newChatDelayMs = opts.newChatDelayMs ?? 2800;
    /** Minimum gap between two messages in the SAME chat. */
    this.perJidMinMs = envInt('ANTIBAN_PER_CHAT_MIN_MS', opts.perJidMinMs ?? 450, 0);
    /** A single chat may not eat more than this share of the minute budget. */
    this.maxPerJidMinute = envInt('ANTIBAN_PER_CHAT_PER_MINUTE', opts.maxPerJidMinute ?? 6, 1);
    this.typingMsPerChar = opts.typingMsPerChar ?? 28;
    this.typingMaxMs = opts.typingMaxMs ?? envInt('ANTIBAN_TYPING_MAX_MS', 1600, 300);
    this.editMinMs = opts.editMinMs ?? 150;
    this.editMaxMs = opts.editMaxMs ?? 450;
    /** Menu envelope probes get their own small budget (they are real sends). */
    this.probeMaxPerWindow = envInt('ANTIBAN_PROBE_MAX_PER_WINDOW', 12, 1);
    this.probeWindowMs = envInt('ANTIBAN_PROBE_WINDOW_MS', 10_000, 1000);

    this.timestamps = [];
    this.jidStamps = new Map();
    this.jidLast = new Map();
    this.seenJids = new Set();
    this.probeStamps = [];
    this.pausedUntil = 0;
    this.factor = 1;
    this.stats = { sent: 0, delayed: 0, blocked: 0, overruns: 0, probes: 0, probeBlocked: 0 };
  }

  _prune(now) {
    const dayAgo = now - 24 * 60 * 60 * 1000;
    if (this.timestamps.length && this.timestamps[0] <= dayAgo) {
      this.timestamps = this.timestamps.filter((t) => t > dayAgo);
    }
  }
  counts(now = Date.now()) {
    this._prune(now);
    let minute = 0; let hour = 0;
    for (let i = this.timestamps.length - 1; i >= 0; i--) {
      const t = this.timestamps[i];
      if (t > now - 60_000) minute++;
      if (t > now - 3_600_000) hour++; else break;
    }
    return { minute, hour, day: this.timestamps.length };
  }
  jidCount(jid, now = Date.now()) {
    const list = this.jidStamps.get(String(jid || ''));
    if (!list) return 0;
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) if (list[i] > now - 60_000) n++; else break;
    return n;
  }

  pause(ms) { this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms); }
  isPaused() { return Date.now() < this.pausedUntil; }
  clearPause() { this.pausedUntil = 0; }

  /** Adaptive throughput: >1 faster (healthy), <1 slower (in trouble). */
  applyFactor(factor) {
    const f = clamp(Number(factor) || 1, 0.15, 1.5);
    this.factor = f;
    this.maxPerMinute = Math.max(1, Math.round(this.base.maxPerMinute * f));
    this.maxPerHour = Math.max(5, Math.round(this.base.maxPerHour * f));
    this.maxPerDay = Math.max(20, Math.round(this.base.maxPerDay * f));
    return f;
  }
  /** Healthy → shorter gaps; in trouble → longer ones. */
  delayScale() { return clamp(1 / this.factor, 0.55, 1.6); }

  applyLimits(partial) {
    if (!partial) return;
    for (const k of ['maxPerMinute', 'maxPerHour', 'maxPerDay']) {
      if (partial[k] != null) { this.base[k] = partial[k]; }
    }
    for (const k of ['minDelayMs', 'maxDelayMs', 'newChatDelayMs', 'perJidMinMs', 'maxPerJidMinute']) {
      if (partial[k] != null) this[k] = partial[k];
    }
    this.applyFactor(this.factor);
  }

  /** Probes (menu envelopes) are real outbound messages — budget them. */
  probeAllowed(now = Date.now()) {
    this.probeStamps = this.probeStamps.filter((t) => t > now - this.probeWindowMs);
    if (this.probeStamps.length < this.probeMaxPerWindow) return { allowed: true, retryMs: 0 };
    return {
      allowed: false,
      retryMs: Math.max(0, this.probeStamps[0] + this.probeWindowMs - now),
      used: this.probeStamps.length,
    };
  }
  recordProbe() {
    const now = Date.now();
    this.probeStamps.push(now);
    this.stats.probes++;
    while (this.probeStamps.length > 200) this.probeStamps.shift();
  }

  compute(jid, content, { isEdit = false, skipTyping = false } = {}) {
    const now = Date.now();
    const key = String(jid || '');
    if (this.isPaused()) {
      this.stats.blocked++;
      return { delayMs: this.pausedUntil - now, blocked: true, reason: 'health_pause' };
    }
    const c = this.counts(now);
    if (c.minute >= this.maxPerMinute) {
      this.stats.blocked++;
      const idx = Math.max(0, this.timestamps.length - this.maxPerMinute);
      return { delayMs: Math.max(500, 60_000 - (now - this.timestamps[idx])), blocked: true, reason: 'per_minute' };
    }
    if (c.hour >= this.maxPerHour) {
      this.stats.blocked++;
      return { delayMs: 5_000, blocked: true, reason: 'per_hour' };
    }
    if (c.day >= this.maxPerDay) {
      this.stats.blocked++;
      return { delayMs: 30_000, blocked: true, reason: 'per_day' };
    }
    // Per-chat fairness: one loud chat cannot consume the whole budget.
    if (!isEdit && key && this.jidCount(key, now) >= this.maxPerJidMinute) {
      this.stats.blocked++;
      const list = this.jidStamps.get(key) || [];
      const idx = Math.max(0, list.length - this.maxPerJidMinute);
      return {
        delayMs: Math.max(500, 60_000 - (now - (list[idx] || now))),
        blocked: true, reason: 'per_chat', jid: key,
      };
    }

    const scale = this.delayScale();
    let delay = isEdit
      ? gaussianDelay(this.editMinMs, this.editMaxMs)
      : gaussianDelay(Math.round(this.minDelayMs * scale), Math.round(this.maxDelayMs * scale));

    const last = this.jidLast.get(key) || 0;
    const since = now - last;
    if (key && since < this.perJidMinMs) delay = Math.max(delay, this.perJidMinMs - since);

    const isNew = key && !this.seenJids.has(key);
    if (isNew && !isEdit) delay = Math.max(delay, Math.round((this.newChatDelayMs + Math.random() * 800) * scale));

    if (!isEdit && !skipTyping) {
      const len = textLength(content);
      if (len > 8) {
        const typing = Math.min(this.typingMaxMs, Math.round(len * this.typingMsPerChar * (0.7 + Math.random() * 0.5)));
        delay = Math.max(delay, typing);
      }
    }
    return { delayMs: Math.max(0, delay), blocked: false, isNew };
  }

  /** Forget the counters (not the chat memory) — used by `.antiban reset`. */
  clearCounters() {
    this.timestamps = [];
    this.jidStamps.clear();
    this.jidLast.clear();
    this.probeStamps = [];
    this.stats = { sent: 0, delayed: 0, blocked: 0, overruns: 0, probes: 0, probeBlocked: 0 };
  }

  record(jid) {
    const now = Date.now();
    this.timestamps.push(now);
    this._prune(now);
    const key = String(jid || '');
    if (key) {
      this.jidLast.set(key, now);
      this.seenJids.add(key);
      const list = this.jidStamps.get(key) || [];
      list.push(now);
      while (list.length && list[0] < now - 3_600_000) list.shift();
      this.jidStamps.set(key, list);
      if (this.jidLast.size > 5000) this.jidLast.delete(this.jidLast.keys().next().value);
      if (this.jidStamps.size > 5000) this.jidStamps.delete(this.jidStamps.keys().next().value);
      if (this.seenJids.size > 8000) this.seenJids.delete(this.seenJids.values().next().value);
    }
    this.stats.sent++;
  }

  /** The caller decided to send despite the cap — remember that. */
  noteOverrun() { this.stats.overruns++; }

  status() {
    const c = this.counts();
    return {
      ...c,
      limits: { minute: this.maxPerMinute, hour: this.maxPerHour, day: this.maxPerDay },
      base: {
        ...this.base,
        minDelayMs: this.minDelayMs, maxDelayMs: this.maxDelayMs, newChatDelayMs: this.newChatDelayMs,
      },
      factor: Number(this.factor.toFixed(2)),
      perChat: { limit: this.maxPerJidMinute, minGapMs: this.perJidMinMs },
      probes: { used: this.probeStamps.length, limit: this.probeMaxPerWindow, windowMs: this.probeWindowMs },
      paused: this.isPaused(),
      pausedRemainingMs: Math.max(0, this.pausedUntil - Date.now()),
      stats: { ...this.stats },
      knownChats: this.seenJids.size,
    };
  }

  /** Protection has to survive a restart — a crash loop must not reset it. */
  serialize() {
    const now = Date.now();
    return {
      timestamps: this.timestamps.filter((t) => t > now - 3_600_000).slice(-600),
      pausedUntil: this.pausedUntil,
      factor: this.factor,
      seenJids: [...this.seenJids].slice(-800),
      savedAt: now,
    };
  }
  restore(state) {
    if (!state || typeof state !== 'object') return false;
    if (state.savedAt && Date.now() - state.savedAt > 24 * 3_600_000) return false;
    const now = Date.now();
    this.timestamps = (Array.isArray(state.timestamps) ? state.timestamps : [])
      .map(Number).filter((t) => t > now - 24 * 3_600_000);
    this.pausedUntil = Number(state.pausedUntil) || 0;
    if (Array.isArray(state.seenJids)) for (const j of state.seenJids) this.seenJids.add(String(j));
    if (Number(state.factor)) this.applyFactor(Number(state.factor));
    return true;
  }
}

module.exports = { RateLimiter, gaussianDelay, textLength };
