const axios = require('axios');
const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const config = require('../../config');
const { assertPublicHttpUrl } = require('../../utils/network');

function safeName(name) {
  return String(name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 140) || 'download';
}

// Reused keep-alive connections: repeated downloads to the same host skip
// the TCP+TLS handshake (saves ~1 RTT+ per request, faster chained fetches).
const keepAlive = {
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 8 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 8 }),
};

function agents(proxyUrl) {
  if (!proxyUrl) return { ...keepAlive };
  const agent = new SocksProxyAgent(proxyUrl);
  return { httpAgent: agent, httpsAgent: agent, proxy: false };
}

async function requestWithRedirects(url, options = {}) {
  let current = url;
  const maxRedirects = options.maxRedirects ?? config.limits.maxRedirects;
  for (let i = 0; i <= maxRedirects; i++) {
    const u = await assertPublicHttpUrl(current, options.validation || {});
    const response = await axios.get(u.href, {
      ...options,
      ...agents(options.proxyUrl),
      proxyUrl: undefined,
      maxRedirects: 0,
      validateStatus: s => (s >= 200 && s < 300) || (s >= 300 && s < 400),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      current = new URL(response.headers.location, u.href).href;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Source returned HTTP ${response.status}.`);
    return { response, url: u.href };
  }
  throw new Error('Too many redirects.');
}

async function fetchText(url, options = {}) {
  const { response } = await requestWithRedirects(url, {
    ...options,
    responseType: 'text',
    timeout: options.timeout || 30000,
    headers: { 'User-Agent': 'Sachi-MD/1.0', ...(options.headers || {}) },
  });
  return String(response.data || '');
}

async function downloadToMemory(url, { maxBytes, proxyUrl, referer, timeout = 120000, validation, onProgress } = {}) {
  const { response, url: finalUrl } = await requestWithRedirects(url, {
    responseType: 'stream',
    timeout,
    proxyUrl,
    headers: { 'User-Agent': 'Mozilla/5.0 Sachi-MD', ...(referer ? { Referer: referer } : {}) },
    validation,
  });

  const declared = Number(response.headers['content-length'] || 0);
  if (maxBytes && declared > maxBytes) {
    response.data.destroy();
    throw new Error('File exceeds the configured size limit.');
  }

  const chunks = [];
  let bytes = 0;
  let lastReport = 0;
  try {
    for await (const chunk of response.data) {
      bytes += chunk.length;
      if (maxBytes && bytes > maxBytes) {
        response.data.destroy();
        throw new Error('File exceeds the configured size limit.');
      }
      chunks.push(Buffer.from(chunk));
      const now = Date.now();
      if (onProgress && now - lastReport >= 300) {
        lastReport = now;
        try { onProgress({ downloaded: bytes, total: declared || undefined, percent: declared ? bytes / declared * 100 : undefined }); }
        catch { /* a progress-UI failure must never abort the download itself */ }
      }
    }
  } catch (e) {
    try { response.data.destroy(); } catch {}
    throw e;
  }

  try { onProgress?.({ downloaded: bytes, total: declared || undefined, percent: declared ? 100 : undefined }); } catch { /* ignore */ }
  const mimeType = String(response.headers['content-type'] || 'application/octet-stream').split(';')[0].toLowerCase();
  const name = safeName(new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || 'download');
  return { buffer: Buffer.concat(chunks, bytes), size: bytes, mimeType, finalUrl, fileName: name };
}

module.exports = { fetchText, downloadToMemory, requestWithRedirects, safeName };
