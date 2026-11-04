const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const config = require('../../config');
const log = require('../../utils/logger');
const { ensureXray } = require('../binaries/manager');
const { atomicJsonWrite, safeJsonRead } = require('../../utils/files');

const { parseSubscription } = require('./parser');
function buildOutbound(s) {
  const stream = { network: s.network || 'tcp' };
  if (s.network === 'ws') stream.wsSettings = { path: s.path || '/', headers: s.host ? { Host: s.host } : undefined };
  else if (s.network === 'grpc') stream.grpcSettings = { serviceName: (s.path || '').replace(/^\/?/, '') };
  if (s.tls === 'tls') stream.security = 'tls', stream.tlsSettings = { serverName: s.sni || s.host || s.address, allowInsecure: false, fingerprint: s.fp || undefined };
  if (s.tls === 'reality') stream.security = 'reality', stream.realitySettings = { serverName: s.sni || s.host || s.address, publicKey: s.pbk, shortId: s.sid || '', fingerprint: s.fp || 'chrome', spiderX: '/' };
  const settings = s.protocol === 'vmess'
    ? { vnext: [{ address: s.address, port: s.port, users: [{ id: s.id, alterId: s.aid || 0, security: 'auto' }] }] }
    : { vnext: [{ address: s.address, port: s.port, users: [{ id: s.id, encryption: 'none', flow: s.flow || undefined }] }] };
  return { tag: 'proxy', protocol: s.protocol, settings, streamSettings: stream };
}

class ProxyManager {
  constructor() { this.servers = []; this.index = 0; this.lastHash = ''; this.lastRefresh = 0; this.timer = null; this.leases = new Map(); this.stats = { refreshes: 0, failures: 0, successes: 0 }; this.cacheFile = config.paths.proxyCache; }
  get enabled() { return config.proxy.enabled && !!config.proxy.subscriptionUrl; }
  async init() {
    if (!this.enabled) return;
    const cache = safeJsonRead(this.cacheFile, null);
    if (cache?.servers?.length) { this.servers = cache.servers; this.lastHash = cache.hash || ''; log.info(`Loaded ${this.servers.length} cached proxy configs.`); }
    await this.refresh(true);
    this.timer = setInterval(() => this.refresh(false).catch(e => log.warn(`Proxy refresh: ${e.message}`)), config.proxy.refreshMinutes * 60 * 1000);
    this.timer.unref?.();
  }
  async fetchSource() {
    const src = config.proxy.subscriptionUrl;
    if (/^v(mess|less):\/\//i.test(src)) return src;
    const r = await axios.get(src, { timeout: config.proxy.requestTimeoutMs, headers: { 'User-Agent': 'Sachi-MD/1.0', Accept: 'text/plain,*/*' }, responseType: 'text', maxRedirects: 5 });
    if (r.status >= 400) throw new Error(`subscription HTTP ${r.status}`);
    return String(r.data || '');
  }
  async refresh(force = false) {
    if (!this.enabled) return false;
    const min = 60 * 1000;
    if (!force && Date.now() - this.lastRefresh < min) return false;
    this.lastRefresh = Date.now(); this.stats.refreshes++;
    let raw; try { raw = await this.fetchSource(); } catch (e) { log.warn(`Proxy source unavailable; keeping current pool. ${e.message}`); return false; }
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    if (!force && hash === this.lastHash && this.servers.length) return false;
    const parsed = parseSubscription(raw);
    if (!parsed.length) { log.warn('Proxy source contains no valid VMess/VLESS configs; keeping current pool.'); return false; }
    const old = new Map(this.servers.map(s => [s.idKey, s]));
    this.servers = parsed.map(s => ({ ...s, failures: old.get(s.idKey)?.failures || 0, successes: old.get(s.idKey)?.successes || 0, status: old.get(s.idKey)?.status || 'new', lastSuccess: old.get(s.idKey)?.lastSuccess || 0, lastFailure: old.get(s.idKey)?.lastFailure || 0 }));
    this.index = 0; this.lastHash = hash; atomicJsonWrite(this.cacheFile, { updatedAt: Date.now(), hash, servers: this.servers });
    log.success(`Proxy pool refreshed: ${this.servers.length} configs.`); return true;
  }
  async startLease(index) {
    const server = this.servers[index]; if (!server) return null;
    const binary = await ensureXray();
    const port = 20000 + Math.floor(Math.random() * 20000);
    const leaseId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const cfgPath = path.join(config.paths.data, `xray-${leaseId}.json`);
    const cfg = { log: { loglevel: 'error' }, inbounds: [{ listen: '127.0.0.1', port, protocol: 'socks', settings: { udp: false } }], outbounds: [buildOutbound(server), { tag: 'direct', protocol: 'freedom' }] };
    atomicJsonWrite(cfgPath, cfg);
    const child = spawn(binary, ['run', '-c', cfgPath], { stdio: 'ignore' });
    // Same trap as yt-dlp: an unhandled 'error' event from spawn is fatal to
    // the process. A missing/unexecutable xray should disable the proxy, not
    // kill the bot.
    let spawnError = null;
    child.on('error', (e) => { spawnError = e; try { child.kill(); } catch {} });
    const lease = { id: leaseId, index, server, port, child, cfgPath, released: false };
    this.leases.set(leaseId, lease);
    await new Promise(resolve => setTimeout(resolve, 650));
    if (spawnError) { log.warn(`Xray could not start: ${spawnError.message}`); await this.release(lease, false); return null; }
    if (child.exitCode !== null || child.killed) { await this.release(lease, false); return null; }
    child.once('exit', () => { if (!lease.released) this.leases.delete(lease.id); });
    return lease;
  }
  async acquire() {
    if (!this.enabled) return null;
    if (!this.servers.length) await this.refresh(true);
    if (!this.servers.length) return null;
    const now = Date.now();
    for (let n = 0; n < this.servers.length; n++) {
      const idx = (this.index + n) % this.servers.length;
      const s = this.servers[idx];
      if (s.status === 'cooldown' && now - (s.lastFailure || 0) < 10 * 60 * 1000) continue;
      const lease = await this.startLease(idx).catch(() => null);
      if (lease) { this.index = (idx + 1) % this.servers.length; return { host: '127.0.0.1', port: lease.port, url: `socks5h://127.0.0.1:${lease.port}`, server: s, lease }; }
      s.failures = (s.failures || 0) + 1; s.lastFailure = Date.now(); s.status = s.failures >= 3 ? 'cooldown' : 'failed'; this.stats.failures++;
    }
    if (await this.refresh(true)) return this.acquire();
    return null;
  }
  async release(handle, success) {
    const lease = handle?.lease || handle; if (!lease || lease.released) return;
    lease.released = true; this.leases.delete(lease.id);
    const s = this.servers.find(x => x.idKey === lease.server.idKey);
    if (s) {
      if (success) { s.successes = (s.successes || 0) + 1; s.failures = 0; s.status = 'healthy'; s.lastSuccess = Date.now(); this.stats.successes++; }
      else { s.failures = (s.failures || 0) + 1; s.lastFailure = Date.now(); s.status = s.failures >= 3 ? 'cooldown' : 'failed'; this.stats.failures++; }
    }
    try { lease.child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { if (!lease.child.killed) lease.child.kill('SIGKILL'); } catch {} }, 1500).unref?.();
    try { fs.unlinkSync(lease.cfgPath); } catch {}
  }
  async stop() { if (this.timer) clearInterval(this.timer); this.timer = null; for (const lease of [...this.leases.values()]) await this.release(lease, false); }
  status() { return { enabled: this.enabled, servers: this.servers.length, activeLeases: this.leases.size, lastRefresh: this.lastRefresh, hash: this.lastHash ? this.lastHash.slice(0, 12) : null, stats: this.stats }; }
}
module.exports = { ProxyManager, parseSubscription, buildOutbound };
