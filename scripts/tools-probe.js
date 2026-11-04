/**
 * Tools probe — every network-backed tool, exercised for real.
 *
 * The fuzz harness (`bug-hunt.js`) checks that commands do not throw and that
 * their replies look sane, but it cannot know whether `https://something/` is
 * still a thing. This script calls the same service functions the commands call,
 * against the live internet, and prints PASS / FAIL with the reason and a
 * timing. Run it after touching any downloader:
 *
 *     node scripts/tools-probe.js            # everything
 *     node scripts/tools-probe.js wiki apk   # just some
 *
 * It never starts WhatsApp and never writes into data/.
 */
const axios = require('axios');

const only = process.argv.slice(2).map((s) => s.toLowerCase());
const want = (name) => !only.length || only.includes(name);

const results = [];
async function probe(name, fn, { soft = false } = {}) {
  if (!want(name)) return;
  const t0 = Date.now();
  try {
    const out = await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true, ms, note: out || '' });
    console.log(`✅ ${name.padEnd(12)} ${String(ms).padStart(6)} ms  ${out || ''}`);
  } catch (e) {
    const ms = Date.now() - t0;
    const reason = String(e && e.message ? e.message : e).slice(0, 160);
    results.push({ name, ok: false, ms, note: reason, soft });
    console.log(`${soft ? '⚠️ ' : '❌'} ${name.padEnd(12)} ${String(ms).padStart(6)} ms  ${reason}`);
  }
}

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

(async () => {
  /* ── plain HTTP tools ──────────────────────────────────────────────── */
  await probe('wiki', async () => {
    const r = await axios.get('https://en.wikipedia.org/api/rest_v1/page/summary/WhatsApp', {
      timeout: 15000, headers: { 'user-agent': 'SachiMD-probe/1.0 (tools audit)' },
    });
    if (!r.data || !r.data.extract) throw new Error('no extract in the response');
    return `${String(r.data.extract).slice(0, 40)}…`;
  });

  await probe('download', async () => {
    const { downloadToMemory } = require('../src/services/downloader/http');
    const r = await downloadToMemory('https://www.google.com/robots.txt', { maxBytes: 512 * 1024, timeout: 20000 });
    const size = r.buffer ? r.buffer.length : r.bytes;
    if (!size) throw new Error('empty body');
    return `${size} bytes`;
  });

  await probe('getdp', async () => {
    // the API the command uses, without a real socket
    const r = await axios.get('https://pps.whatsapp.net/v/t61.24694-24/00000000_0000000000_n.jpg', {
      timeout: 12000, maxRedirects: 3, validateStatus: () => true,
    });
    if (r.status >= 500) throw new Error(`pps.whatsapp.net answered ${r.status}`);
    return `answered ${r.status} (the endpoint is alive)`;
  }, { soft: true });

  /* ── YouTube (yt-search + yt-dlp) ──────────────────────────────────── */
  await probe('yts', async () => {
    const yts = require('yt-search');
    const r = await yts('lofi hip hop');
    if (!r || !Array.isArray(r.videos) || !r.videos.length) throw new Error('no videos returned');
    return `${r.videos.length} results · first: ${r.videos[0].title.slice(0, 30)}`;
  });

  await probe('ytdlp', async () => {
    const { ensureYtDlp } = require('../src/services/binaries/manager');
    await ensureYtDlp();
    const { paths } = require('../src/services/binaries/manager');
    const p = paths ? paths.ytDlp : null;
    if (!p) throw new Error('yt-dlp binary path unknown');
    const { execFileSync } = require('child_process');
    const v = execFileSync(p, ['--version'], { timeout: 20000 }).toString().trim();
    return `yt-dlp ${v}`;
  });

  await probe('ytmeta', async () => {
    const { ytdlpMeta } = require('../src/services/downloader/social');
    const m = await ytdlpMeta('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
    if (!m || !m.title) throw new Error('no metadata');
    return `"${String(m.title).slice(0, 34)}" · ${m.duration || '?'}s`;
  });

  /* ── social ────────────────────────────────────────────────────────── */
  await probe('tiktok', async () => {
    const { downloadTikTok } = require('../src/services/downloader/social');
    const r = await downloadTikTok('https://www.tiktok.com/@tiktok/video/7106594312292453675', { maxMB: 40 });
    if (!r || !r.buffer || !r.buffer.length) throw new Error('no video buffer');
    return `${(r.buffer.length / 1048576).toFixed(1)} MB`;
  }, { soft: true });

  await probe('facebook', async () => {
    const { downloadFacebook } = require('../src/services/downloader/social');
    const r = await downloadFacebook('https://www.facebook.com/watch/?v=10153231379946729', { maxMB: 40 });
    if (!r || !r.buffer || !r.buffer.length) throw new Error('no video buffer');
    return `${(r.buffer.length / 1048576).toFixed(1)} MB`;
  }, { soft: true });

  await probe('mediafire', async () => {
    const { downloadMediafire } = require('../src/services/downloader/social');
    const r = await downloadMediafire('https://www.mediafire.com/file/zulayut7xnratjf/test.txt/file', { maxMB: 5 });
    return r && r.buffer ? `${r.buffer.length} bytes` : 'no buffer';
  }, { soft: true });

  await probe('ytdl-video', async () => {
    const dl = require('../src/services/downloader/manager');
    const r = await dl.download('https://www.youtube.com/watch?v=aqz-KE-bpKQ', { mode: 'video', maxMB: 12, quality: '360p' });
    if (!r.buffer || r.buffer.length < 1000) throw new Error('no media produced');
    return `${(r.buffer.length / 1048576).toFixed(1)} MB · ${r.mimeType}`;
  });

  await probe('ytdl-audio', async () => {
    const dl = require('../src/services/downloader/manager');
    const r = await dl.download('https://www.youtube.com/watch?v=aqz-KE-bpKQ', { mode: 'audio', maxMB: 12, quality: '128k' });
    if (!r.buffer || r.buffer.length < 1000) throw new Error('no media produced');
    return `${(r.buffer.length / 1048576).toFixed(1)} MB · ${r.mimeType}`;
  });

  await probe('sticker', async () => {
    const sk = require('../src/services/media/stickerKit');
    const { execFileSync } = require('child_process');
    const fs = require('fs');
    const png = '/tmp/probe-sticker.png';
    execFileSync(require('../src/services/binaries/manager').paths.ffmpeg,
      ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x320:rate=1:duration=1', '-frames:v', '1', png], { stdio: 'ignore' });
    const webp = await sk.imageToStickerWebp(fs.readFileSync(png), { quality: 90 });
    const back = await sk.webpToPng(webp);
    if (!sk.isWebp(webp)) throw new Error('sticker is not webp');
    if (back.subarray(1, 4).toString() !== 'PNG') throw new Error('sticker2img output is not png');
    return `${webp.length} B webp → ${back.length} B png`;
  });

  /* ── apk ───────────────────────────────────────────────────────────── */
  await probe('apk-search', async () => {
    const apk = require('../src/services/downloader/apk');
    const r = await apk.search('whatsapp');
    if (!r || !r.length) throw new Error('search returned nothing from any source');
    return `${r.length} hits (${r[0].source}) · ${String(r[0].name || r[0].title || '').slice(0, 26)}`;
  });

  await probe('apk-download', async () => {
    const apk = require('../src/services/downloader/apk');
    // a small, real APK from F-Droid (~12 MB) — proves the direct-URL path
    const r = await apk.downloadApk({ url: 'https://f-droid.org/repo/org.fdroid.fdroid_1021051.apk', source: 'direct' }, { maxMB: 20 });
    if (!r.buffer || r.buffer.subarray(0, 2).toString() !== 'PK') throw new Error('not a zip/apk');
    return `${(r.buffer.length / 1048576).toFixed(1)} MB`;
  }, { soft: true });

  await probe('gitclone', async () => {
    const r = await axios.get('https://api.github.com/repos/octocat/Hello-World', {
      timeout: 15000, headers: { 'user-agent': 'SachiMD-probe/1.0', accept: 'application/vnd.github+json' },
    });
    if (!r.data || !r.data.default_branch) throw new Error('unexpected GitHub answer');
    return `${r.data.full_name} · default ${r.data.default_branch}`;
  });

  /* ── ai ────────────────────────────────────────────────────────────── */
  await probe('ai', async () => {
    const ai = require('../src/services/ai/notrack');
    const fn = ai.ask || ai.chat || ai.complete || ai.generate;
    if (typeof fn !== 'function') throw new Error('no ask/chat/complete export');
    const out = await fn('Reply with the single word: pong');
    const text = typeof out === 'string' ? out : (out && (out.text || out.answer)) || '';
    if (!text.trim()) throw new Error('empty answer');
    return text.trim().slice(0, 40);
  }, { soft: true });

  /* ── summary ───────────────────────────────────────────────────────── */
  const hard = results.filter((r) => !r.ok && !r.soft);
  const soft = results.filter((r) => !r.ok && r.soft);
  console.log('\n═══ summary ═══');
  console.log(`pass ${results.filter((r) => r.ok).length}/${results.length}` +
    (soft.length ? ` · soft-fail ${soft.map((r) => r.name).join(', ')}` : '') +
    (hard.length ? ` · HARD-FAIL ${hard.map((r) => r.name).join(', ')}` : ''));
  process.exit(hard.length ? 1 : 0);
})().catch((e) => { console.error('probe crashed:', e); process.exit(2); });
