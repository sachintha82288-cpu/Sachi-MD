/**
 * Where the bot listens.
 *
 *   self   → only "Message yourself" (the number the bot runs on)
 *   inbox  → private 1:1 chats
 *   public → every chat except your own (the bot is publicly reachable)
 *   groups → group chats only
 *   all    → every chat (default — the behaviour before the mode existed)
 *
 * The owner's own chat stays a control channel: owner commands (mode,
 * settings, …) always work there, so the bot can never be locked out.
 */
const config = require('../config');
const settings = require('./settings');

const MODES = ['self', 'inbox', 'public', 'groups', 'all'];

const TITLES = {
  self: 'Self',
  inbox: 'Inbox',
  public: 'Public',
  groups: 'Groups',
  all: 'All'
};

const DESCS = {
  self: 'only your own chat',
  inbox: 'private 1:1 chats',
  public: 'every chat except your own',
  groups: 'group chats only',
  all: 'every chat (default)'
};

const HINTS = {
  self: 'Only the "Message yourself" chat is answered.',
  inbox: 'Only private 1:1 chats are answered.',
  public: 'Every chat is answered except your own chat.',
  groups: 'Only group chats are answered.',
  all: 'Every chat is answered.'
};

function current() {
  const m = String(settings.mode() || 'all').toLowerCase();
  return MODES.includes(m) ? m : 'all';
}

function isValid(m) { return MODES.includes(String(m || '').toLowerCase()); }

function set(m) {
  const value = String(m || '').toLowerCase();
  if (!isValid(value)) return null;
  settings.update({ mode: value });
  return value;
}

function title(m = current()) { return TITLES[m] || TITLES.all; }
function desc(m = current()) { return DESCS[m] || DESCS.all; }
function label(m = current()) { return `${title(m)} — ${desc(m)}`; }
function hint(m = current()) { return HINTS[m] || HINTS.all; }

/** The chat-type filter (no owner exception). */
function chatAllowed({ isSelf = false, isGroup = false } = {}) {
  switch (current()) {
    case 'self': return !!isSelf;
    case 'inbox': return !isGroup;
    case 'public': return !isSelf;
    case 'groups': return !!isGroup;
    default: return true;
  }
}

/**
 * The full check used by the router.
 *
 * The owner's PRIVATE chat is always a control channel: owner commands
 * (mode, settings, …) work there in every mode. Without that rule the bot
 * could be locked out — "self" mode would block the owner from any other
 * number and there would be no way back.
 */
function allows({ isSelf = false, isGroup = false, isOwner = false, isOwnerCommand = false } = {}) {
  if (current() === 'all') return true;
  if (isOwnerCommand && !isGroup && (isOwner || isSelf)) return true;
  return chatAllowed({ isSelf, isGroup });
}

module.exports = {
  MODES, TITLES, DESCS, HINTS,
  current, isValid, set, title, desc, label, hint, chatAllowed, allows
};
