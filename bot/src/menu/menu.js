const config = require('../config');
const settings = require('../services/settings');

/**
 * The bot name for THIS session. Every paired number can name its own bot
 * (`branding.forKey`); with no override it is the global one from Settings.
 */
function botName(brand) { return String((brand && brand.name) || settings.name() || 'Sachi MD').toUpperCase(); }
function tagline(brand) {
  const t = brand && brand.tagline ? String(brand.tagline) : '';
  return caps(t || 'premium whatsapp bot');
}

/**
 * Menu registry + text rendering.
 *
 * The text menu is the safety net: every client can render it, even when
 * the interactive card is dropped by WhatsApp or unsupported by the phone.
 * The button layer (services/menubuttons.js) reuses the same registry.
 */
const categories = [
  { id: 'download', emoji: '📥', name: 'Downloaders', short: 'Media downloads' },
  { id: 'status', emoji: '👁️', name: 'Status Center', short: 'Seen · React · Save' },
  { id: 'media', emoji: '🎨', name: 'Media', short: 'Sticker & media tools' },
  { id: 'tools', emoji: '🛠️', name: 'Tools', short: 'Utilities & profile' },
  { id: 'group', emoji: '👥', name: 'Group', short: 'Group management' },
  { id: 'ai', emoji: '🤖', name: 'AI', short: 'AI tools' },
  { id: 'settings', emoji: '⚙️', name: 'Settings', short: 'Bot preferences' },
  { id: 'owner', emoji: '👑', name: 'Owner', short: 'System controls', ownerOnly: true }
];

const remembered = new Map();
const TTL = 15 * 60 * 1000;

function bold(str) {
  const map = {
    A:'𝐀',B:'𝐁',C:'𝐂',D:'𝐃',E:'𝐄',F:'𝐅',G:'𝐆',H:'𝐇',I:'𝐈',J:'𝐉',K:'𝐊',L:'𝐋',M:'𝐌',N:'𝐍',O:'𝐎',P:'𝐏',Q:'𝐐',R:'𝐑',S:'𝐒',T:'𝐓',U:'𝐔',V:'𝐕',W:'𝐖',X:'𝐗',Y:'𝐘',Z:'𝐙',
    a:'𝐚',b:'𝐛',c:'𝐜',d:'𝐝',e:'𝐞',f:'𝐟',g:'𝐠',h:'𝐡',i:'𝐢',j:'𝐣',k:'𝐤',l:'𝐥',m:'𝐦',n:'𝐧',o:'𝐨',p:'𝐩',q:'𝐪',r:'𝐫',s:'𝐬',t:'𝐭',u:'𝐮',v:'𝐯',w:'𝐰',x:'𝐱',y:'𝐲',z:'𝐳',
    0:'𝟎',1:'𝟏',2:'𝟐',3:'𝟑',4:'𝟒',5:'𝟓',6:'𝟔',7:'𝟕',8:'𝟖',9:'𝟗'
  };
  return String(str).replace(/[A-Za-z0-9]/g, (ch) => map[ch] || ch);
}

/* Premium typography: sans-serif bold for titles/numbers, small caps for
 * labels, circled digits for menu numbers. Pure maps — always safe text. */
const SANS_MAP = {
  A:'𝗔',B:'𝗕',C:'𝗖',D:'𝗗',E:'𝗘',F:'𝗙',G:'𝗚',H:'𝗛',I:'𝗜',J:'𝗝',K:'𝗞',L:'𝗟',M:'𝗠',N:'𝗡',O:'𝗢',P:'𝗣',Q:'𝗤',R:'𝗥',S:'𝗦',T:'𝗧',U:'𝗨',V:'𝗩',W:'𝗪',X:'𝗫',Y:'𝗬',Z:'𝗭',
  a:'𝗮',b:'𝗯',c:'𝗰',d:'𝗱',e:'𝗲',f:'𝗳',g:'𝗴',h:'𝗵',i:'𝗶',j:'𝗷',k:'𝗸',l:'𝗹',m:'𝗺',n:'𝗻',o:'𝗼',p:'𝗽',q:'𝗾',r:'𝗿',s:'𝘀',t:'𝘁',u:'𝘂',v:'𝘃',w:'𝘄',x:'𝘅',y:'𝘆',z:'𝘇',
  0:'𝟬',1:'𝟭',2:'𝟮',3:'𝟯',4:'𝟰',5:'𝟱',6:'𝟲',7:'𝟳',8:'𝟴',9:'𝟵'
};
function sansB(str) { return String(str).replace(/[A-Za-z0-9]/g, (ch) => SANS_MAP[ch] || ch); }

const CAPS_MAP = { a:'ᴀ',b:'ʙ',c:'ᴄ',d:'ᴅ',e:'ᴇ',f:'ꜰ',g:'ɢ',h:'ʜ',i:'ɪ',j:'ᴊ',k:'ᴋ',l:'ʟ',m:'ᴍ',n:'ɴ',o:'ᴏ',p:'ᴘ',q:'ǫ',r:'ʀ',t:'ᴛ',u:'ᴜ',v:'ᴠ',w:'ᴡ',y:'ʏ',z:'ᴢ' };
function caps(str) { return String(str).toLowerCase().replace(/[a-z]/g, (ch) => CAPS_MAP[ch] || ch); }

const CIRCLED = ['❶','❷','❸','❹','❺','❻','❼','❽','❾','❿'];
function circled(n) { return CIRCLED[n - 1] || String(n); }

function remember(id) {
  if (!id) return;
  remembered.set(id, Date.now());
  if (remembered.size > 300) {
    for (const [k, v] of remembered) if (Date.now() - v > TTL) remembered.delete(k);
  }
}

function isMenu(id) {
  const t = remembered.get(id);
  if (!t) return false;
  if (Date.now() - t > TTL) { remembered.delete(id); return false; }
  return true;
}

function category(n) { return categories[n - 1] || null; }

/** Categories the caller may see (owner category is owner-only). */
function visibleCategories(isOwner) {
  return categories.filter((c) => !c.ownerOnly || isOwner);
}

function commandsByCategory(commands) {
  const out = {};
  for (const c of commands) (out[c.category || 'tools'] ??= []).push(c);
  return out;
}

/** Commands of one category, owner commands filtered out for non-owners. */
function categoryCommands(cat, commands, isOwner = false) {
  return commands
    .filter((c) => c.category === cat.id)
    .filter((c) => !c.ownerOnly || isOwner);
}

function main({ commands, name, isOwner, brand = null }) {
  const visible = commands.filter((c) => !c.ownerOnly || isOwner);
  const by = commandsByCategory(visible);
  const shown = visibleCategories(isOwner);
  const catLines = shown.map((c, i) => {
    const count = (by[c.id] || []).length;
    return `│  ${circled(i + 1)} ${c.emoji}  ${sansB(c.name)}${count ? ` ─ ${sansB(String(count))}` : ''}`;
  }).join('\n');
  return (
`╭─────「 ⚔️ ${sansB(botName(brand))} ⚔️ 」─────╮
│
│   🐀 _${tagline(brand)}_
│
│   👋 _${caps('hello')}_ *${String(name || 'there').slice(0, 24)}*
│   🔰 ${caps('prefix')} › *${config.prefix}*
│   ⚡ ${caps('commands')} › ${sansB(String(visible.length))}
│   ${isOwner ? `👑 ${caps('mode')} › ${sansB('owner')}` : `👤 ${caps('mode')} › ${caps('user')}`}
│
├────「 📂 ${sansB('CATEGORIES')} 」────┤
│
${catLines}
│
├─────「 ℹ️ ${sansB('GUIDE')} 」─────┤
│
│   📩 _${caps('reply with a number to open')}_
│   🏠 *${config.prefix}menu* › _${caps('home')}_
│
╰────「 ⚔️ ${sansB(botName(brand))} 」────╯`);
}

function categoryMenu(cat, commands, isOwner = false, page = 0, brand = null) {
  const list = categoryCommands(cat, commands, isOwner);
  const body = list.map((c) => {
    const desc = (c.description || '').trim();
    const short = desc.length > 46 ? desc.slice(0, 44) + '…' : desc;
    return `│  ${c.emoji || '•'}  *${config.prefix}${c.name}*${short ? `\n│      _${short}_` : ''}`;
  }).join('\n│\n');
  const pages = pageCount(list.length);
  const pageNote = pages > 1 ? `\n│   📄 _${caps('page')} ${page + 1}/${pages}_` : '';
  return (
`╭────「 ${cat.emoji} ${sansB(cat.name.toUpperCase())} 」────╮
│   _${caps(cat.short)}_${pageNote}
├──────────────────────┤
│
${body || `│  _${caps('no commands available')}_`}
│
├──────「 ℹ️ ${sansB('GUIDE')} 」─────┤
│
│   🏠 ${caps('reply')} *0* › _${caps('home')}_
│   ❓ *${config.prefix}help ${cat.id}* › _${caps('details')}_
│
╰────「 ⚔️ ${sansB(botName(brand))} 」────╯`);
}

/** How many commands a category page holds (button menu + text menu). */
const PAGE_SIZE = 7;
function pageCount(total) { return Math.max(1, Math.ceil(total / PAGE_SIZE)); }
function pageSlice(list, page) {
  const start = page * PAGE_SIZE;
  return list.slice(start, start + PAGE_SIZE);
}

function help(commands, query, brand = null) {
  if (query) {
    const c = commands.find((x) => x.name === query || x.aliases?.includes(query));
    if (!c) return `❓ Command *${query}* was not found.`;
    const aliases = (c.aliases || []).map((a) => config.prefix + a).join(', ') || '—';
    return `${c.emoji || '•'}  *${config.prefix}${c.name}*\n\n${c.description || 'No description.'}\n\nAliases  ${aliases}\nCategory  ${c.category || 'tools'}`;
  }
  return `${bold(botName(brand))}  ·  Commands\n━━━━━━━━━━━━━━━━━━━━\n\n` +
    commands.map((c) => `${c.emoji || '•'}  ${config.prefix}${c.name}`).join('\n') +
    `\n\n${config.prefix}help <command> for details`;
}

module.exports = {
  categories, remember, isMenu, category, main, categoryMenu, help, bold, botName, tagline,
  sansB, caps, circled, visibleCategories, commandsByCategory, categoryCommands,
  pageCount, pageSlice, PAGE_SIZE
};
