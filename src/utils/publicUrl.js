/**
 * "What address can people actually OPEN?" — the pair page URL.
 *
 * On Pterodactyl the server gets a public IP and one or more allocated
 * ports, but neither is handed to the process in a documented variable, so
 * the owner ends up guessing. This works it out in layers and prints a
 * clickable link (and a QR code) in the terminal at boot:
 *
 *   1. PAIR_PUBLIC_URL / PUBLIC_URL      — the owner told us exactly
 *   2. panel/node env vars               — P_SERVER_ALLOCATION_IP, SERVER_IP, …
 *   3. the port the HTTP server bound to — server.address().port
 *   4. the machine's PUBLIC ip           — DNS (OpenDNS) → HTTPS (ipify),
 *                                          cached for the life of the process
 *   5. fallback: the LAN ip              — with an honest warning
 *
 * Nothing here may ever block the boot: every lookup has a short timeout and
 * every failure degrades to the next layer.
 */
const os = require('os');
const dns = require('dns');
const config = require('../config');
const log = require('./logger');

const LOOKUP_TIMEOUT_MS = () => Math.max(800, Number(process.env.PUBLIC_IP_TIMEOUT_MS) || 2500);
const IP_CACHE_MS = 10 * 60_000;

let cached = null;          // { ip, at, source }
let lastUrl = null;

function isPrivate(ip) {
  const s = String(ip || '');
  return /^(10\.|127\.|0\.|169\.254\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(s)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(s)
    || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80');
}

/** Every IPv4 the machine owns, most-likely-public first. */
function localIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      out.push(i.address);
    }
  }
  return out.sort((a, b) => (isPrivate(a) ? 1 : 0) - (isPrivate(b) ? 1 : 0));
}

/** Public IP as the outside world sees it — DNS first (fast, no HTTP). */
async function publicIpByDns(timeoutMs) {
  const resolver = new dns.promises.Resolver({ timeout: Math.max(500, timeoutMs) });
  try { resolver.setServers(['208.67.222.222:53', '1.1.1.1:53']); } catch { return null; }
  try {
    const answers = await Promise.race([
      resolver.resolve4('myip.opendns.com'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    const ip = Array.isArray(answers) ? answers[0] : null;
    return ip && !isPrivate(ip) ? ip : null;
  } catch { return null; }
}

async function publicIpByHttp(timeoutMs) {
  const hosts = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];
  for (const url of hosts) {
    try {
      const axios = require('axios');
      const r = await axios.get(url, { timeout: timeoutMs, responseType: 'text', transformResponse: [(d) => d] });
      const ip = String(r.data || '').trim().split('\n')[0].trim();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !isPrivate(ip)) return ip;
    } catch { /* next host */ }
  }
  return null;
}

/** The machine's public IP, cached. `null` when it cannot be determined. */
async function getPublicIp({ force = false } = {}) {
  if (!force && cached && Date.now() - cached.at < IP_CACHE_MS) return cached.ip;
  const t = LOOKUP_TIMEOUT_MS();
  let ip = await publicIpByDns(t);
  let source = ip ? 'dns' : null;
  if (!ip) { ip = await publicIpByHttp(t); source = ip ? 'http' : null; }
  cached = { ip: ip || null, at: Date.now(), source };
  return cached.ip;
}

/** Ports worth advertising: the bound one first, then anything else obvious. */
function candidatePorts(boundPort) {
  const list = [];
  const push = (p) => {
    const n = Number(p);
    if (Number.isFinite(n) && n > 0 && n < 65536 && !list.includes(n)) list.push(n);
  };
  push(boundPort);
  push(process.env.PAIR_PORT);
  push(process.env.SERVER_PORT);
  push(process.env.PORT);
  push(process.env.P_SERVER_ALLOCATION_PORT);
  push(process.env.SERVER_ALLOCATION_PORT);
  push(config.port);
  return list;
}

function envUrl() {
  for (const k of ['PAIR_PUBLIC_URL', 'PUBLIC_URL', 'SITE_URL', 'PANEL_PUBLIC_URL']) {
    const v = String(process.env[k] || '').trim();
    if (!v) continue;
    const withProto = /^https?:\/\//i.test(v) ? v : `http://${v}`;
    try {
      const u = new URL(withProto);
      if (u.hostname) return { url: withProto.replace(/\/$/, ''), ip: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)), source: `env:${k}` };
    } catch { /* keep looking */ }
  }
  return null;
}

function envIp() {
  for (const k of ['P_SERVER_ALLOCATION_IP', 'SERVER_ALLOCATION_IP', 'SERVER_IP', 'PANEL_IP', 'PUBLIC_IP', 'P_SERVER_NODE_FQDN']) {
    const v = String(process.env[k] || '').trim();
    if (v && !/\s/.test(v)) return { ip: v, source: `env:${k}` };
  }
  return null;
}

/**
 * Work out the URL to print. `boundPort` is what the HTTP server actually
 * bound to (`server.address().port`) — that is the port the panel maps.
 */
async function discover({ boundPort = null, path = '/', scheme = null } = {}) {
  // `scheme = null` means "do not care" — then an explicit URL keeps its own
  // protocol and a constructed URL defaults to http (back-compat). When the
  // caller knows what it serves (the web server does), that wins: a link that
  // opens beats a link that matches .env.
  const proto = scheme ? (String(scheme).replace(/:$/, '') || 'http') : null;
  const finalProto = proto || 'http';
  const explicit = envUrl();
  if (explicit) {
    lastUrl = { ...explicit, isPublic: !isPrivate(explicit.ip), notes: [], ports: candidatePorts(boundPort) };
    // The protocol is decided by what the server actually serves, not by what
    // was pasted into .env: an owner who writes http://… while the bot is
    // serving HTTPS must still get a link that opens.
    if (proto === 'https' && /^http:\/\//i.test(lastUrl.url)) {
      lastUrl.url = lastUrl.url.replace(/^http:\/\//i, 'https://');
    } else if (proto === 'http' && /^https:\/\//i.test(lastUrl.url)) {
      lastUrl.url = lastUrl.url.replace(/^https:\/\//i, 'http://');
    }
    return lastUrl;
  }
  const fromEnv = envIp();
  const ip = fromEnv?.ip || (await getPublicIp()) || localIps()[0] || '127.0.0.1';
  const source = fromEnv ? fromEnv.source : (cached?.source ? `lookup:${cached.source}` : 'interface');
  const ports = candidatePorts(boundPort);
  const port = ports[0] || config.port;
  const notes = [];
  if (isPrivate(ip)) {
    notes.push('That address is PRIVATE — people outside this machine cannot open it.');
    notes.push('Pterodactyl: open the ALLOCATIONS tab, copy the public IP:port it lists, and put it in .env as PAIR_PUBLIC_URL.');
  }
  if (!fromEnv && !cached?.ip) notes.push('No public IP could be looked up (no outbound DNS/HTTP?) — set PAIR_PUBLIC_URL in .env.');
  lastUrl = { url: `${finalProto}://${ip}:${port}${path}`, ip, port, scheme: finalProto, source, isPublic: !isPrivate(ip), notes, ports };
  return lastUrl;
}

/** The URL from the last discovery (no lookups) — for `.settings` and the API. */
function current() { return lastUrl; }

/** How many terminal cells a string takes (emoji/symbols count double). */
function dispWidth(s) {
  let n = 0;
  for (const ch of String(s == null ? '' : s)) {
    const cp = ch.codePointAt(0);
    const wide = cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf) || cp === 0xfe0f;
    n += wide ? 2 : 1;
  }
  return n;
}

/** Terminal box + a QR code you can scan with the phone you are pairing. */
function banner(info, { qr = true, tls = false, certSource = '' } = {}) {
  if (!info?.url) return;
  const lines = [
    '🌐  PAIR WEBSITE',
    '',
    info.url,
    '',
    info.isPublic ? 'Open it on any phone → enter a number → get a code' : '⚠ NOT a public address — see the note below',
    `detected via ${info.source || 'interface'} · port ${info.port} · ${tls ? 'HTTPS' : 'HTTP'}`,
  ];
  if (tls && certSource !== 'env') {
    lines.push('self-signed cert: the browser warns ONCE → Advanced → Continue');
  }
  // Terminals render emoji and symbols two cells wide, so the box is measured
  // in DISPLAY cells, not code points — otherwise the right edge wanders.
  const W = Math.min(78, Math.max(40, ...lines.map((l) => dispWidth(l) + 4)));
  const c = (s) => {
    s = String(s);
    const n = dispWidth(s);
    const l = Math.max(0, Math.floor((W - n) / 2));
    return ' '.repeat(l) + s + ' '.repeat(Math.max(0, W - n - l));
  };
  const row = (s = '') => '║ ' + c(s) + ' ║';
  const top = '╔' + '═'.repeat(W + 2) + '╗';
  const bot = '╚' + '═'.repeat(W + 2) + '╝';
  console.log('\n' + top);
  for (const l of lines) console.log(row(l));
  console.log(bot + '\n');
  for (const n of info.notes || []) log.warn(`[pair-site] ${n}`);
  if (qr && process.env.PAIR_QR !== 'false') {
    try {
      const qrTerm = require('qrcode-terminal');
      qrTerm.setErrorLevel('L');
      qrTerm.generate(info.url, { small: true }, (out) => {
        console.log(out);
        console.log('  ↑ scan with the phone you want to pair\n');
      });
    } catch { /* the QR is a nicety — never let it break the boot */ }
  }
}

module.exports = { discover, current, getPublicIp, localIps, isPrivate, banner, candidatePorts, dispWidth };
