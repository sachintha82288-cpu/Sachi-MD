# 👑 Sachi MD v1.3.0

Fast • Smart • Clean — a modular WhatsApp bot designed for Pterodactyl.

## v1.3.0 — the pairing system, rebuilt

> the pair system still is not good · the code should be an easy number like
> 1111-1111 · it should feel official · the pair website should be proper and
> well organised

### 1. The code is a phone number you can type

Pairing codes were pronounceable words (`MILU-KOTA`) because a random mix like
`K7Q2-M9XF` is hard to read aloud. That was the wrong fix: the phone only has a
**numeric keypad**, so a word has to be spelled out letter by letter on a
keypad that does not have letters. The code is now **eight digits, grouped
4-4** — `4821-0937` — generated with `crypto.randomInt` and never starting with
a zero. WhatsApp accepts any eight characters, so this changes nothing about
how the code is used; it only changes who can type it without a mistake.

**A fixed code is available for testing:** set `PAIR_FIXED_CODE=11111111` in
`.env` and every code is `1111-1111`. It is off by default and deliberately so:
a code that never changes is a code somebody else can memorise — anyone who can
open the pair page could link a device to a number they do not own. Use it on a
private panel, and unset it when you are done.

| | before | now |
|---|---|---|
| code | `MILU-KOTA` | `4821-0937` |
| keyboard | letters, on a digit keypad | digits, on the keypad |
| fixed code | — | `PAIR_FIXED_CODE=11111111` |
| server refuses our code | pairing failed | falls back to WhatsApp's own code |

### 2. The flow is the official one

The terminal, the chat reply and the website now all describe the **same four
taps**, in the order WhatsApp itself shows them, and all three show the number
in the same international form (`+94 77 123 4567`):

1. WhatsApp → Settings
2. **Linked devices**
3. **Link a device** → *Link with phone number instead*
4. Type the code

The terminal prints a card with the number, the code grouped and spaced out for
reading aloud, and the same steps — instead of a banner that only had the code.
The chat reply uses a fenced block, which every client renders as monospace, so
the code is a box and not a line of text that can be copied with an underscore.

### 3. The pair website

The page is now a form with a beginning, a middle and an end:

- **a three-step rail** at the top that marks itself off as you go
  (your number → pairing code → confirm),
- **one phase at a time**: the number field is replaced by the code, the code is
  replaced by the result — no more scrolling past a dead form to find the code,
- **the code as eight digit cells**, grouped 4-4, with a countdown bar,
- **a country selector** (55 countries, LK first, default = the bot's own
  country). Paste `+94771234567` and the selector moves to LK by itself; type
  `0771234567` and the trunk zero is dropped, not doubled,
- **an "on the phone" column** with the four taps, the privacy notes and the
  device seats (`2/8`),
- **"Different number" / "Link another number"** so a finished or abandoned
  attempt is never a dead end,
- a mobile layout that keeps the status in the top bar instead of wrapping it.

Same security as before: no external asset, no CDN, `default-src 'none'`,
`no-store`, token gate when `PAIR_MODE=token`, and everything interpolated is
escaped.

### 4. Verification (v1.3.0)

| Check | Result |
|---|---|
| unit / integration tests | **335 pass** (+11 `tests/pair-ui.test.js`) |
| code generator | 5000 codes: all eight digits, none leading with 0, >4900 unique |
| pair page in a real browser | Chromium: desktop + 390 px mobile, idle → code → linked, screenshots in the audit |
| pair page script | compiled by the test suite, so a broken escape cannot ship |
| live tool probe | 16/16 (unchanged) |

---

## v1.2.4 — the new emblem

> new logo

The uploaded emblem (gothic circle, crimson **Sachi MD** lettering) replaces the
old one. Nothing else changed — same code, same tests.

| file | used by | size |
|---|---|---|
| `assets/logo.jpg` | the menu card image, 1024×1024 | 238 KB |
| `assets/logo-web.jpg` | pair page, admin console, 512×512 | 62 KB |

The 1600×1600 upload was resized (Lanczos, progressive JPEG) instead of shipped
raw: 1.36 MB in every menu send is a needless upload, and WhatsApp re-compresses
it anyway. `settings.logoPath()` and `menubuttons.logoPath()` prefer the JPG, so
the card, `/logo`, the console and `.settings` all show it **after a restart**.

To change it again: replace `assets/logo.jpg` and restart, or reply to any image
with `.setlogo` (owner, no restart) — `.resetlogo` puts this one back.

---

## v1.2.3 — every downloader repaired, a new logo, and `.sub`

> the tools — find the ones that do not work and fix them · change the bot logo
> (I uploaded it) · `.sub <channel/group link>` in the terminal should make every
> paired number follow/join

### 1. The tools audit — what was actually broken

Instead of trusting the command list, every network-backed tool was called for
real (`node scripts/tools-probe.js`, 16 live checks). Three did not work:

| tool | what was wrong | what it is now |
|---|---|---|
| **`.ytv` `.yta` `.play`** (and the merge path of `.fb` / `.tiktok`) | yt-dlp was invoked with `-o -`, i.e. "write the file to stdout". Modern YouTube is DASH: the video and the audio arrive as **two** streams that must be **merged**, and ffmpeg cannot mux into a pipe — it dies with `ffmpeg exited with code -11` / `Conversion failed!`. On top of that, `/tmp` on a panel is a small tmpfs, and a real merge filled it. So every video/audio download failed, and `.play` failed with it | downloads go to a **temp file** under `data/tmp/`, are merged there, read into memory, and the directory is deleted. The directory is policed while it fills, so a runaway download cannot eat the disk |
| **all of them, randomly** | `bin/yt-dlp` was present but **not executable**. `spawn()` emitted `EACCES` as an unhandled `'error'` event, which **killed the whole bot process** — "the bot has errors" | `usable()` now checks size, exec bit (applies `chmod +x`), and actually runs `--version`; a binary that cannot run is re-downloaded. Both `spawn` sites (yt-dlp metadata, Xray) now handle `'error'` |
| **`.img2sticker`** | promised an "AI background cutout" that silently never happened: the model is an optional 130 MB dependency and is not installed | still falls back to a circle crop, but **says so** and prints the one-line command that enables the AI cutout |

Also fixed while in there: a 4K "best" pick is no longer the default — the
stream is capped at `YTDLP_MAX_HEIGHT` (1080) because WhatsApp re-compresses it
to a few MB anyway, and a size-guard bug that rejected a merged download for
being "too large" when it was the video + audio temp copies together.

**Verified live, every run of `scripts/tools-probe.js`:**

```
✅ wiki · download · getdp · yts · ytdlp · ytmeta · tiktok · facebook
✅ mediafire · ytdl-video (9.8 MB) · ytdl-audio (3.7 MB) · sticker (webp→png)
✅ apk-search · apk-download (11.4 MB) · gitclone · ai
pass 16/16
```

### 2. The logo

`assets/logo.jpg` is the emblem you uploaded (the previous `logo.png` was
deleted so the two cannot disagree). It is used for the menu card, `.settings`,
the pair website's glass ring and the owner console. A 512 px
`assets/logo-web.jpg` is kept for the web pages, because shipping a 1.5 MB PNG
to a phone on mobile data is rude.

If you replace the file again, keep the same name (`assets/logo.jpg`) and
restart — nothing else needs to change.

### 3. `.sub` — one command, every number

```
.sub https://whatsapp.com/channel/0029Vb…
.sub https://chat.whatsapp.com/AbCdEf…
.sub 0029VbAbCdEfGhIjKlMnOp12          (bare channel id)
.sub AbCdEfGhIjKlMnOpQrStUv            (bare invite code)
```

Every **connected** session follows the channel / joins the group — the main
number and every paired number. They are different WhatsApp protocols, so the
link is resolved first and each socket uses what fits: `newsletterFollow` for a
channel, `groupAcceptInvite` for a group.

- **Partial success is visible.** One number can be banned from a channel or
  have no data; the report is `N/M` plus a per-number line, never a single ✅
  that hides a failure.
- **The channel name is looked up** (`newsletterMetadata`) so the confirmation
  says *what* was followed, not just that something was.
- Concurrency 3, owner-only, main-only: it makes every number the bot holds
  join somewhere, which is not something a paired user may do to the others.
- Aliases: `.follow`, `.subscribe`, `.join`.

### 4. Verification (v1.2.3)

| Check | Result |
|---|---|
| unit / integration tests | **324 passed** (+7 `tests/sub.test.js`) |
| live tool probe | **16/16** — including a real 9.8 MB video merge, a real 3.7 MB audio, a real 11.4 MB APK |
| downloader regression | `.ytv 720p` and `.yta 128k` driven end-to-end through `sendYoutube` with a stub socket: 9.8 MB video, 3.7 MB audio delivered |
| quality options | all 8 video + 7 audio choices resolve against the live site (`--simulate`) |
| menu / status E2E | 19/19 · 18/18 |
| fuzz / command audit | no problems · 51/55 (network-only) |

**Upgrade note.** `.sub` needs a restart to appear (commands are loaded at
boot). `YTDLP_MAX_HEIGHT` is new and optional.

## v1.2.2 — the bot stops answering messages from the past

> a phone with WhatsApp's background running turned off: open WhatsApp, everything
> syncs, and the bot replies by itself to old commands that are no longer relevant

### Why it happened

WhatsApp replays what a number received while it (or the phone) was offline —
each message carrying its **original** timestamp. v1.1.0 added a 3-minute
`STALE_COMMAND_SEC` guard, but only **for the first 60 seconds after the socket
opened**:

```js
const justConnected = Date.now() - session.connectedAt < 60_000;
if (ageMs > STALE_MS() && justConnected) continue;     // ← the bug
```

So a replay that arrived *later* — the normal case when the phone itself was
offline for hours and syncs on opening — walked straight into the router, and
the bot answered a `.menu` from yesterday with a full menu, hooks and all.

### What the gate does now

One pure function, `inboundDecision(msg, session)`, decides everything before
the router ever sees a message:

| verdict | rule |
|---|---|
| `own` | the id is something this session sent (the bot never answers itself) |
| `duplicate` | the id was handled already — in a **process-wide** cache, so a reconnect, a history sync or a second device cannot replay it |
| `backlog` | stamped **before the socket finished connecting** → it is a replay, whatever its age. This is the actual reported bug, and it is now unconditional |
| `stale` | older than `STALE_COMMAND_SEC` (180 s) regardless of connection state |
| `status` | a status update that passed both checks |
| `handle` | a real, recent message |

Both of those rules are unconditional now; the 60-second window is gone. A
10-second grace (`SYNC_GRACE_MS`) absorbs clock skew between the sending phone
and the server, so a live message is never mistaken for a replay, and a message
with **no** timestamp is treated as new (never silently dropped).

Refusals are **counted and logged**, not silent:

```
[Sachi MD] [INFO] Ignoring 7384s-old message replayed by WhatsApp (backlog, not a live command) from 9477…
```

`type: 'append'` upserts (history sync proper) are counted too, and `.health`
now reports the total:

```
• Replays   : 10 old message(s) ignored (backlog / stale / duplicate)
```

A non-zero number there is **healthy** — it is the bot refusing to answer the
past. Status updates obey the same rules, so a status replayed from yesterday is
no longer reacted to or auto-forwarded either.

### Also in this release

- **A stored certificate is validated before it is served.** An expired
  certificate, a `key.pem` that does not match `cert.pem`, or a corrupt file
  used to fail *inside every TLS handshake* — the site became unreachable with
  nothing in the log to explain it. Now it is detected at boot and a fresh
  certificate is generated (`[tls] data/tls/key.pem does not match cert.pem —
  generating a fresh pair`).
- `.health` gained the replay counter.

### Verification (v1.2.2)

| Check | Result |
|---|---|
| unit / integration tests | **317 passed** (+13: `tests/backlog.test.js`) |
| the exact reported scenario | a message from 20 hours ago delivered while the bot has been connected for 6 hours → `backlog`, router never called |
| reconnections | the same id replayed after a reconnect → `duplicate`, routed once |
| regression guard | `tests/stale.test.js` was rewritten around the new contract (its old "a late command is still answered" test encoded this bug) |
| menu / status E2E | 19/19 · 18/18 |
| fuzz / command audit | no problems · 51/55 (network-only: `download`, `gitclone`, `play`, `wiki`) |

**Upgrade note.** `STALE_COMMAND_SEC` still works (default 180 s). If you want
a stricter or looser window it is the only knob you need; `SYNC_GRACE_MS`
(10 s) is for clock skew and rarely needs touching.

## v1.2.1 — HTTPS, a redesign, and the pairing bug behind "the code does not work"

Three things were reported after trying v1.2.0:

> the site only opens once my number is paired · the bot does not work properly
> in places · the site is ugly — fix sizes, fonts, colours, make it professional
> and cool, and put it on HTTPS

### 1. The site is up before WhatsApp is (`web` boots first)

`src/app.js` started the web server *after* loading 55 commands and waiting for
the downloader's binary checks. Any slow or failing download therefore kept the
pair page offline, and the pairing flow that usually followed right afterwards
made it look like "the site opens when the number is paired". The order is now:

```js
await web.start();          // ← first, always, ~50 ms after boot
router.loadCommands();
await downloader.init();
await whatsapp.connect();
```

`web.start()` is also wrapped so a failure there can never take the bot down,
and the page itself no longer cares whether the bot's own session has finished
connecting: `/api/pair/info` reports `ready`, and the page says **"Bot is
starting"** instead of failing silently.

### 2. Why a code from the website did not link (the real bug)

WhatsApp closes an **unregistered** socket about a minute after it opens. v1.2.0
treated that close like any other and silently rebuilt the socket — which
invalidates the code that is sitting on the user's screen. Symptom: *"I got a
code, WhatsApp says it is invalid, and the page keeps showing the same one."*

Fixed end to end, in four parts:

| # | fix |
|---|---|
| 1 | a code is only requested once the socket actually reached **pairing mode** (WhatsApp sent a QR) — `waitForPairingReady()`, 25 s timeout, instead of a fixed 1 s sleep and a hope |
| 2 | a pending attempt that closes is **re-opened and rotated**, not rebuilt silently — `pendingCloseAction()` returns `reopen` / `reconnect` / `drop`, and `PAIR_MAX_CODE_ROTATIONS` (20) bounds it |
| 3 | the rotated code is **published into the attempt** (`onPairingCode` → `pairing` record), so the page — which polls every 2 s — shows the new code by itself, with a "Fresh code issued automatically" badge |
| 4 | the attempt's total life went from 4 to **15 minutes** (`PAIR_PENDING_TTL_MS`), because a human has to find *Linked devices → link with phone number* |
| 5 | when a code simply **expires on screen** (WhatsApp codes live 60 s; a human needs longer), the sweep now asks for another one and the page picks it up — no button press. Verified live: rotation 1 at 60 s, rotation 2 at 75 s, a live code on the page every time |
| 6 | two rotation sources firing in the same millisecond used to burn **two** codes, invalidating the one being typed — now debounced (`PAIR_ROTATE_GAP_MS`, 5 s) with one shared ceiling (`PAIR_MAX_CODE_ROTATIONS`, 20) instead of two budgets |

`stateOf()` still keeps `linked` sticky, so a rotated code can never resurrect an
attempt that has already linked.

### 3. Sessions no longer talk through each other's connection

A paired session called `antiban.setSocket(sock)` on connect, overwriting the
**global fallback socket** with the newest session. Typing indicators and
presence then went out through whichever account connected last — the "works in
some places, not others" behaviour. Every paired-session path already passes its
own socket explicitly, so the assignment was removed; the primary session still
owns that slot. Both cases are pinned by tests.

### 4. HTTPS on the panel's single port

The panel allocates **one** port, and a phone browser that types `http://` must
not hit a dead end. The bot now terminates TLS itself on that one port:

| what | how |
|---|---|
| `https://ip:port/` | the whole site, TLS 1.2+, HSTS for 30 days |
| `http://ip:port/` | **301** to the same URL over https (no hang, no "can't be reached") |
| certificate | `SSL_CERT_PATH`/`SSL_KEY_PATH` if you have a real one; otherwise generated once (RSA-2048, SHA-256, ~1 year — the banner prints the real expiry — with SANs for localhost, every local IP and the detected public IP), stored in `data/tls/` and **reused** on every boot |
| the browser warning | appears **once** per device: Advanced → Continue. A real certificate removes it entirely |
| `HTTPS_ENABLED=false` | for a panel that already terminates TLS in front of this port |
| `HTTPS_HSTS_MAX_AGE` | 0 disables the HSTS header |

The terminal banner now prints the `https://` link and says what the warning is
before the user meets it. `PAIR_PUBLIC_URL` is respected but the **scheme is
always the one actually being served** — an `http://` value in `.env` cannot
produce a dead link on an HTTPS bot.

### 5. The redesign — WhatsApp's own colours, liquid glass, cyber edge

The page was rebuilt from the palette up, with WhatsApp's dark theme as the
foundation and the glass as the material:

- **colour** — `#0b141a` background, `#111b21` / `#202c33` panels, `#00a884` →
  `#25d366` green, `#53bdeb` "read receipt" blue for success, `#8696a0` for
  secondary text. Light mode follows WhatsApp's light theme.
- **type** — one system stack, a tight display scale (clamp 28→40 px), tabular
  monospace for everything machine-made (numbers, codes, ports), 10.5 px
  monospaced eyebrows for labels.
- **liquid glass** — a gooey SVG-filtered sheet behind translucent panels, a
  pointer-tracked specular highlight, 30 px backdrop blur with 165 % saturation,
  inset hairline edges.
- **cyber** — a masked engineering grid, a slow scanline sweep, a conic gradient
  ring around the logo, neon focus glow.
- **WhatsApp shapes** — the three steps are **chat bubbles with tails**, success
  is the blue **double tick** with a particle burst, and the code is rendered as
  WhatsApp-style registration boxes that flip in character by character behind a
  countdown ring.
- The owner console (`/admin`) was moved onto the same design system.
- Everything stays self-contained: inline CSS/JS/SVG, no CDN, no fonts, no
  build step; reduced-motion and light mode respected; every interpolation
  escaped.

### 6. Verification (v1.2.1)

| Check | Result |
|---|---|
| unit / integration tests | **303 passed** (+13: `tests/pair-lifecycle.test.js` 9, `tests/https.test.js` 4) |
| pairing lifecycle | code only after pairing mode · reopen+rotate on close · rotation published to the page · finite budget · primary/linked reconnect normally · a paired session never takes the global socket |
| HTTPS | real TLS handshake · 301 from `http://` · HSTS sent · API + owner console over TLS · env certificate wins · missing certificate degrades instead of crashing |
| menu E2E / status E2E | 19/19 · 18/18 |
| fuzz / command audit | no problems · 51/55 (4 network-only) |
| boot order | page reachable within ~1 s of `node index.js`, before any WhatsApp pairing |

**Upgrade note.** If your `.env` still has the v1.2.0 line
`PAIR_PENDING_TTL_MS=240000`, raise it to `900000` (or delete the line) or
attempts will still be dropped after four minutes.

## v1.2.0 — Multi-session: a pair website, per-session bots, and one main number

One process, many bots. Every number you pair runs its **own** WhatsApp
session, its **own** menu and its **own** identity — while exactly one number,
the one you linked from the terminal, stays in charge.

### 1. The pair website (liquid glass, on your panel's public IP)

`GET /` on the bot's port is now a real page instead of a JSON dump:

```
╔════════════════════════════════════════════════════════╗
║                    🌐  PAIR WEBSITE                    ║
║               http://136.67.120.86:3000/               ║
║   Open it on any phone → enter a number → get a code   ║
║          detected via lookup:dns · port 3000           ║
╚════════════════════════════════════════════════════════╝
   ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
   █  … a scannable QR of that link …  █
```

You asked for the link to be **auto-detected and printed in the terminal**
because the panel does not hand the public IP to the process. It is worked out
in layers, cheapest and most reliable first:

| # | source | when it wins |
|---|---|---|
| 1 | `PAIR_PUBLIC_URL` / `PUBLIC_URL` in `.env` | you told the bot exactly |
| 2 | panel/node env vars (`P_SERVER_ALLOCATION_IP`, `SERVER_IP`, `SERVER_ALLOCATION_PORT`, …) | the panel exported them |
| 3 | the port the HTTP server **actually bound to** | always (so the port is never a guess) |
| 4 | the machine's public IP — DNS (`myip.opendns.com` @ OpenDNS), then HTTPS (`api.ipify.org`, `ifconfig.me`) | no env var, outbound traffic allowed |
| 5 | the LAN IPv4 | nothing else worked — and the bot says so loudly |

If layer 5 is what it got, the banner and `.pair` both warn that the address is
**private** and tell you to copy the IP:port from the panel's ALLOCATIONS tab
into `PAIR_PUBLIC_URL`. Nothing about this can block the boot: every lookup has
a 2.5 s timeout and the result is cached for 10 minutes.

The page itself is one self-contained document — inline CSS/JS/SVG, **no CDN,
no build step, no external font** — so it renders identically behind a proxied
panel port or with no internet at all. Aurora background, a gooey SVG liquid
layer, translucent panels with a pointer-tracked specular highlight, the bot's
own logo in a rotating glass ring, digit-grouped input, an 8-character code
that flips in one character at a time, a countdown ring, copy/refresh, and a
live "you are linked" success state that the page polls for. Light mode,
`prefers-reduced-motion` and keyboard/screen-reader paths included.

```
GET  /                     the pair page
POST /api/pair             { number } → { id, code, secondsLeft, state }
GET  /api/pair/status?id=  waiting | linked | expired  (the page polls this)
POST /api/pair/refresh     { id } → a fresh code
GET  /api/pair/info        seats free, mode, TTL
GET  /logo                 the bot's logo for the page
GET  /admin                owner console          (token required)
POST /api/admin/unpair     { phone }              (token required)
GET  /api/status           the original JSON status endpoint, unchanged
GET  /healthz              liveness probe
```

Because this is reachable from the whole internet, it is hardened: 4 KB JSON-only
bodies, a per-IP sliding-window limiter (12/min on the pair API, 60/min on pages,
`Retry-After` on 429), CSP `default-src 'none'`, nosniff, `X-Frame-Options: DENY`,
no-referrer, no-store, and every interpolation escaped — a bot name of
`<img src=x onerror=…>` renders as text (there is a test for exactly that).
`/admin` **refuses to serve anything at all** until you set `PAIR_ADMIN_TOKEN`
(or `STATUS_TOKEN`); without a token nobody gets in, not even you.

### 2. `.pair` — everybody can, and no number means *your* number

| you send | what happens |
|---|---|
| `.pair` | pairs **the number that sent it** — anybody, any session |
| `.pair 94771234567` | pairs another number — **main number only** |
| `.pair refresh` (also `new` / `again` / `retry`) | a fresh code for the attempt already on screen |
| `.pair <your own number>` | refused: that is the bot's own number, with a reason |

The reply is a boxed code with the three taps to use it
(*Linked devices → Link a device → link with phone number instead*), how long it
lives, and the pair-page link. All the rules live in one service
(`src/services/sessions/pairing.js`) that **both** the chat command and the
website call, so the two entrances can never drift apart: phone validation,
"never pair the primary number again" (two linked devices of one account answer
every message twice), a hard session cap, per-number and per-IP budgets, a
30 s cooldown, a 60 s code TTL, and a janitor that tears down a socket nobody
finished linking — an abandoned attempt cannot leave dead credentials behind.

### 3. One main number, and everybody else's own bot

**16 commands are now `mainOnly`** — hidden from the menu *and* refused at
execution time for anyone but the terminal number: `antiban`, `health`,
`proxystatus`, `restart`, `sessions`, `shutdown`, `unpair`, `cleanup`, `mode`,
`setprefix`, `setreaction`, `tagperm`, `autoforward`, `autoreact`, `autoseen`,
`statussettings`. A paired session sees 39 of the 55 commands; the main number
sees all of them.

The gate is deliberately double-locked: `sessionIsPrimary === false` **and**
`sessionId !== 'primary'` both say "not main", because a paired session's
`owner` *is* the person who linked it — matching the sender — and one flag
should never be the only thing between a paired user and the bot-wide settings.
Destructive commands (`.unpair`, `.sessions`) check the gate again for
themselves via `src/utils/mainGate.js`.

**Everybody keeps their own look.** Per-session branding (`src/services/branding.js`)
stores name, header, footer, tagline and logo per number in `data/branding.json`
(logos in `data/branding/`), and `primary` *is* the global identity in
`data/settings.json` — one source of truth, no shadow copy. A session that
customised nothing inherits everything, so a fresh pair looks like your bot
until its owner makes it their own.

| command | who | what |
|---|---|---|
| `.mybot` | everybody | your session's name/header/footer/tagline/logo + how to change them; `.mybot reset` |
| `.setname` `.setheader` `.setfooter` `.settagline` `.setlogo` `.resetlogo` | everybody | main number → the **global** identity; a paired number → **only its own** |
| `.sessions` | main | every session, who is online, what is waiting to link, seats used, codes issued/linked/refused, the pair link |
| `.unpair <number>` | main | disconnects the session, deletes its credentials, cancels a pending code **and forgets its branding** — otherwise the next person to pair that number inherits the previous owner's name and logo |

### 4. Bugs this round found and fixed

* **The help flow leaked the main number's commands.** `menu:help` rendered
  `list()` instead of the caller's filtered list — a paired session was handed
  a documented `.sessions`, `.unpair`, `.restart`. Now it renders
  `base.commands` and wears that session's branding.
* **`+94 (0) 77 123 4567` was normalised three different ways.** The terminal
  prompt dropped the trunk zero, the session manager kept it, the branding key
  kept it — enough to store a session's identity under a key nobody would ever
  look up again. All three now share `src/utils/phone.js`, which also refuses
  to let a device suffix (`…:12@s.whatsapp.net`) become part of a number.
* **`.pair` could print a stale URL.** The link was cached from a discovery made
  *before* the server bound its port, so it showed the configured port rather
  than the real one (and ignored a `PAIR_PUBLIC_URL` set later). It now
  re-resolves against the bound port every time; only the IP lookup is cached.
* **A dead code kept being shown.** Past its 60 s TTL a code can no longer work,
  but the API kept returning it while the socket was open. It now returns
  `codeExpired: true` with an empty code, and "New code" is the only way on.
* **A restored session reported itself as "waiting".** Credentials already on
  disk mean the number is linked from the first moment; `linked` is now sticky.
* **Refreshing a linked number threw an error** ("no longer waiting") where the
  page needed the success view — the "New code" button can now never undo a
  finished pairing.
* **Every code handed out now spends the same budget.** A refresh used to bypass
  the per-number counter, so with the cooldown off one number could farm codes.

### 5. Knobs

```
PAIR_MODE=public|token|off      PAIR_TOKEN=…            PAIR_ADMIN_TOKEN=…
PAIR_PUBLIC_URL=…               PAIR_MAX_SESSIONS=8     PAIR_CODE_TTL_MS=60000
PAIR_PENDING_TTL_MS=240000      PAIR_COOLDOWN_MS=30000  PAIR_RATE_WINDOW_MS=600000
PAIR_MAX_PER_PHONE=3            PAIR_MAX_PER_IP=6       PAIR_HTTP_PER_MIN=12
PAIR_HTTP_API_PER_MIN=90        PAIR_HTTP_PAGE_PER_MIN=60
PAIR_QR=true                    TRUST_PROXY=false
```

All of them are in `.env.example` with exactly the values the code defaults to,
so upgrading cannot silently change behaviour.

Verification: **290/290 tests** — 51 new: 12 web tests over real HTTP on an
ephemeral port, 12 on the pairing service, 8 on per-session branding, 19 on the
multi-session contract (commands *and* the router *and* the card plumbing), menu sim **19/19** (two new scenarios: the
main-only gate end to end, and per-session branding reaching the card), status
sim **18/18**, `bug-hunt.js` **no problems**, command audit **51/55 healthy**
(the 4 are network-only: download, gitclone, play, wiki), and a live boot that
auto-detected the public IP, printed the banner and QR, served the page, and
issued a **real** WhatsApp pairing code through `POST /api/pair`
(`RAMO-CUDI`) before shutting down cleanly on SIGTERM.

> **Preview the page without deploying it:** `node scripts/page-preview.js`
> writes `pair-page-preview.html` and `admin-page-preview.html` — the real pages
> with the logo inlined and a fake backend, so the whole flow is clickable in a
> browser. Try `94750404115` (the bot's own number), `94771111111` (rate
> limited), `94770000000` (bot full) or `12` (invalid).

## v1.1.4 — Anti-ban: stronger protection **and** half the latency

The protection layer was audited with a real benchmark (`scripts/antiban-bench.js`,
real sleeps, fake socket). It found a layer that was **slow where it did not
matter and blind where it did**: every reply — even `🏓 Pong!` — paid a flat
1.5 s "typing" tax, a missing ffmpeg binary scored exactly like a real 403
from WhatsApp, and a restart wiped the risk score completely.

**Speed** — the typing indicator now starts when *your* message arrives
(`antiban.onInbound`), so the human pacing budget overlaps the command's own
work instead of being added to it, and every reply has a hard wall-time cap:

| what the user waits | before | after |
|---|---|---|
| `.ping` (instant command) | 1502 ms | **801 ms** |
| a 1200-character answer | 2202 ms | **1401 ms** |
| a media reply | 2203 ms | **651 ms** |
| first message to a brand-new chat | 3241 ms | **2402 ms** |
| a command that itself takes 400 ms | ~1900 ms | **801 ms** |
| a command that itself takes 1.2 s (AI, download) | ~2700 ms | **1201 ms — the layer adds 0 ms** |
| a DM right after a 14-message group burst | **17 489 ms** | **2376 ms** |

**Strength** — every failure is now classified before it scores anything:

| signal | before | after |
|---|---|---|
| 6 harmless content errors (media expired, ffmpeg, yt-dlp, "give me a number") | risk 48 → **paused 20 s** | risk **0** → keeps sending |
| 3 ordinary reconnects (515 restart-required, 408 timeout) | risk 30 → **paused 20 s** | risk **3** → keeps sending |
| 3 **real** ban signals (403 / 429 / not authorized) | risk 48 → paused 20 s | risk **75 (high)** → **paused 600 s**, escalating 30 s → 2 min → 10 min |
| risk after 10 quiet minutes | 40 → **40** (never decayed) | 50 → **10** (1 point forgiven per 15 s) |
| 10 sends, then a restart | counters **wiped** | counters, risk score and warm-up day **kept** (`data/antiban-state.json`, flushed on shutdown *and* before a crash exit) |
| 5 `.menu` requests back to back | 30 cards fired, 6 counted | **12 cards out, 24 held** by the card budget → image-menu fallback |
| one loud group | ate the whole per-minute budget | capped at 6/min per chat, 450 ms apart — other chats keep flowing |
| a healthy, warm number | ran at the preset | runs at **×1.25** of the preset; a day-0 account at ×0.6, a number in trouble at ×0.25 |

New: the **`turbo` preset** (`.antiban turbo` — 30/min · 400/hr · 2500/day)
for an aged, trusted number, and a much richer `.antiban` / `.health` report
(adaptive factor, per-chat budget, card budget, how failures were classified,
ban-signal escalation, whether the state survived the restart).

> **Upgrading?** If your `.env` still has `ANTIBAN_FAST_MAX_MS=1500` or
> `ANTIBAN_REPLY_MAX_MS=2200`, set them to `800` / `1400` (or delete those
> two lines) — otherwise the old caps keep the old latency.

Verification: **239/239 tests**, menu sim **17/17**, status sim **18/18**,
`bug-hunt.js` **no problems**, command audit **49/53 healthy** (the 4 are
network-only: download, gitclone, play, wiki).

## v1.1.3 — Bug hunt: the two unlocked features, fuzzed and fixed

A dedicated fuzz harness (`scripts/bug-hunt.js`) throws hostile input at
`.tagall` and the status downloader — 20 argument shapes × 9 participant
shapes × 5 permission levels × 31 status argument shapes × 15 status
message shapes, plus restart, TTL, concurrency and cache-limit probes.
It found **7 real bugs**; all are fixed and covered by tests.

| # | Bug found | Impact | Fix |
|---|---|---|---|
| 1 | A long announcement (`.tagall <9000 chars>`) produced one over-long message | WhatsApp rejects it → **the whole tag silently fails** | the text is clamped to `TAGALL_MAX_TEXT` (2400) with a visible `…` |
| 2 | A 20 000-member group was split into **2001 messages** | the rate limiter would throttle that for ~2½ hours | one tagall now sends at most `TAGALL_MAX_MESSAGES` (10); a group too big to *print* is tagged **silently** (everyone still notified) and the bot says so |
| 3 | A participant row without a valid id became a `[object Object]` mention | one bad row made WhatsApp reject the entire message | invalid rows are skipped; mentions are always real jids |
| 4 | Reaction notifications and protocol messages on `status@broadcast` were **cached as statuses** | the cache filled with junk, every download reported "could not be sent" | only real content (media or text) is cached |
| 5 | A **deleted (revoked)** status stayed in the cache | the saver offered a status WhatsApp had already removed | the revoke notice now removes that entry |
| 6 | `.status save` on a quoted message with no content returned **nothing at all** | the classic "no reply" symptom | it always answers: "That message has no status content to save…" |
| 7 | The whole status cache was **RAM only** — every restart wiped it | restart = lose every saved status | the newest `STATUS_PERSIST_MAX` (300) entries are written to `data/status-cache.json` (keys + metadata, never media bytes) and restored at boot, base64-safe so media keys stay real Buffers |

Plus two safety rails that were missing:

- **Send cap** — one `.status` call can no longer fire hundreds of messages
  at WhatsApp (`STATUS_SEND_MAX`, default 100). The reply says how many were
  kept back and how to page through them. It is an anti-ban guard, not a
  feature limit: raise it in `.env`.
- **Crash watchdog** — an uncaught exception used to be logged and ignored,
  so the process could keep running "online but dead". After `CRASH_LIMIT`
  (3) crashes inside `CRASH_WINDOW_MS` (60 s) the bot exits(1) so the panel
  restarts it cleanly. Every crash is written to `data/crash.log` with the
  recent log lines, and **`.health` shows the last crash**.
  `CRASH_RESTART=false` restores the old behaviour.

Measured after the fixes: a 20 000-member tagall takes **42 ms in 11
messages (+9 MB heap)**; the cache survives a restart with downloadable
media keys; the hunt reports **no problems**.

## v1.1.2 — Status saver & tagall unlocked, reaction fully customisable

Two features were artificially limited and one was half-customisable. All
three are now open, and every limit that remains is a setting you can
change (in WhatsApp or in `.env`) instead of a line of code.

### 👁️ Status download — what was restricted and what it does now

| Before (restriction) | Now |
|---|---|
| `.status <number>` only, exact digits, 8–15 characters | any format: `+94 77 123 4567`, `0094…`, `9477…@s.whatsapp.net`, or **mention the person** — 4–20 digits |
| one number at a time | `.status all 10` / `.status latest` — newest statuses of **everyone** cached |
| no way to get your own | `.status me` |
| nothing worked with an empty cache | `.status save` downloads the status you **quoted or forwarded** — no cache, no number |
| no overview | `.status` alone is a **dashboard**: cache stats, automations, and the newest users as a numbered list — reply with a number to download that person |
| empty cache = "No status in RAM", full stop | the bot marks itself available, **subscribes to that contact** and waits (`STATUS_FRESH_WAIT_MS`, 6 s) for a live push, then reports |
| image / video / audio / text only | **sticker and document** statuses are saved too |
| one expired media file killed the whole batch | each item is sent independently; failures are counted and reported |
| 80 statuses per user, 2000 users, 48 h, hard-coded | `STATUS_MAX_PER_USER=200`, `STATUS_MAX_USERS=5000`, `STATUS_TTL_HOURS=72`, `STATUS_MAX_MEDIA_MB=100` — all env-tunable |
| statuses only arrived while the bot was online | `.autoforward on` re-sends every new status to your chat the moment it arrives; `SYNC_FULL_HISTORY=true` also pulls recent statuses at boot |
| the cache could never be emptied | `.status clear` (owner) |

```text
.status                 dashboard + numbered user list
.status 94771234567     that person's statuses (newest first)
.status 94771234567 3   newest 3 only
.status all 10          newest 10 of everyone
.status me              this account's own statuses
.status save            the status you quoted / forwarded
.status clear           empty the RAM cache (owner)
.autoforward on         forward every new status to your chat
.autoforward on 9477xxxx  …or to another number
.autoforward off
```

### 📢 Tagall — restrictions removed

| Before | Now |
|---|---|
| **admins only**, hard-coded | `.tagperm owner \| admin \| all` — default **all** (any member); the owner can always tag |
| one fixed message shape | `.tagall meeting at 8` — your own text |
| mentions always printed | `.tagall hide meeting at 8` — everyone is notified, nothing is printed (alias `.hidetag`) |
| everybody or nobody | `.tagall admins` — tag the admins only |
| no way to tag with a message you received | quote/reply a message and `.tagall` uses its text |
| one giant message — huge groups failed or got truncated | mentions are **chunked** (`TAGALL_CHUNK`, default 100 per message) with a `✅ Tagged 250 member(s) in 3 messages` summary |
| duplicate / device-suffixed participants were tagged twice | participant jids are normalised and de-duplicated |

```text
.tagperm                who may tag? (owner only)
.tagperm all            any member — the default
.tagperm admin          admins + owner
.tagperm owner          owner only
```

### ❤️ Status reaction — fully customisable

`.setreaction` used to take one emoji and **cut it in half** if it was
longer than 8 UTF-16 units, so 👨‍👩‍👧‍👦, 🇱🇰 and 1️⃣ were
stored as broken fragments WhatsApp rejected.

```text
.setreaction            emoji picker — reply with a number (0 = off)
.setreaction 🔥         one emoji
.setreaction 🔥 😍 💯   several: one is picked at random per status
.setreaction off        stop reacting
.autoreact on           re-enable with the saved emoji list
```

Emoji are now parsed as **grapheme clusters** (ZWJ families, flags,
keycaps, skin tones stay whole) and validated — plain words are refused
with an explanation instead of being sent to WhatsApp and silently
dropped. The current list shows in `.settings`, `.statussettings` and
`.health`.

### Fixed along the way

- `normalizeJid()` split on `:` only, so `9477…:12@s.whatsapp.net` lost its
  domain and never matched the owner jid — device-suffixed jids now compare
  correctly everywhere (owner checks, `.unpair`, tagall).
- `.autoreact on` without an emoji used to reset the reaction to ❤️; it now
  keeps your saved list.
- The owner's **own** statuses are cached (for `.status me`) but never
  auto-seen, auto-reacted or forwarded back.
- Auto-forwarded statuses go through the anti-ban-wrapped send, so they get
  the typing indicator and respect the rate limiter.
- `.statussettings` and the Settings card now show every status automation,
  including the forward target.

### Verification (v1.1.2)

| Check | Result |
|---|---|
| `npm test` | **209/209 pass** (159 + 21 status + 15 tagall + 8 status bugs + 6 watchdog) |
| `node scripts/menu-e2e-sim.js` | 17/17 scenarios |
| `node scripts/status-e2e-sim.js` | **18/18 scenarios** (new — status saver + tagall through the real router) |
| `node scripts/bug-hunt.js` | **no problems found** (fuzzes both features) |
| `node scripts/audit-commands.js` | 49–50/53 healthy — the flagged ones need internet (`download`, `gitclone`, `play`, `wiki`) |

## v1.1.1 — Stability pass: the bot never goes quiet on its own

This release fixes the "the bot looks broken" class of problems. The root
cause was the anti-ban layer: **the menu tries several envelopes until one
lands, and every rejected envelope was counted as a failed send.** Three
rejected envelopes (one `.menu` request) pushed the ban-risk score to 36 →
a 45-second silence. Nine (three menu requests) → score 100 → **ten
minutes of total silence**, and the score barely decayed afterwards. That
is exactly what "errors, no reply, nothing works" felt like.

### What was broken and what changed

| Symptom | Cause | Fix |
|---|---|---|
| Bot goes quiet for minutes after a few menus | rejected menu envelopes counted as send failures → risk score → outbound pause | menu envelopes are **probes**: they never raise the risk score, never eat the rate budget and never block |
| "No reply" / replies arrive minutes late | the rate limiter could hold a message for **120 s** | the wait is capped at **15 s** — a late reply beats silence |
| Same, on a new account | the daily warm-up cap added **15–25 s** to every message | reduced to **6–9 s** |
| No typing indicator | the indicator was only sent for text messages, and only through the primary session | cards show it too, every session uses **its own socket**, and it is visible for at least 650 ms |
| `.antiban reset` did not help | it cleared the risk score but **not** the rate pause | the reset now clears both — the bot talks again immediately |
| Ban risk never recovered | the score only decayed 15 % of the time | every good send walks the score down, and the worst pause is 5 min (was 10) |
| Old commands were ignored | the stale-backlog guard was armed forever | the guard is armed for the **first minute after a connect** only — a late command is answered |
| Modes felt broken / locked you out | the control channel was only the self-chat | the owner's **private chat** is always a control channel — owner commands work in every mode |
| "Command failed" with no clue | the error text was swallowed | the reply now names the command and the reason, and `.health` shows the recent log |

### New: `.health` (owner)

The health report straight from WhatsApp — connection, anti-ban state
(risk, pause, rate, typing), the current mode, and the **last warnings and
errors**. It answers "why is the bot quiet?" without opening the panel.

```text
.health            # the full report
.antiban reset     # clear the risk score AND the pause — the bot talks again
.antiban aggressive  # switch the pacing preset at runtime
```

### New: `.setreaction <emoji>`

The status reaction is now a first-class setting (it used to be buried in
`.autoreact on <emoji>`): `.setreaction 🔥` sets the emoji the bot reacts
with on status updates, `.autoreact off` turns it off.

### The customization audit — what you can and cannot change

**From WhatsApp (owner only, no restart, saved in `data/settings.json`)**

| Thing | Command |
|---|---|
| where the bot listens | `.mode self\|inbox\|public\|groups\|all` |
| the bot name (menus, help, banner, cards, sticker pack) | `.setname` |
| the menu card title | `.setheader` |
| the menu card footer | `.setfooter` |
| the card image / logo | `.setlogo` (reply to an image), `.resetlogo` |
| the command prefix | `.setprefix` |
| status auto-seen | `.autoseen on\|off` |
| status auto-react + the emoji **list** | `.autoreact on\|off`, `.setreaction` (picker), `.setreaction 🔥 😍 💯` |
| status auto-forward (+ target number) | `.autoforward on\|off [number]` |
| who may use `.tagall` | `.tagperm owner\|admin\|all` |
| anti-ban on/off, preset, reset | `.antiban on\|off\|reset\|conservative\|moderate\|aggressive` |
| the whole summary | `.settings`, `.statussettings`, `.health` |

**From `.env` (restart required)** — the AI model and persona, the
downloader limits and quality allowlists, the proxy subscription, the web
status port and token, the rate limits and delays (`ANTIBAN_*`), the
session folder, `ALLOW_GROUPS`, `OWNER_ONLY`, the YouTube cookies, the
sticker size cap, the **status cache limits** (`STATUS_TTL_HOURS`,
`STATUS_MAX_PER_USER`, `STATUS_MAX_USERS`, `STATUS_MAX_MEDIA_MB`,
`STATUS_LATEST`, `STATUS_DASH_USERS`, `STATUS_FRESH_WAIT_MS`,
`SYNC_FULL_HISTORY`) and the **tagall behaviour** (`TAGALL_PERMISSION`,
`TAGALL_CHUNK`). **Every knob the code reads is now listed in
`.env.example`** (they were half-hidden before).

**Not configurable at all** — the help text and the command descriptions,
the AI prompt/persona wording, the WhatsApp group/limit messages, the
`Fast • Smart • Clean` slogan in the owner card and the "premium whatsapp
bot" line in the menu crest. These are hardcoded strings; say the word and
they can be moved into the settings.

## v1.1.0 — Settings, modes & branding

Everything the bot shows and where it listens is now changeable **from the
bot itself** — no file editing, no restart. All of it is owner-only and is
saved in `data/settings.json`.

### Operating modes — `.mode`

`.mode` (aliases `.setmode`, `.botmode`) switches where the bot listens.
`.mode` alone lists the modes, `.mode <name>` switches.

| Mode | Where the bot answers |
|---|---|
| `self` | only **"Message yourself"** — the chat with the number the bot runs on |
| `inbox` | only **private 1:1 chats** |
| `public` | **every chat except your own** — the bot is publicly reachable |
| `groups` | only **group chats** |
| `all` | every chat (default — the behaviour before the modes existed) |

- The mode is a **hard filter on the inbound router**: menus, button taps,
  numbered selections and plain commands are all gated, not just the menu.
- A chat that the mode does not cover gets **one** short notice
  (`🔕 Groups — group chats only`) and then the bot stays quiet — no
  spam, no errors.
- **The bot can never be locked out:** owner commands (`.mode`,
  `.settings`, …) always work in your own chat, whatever the mode is.
- The mode survives restarts (`data/settings.json`); `BOT_MODE` in `.env`
  only decides the starting value.

### Branding — `.setname` / `.setheader` / `.setfooter` / `.setlogo`

| Command | What it changes |
|---|---|
| `.setname <name>` | the bot name in the menu crest, the help header, the pairing banner, the "bot is online" message, the info/owner cards and the card footer |
| `.setheader <text>` | the title above the menu card body (empty = no title) |
| `.setfooter <text>` | the line below the menu card (empty = the default) |
| `.setlogo` | the card image — **reply to any image** with `.setlogo`; the picture is stored in `data/branding/` and used as the menu header, the image-menu fallback and the legacy list |
| `.resetlogo` | back to the shipped `assets/logo.jpg` |
| `.settings` | the summary card: mode, name, logo, header, footer, prefix, auto-seen, auto-react |

- The name/header/footer reach **every** menu surface: the native-flow
  card, the bare card, the legacy list, the image menu and the plain text
  menu.
- A custom logo survives restarts and replaces the shipped one everywhere.
- `.setlogo` detects the real file type (JPEG/PNG/WebP) and caps the
  upload at 12 MB.

```env
BOT_MODE=all        # the starting mode (the .mode command overrides it)
BOT_NAME=Sachi MD   # the default name (the .setname command overrides it)
```

## v1.1.0 — Button menu rebuild

The menu is now a **real WhatsApp button menu** (native-flow card) and the
**logo is the card image** — the artwork sits on top, the buttons under it,
exactly like the old logo menu, but tappable. The text-only card, the
legacy list, the logo image menu and the plain text menu all stay as
fallbacks.

- **Button-first delivery ladder.** For every menu screen the bot tries
  1. `native-flow` card **with the logo as media header** (viewOnce
  wrapper), 2. the same card bare, 3. the same card without the image
  (if the logo upload failed), 4. legacy `ListMessage` (renders on iOS/Web),
  5. the logo image menu, 6. the plain text menu. Whatever the phone
  supports, the user gets a menu.
- **The logo travels with the card.** `assets/logo.jpg` is uploaded to
  WhatsApp and attached to the card header (`hasMediaAttachment` +
  `imageMessage`). If the upload fails the card is sent without the image
  instead of shipping an empty header.
- **Per-chat capability learning** (`data/menu-capabilities.json`). The bot
  remembers which envelope actually worked for that chat, remembers chats
  that never send delivery receipts, and remembers envelopes the server
  rejected — so a chat that rejects cards is never asked to render them
  twice. Entries expire after 7 days.
- **No duplicate menus.** A card that is rendered but never acked is *not*
  re-sent as an image; the bot first probes the chat with a tracked 📋
  reaction (a visual no-op) and only falls back when receipts really work.
  Groups keep the card — group receipts are unreliable.
- **Taps run the command.** Native-flow responses are dispatched to the
  command registry: category taps open the category card, command taps run
  the command.
- **Two-step confirmation for dangerous commands** (`shutdown`, `restart`,
  `unpair`, `setprefix`, `cleanup`, `antiban`). The first tap asks for
  confirmation, the second runs it. The confirmation is bound to the chat
  **and** the sender, and expires after 60 s (`MENU_CONFIRM_TTL_MS`).
- Owner-only commands are checked **before** the confirmation card, so a
  non-owner never sees a "confirm" prompt for a command they cannot run.
- **Real menu buttons** — no "Select Options" dropdown. The main menu is one
  button per category, a category page is one button per command, and the
  **`❓ Help` button is always the last one** (`▶️ More` / `◀️ Back` / `🏠 Home`
  sit in front of it). 7 commands per page keeps every card inside the
  native-flow button budget (10 entries).
- The whole menu is **English only** — no Sinhala in the cards, the body
  text or the button labels.
- New logo: `assets/logo.jpg` (1024×1024) is used for the image fallback;
  `assets/logo.png` stays as the master.

```env
MENU_BUTTONS=true              # button menus on (default)
MENU_ENVELOPE_TIMEOUT_MS=7000  # delivery-receipt wait per card
MENU_CONFIRM_TTL_MS=60000      # destructive-confirmation lifetime
```

## v1.0.8 — Quality & Status Center upgrade

### Status Center
- Auto Status Seen can be enabled/disabled with `.autoseen on|off`.
- Auto Status React can be enabled/disabled with `.autoreact on ❤️|off`.
- `.status <number>` sends every status currently delivered to the bot and still available in its in-memory status cache.
- Image and video statuses are downloaded into RAM before sending.
- Text statuses are preserved as text messages.
- Status cache is bounded and expires automatically; expired, private, or undelivered statuses are not bypassed.
- `.statussettings` shows the current automation configuration.

### Premium Menu
- Reworked category navigation with a branded Sachi MD layout.
- Added a dedicated Status Center category.
- Dynamic owner visibility, status automation indicators and quick-access commands.
- Numbered navigation keeps working even when WhatsApp interactive/list-message support is unavailable.

### Downloader fixes
- Video downloads now ensure an FFmpeg binary is available before yt-dlp starts.
- Video requests explicitly use MP4 merging when separate video/audio streams are selected.
- Fixed `.play` so a normal multi-word song title is not accidentally interpreted as a quality value.
- Fixed progress error editing to use the correct message key.
- Existing direct → proxy fallback, RAM limits, isolated proxy sessions and redirect validation remain enabled.

### Tools
- Added `.getdp <number>` plus `.dp`, `.profilepic`, `.pp` aliases.
- Uses the highest-resolution profile-picture URL exposed by WhatsApp/Baileys and handles unavailable/privacy-restricted pictures cleanly.

## Media tools (new)

- `.img2sticker` / `.i2s` / `.cutout` — image → sticker with **AI background cutout**.
  Optional: `npm install @imgly/background-removal-node` (~130 MB, ONNX runs locally, no API key).
  Without it the command still works using a circle-crop fallback.
- `.sticker2img` / `.toimg` / `.s2i` — sticker → image. Static WebP → PNG, animated WebP → MP4 (FFmpeg, auto-downloaded).

## Command reactions (new)

Recognised commands instantly react to the user's message with the command's
own emoji (`.ai` 🤖, `.ytv` 🎬, …), so a slow reply never looks like a dead bot.
Disabled with `REACTIONS_ENABLED=false`. Reactions bypass the typing-simulation
delay on purpose and carry their own light rate limits.

## APK downloader (new)

- `.apk <name>` — search (Google Play + Aptoide merged) → numbered results with real
  names/versions/sizes → reply a number to download. Fallback resolver: F-Droid.
- `.apk <package>` (e.g. `com.whatsapp`) — direct fetch: APKPure → Aptoide.
- `.apk <url>` — any direct APK URL (SSRF-guarded).
- Sources: **APKPure** (latest versions; curl-based WAF-safe resolver) →
  **Aptoide** public API (plain-APK fallback; also used automatically when
  APKPure only has an XAPK bundle, so you get an installable APK) →
  **F-Droid** for FOSS. Downloads are ZIP-verified before sending.
- Default cap `MAX_APK_MB=500` (RAM is consumed fully — lower it on small servers).
- Files are signature-checked (`PK` zip magic) and sent as documents with a
  scan-before-installing warning.

## Important deployment note

The test suite validates local logic, parsers, routing helpers and safety checks. Real WhatsApp status events, profile pictures, YouTube downloads, social-media downloads, FFmpeg execution and live proxy endpoints depend on the deployment server and were not falsely marked as live-tested here.

### Setting the main number in the terminal

Start the bot in a real terminal and it asks for the number the bot runs on:

```
╔══════════════════════════════════════════════════╗
║  📱  SACHI MD — main WhatsApp number               ║
║  The number the bot runs on.                      ║
║  International format, digits only.               ║
║  Example: 94771234567                             ║
╚══════════════════════════════════════════════════╝
  Number [94750404115]: 94771234567
```

- Press **Enter** to keep the number that is already configured.
- The number is validated (8–15 digits, country code first) and saved to
  `.env` as `WA_PHONE_NUMBER` — the next boot is silent.
- `+94 (0) 771-234-567` style input is cleaned up automatically.
- **No terminal (Pterodactyl, Docker, CI): the bot never asks and never
  hangs** — it uses `WA_PHONE_NUMBER` from `.env` straight away.
- Even with a terminal the prompt **gives up after 30 s**
  (`WA_ASK_TIMEOUT_MS`) and continues with the configured number, so an
  unattended start can never hang.
- Once the phone is linked the prompt stays quiet — the number is already
  known. Set `WA_ASK_PHONE=always` to be asked on every start.
- `WA_ASK_PHONE=always|never|if-unset` controls the prompt
  (`always` is the default, and it still only fires when a TTY is attached).

### Bot will not connect? (fast diagnosis)

The bot now fails fast with a clear console message instead of hanging silently:

| Console message | Cause | Fix |
|---|---|---|
| `.env` missing on a panel — bot still pairs to its built-in default number **+94750404115** | default baked into the build | Set `WA_PHONE_NUMBER=<your number>` in `.env` to use a different number, or type it into the terminal on start |
| `Cannot find module …` | Dependencies not installed for this copy | Run `npm install` in the project folder, restart |
| Pairs to the wrong number | default is the built-in `+94750404115` | Set `WA_PHONE_NUMBER=<other number>` in `.env` to override |
| `Primary session was logged out by WhatsApp…` | WhatsApp invalidated the saved session | Restart — a fresh pairing code is shown; link the number again |
| `This session was taken over by another running bot instance…` | Old bot process still running with the same number | Kill/stop the old process, start this one again |
| `Error: Cannot find module …` | Dependencies not installed for this copy | Run `npm install` in the project folder, restart |

Never run two copies of the bot with the same number at once — the newer connection kicks the older one.

Sessions can only be unpaired (`.unpair`) from the bot owner's number — `+94750404115` by default (env: `WA_PHONE_NUMBER`). Paired sessions can use the bot, but removing sessions is locked to the owner number.

## Pterodactyl setup

1. Upload/extract the project.
2. Run `npm install`.
3. (Optional) Copy `.env.example` to `.env` and configure values — **the `.env` file is loaded automatically at startup** (no dotenv package or panel config needed). The bot pairs to its built-in default number **+94750404115** unless `WA_PHONE_NUMBER` says otherwise. Real environment variables still take priority over `.env` values.
4. Start with `npm start`.
5. On first run, the terminal prints a big WHATSAPP PAIRING CODE banner with an easy word-like code (e.g. `MILU-KOTA`). On the phone open WhatsApp > Settings > Linked devices > Link a device > **Link with phone number instead** and type the code. The code lives ~1 minute — if it expires or fails, a fresh code prints automatically; just type the newest one.

### Useful environment variables

```env
BOT_NAME=Sachi MD
BOT_PREFIX=.
WA_PHONE_NUMBER=
SERVER_PORT=3000

V2RAY_SUB_URL=
PROXY_ENABLED=true
PROXY_REFRESH_MINUTES=30
PROXY_REQUEST_TIMEOUT_MS=30000
PROXY_HEALTH_TIMEOUT_MS=10000

MAX_VIDEO_MB=100
MAX_AUDIO_MB=50
MAX_DIRECT_MB=80
MAX_MEDIAFIRE_GB=10
MAX_CONCURRENT_DOWNLOADS=3
MAX_REDIRECTS=5

MENU_BUTTONS=true
MENU_ENVELOPE_TIMEOUT_MS=7000
MENU_CONFIRM_TTL_MS=60000
```

## Commands added/updated

```text
.mode [self|inbox|public|groups|all]
.tagperm [owner|admin|all]
.settings
.setname <name>
.setheader <text>
.setfooter <text>
.setlogo          (reply to an image)
.resetlogo
.setreaction <emoji>
.health           (why is the bot quiet? — the recent log)
.antiban on|off|reset|conservative|moderate|aggressive
```

```text
.status                    dashboard + numbered user list
.status <number> [n]       one person (any number format, or mention them)
.status all|latest [n]     newest statuses of everyone
.status me                 this account's own statuses
.status save               the status you quoted / forwarded
.status clear              empty the RAM cache (owner)
.autoseen on|off
.autoreact on|off          keeps the saved emoji list
.setreaction               emoji picker (reply with a number)
.setreaction 🔥 😍 💯      several emojis → random per status
.autoforward on|off [number]   forward every new status to you
.statussettings
.getdp <number>
```

Group:

```text
.tagall [message]          tag everyone (no admin wall)
.tagall hide [message]     notify everyone without the visible @list
.tagall admins [message]   tag the admins only
.tagperm owner|admin|all   who may tag (owner only)
```

YouTube:

```text
.ytv <youtube-url> [quality]
.yta <youtube-url> [bitrate]
.play <song name> [bitrate]
```

## Tests

```bash
npm test                          # 239 unit + integration tests
node scripts/menu-e2e-sim.js      # 17 menu / mode / branding scenarios
node scripts/status-e2e-sim.js    # 18 status-saver + tagall scenarios (through the real router)
node scripts/bug-hunt.js          # fuzzes .tagall + the status saver with hostile input
node scripts/audit-commands.js    # runs EVERY command and flags dead / erroring ones
node scripts/antiban-bench.js     # measures the anti-ban layer (real sleeps — takes ~10 min)
```

All local tests pass in this build (`tests/antiban-strong.test.js` covers the
protection layer: classification, decay, escalation, per-chat fairness, the
card budget, the typing overlap and restart persistence). Live external
services (YouTube, Wikipedia, the APK mirrors) must be tested on the
Pterodactyl server — the audit flags them as network-only, not as broken.


## Web status endpoint

- The bot serves a small JSON status page (port from `config.js`, default 3000).
- It is OPEN by default for backwards compatibility. To protect it, set
  `STATUS_TOKEN` in `.env` — requests then need `?token=…` or an
  `Authorization: Bearer …` header. Never expose it to the public internet
  without a token (it lists your WhatsApp numbers).
## AI reliability

- `.ai` streams with a live placeholder (thinking → composing → final).
- A **dead stream never hangs and never wastes what streamed**: network
  resets / stalls / long-answer cutoffs resolve with the partial answer,
  marked `⚠️ Answer may be incomplete`. Full answers stream to the end.
- **Concurrency:** notrack.ai allows ~1 request per IP — simultaneous
  `.ai` calls queue (FIFO, max wait `NOTRACK_QUEUE_MS`); queue overflow
  gets a friendly "AI is busy" message instead of a rate-limit error.
  Tune with `NOTRACK_MAX_CONCURRENT` / `NOTRACK_QUEUE_MS`.
- Idle watchdog `NOTRACK_IDLE_MS` (45s), hard cap `NOTRACK_TIMEOUT_MS` (90s).

## Menus

- `.menu` — a **real button menu** (native-flow card) with the **logo as
  the card image** and one button per category underneath. Tapping a
  category opens the category card; tapping a command runs it. There is
  no "Select Options" dropdown — everything is a button, and the
  **`❓ Help` button is always last**.
- **Fallback chain (never silent):** logo card → bare logo card → card
  without the image → legacy list message → logo image menu → plain text
  menu. The bot logs every step (`[menu] native-media rejected …`).
- **Per-chat learning:** the envelope that worked for a chat is tried
  first next time; envelopes the server rejected are not retried for that
  chat (`data/menu-capabilities.json`, 7-day TTL).
- **No duplicate menus:** a card that renders but is never acked is kept,
  not re-sent. The bot probes the chat with a tracked 📋 reaction first
  and only falls back when receipts really work. Groups keep the card.
- The classic image menu is still there as a fallback — the logo
  (`assets/logo.jpg`, master `assets/logo.png`) with the full menu as the
  caption. Replace those files to customize the look.
- Design: sans-serif bold headings, small-caps labels, circled numbers
  ❶–❽ for categories, rounded frame lines.
- Numbers still work: reply `1–8` to a menu to open a category, `0` for home.
- Everything in the menu is **English only** (cards, body text, button
  labels). The WhatsApp client shows the first three quick replies as
  chips and turns the rest into a numbered list — still tappable.
- Dangerous commands ask for confirmation first (tap **Confirm**, or send
  `.cmd confirm` / `.cmd cancel`). The confirmation belongs to the chat and
  the sender and expires after a minute.
- Buttons not appearing on a device? Make sure the WhatsApp app is current
  (older/modified apps may not render native-flow buttons — the image and
  text menus keep working regardless). Check the log for
  `[menu] … rejected …` lines.

## Known issues (still open)

Found during the v1.1.0 review — not fixed in this build:

- **Web status endpoint** is open on `0.0.0.0:3000` unless `STATUS_TOKEN`
  is set. It lists the WhatsApp numbers the bot knows — always set a token
  or bind it to localhost behind a reverse proxy.
- **SSRF guard (downloader)** validates the resolved IP *before* the
  request, so a DNS entry that changes between the check and the connect
  (DNS rebind) can still point at a private address. Mitigation: run the
  bot in a network namespace without access to 127.0.0.0/8 or the cloud
  metadata address.
- **Xray start** waits a fixed 650 ms before probing the proxy — on a slow
  box the first health check can fail and cost one extra retry.
- **Owner gate** depends on `config.owner`, which is filled in when the
  primary session connects. Before the first connection every owner-only
  command is refused (by design).
- `wa-sticker-formatter` was removed from `package.json` — it was never
  imported; the sticker pipeline uses the bundled WebP encoder instead.
