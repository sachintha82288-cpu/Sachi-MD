const fs = require('fs');
const path = require('path');
const { extractText, unwrapMessage, normalizeJid } = require('../utils/messages');
const menu = require('../menu/menu');
const reactions = require('../services/reactions');
const selections = require('../services/selection');
const menuButtons = require('../services/menubuttons');
const capabilities = require('../services/menu/capabilities');
const confirmSvc = require('../services/menu/confirm');
const mode = require('../services/mode');
const antiban = require('../services/antiban');
const branding = require('../services/branding');
const log = require('../utils/logger');
const defaultConfig = require('../config');

const commands = new Map();

/* ── command registry ─────────────────────────────────────────────────── */

function loadCommands() {
  commands.clear();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js')) {
        try {
          delete require.cache[require.resolve(p)];
          const c = require(p);
          if (c.name && typeof c.execute === 'function') {
            commands.set(c.name, c);
            for (const a of c.aliases || []) commands.set(a, c);
          }
        } catch (e) {
          log.error(`Command load failed ${entry.name}: ${e.message}`);
        }
      }
    }
  }
  walk(path.join(__dirname, '..', 'commands'));
  return list();
}

function list() {
  return [...new Map([...commands.values()].map((c) => [c.name, c])).values()].sort(
    (a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name)
  );
}

/* ── menu delivery ───────────────────────────────────────────────────── */

/**
 * Button menus are ON by default now. The classic logo image menu stays
 * as the fallback for phones/clients that cannot render a card.
 */
const BUTTONS_ENABLED = () => process.env.MENU_BUTTONS !== 'false';

const LOGO_PATH = menuButtons.LOGO_PATH;

/** Send the classic image menu (logo + full text caption), delivery-verified. */
async function sendMenuImage(send, msg, jid, text, brand = null) {
  // The logo can be replaced from the Settings menu at runtime — always
  // resolve it fresh, never from a cached module constant.
  const logo = menuButtons.logoPath(brand);
  if (!logo || !fs.existsSync(logo)) return { sent: null, outcome: 'error' };
  const sent = await send(jid, { image: { url: logo }, caption: text }, { quoted: msg, trackDelivery: true });
  if (!sent?.delivery) return { sent, outcome: 'sent' };
  return { sent, outcome: await sent.delivery };
}

/**
 * Can this chat return delivery receipts at all? Some phones render a
 * message but never ack it. Treating "no ack" as "not delivered" sends a
 * SECOND menu (the duplicate-menu bug). Probe with a tracked reaction —
 * the same 📋 emoji on the same message, so it is a visual no-op.
 */
async function receiptsWork(send, msg, jid) {
  const known = capabilities.receiptsAlive(jid);
  if (known === false) return false; // learned earlier — do not pay for a probe
  try {
    const probe = await send(jid, { react: { text: '📋', key: msg.key } }, { trackDelivery: true });
    if (!probe?.delivery) return true; // untracked path → assume it rendered
    let r;
    const t = setTimeout(() => r('probe-timeout'), 5000);
    const outcome = await Promise.race([probe.delivery, new Promise((res) => { r = res; })]);
    clearTimeout(t);
    const alive = outcome === 'delivered';
    capabilities.remember(jid, { receipts: alive });
    return alive;
  } catch {
    return false;
  }
}

/**
 * Try one interactive envelope. Returns the sent message or null.
 * outcome: 'delivered' | 'error' | 'timeout' | 'sent'
 */
async function tryEnvelope(send, msg, jid, cand) {
  const built = cand.build();
  const sent = await send(jid, built, {
    quoted: msg,
    trackDelivery: true
  });
  if (!sent) return { sent: null, outcome: 'error' };
  if (!sent.delivery) return { sent, outcome: 'sent' };
  return { sent, outcome: await sent.delivery };
}

/**
 * Deliver a menu screen through the envelope ladder:
 *   native-flow (wrapper) → native-flow (bare) → legacy list
 * The envelope that worked for this chat is tried first (capability
 * memory), and a chat that never acks anything is trusted immediately.
 */
async function sendMenuScreen(send, msg, jid, spec) {
  const preferred = capabilities.preferredEnvelope(jid);
  const receiptsKnown = capabilities.receiptsAlive(jid);
  const skip = capabilities.failedEnvelopes(jid);
  const ladder = menuButtons.candidates({ ...spec, preferred, skip });
  for (const cand of ladder) {
    let result;
    try {
      result = await tryEnvelope(send, msg, jid, cand);
    } catch (e) {
      if (e.probeBudget) {
        // Not this envelope's fault — the outbound probe budget is spent.
        log.warn(`[menu] ${cand.id}: ${e.message} — falling back to the image menu`);
        return null;
      }
      log.warn(`[menu] ${cand.id} send failed: ${e.message}`);
      capabilities.markFailed(jid, cand.id);
      if (e.mediaFailed) {
        // The logo upload is the problem, not the envelope — do not try
        // the other media shape either.
        capabilities.markFailed(jid, cand.id === 'native-media' ? 'native-media-bare' : 'native-media');
      }
      continue;
    }
    const { sent, outcome } = result;
    if (!sent) continue;
    if (outcome === 'sent' || outcome === 'delivered') {
      capabilities.remember(jid, { envelope: cand.id, receipts: outcome === 'delivered' ? true : undefined });
      return sent;
    }
    if (outcome === 'error') {
      capabilities.markFailed(jid, cand.id);
      log.warn(`[menu] ${cand.id} rejected (error ack) — trying the next envelope`);
      continue;
    }
    // timeout: the card may have rendered without an ack
    if (jid.endsWith('@g.us')) {
      capabilities.remember(jid, { envelope: cand.id });
      return sent; // group receipts are unreliable — keep what was sent
    }
    if (receiptsKnown === false) {
      capabilities.remember(jid, { envelope: cand.id });
      return sent; // this chat never acks — assume it rendered
    }
    if (await receiptsWork(send, msg, jid)) {
      log.warn(`[menu] ${cand.id} not delivered (receipts work) — trying the next envelope`);
      continue;
    }
    capabilities.remember(jid, { envelope: cand.id, receipts: false });
    log.warn(`[menu] ${cand.id} unacked but receipts dead — assumed rendered, NOT sending a duplicate`);
    return sent;
  }
  return null;
}

/** Full menu delivery: cards → logo image → plain text. Never silent. */
async function deliverMenu(send, msg, jid, spec) {
  const text = spec.text;
  const preferred = capabilities.preferredEnvelope(jid);
  // A chat where the cards were rejected before gets the image menu
  // straight away — no point burning three envelope round-trips first.
  const cardsUsable = preferred !== 'image' && preferred !== 'text';
  if (BUTTONS_ENABLED() && cardsUsable) {
    const card = await sendMenuScreen(send, msg, jid, spec);
    if (card) {
      menu.remember(card?.key?.id);
      return card;
    }
    const budget = typeof antiban.probeBudget === 'function' ? antiban.probeBudget() : null;
    log.warn(budget && !budget.allowed
      ? `[menu] card budget spent (${budget.used}/${antiban.status().probes.budget.limit} in ${Math.round(budget.windowMs / 1000)}s) — falling back to the image menu`
      : '[menu] every interactive envelope failed — falling back to the image menu');
  }
  let image = null;
  try {
    const r = await sendMenuImage(send, msg, jid, text, spec.brand || null);
    image = r.sent;
    if (r.outcome === 'sent' || r.outcome === 'delivered') {
      capabilities.remember(jid, { envelope: 'image' });
      menu.remember(image?.key?.id);
      return image;
    }
    if (r.outcome === 'timeout' && !jid.endsWith('@g.us') && !(await receiptsWork(send, msg, jid))) {
      capabilities.remember(jid, { receipts: false, envelope: 'image' });
      menu.remember(image?.key?.id);
      return image; // rendered, just never acked
    }
  } catch (e) {
    log.warn(`[menu] image menu failed (${e.message}) — sending text menu instead`);
  }
  capabilities.remember(jid, { envelope: 'text' });
  const sent2 = await send(jid, { text }, { quoted: msg });
  menu.remember(sent2?.key?.id);
  return sent2;
}

/** The main menu screen. */
async function sendMainMenu(sock, send, msg, jid, config) {
  const sender = jid.endsWith('@g.us') ? msg.key.participant : jid;
  const owner = isOwner({ jid, sender, msg, config });
  const cmds = visibleList(config, sender, jid);
  const brand = config.brand || branding.forKey(config.brandKey || 'primary');
  const spec = {
    screen: 'home',
    commands: cmds,
    name: msg.pushName,
    isOwner: owner,
    brand,
    text: menu.main({ commands: cmds, name: msg.pushName, isOwner: owner, brand })
  };
  return deliverMenu(send, msg, jid, spec);
}

/** One category screen (category number is 1-based, as in the text menu). */
async function sendCategoryMenu(sock, send, msg, jid, config, catIndex, page = 0) {
  const sender = jid.endsWith('@g.us') ? msg.key.participant : jid;
  const owner = isOwner({ jid, sender, msg, config });
  const cat = menu.category(catIndex);
  if (!cat) return null;
  if (cat.ownerOnly && !owner) {
    return send(jid, { text: '⛔ Owner commands are hidden from this menu.' }, { quoted: msg });
  }
  const cmds = visibleList(config, sender, jid);
  const brand = config.brand || branding.forKey(config.brandKey || 'primary');
  const spec = {
    screen: 'category',
    cat,
    catIndex,
    page,
    commands: cmds,
    isOwner: owner,
    brand,
    text: menu.categoryMenu(cat, cmds, owner, page, brand)
  };
  return deliverMenu(send, msg, jid, spec);
}

/* ── permissions ─────────────────────────────────────────────────────── */

// The MAIN-number rule lives in utils/mainGate.js so a command can check it
// for itself without require-ing the router back (that would be a cycle —
// the router is what loads the commands).
const { digitsOf, isMainNumber, MAIN_ONLY_NOTICE } = require('../utils/mainGate');

/**
 * What this caller may see: `mainOnly` commands (session management, the
 * anti-ban panel, bot-wide settings) disappear for everybody except the main
 * number — hidden from the menu AND refused at execution time.
 */
function visibleList(config, sender, jid) {
  const all = list();
  if (isMainNumber({ config, sender, jid })) return all;
  return all.filter((c) => !c.mainOnly);
}

function isOwner(ctx) {
  return (
    normalizeJid(ctx.sender) === normalizeJid(ctx.config.owner) ||
    normalizeJid(ctx.jid) === normalizeJid(ctx.config.owner) ||
    ctx.msg.key.fromMe === true
  );
}


/** A short, readable reason for the user (no stack traces). */
function shortError(e) {
  const raw = String(e?.message || e || 'unknown error').replace(/\s+/g, ' ').trim();
  return raw.length > 140 ? raw.slice(0, 140) + '…' : raw;
}


/* ── command execution ───────────────────────────────────────────────── */

async function runCommand(ctx, cmdName, args = []) {
  const command = commands.get(cmdName);
  if (!command) return;
  const owner = isOwner(ctx);
  if ((command.ownerOnly || ctx.config.ownerOnly) && !owner) {
    return ctx.send(ctx.jid, { text: '⛔ This command is available to the owner only.' }, { quoted: ctx.msg });
  }
  if (command.groupOnly && !ctx.isGroup) {
    return ctx.send(ctx.jid, { text: '⛔ This command works only in groups.' }, { quoted: ctx.msg });
  }
  // Session management and bot-wide configuration belong to the MAIN number
  // only. A paired session may still customise its OWN menu identity.
  if (command.mainOnly && !ctx.isMain) {
    return ctx.send(ctx.jid, { text: MAIN_ONLY_NOTICE(ctx.config) }, { quoted: ctx.msg });
  }
  // The command WILL run: raise "typing…" now, so the human pacing budget
  // is spent while the command works (AI, download, sticker…) instead of
  // being added on top of it. Messages the bot ignores never show typing.
  antiban.onInbound(ctx.jid, { sock: ctx.sock });
  reactions.react(ctx.sock, ctx.jid, ctx.msg.key, command.emoji || '⚡');
  const full = {
    sock: ctx.sock,
    send: ctx.send,
    msg: ctx.msg,
    jid: ctx.jid,
    isSelf: ctx.isSelf,
    sender: ctx.sender,
    isGroup: ctx.isGroup,
    isOwner: owner,
    isMain: ctx.isMain === true,
    brand: ctx.brand || branding.forKey(ctx.config?.brandKey || 'primary'),
    brandKey: ctx.brandKey || ctx.config?.brandKey || 'primary',
    args,
    config: ctx.config,
    prefix: ctx.prefix,
    cmdName,
    commands: ctx.commands || visibleList(ctx.config, ctx.sender, ctx.jid),
    quotedMsg: ctx.quotedMsg,
    target: ctx.target,
    pushName: ctx.msg.pushName || null,
    reply: (content) => ctx.send(ctx.jid, content, { quoted: ctx.msg }),
    edit: async (key, content) => {
      if (!key) throw new Error('edit: target message key is missing');
      const payload = typeof content === 'string' ? { text: content } : { ...content };
      // Baileys expects the edit flag INSIDE the content object:
      // sendMessage(jid, { text, edit: key }). Passing it via options is
      // silently ignored and sends a brand-new message instead.
      return ctx.send(ctx.jid, { ...payload, edit: key });
    }
  };
  try {
    await command.execute(full);
  } catch (e) {
    log.error(`Command ${cmdName}: ${e.stack || e.message}`);
    await ctx.send(ctx.jid, {
      text: `❌ *${cmdName}* failed — ${shortError(e)}\n\n_Use ${ctx.prefix || '.'}health to see the recent log._`
    }, { quoted: ctx.msg });
  }
}

/**
 * Destructive commands run in two steps: a confirmation card first, then
 * the command. The typed path accepts an explicit "confirm" argument so
 * the owner is never locked out when a card cannot be delivered.
 */
async function requestConfirmation(ctx, cmdName, args) {
  const command = commands.get(cmdName);
  const label = command?.description || cmdName;
  confirmSvc.request(ctx.jid, ctx.sender, cmdName, label);
  const card = menuButtons.confirmPayload({ name: cmdName, label });
  try {
    const sent = await ctx.send(ctx.jid, card, {
      quoted: ctx.msg,
      trackDelivery: true
    });
    if (sent) {
      const outcome = sent.delivery ? await sent.delivery : 'sent';
      if (outcome === 'delivered' || outcome === 'sent') {
        return ctx.reply({
          text: `⚠️ *Confirm action*\n\n${label}\n\nTap *✅ Confirm* — or type *${ctx.prefix}${cmdName} confirm*.\n_Expires in ${Math.round(confirmSvc.TTL_MS / 1000)}s._`
        });
      }
    }
  } catch (e) {
    log.warn(`[menu] confirm card failed: ${e.message}`);
  }
  return ctx.reply({
    text: `⚠️ *Confirm action*\n\n${label}\n\nType *${ctx.prefix}${cmdName} confirm* to proceed.\n_Expires in ${Math.round(confirmSvc.TTL_MS / 1000)}s._`
  });
}

/* ── mode gate ───────────────────────────────────────────────────────── */

/** Chats that already got the "wrong mode" notice (one per chat / 10 min). */
const modeNotices = new Map();
const MODE_NOTICE_TTL = 10 * 60 * 1000;

/**
 * Where the bot listens. When the current mode does not cover this chat
 * the bot stays quiet — but it says so ONCE per chat, so nobody thinks
 * the bot is dead.
 */
async function modeAllows(send, msg, jid, ctx) {
  if (mode.allows(ctx)) return true;
  const key = String(jid);
  const last = modeNotices.get(key);
  const stale = !last || Date.now() - last.at > MODE_NOTICE_TTL;
  // a new mode means a new explanation
  if (stale || last.mode !== mode.current()) {
    modeNotices.set(key, { at: Date.now(), mode: mode.current() });
    while (modeNotices.size > 500) modeNotices.delete(modeNotices.keys().next().value);
    try {
      await send(jid, {
        text: `🔕 *Bot mode: ${mode.title()}*\n${mode.hint()}\n\nChange it with \`${ctx.prefix || defaultConfig.prefix || '.'}mode\` in the Settings menu.`
      }, { quoted: msg });
    } catch { /* the notice is best effort */ }
  }
  return false;
}

/* ── main handler ────────────────────────────────────────────────────── */

async function handle(sock, msg, config, send) {
  const jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;
  const isGroup = jid.endsWith('@g.us');
  if (isGroup && !config.allowGroups) return;
  const sender = (isGroup ? msg.key.participant : jid) || jid;
  const chatOwner = isOwner({ jid, sender, msg, config });
  // "Message yourself" — the chat with the number the bot runs on.
  const isSelf = normalizeJid(jid) === normalizeJid(config.owner);
  const text = extractText(msg.message);
  const m = unwrapMessage(msg.message);
  const ci = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo || m.documentMessage?.contextInfo || m.interactiveResponseMessage?.contextInfo || m.listResponseMessage?.contextInfo || {};
  const quotedMsg = ci.quotedMessage || null;
  const target = ci.mentionedJid?.[0] || ci.participant || null;

  /* 1 ─ button taps (native flow + legacy list + legacy quick replies) */
  const flowId = menuButtons.parseFlowResponse(m);
  if (flowId) {
    const owner = isOwner({ jid, sender, msg, config });
    const base = {
      sock, send, msg, jid, sender, isGroup, isOwner: owner, isSelf,
      isMain: isMainNumber({ config, sender, jid, msg }),
      brand: config.brand || branding.forKey(config.brandKey || 'primary'),
      brandKey: config.brandKey || 'primary',
      config, prefix: config.prefix, cmdName: '', args: [],
      commands: visibleList(config, sender, jid), quotedMsg, target, pushName: msg.pushName || null,
      reply: (content) => send(jid, content, { quoted: msg }),
      edit: async (key, content) => {
        if (!key) throw new Error('edit: target message key is missing');
        const payload = typeof content === 'string' ? { text: content } : { ...content };
        return send(jid, { ...payload, edit: key });
      }
    };

    if (flowId === menuButtons.FLOW.home || flowId === menuButtons.FLOW.refresh) {
      if (!await modeAllows(send, msg, jid, { isSelf, isGroup, isOwner: chatOwner, isOwnerCommand: false })) return;
      await sendMainMenu(sock, send, msg, jid, config).catch(() => {});
      return;
    }
    if (flowId === menuButtons.FLOW.help) {
      if (!await modeAllows(send, msg, jid, { isSelf, isGroup, isOwner: chatOwner, isOwnerCommand: false })) return;
      // `base.commands`, not `list()`: a paired session must not be shown the
      // main number's commands, and the help text wears that session's brand.
      await send(jid, { text: menu.help(base.commands, '', base.brand) }, { quoted: msg });
      return;
    }
    const catMatch = /^menu:cat:(\d+)(?::(\d+))?$/.exec(flowId);
    if (catMatch) {
      if (!await modeAllows(send, msg, jid, { isSelf, isGroup, isOwner: chatOwner, isOwnerCommand: false })) return;
      await sendCategoryMenu(sock, send, msg, jid, config, Number(catMatch[1]), catMatch[2] ? Number(catMatch[2]) : 0).catch(() => {});
      return;
    }
    const cmdMatch = /^cmd:([a-z0-9_-]+)(?::(confirm|cancel))?$/.exec(flowId);
    if (cmdMatch) {
      const cmdName = cmdMatch[1];
      const action = cmdMatch[2];
      const command = commands.get(cmdName);
      if (!command) return;
      if (!await modeAllows(send, msg, jid, {
        isSelf, isGroup, isOwner: chatOwner, isOwnerCommand: !!(command.ownerOnly || config.ownerOnly)
      })) return;
      if (action === 'cancel') {
        confirmSvc.cancel(jid, sender);
        await send(jid, { text: '❎ Cancelled — nothing was changed.' }, { quoted: msg });
        return;
      }
      if (action === 'confirm') {
        const pending = confirmSvc.consume(jid, sender);
        if (!pending || pending.name !== cmdName) {
          await send(jid, { text: '⏱️ That confirmation expired. Tap the command again.' }, { quoted: msg });
          return;
        }
        await runCommand(base, cmdName, []);
        return;
      }
      // Permission first — never hand a confirmation card to someone who
      // could not run the command anyway.
      if ((command.ownerOnly || config.ownerOnly) && !owner) {
        await send(jid, { text: '⛔ This command is available to the owner only.' }, { quoted: msg });
        return;
      }
      if (command.mainOnly && !isMainNumber({ config, sender, jid, msg })) {
        await send(jid, { text: MAIN_ONLY_NOTICE(config) }, { quoted: msg });
        return;
      }
      if (command.groupOnly && !isGroup) {
        await send(jid, { text: '⛔ This command works only in groups.' }, { quoted: msg });
        return;
      }
      if (confirmSvc.isDestructive(cmdName)) {
        await requestConfirmation(base, cmdName, []);
        return;
      }
      await runCommand(base, cmdName, []);
      return;
    }
    return; // well-formed flow id we did not act on — never treat as text
  }

  if (!text) return;

  /* 2 ─ pending selection ("reply with a number") */
  const pending = ci.stanzaId ? selections.get(ci.stanzaId, jid, sender) : null;
  if (pending && /^\d{1,3}$/.test(text)) {
    if (!await modeAllows(send, msg, jid, { isSelf, isGroup, isOwner: chatOwner, isOwnerCommand: false })) return;
    try {
      await pending.handler({
        sock, send, msg, jid, sender, isGroup, text, config,
        isOwner: isOwner({ jid, sender, msg, config }),
        reply: (content) => send(jid, content, { quoted: msg }),
      });
    } catch (e) {
      log.error(`Selection ${pending.type}: ${e.stack || e.message}`);
      await send(jid, { text: '❌ Something went wrong while handling that selection.' }, { quoted: msg });
    }
    return;
  }

  /* 3 ─ typed menu navigation (reply 1-8 / 0 to a menu message) */
  if (ci.stanzaId && menu.isMenu(ci.stanzaId) && /^\d{1,2}$/.test(text)) {
    if (!await modeAllows(send, msg, jid, { isSelf, isGroup, isOwner: chatOwner, isOwnerCommand: false })) return;
    const n = Number(text);
    if (n === 0) {
      await sendMainMenu(sock, send, msg, jid, config).catch(() => {});
      return;
    }
    await sendCategoryMenu(sock, send, msg, jid, config, n, 0).catch(() => {});
    return;
  }

  /* 4 ─ prefix commands */
  const prefix = config.prefix;
  if (!text.startsWith(prefix)) return;
  const args = text.slice(prefix.length).trim().split(/\s+/);
  const cmdName = (args.shift() || '').toLowerCase();
  if (!cmdName) return;
  const command = commands.get(cmdName);
  if (cmdName === 'menu') {
    if (!await modeAllows(send, msg, jid, { isSelf, isGroup, isOwner: chatOwner, isOwnerCommand: false })) return;
    reactions.react(sock, jid, msg.key, '📋');
    await sendMainMenu(sock, send, msg, jid, config).catch((e) => log.warn(`Menu send failed: ${e.message}`));
    return;
  }
  if (!command) return;
  const owner = chatOwner;
  // The mode decides where the bot listens. Owner commands stay reachable
  // from the owner's own chat so the bot can never be locked out.
  if (!await modeAllows(send, msg, jid, {
    isSelf, isGroup, isOwner: owner, isOwnerCommand: !!(command.ownerOnly || config.ownerOnly)
  })) return;
  if ((command.ownerOnly || config.ownerOnly) && !owner) {
    return send(jid, { text: '⛔ This command is available to the owner only.' }, { quoted: msg });
  }
  if (command.groupOnly && !isGroup) {
    return send(jid, { text: '⛔ This command works only in groups.' }, { quoted: msg });
  }
  const mainHere = isMainNumber({ config, sender, jid, msg });
  if (command.mainOnly && !mainHere) {
    return send(jid, { text: MAIN_ONLY_NOTICE(config) }, { quoted: msg });
  }
  const brandHere = config.brand || branding.forKey(config.brandKey || 'primary');
  // destructive commands need an explicit confirmation
  if (confirmSvc.isDestructive(cmdName, args) && args[0] === 'confirm') {
    // typed confirmation — clear the pending card state as well
    confirmSvc.consume(jid, sender);
  }
  if (confirmSvc.isDestructive(cmdName, args) && args[0] !== 'confirm') {
    const base = {
      sock, send, msg, jid, sender, isGroup, isOwner: owner, isMain: mainHere,
      brand: brandHere, brandKey: config.brandKey || 'primary', config, prefix,
      cmdName, commands: visibleList(config, sender, jid), quotedMsg, target, pushName: msg.pushName || null,
      reply: (content) => send(jid, content, { quoted: msg }),
      edit: async (key, content) => {
        if (!key) throw new Error('edit: target message key is missing');
        const payload = typeof content === 'string' ? { text: content } : { ...content };
        return send(jid, { ...payload, edit: key });
      }
    };
    await requestConfirmation(base, cmdName, args);
    return;
  }
  // The command WILL run: raise "typing…" now so the pacing overlaps the work.
  antiban.onInbound(jid, { sock });
  reactions.react(sock, jid, msg.key, command.emoji || '⚡');
  const ctx = {
    sock, send, msg, jid, sender, isGroup, isOwner: owner, isMain: mainHere, isSelf, args, config, prefix, cmdName,
    brand: brandHere, brandKey: config.brandKey || 'primary',
    commands: visibleList(config, sender, jid), quotedMsg, target, pushName: msg.pushName || null,
    reply: (content) => send(jid, content, { quoted: msg }),
    edit: async (key, content) => {
      if (!key) throw new Error('edit: target message key is missing');
      const payload = typeof content === 'string' ? { text: content } : { ...content };
      return send(jid, { ...payload, edit: key });
    }
  };
  try {
    await command.execute(ctx);
  } catch (e) {
    log.error(`Command ${cmdName}: ${e.stack || e.message}`);
    await send(jid, {
      text: `❌ *${cmdName}* failed — ${shortError(e)}\n\n_Use ${prefix}health to see the recent log._`
    }, { quoted: msg });
  }
}

module.exports = {
  handle, loadCommands, list, isOwner, isMainNumber, visibleList,
  deliverMenu, sendMainMenu, sendCategoryMenu, MAIN_ONLY_NOTICE,
};
