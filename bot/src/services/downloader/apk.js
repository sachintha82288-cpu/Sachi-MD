/**
 * APK search & download service.
 *
 * Sources (all verified working from a plain datacenter IP):
 *   • resolver  — Google Play web search (no anti-bot): package ids in
 *                 popularity order for a name query.
 *   • downloader— APKPure's package endpoint (d.apkpure.com) 302-redirects
 *                 to a signed CDN URL; its Location header also carries the
 *                 app name / version / full size, so a list can be enriched
 *                 with real metadata via tiny redirect-only requests.
 *   • fallback  — F-Droid web search + official package API (FOSS apps).
 *   • direct    — any URL the user supplies (SSRF-guarded by http.js).
 *
 * Every download is validated: an APK is a ZIP, so the buffer must start
 * with the PK\x03\x04 magic — HTML error pages never pass through.
 */
const http = require('./http');
const { execFile } = require('child_process');
const { human } = require('./cleanup');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const axios = require('axios');

const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
const URL_RE = /^https?:\/\/\S+$/i;

function resolveInput(text) {
  const t = String(text || '').trim();
  if (!t) return { type: 'empty' };
  if (URL_RE.test(t)) return { type: 'url', value: t };
  if (PACKAGE_RE.test(t) && t.includes('.')) return { type: 'package', value: t.toLowerCase() };
  return { type: 'query', value: t };
}

/** Parse the metadata that APKPure embeds in its signed Location header. */
function metaFromLocation(location) {
  try {
    const u = new URL(location);
    const filename = u.searchParams.get('filename') || '';
    const fullSize = Number(u.searchParams.get('full_size')) || 0;
    const cleaned = decodeURIComponent(filename).replace(/_APKPure\.(apk|xapk)$/i, '').replace(/-APKPure\.(apk|xapk)$/i, '');
    const cut = cleaned.lastIndexOf('_');
    if (cut > 0) return { name: cleaned.slice(0, cut), version: cleaned.slice(cut + 1), sizeBytes: fullSize };
    if (cleaned) return { name: cleaned, version: '', sizeBytes: fullSize };
  } catch { /* fall through */ }
  return null;
}

/**
 * Resolve the APKPure signed CDN URL.
 * d.apkpure.com sits behind a TLS-fingerprint WAF that 403s Node's HTTP
 * stack but allows curl, so the 302 lookup shells out to curl when
 * available (with a plain-axios fallback for environments where the WAF
 * is absent or curl is missing). The heavy download itself stays in Node
 * — the signed data.winudf.com URL accepts any client.
 */
function curlResolve(url, timeoutMs = 25000) {
  return new Promise((resolve) => {
    execFile('curl', ['-sS', '-o', '/dev/null', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-A', UA, '-w', '%{http_code}\t%{redirect_url}', url],
    { timeout: timeoutMs }, (err, stdout) => {
      const out = String(stdout || '');
      const [code, loc] = out.trim().split('\t');
      if (err && !out) return resolve(null);
      resolve(code === '302' || code === '301' ? loc || null : null);
    });
  });
}

async function resolveApkPure(pkg) {
  const target = `https://d.apkpure.com/b/APK/${encodeURIComponent(pkg)}?version=latest`;
  let loc = await curlResolve(target);
  if (loc) return loc;
  try {
    const r = await axios.get(target, {
      maxRedirects: 0,
      validateStatus: (s) => s === 301 || s === 302,
      timeout: 15000,
      headers: { 'User-Agent': UA },
    });
    return r.headers?.location || null;
  } catch {
    return null;
  }
}

/** Redirect-only metadata probe for one package (no media is downloaded). */
async function fetchMeta(pkg) {
  const loc = await resolveApkPure(pkg);
  return loc ? metaFromLocation(loc) : null;
}

/** Enrich list items with real names/versions/sizes in parallel. */
async function enrich(items) {
  await Promise.all(items.map(async (item) => {
    if (item.source !== 'apkpure') return;
    const meta = await fetchMeta(item.package);
    if (meta) Object.assign(item, meta);
  }));
  return items;
}

/** Google Play search → package ids in popularity order. */
async function searchPlay(query, { limit = 6 } = {}) {
  const html = await http.fetchText(
    `https://play.google.com/store/search?q=${encodeURIComponent(query)}&c=apps&hl=en`,
    { timeout: 25000, headers: { 'User-Agent': UA, 'Accept-Language': 'en' } },
  );
  const seen = new Set();
  const out = [];
  const re = /\/store\/apps\/details\?id=([a-zA-Z0-9._]+)/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const pkg = m[1].toLowerCase();
    if (!seen.has(pkg)) { seen.add(pkg); out.push({ source: 'apkpure', package: pkg }); }
  }
  return enrich(out);
}

/** F-Droid search → package ids + display names (FOSS fallback). */
async function searchFdroid(query, { limit = 6 } = {}) {
  const html = await http.fetchText(
    `https://search.f-droid.org/?q=${encodeURIComponent(query)}&lang=en`,
    { timeout: 25000, headers: { 'User-Agent': UA } },
  );
  const seen = new Set();
  const out = [];
  const re = /f-droid\.org\/en\/packages\/([a-zA-Z0-9._]+)"[\s\S]{0,400}?<h4 class="package-name">\s*([^<]+?)\s*<\/h4>/g;
  let m;
  while ((m = re.exec(html)) && out.length < limit) {
    const pkg = m[1].toLowerCase();
    if (!seen.has(pkg)) { seen.add(pkg); out.push({ source: 'fdroid', package: pkg, name: m[2].trim() }); }
  }
  if (!out.length) {
    const bare = /f-droid\.org\/en\/packages\/([a-zA-Z0-9._]+)/g;
    let b;
    while ((b = bare.exec(html)) && out.length < limit) {
      const pkg = b[1].toLowerCase();
      if (!seen.has(pkg)) { seen.add(pkg); out.push({ source: 'fdroid', package: pkg }); }
    }
  }
  return out;
}

/** Aptoide (ws75 public API) search — full metadata + direct APK URL per result. */
async function searchAptoide(query, { limit = 6 } = {}) {
  const raw = await http.fetchText(
    `https://ws75.aptoide.com/api/7/apps/search?query=${encodeURIComponent(query)}&limit=${Math.max(limit * 2, 10)}`,
    { timeout: 20000, headers: { 'User-Agent': UA } },
  );
  const list = JSON.parse(raw)?.datalist?.list || [];
  const out = [];
  for (const a of list) {
    if (!a?.package || !a?.file?.path) continue;
    out.push({
      source: 'aptoide', package: String(a.package), name: a.name || '',
      version: a.file.vername || '', sizeBytes: Number(a.file.filesize) || 0, url: a.file.path,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Best Aptoide build for one package: direct lookup first, exact-match search second. */
async function aptoideForPackage(pkg) {
  const api = 'https://ws75.aptoide.com/api/7';
  const headers = { 'User-Agent': UA };
  try {
    const raw = await http.fetchText(`${api}/app/get/package_name=${encodeURIComponent(pkg)}`, { timeout: 15000, headers });
    const d = JSON.parse(raw)?.nodes?.meta?.data;
    const f = d?.file;
    if (f?.path) return { url: f.path, name: d.name || '', version: f.vername || '', sizeBytes: Number(f.filesize) || 0 };
  } catch { /* fall through to search */ }
  const raw2 = await http.fetchText(`${api}/apps/search?query=${encodeURIComponent(pkg)}&limit=10`, { timeout: 20000, headers });
  const list = JSON.parse(raw2)?.datalist?.list || [];
  const hit = list.find((a) => String(a?.package || '').toLowerCase() === String(pkg).toLowerCase());
  if (!hit?.file?.path) return null;
  return { url: hit.file.path, name: hit.name || '', version: hit.file.vername || '', sizeBytes: Number(hit.file.filesize) || 0 };
}

/** Search with fallback: Play + Aptoide merged, F-Droid when both yield nothing. */
async function search(query, { limit = 6 } = {}) {
  const [play, apt] = await Promise.allSettled([
    searchPlay(query, { limit }),
    searchAptoide(query, { limit: 3 }),
  ]);
  let items = play.status === 'fulfilled' ? play.value : [];
  if (apt.status === 'fulfilled' && apt.value.length) {
    const have = new Set(items.map((i) => i.package));
    for (const a of apt.value) {
      if (!have.has(a.package) && items.length < limit) items.push(a);
    }
  }
  if (!items.length) {
    try { items = await searchFdroid(query, { limit }); } catch { /* give up below */ }
  }
  return items;
}

function assertApkMagic(buffer) {
  if (!buffer || buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('That download is not a valid APK file (bad file signature).');
  }
}

/** Shared tail: download a resolved URL, verify, shape the result. */
async function fetchAndShape(spec, { maxMB, onProgress }) {
  const result = await http.downloadToMemory(spec.url, {
    maxBytes: maxMB * 1024 * 1024,
    timeout: 600000,
    onProgress,
  });
  assertApkMagic(result.buffer);

  let name = spec.name || '';
  let version = spec.version || '';
  if (!name && spec.directUrl) {
    try { name = decodeURIComponent(new URL(spec.url).pathname.split('/').pop() || ''); } catch { /* keep empty */ }
    if (name.toLowerCase().endsWith('.apk')) name = name.slice(0, -4);
  }
  if (!name) name = spec.package || 'app';
  const sizeBytes = result.size;
  const base = `${String(name).slice(0, 80)}${version ? `-${version}` : ''}`
    .replace(/[^a-zA-Z0-9._ ()-]+/g, '_').trim() || 'app';
  return {
    buffer: result.buffer,
    size: sizeBytes,
    name,
    version,
    source: spec.source,
    package: spec.package || null,
    fileName: /\.(apk|xapk)$/i.test(base) ? base : `${base}${spec.isBundle ? '.xapk' : '.apk'}`,
    isBundle: !!spec.isBundle,
    sizeLabel: human(sizeBytes),
  };
}

/** One download attempt against a single source. Throws on failure. */
async function downloadVia(kind, item, opts) {
  const pkg = item.package;
  if (kind === 'url') {
    return fetchAndShape({ url: item.url, source: 'direct', package: pkg, name: item.name, version: item.version, directUrl: !item.name }, opts);
  }
  if (kind === 'fdroid') {
    const api = await axios.get(`https://f-droid.org/api/v1/packages/${encodeURIComponent(pkg)}`, {
      timeout: 20000, headers: { 'User-Agent': UA }, validateStatus: (s) => s < 400,
    });
    const code = api.data?.suggestedVersionCode;
    if (!code) throw new Error('No downloadable build found on F-Droid.');
    return fetchAndShape({ url: `https://f-droid.org/repo/${pkg}_${code}.apk`, source: 'fdroid', package: pkg, name: item.name, version: item.version }, opts);
  }
  if (kind === 'aptoide') {
    const alt = await module.exports.aptoideForPackage(pkg);
    if (!alt?.url) throw new Error(`No build of ${pkg} on Aptoide.`);
    return fetchAndShape({ url: alt.url, source: 'aptoide', package: pkg, name: item.name || alt.name, version: item.version || alt.version }, opts);
  }
  // apkpure: resolve the signed CDN URL via curl (WAF-safe)
  const loc = await module.exports.resolveApkPure(pkg);
  if (!loc) throw new Error('The APK source is unreachable right now (blocked or unavailable).');
  const meta = metaFromLocation(loc);
  const spec = {
    url: loc, source: 'apkpure', package: pkg,
    name: item.name || meta?.name, version: item.version || meta?.version,
  };
  if (/\.xapk(?:&|$)/i.test(loc)) {
    // APKPure only ships a split/XAPK bundle here — Aptoide often has a
    // plain, directly-installable APK of the same app, so prefer that.
    try {
      const alt = await module.exports.aptoideForPackage(pkg);
      if (alt?.url) {
        return fetchAndShape({ url: alt.url, source: 'aptoide', package: pkg, name: item.name || alt.name, version: item.version || alt.version }, opts);
      }
    } catch { /* keep the bundle path */ }
    spec.isBundle = true;
  }
  return fetchAndShape(spec, opts);
}

/** Download an APK for a list item / package / direct URL, with source fallback. */
async function downloadApk(item, { maxMB = 500, onProgress } = {}) {
  const pkg = typeof item === 'string' ? item : item?.package;
  const wants = typeof item === 'string' ? { package: pkg } : { ...(item || {}) };
  if (typeof item === 'string' || !item) item = wants;
  if (!wants.url && !pkg) throw new Error('Give me an app name, package id, or URL to download.');

  let attempts;
  if (wants.url) {
    attempts = wants.package ? ['url', 'aptoide'] : ['url'];
  } else if (wants.source === 'fdroid') {
    attempts = ['fdroid', 'aptoide'];
  } else if (wants.source === 'aptoide') {
    attempts = ['aptoide', 'apkpure'];
  } else {
    attempts = ['apkpure', 'aptoide'];
  }

  let lastErr;
  for (const kind of attempts) {
    try {
      return await downloadVia(kind, wants, { maxMB, onProgress });
    } catch (e) {
      if (/size limit/i.test(e.message || '')) throw e; // cap is not retryable
      lastErr = e;
    }
  }
  throw lastErr;
}

module.exports = { resolveInput, search, searchPlay, searchAptoide, searchFdroid, aptoideForPackage, fetchMeta, resolveApkPure, metaFromLocation, downloadApk, assertApkMagic, PACKAGE_RE };
