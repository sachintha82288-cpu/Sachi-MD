const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findMedia, isWebp, isAnimatedWebp, isTgs, circleFilter, MEDIA_CAP_MB,
} = require('../src/services/media/stickerKit');

function webpBuffer({ animated = false } = {}) {
  const head = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP')]);
  if (!animated) return Buffer.concat([head, Buffer.from('VP8 \x00\x00\x00\x00')]);
  return Buffer.concat([head, Buffer.from('VP8X \x00\x00\x00\x00'), Buffer.from('ANIM\x00\x00\x00\x00'), Buffer.from('ANMF\x00\x00\x00\x00')]);
}

test('webp magic detection: static vs animated', () => {
  assert.equal(isWebp(webpBuffer()), true);
  assert.equal(isWebp(webpBuffer({ animated: true })), true);
  assert.equal(isAnimatedWebp(webpBuffer()), false);
  assert.equal(isAnimatedWebp(webpBuffer({ animated: true })), true);
  assert.equal(isWebp(Buffer.from('not a webp at all')), false);
  assert.equal(isAnimatedWebp(Buffer.from('RIFFxxxxWEBP but no anim chunk')), false);
});

test('tgs (gzip lottie) detection', () => {
  const zlib = require('node:zlib');
  const tgs = zlib.gzipSync(Buffer.from('{"v":"5.7.4","ddd":"Caca","fr":60}'));
  assert.equal(isTgs(tgs), true);
  assert.equal(isTgs(webpBuffer()), false);
});

test('circle filter encodes the requested size', () => {
  const f = circleFilter(512);
  assert.ok(f.includes('scale=512:512'));
  assert.ok(f.includes('hypot(X-256,Y-256)'));
  assert.ok(f.includes('format=rgba'));
});

test('findMedia reads direct and quoted stickers/images', () => {
  const direct = { stickerMessage: { mimetype: 'image/webp' } };
  assert.deepEqual(findMedia(direct), { type: 'sticker', content: direct.stickerMessage });
  const quoted = { extendedTextMessage: { text: '.toimg', contextInfo: { quotedMessage: { imageMessage: { caption: null } } } } };
  const r = findMedia(quoted);
  assert.equal(r.type, 'image');
  assert.ok(r.content);
  assert.deepEqual(findMedia({ conversation: '.toimg' }), { type: null, content: null });
});

test('media cap env is NaN-safe', () => {
  assert.ok(Number.isFinite(MEDIA_CAP_MB) && MEDIA_CAP_MB >= 1);
});

test('buildWaExif embeds pack metadata bytes', () => {
  const { buildWaExif } = require('../src/services/media/stickerKit');
  const exif = buildWaExif('My Pack', 'Author X');
  assert.ok(exif.includes('My Pack'));
  assert.ok(exif.includes('Author X'));
  assert.ok(exif.subarray(0, 4).toString('latin1') === 'II*\\0' || exif[0] === 0x49);
});

test('addExifToWebp appends EXIF chunk and fixes RIFF size', () => {
  const { addExifToWebp, buildWaExif, isWebp } = require('../src/services/media/stickerKit');
  const fake = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from('VP8 \\x00\\x00\\x00\\x00')]);
  fake.writeUInt32LE(fake.length - 8, 4);
  const out = addExifToWebp(fake, buildWaExif('P'));
  assert.equal(isWebp(out), true);
  assert.ok(out.includes('EXIF'));
  assert.equal(8 + out.readUInt32LE(4), out.length);
  // idempotent: re-adding replaces instead of duplicating
  const out2 = addExifToWebp(out, buildWaExif('P'));
  assert.equal((out2.toString('latin1').match(/EXIF/g) || []).length, 1);
});
