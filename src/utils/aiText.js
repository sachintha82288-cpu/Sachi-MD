/**
 * Text helpers for AI replies — <think> reasoning separation and
 * Markdown → WhatsApp formatting (bold, italic, strike, mono, bullets).
 */

/**
 * Split streamed model output into reasoning and answer.
 * Handles: <think>..</think>, <thinking>..</thinking>, unterminated <think>
 * (stream cut mid-reasoning), and plain text with no think tags at all.
 */
function splitThink(raw) {
  const s = String(raw || '');
  let reasoning = '';
  const re = /<think(?:ing)?>([\s\S]*?)(?:<\/think(?:ing)?>|$)/gi;
  let m;
  while ((m = re.exec(s))) {
    const part = m[1].trim();
    if (part) reasoning += (reasoning ? '\n' : '') + part;
  }
  const answer = s
    .replace(/<think(?:ing)?>[\s\S]*?(?:<\/think(?:ing)?>|$)/gi, '')
    .replace(/<\/?(?:think|thinking)>/gi, '')
    .trim();
  return { reasoning, answer };
}

/** True while the model is inside an unclosed <think> block. */
function isInThink(raw) {
  const open = (String(raw || '').match(/<think(?:ing)?>/gi) || []).length;
  const close = (String(raw || '').match(/<\/think(?:ing)?>/gi) || []).length;
  return open > close;
}

/**
 * Convert common Markdown to WhatsApp text formatting:
 *   **bold** → *bold*      *italic* → _italic_     ~~strike~~ → ~strike~
 *   ### Heading → *Heading*                        - item → • item
 *   [text](url) → text (url)                       ```lang fences → plain ```
 * Inline `code` and ``` blocks are kept — modern WhatsApp renders them monospace.
 */
function mdToWhatsApp(md) {
  let s = String(md || '');
  s = s.replace(/```[a-zA-Z0-9_+#.-]*[ \t]*\n?/g, '```');            // fence language tag
  s = s.replace(/~~([^~\n]+)~~/g, '~$1~');                            // strike
  s = s.replace(/(^|[^*\w])\*([^*\s](?:[^*\n]*[^*\s])?)\*(?!\*)/g, '$1_$2_'); // italic first (no *, no edge spaces)
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '*$1*');                    // bold+italic
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');                        // bold
  s = s.replace(/(^|\s)__([^_\n]+)__(?=\s|$|[.,!?])/g, '$1*$2*');     // __bold__
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');                         // headings
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '• ');                        // bullets
  s = s.replace(/\[([^\]\n]*)\]\((https?:[^)\s]+)\)/g, '$1 ($2)');    // links
  s = s.replace(/^&gt;[ \t]?/gm, '> ');                               // escaped quotes
  return s.trim();
}

module.exports = { splitThink, isInThink, mdToWhatsApp };
