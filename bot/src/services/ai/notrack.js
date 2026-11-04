/**
 * NoTrack AI service — free, key-less AI replies via notrack.ai.
 *
 * Protocol (reverse-engineered from the notrack.ai web client's JavaScript):
 *   POST https://notrack.ai/api/dispatch
 *   Content-Type: application/json
 *   body: { user_input, mode, model, persona, max_turns, chat_id,
 *           attachments, regenerate, edit, edit_mid, via }
 *   → text/event-stream made of `data: {json}\n\n` blocks.
 *
 *   Event types seen on the wire:
 *     chat_meta  { chat_id, mode }        — new chat identifier
 *     user       { turn, content, message_id }
 *     thinking   { speaker, turn }
 *     busy       { why, text, ab }        — optional "models are busy" notice
 *     delta      { speaker, turn, chunk } — streamed text fragments
 *     message    { speaker, turn, content } — FINAL answer (authoritative)
 *     consensus  { content }              — debate-mode final answer
 *     error      { code, content }        — e.g. code 'ratelimit'
 *     done                                — end of stream
 *
 * The stream may embed the model's reasoning inside <think>…</think> blocks;
 * reasoning is separated from the answer with utils/aiText.splitThink().
 *
 * No API key, no account, no cookies required. Stateless.
 */
const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const { splitThink, isInThink } = require('../../utils/aiText');

const ENDPOINT = process.env.NOTRACK_API_URL || 'https://notrack.ai/api/dispatch';
const MODEL = (process.env.NOTRACK_MODEL || 'C').trim().slice(0, 1).toUpperCase() || 'C';
const PERSONA = (process.env.NOTRACK_PERSONA || 'normal').trim() || 'normal';
const MODE = 'usual';
function envInt(name, def, min) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.max(min, n) : def;
}
const TIMEOUT_MS = envInt('NOTRACK_TIMEOUT_MS', 90000, 15000);
/** No-data window: if NOTHING arrives for this long the stream is dead. */
const IDLE_MS = envInt('NOTRACK_IDLE_MS', 45000, 300);
/** Max simultaneous dispatches — notrack.ai allows ~1 per IP; parallel
 *  requests get 429'd, so we queue instead (verified live 2026-09). */
const MAX_CONCURRENT = envInt('NOTRACK_MAX_CONCURRENT', 1, 1);
/** How long a request may wait in the concurrency queue before giving up. */
const QUEUE_MS = envInt('NOTRACK_QUEUE_MS', 45000, 250);
const MAX_PROMPT_CHARS = 4000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

class AiError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AiError';
    this.code = code || 'ai_error';
  }
}

/**
 * Incremental parser for the `data: {json}\n\n` SSE flavour notrack.ai uses.
 * Kept as a small class so it can be unit-tested without network access.
 */
class SseParser {
  constructor() { this.buf = ''; }
  push(text) {
    this.buf += String(text || '');
    const events = [];
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try { events.push(JSON.parse(line.slice(6))); } catch { /* skip malformed block */ }
    }
    return events;
  }
}

function friendly(err) {
  if (err instanceof AiError) return err;
  if (err?.response?.status === 429)
    return new AiError('The AI is rate-limited right now. Please try again in a minute.', 'ratelimit');
  const text = String(err?.message || err || '').toLowerCase();
  if (err?.code === 'ECONNABORTED' || text.includes('timeout'))
    return new AiError('The AI took too long to answer. Please try again.', 'timeout');
  if (['enotfound', 'econnrefused', 'econnreset', 'eai_again'].some((c) => text.includes(c)))
    return new AiError('Cannot reach the AI service right now. Please try again later.', 'network');
  return new AiError('The AI service is temporarily unavailable. Please try again later.', 'ai_error');
}

/**
 * Ask notrack.ai with live streaming updates (single in-flight request).
 * Resolves with { text, reasoning, speaker, elapsedMs, truncated }.
 *   onEvent(evt)   — optional; { type, speaker } notifications ('busy' etc.)
 *   onDelta(state) — optional; called while text streams in with
 *                    { reasoning, answer, inThinking } accumulated so far.
 */
async function askOnce(prompt, { onEvent, onDelta } = {}) {
  const input = String(prompt || '').trim().slice(0, MAX_PROMPT_CHARS);
  if (!input) throw new AiError('Empty prompt.', 'bad_request');
  const startedAt = Date.now();

  let resp;
  try {
    resp = await axios.post(ENDPOINT, {
      user_input: input,
      mode: MODE,
      model: MODEL,
      persona: PERSONA,
      max_turns: 3,
      chat_id: null,
      attachments: [],
      regenerate: false,
      edit: false,
      edit_mid: null,
      via: 'typed',
    }, {
      timeout: TIMEOUT_MS,
      responseType: 'stream',
      maxRedirects: 5,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': UA,
        Origin: 'https://notrack.ai',
        Referer: 'https://notrack.ai/chat',
      },
    });
  } catch (e) {
    throw friendly(e);
  }

  return await new Promise((resolve, reject) => {
    const parser = new SseParser();
    const decoder = new StringDecoder('utf8');
    let raw = '';
    let finalContent = null;
    let speaker = null;
    let lastError = null;
    let settled = false;
    let idleTimer = null;

    const streamState = () => ({
      ...splitThink(raw),
      inThinking: isInThink(raw),
    });

    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(idleTimer);
      try { resp.data.destroy(); } catch {}
      if (err) return reject(err);
      const fromFinal = splitThink(finalContent ?? '');
      const fromRaw = splitThink(raw);
      const text = fromFinal.answer || fromRaw.answer;
      const reasoning = fromFinal.reasoning || fromRaw.reasoning;
      if (!text) return reject(new AiError('The AI returned an empty response. Please try again.', 'empty'));
      // Everything the model already said is precious: a cut stream (network
      // reset, absolute cap, missing done event) resolves with the partial
      // answer instead of throwing it away, flagged so callers can say so.
      resolve({ text, reasoning, speaker, elapsedMs: Date.now() - startedAt, truncated: !finalContent });
    };

    // Idle watchdog: the stream is dead only when NO data flows. Reset on
    // every chunk so long-but-healthy answers are never cut mid-sentence.
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(raw || finalContent ? null : new AiError('The AI took too long to answer. Please try again.', 'timeout'));
      }, IDLE_MS);
      idleTimer.unref?.();
    };
    // Absolute cap (stream must still end eventually).
    const watchdog = setTimeout(() => {
      finish(raw || finalContent ? null : new AiError('The AI took too long to answer. Please try again.', 'timeout'));
    }, TIMEOUT_MS + Math.min(5000, IDLE_MS));
    watchdog.unref?.();
    armIdle();

    resp.data.on('data', (chunk) => {
      armIdle();
      for (const evt of parser.push(decoder.write(chunk))) {
        try { onEvent?.({ type: evt.type, speaker: evt.speaker ?? null }); } catch {}
        if (evt.type === 'delta') {
          if (typeof evt.chunk === 'string' && evt.chunk) {
            raw += evt.chunk;
            speaker = evt.speaker || speaker;
            if (onDelta) { try { onDelta(streamState()); } catch {} }
          }
        } else if (evt.type === 'message' || evt.type === 'consensus') {
          if (typeof evt.content === 'string' && evt.content.trim()) {
            finalContent = evt.content;
            speaker = evt.speaker || speaker;
          }
        } else if (evt.type === 'error') {
          const code = evt.code || 'ai_error';
          lastError = new AiError(
            code === 'ratelimit'
              ? 'The AI is rate-limited right now. Please try again in a minute.'
              : String(evt.content || 'The AI service reported an error.').slice(0, 200),
            code,
          );
        } else if (evt.type === 'done') {
          finish(lastError && !finalContent && !raw ? lastError : null);
        }
      }
    });

    resp.data.on('end', () => { try { parser.push(decoder.end()); } catch {} finish(lastError && !finalContent && !raw ? lastError : null); });
    resp.data.on('error', (e) => {
      // A network reset after the model already said something useful is a
      // truncation, not a failure — deliver what streamed.
      finish(raw || finalContent ? null : friendly(e));
    });
  });
}

/**
 * Public ask() — bounds how many requests hit notrack.ai at once so a
 * burst of users cannot trigger a wave of rate-limit errors. Extra calls
 * wait FIFO; requests queued longer than QUEUE_MS get a friendly error.
 */
let active = 0;
const queue = [];
async function ask(prompt, opts = {}) {
  if (active >= MAX_CONCURRENT) {
    await new Promise((resolve, reject) => {
      const item = { resolve, reject };
      queue.push(item);
      const timer = setTimeout(() => {
        const i = queue.indexOf(item);
        if (i !== -1) {
          queue.splice(i, 1);
          reject(new AiError('The AI is busy right now — several people are asking at once. Please try again in a moment.', 'busy'));
        }
      }, QUEUE_MS);
      timer.unref?.();
    });
  }
  active++;
  try {
    return await askOnce(prompt, opts);
  } finally {
    active--;
    const next = queue.shift();
    if (next) next.resolve();
  }
}

function status() {
  return {
    provider: 'notrack.ai', model: MODEL, persona: PERSONA, mode: MODE,
    timeoutMs: TIMEOUT_MS, idleMs: IDLE_MS, maxConcurrent: MAX_CONCURRENT,
    active, queued: queue.length,
  };
}

module.exports = { ask, status, SseParser, AiError, ENDPOINT };
