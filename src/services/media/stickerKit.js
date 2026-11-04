/**
 * stickerKit — shared helpers for sticker/media tool commands.
 *
 * Uses the FFmpeg binary that binaries/manager.js already auto-downloads
 * (no new hard dependencies). All conversions stream through stdin/stdout;
 * only MP4 output (which needs a seekable file) touches data/tmp briefly
 * with a `sachi-` prefix so downloader/cleanup.js sweeps strays.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const config = require('../../config');
const { ensureDir } = require('../../utils/files');
const { unwrapMessage } = require('../../utils/messages');
const { ensureFfmpeg, paths } = require('../binaries/manager');

function envInt(name, def, min) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : def;
}
const MEDIA_CAP_MB = envInt('STICKER_MEDIA_CAP_MB', 15, 1);
const FFMPEG_TIMEOUT_MS = envInt('STICKER_FFMPEG_TIMEOUT_MS', 90000, 10000);
const MAX_OUT_BYTES = 64 * 1024 * 1024;

/** Find the first usable media (sticker/image) in a message, quoted or direct. */
function findMedia(message) {
  const pick = (mm) => {
    if (!mm) return [null, null];
    if (mm.stickerMessage) return ['sticker', mm.stickerMessage];
    if (mm.imageMessage) return ['image', mm.imageMessage];
    return [null, null];
  };
  const m = unwrapMessage(message || {});
  let [type, content] = pick(m);
  if (!type) {
    const ci = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo
      || m.videoMessage?.contextInfo || m.stickerMessage?.contextInfo;
    if (ci?.quotedMessage) [type, content] = pick(unwrapMessage(ci.quotedMessage));
  }
  return { type, content };
}

/** Download WhatsApp media content into RAM with a hard size cap. */
async function downloadMedia(content, type, capMB = MEDIA_CAP_MB) {
  const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
  const stream = await downloadContentFromMessage(content, type);
  const chunks = [];
  let size = 0;
  const max = capMB * 1024 * 1024;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw new Error(`Media exceeds the ${capMB} MB limit.`);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function isWebp(buf) {
  return Buffer.isBuffer(buf) && buf.length > 12
    && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WEBP';
}

/** Animated WebP carries an ANIM/ANMF chunk. */
function isAnimatedWebp(buf) {
  return isWebp(buf) && buf.includes('ANIM');
}

/** .tgs animated stickers are gzip-compressed Lottie JSON. */
function isTgs(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return false;
  if (buf[0] !== 0x1f || buf[1] !== 0x8b) return false;
  try {
    const head = zlib.gunzipSync(buf, { maxOutputLength: 2 * 1024 * 1024 })
      .subarray(0, 128).toString('utf8');
    return head.includes('"v"') || head.includes('"ddd"') || head.includes('{"');
  } catch {
    return false;
  }
}

/** The ffmpeg circular-mask filtergraph (square crop → scale → alpha circle). */
function circleFilter(size = 512) {
  const half = size / 2;
  const r = half - 4;
  return `crop=w='min(iw,ih)':h='min(iw,ih)',scale=${size}:${size},format=rgba,`
    + `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(hypot(X-${half},Y-${half}),${r}),255,0)'`;
}

function runFfmpeg(args, { input = null, timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(paths.ffmpeg, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    const chunks = [];
    let bytes = 0;
    let stderr = '';
    let done = false;
    const finish = (err, buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch {}
      if (err) reject(err);
      else resolve(buffer);
    };
    const timer = setTimeout(() => finish(new Error('FFmpeg timed out.')), timeoutMs);
    timer.unref?.();
    child.stdout.on('data', (c) => {
      bytes += c.length;
      if (bytes > MAX_OUT_BYTES) return finish(new Error('Converted media is too large.'));
      chunks.push(c);
    });
    child.stderr.on('data', (d) => { stderr = `${stderr}${d}`.slice(-4000); });
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => {
      if (done) return;
      if (code === 0) return finish(null, Buffer.concat(chunks, bytes));
      const last = stderr.trim().split('\n').filter(Boolean).pop();
      finish(new Error(last || `FFmpeg exited with code ${code}.`));
    });
    child.stdin.end(input ?? undefined);
  });
}

/** Image buffer → circular transparent PNG sticker source. */
async function circleCropPng(input, { size = 512 } = {}) {
  await ensureFfmpeg();
  return runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-i', 'pipe:0',
    '-vf', circleFilter(size),
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ], { input });
}

/** Static (or first-frame) WebP → PNG with transparency preserved. */
async function webpToPng(input) {
  await ensureFfmpeg();
  return runFfmpeg([
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-vcodec', 'webp', '-i', 'pipe:0',
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1',
  ], { input });
}

/**
 * Animated WebP → H.264 MP4 (faststart) for inline WhatsApp playback.
 *
 * The auto-downloaded FFmpeg build has WebP *encoders* but its native WebP
 * decoder only handles single-frame images, so we split the ANMF container
 * in pure JS: each animation frame's ALPH/VP8/VP8L sub-chunks become a
 * standalone single-frame WebP, which the decoder handles fine. The PNGs
 * are then piped through FFmpeg as an image sequence.
 */
function riffChunks(buf, start, end) {
  const chunks = [];
  let p = start;
  while (p + 8 <= end) {
    const fourcc = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (size < 0 || p + 8 + size > end) break;
    chunks.push({ fourcc, dataStart: p + 8, size });
    p += 8 + size + (size & 1);
  }
  return chunks;
}

function webpChunk(fourcc, data) {
  const head = Buffer.alloc(8);
  head.write(fourcc, 0, 'latin1');
  head.writeUInt32LE(data.length, 4);
  const pad = data.length & 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

/** Parse an animated WebP into standalone single-frame WebP buffers. */
function parseAnimatedWebp(buf) {
  if (!isWebp(buf)) return null;
  const riffSize = buf.readUInt32LE(4);
  const end = Math.min(buf.length, 8 + riffSize);
  let width = 0;
  let height = 0;
  const frames = [];
  for (const c of riffChunks(buf, 12, end)) {
    if (c.fourcc === 'VP8X' && c.size >= 10) {
      width = 1 + buf.readUIntLE(c.dataStart + 4, 3);
      height = 1 + buf.readUIntLE(c.dataStart + 7, 3);
    } else if (c.fourcc === 'ANMF' && c.size >= 16) {
      const durationMs = buf.readUIntLE(c.dataStart + 12, 3) || 100;
      const subs = riffChunks(buf, c.dataStart + 16, c.dataStart + c.size);
      const alpha = subs.find((s) => s.fourcc === 'ALPH');
      const codec = subs.find((s) => s.fourcc === 'VP8 ' || s.fourcc === 'VP8L');
      if (!codec) continue;
      const body = [];
      if (alpha) body.push(webpChunk('ALPH', buf.subarray(alpha.dataStart, alpha.dataStart + alpha.size)));
      body.push(webpChunk(codec.fourcc, buf.subarray(codec.dataStart, codec.dataStart + codec.size)));
      const payload = Buffer.concat(body);
      const head = Buffer.alloc(12);
      head.write('RIFF', 0, 'latin1');
      head.writeUInt32LE(4 + payload.length, 4);
      head.write('WEBP', 8, 'latin1');
      frames.push({ webp: Buffer.concat([head, payload]), durationMs });
    }
  }
  return frames.length ? { frames, width, height } : null;
}

async function webpToMp4(input, { maxFrames = 150 } = {}) {
  await ensureFfmpeg();
  const anim = parseAnimatedWebp(input);
  if (!anim) throw new Error('Could not read the animation frames.');
  const frames = anim.frames.slice(0, maxFrames);
  const avgMs = frames.reduce((a, f) => a + f.durationMs, 0) / frames.length;
  const fps = Math.min(30, Math.max(2, Math.round(1000 / avgMs)));
  ensureDir(config.paths.temp);
  const outFile = path.join(config.paths.temp, `sachi-s2i-${Date.now()}-${Math.random().toString(16).slice(2)}.mp4`);
  const concat = Buffer.concat(frames.map((f) => f.webp));
  try {
    // Fast path: decode the whole WebP sequence and encode MP4 in one spawn.
    try {
      await runFfmpeg([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'image2pipe', '-vcodec', 'webp', '-framerate', String(fps), '-i', 'pipe:0',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        outFile,
      ], { input: concat });
      if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return fs.readFileSync(outFile);
    } catch { /* fall through to per-frame decoding */ }
    // Robust path: decode each frame on its own, then rebuild the sequence.
    const pngs = [];
    for (const f of frames) pngs.push(await webpToPng(f.webp));
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-framerate', String(fps), '-vcodec', 'png', '-i', 'pipe:0',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      outFile,
    ], { input: Buffer.concat(pngs) });
    return fs.readFileSync(outFile);
  } finally {
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/** Build the WhatsApp sticker EXIF blob (pack/author metadata), same bytes
 *  every WA bot library emits; attached to the WebP as an EXIF RIFF chunk. */
/** The sticker pack/author follow the bot name (owner customisable). */
function brandName() {
  try { return String(require('../settings').name() || 'Sachi MD'); } catch { return 'Sachi MD'; }
}
function buildWaExif(pack, author) {
  const brand = brandName();
  pack = pack || brand;
  author = author || brand;
  const stickerPackID = 'com.etheral.waifuhub.android.stickercontentprovider b5e7275f-f1de-4137-961f-57becfad34f2';
  const json = JSON.stringify({
    'sticker-pack-id': stickerPackID,
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
  });
  let length = Buffer.byteLength(json, 'utf8');
  const start = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00]);
  const code = [0x00, 0x00, 0x16, 0x00, 0x00, 0x00];
  if (length > 256) { length -= 256; code.unshift(0x01); } else { code.unshift(0x00); }
  let lenHex = length.toString(16);
  if (length < 16) lenHex = `0${lenHex}`;
  return Buffer.concat([start, Buffer.from(lenHex, 'hex'), Buffer.from(code), Buffer.from(json, 'utf8')]);
}

/** Append (or replace) the EXIF RIFF chunk of a WebP file. */
function addExifToWebp(webp, exif) {
  if (!isWebp(webp)) throw new Error('Not a WebP buffer.');
  const riffSize = webp.readUInt32LE(4);
  const end = Math.min(webp.length, 8 + riffSize);
  const keep = [];
  for (const c of riffChunks(webp, 12, end)) {
    if (c.fourcc === 'EXIF') continue;
    keep.push(webp.subarray(c.dataStart - 8, c.dataStart + c.size + (c.size & 1)));
  }
  const body = Buffer.concat([Buffer.from('WEBP'), ...keep, webpChunk('EXIF', exif)]);
  const out = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), body]);
  out.writeUInt32LE(body.length, 4);
  return out;
}

/** Image (PNG/JPEG…) buffer → 512px WebP sticker with WhatsApp EXIF metadata. */
async function imageToStickerWebp(input, { pack, author, quality = 90 } = {}) {
  await ensureFfmpeg();
  ensureDir(config.paths.temp);
  const out = path.join(config.paths.temp, `sachi-stk-${Date.now()}-${Math.random().toString(16).slice(2)}.webp`);
  try {
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'image2pipe', '-i', 'pipe:0',
      '-vf', "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=black@0.0,format=rgba",
      '-c:v', 'libwebp', '-q:v', String(quality),
      out,
    ], { input });
    return addExifToWebp(fs.readFileSync(out), buildWaExif(pack, author));
  } finally {
    try { fs.unlinkSync(out); } catch {}
  }
}


/** Video (MP4) buffer → animated WebP sticker with WhatsApp EXIF metadata. */
async function videoToStickerWebp(input, {
  pack, author, fps = 15, durationS = 10, quality = 75,
} = {}) {
  await ensureFfmpeg();
  ensureDir(config.paths.temp);
  const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inFile = path.join(config.paths.temp, `sachi-stk-${id}.mp4`);
  const outFile = path.join(config.paths.temp, `sachi-stk-${id}.webp`);
  try {
    fs.writeFileSync(inFile, input);
    await runFfmpeg([
      '-y', '-hide_banner', '-loglevel', 'error',
      '-t', String(durationS), '-i', inFile,
      '-vf', `crop=w='min(iw,ih)':h='min(iw,ih)',scale=512:512,setsar=1,fps=${fps}`,
      '-an', '-c:v', 'libwebp', '-q:v', String(quality), '-loop', '0', '-vsync', '0',
      outFile,
    ]);
    return addExifToWebp(fs.readFileSync(outFile), buildWaExif(pack, author));
  } finally {
    try { fs.unlinkSync(inFile); } catch {}
    try { fs.unlinkSync(outFile); } catch {}
  }
}

/**
 * AI background removal — OPTIONAL quality path.
 * Returns a PNG (transparent bg) when @imgly/background-removal-node is
 * installed, or null when the package is not available (caller falls back
 * to the circle crop). Throws on real inference failures so the caller can
 * decide what to tell the user.
 */
function imageMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return 'image/png';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

async function removeBackgroundPng(input, { model, onStage } = {}) {
  let mod;
  try { mod = require('@imgly/background-removal-node'); } catch { return null; }
  if (!mod?.removeBackground) return null;
  onStage?.('Loading AI model…');
  const blob = await mod.removeBackground(new Blob([input], { type: imageMime(input) }), {
    model: model || process.env.BG_REMOVE_MODEL || 'small',
    output: { format: 'image/png' },
  });
  onStage?.('Computing cutout…');
  return Buffer.from(await blob.arrayBuffer());
}

module.exports = {
  MEDIA_CAP_MB,
  findMedia,
  downloadMedia,
  isWebp,
  isAnimatedWebp,
  isTgs,
  circleFilter,
  parseAnimatedWebp,
  buildWaExif,
  addExifToWebp,
  imageToStickerWebp,
  videoToStickerWebp,
  circleCropPng,
  webpToPng,
  webpToMp4,
  removeBackgroundPng,
};
