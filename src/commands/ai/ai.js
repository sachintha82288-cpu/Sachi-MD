const notrack = require('../../services/ai/notrack');
const { mdToWhatsApp, splitThink } = require('../../utils/aiText');
const { bold } = require('../../menu/menu');

const LINE = '━━━━━━━━━━━━━━━━━';
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const EDIT_MS = Math.max(900, Number(process.env.NOTRACK_STREAM_EDIT_MS || 1300));
const LIVE_TAIL = 420;
const MAX_ANSWER_CHARS = 3800;

function header() {
  return `🤖 ✦${bold('SACHI AI')}✦\n${LINE}`;
}

function liveView(state, frame, busy) {
  const spin = SPINNER[frame % SPINNER.length];
  let stage;
  if (state.inThinking || (!state.answer && state.reasoning)) {
    const tail = tailText(state.reasoning, LIVE_TAIL);
    stage = `💭 ${bold('Thinking…')} ${spin}\n\n_${tail || '…'}_`;
  } else if (state.answer) {
    const tail = mdToWhatsApp(tailText(state.answer, LIVE_TAIL));
    stage = `✍️ ${bold('Composing…')} ${spin}\n\n${tail}`;
  } else {
    stage = `💭 ${bold('Thinking…')} ${spin}\n\n_…_`;
  }
  const note = busy ? '\n\n🐌 _models are busy — a bit slower than usual_' : '';
  return `${header()}\n${stage}${note}`;
}

function tailText(text, max) {
  const s = String(text || '');
  return s.length > max ? `…${s.slice(-max)}` : s;
}

function finalView({ text, reasoning, elapsedMs, truncated }) {
  const secs = (elapsedMs / 1000).toFixed(1);
  const clean = splitThink(text);          // defensive: never leak <think> tags
  const converted = mdToWhatsApp(clean.answer);
  const body = converted.slice(0, MAX_ANSWER_CHARS)
    + (converted.length > MAX_ANSWER_CHARS ? `\n\n✂️ _${bold('Long answer trimmed')}_` : '');
  const reason = (reasoning || clean.reasoning).slice(0, 400);
  const thought = reason
    ? `💭 ${bold('Reasoned')} · _${reason.length.toLocaleString('en')} chars in thought_ · `
    : '';
  const cut = truncated ? `\n\n⚠️ _${bold('Answer may be incomplete')} — the stream was cut off._` : '';
  return `${header()}\n${body}${cut}\n\n${LINE}\n${thought}⏱ _${secs}s_ · ⚡ _NoTrack_`;
}

module.exports = {
  name: 'ai',
  aliases: ['ask', 'chat'],
  category: 'ai',
  emoji: '🤖',
  description: 'Ask the built-in AI — live thinking, free & key-less (NoTrack)',
  execute: async (ctx) => {
    const q = ctx.args.join(' ').trim();
    if (!q) return ctx.reply({ text: `${header()}\nUsage: ${ctx.prefix}${bold('ai')} <message>\n\n_Example:_ ${ctx.prefix}ai _explain photosynthesis simply_` });

    let frame = 0;
    let busy = false;
    let editBroken = false;
    let lastEditAt = 0;
    let editBusy = false;
    let lastState = null;

    const placeholder = await ctx.reply({ text: liveView({}, frame, false) });

    const pushEdit = async (state, force = false) => {
      if (editBroken || !placeholder?.key) return;
      lastState = state || lastState;
      if (editBusy) return;
      const now = Date.now();
      if (!force && now - lastEditAt < EDIT_MS) return;
      editBusy = true;
      lastEditAt = now;
      try {
        await ctx.edit(placeholder.key, liveView(lastState || {}, ++frame, busy));
      } catch { editBroken = true; }
      editBusy = false;
    };

    let result = null;
    let error = null;
    try {
      result = await notrack.ask(q, {
        onEvent: (evt) => { if (evt.type === 'busy') busy = true; },
        onDelta: (state) => { pushEdit(state).catch(() => {}); },
      });
    } catch (e) {
      error = e;
    }

    if (error) {
      const code = error?.code;
      const errorText = code === 'ratelimit' ? '🚦 The AI is rate-limited right now. Please try again in a minute.'
        : code === 'timeout' ? '⏱️ The AI took too long to answer. Please try again.'
        : code === 'network' ? '📡 Cannot reach the AI service right now. Please try again later.'
        : code === 'busy' ? `_busy_ Several people are asking the AI at once. Please try again in a moment.`
        : `❌ ${error?.message || 'The AI service is temporarily unavailable.'}`;
      const text = `${header()}\n${errorText}`;
      try { await ctx.edit(placeholder.key, text); }
      catch { await ctx.reply({ text }); }
      return;
    }

    const finalText = finalView(result || {});
    try {
      await ctx.edit(placeholder.key, finalText);
    } catch {
      await ctx.reply({ text: finalText });
    }
  },
};
