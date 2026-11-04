/**
 * Anti-ban: human-like pacing, fair scheduling and a health watch that can
 * tell a missing ffmpeg from a 403.
 *
 * IMPORTANT — probes vs. real sends
 * ---------------------------------
 * The menu tries several envelopes (native-flow card, bare card, legacy
 * list, …). The server REJECTING one of them is normal control flow, not a
 * sign of a ban, so rejections never raise the health score. They ARE real
 * outbound traffic though, so they now have their own small budget
 * (`ANTIBAN_PROBE_MAX_PER_WINDOW`): once it is spent the menu ladder stops
 * and goes straight to the image/text fallback instead of hammering.
 *
 * IMPORTANT — speed
 * -----------------
 * `onInbound()` raises the typing indicator the moment a message arrives,
 * so the human pacing budget is consumed WHILE the command works. A slow
 * command (AI, download, sticker) therefore adds ~0 ms of extra latency,
 * and `beforeOutbound()` only waits for whatever is left.
 */
const path = require('path');
const config = require('../../config');
const log = require('../../utils/logger');
const { atomicJsonWrite, safeJsonRead } = require('../../utils/files');
const { RateLimiter } = require('./rateLimiter');
const { PresenceHelper } = require('./presence');
const { HealthMonitor, classifyError } = require('./health');
const { WarmUp } = require('./warmup');

const PRESETS = {
  conservative: { maxPerMinute: 8, maxPerHour: 100, maxPerDay: 600, minDelayMs: 1200, maxDelayMs: 5000, newChatDelayMs: 3500 },
  moderate: { maxPerMinute: 12, maxPerHour: 150, maxPerDay: 1000, minDelayMs: 900, maxDelayMs: 4200, newChatDelayMs: 2800 },
  aggressive: { maxPerMinute: 18, maxPerHour: 220, maxPerDay: 1500, minDelayMs: 500, maxDelayMs: 2800, newChatDelayMs: 1800 },
  /** Fastest preset — for a trusted, warmed-up number on a quiet bot. */
  turbo: { maxPerMinute: 30, maxPerHour: 400, maxPerDay: 2500, minDelayMs: 300, maxDelayMs: 1500, newChatDelayMs: 1000 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envInt = (name, def, min) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.floor(n)) : def;
};

/** How long the bot may sit in the rate limiter before it sends anyway. */
const MAX_BLOCK_WAIT_MS = envInt('ANTIBAN_MAX_BLOCK_MS', 15_000, 1000);
/** First message after the daily warm-up cap pays this; the rest pay less. */
const WARMUP_PENALTY_MS = envInt('ANTIBAN_WARMUP_PENALTY_MS', 6_000, 0);
const WARMUP_PENALTY_REPEAT_MS = envInt('ANTIBAN_WARMUP_PENALTY_REPEAT_MS', 1_500, 0);
/** How long a menu envelope may wait when the rate cap is reached. */
const PROBE_BLOCK_WAIT_MS = envInt('ANTIBAN_PROBE_BLOCK_MS', 600, 0);
/** Fast mode: short replies get a tight wall-time cap. */
const SHORT_MAX_MS = envInt('ANTIBAN_FAST_MAX_MS', 800, 200);
/** Ceiling for replies in a KNOWN chat (a brand-new chat keeps the full delay). */
const REPLY_MAX_MS = envInt('ANTIBAN_REPLY_MAX_MS', 1400, 300);
/** Typing window for the FIRST message to a brand-new chat. */
const NEW_CHAT_TYPING_MS = envInt('ANTIBAN_NEW_CHAT_TYPING_MS', 2_400, 500);
/** How often the persisted protection state is written. */
const STATE_SAVE_MS = envInt('ANTIBAN_STATE_SAVE_MS', 2_000, 500);

class AntiBan {
  /** `opts.dataDir` lets tests/benches keep their state out of the real data dir. */
  constructor(opts = {}) {
    const ab = config.antiban || {};
    const dataDir = opts.dataDir || config.paths.data;
    this.enabled = ab.enabled !== false;
    this.presetName = PRESETS[ab.preset || 'moderate'] ? (ab.preset || 'moderate') : 'moderate';
    const preset = PRESETS[this.presetName];
    this.limiter = new RateLimiter({
      ...preset,
      maxPerMinute: ab.maxPerMinute ?? preset.maxPerMinute,
      maxPerHour: ab.maxPerHour ?? preset.maxPerHour,
      maxPerDay: ab.maxPerDay ?? preset.maxPerDay,
      minDelayMs: ab.minDelayMs ?? preset.minDelayMs,
      maxDelayMs: ab.maxDelayMs ?? preset.maxDelayMs,
      newChatDelayMs: ab.newChatDelayMs ?? preset.newChatDelayMs,
      typingMsPerChar: ab.typingMsPerChar ?? 28,
    });
    this.presence = new PresenceHelper({ enabled: ab.typing !== false, wpm: ab.typingWpm ?? 42 });
    this.health = new HealthMonitor({
      onHighRisk: (level, risk) => {
        const pause = this.health.suggestedPauseMs();
        if (pause > 0) {
          this.limiter.pause(pause);
          log.warn(`Anti-ban: risk=${level} (${Math.round(risk)}) — pausing outbound ~${Math.round(pause / 1000)}s`);
        }
      },
      onBanSignal: (pause, signals, detail) => {
        this.limiter.pause(pause);
        log.warn(`Anti-ban: BAN SIGNAL #${signals} (${String(detail).slice(0, 80)}) — cooling down ${Math.round(pause / 1000)}s`);
      },
    });
    this.warmup = new WarmUp(dataDir, { enabled: ab.warmup !== false, schedule: ab.warmupSchedule });
    this.stateFile = path.join(dataDir, 'antiban-state.json');
    this._bgTimer = null;
    this._saveTimer = null;
    this._lastPenaltyAt = 0;
    this.probeStats = { tried: 0, rejected: 0, delivered: 0, budgetBlocked: 0 };
    this.restored = this._restore();
    this.applyAdaptive();
  }

  /* ── persisted protection state ──────────────────────────────────── */

  _restore() {
    try {
      const state = safeJsonRead(this.stateFile, null);
      if (!state) return false;
      const h = this.health.restore(state.health);
      const l = this.limiter.restore(state.limiter);
      if (h || l) {
        log.info(`Anti-ban: protection state restored (risk ${this.health.status().risk}, ${this.limiter.status().minute} sends in the last minute)`);
        return true;
      }
    } catch {}
    return false;
  }

  /** Debounced — the state must survive a crash without costing I/O per send. */
  scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.saveNow(); }, STATE_SAVE_MS);
    this._saveTimer.unref?.();
  }
  saveNow() {
    try {
      atomicJsonWrite(this.stateFile, {
        v: 1,
        health: this.health.serialize(),
        limiter: this.limiter.serialize(),
        warmup: this.warmup.serialize ? this.warmup.serialize() : undefined,
      });
      return true;
    } catch { return false; }
  }

  /* ── adaptive throughput ─────────────────────────────────────────── */

  /** A young account is held back; a warm, healthy one is allowed more. */
  warmupFactor() {
    if (!this.warmup.enabled) return 1;
    const day = this.warmup.status().accountDay;
    if (day <= 0) return 0.6;
    if (day === 1) return 0.75;
    if (day === 2) return 0.85;
    if (day < 7) return 0.95;
    return 1;
  }
  applyAdaptive() {
    const f = this.health.throughputFactor(this.warmupFactor());
    this.limiter.applyFactor(f);
    return f;
  }

  /* ── sockets & background ────────────────────────────────────────── */

  setSocket(sock) {
    this.presence.setSocket(sock);
    if (this.enabled && !this._bgTimer) this._schedulePulse();
  }
  /** Re-randomised every time, so the "am I alive" pulse is not metronomic. */
  _schedulePulse() {
    const wait = 45 * 60_000 + Math.floor(Math.random() * 20 * 60_000);
    this._bgTimer = setTimeout(() => {
      if (Math.random() < 0.5) this.presence.pulseAvailable().catch(() => {});
      this._bgTimer = null;
      if (this.enabled) this._schedulePulse();
    }, wait);
    this._bgTimer.unref?.();
  }
  /** Flush everything to disk — call on shutdown and before a crash exit. */
  stop() {
    if (this._bgTimer) clearTimeout(this._bgTimer);
    this._bgTimer = null;
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try { this.warmup.flush?.(); } catch {}
    this.saveNow();
  }

  noteDisconnect(code) {
    this.health.noteDisconnect(code);
    const pause = this.health.suggestedPauseMs();
    if (pause > 0) this.limiter.pause(pause);
    this.applyAdaptive();
    this.scheduleSave();
  }
  noteConnected() {
    this.health.noteGoodConnection();
    this.applyAdaptive();
    this.scheduleSave();
  }

  /* ── inbound: start the human clock NOW ──────────────────────────── */

  /**
   * Called the moment a message arrives (before the command runs).
   * Raises the typing indicator and refreshes the adaptive limits, so the
   * pacing budget overlaps the work instead of being added to it.
   */
  onInbound(jid, { sock = null, text = '' } = {}) {
    if (!this.enabled || !jid) return false;
    this.applyAdaptive();
    // fire and forget — never delay the router
    this.presence.startTyping(jid, sock, text ? { text } : null).catch(() => {});
    return true;
  }

/**
   * Called after the router is done with a message. If nothing was sent,
   * the indicator is dropped — the bot must not look like it is typing and
   * then stay silent.
   */
  finishInbound(jid, { sock = null } = {}) {
    if (!this.enabled || !jid) return false;
    if (!this.presence.isTyping(jid)) return false;   // a reply already cleared it
    this.presence.cancelTyping(jid, sock).catch(() => {});
    return true;
  }

  /** How much of the menu-envelope (probe) budget is left in this window. */
  probeBudget() { return this.limiter.probeAllowed(); }

  /**
   * Pace an interactive/menu send (a "probe"). Returns `null` when the card
   * may go out, or an Error carrying `.probeBudget = true` when the card
   * budget is spent — callers must then stop trying envelopes and fall back
   * to the image/text menu instead of hammering WhatsApp.
   */
  async probeGate(jid, content, { sock = null, probeMaxMs = null } = {}) {
    const paced = await this.beforeOutbound(jid, content, {
      probe: true, sock, ...(probeMaxMs != null ? { probeMaxMs } : {}),
    });
    if (paced && paced.probeBlocked) {
      const secs = Math.max(1, Math.round((paced.retryMs || 1000) / 1000));
      const err = new Error(`menu card budget spent — retry in ${secs}s`);
      err.probeBudget = true;
      err.retryMs = paced.retryMs || 0;
      return err;
    }
    return null;
  }

  /* ── outbound pacing ─────────────────────────────────────────────── */

  async beforeOutbound(jid, content, options = {}) {
    const sock = options.sock || null;
    if (!this.enabled) return { delayed: 0 };
    const isEdit = !!options.isEdit;
    const skipPresence = !!options.skipPresence || isEdit;

    if (options.probe) {
      this.probeStats.tried++;
      // A health pause means "send nothing at all" — the menu must fall back
      // to the image card straight away instead of stalling for seconds.
      if (this.limiter.isPaused()) {
        this.probeStats.budgetBlocked++;
        return {
          delayed: 0, probe: true, probeBlocked: true, reason: 'health_pause',
          retryMs: Math.max(0, this.limiter.pausedUntil - Date.now()),
        };
      }
      // Probes are real outbound traffic: they get their own budget so a
      // burst of menu requests cannot fire 30 messages in a second.
      const budget = this.limiter.probeAllowed();
      if (!budget.allowed) {
        this.probeStats.budgetBlocked++;
        return { delayed: 0, probe: true, probeBlocked: true, retryMs: budget.retryMs };
      }
      this.limiter.recordProbe();
      const plan = this.limiter.compute(jid, content, { isEdit: false, skipTyping: true });
      if (plan.blocked) await sleep(Math.min(plan.delayMs || 1000, PROBE_BLOCK_WAIT_MS));
      if (!skipPresence) {
        await this.presence.beforeSend(jid, content, { skip: false, maxMs: options.probeMaxMs ?? 700, sock });
      }
      return { delayed: 0, probe: true };
    }

    // Daily warm-up cap: the first message pays, the next ones barely do.
    if (!isEdit && !this.warmup.canSend()) {
      const sincePenalty = Date.now() - this._lastPenaltyAt;
      const penalty = sincePenalty < 60_000 ? WARMUP_PENALTY_REPEAT_MS : WARMUP_PENALTY_MS;
      this._lastPenaltyAt = Date.now();
      if (penalty > 0) await sleep(penalty + Math.floor(Math.random() * 1500));
    }

    let plan = this.limiter.compute(jid, content, { isEdit, skipPresence: skipPresence, skipTyping: skipPresence });
    let waited = 0;
    while (plan.blocked && waited < MAX_BLOCK_WAIT_MS) {
      const wait = Math.min(plan.delayMs || 5000, 5000, MAX_BLOCK_WAIT_MS - waited);
      if (wait <= 0) break;
      await sleep(wait);
      waited += wait;
      plan = this.limiter.compute(jid, content, { isEdit, skipTyping: skipPresence });
    }
    if (plan.blocked) this.limiter.noteOverrun();

    // One wall-time budget per message. The typing indicator has usually
    // been up since the message ARRIVED (onInbound), so most of this budget
    // is already spent — presence subtracts it and only the remainder is
    // actually waited out.
    let budget = plan.delayMs;
    if (!isEdit && !plan.isNew) budget = Math.min(budget, isShortReply(content) ? SHORT_MAX_MS : REPLY_MAX_MS);
    const already = this.presence.elapsed(jid);
    let slept = 0;
    let quiet = 0;

    if (!isEdit && !skipPresence) {
      slept = (await this.presence.beforeSend(jid, content, {
        skip: false, maxMs: budget, sock,
        composeCapMs: plan.isNew ? NEW_CHAT_TYPING_MS : null,
      })) || 0;
      // Media-only messages have no text to "type": let whatever is still
      // left of the budget pass quietly, so pacing stays human.
      quiet = Math.max(0, budget - already - slept);
      if (quiet > 30 && !hasText(content)) await sleep(quiet);
      else quiet = 0;
    } else {
      quiet = Math.max(0, budget - already);
      if (quiet > 30) await sleep(quiet);
    }
    return {
      delayed: slept + quiet, absorbed: already, waited,
      isNew: plan.isNew, blocked: plan.blocked, reason: plan.reason,
    };
  }

  afterOutbound(jid, ok, err, options = {}) {
    if (!this.enabled) return;
    if (options.probe) {
      if (ok) {
        this.probeStats.delivered++;
        this.limiter.record(jid);
        this.warmup.recordSend();
        this.health.noteSendOk();
        this.presence.afterSend(jid).catch(() => {});
      } else {
        this.probeStats.rejected++;
        log.debug?.(`[antiban] envelope rejected (not counted as a failure): ${err?.message || err}`);
      }
      this.applyAdaptive();
      this.scheduleSave();
      return;
    }
    if (ok) {
      this.limiter.record(jid);
      this.warmup.recordSend();
      this.health.noteSendOk();
      this.presence.afterSend(jid).catch(() => {});
    } else if (err) {
      const kind = this.health.noteSendFail(err);
      const pause = this.health.suggestedPauseMs();
      if (pause > 0) this.limiter.pause(pause);
      if (kind !== 'benign') log.warn(`[antiban] send failure (${kind}): ${String(err?.message || err).slice(0, 100)}`);
    }
    this.applyAdaptive();
    this.scheduleSave();
  }

  /** Classify an error without recording it — used by diagnostics/tests. */
  classify(err) { return classifyError(err); }

  status() {
    return {
      enabled: this.enabled,
      preset: this.presetName,
      rate: this.limiter.status(),
      health: this.health.status(),
      warmup: this.warmup.status(),
      typing: this.presence.enabled,
      presence: this.presence.status(),
      adaptive: {
        factor: Number(this.limiter.factor.toFixed(2)),
        warmupFactor: Number(this.warmupFactor().toFixed(2)),
        effectivePerMinute: this.limiter.maxPerMinute,
      },
      probes: { ...this.probeStats, budget: { ...this.limiter.status().probes } },
      caps: { shortReplyMs: SHORT_MAX_MS, knownChatMs: REPLY_MAX_MS, maxBlockMs: MAX_BLOCK_WAIT_MS },
      restored: !!this.restored,
    };
  }

  setEnabled(value) { this.enabled = !!value; }

  setPreset(name) {
    const key = String(name || '').toLowerCase();
    if (!PRESETS[key]) return null;
    this.presetName = key;
    const p = PRESETS[key];
    this.limiter.applyLimits({
      maxPerMinute: p.maxPerMinute,
      maxPerHour: p.maxPerHour,
      maxPerDay: p.maxPerDay,
      minDelayMs: p.minDelayMs,
      maxDelayMs: p.maxDelayMs,
      newChatDelayMs: p.newChatDelayMs,
    });
    this.applyAdaptive();
    this.scheduleSave();
    return key;
  }

  /** Full reset: health score, ban signals, rate pause, probe budget. */
  reset() {
    this.health.reset();
    this.limiter.clearPause();
    this.limiter.clearCounters();
    this.probeStats = { tried: 0, rejected: 0, delivered: 0, budgetBlocked: 0 };
    this.applyAdaptive();
    this.saveNow();
    return this.status();
  }
}

function hasText(content) {
  return !!(content && (typeof content.text === 'string' && content.text.length) || (content && typeof content.caption === 'string' && content.caption.length));
}
function textLen(content) {
  if (!content || typeof content !== 'object') return 0;
  if (typeof content.text === 'string') return content.text.length;
  if (typeof content.caption === 'string') return content.caption.length;
  return 0;
}
function isShortReply(content) {
  const len = textLen(content);
  return len > 0 && len < 80 && !content.image && !content.video && !content.document && !content.sticker;
}

const antiban = new AntiBan();
module.exports = antiban;
module.exports.AntiBan = AntiBan;
module.exports.PRESETS = PRESETS;
module.exports.MAX_BLOCK_WAIT_MS = MAX_BLOCK_WAIT_MS;
module.exports.SHORT_MAX_MS = SHORT_MAX_MS;
module.exports.NEW_CHAT_TYPING_MS = NEW_CHAT_TYPING_MS;
module.exports.REPLY_MAX_MS = REPLY_MAX_MS;
