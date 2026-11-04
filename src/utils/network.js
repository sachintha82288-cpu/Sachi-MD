const dns = require('dns').promises;
const net = require('net');

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b] = p;
  return a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    a === 0 || a >= 224;
}

function isPrivateIPv6(ip) {
  const s = ip.toLowerCase().split('%')[0];
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') ||
    s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb');
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) return isPrivateIPv6(ip);
  return true;
}

async function assertPublicHttpUrl(input, { allowlist = null } = {}) {
  let u;
  try { u = new URL(input); } catch { throw new Error('Invalid URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP(S) URLs are supported.');
  const hostname = u.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Private network URLs are not allowed.');
  }
  if (allowlist && !allowlist.some(s => hostname === s || hostname.endsWith(`.${s}`))) {
    throw new Error('URL host is not allowed.');
  }
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('Private network URLs are not allowed.');
    return u;
  }
  let records;
  try { records = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch { throw new Error('Could not resolve the URL host.'); }
  if (!records.length || records.some(r => isPrivateAddress(r.address))) {
    throw new Error('URL resolves to a private or restricted network.');
  }
  return u;
}

module.exports = { assertPublicHttpUrl, isPrivateAddress };
