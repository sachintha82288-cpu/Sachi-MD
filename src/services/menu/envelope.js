/**
 * Interactive message envelopes — the wire format for menu cards.
 *
 * Research (Baileys 6.7.24 source + community live tests):
 *
 * 1. `sock.sendMessage()` has NO branch for interactiveMessage in 6.7.x, so
 *    every card goes through generateWAMessageFromContent() + relayMessage().
 *
 * 2. The stanza must ALSO carry the binary wrapper nodes the official
 *    client attaches, otherwise WhatsApp accepts the bytes, the phone
 *    renders nothing, and the sender sees "sent":
 *
 *      <biz>
 *        <interactive type="native_flow" v="1">
 *          <native_flow v="9" name="mixed"/>
 *        </interactive>
 *      </biz>
 *      <bot biz_bot="1"/>          ← 1:1 chats only (AI badge / render flag)
 *
 *    relayMessage() exposes these as `additionalNodes`.
 *
 * 3. Two payload shapes are in the wild and clients disagree about which
 *    one renders:
 *      'wrapped' — interactiveMessage inside viewOnceMessage with
 *                  messageContextInfo INSIDE the wrapper
 *      'bare'    — interactiveMessage at the top level with a top-level
 *                  messageContextInfo
 *    So the menu sends the shape that is known to work for the chat first
 *    (see capabilities.js) and falls back to the other one.
 *
 * 4. native-flow `single_select` does NOT render on iOS / Web / Desktop.
 *    The legacy ListMessage (ListType.SINGLE_SELECT) does:
 *      <biz><list type="product_list" v="2"/></biz>
 *    → third envelope, used for the classic list menu.
 *
 * Limits are Meta's own (interactive messages):
 *   body ≤ 4096 · footer ≤ 60 · header ≤ 60 · button label ≤ 20
 *   quick replies ≤ 3 · list rows ≤ 10 TOTAL · sections ≤ 10
 *   row title ≤ 24 · row description ≤ 72 · row id ≤ 200
 */
const { proto } = require('@whiskeysockets/baileys');

const LIMITS = Object.freeze({
  body: 4096,
  footer: 60,
  header: 60,
  buttonText: 20,
  quickReplyText: 20,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
  sectionTitle: 24,
  rowsPerList: 10,
  sectionsPerList: 10,
  // WhatsApp shows up to 3 quick replies as chips; the native-flow button
  // array itself accepts 10 entries (the rest fall back to a numbered
  // list on the client).
  quickReplies: 3,
  buttons: 10
});

/** Clip to a limit without splitting surrogate pairs / astral chars. */
function clip(value, max) {
  const chars = Array.from(String(value == null ? '' : value));
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, Math.max(1, max - 1)).join('').replace(/\s+$/, '') + '…';
}

/* ── button / row builders ───────────────────────────────────────────── */

function row(id, title, description) {
  const out = {
    id: clip(id, LIMITS.rowId),
    title: clip(title, LIMITS.rowTitle)
  };
  const desc = clip(description, LIMITS.rowDescription);
  if (desc) out.description = desc;
  return out;
}

function section(title, rows) {
  return {
    title: clip(title, LIMITS.sectionTitle),
    rows: rows.slice(0, LIMITS.rowsPerList)
  };
}

function quickReply(id, displayText) {
  return {
    name: 'quick_reply',
    buttonParamsJson: JSON.stringify({
      display_text: clip(displayText, LIMITS.quickReplyText),
      id: clip(id, LIMITS.rowId)
    })
  };
}

function singleSelect(buttonTitle, sections) {
  const capped = sections.slice(0, LIMITS.sectionsPerList);
  let budget = LIMITS.rowsPerList;
  const trimmed = capped.map((s) => {
    const rows = (s.rows || []).slice(0, budget);
    budget -= rows.length;
    return { title: clip(s.title, LIMITS.sectionTitle), rows };
  }).filter((s) => s.rows.length);
  return {
    name: 'single_select',
    buttonParamsJson: JSON.stringify({
      title: clip(buttonTitle, LIMITS.buttonText),
      sections: trimmed
    })
  };
}

function ctaUrl(displayText, url) {
  return {
    name: 'cta_url',
    buttonParamsJson: JSON.stringify({
      display_text: clip(displayText, LIMITS.quickReplyText),
      url: String(url)
    })
  };
}

/* ── binary wrapper nodes ────────────────────────────────────────────── */

/** biz → interactive(native_flow,v=1) → native_flow(v=9,name=mixed) [+ bot for DMs] */
function nativeFlowNodes({ isGroup = false } = {}) {
  const nodes = [{
    tag: 'biz',
    attrs: {},
    content: [{
      tag: 'interactive',
      attrs: { type: 'native_flow', v: '1' },
      content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }]
    }]
  }];
  if (!isGroup) nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } });
  return nodes;
}

/** biz → list(type=product_list,v=2) — legacy list menu envelope */
function listNodes() {
  return [{
    tag: 'biz',
    attrs: {},
    content: [{ tag: 'list', attrs: { type: 'product_list', v: '2' } }]
  }];
}

/* ── payload builders ────────────────────────────────────────────────── */

function buildNativeFlow({ bodyText, footerText, headerTitle, buttons, variant = 'wrapped', media = null }) {
  const interactive = proto.Message.InteractiveMessage.create({
    body: proto.Message.InteractiveMessage.Body.create({ text: clip(bodyText, LIMITS.body) }),
    footer: proto.Message.InteractiveMessage.Footer.create({ text: clip(footerText, LIMITS.footer) }),
    header: proto.Message.InteractiveMessage.Header.create({
      // The media flag is set by attachMedia() once the logo is really
      // uploaded — a header that claims a picture it does not have would
      // render as a broken box.
      hasMediaAttachment: false,
      ...(headerTitle ? { title: clip(headerTitle, LIMITS.header) } : {})
    }),
    // messageVersion is a RESPONSE-side flag — setting it on an outgoing
    // card makes the server drop the stanza. Keep it unset.
    nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
      buttons,
      messageParamsJson: ''
    })
  });
  const contextInfo = { deviceListMetadata: {}, deviceListMetadataVersion: 2 };
  if (variant === 'bare') {
    return {
      kind: 'native-bare',
      __interactive: true,
      content: { messageContextInfo: contextInfo, interactiveMessage: interactive },
      nodes: nativeFlowNodes(),
      media: media || null,
      // The typing indicator is sized from the body text.
      typingText: bodyText
    };
  }
  return {
    kind: 'native-wrapped',
    __interactive: true,
    content: { viewOnceMessage: { message: { messageContextInfo: contextInfo, interactiveMessage: interactive } } },
    nodes: nativeFlowNodes(),
    media: media || null,
    typingText: bodyText
  };
}

/**
 * Attach a prepared media (the logo) as the card's media header.
 * `prepared` is the output of prepareWAMessageMedia() — the image has
 * already been uploaded to WhatsApp at that point.
 */
function attachMedia(payload, prepared) {
  const im = payload?.viewOnceMessage?.message?.interactiveMessage
    || payload?.interactiveMessage;
  if (!im || !prepared?.imageMessage) return payload;
  im.header.hasMediaAttachment = true;
  im.header.imageMessage = proto.Message.ImageMessage.create(prepared.imageMessage);
  return payload;
}

function buildList({ bodyText, buttonText, footerText, sections }) {
  const list = proto.Message.ListMessage.create({
    title: clip(bodyText, LIMITS.body),
    buttonText: clip(buttonText, LIMITS.buttonText),
    footerText: clip(footerText, LIMITS.footer),
    listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
    sections
  });
  return {
    kind: 'list',
    __interactive: true,
    content: { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, listMessage: list },
    nodes: listNodes(),
    typingText: bodyText
  };
}

/* ── reply parsing ───────────────────────────────────────────────────── */

/**
 * Pull the tapped id out of ANY interactive reply shape WhatsApp clients
 * use. Returns null for anything that is not one of ours.
 */
function parseReplyId(message) {
  const m = message || {};
  const flow = m.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (flow?.paramsJson) {
    try {
      const parsed = JSON.parse(flow.paramsJson);
      const id = parsed?.id;
      if (typeof id === 'string' && /^(menu|cmd):/.test(id)) return id;
    } catch { /* malformed payload — fall through */ }
  }
  const listId = m.listResponseMessage?.singleSelectReply?.selectedRowId;
  if (typeof listId === 'string' && /^(menu|cmd):/.test(listId)) return listId;
  const btnId = m.buttonsResponseMessage?.selectedButtonId;
  if (typeof btnId === 'string' && /^(menu|cmd):/.test(btnId)) return btnId;
  const tplId = m.templateButtonReplyMessage?.selectedId;
  if (typeof tplId === 'string' && /^(menu|cmd):/.test(tplId)) return tplId;
  return null;
}

module.exports = {
  LIMITS,
  clip,
  row,
  section,
  quickReply,
  singleSelect,
  ctaUrl,
  nativeFlowNodes,
  listNodes,
  buildNativeFlow,
  buildList,
  attachMedia,
  parseReplyId
};
