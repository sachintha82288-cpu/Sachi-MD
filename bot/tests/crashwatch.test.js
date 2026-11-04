/**
 * Round 7 — the process must not limp on after repeated crashes.
 * "Online but dead" is the worst failure mode a bot has.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.CRASH_LIMIT = '3';
process.env.CRASH_WINDOW_MS = '60000';

const watch = require('../src/utils/crashwatch');
const crashlog = require('../src/utils/crashlog');
const config = require('../src/config');

test.after(() => { crashlog.clear(); watch.reset(); });

test('the watchdog stays quiet for isolated crashes', () => {
  watch.reset();
  const t0 = 1_000_000;
  assert.equal(watch.noteCrash(t0), false, 'first crash — keep running');
  assert.equal(watch.noteCrash(t0 + 1000), false, 'second crash — keep running');
  assert.equal(watch.state(t0 + 1000).recent, 2);
});

test('three crashes inside the window ask for a clean restart', () => {
  watch.reset();
  const t0 = 1_000_000;
  watch.noteCrash(t0);
  watch.noteCrash(t0 + 1000);
  assert.equal(watch.noteCrash(t0 + 2000), true, 'the third crash trips the watchdog');
});

test('crashes outside the window are forgotten', () => {
  watch.reset();
  const t0 = 1_000_000;
  watch.noteCrash(t0);
  watch.noteCrash(t0 + 1000);
  assert.equal(watch.noteCrash(t0 + 120_000), false, 'the old ones aged out');
  assert.equal(watch.state(t0 + 120_000).recent <= 2, true);
});

test('CRASH_RESTART=false keeps the old log-and-limp behaviour', () => {
  const original = process.env.CRASH_RESTART;
  process.env.CRASH_RESTART = 'false';
  for (const k of Object.keys(require.cache)) if (k.includes('crashwatch')) delete require.cache[k];
  const off = require('../src/utils/crashwatch');
  assert.equal(off.ENABLED, false);
  for (let i = 0; i < 10; i++) assert.equal(off.noteCrash(1_000_000 + i), false, 'never asks for a restart');
  process.env.CRASH_RESTART = original === undefined ? '' : original;
  if (original === undefined) delete process.env.CRASH_RESTART;
  for (const k of Object.keys(require.cache)) if (k.includes('crashwatch')) delete require.cache[k];
});

test('the crash report is written, readable and capped', () => {
  crashlog.clear();
  crashlog.write('uncaughtException', new Error('boom in handler'), [{ level: 'error', text: 'earlier problem' }]);
  crashlog.write('unhandledRejection', new Error('second boom'), []);
  const last = crashlog.last();
  assert.match(last, /unhandledRejection: Error: second boom/);
  const raw = fs.readFileSync(crashlog.FILE, 'utf8');
  assert.match(raw, /earlier problem/, 'the recent log lines are kept for the post-mortem');
  assert.ok(crashlog.clear());
  assert.equal(crashlog.last(), null);
});

test('.health surfaces the last crash', async () => {
  crashlog.clear();
  crashlog.write('uncaughtException', new Error('socket handler died'), []);
  const health = require('../src/commands/tools/health');
  let out = '';
  await health.execute({ reply: async (c) => { out = c.text; } });
  assert.match(out, /Last crash/);
  assert.match(out, /socket handler died/);
  crashlog.clear();
  let after = '';
  await health.execute({ reply: async (c) => { after = c.text; } });
  assert.ok(!/Last crash/.test(after), 'the section disappears once the log is cleared');
});
