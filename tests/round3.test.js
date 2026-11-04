const test = require('node:test');
const assert = require('node:assert/strict');

test('progress reporter: failing status card never throws out of update/done/fail', async () => {
  const { createProgressReporter } = require('../src/services/downloader/progress');
  let attempts = 0;
  const reporter = createProgressReporter({
    send: async () => { attempts++; throw new Error('socket went away'); },
    edit: async () => { throw new Error('edit failed'); },
    jid: 'x@s.whatsapp.net',
    title: 'T',
  });
  reporter.setKey(null);
  // must not throw even though send() and edit() always fail
  await reporter.update({ percent: 50, downloaded: 10, total: 20 }, true);
  await reporter.update({ percent: 75 }, true);
  await reporter.done({ downloaded: 20, total: 20 });
  await reporter.fail('boom');
  assert.ok(attempts >= 1, 'initial card was attempted');
  // finished flag stops further work
  await reporter.update({ percent: 99 }, true);
});

test('progress reporter: normal flow still works', async () => {
  const { createProgressReporter, bar } = require('../src/services/downloader/progress');
  const sent = [];
  const reporter = createProgressReporter({
    send: async (jid, content) => { sent.push(content.text); return { key: { id: 'K1' } }; },
    edit: async (key, text) => { sent.push(text); },
    jid: 'x@s.whatsapp.net',
    title: 'T',
  });
  await reporter.update({ percent: 0 }, true);
  reporter.setKey({ id: 'K1' });
  await reporter.update({ percent: 50, downloaded: 5, total: 10 }, true);
  await reporter.done({ downloaded: 10, total: 10 });
  assert.equal(sent.length, 4, 'initial card + its first edit + 50% edit + done');
  assert.ok(sent[3].startsWith('✅ *T*'));
  assert.equal(bar(50, 10), '█████░░░░░');
  assert.equal(bar(undefined, 10), '░'.repeat(10));
  assert.equal(bar(150, 4), '████');
});

test('downloadToMemory survives a throwing onProgress callback', async () => {
  const http = require('../src/services/downloader/http');
  const dns = require('dns');
  const axios = require('axios');
  const { Readable } = require('stream');

  // neutralize SSRF checks for our fake host
  const realLookup = dns.promises.lookup;
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  // neutralize the HTTP layer
  const realGet = axios.get;
  const payload = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('fake-apk-body')]);
  axios.get = async () => ({
    status: 200,
    headers: { 'content-length': String(payload.length), 'content-type': 'application/octet-stream' },
    data: Readable.from([payload.subarray(0, 4), payload.subarray(4)]),
  });

  let throws = 0;
  try {
    const result = await http.downloadToMemory('https://example.com/fake.apk', {
      maxBytes: 1024 * 1024,
      onProgress: () => { throws++; throw new Error('UI blew up'); },
    });
    assert.equal(result.size, payload.length, 'full payload still downloaded');
    assert.equal(result.buffer.slice(0, 2).toString(), 'PK');
    assert.ok(throws >= 2, 'onProgress was actually invoked');
  } finally {
    dns.promises.lookup = realLookup;
    axios.get = realGet;
  }
});

test('status manager: redelivered status is seen/reacted only once', async () => {
  const statusManager = require('../src/services/status/manager');
  // the automations are persisted — keep the developer's file untouched
  const fs = require('fs');
  const file = require('path').join(require('../src/config').paths.data, 'status-settings.json');
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
  statusManager.setAutoSeen(true);
  statusManager.setAutoReact(true, '🔥');
  const reads = [];
  const reacts = [];
  const sock = {
    readMessages: async (keys) => reads.push(...keys),
    sendMessage: async (jid, content) => reacts.push(content),
  };
  const msg = {
    key: { remoteJid: 'status@broadcast', id: 'STATUS-1', participant: '947811111111@s.whatsapp.net', fromMe: false },
    message: { imageMessage: { caption: 'hi' } },
  };
  await statusManager.handleStatus(msg, sock);
  await statusManager.handleStatus(msg, sock); // redelivery (fresh, inside stale window)
  await statusManager.handleStatus(msg, sock); // another redelivery
  assert.equal(reads.length, 1, 'read receipt once');
  assert.equal(reacts.length, 1, 'reaction once');
  assert.deepEqual(reacts[0].react, { text: '🔥', key: msg.key });
  // a different status id still gets processed
  const msg2 = JSON.parse(JSON.stringify(msg));
  msg2.key.id = 'STATUS-2';
  await statusManager.handleStatus(msg2, sock);
  assert.equal(reads.length, 2);
  assert.equal(reacts.length, 2);
  } finally {
    if (backup === null) { try { fs.rmSync(file, { force: true }); } catch {} }
    else fs.writeFileSync(file, backup);
  }
});
