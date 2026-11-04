/**
 * Menu payload builders — the button layer.
 *
 * Every menu screen is rendered as a CANDIDATE LIST, not a single message:
 *
 *   1. native-flow, viewOnce wrapper   (renders on most phones)
 *   2. native-flow, bare shape         (renders where the wrapper greys out)
 *   3. legacy list message             (renders on iOS / Web / Desktop)
 *   4. logo image + caption            (image menu)
 *   5. plain text menu                 (last resort)
 *
 * The router walks the list and stops at the first envelope that actually
 * delivers (see router.js). The order of 1–3 is reshuffled per chat using
 * the capability memory (services/menu/capabilities.js), so a chat that
 * never acks anything gets its menu on the first try instead of after a
 * full timeout.
 *
 * Flow-id grammar (all ids are ≤200 chars, titles ≤24, descriptions ≤72):
 *   menu:home            → main menu
 *   menu:refresh         → re-send the main menu
 *   menu:help            → command list as text
 *   menu:cat:<n>[:page]  → category screen (page = 0-based index, 0 omitted)
 *   cmd:<name>           → run a command
 *   cmd:<name>:confirm   → confirmed destructive command
 *   cmd:<name>:cancel    → cancelled destructive command
 */
const fs = require('fs');
const path = require('path');
const menu = require('../menu/menu');
const env = require('./menu/envelope');
const confirmSvc = require('./menu/confirm');
const settings = require('./settings');

const ASSETS = path.join(__dirname, '..', '..', 'assets');

/** Prefer the small JPEG upload; keep the PNG as a lossless master.
 *  A logo set from the Settings command wins over the shipped files. */
/**
 * Resolve the identity one payload should render with: the session's own
 * brand (`.setname` / `.setlogo` from a paired number) or — when it has not
 * customised anything — the global identity from Settings.
 */
function ident(brand) {
  const b = brand && typeof brand === 'object' ? brand : null;
  return {
    name: (b && b.name) || settings.name(),
    header: (b && b.header) || (b ? '' : settings.header()) || '',
    footer: (b && b.footer) || (b ? '' : settings.footer()) || '',
    logoPath: (b && b.logoPath) || logoPath(),
    tagline: (b && b.tagline) || '',
  };
}

function logoPath(brand = null) {
  // A paired session with its own logo wins over the global one.
  if (brand && brand.logoPath) return brand.logoPath;
  const custom = settings.logoPath();
  if (custom) return custom;
  for (const name of ['logo.jpg', 'logo.jpeg', 'logo.png']) {
    const p = path.join(ASSETS, name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(ASSETS, 'logo.png');
}

const LOGO_PATH = logoPath();

const FLOW = {
  home: 'menu:home',
  refresh: 'menu:refresh',
  help: 'menu:help',
  category: (n, page = 0) => (page > 0 ? `menu:cat:${n}:${page}` : `menu:cat:${n}`),
  command: (name) => `cmd:${name}`,
  confirm: (name) => `cmd:${name}:confirm`,
  cancel: (name) => `cmd:${name}:cancel`
};

/* ── rows ─────────────────────────────────────────────────────────────── */

function homeRows(commands, isOwner) {
  const visible = commands.filter((c) => !c.ownerOnly || isOwner);
  const by = menu.commandsByCategory(visible);
  const cats = menu.visibleCategories(isOwner);
  const rows = cats.map((c, i) => {
    const count = (by[c.id] || []).length;
    return env.row(
      FLOW.category(i + 1),
      `${menu.circled(i + 1)} ${c.emoji} ${c.name}`,
      `${c.short}${count ? ` · ${count} cmds` : ''}`
    );
  });
  // Navigation rows live in the list itself so the legacy list envelope
  // (iOS / Web) has the same options as the native-flow card.
  rows.push(env.row(FLOW.refresh, '🔄 Refresh', 'Reload this menu'));
  rows.push(env.row(FLOW.home, '🏠 Home', 'Back to the main menu'));
  return rows;
}

function categoryRows(cat, commands, isOwner, page = 0, catIndex = 1) {
  const list = menu.categoryCommands(cat, commands, isOwner);
  const pages = menu.pageCount(list.length);
  const rows = menu.pageSlice(list, page).map((c) => env.row(
    FLOW.command(c.name),
    `${c.emoji || '•'} .${c.name}`,
    c.description || ''
  ));
  if (pages > 1) {
    if (page + 1 < pages) {
      rows.push(env.row(FLOW.category(catIndex, page + 1), '▶️ More', `Next page (${page + 2}/${pages})`));
    } else {
      rows.push(env.row(FLOW.category(catIndex, 0), '◀️ Back', `First page (1/${pages})`));
    }
  }
  rows.push(env.row(FLOW.home, '🏠 Home', 'Back to the main menu'));
  return rows;
}

function categories() { return menu.categories; }

/* ── menu buttons (no "Select Options" list — real buttons) ──────────── */

/**
 * The main menu as quick-reply buttons: one button per category plus the
 * Help button LAST. WhatsApp shows the first three as chips and turns the
 * rest into a numbered list, so the menu stays tappable everywhere.
 */
function homeButtons(commands, isOwner) {
  const visible = commands.filter((c) => !c.ownerOnly || isOwner);
  const cats = menu.visibleCategories(isOwner);
  const nav = [env.quickReply(FLOW.help, '❓ Help')];
  const max = Math.max(1, env.LIMITS.buttons - nav.length);
  const buttons = cats.slice(0, max).map((c, i) => env.quickReply(
    FLOW.category(i + 1),
    `${menu.circled(i + 1)} ${c.emoji} ${c.name}`
  ));
  return [...buttons, ...nav];
}

/**
 * A category as quick-reply buttons: the commands of the current page,
 * then the pager (More / Back), then Home, then Help — always last.
 */
function categoryButtons(cat, commands, isOwner, page = 0, catIndex = 1) {
  const list = menu.categoryCommands(cat, commands, isOwner);
  const pages = menu.pageCount(list.length);
  const nav = [];
  if (pages > 1) {
    nav.push(page + 1 < pages
      ? env.quickReply(FLOW.category(catIndex, page + 1), '▶️ More')
      : env.quickReply(FLOW.category(catIndex, 0), '◀️ Back'));
  }
  nav.push(env.quickReply(FLOW.home, '🏠 Home'));
  nav.push(env.quickReply(FLOW.help, '❓ Help'));
  const max = Math.max(1, env.LIMITS.buttons - nav.length);
  const buttons = menu.pageSlice(list, page).slice(0, max).map((c) => env.quickReply(
    FLOW.command(c.name),
    `${c.emoji || '•'} .${c.name}`
  ));
  return [...buttons, ...nav];
}

/* ── payloads ─────────────────────────────────────────────────────────── */

/**
 * The logo as the card's media header. The card then shows the artwork
 * with the buttons underneath — the classic "logo menu" look, but tappable.
 */
function logoMedia(brand = null) {
  const p = ident(brand).logoPath;
  if (!p || !fs.existsSync(p)) return null;
  return { image: { url: p } };
}

const CARD_BODY_HOME = '👇 Tap a category to open it';
const CARD_BODY_CATEGORY = '👇 Tap a command to run it';

/** Header title + footer line — per session, else from Settings. */
function cardChrome(defaultFooter, brand = null) {
  const id = ident(brand);
  return { header: id.header, footer: id.footer || defaultFooter, name: id.name };
}

function homePayload({ commands, name, isOwner, variant = 'wrapped', withMedia = true, brand = null }) {
  const id = ident(brand);
  const media = withMedia ? logoMedia(brand) : null;
  // With the logo as the header the body only needs one line; without it
  // the body carries the full classic menu text.
  const body = media ? CARD_BODY_HOME : menu.main({ commands, name, isOwner, brand });
  const buttons = homeButtons(commands, isOwner);
  const chrome = cardChrome(`${id.name} · tap a button`, brand);
  return env.buildNativeFlow({
    bodyText: body,
    headerTitle: chrome.header,
    footerText: chrome.footer,
    buttons,
    variant,
    media
  });
}

function categoryPayload({ cat, catIndex = 1, commands, isOwner, page = 0, variant = 'wrapped', withMedia = true, brand = null }) {
  const id = ident(brand);
  const media = withMedia ? logoMedia(brand) : null;
  const body = media ? CARD_BODY_CATEGORY : menu.categoryMenu(cat, commands, isOwner, page, brand);
  const buttons = categoryButtons(cat, commands, isOwner, page, catIndex);
  const chrome = cardChrome(`${id.name} · ${cat.name}`, brand);
  return env.buildNativeFlow({
    bodyText: body,
    headerTitle: chrome.header,
    footerText: chrome.footer,
    buttons,
    variant,
    media
  });
}

function homeListPayload({ commands, name, isOwner, brand = null }) {
  const id = ident(brand);
  const body = `⚔️ ${String(id.name).toUpperCase()} ⚔️\n👇 Tap a category to open it`;
  const rows = homeRows(commands, isOwner);
  return env.buildList({
    bodyText: body,
    buttonText: '📂 Categories',
    footerText: id.footer || id.name,
    sections: [{ title: 'Categories', rows }]
  });
}

function categoryListPayload({ cat, catIndex = 1, commands, isOwner, page = 0, brand = null }) {
  const id = ident(brand);
  const body = `⚔️ ${String(id.name).toUpperCase()} ⚔️ · ${cat.name}\n👇 Tap a command to run it`;
  const rows = categoryRows(cat, commands, isOwner, page, catIndex);
  return env.buildList({
    bodyText: body,
    buttonText: `⚙️ ${cat.name}`,
    footerText: id.footer || id.name,
    sections: [{ title: cat.name, rows }]
  });
}

/** Two-step card for destructive commands. */
function confirmPayload({ name, label, variant = 'wrapped', brand = null }) {
  const id = ident(brand);
  const body = `⚠️ *Confirm action*\n\n${label || name}\n\n_This cannot be undone._`;
  const buttons = [
    env.quickReply(FLOW.confirm(name), '✅ Confirm'),
    env.quickReply(FLOW.cancel(name), '❌ Cancel')
  ];
  return env.buildNativeFlow({
    bodyText: body,
    headerTitle: id.header,
    footerText: id.footer || `${id.name} · owner only`,
    buttons,
    variant
  });
}

/**
 * Ordered candidate list for one menu screen.
 *
 *   1. native-flow card WITH the logo as media header (the wanted look)
 *   2. the same card without the media (logo upload failed)
 *   3. legacy list message (iOS / Web)
 *
 * `preferred` is the envelope that worked for this chat before, `skip`
 * holds the envelopes the server already rejected for it.
 */
function candidates({ screen, preferred, skip = [], ...rest }) {
  const build = (variant, withMedia) => {
    if (screen === 'home') return () => homePayload({ ...rest, variant, withMedia });
    if (screen === 'category') return () => categoryPayload({ ...rest, variant, withMedia });
    return () => confirmPayload({ ...rest, variant });
  };

  let ordered;
  if (screen === 'home' || screen === 'category') {
    ordered = [
      { id: 'native-media', build: build('wrapped', true) },
      { id: 'native-media-bare', build: build('bare', true) },
      { id: 'native-plain', build: build('wrapped', false) },
      { id: 'native-plain-bare', build: build('bare', false) },
      { id: 'list', build: screen === 'home' ? () => homeListPayload(rest) : () => categoryListPayload(rest) }
    ];
  } else {
    ordered = [
      { id: 'native-plain', build: build('wrapped', false) },
      { id: 'native-plain-bare', build: build('bare', false) }
    ];
  }

  if (preferred) {
    const idx = ordered.findIndex((c) => c.id === preferred);
    if (idx > 0) ordered.unshift(ordered.splice(idx, 1)[0]);
  }
  if (skip && skip.length) {
    const kept = ordered.filter((c) => !skip.includes(c.id));
    if (kept.length) ordered = kept;
  }
  return ordered;
}

/* ── reply parsing ───────────────────────────────────────────────────── */

/** Extract the tapped flow id from any interactive reply shape. */
function parseFlowResponse(message) {
  return env.parseReplyId(message);
}

module.exports = {
  FLOW,
  LOGO_PATH,
  logoPath,
  ident,
  cardChrome,
  homeRows,
  categoryRows,
  homeButtons,
  categoryButtons,
  homePayload,
  categoryPayload,
  homeListPayload,
  categoryListPayload,
  confirmPayload,
  candidates,
  parseFlowResponse,
  confirmSvc
};
