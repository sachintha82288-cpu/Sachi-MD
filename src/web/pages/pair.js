/**
 * The pair website — one self-contained HTML document (inline CSS + JS + SVG,
 * no CDN, no build step, works offline and behind a proxied panel port).
 *
 * The page is laid out like **WhatsApp's own Linked devices screen**, because
 * that is the screen the user is about to look at:
 *
 *   1. a top bar with the bot's identity and the live pairing state,
 *   2. a three-step rail (number → code → confirm) that marks itself off,
 *   3. the code as eight separate digit cells, grouped 4-4 with a dash,
 *   4. a side column with the exact taps on the phone and the safety notes.
 *
 * Design language stays the one the bot already uses — WhatsApp dark palette,
 * liquid glass panels, a faint cyber grid — but the decoration is dialled back
 * so the page reads as a form, not a poster: one accent colour, hairline
 * borders, a single type scale, and no element competing with the code.
 *
 * Everything interpolated into the page is escaped — the bot name is owner
 * input and must never become markup.
 */

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function render({
  botName = 'Sachi MD', version = '', mode = 'public', token = '',
  maxSessions = 8, sessions = 0, codeTtlSec = 60, tagline = 'Fast • Smart • Clean',
  country = '94',
} = {}) {
  const m = String(mode).toLowerCase();
  const closed = m === 'off' || m === 'locked';
  const needsToken = m === 'token';
  const used = Math.max(0, Number(sessions) || 0);
  const cap = Math.max(1, Number(maxSessions) || 8);
  const pct = Math.min(100, Math.round((used / cap) * 100));
  return `<!doctype html>
<html lang="en" data-mode="${esc(mode)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a1116">
<meta name="color-scheme" content="dark light">
<meta name="robots" content="noindex, nofollow">
<meta name="description" content="${esc(botName)} — link your WhatsApp number and get a pairing code.">
<title>${esc(botName)} · Linked devices</title>
<style>
/* ═════════════════════ tokens — WhatsApp dark, glassed, restrained ═════════════════════ */
:root{
  --bg:#0a1116; --bg-2:#0e171d;
  --panel:rgba(15,25,31,.78); --panel-2:#16222a;
  --ink:#e9edef; --dim:#9fb0ba; --faint:#71858f;
  --line:rgba(134,150,160,.20); --line-soft:rgba(134,150,160,.10);
  --acc:#00a884; --acc-2:#25d366; --acc-3:#53bdeb;
  --warn:#f0b429; --bad:#ef5b6b;
  --r-lg:20px; --r-md:14px; --r-sm:10px;
  --shadow:0 26px 60px -30px rgba(0,0,0,.9);
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Helvetica,"Noto Sans",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --ease:cubic-bezier(.22,.86,.28,1);
}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  min-height:100dvh;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
}
a{color:inherit}
::selection{background:rgba(0,168,132,.35)}

/* ═════════════════════ background — glass, not noise ═════════════════════ */
.bg{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none;background:
  radial-gradient(1100px 600px at 18% -10%,rgba(0,168,132,.16),transparent 60%),
  radial-gradient(900px 520px at 92% 8%,rgba(83,189,235,.10),transparent 62%),
  linear-gradient(180deg,#0a1116 0%,#081014 100%)}
.blob{position:absolute;width:46vw;height:46vw;border-radius:50%;filter:blur(72px);opacity:.30}
.blob.b1{top:-18vw;left:-10vw;background:#0b3b33;animation:drift1 26s var(--ease) infinite alternate}
.blob.b2{bottom:-24vw;right:-12vw;background:#123047;animation:drift2 32s var(--ease) infinite alternate}
.liquid{position:absolute;inset:0;opacity:.30;mix-blend-mode:screen}
.liquid i{position:absolute;width:40vw;height:40vw;border-radius:50%;filter:blur(34px);
  background:radial-gradient(circle at 32% 30%,rgba(0,168,132,.28),transparent 66%);
  animation:drift3 24s var(--ease) infinite alternate}
.liquid i:nth-child(1){top:8vh;left:38vw}
.liquid i:nth-child(2){bottom:2vh;left:4vw;animation-duration:29s;background:radial-gradient(circle at 40% 40%,rgba(83,189,235,.20),transparent 68%)}
@keyframes drift1{0%{transform:translate3d(0,0,0) scale(1)}100%{transform:translate3d(4vw,3vw,0) scale(1.08)}}
@keyframes drift2{0%{transform:translate3d(0,0,0) scale(1)}100%{transform:translate3d(-4vw,-3vw,0) scale(1.06)}}
@keyframes drift3{0%{transform:translate3d(0,0,0) scale(1)}100%{transform:translate3d(-3vw,4vw,0) scale(1.12)}}
.grid{position:absolute;inset:0;opacity:.6;
  background-image:linear-gradient(rgba(134,150,160,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(134,150,160,.055) 1px,transparent 1px);
  background-size:46px 46px;
  -webkit-mask-image:radial-gradient(ellipse at 50% 0%,#000 30%,transparent 78%);
  mask-image:radial-gradient(ellipse at 50% 0%,#000 30%,transparent 78%)}
.vignette{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,transparent 55%,rgba(0,0,0,.45))}

/* ═════════════════════ top bar ═════════════════════ */
.topbar{
  position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:14px;
  padding:11px clamp(14px,4vw,26px);border-bottom:1px solid var(--line-soft);
  background:rgba(9,16,21,.82);
  -webkit-backdrop-filter:blur(18px) saturate(150%);backdrop-filter:blur(18px) saturate(150%);
}
.brand{display:flex;align-items:center;gap:11px;text-decoration:none;min-width:0}
.brand img,.brand .glyph{width:32px;height:32px;border-radius:10px;object-fit:cover;display:block;
  border:1px solid rgba(255,255,255,.10);box-shadow:0 6px 16px -8px rgba(0,0,0,.9)}
.brand .glyph{display:grid;place-items:center;background:rgba(0,168,132,.14);font-size:16px}
.brand .names{display:flex;flex-direction:column;min-width:0}
.brand b{font-size:13.5px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.brand small{font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.topright{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.pill{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;
  border:1px solid var(--line-soft);background:rgba(22,34,42,.55);font-size:11.5px;color:var(--dim);white-space:nowrap}
.pill.quiet{color:var(--faint)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--acc-2);box-shadow:0 0 0 3px rgba(37,211,102,.14)}
.iconlink{font-size:12px;color:var(--faint);text-decoration:none;padding:5px 2px;border-bottom:1px dotted transparent}
.iconlink:hover{color:#bff5e2;border-bottom-color:rgba(0,168,132,.5)}

/* ═════════════════════ shell ═════════════════════ */
.shell{max-width:1080px;margin:0 auto;padding:26px clamp(14px,4vw,24px) 56px}

.eyebrow{margin:0 0 9px;font-size:10.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:#5fce9f}
h1{margin:0 0 10px;font-size:clamp(25px,3.3vw,34px);line-height:1.14;letter-spacing:-.025em;font-weight:680}
h1 span{color:#3fd7a6}
.lede{margin:0;max-width:64ch;font-size:14px;line-height:1.6;color:var(--dim)}

/* the three steps */
.rail{list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px;margin:20px 0 0;padding:0}
.rail li{display:flex;align-items:center;gap:10px;padding:11px 13px;border-radius:var(--r-md);
  border:1px solid var(--line-soft);background:rgba(255,255,255,.018);transition:border-color .25s,background .25s}
.rail .n{flex:0 0 auto;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;
  border:1px solid var(--line);color:var(--faint);font:600 11px/1 var(--mono)}
.rail b{display:block;font-size:12.6px;font-weight:600;color:var(--dim);letter-spacing:-.005em}
.rail small{display:block;font-size:11.2px;color:var(--faint);margin-top:1px;line-height:1.35}
.rail li.on{border-color:rgba(0,168,132,.42);background:rgba(0,168,132,.065)}
.rail li.on .n{background:var(--acc);border-color:transparent;color:#04120d;font-weight:700}
.rail li.on b{color:var(--ink)}
.rail li.done .n{background:rgba(37,211,102,.16);border-color:rgba(37,211,102,.35);color:#8ef0c6}
.rail li.done b{color:#cdf7e6}

/* ═════════════════════ layout ═════════════════════ */
.layout{display:grid;grid-template-columns:minmax(0,1.42fr) minmax(0,.92fr);gap:14px;margin-top:16px;align-items:start}
.panel{position:relative;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);box-shadow:var(--shadow);
  -webkit-backdrop-filter:blur(22px) saturate(150%);backdrop-filter:blur(22px) saturate(150%);overflow:hidden}
.panel::before{content:"";position:absolute;inset:0 0 auto;height:1px;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.16),transparent)}

.card{padding:20px clamp(15px,2.5vw,24px) 22px}
.cardhead{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;
  padding-bottom:15px;border-bottom:1px solid var(--line-soft);margin-bottom:17px}
.cardhead h2{margin:0 0 3px;font-size:16px;font-weight:640;letter-spacing:-.01em}
.cardhead p{margin:0;font-size:12.4px;color:var(--faint)}
.badge{flex:0 0 auto;font:600 10px/1 var(--sans);letter-spacing:.12em;color:#8ef0c6;
  border:1px solid rgba(0,168,132,.32);background:rgba(0,168,132,.10);padding:6px 8px;border-radius:8px}

/* form */
.lbl{display:block;font-size:10.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);margin-bottom:7px}
.field{display:flex;align-items:center;border:1px solid var(--line);border-radius:var(--r-md);
  background:rgba(8,15,19,.55);transition:border-color .18s,box-shadow .18s;overflow:hidden}
.field:focus-within{border-color:rgba(0,168,132,.6);box-shadow:0 0 0 3px rgba(0,168,132,.12)}
.field.bad{border-color:rgba(239,91,107,.6);box-shadow:0 0 0 3px rgba(239,91,107,.12)}
.field .plus{padding:0 0 0 12px;color:var(--faint);font:500 15px/1 var(--mono)}
#cc{display:none}
#cc.ready{display:block;appearance:none;-webkit-appearance:none;background:transparent;border:0;
  border-right:1px solid var(--line-soft);color:var(--ink);font:500 13px/1 var(--sans);
  padding:14px 27px 14px 6px;margin-left:3px;cursor:pointer;outline:none;
  background-image:linear-gradient(45deg,transparent 50%,var(--faint) 50%),linear-gradient(135deg,var(--faint) 50%,transparent 50%);
  background-position:calc(100% - 13px) 50%,calc(100% - 9px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
#cc.ready option{background:#16222a;color:#e9edef}
#cc.ready:focus{color:#9ff3d3}
.field input{flex:1;min-width:0;background:transparent;border:0;outline:none;color:var(--ink);
  font:500 16px/1 var(--mono);letter-spacing:.04em;padding:14px 13px}
.field input::placeholder{color:rgba(113,133,143,.55);letter-spacing:.02em}
.hint{margin:8px 0 0;font-size:11.8px;color:var(--faint);line-height:1.45}
.tokenwrap{margin-top:13px}
.actions{display:flex;gap:9px;margin-top:15px}
.btn{font-family:var(--sans);border-radius:var(--r-sm);cursor:pointer;transition:filter .18s,border-color .18s,transform .1s}
.btn:active{transform:translateY(1px)}
.btn.primary{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:9px;
  padding:13px 18px;border:0;font-size:13.6px;font-weight:650;letter-spacing:.01em;color:#04120d;
  background:linear-gradient(180deg,#14c194,#00a884)}
.btn.primary:hover{filter:brightness(1.07)}
.btn.primary:disabled{opacity:.72;cursor:default}
.btn.ghost{padding:10px 13px;font-size:12.6px;color:var(--ink);background:rgba(255,255,255,.03);border:1px solid var(--line)}
.btn.ghost:hover{border-color:rgba(0,168,132,.44);color:#c8f7e7}
.spin{display:none;width:13px;height:13px;border-radius:50%;border:2px solid rgba(4,18,13,.35);border-top-color:#04120d;animation:spin .7s linear infinite}
.btn.loading .spin{display:inline-block}
@keyframes spin{to{transform:rotate(360deg)}}

/* errors */
.err{display:none;gap:9px;align-items:flex-start;margin-top:13px;padding:10px 12px;border-radius:var(--r-sm);
  background:rgba(239,91,107,.09);border:1px solid rgba(239,91,107,.30);color:#ffcdd3;font-size:12.6px;line-height:1.45}
.err.show{display:flex}
.err svg{flex:0 0 auto;margin-top:1px}

/* the form, the code and the result never compete: one phase at a time */
.card.code #form{display:none}
.card.done #form{display:none}

/* the code */
.codebox{display:none;margin-top:18px;padding-top:17px;border-top:1px solid var(--line-soft)}
.codebox.show{display:block;animation:rise .34s var(--ease)}
.codetop{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}
.codegrid{display:flex;align-items:center;gap:5px;margin-top:2px}
.codegrid .cell{width:clamp(33px,6.6vw,42px);height:clamp(45px,8.8vw,54px);display:grid;place-items:center;
  border-radius:11px;border:1px solid rgba(0,168,132,.34);
  background:linear-gradient(180deg,rgba(0,168,132,.11),rgba(0,168,132,.03));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.06);
  font:700 clamp(19px,4.2vw,25px)/1 var(--mono);color:#d9fff3;font-variant-numeric:tabular-nums;
  animation:pop .28s var(--ease) both}
.codegrid .sep{color:var(--faint);font:700 17px/1 var(--mono);padding:0 2px;opacity:.7}
@keyframes pop{from{opacity:0;transform:translateY(5px) scale(.96)}to{opacity:1;transform:none}}
.timer{display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:74px}
.timer b{font:700 21px/1 var(--mono);color:#c8f7e7;font-variant-numeric:tabular-nums}
.timer small{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}
.timer.warn b{color:var(--warn)}
.timer.bad b{color:var(--bad)}
.meter{height:4px;border-radius:999px;background:rgba(134,150,160,.16);margin-top:15px;overflow:hidden}
.meter i{display:block;height:100%;width:100%;border-radius:999px;
  background:linear-gradient(90deg,#00a884,#53bdeb);transition:width .25s linear}
.codephone{margin:11px 0 0;font-size:12.3px;color:var(--faint)}
.codephone b{color:var(--ink);font:600 12.3px/1 var(--mono);letter-spacing:.02em}
.row{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.status{display:flex;align-items:center;gap:9px;margin-top:13px;font-size:12.4px;color:var(--dim)}
.status small{display:block;font-size:11.2px;color:var(--faint);margin-top:1px;line-height:1.4}
.pulse{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--acc-3);
  box-shadow:0 0 0 0 rgba(83,189,235,.5);animation:pulse 1.9s infinite}
.status.ok .pulse{background:var(--acc-2)}
.status.bad .pulse{background:var(--bad);animation:none;box-shadow:none}
@keyframes pulse{70%{box-shadow:0 0 0 9px rgba(83,189,235,0)}100%{box-shadow:0 0 0 0 rgba(83,189,235,0)}}

/* success */
.linked{display:none;position:relative;padding:26px 6px 8px;text-align:center}
.linked.show{display:block;animation:rise .4s var(--ease)}
.okring{width:54px;height:54px;margin:0 auto 13px;border-radius:50%;display:grid;place-items:center;
  background:radial-gradient(circle at 32% 26%,rgba(37,211,102,.30),rgba(0,168,132,.10));
  border:1px solid rgba(37,211,102,.42);color:#a3f7d1;font-size:24px;font-weight:700}
.linked h3{margin:0 0 7px;font-size:18.5px;letter-spacing:-.015em;font-weight:650}
.linked p{margin:0 auto;max-width:46ch;font-size:13.2px;line-height:1.6;color:var(--dim)}
.linked .next{list-style:none;display:grid;gap:7px;max-width:400px;margin:15px auto 0;padding:0;text-align:left}
.linked .next li{font-size:12.3px;color:var(--dim);background:rgba(255,255,255,.022);
  border:1px solid var(--line-soft);border-radius:9px;padding:8px 10px}
.linked code,.side code,.locked code{font:600 11.4px/1 var(--mono);color:#c8f7e7;
  background:rgba(0,168,132,.12);border:1px solid rgba(0,168,132,.22);padding:2px 5px;border-radius:5px}
.spark{position:absolute;inset:0;pointer-events:none}
.spark i{position:absolute;width:5px;height:5px;border-radius:50%;background:var(--acc-3);opacity:0}
.linked.show .spark i{animation:burst 1.1s var(--ease) forwards}
@keyframes burst{0%{opacity:.9;transform:translate(0,0) scale(1)}100%{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.2)}}

/* ═════════════════════ side column ═════════════════════ */
.side{padding:19px clamp(14px,2.3vw,20px)}
.side h2{margin:0 0 13px;font-size:11px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--faint)}
.guide{list-style:none;counter-reset:g;display:grid;gap:12px;margin:0;padding:0}
.guide li{position:relative;counter-increment:g;padding-left:32px}
.guide li::before{content:counter(g);position:absolute;left:0;top:0;width:21px;height:21px;border-radius:50%;
  display:grid;place-items:center;background:rgba(0,168,132,.12);border:1px solid rgba(0,168,132,.30);
  color:#8ef0c6;font:600 10.5px/1 var(--mono)}
.guide b{display:block;font-size:12.8px;font-weight:600;color:var(--ink)}
.guide span{display:block;margin-top:1px;font-size:11.8px;line-height:1.45;color:var(--faint)}
.divider{height:1px;background:var(--line-soft);margin:17px 0}
.facts{list-style:none;display:grid;gap:9px;margin:0;padding:0}
.facts li{position:relative;padding-left:15px;font-size:12.1px;line-height:1.5;color:var(--dim)}
.facts li::before{content:"";position:absolute;left:0;top:6px;width:5px;height:5px;border-radius:50%;background:rgba(0,168,132,.75)}
.capacity{margin-top:17px;padding:11px 12px;border:1px solid var(--line-soft);border-radius:11px;background:rgba(255,255,255,.02)}
.caphead{display:flex;justify-content:space-between;align-items:baseline;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);margin-bottom:7px}
.caphead b{color:var(--ink);font:600 11.5px/1 var(--mono);letter-spacing:0}
.capbar{height:5px;border-radius:999px;background:rgba(134,150,160,.16);overflow:hidden}
.capbar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#00a884,#53bdeb);transition:width .4s var(--ease)}
.privacy{margin:15px 0 0;font-size:11.3px;line-height:1.5;color:var(--faint)}

/* locked / closed */
.locked{display:flex;flex-direction:column;gap:11px;align-items:flex-start}
.locked h2{margin:0;font-size:19px;font-weight:650;letter-spacing:-.015em}
.locked p{margin:0;font-size:12.6px;line-height:1.55;color:var(--faint)}
.locked .pill{align-self:flex-start}

/* footer + toast */
footer{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;
  margin-top:20px;padding:0 3px;font-size:11.3px;color:var(--faint)}
footer a{color:var(--dim);text-decoration:none;border-bottom:1px dotted rgba(134,150,160,.35)}
footer a:hover{color:#c8f7e7;border-bottom-color:rgba(0,168,132,.5)}
.toast{position:fixed;left:50%;bottom:22px;z-index:9;transform:translate(-50%,14px);opacity:0;pointer-events:none;
  padding:10px 16px;border-radius:999px;font-size:12.6px;color:var(--ink);
  background:rgba(22,34,42,.92);border:1px solid var(--line);box-shadow:var(--shadow);
  -webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);
  transition:opacity .28s var(--ease),transform .28s var(--ease)}
.toast.show{opacity:1;transform:translate(-50%,0)}

@keyframes rise{from{opacity:0;transform:translateY(7px)}to{opacity:1;transform:none}}

/* ═════════════════════ responsive ═════════════════════ */
@media (max-width:900px){
  .layout{grid-template-columns:1fr}
  .side{order:2}
}
@media (max-width:640px){
  .rail{grid-template-columns:1fr;gap:7px}
  .rail li{padding:10px 12px}
  .topbar{padding:9px 14px;gap:8px}
  .topbar .pill.quiet,.topbar .iconlink{display:none}
  .brand{flex:1 1 auto}
  .brand small{display:none}
  .brand img,.brand .glyph{width:28px;height:28px;border-radius:9px}
  .brand b{font-size:13px}
  .topright{flex:0 0 auto;gap:0}
  .pill{font-size:11px;padding:5px 9px}
  .codetop{gap:10px}
  .timer{align-items:flex-start;min-width:0}
  .timer small{white-space:nowrap;font-size:9.5px;letter-spacing:.07em}
  .row .btn{flex:1}
  h1{letter-spacing:-.02em}
}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.001s!important;animation-iteration-count:1!important;transition-duration:.001s!important}
  .blob,.liquid,.grid{animation:none}
}
</style>
</head>
<body>
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <filter id="goo"><feGaussianBlur in="SourceGraphic" stdDeviation="26" result="b"/>
    <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 26 -11" result="g"/>
    <feBlend in="SourceGraphic" in2="g"/></filter>
</defs></svg>

<div class="bg" aria-hidden="true">
  <div class="blob b1"></div><div class="blob b2"></div>
  <div class="liquid"><i></i><i></i></div>
  <div class="grid"></div><div class="vignette"></div>
</div>

<header class="topbar">
  <a class="brand" href="/">
    <span class="logo">${logoMarkup()}</span>
    <span class="names"><b>${esc(botName)}</b><small>Linked devices</small></span>
  </a>
  <div class="topright">
    <span class="pill"><i class="dot" id="dot"></i><span id="tagText">Pairing open</span></span>
    <span class="pill quiet" id="seatChip">${esc(used)}/${esc(cap)} devices</span>
    <a class="iconlink" href="/api/status" id="st">Status</a>
    <a class="iconlink" href="/admin" id="ad">Console</a>
  </div>
</header>

<main class="shell">
  <section class="head">
    <p class="eyebrow">WhatsApp · Linked devices</p>
    <h1>Link your number to <span>${esc(botName)}</span></h1>
    <p class="lede">Enter the number, get an eight-digit code, and confirm it on the phone.
      The whole process takes about a minute, and nothing is installed on the device.</p>

    <ol class="rail" id="rail">
      <li data-step="1" class="on"><span class="n">1</span><div><b>Your number</b><small>Country code, digits only</small></div></li>
      <li data-step="2"><span class="n">2</span><div><b>Pairing code</b><small>Issued here by ${esc(botName)}</small></div></li>
      <li data-step="3"><span class="n">3</span><div><b>Confirm on the phone</b><small>Linked devices → Link with phone number</small></div></li>
    </ol>
  </section>

  <div class="layout">
    <!-- ══ action card ══ -->
    <section class="panel card" id="card">
${closed ? closedMarkup(m) : `
      <div class="cardhead">
        <div>
          <h2 id="cardTitle">Get a pairing code</h2>
          <p id="cardSub">Issued by this bot — no app, no account, no fee.</p>
        </div>
        <span class="badge" title="Served over TLS">HTTPS</span>
      </div>

      <form id="form" novalidate>
        <label class="lbl" for="num">WhatsApp number</label>
        <div class="field" id="field">
          <select id="cc" aria-label="Country code"></select>
          <input id="num" name="number" type="tel" inputmode="numeric" autocomplete="tel"
                 placeholder="77 123 4567" maxlength="20" aria-describedby="hint" spellcheck="false">
        </div>
        <p class="hint" id="hint">Pick your country, then type the number as you normally write it. Used once, to issue this code.</p>
        ${needsToken ? `<div class="tokenwrap"><label class="lbl" for="tk">Access passcode</label>
          <div class="field"><input id="tk" type="password" placeholder="••••••••" autocomplete="off"></div></div>` : ''}
        <div class="actions">
          <button class="btn primary" id="go" type="submit"><span>Continue</span><span class="spin"></span></button>
        </div>
      </form>

      <div class="err" id="err" role="alert">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.2v.1"/></svg>
        <span id="errText"></span>
      </div>

      <div class="codebox" id="codebox">
        <div class="codetop">
          <div>
            <p class="lbl" style="margin-bottom:8px">Pairing code</p>
            <div class="codegrid" id="code" aria-live="polite" aria-label="Pairing code"></div>
          </div>
          <div class="timer" id="timer"><b id="secs">60</b><small>seconds left</small></div>
        </div>
        <div class="meter"><i id="bar"></i></div>
        <p class="codephone">For <b id="codePhone">+94 …</b> — type this code on that phone.</p>
        <div class="row">
          <button class="btn ghost" id="copy" type="button">Copy code</button>
          <button class="btn ghost" id="again" type="button">New code</button>
          <button class="btn ghost" id="restart" type="button">Different number</button>
        </div>
        <div class="status" id="status"><i class="pulse"></i><div><span id="statusText">Waiting for confirmation…</span></div></div>
      </div>

      <div class="linked" id="linked">
        <div class="spark" id="spark"></div>
        <span class="okring">✓</span>
        <h3>Device linked</h3>
        <p id="linkedText">That number now runs its own bot session.</p>
        <ul class="next">
          <li>Send <code>.menu</code> from that number to see every command.</li>
          <li>Send <code>.mybot</code> to set its name, logo, header and footer.</li>
          <li>Remove it any time in <b>Linked devices</b> on the phone, or from the owner console.</li>
        </ul>
        <div class="row" style="justify-content:center">
          <button class="btn ghost" id="another" type="button">Link another number</button>
        </div>
      </div>
`}
    </section>

    <!-- ══ side ══ -->
    <aside class="panel side">
      <h2>On the phone</h2>
      <ol class="guide">
        <li><b>Open WhatsApp</b><span>Settings on iPhone, the ⋮ menu on Android</span></li>
        <li><b>Linked devices</b><span>Tap it, then “Link a device”</span></li>
        <li><b>Link with phone number instead</b><span>The link under the QR frame</span></li>
        <li><b>Enter the eight digits</b><span>The dash is optional — letters are not needed</span></li>
      </ol>
      <div class="divider"></div>
      <h2>Good to know</h2>
      <ul class="facts">
        <li>The code is valid for about ${esc(codeTtlSec)} seconds. A new one replaces it automatically.</li>
        <li>Each linked number runs <b>its own bot</b> — its own name, logo, header and footer.</li>
        <li>The bot only answers commands. Linking never gives it your password, chats or contacts.</li>
      </ul>
      <div class="capacity">
        <div class="caphead"><span>Linked devices</span><b id="capText">${esc(used)}/${esc(cap)}</b></div>
        <div class="capbar"><i id="capFill" style="width:${pct}%"></i></div>
      </div>
      <p class="privacy">🔒 Served over HTTPS · ${esc(tagline)}</p>
    </aside>
  </div>

  <footer>
    <span>${esc(botName)} · multi-session pairing${version ? ` · v${esc(version)}` : ''}</span>
    <span><a href="/api/status">bot status</a> · <a href="/admin">owner console</a></span>
  </footer>
</main>

<div class="toast" id="toast" role="status"></div>

<script>
(function(){
  var CFG = { mode: ${JSON.stringify(String(mode))}, ttl: ${Number(codeTtlSec) || 60} };
  var BOT_CC = ${JSON.stringify(String(country || '94'))};
  var $ = function(id){ return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var token = ${JSON.stringify(String(token || ''))} || params.get('token') || '';
  var pendingId = null, shownCode = '', timer = null, poll = null, endsAt = 0, lastPhone = '';

  /* ── small helpers ─────────────────────────────────────────────── */
  function toast(msg){
    var t = $('toast'); if(!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(function(){ t.classList.remove('show'); }, 1900);
  }
  function showErr(msg){
    var e = $('err'), f = $('field'); if(!e) return;
    $('errText').textContent = msg; e.classList.add('show');
    if (f){ f.classList.remove('bad'); void f.offsetWidth; f.classList.add('bad'); }
  }
  function hideErr(){ var e = $('err'); if(e) e.classList.remove('show'); var f = $('field'); if(f) f.classList.remove('bad'); }
  function setStep(k){
    var items = document.querySelectorAll('.rail li');
    for (var i = 0; i < items.length; i++){
      var n = i + 1;
      items[i].classList.toggle('on', n === k);
      items[i].classList.toggle('done', n < k);
    }
  }
  function api(path, body){
    var opt = { headers: { 'Accept': 'application/json' }, cache: 'no-store' };
    if (body){ opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var sep = path.indexOf('?') >= 0 ? '&' : '?';
    return fetch(path + (token ? sep + 'token=' + encodeURIComponent(token) : ''), opt)
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { ok: r.ok, code: r.status, body: j }; }); });
  }

  /* ── the number field ──────────────────────────────────────────── */
  /* ── country codes ─────────────────────────────────────────────
     WhatsApp's own screen asks for the country first. Typing a bare number and
     hoping the country code is right is where most failed attempts come from,
     so the form asks for it — LK first (where this bot is deployed), then the
     rest alphabetically. Without JS the select stays hidden and the plain
     international input is still exactly what it was. */
  var CC = [
    ['LK','Sri Lanka',94],['IN','India',91],['PK','Pakistan',92],['BD','Bangladesh',880],
    ['NP','Nepal',977],['MV','Maldives',960],['AE','United Arab Emirates',971],
    ['SA','Saudi Arabia',966],['QA','Qatar',974],['KW','Kuwait',965],['OM','Oman',968],
    ['BH','Bahrain',973],['JO','Jordan',962],['LB','Lebanon',961],['IQ','Iraq',964],
    ['MY','Malaysia',60],['SG','Singapore',65],['AU','Australia',61],['ID','Indonesia',62],
    ['GB','United Kingdom',44],['US','United States',1],['CA','Canada',1],['DE','Germany',49],
    ['FR','France',33],['IT','Italy',39],['ES','Spain',34],['NL','Netherlands',31],
    ['PT','Portugal',351],['BE','Belgium',32],['CH','Switzerland',41],['AT','Austria',43],
    ['SE','Sweden',46],['NO','Norway',47],['DK','Denmark',45],['FI','Finland',358],
    ['IE','Ireland',353],['PL','Poland',48],['RO','Romania',40],['RU','Russia',7],
    ['TR','Turkey',90],['EG','Egypt',20],['ZA','South Africa',27],['NG','Nigeria',234],
    ['KE','Kenya',254],['BR','Brazil',55],['AR','Argentina',54],['MX','Mexico',52],
    ['CL','Chile',56],['CO','Colombia',57],['CN','China',86],['JP','Japan',81],
    ['KR','South Korea',82],['PH','Philippines',63],['TH','Thailand',66],['VN','Vietnam',84],
  ];
  function flag(iso){
    return iso.replace(/./g, function(ch){ return String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65); });
  }
  var ccSel = $('cc');
  var ccCode = '94';
  if (ccSel){
    CC.forEach(function(c){
      var o = document.createElement('option');
      o.value = String(c[2]);
      o.textContent = flag(c[0]) + ' +' + c[2];
      o.title = c[1];
      ccSel.appendChild(o);
    });
    /* default: the country this bot is registered in (the server sends it),
       and after that whatever this browser used last time */
    var saved = '';
    try { saved = localStorage.getItem('sachi.cc') || ''; } catch (e){}
    var guess = saved || BOT_CC || '94';
    if (!CC.some(function(c){ return String(c[2]) === String(guess); })) guess = '94';
    ccSel.value = guess;
    ccCode = guess;
    ccSel.classList.add('ready');
    /* the placeholder shows the shape of a number in THAT country */
    function placeholderFor(cc){
      if (num) num.placeholder = String(cc) === '94' ? '77 123 4567' : 'without the leading 0';
    }
    placeholderFor(ccCode);
    ccSel.addEventListener('change', function(){
      ccCode = ccSel.value;
      try { localStorage.setItem('sachi.cc', ccCode); } catch (e){}
      placeholderFor(ccCode);
      if (num) num.dispatchEvent(new Event('input'));
      hideErr();
    });
  }

  /* The national number, with a trunk zero ("077…") or a pasted full number
     both handled, so nobody has to think about which part to leave out. */
  function withCountry(){
    var raw = String((num && num.value) || '').replace(/\D/g, '');
    if (!raw) return '';
    if (raw.indexOf(ccCode) === 0 && raw.length > ccCode.length + 6) return raw;
    return ccCode + raw.replace(/^0+/, '');
  }

  /* Group digits the way the number is actually written: Sri Lankan numbers
     94 77 123 4567, everything else in threes from the right. Never leaves a
     single orphan digit at the end, which is what made the field wrap. */
  function fmtNumber(d){
    d = String(d || '').replace(/\D/g, '');
    var zero = d.charAt(0) === '0' ? '0' : '';
    var n = zero ? d.slice(1) : d;
    if (String(ccCode) === '94'){
      /* 94 77 123 4567 — the way a Sri Lankan number is written */
      return zero + [n.slice(0,2), n.slice(2,5), n.slice(5,9)].filter(Boolean).join(' ');
    }
    var parts = [], tail = n;
    while (tail.length > 4){ parts.unshift(tail.slice(-3)); tail = tail.slice(0,-3); }
    if (tail) parts.unshift(tail);
    return (zero ? zero + ' ' : '') + parts.join(' ');
  }

  /* A pasted number that already carries a country code moves the selector
     itself: +94771234567 becomes LK + 77 123 4567 instead of being rejected. */
  function detectCountry(digits){
    var best = null;
    CC.forEach(function(c){
      var cc = String(c[2]);
      if (digits.indexOf(cc) !== 0) return;
      var rest = digits.slice(cc.length);
      if (rest.length < 7 || rest.length > 12) return;
      if (!best || cc.length > String(best[2]).length) best = c;
    });
    return best;
  }

  var num = $('num');
  if (num){
    if (params.get('number')){
      var pre = String(params.get('number')).replace(/\\D/g,'').slice(0,15);
      var known = CC.filter(function(c){ return pre.indexOf(String(c[2])) === 0 && pre.length > String(c[2]).length + 5; })[0];
      if (known && ccSel){ ccSel.value = String(known[2]); ccCode = String(known[2]); pre = pre.slice(String(known[2]).length); }
      num.value = fmtNumber(pre);
    }
    num.addEventListener('input', function(){
      var d = num.value.replace(/\\D/g,'').slice(0,15);
      var hit = detectCountry(d);
      if (hit && String(hit[2]) !== String(ccCode)){
        ccCode = String(hit[2]);
        if (ccSel){ ccSel.value = ccCode; try { localStorage.setItem('sachi.cc', ccCode); } catch (e){} }
        d = d.slice(ccCode.length);
        toast('Country set to +' + ccCode);
      }
      num.value = fmtNumber(d);
      hideErr();
    });
    num.addEventListener('paste', function(e){
      var t = (e.clipboardData || window.clipboardData).getData('text') || '';
      var d = t.replace(/\\D/g,'').slice(0,15);
      if (d.length >= 8){ num.value = d; num.dispatchEvent(new Event('input')); e.preventDefault(); hideErr(); }
    });
  }

  /* ── the code: eight cells, grouped 4-4 ────────────────────────── */
  function renderCode(code){
    var box = $('code'); if(!box) return;
    var raw = String(code || '').replace(/[^A-Z0-9]/g,'');
    shownCode = raw;
    box.innerHTML = '';
    for (var i = 0; i < 8; i++){
      if (i === 4){
        var sep = document.createElement('span'); sep.className = 'sep'; sep.textContent = '-';
        box.appendChild(sep);
      }
      var c = document.createElement('span'); c.className = 'cell';
      c.textContent = raw.charAt(i) || '·';
      if (raw.charAt(i)) c.style.animationDelay = (i * 38) + 'ms';
      box.appendChild(c);
    }
  }

  /* ── countdown ─────────────────────────────────────────────────── */
  function startTimer(secondsLeft){
    endsAt = Date.now() + Math.max(0, secondsLeft == null ? CFG.ttl : secondsLeft) * 1000;
    clearInterval(timer);
    timer = setInterval(function(){
      var left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
      var s = $('secs'), bar = $('bar'), wrap = $('timer');
      if (s) s.textContent = left;
      if (bar) bar.style.width = Math.min(100, Math.max(0, (left / CFG.ttl) * 100)) + '%';
      if (wrap){ wrap.classList.toggle('warn', left <= 25 && left > 10); wrap.classList.toggle('bad', left <= 10); }
      if (left <= 0){
        clearInterval(timer);
        setStatus('', 'Code expired — waiting for a fresh one…', 'It is replaced automatically; no need to reload.');
      }
    }, 250);
  }

  function setStatus(kind, text, sub){
    var el = $('status'), t = $('statusText'); if(!el || !t) return;
    el.className = 'status' + (kind === 'ok' ? ' ok' : kind === 'bad' ? ' bad' : '');
    t.textContent = text;
    var old = el.querySelector('small');
    if (old) old.remove();
    if (sub){ var s = document.createElement('small'); s.textContent = sub; t.parentNode.appendChild(s); }
  }

  function celebrate(){
    var sp = $('spark'); if(!sp) return;
    sp.innerHTML = '';
    for (var i = 0; i < 20; i++){
      var el = document.createElement('i');
      var ang = (Math.PI * 2 * i) / 20, dist = 55 + Math.random() * 80;
      el.style.left = '50%'; el.style.top = '36%';
      el.style.setProperty('--dx', Math.cos(ang) * dist + 'px');
      el.style.setProperty('--dy', Math.sin(ang) * dist + 'px');
      el.style.animationDelay = (Math.random() * 180) + 'ms';
      el.style.background = ['#53bdeb','#25d366','#00a884','#ffffff'][i % 4];
      sp.appendChild(el);
    }
  }

  /* ── polling: one source of truth while the phone is being used ── */
  function beginPolling(id){
    clearInterval(poll);
    var tries = 0;
    poll = setInterval(function(){
      tries++;
      api('/api/pair/status?id=' + encodeURIComponent(id)).then(function(r){
        var st = r.body || {};
        if (st.phonePretty && $('codePhone')) $('codePhone').textContent = st.phonePretty;
        if (st.state === 'linked'){
          clearInterval(poll); clearInterval(timer);
          var cb = $('codebox'); if (cb) cb.classList.remove('show');
          var lk = $('linked'); if (lk) lk.classList.add('show');
          phase('done'); celebrate();
          var lt = $('linkedText');
          if (lt) lt.innerHTML = 'Welcome, <b>' + String(st.name || '').replace(/[<>]/g,'') +
            '</b> — the number ' + String(st.phonePretty || ('+' + st.phone)).replace(/[<>]/g,'') +
            ' now runs its own bot session.';
          var dot = $('dot'), tg = $('tagText');
          if (dot) dot.style.background = '#25d366';
          if (tg) tg.textContent = 'Device linked';
        } else if (st.state === 'expired' || st.state === 'cancelled'){
          clearInterval(poll);
          setStatus('bad', st.state === 'expired'
            ? 'That attempt timed out — the socket was closed.'
            : 'That attempt was cancelled.',
            st.state === 'expired' ? 'Start again with a new code; nothing was left running.' : '');
        } else {
          var raw = String(st.rawCode || '').replace(/[^A-Z0-9]/g,'');
          if (raw && raw !== shownCode){
            renderCode(st.code || raw);
            startTimer(st.secondsLeft);
            setStatus('ok', 'Fresh code issued automatically', 'The previous one expired on WhatsApp\\'s side — use this one.');
          } else if (st.secondsLeft != null && tries % 4 === 0){
            startTimer(st.secondsLeft);
          }
        }
      }).catch(function(){});
      if (tries > 450) clearInterval(poll);      /* ~15 minutes, then stop */
    }, 2000);
  }

  /* one phase at a time: form → code → done */
  var HEAD = {
    form: ['Get a pairing code', 'Issued by this bot — no app, no account, no fee.'],
    code: ['Type this code on the phone', 'It is valid for about a minute; a fresh one replaces it automatically.'],
    done: ['All set', 'The device is linked and the session is running.'],
  };
  function phase(p){
    var c = $('card'); if (!c) return;
    c.classList.toggle('code', p === 'code');
    c.classList.toggle('done', p === 'done');
    setStep(p === 'code' ? 2 : p === 'done' ? 4 : 1);
    var h = HEAD[p] || HEAD.form;
    var t = $('cardTitle'), sub = $('cardSub');
    if (t) t.textContent = h[0];
    if (sub) sub.textContent = h[1];
  }
  function startOver(){
    clearInterval(poll); clearInterval(timer);
    pendingId = null; shownCode = ''; endsAt = 0;
    var cb = $('codebox'); if (cb) cb.classList.remove('show');
    var lk = $('linked'); if (lk) lk.classList.remove('show');
    phase('form');
    if (num){ num.focus(); num.select(); }
  }
  ['restart','another'].forEach(function(id){
    var b = $(id);
    if (b) b.addEventListener('click', startOver);
  });

  function onResult(r){
    var b = r.body || {};
    var go = $('go'); if (go){ go.classList.remove('loading'); go.disabled = false; }
    if (!r.ok){
      var msg = b.error || ('Request failed (' + r.code + ')');
      if (b.retryMs) msg += ' Try again in ' + Math.ceil(b.retryMs / 1000) + 's.';
      showErr(msg);
      return;
    }
    hideErr();
    pendingId = b.id;
    lastPhone = b.phonePretty || '';
    if (lastPhone && $('codePhone')) $('codePhone').textContent = lastPhone;
    if (b.state === 'linked'){
      var cb0 = $('codebox'); if (cb0) cb0.classList.remove('show');
      var lk0 = $('linked'); if (lk0) lk0.classList.add('show');
      phase('done'); celebrate();
      return;
    }
    renderCode(b.code);
    var cb = $('codebox'); if (cb) cb.classList.add('show');
    phase('code');
    setStatus('', 'Waiting for confirmation…', 'WhatsApp → Settings → Linked devices → Link with phone number');
    startTimer(b.secondsLeft);
    beginPolling(b.id);
    if (cb && cb.scrollIntoView) cb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ── submit ────────────────────────────────────────────────────── */
  var form = $('form');
  if (form) form.addEventListener('submit', function(e){
    e.preventDefault(); hideErr();
    var digits = withCountry();
    if (digits.length < 8 || digits.length > 15){
      showErr('That number looks short — enter it without the leading 0, e.g. 77 123 4567');
      if (num) num.focus();
      return;
    }
    if (CFG.mode === 'token' && !token && $('tk')) token = $('tk').value.trim();
    if (CFG.mode === 'token' && !token){
      showErr('This bot needs an access passcode — ask the owner for a link with ?token=…');
      return;
    }
    var go = $('go'); if (go){ go.classList.add('loading'); go.disabled = true; }
    api('/api/pair', { number: digits }).then(onResult).catch(function(){
      if (go){ go.classList.remove('loading'); go.disabled = false; }
      showErr('Cannot reach the bot — is it still running?');
    });
  });

  /* ── copy ──────────────────────────────────────────────────────── */
  var copy = $('copy');
  if (copy) copy.addEventListener('click', function(){
    var raw = shownCode;
    var grouped = raw.length === 8 ? raw.slice(0,4) + '-' + raw.slice(4) : raw;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(grouped).then(function(){ toast('Copied ' + grouped); }, function(){ legacyCopy(grouped); });
    } else legacyCopy(grouped);
  });
  function legacyCopy(text){
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copied ' + text); }
    catch (e){ toast('Copy failed — select the code manually'); }
    document.body.removeChild(ta);
  }

  /* ── new code ──────────────────────────────────────────────────── */
  var again = $('again');
  if (again) again.addEventListener('click', function(){
    if (!pendingId){ if (form) form.dispatchEvent(new Event('submit')); return; }
    hideErr();
    api('/api/pair/refresh', { id: pendingId }).then(function(r){
      if (!r.ok){ showErr((r.body && r.body.error) || 'Could not get a new code — start again.'); pendingId = null; return; }
      onResult({ ok: true, body: r.body });
      toast('Fresh code issued');
    }).catch(function(){ showErr('Cannot reach the bot.'); });
  });

  /* ── live state: seats, mode, whether the bot is up ────────────── */
  api('/api/pair/info').then(function(r){
    var b = r.body || {};
    var chip = $('seatChip'), tg = $('tagText'), dot = $('dot');
    var capText = $('capText'), capFill = $('capFill');
    if (b.sessions != null){
      if (chip) chip.textContent = b.sessions + '/' + b.maxSessions + ' devices';
      if (capText) capText.textContent = b.sessions + '/' + b.maxSessions;
      if (capFill) capFill.style.width = Math.min(100, Math.round((b.sessions / Math.max(1, b.maxSessions)) * 100)) + '%';
    }
    if (b.full){ if (tg) tg.textContent = 'All device slots are in use'; if (dot) dot.style.background = '#f0b429'; }
    if (b.closed){ if (tg) tg.textContent = 'Pairing closed'; if (dot) dot.style.background = '#ef5b6b'; }
    if (b.ready === false){
      if (tg) tg.textContent = 'Bot starting';
      if (dot) dot.style.background = '#f0b429';
      var st = $('status');
      if (st && $('codebox') && !$('codebox').classList.contains('show'))
        setStatus('', 'The bot is still connecting to WhatsApp — codes work as soon as it is up.');
    }
  }).catch(function(){});

  renderCode('');
})();
</script>
</body>
</html>`;
}

function logoMarkup() {
  // The bot's own logo (served by /logo) with an emoji fallback if there is none.
  return `<img src="/logo" alt="" onerror="this.outerHTML='<span class=&quot;glyph&quot;>🤖</span>'">`;
}

function closedMarkup(m) {
  if (m === 'locked') {
    return `      <div class="locked">
        <h2>Owner console is locked</h2>
        <p>Set <code>PAIR_ADMIN_TOKEN</code> (or <code>STATUS_TOKEN</code>) in <code>.env</code>,
          restart the bot, then open <code>/admin?token=YOUR_TOKEN</code>.
          Without a token nobody gets in — not even the owner.</p>
        <span class="pill">🔒 sessions and numbers stay private</span>
      </div>`;
  }
  return `      <div class="locked">
        <h2>Pairing is closed</h2>
        <p>The owner turned the pair page off (<code>PAIR_MODE=off</code>).
          Ask them to send <code>.pair</code> from the bot's own WhatsApp number instead.</p>
        <span class="pill">🔒 no codes are being issued</span>
      </div>`;
}

module.exports = { render, esc };
