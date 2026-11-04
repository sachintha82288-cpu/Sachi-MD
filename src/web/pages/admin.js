/**
 * Owner console — a token-gated glass page listing every session (primary +
 * paired), any half-finished pairing attempts, and the anti-ban/health state,
 * with a button to cut a session loose. Same design language as the pair page,
 * deliberately plain: it is a control panel, not a landing page.
 */
const { esc } = require('./pair');

function render({ botName = 'Sachi MD', version = '', token = '', sessions = [], pending = [], stats = {}, info = {} } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(botName)} · Owner console</title>
<style>
/* ═══════════ owner console — WhatsApp dark, liquid glass, cyber ═══════════ */
:root{
  --bg:#0b141a;--bg-2:#111b21;--panel:#111b21;--panel-2:#202c33;
  --ink:#e9edef;--dim:rgba(233,237,239,.64);--faint:rgba(233,237,239,.40);
  --line:rgba(134,150,160,.20);--line-soft:rgba(134,150,160,.12);--hi:rgba(255,255,255,.10);
  --acc:#00a884;--acc-2:#25d366;--acc-3:#53bdeb;--warn:#ffc857;--bad:#f15c6d;--ok:#25d366;
  --glass:linear-gradient(157deg,rgba(32,44,51,.86),rgba(17,27,33,.72) 52%,rgba(32,44,51,.80));
  --glass-soft:linear-gradient(157deg,rgba(255,255,255,.055),rgba(255,255,255,.018));
  --shadow:0 30px 80px -30px rgba(0,0,0,.85),0 2px 10px -4px rgba(0,0,0,.5);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Helvetica,"Noto Sans",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --ease:cubic-bezier(.22,.86,.28,1);
}
@media (prefers-color-scheme:light){
  :root{--bg:#eae6df;--bg-2:#f7f5f1;--ink:#0b141a;--dim:rgba(11,20,26,.68);--faint:rgba(11,20,26,.46);
    --line:rgba(11,20,26,.14);--line-soft:rgba(11,20,26,.08);--hi:rgba(255,255,255,.75);
    --glass:linear-gradient(157deg,rgba(255,255,255,.9),rgba(255,255,255,.68));
    --glass-soft:linear-gradient(157deg,rgba(255,255,255,.66),rgba(255,255,255,.34));
    --shadow:0 26px 60px -30px rgba(9,32,29,.4),0 2px 8px -4px rgba(9,32,29,.16);}
}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;font-family:var(--font);font-size:14.5px;line-height:1.5;color:var(--ink);
  -webkit-font-smoothing:antialiased;background:var(--bg);overflow-x:hidden}
::selection{background:rgba(0,168,132,.32);color:#fff}
.bg{position:fixed;inset:0;z-index:0;overflow:hidden;
  background:radial-gradient(120% 80% at 8% -10%,#123a35 0%,transparent 55%),
    radial-gradient(100% 70% at 100% 0%,#0d2b3a 0%,transparent 52%),
    linear-gradient(180deg,var(--bg-2) 0%,var(--bg) 46%,#070d11 100%)}
.bg i{position:absolute;border-radius:50%;filter:blur(76px);opacity:.46;mix-blend-mode:screen}
.bg i:nth-child(1){width:52vw;height:52vw;left:-12vw;top:-14vw;background:radial-gradient(circle,#00a884,transparent 63%);animation:d1 28s var(--ease) infinite}
.bg i:nth-child(2){width:42vw;height:42vw;right:-10vw;bottom:-14vw;background:radial-gradient(circle,#1f7fb8,transparent 64%);animation:d2 36s var(--ease) infinite}
@keyframes d1{50%{transform:translate(8vw,6vh) scale(1.15)}}
@keyframes d2{50%{transform:translate(-7vw,-8vh) scale(1.12)}}
.bg .grid{position:absolute;inset:0;opacity:.14;
  background-image:linear-gradient(rgba(0,168,132,.16) 1px,transparent 1px),linear-gradient(90deg,rgba(0,168,132,.16) 1px,transparent 1px);
  background-size:64px 64px;
  -webkit-mask-image:radial-gradient(120% 90% at 50% 10%,#000 10%,transparent 72%);
  mask-image:radial-gradient(120% 90% at 50% 10%,#000 10%,transparent 72%);
  animation:gp 42s linear infinite}
@keyframes gp{to{background-position:64px 64px,64px 64px}}
.bg .vig{position:absolute;inset:0;background:radial-gradient(115% 78% at 50% 30%,transparent 44%,rgba(0,0,0,.55) 100%)}
@media (prefers-color-scheme:light){
  .bg{background:radial-gradient(120% 80% at 8% -10%,#d7ece6 0%,transparent 55%),radial-gradient(100% 70% at 100% 0%,#dceaf3 0%,transparent 52%),linear-gradient(180deg,#f6f8f7,#eae6df)}
  .bg i{mix-blend-mode:multiply;opacity:.3}.bg .grid{opacity:.08}
  .bg .vig{background:radial-gradient(115% 78% at 50% 30%,transparent 46%,rgba(255,255,255,.5) 100%)}
}
.wrap{position:relative;z-index:1;max-width:1120px;margin:0 auto;padding:30px 18px 64px}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:22px}
.id{display:flex;align-items:center;gap:13px;min-width:0}
.ring{position:relative;width:46px;height:46px;flex:0 0 auto;border-radius:14px;display:grid;place-items:center;
  background:var(--glass-soft);border:1px solid var(--line);box-shadow:inset 0 1px 0 var(--hi)}
.ring::before{content:"";position:absolute;inset:-2px;border-radius:16px;padding:2px;
  background:conic-gradient(from 0deg,transparent 0 40%,var(--acc-2) 50%,var(--acc) 60%,var(--acc-3) 68%,transparent 78%);
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask-composite:exclude;animation:sp 8s linear infinite;opacity:.85}
@keyframes sp{to{transform:rotate(1turn)}}
.ring img{width:34px;height:34px;border-radius:10px;object-fit:cover;display:block}
h1{margin:0;font-size:21px;letter-spacing:-.025em;font-weight:700;line-height:1.15}
h1 .g{background:linear-gradient(94deg,var(--acc-2),var(--acc) 46%,var(--acc-3));-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{margin:3px 0 0;color:var(--faint);font-size:12.4px}
.badges{display:flex;gap:7px;flex-wrap:wrap}
.tag{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border-radius:999px;font-size:10.5px;
  letter-spacing:.09em;text-transform:uppercase;color:var(--dim);background:var(--glass-soft);
  border:1px solid var(--line-soft);white-space:nowrap}
.tag .dot{width:7px;height:7px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 3px rgba(37,211,102,.18)}
.grid2{display:grid;gap:16px;grid-template-columns:1fr}
@media(min-width:900px){.grid2{grid-template-columns:1.45fr .55fr}}
.col{display:flex;flex-direction:column;gap:16px;min-width:0}
.card{position:relative;border-radius:22px;padding:20px;background:var(--glass);border:1px solid var(--line);
  box-shadow:var(--shadow),inset 0 1px 0 var(--hi);overflow:hidden;isolation:isolate;
  -webkit-backdrop-filter:blur(30px) saturate(165%);backdrop-filter:blur(30px) saturate(165%)}
.card::after{content:"";position:absolute;inset:-1px;pointer-events:none;border-radius:inherit;opacity:0;transition:opacity .5s var(--ease);
  background:radial-gradient(340px circle at var(--mx,50%) var(--my,0%),rgba(0,168,132,.18),transparent 62%)}
.card:hover::after{opacity:1}
.card h2{margin:0 0 5px;font:650 11px/1.4 var(--mono);letter-spacing:.13em;text-transform:uppercase;color:var(--faint);display:flex;align-items:center;gap:8px}
.card h2 .n{color:var(--acc-2);font-weight:700}
.card p.note{margin:0 0 14px;color:var(--dim);font-size:12.5px;line-height:1.55}
table{width:100%;border-collapse:collapse;font-size:13.2px}
th{text-align:left;font:600 10px/1.4 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--faint);
  padding:9px 10px;border-bottom:1px solid var(--line)}
td{padding:11px 10px;border-bottom:1px solid var(--line-soft);vertical-align:middle}
tr:last-child td{border-bottom:0}
tbody tr{transition:background .2s var(--ease)}
tbody tr:hover{background:rgba(0,168,132,.06)}
.mono{font-family:var(--mono);font-size:12.4px;font-variant-numeric:tabular-nums;letter-spacing:.01em}
.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-size:11px;
  background:rgba(233,237,239,.06);border:1px solid var(--line-soft);color:var(--dim);white-space:nowrap}
.pill .d{width:6px;height:6px;border-radius:50%;background:var(--dim)}
.pill.on{color:#c8ffe9;background:rgba(37,211,102,.14);border-color:rgba(37,211,102,.4)}
.pill.on .d{background:var(--ok);box-shadow:0 0 0 3px rgba(37,211,102,.18)}
.pill.warn{color:#fff0d6;background:rgba(255,200,87,.14);border-color:rgba(255,200,87,.4)}
.pill.warn .d{background:var(--warn)}
.pill.bad{color:#ffe3e7;background:rgba(241,92,109,.14);border-color:rgba(241,92,109,.4)}
.pill.bad .d{background:var(--bad)}
.pill.main{color:#cdeeff;background:rgba(83,189,235,.14);border-color:rgba(83,189,235,.4)}
.btn{border:0;cursor:pointer;font:600 12.6px/1 var(--font);color:#04231c;padding:10px 14px;border-radius:11px;
  background:linear-gradient(150deg,#7ff0c4,var(--acc-2) 42%,var(--acc));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 12px 26px -14px rgba(0,168,132,.9);
  transition:transform .18s var(--ease),box-shadow .25s var(--ease),filter .2s}
.btn:hover{transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.6),0 16px 30px -14px rgba(37,211,102,.95)}
.btn:disabled{opacity:.5;cursor:not-allowed;transform:none}
.btn.ghost{background:rgba(233,237,239,.06);color:var(--ink);border:1px solid var(--line);box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
.btn.ghost:hover{background:rgba(0,168,132,.14);border-color:rgba(0,168,132,.42);color:#d9fff2}
.btn.danger{background:rgba(241,92,109,.12);color:#ffd6db;border:1px solid rgba(241,92,109,.38);box-shadow:none}
.btn.danger:hover{background:rgba(241,92,109,.22)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:9px 14px;font-size:12.8px;margin:0}
.kv dt{color:var(--faint);white-space:nowrap} .kv dd{margin:0;font-family:var(--mono);font-size:12.2px;text-align:right;
  font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.empty{color:var(--faint);font-size:12.8px;padding:16px 2px;display:flex;align-items:center;gap:9px}
.empty .d{width:7px;height:7px;border-radius:50%;background:var(--faint)}
a{color:var(--acc-3);text-decoration:none} a:hover{text-decoration:underline}
.link{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:4px}
input#u{flex:1 1 240px;min-width:0;padding:12px 13px;border-radius:11px;font:500 12.4px/1 var(--mono);color:var(--ink);
  background:rgba(11,20,26,.5);border:1px solid var(--line);outline:none;letter-spacing:.01em;
  transition:border-color .25s var(--ease),box-shadow .25s var(--ease)}
input#u:focus{border-color:rgba(0,168,132,.7);box-shadow:0 0 0 1px rgba(0,168,132,.35),0 0 24px -8px rgba(37,211,102,.5)}
@media (prefers-color-scheme:light){input#u{background:rgba(255,255,255,.72)}}
#msg{margin-top:12px;font-size:12.6px;color:var(--dim);min-height:18px}
.hintline{margin:14px 0 0;color:var(--faint);font-size:11.8px;line-height:1.5}
.hintline code{font:600 11.6px/1 var(--mono);color:#d9fff2;background:rgba(0,168,132,.14);
  border:1px solid rgba(0,168,132,.28);padding:2px 5px;border-radius:5px}
.toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,18px);z-index:9;opacity:0;pointer-events:none;
  padding:11px 17px;border-radius:999px;font-size:13px;color:var(--ink);background:var(--glass);
  border:1px solid var(--line);box-shadow:var(--shadow);
  -webkit-backdrop-filter:blur(22px) saturate(160%);backdrop-filter:blur(22px) saturate(160%);
  transition:opacity .3s var(--ease),transform .3s var(--ease)}
.toast.show{opacity:1;transform:translate(-50%,0)}
@media (max-width:520px){.wrap{padding:22px 14px 48px}.card{padding:16px;border-radius:18px}th,td{padding:9px 7px}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div class="bg" aria-hidden="true"><i></i><i></i><div class="grid"></div><div class="vig"></div></div>
<div class="wrap">
  <div class="top">
    <div class="id">
      <div class="ring"><img src="/logo" alt="" onerror="this.outerHTML='<span style=\'font-size:22px\'>🤖</span>'"></div>
      <div>
        <h1>${esc(botName)} · <span class="g">Owner console</span></h1>
        <p class="sub">Sessions, half-finished pairings and bot health${version ? ` · v${esc(version)}` : ''}</p>
      </div>
    </div>
    <div class="badges">
      <span class="tag"><span class="dot"></span>token protected</span>
      <span class="tag">🔒 HTTPS</span>
      <span class="tag">main number only</span>
    </div>
  </div>

  <div class="grid2">
    <div class="col">
    <div class="card">
      <h2><span class="n">01</span> Sessions</h2>
      <p class="note">The primary session is the number you typed in the terminal. Paired sessions belong to whoever linked them — they keep their own branding.</p>
      <div id="table">${sessionsTable(sessions)}</div>
    </div>

    </div>
    <div class="col">
      <div class="card">
        <h2><span class="n">02</span> Pair page</h2>
        <p class="note">Send this link to anyone you want to link a number.</p>
        <div class="link"><input id="u" readonly value="${esc(info.url || '')}"><button class="btn ghost" id="cp">Copy</button></div>
        <dl class="kv" style="margin-top:14px">
          <dt>public?</dt><dd>${info.isPublic ? 'yes' : 'NO — private address'}</dd>
          <dt>detected via</dt><dd>${esc(info.source || '—')}</dd>
          <dt>ip : port</dt><dd>${esc(info.ip || '—')}:${esc(info.port || '—')}</dd>
        </dl>
        ${String(info.notes || []).length ? `<p class="note" style="margin-top:12px;color:#ffdfe4">${String(info.notes || []).map(esc).join('<br>')}</p>` : ''}
      </div>

      <div class="card">
        <h2><span class="n">03</span> Waiting to link</h2>
        <p class="note">Codes issued but not linked yet. They are cleaned up automatically.</p>
        <div id="pending">${pendingTable(pending)}</div>
      </div>

      <div class="card">
        <h2><span class="n">04</span> Limits &amp; health</h2>
        <dl class="kv">
          <dt>max sessions</dt><dd>${esc(stats.maxSessions != null ? stats.maxSessions : '—')}</dd>
          <dt>in use</dt><dd>${esc(stats.inUse != null ? stats.inUse : '—')}</dd>
          <dt>pending</dt><dd>${esc(stats.pending != null ? stats.pending : '—')}</dd>
          <dt>codes issued</dt><dd>${esc(stats.issued != null ? stats.issued : '—')}</dd>
          <dt>linked ok</dt><dd>${esc(stats.linked != null ? stats.linked : '—')}</dd>
          <dt>refused</dt><dd>${esc(stats.refused != null ? stats.refused : '—')}</dd>
          <dt>health</dt><dd>${esc(stats.health || '—')}</dd>
          <dt>uptime</dt><dd>${esc(stats.uptime || '—')}</dd>
        </dl>
        <p class="hintline">Everything here is also in chat from the main number:
          <code>.sessions</code> <code>.unpair</code> <code>.health</code> <code>.antiban</code></p>
      </div>
    </div>
  </div>
</div>
<div class="toast" id="toast" role="status"></div>
<script>
(function(){
  var token = new URLSearchParams(location.search).get('token') || ${JSON.stringify(String(token || ''))};
  function $(i){return document.getElementById(i)}
  function toast(m){var t=$('toast');t.textContent=m;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show')},1800)}
  Array.prototype.forEach.call(document.querySelectorAll('.card'),function(c){
    c.addEventListener('pointermove',function(e){
      var r=c.getBoundingClientRect();
      c.style.setProperty('--mx',((e.clientX-r.left)/r.width*100)+'%');
      c.style.setProperty('--my',((e.clientY-r.top)/r.height*100)+'%');
    });
  });
  $('cp').addEventListener('click',function(){
    var v=$('u').value; if(navigator.clipboard) navigator.clipboard.writeText(v).then(function(){toast('Link copied')});
    else {$('u').select();document.execCommand('copy');toast('Link copied')}
  });
  document.addEventListener('click',function(e){
    var b=e.target.closest('[data-unpair]'); if(!b) return;
    var phone=b.getAttribute('data-unpair');
    if(!confirm('Unlink '+phone+'? Their bot session and stored branding are removed.')) return;
    b.disabled=true;
    fetch('/api/admin/unpair'+(token?'?token='+encodeURIComponent(token):''),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:phone})})
      .then(function(r){return r.json().catch(function(){return{}}).then(function(j){return{ok:r.ok,j:j}})})
      .then(function(r){ toast(r.ok ? ('Unlinked '+phone) : (r.j.error||'Unlink failed')); setTimeout(function(){location.reload()},900); })
      .catch(function(){ toast('Network error'); b.disabled=false; });
  });
})();
</script>
</body>
</html>`;
}

function pillFor(s) {
  const state = String(s.state || '').toLowerCase();
  const live = s.connected || state === 'connected' || state === 'open';
  const cls = s.isPrimary ? 'on' : live ? 'on' : (state === 'connecting' ? 'warn' : 'bad');
  const label = s.isPrimary ? `primary · ${live ? 'online' : state || 'offline'}` : (live ? 'online' : state || 'offline');
  return `<span class="pill ${cls}"><span class="d"></span>${esc(label)}</span>`;
}

function sessionsTable(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!list.length) return '<div class="empty">No sessions yet. The primary number appears here once it is linked.</div>';
  return `<table><thead><tr><th>Number</th><th>Name</th><th>State</th><th>Since</th><th></th></tr></thead><tbody>${
    list.map((s) => `<tr>
      <td class="mono">${esc(s.phone || s.id || '—')}</td>
      <td>${esc(s.name || '—')}${s.isPrimary ? ' <span class="pill">main</span>' : ''}</td>
      <td>${pillFor(s)}</td>
      <td class="mono">${esc(since(s.startedAt))}</td>
      <td style="text-align:right">${s.isPrimary ? '' : `<button class="btn danger" data-unpair="${esc(s.phone || '')}">Unlink</button>`}</td>
    </tr>`).join('')}</tbody></table>`;
}

function pendingTable(pending) {
  const list = Array.isArray(pending) ? pending : [];
  if (!list.length) return '<div class="empty">Nothing waiting.</div>';
  return `<table><thead><tr><th>Number</th><th>Code</th><th>Left</th><th></th></tr></thead><tbody>${
    list.map((p) => `<tr>
      <td class="mono">${esc(p.phone || '—')}</td>
      <td class="mono">${esc(p.code || '—')}</td>
      <td class="mono">${p.secondsLeft != null ? `${p.secondsLeft}s` : '—'}</td>
      <td style="text-align:right"><button class="btn ghost" data-unpair="${esc(p.phone || '')}">Cancel</button></td>
    </tr>`).join('')}</tbody></table>`;
}

function since(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

module.exports = { render, sessionsTable, pendingTable };
