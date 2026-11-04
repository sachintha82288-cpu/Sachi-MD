/* Full E2E menu simulation for the button menu (v2).
 *
 * Simulates the whole delivery ladder of the menu system:
 *   card (native-flow) → card (bare) → legacy list → logo image → text
 * and the duplicate-menu guard on top of it.
 *
 * Run: node scripts/menu-e2e-sim.js
 */
process.env.MENU_FALLBACK_MS = '300';
process.env.MENU_ENVELOPE_TIMEOUT_MS = '600';
process.env.ANTIBAN_ENABLED = 'false';

const path = require('path');
const fs = require('fs');
const LOGO = path.join(__dirname, '..', 'assets', 'logo.jpg');
const router = require('../src/router/router');
const config = require('../src/config');
const capabilities = require('../src/services/menu/capabilities');
const confirm = require('../src/services/menu/confirm');

// The real shutdown command kills the process — stub it out for the sim.
// (The router reloads every command module with a clean require cache, so
// the patch has to happen on the loaded command object itself.)
router.loadCommands();
const shutdownCmd = router.list().find((c) => c.name === 'shutdown');
if (shutdownCmd) shutdownCmd.execute = async ({ reply }) => { await reply({ text: '⛔ Shutting down...' }); };
// The MAIN number — the one typed into the terminal at boot.
const MAIN = String(config.ownerNumber || '94750404115');
const MAIN_JID = `${MAIN}@s.whatsapp.net`;
const results = [];
const report = (n, ok, d) => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

function msg(text, jid = 'user@s.whatsapp.net', stanzaId) {
  return {
    key: { remoteJid: jid, id: 'IN' + Math.random(), fromMe: false, participant: jid.endsWith('@g.us') ? '94771234567@s.whatsapp.net' : undefined },
    pushName: 'T',
    messageTimestamp: Math.floor(Date.now() / 1000),
    message: stanzaId ? { conversation: text, extendedTextMessage: { text, contextInfo: { stanzaId } } } : { conversation: text }
  };
}

function sock(sends, { cardMode = 'delivered', imageMode = 'delivered', receiptsWork = true } = {}) {
  const s = {
    lastKey: null,
    sendMessage: async (j, c, o) => {
      const k = { id: 'BOT-' + Math.random() };
      s.lastKey = k;
      const kind = c && c.__interactive ? 'card' : c && c.image ? 'image' : c && c.react ? (o && o.trackDelivery ? 'probe' : 'react') : 'text';
      sends.push(kind);
      if (!(o && o.trackDelivery)) return { key: k };
      const outcome = kind === 'card' ? cardMode : kind === 'image' ? imageMode : (receiptsWork ? 'delivered' : 'timeout');
      return { key: k, delivery: Promise.resolve(outcome) };
    }
  };
  return s;
}

const run = (s, m) => router.handle(s, m, config, (j, c, o) => s.sendMessage(j, c, o));
const tap = (id, jid) => ({
  ...msg('t', jid || 'user@s.whatsapp.net'),
  message: { interactiveResponseMessage: { nativeFlowResponseMessage: { name: 'menu_options', paramsJson: JSON.stringify({ id }) }, contextInfo: { stanzaId: 'X' } } }
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let simN = 0;
  const J = () => `u${++simN}@s.whatsapp.net`;

  // 1 — DM .menu → interactive card
  {
    capabilities.reset();
    const s = [];
    const before = Date.now();
    await run(sock(s), msg('.menu', J()));
    const ms = Date.now() - before;
    report('1. DM .menu → button card INSTANTLY', s.includes('card') && !s.includes('image') && ms < 800, `${s.join(',')} in ${ms}ms`);
  }

  // 2 — group .menu → card
  {
    capabilities.reset();
    const s = [];
    await run(sock(s), msg('.menu', '12345@g.us'));
    await sleep(200);
    report('2. GROUP .menu → button card', s.includes('card') && !s.includes('image'), s.join(','));
  }

  // 3 — card rejected → logo image menu
  {
    capabilities.reset();
    const s = [];
    await run(sock(s, { cardMode: 'error' }), msg('.menu', J()));
    await sleep(200);
    report('3. Card rejected → logo image menu', s.includes('card') && s.includes('image') && !s.includes('text'), s.join(','));
  }

  // 4 — card rejected AND image rejected → text menu
  {
    capabilities.reset();
    const s = [];
    await run(sock(s, { cardMode: 'error', imageMode: 'error' }), msg('.menu', J()));
    await sleep(200);
    report('4. Card + image rejected → text menu', s.includes('text'), s.join(','));
  }

  // 5 — DM card unacked, receipts dead → card kept, NO duplicate
  {
    capabilities.reset();
    const s = [];
    await run(sock(s, { cardMode: 'timeout', receiptsWork: false }), msg('.menu', J()));
    await sleep(600);
    const cards = s.filter((x) => x === 'card').length;
    const others = s.filter((x) => x === 'image' || x === 'text').length;
    report('5. DM card unacked + dead receipts → NO duplicate', cards === 1 && others === 0, s.join(','));
  }

  // 6 — DM card unacked, receipts alive → single image fallback
  {
    capabilities.reset();
    const s = [];
    await run(sock(s, { cardMode: 'timeout', receiptsWork: true }), msg('.menu', J()));
    await sleep(600);
    report('6. DM card unacked + live receipts → image fallback once', s.filter((x) => x === 'image').length === 1, s.join(','));
  }

  // 7 — group card unacked → card kept (no probe, no duplicate)
  {
    capabilities.reset();
    const s = [];
    await run(sock(s, { cardMode: 'timeout' }), msg('.menu', '12345@g.us'));
    await sleep(600);
    report('7. GROUP card unacked → card kept, no probe', s.filter((x) => x === 'card').length === 1 && s.filter((x) => x === 'probe').length === 0, s.join(','));
  }

  // 8 — category tap → category card
  {
    capabilities.reset();
    const s = [];
    await run(sock(s), tap('menu:cat:1', J()));
    await sleep(200);
    report('8. Category tap → category card', s.includes('card') && !s.includes('image'), s.join(','));
  }

  // 9 — command tap → command runs
  {
    capabilities.reset();
    const s = [];
    await run(sock(s), tap('cmd:ping', J()));
    await sleep(200);
    report('9. Command tap → command output', s.filter((x) => x === 'text').length >= 1, s.join(','));
  }

  // 10 — destructive tap → confirm card, confirm → runs.
  // `.shutdown` is main-only since multi-session landed, so the sim has to
  // speak as the MAIN number (a jid with no digits can never be one).
  {
    capabilities.reset();
    confirm.reset();
    const owner = config.owner;
    config.owner = MAIN_JID;
    const s = [];
    await run(sock(s), tap('cmd:shutdown', MAIN_JID));
    await sleep(200);
    const hasCard = s.includes('card');
    s.length = 0;
    await run(sock(s), tap('cmd:shutdown:confirm', MAIN_JID));
    await sleep(200);
    const ran = s.filter((x) => x === 'text').some(() => true);
    config.owner = owner;
    report('10. Destructive tap → confirm card → confirm runs', hasCard && ran, s.join(','));
  }

  // 11 — typed number still opens a category (classic path alive)
  {
    capabilities.reset();
    const s = [];
    const jid = J();
    const sk = sock(s);
    await run(sk, msg('.menu', jid));
    const menuId = sk.lastKey && sk.lastKey.id;
    s.length = 0;
    await router.handle(sk, msg('1', jid, menuId), config, (j, c, o) => sk.sendMessage(j, c, o));
    await sleep(200);
    report('11. Typed "1" on the menu → category card', s.includes('card'), s.join(','));
  }

  // 12 — logo missing → text menu last resort
  {
    capabilities.reset();
    const s = [];
    // every shipped logo file goes away — the menu must survive without one
    const logos = [LOGO, LOGO.replace(/\.jpg$/, '.png')];
    const baks = [];
    try {
      for (const f of logos) {
        if (fs.existsSync(f)) { const b = f + '.sim-bak'; fs.renameSync(f, b); baks.push([b, f]); }
      }
      await run(sock(s, { cardMode: 'error' }), msg('.menu', J()));
      await sleep(200);
    } finally {
      for (const [b, f] of baks) if (fs.existsSync(b)) fs.renameSync(b, f);
    }
    report('12. Logo missing → text menu last resort', s.includes('text'), s.join(','));
  }

  // 13 — a chat that rejects cards is not asked twice
  {
    capabilities.reset();
    const s = [];
    const jid = J();
    await run(sock(s, { cardMode: 'error' }), msg('.menu', jid));
    s.length = 0;
    await run(sock(s, { cardMode: 'error' }), msg('.menu', jid));
    await sleep(200);
    report('13. Rejected envelopes are not retried for the same chat', s.filter((x) => x === 'card').length === 0, s.join(','));
  }

  // 14 — the card carries the logo as media header + a one-line body
  {
    capabilities.reset();
    let payload = null;
    const sk = {
      sendMessage: async (j, c, o) => {
        if (c && c.__interactive && !payload) payload = c;
        const key = { id: 'BOT-' + Math.random() };
        if (o && o.trackDelivery) return { key, delivery: Promise.resolve('delivered') };
        return { key };
      }
    };
    await run(sk, msg('.menu', J()));
    const im = payload?.content?.viewOnceMessage?.message?.interactiveMessage;
    const hasLogo = !!payload?.media && /logo\.(jpg|png)$/.test(payload.media.image.url);
    const shortBody = !!im && im.body.text.length < 80;
    report('14. Card = logo media header + one-line body', hasLogo && shortBody,
      `media=${hasLogo} body="${im ? im.body.text : '?'}"`);
  }

  // 15 — no "Select Options": the menu is real buttons, help last
  {
    capabilities.reset();
    let payload = null;
    const sk = {
      sendMessage: async (j, c, o) => {
        if (c && c.__interactive && !payload) payload = c;
        const key = { id: 'BOT-' + Math.random() };
        if (o && o.trackDelivery) return { key, delivery: Promise.resolve('delivered') };
        return { key };
      }
    };
    await run(sk, msg('.menu', J()));
    const buttons = payload?.content?.viewOnceMessage?.message?.interactiveMessage?.nativeFlowMessage?.buttons || [];
    const names = buttons.map((b) => b.name);
    const ids = buttons.map((b) => JSON.parse(b.buttonParamsJson).id);
    const noList = !names.includes('single_select');
    const helpLast = ids[ids.length - 1] === 'menu:help';
    const allQuick = names.every((n) => n === 'quick_reply');
    const english = buttons.every((b) => !/[඀-෿]/.test(JSON.parse(b.buttonParamsJson).display_text));
    report('15. Menu = real buttons (no select-options), help last, English',
      noList && allQuick && helpLast && english,
      `buttons=${buttons.length} last=${ids[ids.length - 1]}`);
  }

  // 16 — the mode decides where the bot listens
  {
    capabilities.reset();
    const mode = require('../src/services/mode');
    const before = mode.current();
    try {
      mode.set('groups');
      const s = [];
      await run(sock(s), msg('.ping', '94700000002@s.whatsapp.net'));
      const blocked = s.filter((x) => x === 'text').length;
      const s2 = [];
      await run(sock(s2), msg('.ping', '120363000000000000@g.us', '94700000002@s.whatsapp.net'));
      const answered = s2.filter((x) => x === 'text').length;
      report('16. Mode "groups" — DM ignored, group answered', blocked === 1 && answered >= 1,
        `dm=${blocked} group=${answered}`);
    } finally {
      mode.set(before);
    }
  }

  // 17 — the branding (name, header, footer) reaches the card
  {
    capabilities.reset();
    const settings = require('../src/services/settings');
    const before = { ...settings.get() };
    let payload = null;
    const sk = {
      sendMessage: async (j, c, o) => {
        if (c && c.__interactive && !payload) payload = c;
        return { key: { id: 'BOT-' + Math.random() } };
      }
    };
    try {
      settings.update({ botName: 'Sachi Prime', header: 'MY HEADER', footer: 'MY FOOTER' });
      await run(sk, msg('.menu', J()));
      const im = payload?.content?.viewOnceMessage?.message?.interactiveMessage;
      const ok = im && im.header && im.header.title === 'MY HEADER' && im.footer.text === 'MY FOOTER';
      report('17. Custom header + footer reach the card', !!ok,
        `header=${im ? im.header?.title : '?'} footer=${im ? im.footer?.text : '?'}`);
    } finally {
      settings.update(before);
    }
  }

  // 18 — a PAIRED session: a main-only command is refused and hidden from the menu
  {
    capabilities.reset();
    confirm.reset();
    const keep = { owner: config.owner, sp: config.sessionIsPrimary, sid: config.sessionId, bk: config.brandKey };
    const phone = '94770001234';
    const pjid = `${phone}@s.whatsapp.net`;
    Object.assign(config, { owner: pjid, sessionIsPrimary: false, sessionId: phone, brandKey: phone });
    let refusedText = '';
    const sk = { sendMessage: async (j, c) => { if (c && c.text) refusedText += c.text + '\n'; return { key: { id: 'BOT-' + Math.random() } }; } };
    await router.handle(sk, msg('.sessions', pjid), config, (j, c, o) => sk.sendMessage(j, c, o));
    await sleep(150);
    const refused = refusedText.includes('⛔') && /main bot number/i.test(refusedText);
    const visible = router.visibleList(config, pjid, pjid);
    const noGated = visible.length > 0 && visible.every((c) => !c.mainOnly);
    Object.assign(config, keep);
    report('18. Paired session: gated command refused, menu hides it', refused && noGated,
      `refused=${refused} visible=${visible.length}/${router.list().length}`);
  }

  // 19 — a PAIRED session's card wears ITS OWN header/footer, the main one keeps the global
  {
    capabilities.reset();
    const branding = require('../src/services/branding');
    const settings = require('../src/services/settings');
    const before = { ...settings.get() };
    const keep = { owner: config.owner, sp: config.sessionIsPrimary, sid: config.sessionId, bk: config.brandKey };
    const phone = '94770005678';
    const sjid = `${phone}@s.whatsapp.net`;
    const grab = () => {
      let payload = null;
      return {
        sk: { sendMessage: async (j, c) => { if (c && c.__interactive && !payload) payload = c; return { key: { id: 'BOT-' + Math.random() } }; } },
        im: () => payload?.content?.viewOnceMessage?.message?.interactiveMessage
      };
    };
    try {
      settings.update({ botName: 'Global Bot', header: 'GLOBAL HEADER', footer: 'GLOBAL FOOTER' });
      branding.set(phone, { name: 'My Session Bot', header: 'SESSION HEADER', footer: 'SESSION FOOTER' });
      branding.flush();

      Object.assign(config, { owner: sjid, sessionIsPrimary: false, sessionId: phone, brandKey: phone });
      const a = grab();
      await router.handle(a.sk, msg('.menu', sjid), config, (j, c, o) => a.sk.sendMessage(j, c, o));
      await sleep(250);
      const sessionIm = a.im();

      Object.assign(config, { owner: MAIN_JID, sessionIsPrimary: true, sessionId: 'primary', brandKey: 'primary' });
      const b = grab();
      await router.handle(b.sk, msg('.menu', MAIN_JID), config, (j, c, o) => b.sk.sendMessage(j, c, o));
      await sleep(250);
      const mainIm = b.im();

      const ok = sessionIm?.header?.title === 'SESSION HEADER' && sessionIm?.footer?.text === 'SESSION FOOTER'
        && mainIm?.header?.title === 'GLOBAL HEADER' && mainIm?.footer?.text === 'GLOBAL FOOTER';
      report('19. Per-session branding reaches the card', !!ok,
        `session=${sessionIm?.header?.title}/${sessionIm?.footer?.text} main=${mainIm?.header?.title}/${mainIm?.footer?.text}`);
    } finally {
      branding.forget(phone);
      settings.update(before);
      Object.assign(config, keep);
    }
  }

  const fails = results.filter((x) => !x).length;
  console.log(`\n== ${results.length - fails}/${results.length} scenarios OK ==`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('SIM CRASH:', e && e.stack || e); process.exit(2); });
