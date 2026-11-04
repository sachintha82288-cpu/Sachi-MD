/**
 * TLS for the pair website — HTTPS on the panel's one allocated port.
 *
 * A certificate is needed, and on a panel there is normally no domain and no
 * reverse proxy, so the order is:
 *
 *   1. `SSL_CERT_PATH` + `SSL_KEY_PATH` (also `HTTPS_CERT` / `HTTPS_KEY`) —
 *      a REAL certificate: Let's Encrypt through the panel, a Cloudflare
 *      origin cert, a reverse proxy in front. No browser warning at all.
 *   2. `data/tls/{cert.pem,key.pem}` — what this bot generated last time. It
 *      is REUSED across restarts on purpose: the browser warning is accepted
 *      once and then stays accepted, and the certificate does not churn.
 *   3. Generate a self-signed one (RSA 2048, SHA-256, 10 years) with SANs for
 *      localhost, every local IP and the detected public IP, and store it.
 *
 * Nothing here may block the boot for long: generation is ~1 s the first time
 * and every failure degrades to "no TLS" with a loud log line, because a bot
 * with no website at all is worse than one with a warning.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const config = require('../config');
const log = require('../utils/logger');

const TLS_DIR = () => path.join(config.paths.data, 'tls');
const CERT_FILE = () => path.join(TLS_DIR(), 'cert.pem');
const KEY_FILE = () => path.join(TLS_DIR(), 'key.pem');

let cached = null;

function envPaths() {
  const cert = String(process.env.SSL_CERT_PATH || process.env.HTTPS_CERT || process.env.SSL_CERT || '').trim();
  const key = String(process.env.SSL_KEY_PATH || process.env.HTTPS_KEY || process.env.SSL_KEY || '').trim();
  if (!cert && !key) return null;
  if (!cert || !key) {
    log.warn('[tls] Both SSL_CERT_PATH and SSL_KEY_PATH are needed — falling back to the bot\'s own certificate.');
    return null;
  }
  const abs = (p) => (path.isAbsolute(p) ? p : path.join(config.paths.root, p));
  const c = abs(cert), k = abs(key);
  if (!fs.existsSync(c) || !fs.existsSync(k)) {
    log.error(`[tls] Certificate files not found (${c} / ${k}) — falling back to the bot's own certificate.`);
    return null;
  }
  return { cert: fs.readFileSync(c), key: fs.readFileSync(k), source: `env:${cert}` };
}

function stored() {
  try {
    if (!fs.existsSync(CERT_FILE()) || !fs.existsSync(KEY_FILE())) return null;
    const cert = fs.readFileSync(CERT_FILE());
    const key = fs.readFileSync(KEY_FILE());
    if (!cert.length || !key.length) return null;
    if (!/BEGIN CERTIFICATE/.test(cert.toString()) || !/PRIVATE KEY/.test(key.toString())) return null;

    // A stored certificate is only useful if it still works. Serving an
    // expired one, or a key that does not belong to it, fails inside every
    // TLS handshake — the browser shows a hard certificate error and the site
    // is simply dead, with nothing in the log to explain it. Check both here
    // and regenerate instead.
    let validTo = null;
    try {
      const x509 = new crypto.X509Certificate(cert);
      validTo = new Date(x509.validTo).toISOString().slice(0, 10);
      const expiresAt = Date.parse(x509.validTo);
      if (Number.isFinite(expiresAt) && expiresAt - Date.now() < 7 * 86400_000) {
        log.warn('[tls] the stored certificate expires within a week — generating a fresh one');
        return null;
      }
      const keyObj = crypto.createPrivateKey(key);
      if (typeof x509.checkPrivateKey === 'function' && !x509.checkPrivateKey(keyObj)) {
        log.warn('[tls] data/tls/key.pem does not match cert.pem — generating a fresh pair');
        return null;
      }
    } catch (e) {
      log.warn(`[tls] the stored certificate is unusable (${e.message}) — generating a fresh one`);
      return null;
    }
    return { cert, key, source: 'data/tls', validTo };
  } catch (e) {
    log.warn(`[tls] Could not read the stored certificate: ${e.message}`);
    return null;
  }
}

/** Every address worth putting in the certificate's SAN list. */
function sanAddresses(extraHosts = []) {
  const altNames = [{ type: 2, value: 'localhost' }];
  const seen = new Set(['localhost']);
  const addIp = (ip) => {
    if (!ip || seen.has(ip)) return;
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !/^[0-9a-f:]+$/i.test(ip)) return;
    seen.add(ip);
    altNames.push({ type: 7, ip });
  };
  const addDns = (name) => {
    if (!name || seen.has(name)) return;
    if (!/^[a-z0-9.-]+$/i.test(name)) return;      // never inject junk into a cert
    seen.add(name);
    altNames.push({ type: 2, value: name });
  };
  addIp('127.0.0.1');
  addIp('::1');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4') addIp(i.address);
  }
  for (const h of extraHosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) addIp(h);
    else addDns(h);
  }
  return altNames;
}

async function generate(extraHosts = []) {
  let selfsigned;
  try { selfsigned = require('selfsigned'); }
  catch (e) {
    log.error(`[tls] The 'selfsigned' package is missing (${e.message}) — run npm install. Serving without HTTPS.`);
    return null;
  }
  const host = String(extraHosts[0] || os.hostname() || 'sachi-bot').split(':')[0];
  const cn = /^[a-z0-9.-]+$/i.test(host) ? host : 'sachi-bot';
  const attrs = [{ name: 'commonName', value: cn }, { name: 'organizationName', value: 'Sachi MD' }];
  const days = Math.max(30, Number(process.env.SSL_DAYS || 3650));
  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    days,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: sanAddresses(extraHosts) },
    ],
  });
  if (!pems?.cert || !pems?.private) {
    log.error('[tls] Certificate generation returned nothing usable — serving without HTTPS.');
    return null;
  }
  // The generator may cap the lifetime (Apple/Chrome reject long-lived leaf
  // certificates), so never claim a duration — read the real one back.
  let validTo = null;
  try {
    const x = new crypto.X509Certificate(pems.cert);
    validTo = new Date(x.validTo).toISOString().slice(0, 10);
  } catch {}
  try {
    fs.mkdirSync(TLS_DIR(), { recursive: true });
    fs.writeFileSync(CERT_FILE(), pems.cert, { mode: 0o644 });
    fs.writeFileSync(KEY_FILE(), pems.private, { mode: 0o600 });
    if (pems.public) fs.writeFileSync(path.join(TLS_DIR(), 'public.pem'), pems.public, { mode: 0o644 });
  } catch (e) {
    log.warn(`[tls] Certificate generated but could not be stored (${e.message}) — it will be regenerated next boot.`);
  }
  return { cert: Buffer.from(pems.cert), key: Buffer.from(pems.private), source: 'generated', cn, validTo };
}

/**
 * The TLS material to serve with. `extraHosts` should include the address the
 * bot printed, so the certificate covers it.
 */
async function load({ extraHosts = [], force = false } = {}) {
  if (cached && !force) return cached;
  const explicit = envPaths();
  if (explicit) { cached = { ...explicit, tls: true }; return cached; }
  const reused = stored();
  if (reused) {
    cached = { ...reused, tls: true };
    log.info('[tls] using the stored certificate in data/tls (browser warning already accepted once)');
    return cached;
  }
  const made = await generate(extraHosts);
  if (!made) { cached = { tls: false, source: 'none' }; return cached; }
  cached = { ...made, tls: true };
  return cached;
}

/** Forget the cached material (after a new certificate is dropped in). */
function reset() { cached = null; }

/** Delete the generated certificate so the next boot makes a fresh one. */
function regenerate() {
  try {
    for (const f of [CERT_FILE(), KEY_FILE(), path.join(TLS_DIR(), 'public.pem')]) fs.rmSync(f, { force: true });
  } catch {}
  reset();
}

function describe(material) {
  if (!material?.tls) return 'none (HTTPS unavailable)';
  if (material.source === 'generated') return `self-signed (${material.cn || 'sachi-bot'}${material.validTo ? `, valid to ${material.validTo}` : ''})`;
  return material.source === 'data/tls'
    ? `self-signed, stored in data/tls${material.validTo ? `, valid to ${material.validTo}` : ''}`
    : `your certificate (${material.source})`;
}

module.exports = { load, reset, regenerate, describe, sanAddresses, TLS_DIR, CERT_FILE, KEY_FILE };
