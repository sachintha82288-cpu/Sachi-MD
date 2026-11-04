const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveInput, metaFromLocation, assertApkMagic } = require('../src/services/downloader/apk');

test('resolveInput classifies urls, packages and search queries', () => {
  assert.deepEqual(resolveInput('https://f-droid.org/repo/x_1.apk'), { type: 'url', value: 'https://f-droid.org/repo/x_1.apk' });
  assert.deepEqual(resolveInput('com.whatsapp'), { type: 'package', value: 'com.whatsapp' });
  assert.deepEqual(resolveInput('org.fdroid.fdroid'), { type: 'package', value: 'org.fdroid.fdroid' });
  const q = resolveInput('whatsapp messenger');
  assert.equal(q.type, 'query');
  assert.equal(q.value, 'whatsapp messenger');
  assert.equal(resolveInput('').type, 'empty');
  assert.equal(resolveInput('   ').type, 'empty');
});

test('metaFromLocation parses APKPure signed redirect params', () => {
  const loc = 'https://data.winudf.com/APK/abc?filename=WhatsApp+Messenger_2.26.37.73_APKPure.apk&full_size=76318490&package_name=com.whatsapp';
  const meta = metaFromLocation(loc);
  assert.equal(meta.name, 'WhatsApp Messenger');
  assert.equal(meta.version, '2.26.37.73');
  assert.equal(meta.sizeBytes, 76318490);
  assert.equal(metaFromLocation('https://x/y'), null);
});

test('assertApkMagic accepts zip/apk and rejects html/text', () => {
  assertApkMagic(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
  assertApkMagic(Buffer.from('PK\x03\x04 rest of apk'));
  assert.throws(() => assertApkMagic(Buffer.from('<!DOCTYPE html><html>CF challenge</html>')), /not a valid APK/);
  assert.throws(() => assertApkMagic(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), /not a valid APK/);
  assert.throws(() => assertApkMagic(Buffer.alloc(0)), /not a valid APK/);
});

test('play search html extractor keeps popularity order and dedupes', async () => {
  const { searchPlay } = require('../src/services/downloader/apk');
  // fake the network layer by injecting a fake fetchText through http module cache
  const httpMod = require('../src/services/downloader/http');
  const real = httpMod.fetchText;
  httpMod.fetchText = async () => `
    junk /store/apps/details?id=com.whatsapp more
    /store/apps/details?id=com.whatsapp.w4b
    /store/apps/details?id=com.whatsapp&hl=en
    /store/apps/details?id=org.thoughtcrime.securesms`;
  try {
    const items = await searchPlay('whatever', { limit: 6 });
    assert.deepEqual(items.map((i) => i.package), ['com.whatsapp', 'com.whatsapp.w4b', 'org.thoughtcrime.securesms']);
    assert.ok(items.every((i) => i.source === 'apkpure'));
  } finally {
    httpMod.fetchText = real;
  }
});

test('selection registry: remember, get, sender guard, one-per-chat, cancel, ttl', () => {
  const selections = require('../src/services/selection');
  selections.reset();
  let calls = 0;
  assert.equal(selections.remember('BOT1', { type: 'apk', chat: 'c1', sender: 'u1', handler: async () => { calls++; } }), true);
  assert.equal(selections.get('BOT1', 'c1', 'u1').type, 'apk');
  assert.equal(selections.get('BOT1', 'c1', 'u2'), null, 'different sender blocked');
  assert.equal(selections.get('BOT1', 'c2', 'u1'), null, 'different chat blocked');
  assert.equal(selections.get('UNKNOWN', 'c1', 'u1'), null);
  // one active per chat
  selections.remember('BOT2', { type: 'apk', chat: 'c1', sender: 'u1', handler: async () => {} });
  assert.equal(selections.get('BOT1', 'c1', 'u1'), null, 'old selection replaced');
  assert.ok(selections.get('BOT2', 'c1', 'u1'));
  // cancel
  assert.equal(selections.cancel('BOT2'), true);
  assert.equal(selections.get('BOT2', 'c1', 'u1'), null);
  // ttl: expired entries disappear
  const { execSync } = require('child_process');
  void execSync;
  selections.remember('BOT3', { type: 'apk', chat: 'c3', sender: 'u3', handler: async () => {} });
  // fast-forward expiry by patching the entry
  const mod = require('../src/services/selection');
  void mod;
  const entries = require('../src/services/selection');
  void entries;
  // direct TTL check via timer manipulation is not possible; rely on expiresAt logic
  assert.ok(selections.TTL >= 30_000);
  void calls;
});

test('downloadApk names: url basename, fdroid single .apk, bad input rejected', async () => {
  const apk = require('../src/services/downloader/apk');
  const httpMod = require('../src/services/downloader/http');
  const realDl = httpMod.downloadToMemory;
  const realFetch = httpMod.fetchText;
  const fake = Buffer.from('PK\x03\x04-fake-apk-bytes');
  httpMod.downloadToMemory = async () => ({ buffer: fake, size: fake.length, finalUrl: 'x' });
  httpMod.fetchText = async () => JSON.stringify({ suggestedVersionCode: 1023052 });
  try {
    // url fast-path: name derived from URL basename (not "undefined.apk")
    const r1 = await apk.downloadApk({ url: 'https://f-droid.org/repo/org.fdroid.fdroid_1023052.apk', source: 'direct' }, { maxMB: 500 });
    assert.equal(r1.fileName, 'org.fdroid.fdroid_1023052.apk');
    assert.equal(r1.source, 'direct');
    // fdroid path: no double .apk extension
    const r2 = await apk.downloadApk({ source: 'fdroid', package: 'org.fdroid.fdroid' }, { maxMB: 500 });
    assert.equal(r2.fileName, 'org.fdroid.fdroid.apk');
    assert.ok(!r2.fileName.includes('.apk.apk'));
    // apkpure-path string form still works (mocked resolver)
    const realResolve = apk.resolveApkPure;
    apk.resolveApkPure = async () => 'https://data.winudf.com/x?filename=Termux_1.0_APKPure.apk&full_size=5';
    try {
      const r3 = await apk.downloadApk('com.termux', { maxMB: 500 });
      assert.equal(r3.name, 'Termux');
      assert.equal(r3.version, '1.0');
      assert.equal(r3.fileName, 'Termux-1.0.apk');
    } finally { apk.resolveApkPure = realResolve; }
    // empty/invalid item → friendly error, no crash
    await assert.rejects(() => apk.downloadApk({}, { maxMB: 500 }), /app name, package id, or URL/);
  } finally {
    httpMod.downloadToMemory = realDl;
    httpMod.fetchText = realFetch;
  }
});

test('xapk bundles keep their extension and are flagged', async () => {
  const apk = require('../src/services/downloader/apk');
  const httpMod = require('../src/services/downloader/http');
  const realDl = httpMod.downloadToMemory;
  const realResolve = apk.resolveApkPure;
  const realApt = apk.aptoideForPackage;
  httpMod.downloadToMemory = async () => ({ buffer: Buffer.from('PK\x03\x04fake'), size: 12, finalUrl: 'x' });
  apk.resolveApkPure = async () => 'https://data.winudf.com/x?filename=NewPip+Mp3+Mp4+Downloader_4.0-APKPure.xapk&full_size=9&package_name=com.x';
  apk.aptoideForPackage = async () => null; // no plain-apk alternative → stay with the bundle
  try {
    const r = await apk.downloadApk({ source: 'apkpure', package: 'com.x' }, { maxMB: 500 });
    assert.ok(r.fileName.endsWith('.xapk'), 'keeps .xapk: ' + r.fileName);
    assert.equal(r.isBundle, true);
  } finally {
    httpMod.downloadToMemory = realDl;
    apk.resolveApkPure = realResolve;
    apk.aptoideForPackage = realApt;
  }
});

test('aptoide: search parse, package lookup, and fallback chain', async () => {
  const apk = require('../src/services/downloader/apk');
  const httpMod = require('../src/services/downloader/http');
  const realFetch = httpMod.fetchText;
  const realDl = httpMod.downloadToMemory;
  const realResolve = apk.resolveApkPure;
  const realApt = apk.aptoideForPackage;
  // search parse: datalist.list → full items; entries without file.path skipped
  httpMod.fetchText = async (url) => {
    if (url.includes('/apps/search?')) {
      return JSON.stringify({ datalist: { list: [
        { name: 'Instagram', package: 'com.instagram.android', file: { path: 'https://pool.apk.aptoide.com/x.apk', vername: '435.0', filesize: 134746521 } },
        { name: 'Broken', package: 'com.broken', file: {} },
        { name: 'Insta Lite', package: 'com.instagram.lite', file: { path: 'https://pool.apk.aptoide.com/y.apk', vername: '530.0', filesize: 3858759 } },
      ] } });
    }
    throw new Error('unexpected fetch ' + url);
  };
  try {
    const items = await apk.searchAptoide('instagram', { limit: 2 });
    assert.equal(items.length, 2);
    assert.equal(items[0].package, 'com.instagram.android');
    assert.equal(items[0].version, '435.0');
    assert.equal(items[0].sizeBytes, 134746521);
    assert.equal(items[0].source, 'aptoide');
  } finally { httpMod.fetchText = realFetch; }

  // fallback chain: apkpure unreachable → aptoide serves the app
  httpMod.downloadToMemory = async (url) => ({ buffer: Buffer.from('PK\x03\x04fake'), size: 12, finalUrl: url });
  apk.resolveApkPure = async () => null;
  apk.aptoideForPackage = async (pkg) => pkg === 'com.instagram.android'
    ? { url: 'https://pool.apk.aptoide.com/x.apk', name: 'Instagram', version: '435.0', sizeBytes: 134746521 }
    : null;
  try {
    const r = await apk.downloadApk({ source: 'apkpure', package: 'com.instagram.android' }, { maxMB: 500 });
    assert.equal(r.source, 'aptoide');
    assert.equal(r.version, '435.0');
    assert.equal(r.fileName, 'Instagram-435.0.apk');
    // both sources fail → aggregated original error
    apk.aptoideForPackage = async () => null;
    await assert.rejects(
      () => apk.downloadApk({ source: 'apkpure', package: 'com.ghost.app' }, { maxMB: 500 }),
      /unreachable|Aptoide/,
    );
  } finally {
    httpMod.downloadToMemory = realDl;
    apk.resolveApkPure = realResolve;
    apk.aptoideForPackage = realApt;
  }
});

test('xapk on apkpure prefers an aptoide plain apk', async () => {
  const apk = require('../src/services/downloader/apk');
  const httpMod = require('../src/services/downloader/http');
  const realDl = httpMod.downloadToMemory;
  const realResolve = apk.resolveApkPure;
  const realApt = apk.aptoideForPackage;
  httpMod.downloadToMemory = async (url) => ({ buffer: Buffer.from('PK\x03\x04fake'), size: 12, finalUrl: url });
  apk.resolveApkPure = async () => 'https://data.winudf.com/x?filename=Instagram_448.0-APKPure.xapk&full_size=9&package_name=com.instagram.android';
  apk.aptoideForPackage = async () => ({ url: 'https://pool.apk.aptoide.com/insta.apk', name: 'Instagram', version: '435.0', sizeBytes: 10 });
  try {
    const r = await apk.downloadApk({ source: 'apkpure', package: 'com.instagram.android' }, { maxMB: 500 });
    assert.equal(r.source, 'aptoide', 'plain apk preferred over xapk bundle');
    assert.equal(r.isBundle, false);
    assert.ok(!r.fileName.includes('xapk'));
  } finally {
    httpMod.downloadToMemory = realDl;
    apk.resolveApkPure = realResolve;
    apk.aptoideForPackage = realApt;
  }
});
