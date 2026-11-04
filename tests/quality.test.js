const test = require('node:test');
const assert = require('node:assert/strict');
const q = require('../src/services/downloader/quality');

test('video quality parser accepts supported values and auto', () => {
  assert.equal(q.parseVideoQuality('720').value, 720);
  assert.equal(q.parseVideoQuality('720p').value, 720);
  assert.equal(q.parseVideoQuality('auto').auto, true);
  assert.equal(q.parseVideoQuality('999'), null);
});

test('audio quality parser accepts supported bitrates', () => {
  assert.equal(q.parseAudioQuality('192').value, 192);
  assert.equal(q.parseAudioQuality('192k').value, 192);
  assert.equal(q.parseAudioQuality('999'), null);
});

test('yt-dlp format selectors respect selected limits', () => {
  assert.match(q.videoFormat(480), /height<=480/);
  assert.match(q.audioFormat(256), /abr<=256/);
});
