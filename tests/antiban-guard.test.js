const test = require('node:test');
const assert = require('node:assert/strict');

const antiban = require('../src/services/antiban');
const { HealthMonitor } = require('../src/services/antiban/health');
const { RateLimiter } = require('../src/services/antiban/rateLimiter');

// The menu tries several envelopes until one lands. The server rejecting
// one of them is NORMAL — it must never look like a ban risk, or the bot
// pauses itself and looks completely broken.

test('rejected menu envelopes never raise the ban-risk score', () => {
  antiban.reset();
  for (let i = 0; i < 12; i++) {
    antiban.afterOutbound('u@s.whatsapp.net', false, new Error('relayMessage rejected (503)'), { probe: true });
  }
  const s = antiban.status();
  assert.equal(s.health.risk, 0, 'the risk stays at 0');
  assert.equal(s.rate.paused, false, 'the bot is not paused');
  assert.equal(s.probes.rejected, 12, 'the rejections are counted for diagnostics');
});

test('a failed probe does not eat the rate budget, a delivered one counts once', () => {
  antiban.reset();
  for (let i = 0; i < 6; i++) {
    antiban.afterOutbound('u@s.whatsapp.net', false, new Error('rejected'), { probe: true });
  }
  assert.equal(antiban.status().rate.minute, 0, 'failed probes are free');
  antiban.afterOutbound('u@s.whatsapp.net', true, null, { probe: true });
  assert.equal(antiban.status().rate.minute, 1, 'the delivered message counts once');
});

test('a real send failure still counts (that IS a signal)', () => {
  antiban.reset();
  antiban.afterOutbound('u@s.whatsapp.net', false, new Error('socket hang up'));
  assert.ok(antiban.status().health.risk > 0, 'the risk went up');
});

test('the risk score walks back down on every good send', () => {
  const health = new HealthMonitor({});
  health.noteSendFail(new Error('boom'));
  const after = health.risk;
  assert.ok(after > 0);
  for (let i = 0; i < after; i++) health.noteSendOk();
  assert.equal(health.risk, 0, 'good sends clear the score');
});

test('a real failure never mutes the bot for more than 5 minutes', () => {
  const health = new HealthMonitor({});
  for (let i = 0; i < 20; i++) health.noteSendFail(new Error('boom'));
  assert.ok(health.suggestedPauseMs() <= 5 * 60_000, 'the worst pause is 5 minutes');
});

test('.antiban reset clears the health score AND the rate pause', () => {
  antiban.reset();
  antiban.afterOutbound('u@s.whatsapp.net', false, new Error('boom'));
  for (let i = 0; i < 10; i++) antiban.afterOutbound('u@s.whatsapp.net', false, new Error('boom'));
  assert.equal(antiban.status().rate.paused, true, 'the bot is paused');
  antiban.reset();
  const s = antiban.status();
  assert.equal(s.health.risk, 0, 'the risk is cleared');
  assert.equal(s.rate.paused, false, 'the pause is cleared — the bot talks again');
});

test('the pacing preset can be changed at runtime', () => {
  const before = antiban.status().rate.limits.minute;
  assert.equal(antiban.setPreset('conservative'), 'conservative');
  assert.equal(antiban.status().preset, 'conservative');
  assert.ok(antiban.status().rate.limits.minute < before, 'the limits follow the preset');
  assert.equal(antiban.setPreset('nope'), null);
  antiban.setPreset('moderate');
});

test('the rate limiter can be told to stop waiting', () => {
  const limiter = new RateLimiter({});
  limiter.pause(60_000);
  assert.equal(limiter.isPaused(), true);
  limiter.clearPause();
  assert.equal(limiter.isPaused(), false);
});
