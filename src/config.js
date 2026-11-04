const fs = require('fs');
const path = require('path');
// .env is loaded here too: tests and tools require('src/config') directly
// without going through index.js. Idempotent — index.js also calls it.
require('./utils/envLoader').loadEnv();
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const settingsFile = path.join(DATA, 'settings.json');
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
let persisted = {};
try { if (fs.existsSync(settingsFile)) persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}

const config = {
  botName: persisted.botName || process.env.BOT_NAME || 'Sachi MD',
  /** The name before the owner customised it (used by .resetname). */
  defaultBotName: process.env.BOT_NAME || 'Sachi MD',
  version: require('../package.json').version,
  prefix: persisted.prefix || process.env.BOT_PREFIX || '.',
  owner: '',
  /** Where the bot listens: self | inbox | public | groups | all. */
  mode: persisted.mode || process.env.BOT_MODE || 'all',
  /** Menu card header title (empty = none). */
  header: persisted.header || '',
  /** Menu card footer line (empty = the default). */
  footer: persisted.footer || '',
  /** Custom logo file, relative to the project root. */
  logo: persisted.logo || '',
  /** Who may run .tagall — owner | admin | all (default: all). */
  tagallPerm: (persisted.tagallPerm || process.env.TAGALL_PERMISSION || 'all').toLowerCase(),
  sessionName: process.env.SESSION_NAME || 'sessions',
  allowGroups: process.env.ALLOW_GROUPS !== 'false',
  ownerOnly: process.env.OWNER_ONLY === 'true',
  port: Number(process.env.SERVER_PORT || process.env.PORT || 3000),
  phoneNumber: process.env.WA_PHONE_NUMBER || '94750404115',
  /** Only this number may unpair connected sessions (.unpair). */
  ownerNumber: String(process.env.WA_PHONE_NUMBER || '94750404115').replace(/\D/g, ''),
  proxy: {
    enabled: process.env.V2RAY_SUB_URL ? process.env.PROXY_ENABLED !== 'false' : process.env.PROXY_ENABLED === 'true',
    subscriptionUrl: process.env.V2RAY_SUB_URL || '',
    refreshMinutes: Math.max(5, Number(process.env.PROXY_REFRESH_MINUTES || 30)),
    requestTimeoutMs: Math.max(5000, Number(process.env.PROXY_REQUEST_TIMEOUT_MS || 30000)),
    healthTimeoutMs: Math.max(3000, Number(process.env.PROXY_HEALTH_TIMEOUT_MS || 10000))
  },
  limits: {
    videoMB: Number(process.env.MAX_VIDEO_MB || 100),
    audioMB: Number(process.env.MAX_AUDIO_MB || 50),
    directMB: Number(process.env.MAX_DIRECT_MB || 80),
    mediafireGB: Number(process.env.MAX_MEDIAFIRE_GB || 10),
    apkMB: Math.max(1, Number(process.env.MAX_APK_MB) > 0 ? Number(process.env.MAX_APK_MB) : 500),
    concurrentDownloads: Math.max(1, Number(process.env.MAX_CONCURRENT_DOWNLOADS || 3)),
    maxRedirects: Math.max(0, Math.min(10, Number(process.env.MAX_REDIRECTS || 5))),
    memoryDownloads: process.env.RAM_DOWNLOADS !== 'false',
    progressUpdateMs: Math.max(700, Number(process.env.PROGRESS_UPDATE_MS || 1200))
  },
  antiban: {
    enabled: process.env.ANTIBAN_ENABLED !== 'false',
    preset: (process.env.ANTIBAN_PRESET || 'moderate').toLowerCase(),
    maxPerMinute: process.env.ANTIBAN_MAX_PER_MINUTE ? Number(process.env.ANTIBAN_MAX_PER_MINUTE) : undefined,
    maxPerHour: process.env.ANTIBAN_MAX_PER_HOUR ? Number(process.env.ANTIBAN_MAX_PER_HOUR) : undefined,
    maxPerDay: process.env.ANTIBAN_MAX_PER_DAY ? Number(process.env.ANTIBAN_MAX_PER_DAY) : undefined,
    minDelayMs: process.env.ANTIBAN_MIN_DELAY ? Number(process.env.ANTIBAN_MIN_DELAY) : undefined,
    maxDelayMs: process.env.ANTIBAN_MAX_DELAY ? Number(process.env.ANTIBAN_MAX_DELAY) : undefined,
    newChatDelayMs: process.env.ANTIBAN_NEW_CHAT_DELAY ? Number(process.env.ANTIBAN_NEW_CHAT_DELAY) : undefined,
    typing: process.env.ANTIBAN_TYPING !== 'false',
    typingWpm: Number(process.env.ANTIBAN_TYPING_WPM || 42),
    warmup: process.env.ANTIBAN_WARMUP !== 'false'
  }
};
config.paths = {
  root: ROOT, data: DATA, settings: settingsFile,
  session: path.join(ROOT, config.sessionName),
  bin: path.join(ROOT, 'bin'),
  temp: path.join(DATA, 'tmp'),
  proxyCache: path.join(DATA, 'proxy-cache.json'),
  proxyConfig: path.join(DATA, 'xray-config.json')
};
module.exports = config;
