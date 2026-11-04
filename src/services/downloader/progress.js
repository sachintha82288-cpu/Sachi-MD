const { human } = require('./cleanup');
const config = require('../../config');

function percent(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

function bar(value, width = 14) {
  const p = percent(value);
  if (p === null) return '░'.repeat(width);
  const filled = Math.round((p / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function formatProgress(p = {}) {
  const pct = percent(p.percent);
  const parts = [`${bar(pct)} ${pct === null ? '--' : pct.toFixed(1)}%`];
  if (p.downloaded != null) parts.push(`📦 ${human(p.downloaded)}${p.total ? ` / ${human(p.total)}` : ''}`);
  if (p.speed) parts.push(`⚡ ${p.speed}`);
  if (p.eta) parts.push(`⏱️ ${p.eta}`);
  if (p.phase) parts.push(`
${p.phase}`);
  return parts.join('  ');
}

function createProgressReporter({ send, edit, jid, quoted, title = 'Downloading' } = {}) {
  let key = null;
  let lastAt = 0;
  let lastText = '';
  let finished = false;
  const interval = config.limits.progressUpdateMs;

  async function ensure(initial = {}) {
    if (key) return key;
    const sent = await send(jid, { text: `⬇️ *${title}*\n\n${formatProgress({ ...initial, phase: initial.phase || 'Preparing download…' })}` }, { quoted });
    key = sent?.key || null;
    lastText = sent ? formatProgress(initial) : '';
    return key;
  }

  async function update(p = {}, force = false) {
    if (finished) return;
    if (!key) {
      try { await ensure(p); } catch { return; } // can't post the status card — keep downloading silently
    }
    const now = Date.now();
    if (!force && now - lastAt < interval) return;
    lastAt = now;
    const text = `⬇️ *${title}*\n\n${formatProgress(p)}`;
    if (text === lastText) return;
    lastText = text;
    if (key) {
      try { await edit(key, text); } catch {}
    }
  }

  async function done({ phase = 'Download complete', downloaded, total, speed } = {}) {
    if (finished) return;
    finished = true;
    const text = `✅ *${title}*\n\n${formatProgress({ percent: 100, downloaded, total, speed, phase })}`;
    if (key) { try { await edit(key, text); } catch {} }
  }

  async function fail(message = 'Download failed') {
    if (finished) return;
    finished = true;
    if (key) { try { await edit(key, `❌ *${title}*\n\n${message}`); return; } catch {} }
    try { await send(jid, { text: `❌ *${title}*\n\n${message}` }, { quoted }); } catch {}
  }

  function setKey(value) { key = value || null; }
  return { ensure, update, done, fail, setKey };
}

module.exports = { createProgressReporter, formatProgress, bar };
