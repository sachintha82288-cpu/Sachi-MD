const VIDEO_QUALITIES = [144, 240, 360, 480, 720, 1080, 1440, 2160];
const AUDIO_QUALITIES = [64, 96, 128, 160, 192, 256, 320];
function parseChoice(value, allowed, fallback) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw || raw === 'auto') return { value: fallback, auto: true, best: false };
  if (raw === 'best' || raw === 'max') return { value: allowed[allowed.length - 1], auto: false, best: true };
  const n = Number(raw.replace(/p$/i, '').replace(/k$/i, ''));
  if (!Number.isInteger(n) || !allowed.includes(n)) return null;
  return { value: n, auto: false, best: false };
}
function parseVideoQuality(value) { return parseChoice(value, VIDEO_QUALITIES, 1080); }
function parseAudioQuality(value) { return parseChoice(value, AUDIO_QUALITIES, 192); }
function videoFormat(quality, best = false) {
  if (best) return 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b';
  return `bv*[height<=${quality}][ext=mp4]+ba[ext=m4a]/b[height<=${quality}][ext=mp4]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`;
}
function audioFormat(quality, best = false) {
  if (best) return 'ba/b';
  return `ba[abr<=${quality}][ext=m4a]/ba[abr<=${quality}]/ba[ext=m4a]/ba/b`;
}
function videoUsage(prefix, command = 'ytv') {
  return `Usage: ${prefix}${command} <YouTube URL> [quality]\nQuality: auto, best, ${VIDEO_QUALITIES.map((q) => `${q}p`).join(', ')}`;
}
function audioUsage(prefix, command = 'yta') {
  return `Usage: ${prefix}${command} <YouTube URL> [quality]\nBitrate: auto, best, ${AUDIO_QUALITIES.map((q) => `${q}k`).join(', ')}`;
}
module.exports = { VIDEO_QUALITIES, AUDIO_QUALITIES, parseVideoQuality, parseAudioQuality, videoFormat, audioFormat, videoUsage, audioUsage };
