const path = require('path');
const { atomicJsonWrite, safeJsonRead } = require('../../utils/files');
class WarmUp {
  constructor(dataDir, opts = {}) {
    this.file = path.join(dataDir, 'antiban-warmup.json');
    this.enabled = opts.enabled !== false;
    this.days = opts.days ?? 7;
    this.schedule = opts.schedule || [40, 80, 120, 200, 350, 500, 800];
    this.state = safeJsonRead(this.file, null) || { firstSeen: Date.now(), dayCounts: {} };
    this._saveTimer = null;
    try { atomicJsonWrite(this.file, this.state); } catch {}
  }
  _dayKey(ts = Date.now()) { return new Date(ts).toISOString().slice(0, 10); }
  _accountDay() {
    const ageMs = Date.now() - (this.state.firstSeen || Date.now());
    return Math.floor(ageMs / (24 * 60 * 60 * 1000));
  }
  /**
   * Debounced: the daily counter is written at most once every couple of
   * seconds instead of on every single outbound message.
   */
  _persist() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.flush(); }, 2000);
    this._saveTimer.unref?.();
  }
  flush() {
    try { atomicJsonWrite(this.file, this.state); return true; } catch { return false; }
  }
  serialize() { return { ...this.state, dayCounts: { ...this.state.dayCounts } }; }
  dailyCap() {
    if (!this.enabled) return null;
    const day = this._accountDay();
    if (day >= this.schedule.length) return null;
    return this.schedule[Math.min(day, this.schedule.length - 1)];
  }
  todayCount() { return this.state.dayCounts[this._dayKey()] || 0; }
  canSend() {
    const cap = this.dailyCap();
    if (cap == null) return true;
    return this.todayCount() < cap;
  }
  recordSend() {
    if (!this.enabled) return;
    const key = this._dayKey();
    this.state.dayCounts[key] = (this.state.dayCounts[key] || 0) + 1;
    const keys = Object.keys(this.state.dayCounts).sort();
    while (keys.length > 14) delete this.state.dayCounts[keys.shift()];
    this._persist();
  }
  status() {
    const day = this._accountDay();
    const cap = this.dailyCap();
    return {
      enabled: this.enabled,
      accountDay: day,
      warmupDays: this.days,
      dailyCap: cap,
      todayCount: this.todayCount(),
      fullyWarmed: cap == null,
      firstSeen: this.state.firstSeen,
    };
  }
}
module.exports = { WarmUp };
