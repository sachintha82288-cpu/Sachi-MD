/* Generates menu-preview.html — a visual mock of the real button menu,
 * built from the actual production payloads (nothing here is hand-written).
 *
 * Run: node scripts/menu-preview.js
 */
const fs = require('fs');
const path = require('path');

const router = require('../src/router/router');
const config = require('../src/config');
const menu = require('../src/menu/menu');
const mb = require('../src/services/menubuttons');

router.loadCommands();
const COMMANDS = router.list();

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const logoData = (() => {
  const p = path.join(__dirname, '..', 'assets', 'logo.jpg');
  if (!fs.existsSync(p)) return '';
  return 'data:image/jpeg;base64,' + fs.readFileSync(p).toString('base64');
})();

function parseButtons(card) {
  const im = card.content?.viewOnceMessage?.message?.interactiveMessage
    || card.content?.interactiveMessage;
  const buttons = im?.nativeFlowMessage?.buttons || [];
  return buttons.map((b) => {
    let p = {};
    try { p = JSON.parse(b.buttonParamsJson || '{}'); } catch { /* ignore */ }
    if (b.name === 'single_select') {
      return { type: 'list', title: p.title, sections: p.sections || [] };
    }
    if (b.name === 'quick_reply') {
      return { type: 'quick', title: p.display_text, id: p.id };
    }
    return { type: b.name, title: p.display_text || p.title || b.name, id: p.id };
  });
}

function cardHtml(title, card, note) {
  const im = card.content?.viewOnceMessage?.message?.interactiveMessage
    || card.content?.interactiveMessage;
  const body = im?.body?.text || '';
  const footer = im?.footer?.text || '';
  const header = im?.header?.title || '';
  const buttons = parseButtons(card);
  const media = card.media ? logoData : '';

  const rows = buttons.filter((b) => b.type === 'list').flatMap((b) =>
    (b.sections || []).flatMap((s) => s.rows || [])
  );
  const quick = buttons.filter((b) => b.type === 'quick');
  // WhatsApp renders the first three quick replies as chips; the rest
  // become a numbered list on the client.
  const chips = quick.slice(0, 3);
  const rest = quick.slice(3);

  return `
  <div class="wrap">
    <div class="label">${esc(title)}</div>
    ${note ? `<div class="note">${esc(note)}</div>` : ''}
    <div class="card">
      ${media ? `<div class="media"><div class="ph"></div></div>` : ''}
      ${header ? `<div class="head">${esc(header)}</div>` : ''}
      <div class="body"><pre>${esc(body)}</pre></div>
      ${rows.length ? `<div class="rows">${rows.map((r) => `
        <div class="row">
          <div class="rtitle">${esc(r.title)}</div>
          ${r.description ? `<div class="rdesc">${esc(r.description)}</div>` : ''}
          <div class="rid">${esc(r.id)}</div>
        </div>`).join('')}</div>` : ''}
      ${chips.length ? `<div class="quick">${chips.map((q) => `<span class="chip">${esc(q.title)}</span>`).join('')}</div>` : ''}
      ${rest.length ? `<div class="rows">${rest.map((q, i) => `
        <div class="row">
          <div class="rtitle">${i + 1}. ${esc(q.title)}</div>
          <div class="rid">${esc(q.id)}</div>
        </div>`).join('')}</div>` : ''}
      ${footer ? `<div class="foot">${esc(footer)}</div>` : ''}
    </div>
  </div>`;
}

const home = mb.homePayload({ commands: COMMANDS, name: 'Sachi', isOwner: true });
const home2 = mb.homePayload({ commands: COMMANDS, name: 'Sachi', isOwner: false });
const firstCat = menu.categories[0];
const cat = mb.categoryPayload({ cat: firstCat, catIndex: 1, commands: COMMANDS, isOwner: true, page: 0 });
const confirm = mb.confirmPayload({ name: 'shutdown', label: '⏹️ Shutting down the bot' });
const list = mb.homeListPayload({ commands: COMMANDS, name: 'Sachi', isOwner: true });

const listRows = (list.content?.listMessage?.sections || []).flatMap((s) => s.rows || []);

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sachi MD — Button Menu Preview</title>
<style>
  :root { color-scheme: dark; --logo: url(${logoData}); }
  * { box-sizing: border-box; }
  body { margin:0; padding:26px 16px 60px; background:#0b141a;
         font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  h1 { color:#e9edef; font-size:19px; margin:0 0 4px; }
  .sub { color:#8696a0; font-size:13px; margin:0 0 24px; }
  .wrap { max-width:420px; margin:0 auto 30px; }
  .label { color:#00a884; font-size:12px; letter-spacing:.08em; text-transform:uppercase; font-weight:700; }
  .note { color:#8696a0; font-size:12px; margin:4px 0 8px; }
  .card { background:#182229; border-radius:10px; overflow:hidden;
          box-shadow:0 1px 3px rgba(0,0,0,.5); }
  .head { background:#1f2c34; color:#e9edef; font-size:14px; font-weight:600; padding:10px 12px; }
  .media { background:#10181d; padding:0; }
  .media img, .logo { display:block; width:100%; max-height:260px; object-fit:cover; }
  .media .ph { background-image: var(--logo); background-size:cover; background-position:center;
               height:260px; }
  .body { padding:10px 12px; border-top:1px solid #222d34; }
  .body pre { margin:0; color:#e9edef; font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
              font-size:12.5px; line-height:1.45; white-space:pre-wrap; word-break:break-word; }
  .rows { border-top:1px solid #222d34; }
  .row { padding:9px 12px; border-bottom:1px solid #1b252b; }
  .row:last-child { border-bottom:0; }
  .rtitle { color:#53bdeb; font-size:14px; font-weight:600; }
  .rdesc { color:#8696a0; font-size:12.5px; margin-top:1px; }
  .rid { color:#667781; font-size:10.5px; margin-top:2px; font-family:ui-monospace,Menlo,monospace; }
  .quick { padding:9px 12px; border-top:1px solid #222d34; display:flex; gap:8px; flex-wrap:wrap; }
  .chip { background:#1f2c34; border:1px solid #2a3942; color:#e9edef;
          font-size:13px; padding:6px 12px; border-radius:16px; }
  .foot { padding:8px 12px; border-top:1px solid #222d34; color:#8696a0; font-size:12px; }
  .logo { max-width:220px; border-radius:10px; display:block; margin:0 auto 10px; }
  .imgs { text-align:center; padding:12px; background:#182229; border-radius:10px; }
  .cap { color:#8696a0; font-size:12px; margin-top:8px; text-align:left; }
  .cap pre { color:#e9edef; font-family:ui-monospace,Menlo,monospace; font-size:11.5px;
             white-space:pre-wrap; word-break:break-word; margin:6px 0 0; }
</style></head><body>
<h1>⚔️ SACHI MD — Button Menu Preview</h1>
<p class="sub">Generated from the live payloads (src/services/menubuttons.js) — the real cards the bot sends.</p>

${cardHtml('Home card — owner view', home, 'native-flow card, wrapped envelope')}
${cardHtml('Home card — guest view', home2, 'the owner category is hidden for everybody else')}
${cardHtml('Category card', cat, 'logo header, 8 rows per page, ▶️ More / ◀️ Back pager')}
${cardHtml('Destructive-command confirmation', confirm, 'two-step gate — a non-owner never sees this card')}

<div class="wrap">
  <div class="label">Legacy list envelope</div>
  <div class="note">iOS / Web — rendered as a WhatsApp list, not a native-flow card</div>
  <div class="card">
    <div class="body"><pre>${esc(list.content?.listMessage?.title || '')}</pre></div>
    <div class="rows">${listRows.map((r) => `
      <div class="row">
        <div class="rtitle">${esc(r.title)}</div>
        ${r.description ? `<div class="rdesc">${esc(r.description)}</div>` : ''}
        <div class="rid">${esc(r.id)}</div>
      </div>`).join('')}</div>
    <div class="foot">${esc(list.content?.listMessage?.footerText || '')}</div>
  </div>
</div>

<div class="wrap">
  <div class="label">Image-menu fallback</div>
  <div class="note">assets/logo.jpg + the classic text menu as the caption</div>
  <div class="imgs">
    ${logoData ? `<div style="max-width:220px;height:220px;border-radius:10px;background-image:var(--logo);background-size:cover;background-position:center;"></div>` : '<div class="cap">logo.jpg missing</div>'}
    <div class="cap"><pre>${esc(menu.main({ commands: COMMANDS, name: 'Sachi', isOwner: true }))}</pre></div>
  </div>
</div>
</body></html>`;

const out = path.join(__dirname, '..', 'menu-preview.html');
fs.writeFileSync(out, html);
console.log('wrote ' + out + ' (' + Math.round(html.length / 1024) + ' KB)');
