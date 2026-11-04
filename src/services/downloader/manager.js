const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const log = require('../../utils/logger');
const { ensureYtDlp, ensureFfmpeg } = require('../binaries/manager');
const { ProxyManager } = require('../proxy/manager');
const { cleanup } = require('./cleanup');
const { videoFormat, audioFormat, parseVideoQuality, parseAudioQuality } = require('./quality');
const { isYoutubeAuthError } = require('../../utils/youtube');

const proxyManager = new ProxyManager();
let initialized = false;
let activeJobs = 0;

async function init() { if (initialized) return; initialized = true; await proxyManager.init(); }


function errorText(s) {
  const text = String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
  const m = text.match(/ERROR:\s*(.*)/i);
  return (m ? m[1] : text || 'Download failed').split('\n').map(x => x.trim()).find(Boolean)?.slice(0, 220) || 'Download failed';
}

function parseProgress(line) {
  const s = String(line || '').trim();
  const m = s.match(/(?:download:)?\s*([0-9.]+)%.*?of\s+([0-9.]+)([KMGTP]?i?B).*?at\s+([^\s]+).*?ETA\s+([^\s]+)/i);
  if (m) {
    const factor = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[m[3]] || 1;
    return { percent: Number(m[1]), total: Number(m[2]) * factor, speed: m[4], eta: m[5] };
  }
  const simple = s.match(/([0-9.]+)%/);
  return simple ? { percent: Number(simple[1]) } : null;
}

/**
 * Where yt-dlp may put its intermediate files.
 *
 * `data/tmp` on the project disk — NOT /tmp. A panel's /tmp is usually a small
 * tmpfs (992 MB here) and a single 4K merge fills it, which is exactly what
 * "ffmpeg exited with code -11" turned out to be: the downloader ran the disk
 * out of space and the postprocessor died.
 */
const TMP_ROOT = () => path.join(config.paths.data, 'tmp');

/**
 * Run yt-dlp into a temp FILE, then hand back the bytes.
 *
 * This replaces `-o -`. Writing to stdout cannot work when yt-dlp has to merge
 * a DASH video stream with a separate audio stream — ffmpeg has nowhere to
 * seek, so the merge fails ("ffmpeg exited with code -11"/"Conversion
 * failed!"). Modern YouTube is DASH-only above 720p, so `.ytv` failed on
 * almost every real video. A temp file also lets us police the disk while it
 * downloads and delete the evidence afterwards.
 */
function downloadToTemp(binary, args, { timeout = 300000, maxBytes, onProgress, label = 'dl' } = {}) {
  const dir = path.join(TMP_ROOT(), `${label}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const outTemplate = path.join(dir, 'media.%(ext)s');
  const fullArgs = [...args, '-o', outTemplate];
  return new Promise((resolve) => {
    // yt-dlp writes its progress and its "--max-filesize" abort message to
    // STDOUT, not stderr, so both streams are collected.
    let stderr = '', stdoutTail = '', done = false, killedForSize = false;
    const child = spawn(binary, fullArgs, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // A merge keeps the video and the audio stream on disk, then writes the
    // muxed file, so the DIRECTORY can legitimately be ~2× the final size.
    // Policing the total therefore rejected files that were well inside the
    // limit exactly when a DASH merge was happening. Police the largest single
    // artifact instead, with a runaway guard on the total.
    const sizes = () => {
      let total = 0, largest = 0;
      try {
        for (const f of fs.readdirSync(dir)) {
          try {
            const n = fs.statSync(path.join(dir, f)).size;
            total += n;
            if (n > largest) largest = n;
          } catch {}
        }
      } catch {}
      return { total, largest };
    };
    const cleanupDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(watch);
      if (killedForSize) {
        cleanupDir();
        return resolve({ code: -3, buffer: null, bytes: 0, stderr, error: new Error('The file is larger than the configured size limit.') });
      }
      if (code !== 0) {
        cleanupDir();
        return resolve({ code, buffer: null, bytes: 0, stderr, error: error || new Error(errorText(stderr)) });
      }
      let best = null;
      try {
        for (const f of fs.readdirSync(dir)) {
          const full = path.join(dir, f);
          if (/\.(part|ytdl|temp)$/i.test(f)) continue;
          const st = fs.statSync(full);
          if (st.isFile() && (!best || st.size > best.size)) best = { full, size: st.size };
        }
      } catch {}
      if (!best || !best.size) {
        cleanupDir();
        // yt-dlp exits 0 and downloads NOTHING when `--max-filesize` says the
        // media is too big, so "finished without producing media" would be a
        // confusing thing to show somebody who asked for a 720p video with a
        // 3 MB limit. Say what actually happened.
        const tooBig = /larger than max-filesize|File is larger than max|larger than the configured/i.test(`${stderr}\n${stdoutTail}`);
        return resolve({
          code: -4, buffer: null, bytes: 0, stderr,
          error: new Error(tooBig
            ? `That media is larger than the ${Math.round((maxBytes || 0) / 1048576)} MB limit. Try a lower quality.`
            : 'Downloader finished without producing media.'),
        });
      }
      if (maxBytes && best.size > maxBytes) { cleanupDir(); return resolve({ code: -3, buffer: null, bytes: 0, stderr, error: new Error('The file is larger than the configured size limit.') }); }
      let buffer = null;
      try { buffer = fs.readFileSync(best.full); } catch (e) { cleanupDir(); return resolve({ code: -5, buffer: null, bytes: 0, stderr, error: e }); }
      cleanupDir();
      resolve({ code: 0, buffer, bytes: buffer.length, stderr, file: path.basename(best.full) });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(-1, new Error('Download timed out.')); }, timeout);
    // Watch the temp dir: --max-filesize only limits the *selected* stream, not
    // the merged output, so a 4K pick can still write gigabytes of disk.
    const watch = setInterval(() => {
      if (done || !maxBytes) return;
      const { total, largest } = sizes();
      onProgress?.({ downloaded: total });
      if (largest > maxBytes || total > maxBytes * 2.5) {
        killedForSize = true;
        try { child.kill('SIGKILL'); } catch {}
      }
    }, 1000);
    watch.unref?.();
    child.on('error', (e) => finish(-2, e));
    child.stdout.on('data', (d) => {
      stdoutTail = (stdoutTail + d.toString()).slice(-4000);
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      const p = parseProgress(text);
      if (p) onProgress?.(p);
    });
    child.on('exit', (code) => finish(code, null));
  });
}

function run(binary, args, { timeout = 300000, onStderr, onStdout } = {}) {
  return new Promise(resolve => {
    const child = spawn(binary, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out, err, child }); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(-1); }, timeout);
    child.stdout.on('data', d => { onStdout?.(d); out += d.toString('utf8'); });
    child.stderr.on('data', d => { const s = d.toString(); onStderr?.(s); err += s; });
    child.on('error', e => { err += e.message; finish(-2); });
    child.on('exit', finish);
  });
}

function runBinaryToMemory(binary, args, { timeout = 300000, maxBytes, onProgress } = {}) {
  return new Promise(resolve => {
    const child = spawn(binary, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, stderr = '', done = false, progress = {};
    const finish = (code, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, buffer: Buffer.concat(chunks, bytes), bytes, stderr, progress, child, error });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish(-1, new Error('Download timed out.')); }, timeout);

    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (maxBytes && bytes > maxBytes) {
        try { child.kill('SIGKILL'); } catch {}
        finish(-1, new Error('File exceeds the configured size limit.'));
        return;
      }
      chunks.push(Buffer.from(chunk));
      if (!progress.percent) progress.downloaded = bytes;
      onProgress?.({ ...progress, downloaded: bytes });
    });

    let lineBuffer = '';
    child.stderr.on('data', data => {
      const text = data.toString();
      stderr += text;
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n|\r/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        const p = parseProgress(line);
        if (p) { progress = { ...progress, ...p }; onProgress?.({ ...progress, downloaded: bytes }); }
      }
    });

    child.on('error', e => finish(-2, e));
    child.on('exit', code => finish(code, code === 0 ? null : new Error(errorText(stderr))));
  });
}

function cookieArgs() {
  const fs = require('fs');
  const path = require('path');
  const fromEnv = process.env.YTDLP_COOKIES || process.env.YOUTUBE_COOKIES || '';
  const candidates = [fromEnv, path.join(config.paths.data, 'cookies.txt'), path.join(config.paths.root, 'cookies.txt')].filter(Boolean);
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return ['--cookies', c]; } catch {}
  }
  return [];
}

function commonArgs(maxMB, mode, quality) {
  const args = [
    '--no-warnings', '--no-playlist', '--restrict-filenames', '--newline',
    '--socket-timeout', '30', '--retries', '2', '--fragment-retries', '2',
    '--max-filesize', `${maxMB}M`,
    '--progress-template', 'download:%(progress._percent_str)s of %(progress.total_bytes_str)s at %(progress._speed_str)s ETA %(progress.eta)s',
  ];
  if (mode === 'audio') {
    const parsed = parseAudioQuality(quality);
    if (!parsed) throw new Error('Invalid audio quality.');
    args.push('-f', audioFormat(parsed.value, parsed.best));
  } else {
    const parsed = parseVideoQuality(quality);
    if (!parsed) throw new Error('Invalid video quality.');
    // Without a height ceiling "best video" is whatever YouTube decides —
    // often 4K AV1, which is a gigabyte on disk and minutes of ffmpeg for a
    // WhatsApp attachment that gets re-compressed to ~5 MB anyway.
    const fmt = parsed.value
      ? videoFormat(parsed.value, parsed.best)
      : `bv*[height<=${maxHeight()}]+ba/b[height<=${maxHeight()}]`;
    args.push('-f', fmt, '--merge-output-format', 'mp4');
  }
  args.push(...cookieArgs());
  return args;
}

/** Default ceiling on the video stream when the user did not ask for one. */
function maxHeight() {
  const n = Number(process.env.YTDLP_MAX_HEIGHT);
  return Number.isFinite(n) && n >= 144 ? Math.floor(n) : 1080;
}

async function info(url, { onProgress } = {}) {
  await init(); await ensureYtDlp();
  const args = ['--no-warnings', '--skip-download', '--dump-single-json', '--no-playlist', '--socket-timeout', '30', '--retries', '1', ...cookieArgs(), url];
  let r = await run(require('../binaries/manager').paths.ytDlp, args, { timeout: 120000, onStderr: s => onProgress?.(parseProgress(s)) });
  if (r.code === 0) { try { return JSON.parse(r.out); } catch { throw new Error('Could not read media information.'); } }
  if (isYoutubeAuthError(r.err)) throw new Error('YouTube requires sign-in for this video. Place a cookies.txt (yt-dlp Netscape format) in data/ or set YTDLP_COOKIES path.');
  const pr = await runWithProxy(args, 120000, onProgress);
  if (pr?.code === 0) { try { return JSON.parse(pr.out); } catch { throw new Error('Could not read media information.'); } }
  throw new Error(errorText(pr?.err || r.err));
}

async function runWithProxy(args, timeout, onProgress, maxBytes) {
  await init();
  const attempts = Math.max(1, proxyManager.servers.length || 1);
  for (let i = 0; i < attempts; i++) {
    const lease = await proxyManager.acquire();
    if (!lease) break;
    try {
      const nextArgs = [...args, '--proxy', lease.url];
      const r = maxBytes
        ? await downloadToTemp(require('../binaries/manager').paths.ytDlp, nextArgs, { timeout, maxBytes, onProgress, label: 'proxy' })
        : await run(require('../binaries/manager').paths.ytDlp, nextArgs, { timeout, onStderr: s => onProgress?.(parseProgress(s)) });
      await proxyManager.release(lease, r.code === 0);
      if (r.code === 0) return { ...r, via: 'proxy' };
    } catch (e) { await proxyManager.release(lease, false); }
  }
  return null;
}

async function download(url, { mode = 'video', maxMB, quality, onProgress } = {}) {
  await init();
  const limit = Number(maxMB || (mode === 'audio' ? config.limits.audioMB : config.limits.videoMB));
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('Invalid download size limit.');
  if (activeJobs >= config.limits.concurrentDownloads) throw new Error('Server is busy with other downloads. Please try again shortly.');
  activeJobs++;
  try {
    await ensureYtDlp();
    const ffmpeg = await ensureFfmpeg().catch(() => null);
    const args = commonArgs(limit, mode, quality);
    if (ffmpeg) args.push('--ffmpeg-location', ffmpeg);
    args.push(url);
    let progress = { phase: 'Connecting directly…' };
    const report = p => { progress = { ...progress, ...p }; onProgress?.(progress); };
    let r = await downloadToTemp(require('../binaries/manager').paths.ytDlp, args, { timeout: 300000, maxBytes: limit * 1024 * 1024, onProgress: report, label: mode });
    let via = 'direct';
    if (r.code !== 0 && !isYoutubeAuthError(r.stderr)) {
      report({ phase: 'Direct connection failed — switching to proxy…' });
      const pr = await runWithProxy(args, 300000, report, limit * 1024 * 1024);
      if (pr) { r = pr; via = 'proxy'; }
    }
    if (r.code !== 0) {
      if (isYoutubeAuthError(r.stderr)) {
        throw new Error('YouTube requires sign-in for this video. Place a cookies.txt (yt-dlp Netscape format) in data/ or set YTDLP_COOKIES path.');
      }
      throw new Error(errorText(r.error?.message || r.stderr));
    }
    if (!r.buffer?.length) throw new Error('Downloader finished without producing media.');
    const media = detectMedia(r.buffer, mode);
    const ext = media.ext;
    const mimeType = media.mimeType;
    onProgress?.({ percent: 100, downloaded: r.bytes, total: r.bytes, phase: via === 'proxy' ? 'Download complete • proxy fallback' : 'Download complete' });
    return { buffer: r.buffer, size: r.bytes, ext, mimeType, via };
  } finally {
    activeJobs--;
    cleanup(false);
  }
}

function detectMedia(buffer, mode) {
  if (buffer?.length >= 12 && buffer.subarray(4, 8).toString() === 'ftyp') return { ext: 'mp4', mimeType: mode === 'audio' ? 'audio/mp4' : 'video/mp4' };
  if (buffer?.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { ext: 'webm', mimeType: mode === 'audio' ? 'audio/webm' : 'video/webm' };
  if (buffer?.length >= 4 && buffer.subarray(0, 4).toString() === 'OggS') return { ext: 'ogg', mimeType: mode === 'audio' ? 'audio/ogg' : 'video/ogg' };
  if (buffer?.length >= 3 && buffer.subarray(0, 3).toString() === 'ID3') return { ext: 'mp3', mimeType: 'audio/mpeg' };
  return { ext: mode === 'audio' ? 'm4a' : 'mp4', mimeType: mode === 'audio' ? 'audio/mp4' : 'video/mp4' };
}

function status() { return { activeJobs, limit: config.limits.concurrentDownloads, proxy: proxyManager.status(), memoryDownloads: true }; }
async function shutdown() { await proxyManager.stop(); }
module.exports = { init, info, download, status, shutdown, proxyManager, run, commonArgs, isYoutubeAuthError,
  downloadToTemp, runBinaryToMemory, parseProgress, maxHeight, TMP_ROOT };
