const axios = require('axios');
const config = require('../../config');
const { fetchText, downloadToMemory, safeName } = require('./http');
const { ensureYtDlp, ensureFfmpeg, paths } = require('../binaries/manager');
const log = require('../../utils/logger');

function getProxy() {
  try { return require('./manager').proxyManager; } catch { return null; }
}
function errorText(s) {
  const text = String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
  const m = text.match(/ERROR:\s*(.*)/i);
  return (m ? m[1] : text || 'Download failed').split('\n').map((x) => x.trim()).find(Boolean)?.slice(0, 220) || 'Download failed';
}
function runBinaryToMemory(binary, args, { timeout = 300000, maxBytes, onProgress } = {}) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const child = spawn(binary, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0; let stderr = ''; let done = false;
    const finish = (code, error) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, buffer: Buffer.concat(chunks, bytes), bytes, stderr, error }); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(-1, new Error('Download timed out.')); }, timeout);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (maxBytes && bytes > maxBytes) { try { child.kill('SIGKILL'); } catch {} finish(-1, new Error('File exceeds the configured size limit.')); return; }
      chunks.push(Buffer.from(chunk));
      onProgress?.({ downloaded: bytes });
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => finish(-2, e));
    child.on('exit', (code) => finish(code, code === 0 ? null : new Error(errorText(stderr))));
  });
}
async function ytdlpSocial(url, { maxMB, onProgress, proxyUrl } = {}) {
  await ensureYtDlp();
  const ffmpeg = await ensureFfmpeg().catch(() => null);
  const limit = maxMB || config.limits.videoMB;
  const args = [
    '--no-warnings', '--no-playlist', '--restrict-filenames', '--newline',
    '--socket-timeout', '30', '--retries', '3', '--fragment-retries', '3',
    '--max-filesize', `${limit}M`, '-f', 'bv*+ba/b', '--merge-output-format', 'mp4',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  ];
  if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
  if (proxyUrl) args.push('--proxy', proxyUrl);
  args.push(url);
  // Temp file, not stdout: same merge problem as the YouTube path (a DASH
  // video+audio pair cannot be muxed into a pipe).
  const r = await require('./manager').downloadToTemp(paths.ytDlp, args, { timeout: 300000, maxBytes: limit * 1024 * 1024, onProgress, label: 'social' });
  if (r.code !== 0 || !r.buffer?.length) throw new Error(errorText(r.stderr) || r.error?.message || 'yt-dlp failed');
  return { buffer: r.buffer, size: r.bytes, mimeType: 'video/mp4', ext: 'mp4', via: proxyUrl ? 'proxy' : 'direct' };
}
async function ytdlpWithProxyFallback(url, opts = {}) {
  try { return await ytdlpSocial(url, opts); }
  catch (first) {
    const proxy = getProxy();
    if (!proxy?.enabled) throw first;
    const lease = await proxy.acquire();
    if (!lease) throw first;
    try {
      const r = await ytdlpSocial(url, { ...opts, proxyUrl: lease.url });
      await proxy.release(lease, true);
      return { ...r, via: 'proxy' };
    } catch (e) {
      await proxy.release(lease, false);
      throw first;
    }
  }
}
async function ytdlpMeta(url) {
  await ensureYtDlp();
  const { spawn } = require('child_process');
  const args = ['--no-warnings', '--skip-download', '--dump-single-json', '--no-playlist', '--socket-timeout', '25',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', url];
  return new Promise((resolve) => {
    const child = spawn(paths.ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    let done = false;
    const finish = (value) => { if (done) return; done = true; clearTimeout(t); resolve(value); };
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(null); }, 60000);
    // Without this, a spawn failure (EACCES on a binary that lost its exec bit,
    // ENOMEM, ENOENT) is emitted as an unhandled 'error' event and takes the
    // whole bot process down — which is what "the bot has errors" looked like.
    child.on('error', (e) => { log.warn(`yt-dlp could not start: ${e.message}`); finish(null); });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => {
      if (code !== 0) return finish(null);
      try { finish(JSON.parse(out)); } catch { finish(null); }
    });
  });
}
async function downloadTikTok(url, { onProgress } = {}) {
  try {
    const meta = await ytdlpMeta(url);
    const r = await ytdlpWithProxyFallback(url, { onProgress, maxMB: config.limits.videoMB });
    return { ...r, title: meta?.title || 'TikTok video', uploader: meta?.uploader || meta?.channel || 'unknown' };
  } catch (ytdlpErr) {
    log.warn(`TikTok yt-dlp failed: ${ytdlpErr.message} — trying API fallback`);
    onProgress?.({ phase: 'Trying alternate TikTok source…' });
    let last = ytdlpErr;
    for (const api of [`https://tikwm.com/api/?url=${encodeURIComponent(url)}`, `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`]) {
      try {
        const { data } = await axios.get(api, { timeout: 25000, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        const d = data?.data || data;
        const mediaUrl = d?.play || d?.hdplay || d?.wmplay || d?.video;
        if (!mediaUrl) continue;
        const file = await downloadToMemory(mediaUrl, { maxBytes: config.limits.videoMB * 1024 * 1024, timeout: 120000, referer: 'https://www.tiktok.com/', onProgress });
        return { buffer: file.buffer, size: file.size, mimeType: 'video/mp4', ext: 'mp4', via: 'api-fallback', title: d?.title || 'TikTok video', uploader: d?.author?.nickname || d?.author?.unique_id || 'unknown' };
      } catch (e) { last = e; }
    }
    throw new Error(last?.message || 'TikTok download failed');
  }
}
async function downloadFacebook(url, { onProgress } = {}) {
  const meta = await ytdlpMeta(url);
  const r = await ytdlpWithProxyFallback(url, { onProgress, maxMB: config.limits.videoMB });
  return { ...r, title: meta?.title || 'Facebook video', uploader: meta?.uploader || meta?.channel || '' };
}
function extractMediafireLinks(html) {
  const candidates = [];
  const patterns = [
    /href=["'](https?:\/\/download[^"']+)["']/gi,
    /href=["'](https?:\/\/[^"']*mediafire[^"']*\/[^"']+)["']/gi,
    /"(https?:\/\/download\d+\.mediafire\.com\/[^"]+)"/gi,
    /data-scrambled-url=["']([^"']+)["']/gi,
  ];
  for (const re of patterns) {
    for (const m of String(html).matchAll(re)) {
      let u = m[1];
      if (/scrambled/i.test(re.source)) {
        try { u = Buffer.from(u, 'base64').toString('utf8'); } catch { continue; }
      }
      if (/^https?:\/\//i.test(u)) candidates.push(u);
    }
  }
  return candidates.find((u) => /download\d*\.mediafire\.com/i.test(u)) || candidates[0] || null;
}
async function downloadMediafire(pageUrl, { onProgress } = {}) {
  let html;
  try { html = await fetchText(pageUrl, { timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } }); }
  catch (first) {
    const proxy = getProxy();
    const lease = proxy?.enabled ? await proxy.acquire() : null;
    if (!lease) throw first;
    try { html = await fetchText(pageUrl, { timeout: 30000, proxyUrl: lease.url }); await proxy.release(lease, true); }
    catch (e) { await proxy.release(lease, false); throw first; }
  }
  const direct = extractMediafireLinks(html);
  if (!direct) throw new Error('Could not find a MediaFire download link (file may be private or removed).');
  const title = ((html.match(/<div[^>]+class=["'][^"']*filename[^"']*["'][^>]*>([^<]+)/i) || [])[1] || safeName(new URL(direct).pathname.split('/').pop()) || 'mediafire_file').trim();
  const maxBytes = config.limits.mediafireGB * 1024 ** 3;
  try {
    const result = await downloadToMemory(direct, { maxBytes, referer: pageUrl, timeout: 180000, onProgress });
    return { ...result, title, via: 'direct' };
  } catch (first) {
    const proxy = getProxy();
    const lease = proxy?.enabled ? await proxy.acquire() : null;
    if (!lease) throw first;
    try {
      const result = await downloadToMemory(direct, { maxBytes, referer: pageUrl, timeout: 180000, proxyUrl: lease.url, onProgress });
      await proxy.release(lease, true);
      return { ...result, title, via: 'proxy' };
    } catch (e) { await proxy.release(lease, false); throw e; }
  }
}
module.exports = { downloadTikTok, downloadFacebook, downloadMediafire, ytdlpWithProxyFallback, ytdlpMeta };
