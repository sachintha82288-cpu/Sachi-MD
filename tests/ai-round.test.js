const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('stream');

/** Build an SSE response-like object from event list. */
function sseResp(events, { gapMs = 0, errorAfter = null } = {}) {
  async function* gen() {
    for (const e of events) {
      if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
      yield Buffer.from(`data: ${JSON.stringify(e)}\n\n`);
    }
    if (errorAfter) await new Promise((r) => setTimeout(r, errorAfter));
    if (errorAfter) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  }
  return { data: Readable.from(gen()) };
}

/** Fresh notrack module with custom env (env is read at require-time). */
function freshModule(env = {}) {
  const path = require.resolve('../src/services/ai/notrack');
  delete require.cache[path];
  for (const k of ['NOTRACK_TIMEOUT_MS', 'NOTRACK_IDLE_MS', 'NOTRACK_MAX_CONCURRENT', 'NOTRACK_QUEUE_MS']) delete process.env[k];
  Object.assign(process.env, env);
  return require('../src/services/ai/notrack');
}
const REAL_PATH = require.resolve('../src/services/ai/notrack');
function restoreModule() {
  delete require.cache[REAL_PATH];
  for (const k of ['NOTRACK_TIMEOUT_MS', 'NOTRACK_IDLE_MS', 'NOTRACK_MAX_CONCURRENT', 'NOTRACK_QUEUE_MS']) delete process.env[k];
  require('../src/services/ai/notrack');
}

const deltas = (chunks) => chunks.map((chunk) => ({ type: 'delta', speaker: 'AI', chunk }));

/** Keep the event loop alive while unref'd watchdog timers elapse. */
async function withKeepAlive(fn, ms) {
  const hold = setInterval(() => {}, 50);
  try {
    return await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('test timeout')), ms))]);
  } finally { clearInterval(hold); }
}

test('ai: normal stream → full answer, not truncated', async () => {
  const notrack = freshModule();
  const axios = require('axios');
  axios.post = async () => sseResp([
    { type: 'chat_meta', chat_id: 'x' },
    ...deltas(['Hello', ' world']),
    { type: 'message', speaker: 'AI', content: 'Hello world' },
    { type: 'done' },
  ]);
  try {
    const r = await notrack.ask('hi');
    assert.equal(r.text, 'Hello world');
    assert.equal(r.truncated, false);
  } finally { restoreModule(); }
});

test('ai: stream error MID-WAY delivers the partial answer (was: thrown away)', async () => {
  const notrack = freshModule();
  const axios = require('axios');
  axios.post = async () => sseResp(
    [...deltas(['The capital of France is', ' Paris, a city']),
     { type: 'thinking', speaker: 'AI', turn: 1 }],
    { errorAfter: 30 },
  );
  try {
    const r = await notrack.ask('capital of france');
    assert.ok(r.text.includes('Paris'), `partial delivered: ${r.text}`);
    assert.equal(r.truncated, true, 'flagged as truncated');
  } finally { restoreModule(); }
});

test('ai: stream error with NOTHING streamed → friendly rejection', async () => {
  const notrack = freshModule();
  const axios = require('axios');
  axios.post = async () => sseResp([], { errorAfter: 20 });
  try {
    await assert.rejects(() => notrack.ask('hi'), /temporarily unavailable|network/i);
  } finally { restoreModule(); }
});

test('ai: idle stall mid-stream → partial answer instead of a hang', () => withKeepAlive(async () => {
  const notrack = freshModule({ NOTRACK_IDLE_MS: '300' });
  const axios = require('axios');
  axios.post = async () => {
    const stream = new Readable({ read() {} });
    setTimeout(() => {
      stream.push(Buffer.from(`data: ${JSON.stringify(deltas(['Some streamed', ' text'])[0])}\n\n`));
      // …then silence forever
    }, 20);
    return { data: stream };
  };
  try {
    const r = await notrack.ask('hi');
    assert.ok(r.text.includes('Some streamed'), 'partial text resolved');
    assert.equal(r.truncated, true);
  } finally { restoreModule(); }
}, 5000));

test('ai: long healthy stream past the absolute cap → marked partial, not silent', () => withKeepAlive(async () => {
  const notrack = freshModule({ NOTRACK_TIMEOUT_MS: '1000', NOTRACK_IDLE_MS: '300' });
  const axios = require('axios');
  // 10 chunks × 250ms = 2.5s of continuous flow → absolute cap (~1.3s) fires mid-flow
  axios.post = async () => sseResp(deltas(Array.from({ length: 10 }, (_, i) => ` part${i}`)), { gapMs: 250 });
  try {
    const r = await notrack.ask('long story');
    assert.ok(r.text.includes('part'), 'text so far delivered');
    assert.equal(r.truncated, true, 'caller knows it was cut');
  } finally { restoreModule(); }
}, 10000));

test('ai: concurrency limiter — FIFO queue and busy-timeout', () => withKeepAlive(async () => {
  const notrack = freshModule({ NOTRACK_MAX_CONCURRENT: '1', NOTRACK_QUEUE_MS: '300' });
  const axios = require('axios');
  let release;
  const gate = new Promise((r) => { release = r; });
  axios.post = async (url, body) => {
    if (JSON.parse(JSON.stringify(body)).user_input === 'first') {
      const stream = new Readable({ read() {} }); // holds the single slot open
      gate.then(() => {
        stream.push(Buffer.from(`data: ${JSON.stringify(deltas(['finally'])[0])}\n\n`));
        stream.push(Buffer.from(`data: ${JSON.stringify({ type: 'done' })}\n\n`));
        stream.push(null);
      });
      return { data: stream };
    }
    return sseResp([...deltas(['ok']), { type: 'done' }]);
  };
  try {
    const first = notrack.ask('first');
    const second = notrack.ask('second');   // queued behind the open slot
    const third = notrack.ask('third');     // queued too
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(second && third);
    // first never finishes → second/third queued past 300ms → 'busy'
    await assert.rejects(() => second, /busy/i);
    await assert.rejects(() => third, /busy/i);
    release(); // now let the first finish
    await assert.doesNotReject(() => first);
  } finally { restoreModule(); }
}, 10000));

test('ai: concurrency limiter releases FIFO when a slot frees', () => withKeepAlive(async () => {
  const notrack = freshModule({ NOTRACK_MAX_CONCURRENT: '1', NOTRACK_QUEUE_MS: '5000' });
  const axios = require('axios');
  const order = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  axios.post = async (url, body) => {
    const input = body.user_input;
    if (input === 'first') {
      await gate;
      return sseResp([...deltas(['A']), { type: 'done' }]);
    }
    return sseResp([...deltas([input === 'second' ? 'B' : 'C']), { type: 'done' }]);
  };
  try {
    const first = notrack.ask('first').then((r) => { order.push('first:' + r.text); return r; });
    const second = notrack.ask('second').then((r) => { order.push('second:' + r.text); return r; });
    const third = notrack.ask('third').then((r) => { order.push('third:' + r.text); return r; });
    await new Promise((r) => setTimeout(r, 80));
    release();
    await Promise.all([first, second, third]);
    assert.deepEqual(order, ['first:A', 'second:B', 'third:C'], `FIFO order: ${order.join(' → ')}`);
  } finally { restoreModule(); }
}, 10000));

test('ai command: two simultaneous users never cross streams', async () => {
  const notrack = require('../src/services/ai/notrack');
  const command = require('../src/commands/ai/ai');
  const realAsk = notrack.ask;
  const pending = [];
  notrack.ask = (q, opts) => new Promise((resolve) => pending.push({ q, opts, resolve }));

  const mkCtx = (name) => {
    const edits = [];
    const key = { id: 'KEY-' + name };
    return {
      key, edits,
      args: [name === 'A' ? 'question-A' : 'question-B'],
      prefix: '.',
      reply: async (content) => { name; return { key }; },
      edit: async (k, payload) => { edits.push({ key: k && k.id, text: payload.text || payload }); },
    };
  };
  try {
    const ctxA = mkCtx('A');
    const ctxB = mkCtx('B');
    const runA = command.execute(ctxA);
    const runB = command.execute(ctxB);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(pending.length, 2, 'both asks in flight');
    // B finishes first
    pending[1].resolve({ text: 'ANSWER-B', reasoning: '', elapsedMs: 5 });
    pending[0].resolve({ text: 'ANSWER-A', reasoning: '', elapsedMs: 5, truncated: true });
    await Promise.all([runA, runB]);
    const lastA = ctxA.edits[ctxA.edits.length - 1];
    const lastB = ctxB.edits[ctxB.edits.length - 1];
    assert.equal(lastA.key, 'KEY-A');
    assert.ok(lastA.text.includes('ANSWER-A'), 'A got answer A');
    const bold = require('../src/menu/menu').bold;
    assert.ok(lastA.text.includes(bold('Answer may be incomplete')), 'truncation note present for A');
    assert.equal(lastB.key, 'KEY-B');
    assert.ok(lastB.text.includes('ANSWER-B'), 'B got answer B');
    assert.ok(!lastB.text.includes('ANSWER-A') && !lastA.text.includes('ANSWER-B'), 'no cross-contamination');
  } finally { notrack.ask = realAsk; }
});

test('ai command: over-long answers are trimmed with a visible note', async () => {
  const notrack = require('../src/services/ai/notrack');
  const command = require('../src/commands/ai/ai');
  const realAsk = notrack.ask;
  notrack.ask = async () => ({ text: 'x'.repeat(5000), reasoning: '', elapsedMs: 5 });
  try {
    const edits = [];
    const key = { id: 'K' };
    await command.execute({
      args: ['long'], prefix: '.', reply: async () => ({ key }),
      edit: async (k, payload) => edits.push(payload.text || payload),
    });
    const bold = require('../src/menu/menu').bold;
    assert.ok(edits[edits.length - 1].includes(bold('Long answer trimmed')), 'trim note present');
  } finally { notrack.ask = realAsk; }
});
