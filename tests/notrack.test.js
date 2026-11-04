const test = require('node:test');
const assert = require('node:assert/strict');
const { StringDecoder } = require('string_decoder');
const { SseParser, AiError, ask } = require('../src/services/ai/notrack');

test('sse parser assembles split data blocks across chunks', () => {
  const p = new SseParser();
  const a = p.push('data: {"type":"delta","chunk":"Hel');
  assert.deepEqual(a, []);
  const b = p.push('lo"}\n\ndata: {"type":"message","content":"done"}\n\n');
  assert.equal(b.length, 2);
  assert.equal(b[0].type, 'delta');
  assert.equal(b[0].chunk, 'Hello');
  assert.equal(b[1].content, 'done');
});

test('sse parser skips malformed json and blank blocks', () => {
  const p = new SseParser();
  const events = p.push('data: {broken\n\ndata: {"type":"done"}\n\n\n\n: keep-alive\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'done');
});

test('multibyte text survives chunks split mid-character', () => {
  const line = 'data: {"type":"delta","chunk":"ආහාර 🍛 Sinhala OK"}\n\n';
  const buf = Buffer.from(line, 'utf8');
  let checked = 0;
  for (let cut = 7; cut < buf.length - 1; cut++) {
    const decoder = new StringDecoder('utf8');
    const p = new SseParser();
    const events = [
      ...p.push(decoder.write(buf.subarray(0, cut))),
      ...p.push(decoder.write(buf.subarray(cut))),
      ...p.push(decoder.end()),
    ];
    assert.equal(events.length, 1, `one event at cut=${cut}`);
    assert.equal(events[0].chunk, 'ආහාර 🍛 Sinhala OK', `clean text at cut=${cut}`);
    checked++;
  }
  assert.ok(checked > 20);
});

test('empty prompt is rejected without network', async () => {
  await assert.rejects(() => ask('   '), (e) => e instanceof AiError && e.code === 'bad_request');
});
