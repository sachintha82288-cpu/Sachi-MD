# Sachi MD Bot v1.3.0 — deploy guide

## What is in this package

- **Button menu (v2)** — the menu is a real WhatsApp button card with the
  **logo as the card image**. Taps open categories and run commands.
- One button per category, one button per command, **`❓ Help` is always
  the last button**. No "Select Options" dropdown. English only.
- 7 commands per page (`▶️ More` / `◀️ Back` / `🏠 Home`).
- Destructive commands (shutdown, restart, unpair, setprefix, cleanup,
  antiban) ask for a confirmation first.
- Automatic fallback chain: logo card → card without image → legacy list →
  logo image menu → plain text menu. Nothing ever ends in silence.
- Per-chat learning (`data/menu-capabilities.json`) so a chat is never
  asked to render an envelope it already rejected.
- **Stability (v1.1.1)** — the bot can no longer mute itself: rejected
  menu envelopes never raise the ban-risk score, the rate limiter never
  holds a reply for more than 15 s, the typing indicator works for every
  session and for the menu cards, and `.antiban reset` really unblocks
  the bot. `.health` shows the whole state + the recent log.
- **Status saver unlocked (v1.1.2)** — `.status` is a real saver now:
  - `.status <number>` (any format: `+94 77 123 4567`, `0094…`, a jid,
    or just mention the person), `.status <number> 3` for the newest 3
  - `.status all 10` — the newest statuses of **everyone** in the cache
  - `.status me` — this account's own statuses
  - `.status save` — the status you **quoted or forwarded** (works with an
    empty cache, no number needed)
  - `.status` — dashboard: what is cached, plus a numbered user list
    (reply with a number to download that person's statuses)
  - `.status clear` — empty the RAM cache (owner)
  - Empty cache for a number? The bot marks itself available, subscribes to
    that contact and waits `STATUS_FRESH_WAIT_MS` for a live push before
    giving up. Sticker and document statuses are supported too, one broken
    media file no longer kills the batch, and limits are env-tunable
    (`STATUS_TTL_HOURS`, `STATUS_MAX_PER_USER`, `STATUS_MAX_USERS`,
    `STATUS_MAX_MEDIA_MB`) instead of hard-coded.
  - `.autoforward on [number]` — every new status is re-sent to your chat
    (or another number) as it arrives, so nothing is missed.
- **Tagall unlocked (v1.1.2)** — no admin wall any more:
  - `.tagperm owner | admin | all` decides who may tag (default **all**,
    the owner always can)
  - `.tagall meeting at 8` — custom message
  - `.tagall hide meeting at 8` — notify everyone without the visible
    `@` list (aliases: `.hidetag`)
  - `.tagall admins` — tag the admins only
  - reply/quote a message and `.tagall` uses its text
  - big groups are **chunked** (`TAGALL_CHUNK`, default 100 mentions per
    message) so a 1000-member group is tagged instead of failing
- **Status reaction is fully customisable (v1.1.2)** — `.setreaction` with
  no argument opens an emoji picker (reply with a number); several emojis
  (`.setreaction 🔥 😍 💯`) are saved and one is picked at random per
  status; ZWJ families (👨‍👩‍👧‍👦), flags (🇱🇰) and keycaps (1️⃣)
  are stored whole instead of being cut in half.
- **Bug hunt (v1.1.3)** — `scripts/bug-hunt.js` fuzzes both features and
  found 7 real bugs, all fixed: over-long announcements were rejected by
  WhatsApp, a 20 000-member tag became 2001 messages, broken participant
  rows produced `[object Object]` mentions, reaction/protocol noise was
  cached as statuses, deleted statuses stayed downloadable, `.status save`
  could answer with nothing at all, and the cache died on every restart.
  The cache now survives restarts (`STATUS_PERSIST`), one command can
  never blast more than `STATUS_SEND_MAX` messages, and a crash watchdog
  (`CRASH_LIMIT` / `CRASH_WINDOW_MS`) restarts the process instead of
  limping on — every crash lands in `data/crash.log` and shows in
  `.health`.
- **Anti-ban reworked (v1.1.4)** — stronger protection *and* real speed:
  - the "typing…" indicator now starts the moment your message arrives, so
    the human pacing overlaps the command's own work: `.ping` answers in
    ~0.8 s instead of ~1.5 s, a media reply in ~0.65 s, and a slow AI or
    download reply costs **0 ms** extra
  - failures are **classified** before they score anything: media-expired,
    ffmpeg, yt-dlp, sticker and "usage" errors score 0, ordinary reconnects
    (515 restart-required, 408 timeout) score almost nothing, while a real
    403 / 429 / "not authorized" cools the bot down 30 s → 2 min → 10 min
  - risk **decays with time** (1 point forgiven per 15 s of quiet) instead
    of only when a send happens to succeed
  - one loud group can no longer starve everybody else (per-chat cap, 450 ms
    between two sends in the same chat), and menu cards have their own
    budget — when it runs out the bot falls back to the image menu instead
    of firing 30 cards at WhatsApp
  - the risk score, the rate counters and the warm-up day count survive a
    restart (`data/antiban-state.json`), flushed on shutdown *and* right
    before a crash exit — a crash loop can no longer "forget" that the
    number was in trouble
  - new `turbo` preset for an aged, trusted number, and a much richer
    `.antiban` / `.health` report
- **Multi-session + pair website (v1.2.0)** — one process, many bots:
  - a **liquid-glass pair page** on `GET /` (self-contained HTML/CSS/JS/SVG,
    no CDN, no build step) that turns any phone number into a WhatsApp
    pairing code and then watches it link
  - the public address is **auto-detected at boot** — `.env` override, then
    panel variables, then the port the server bound to, then a public-IP
    lookup over DNS/HTTPS — and printed in the terminal inside a box with a
    **QR code you can scan**. If all it found is a private address it says so
    and tells you to set `PAIR_PUBLIC_URL` from the panel's Allocations tab
  - `.pair` works for **everybody**: with no number it pairs the number that
    sent it, `.pair <number>` is main-number only, `.pair refresh` gets a
    fresh code. Chat and website share ONE service, so the rules (validation,
    never re-pair the primary number, session cap, per-number and per-IP
    budgets, 60 s code TTL, teardown of attempts nobody finished) cannot drift
  - **one main number** — the one typed in the terminal — is the only caller
    that may manage sessions or change bot-wide settings: 16 commands are
    hidden from everybody else's menu *and* refused if typed
  - **everybody can restyle their own bot**: `.mybot`, `.setname`,
    `.setheader`, `.setfooter`, `.settagline`, `.setlogo`,
    `.resetlogo` write to that session only (`data/branding.json` +
    `data/branding/`); on the main number they write the global identity
  - `.sessions` (sessions, pending codes, seats, counters, pair link) and
    `.unpair` (disconnect, delete credentials, cancel the pending code and
    forget that number's branding)
  - a token-gated **owner console** on `/admin` — it serves nothing at all
    until `PAIR_ADMIN_TOKEN` (or `STATUS_TOKEN`) is set
  - hardened because it faces the internet: 4 KB JSON bodies, per-IP rate
    limits with `Retry-After`, CSP `default-src 'none'`, nosniff, DENY
    framing, no-store, and every interpolation escaped
- **HTTPS pair website** — self-signed certificate generated once and reused,
  or your own certificate via `SSL_CERT_PATH` / `SSL_KEY_PATH`; plain `http://`
  on the same port is answered with a 301 to `https://`
- **Settings, modes & branding — all from the bot, owner only:**
  - `.mode self | inbox | public | groups | all` — where the bot listens
    (the router filter, not just the menu). A chat outside the mode gets one
    short notice and then silence. Owner commands always work in your own
    chat, so the bot can never be locked out.
  - `.setname` / `.setheader` / `.setfooter` / `.settagline` /
    `.setlogo` (reply to an image) / `.resetlogo` / `.settings` — the
    name, the card header, the card footer, the small tagline line and the
    card image. Saved in `data/settings.json`. Since v1.2.0 these are
    per-session: from the main number they change the global identity, from a
    paired number only that number's own bot (see `.mybot`).

## 1. Upload & extract

Pterodactyl: **File Manager → Upload** the zip, then extract it into the
server root (or into a subfolder and set the startup file accordingly).

The package contains a `Sachi-MD-Bot-v1.3.0-button-menu/` folder —
move its contents up one level if you want them in the server root.

## 2. Install

```bash
npm install --omit=dev
```

(`node_modules` is not shipped — the server installs it once.)

## 3. Configure

Copy `.env.example` to `.env` and fill in what you need. The bot loads
`.env` automatically at startup.

```env
BOT_NAME=Sachi MD
BOT_PREFIX=.
WA_PHONE_NUMBER=94750404115     # the number the bot runs on
WA_ASK_PHONE=always             # ask for the number in the terminal (TTY only)
STATUS_TOKEN=change-me           # protects the web status endpoint
V2RAY_SUB_URL=                  # optional: vmess/vless/subscription link
MENU_BUTTONS=true               # button menu (default on)
MENU_ENVELOPE_TIMEOUT_MS=7000
MENU_CONFIRM_TTL_MS=60000
BOT_MODE=all                    # starting mode: self | inbox | public | groups | all

# status saver (v1.1.2) — every limit is tunable, nothing is hard-coded
STATUS_TTL_HOURS=72             # how long a cached status stays available
STATUS_MAX_PER_USER=200
STATUS_MAX_USERS=5000
STATUS_MAX_MEDIA_MB=100
STATUS_LATEST=10                # default count for ".status all"
STATUS_FRESH_WAIT_MS=6000       # live-push wait when nothing is cached
SYNC_FULL_HISTORY=false         # true = also pull recent statuses at boot

# group tagging (v1.1.2)
TAGALL_PERMISSION=all           # owner | admin | all  (also: .tagperm)
TAGALL_CHUNK=100                # mentions per message
```

**Set `STATUS_TOKEN`** — without it the status endpoint (port 3000) is open
to the internet and lists your WhatsApp numbers.

## 4. Start

```bash
npm start
```

**The main number can be typed straight into the terminal:**

```
╔══════════════════════════════════════════════════╗
║  📱  SACHI MD — main WhatsApp number               ║
║  The number the bot runs on.                      ║
║  International format, digits only.               ║
║  Example: 94771234567                             ║
╚══════════════════════════════════════════════════╝
  Number [94750404115]: 94771234567
```

Press Enter to keep the configured number, or type your own — it is checked
and saved to `.env` for the next boot. **Without a terminal (panel, Docker)
the bot never asks** and uses `WA_PHONE_NUMBER` straight away; even with a
terminal the prompt gives up after `WA_ASK_TIMEOUT_MS` (30 s) so an
unattended start can never hang. Once the phone is linked the prompt stays
quiet.

Then the pairing code prints in the terminal (e.g. `MILU-KOTA`). On the
phone: **WhatsApp → Settings → Linked devices → Link a device → Link with
phone number instead** and type the newest code.

## 5. The logo & the branding

`assets/logo.jpg` is the card image (1024×1024). Replace it with your own
file (same name) and restart — no code change needed.
`assets/logo.png` is the lossless master, used if the JPG is missing.

**Or change it from WhatsApp itself (no restart, owner only):**

```text
.mode                     # where the bot listens
.mode groups              # switch the mode
.settings                 # the full summary
.setname Sachi Prime      # the bot name
.setheader My Header      # the card title
.setfooter My Footer      # the line under the card
.setlogo                  # reply to an image to use it as the logo
.resetlogo                # back to assets/logo.jpg
.setreaction 🔥           # the emoji for status updates
.health                   # why is the bot quiet? (state + recent log)
.antiban reset            # clear the ban-risk score and the pause
```

Everything is saved in `data/settings.json` and survives restarts.

## 6. Status saver & tagall (v1.1.2 — restrictions removed)

```text
# statuses (works for anyone, in any chat the mode allows)
.status                     # dashboard + a numbered list of cached users
.status 94771234567         # one person — any format, or just mention them
.status 94771234567 3       # newest 3 only
.status all 10              # newest 10 of EVERYONE cached
.status me                  # this account's own statuses
.status save                # the status you quoted / forwarded
.status clear               # empty the RAM cache (owner)

# automations (owner)
.autoseen on|off
.autoreact on|off           # keeps your saved emoji list
.setreaction                # emoji picker — reply with a number
.setreaction 🔥 😍 💯       # several emojis, one at random per status
.autoforward on             # every new status is sent to your chat
.autoforward on 9477xxxx    # …or to another number
.statussettings

# groups
.tagall meeting at 8        # tag everyone — no admin wall
.tagall hide meeting at 8   # notify everyone, print no @list
.tagall admins              # tag the admins only
.tagperm owner|admin|all    # who may tag (owner only, default: all)
```

Nothing is hard-coded: `STATUS_TTL_HOURS`, `STATUS_MAX_PER_USER`,
`STATUS_MAX_USERS`, `STATUS_MAX_MEDIA_MB`, `STATUS_LATEST`,
`STATUS_FRESH_WAIT_MS`, `SYNC_FULL_HISTORY`, `TAGALL_PERMISSION` and
`TAGALL_CHUNK` are all in `.env.example`.

## 7. Speed & anti-ban (v1.1.4)

Everything below is optional — the defaults are already tuned. Read
`.antiban` (owner only) to see what the bot is doing right now: the
adaptive speed factor, the per-minute budget, the card budget, how recent
failures were classified and whether the protection state survived the last
restart. `.health` shows the short version.

| command | what it does |
|---|---|
| `.antiban` | full protection report |
| `.antiban <preset>` | change the pace — conservative / moderate / aggressive / turbo (`turbo` = 30/min · 400/hr · 2500/day, only for an aged, trusted number) |
| `.antiban on` / `.antiban off` | enable or disable the whole layer |
| `.antiban reset` | clear the risk score, the counters and the ban memory |
| `.antiban save` | write the protection state to disk now |

The knobs that matter most, in `.env`:

```env
ANTIBAN_PRESET=moderate
ANTIBAN_FAST_MAX_MS=800            # short replies: acks, errors, .ping
ANTIBAN_REPLY_MAX_MS=1400          # a normal reply in a known chat
ANTIBAN_NEW_CHAT_TYPING_MS=2400    # the FIRST message to a brand-new chat
ANTIBAN_TYPING_MIN_MS=650          # the indicator must be visible this long
ANTIBAN_MAX_BLOCK_MS=15000         # never sit in the rate limiter longer
ANTIBAN_PER_CHAT_PER_MINUTE=6      # one chat cannot eat the whole budget
ANTIBAN_PROBE_MAX_PER_WINDOW=12    # menu cards per 10 s window
ANTIBAN_DECAY_MS_PER_POINT=15000   # 1 risk point forgiven per 15 s of quiet
```

> **Upgrading from v1.1.3 or older?** If your existing `.env` still
> contains `ANTIBAN_FAST_MAX_MS=1500` or `ANTIBAN_REPLY_MAX_MS=2200`,
> change them to `800` and `1400` (or delete those two lines). Those two
> values are the whole difference between the old ~1.5 s reply and the new
> ~0.8 s one.

Want it even faster? `ANTIBAN_TYPING_MIN_MS=300` and
`ANTIBAN_FAST_MAX_MS=400` — the bot stays polite, it just stops
"thinking" out loud. Want it safer on a fresh number?
`ANTIBAN_PRESET=conservative` and leave `ANTIBAN_WARMUP=true`.

## 8. Multi-session & the pair website (v1.2.0)

One bot process can now carry several WhatsApp numbers. The number you type in
the terminal is the **main** number: it is the only one that manages sessions
and the bot-wide settings. Every other number you pair runs its own session and
can restyle its own menu.

### The pair page — open it on a phone

Start the bot and look at the terminal. It prints the address it worked out,
plus a QR code you can scan with the phone you want to pair:

```
╔════════════════════════════════════════════════════════╗
║                    🌐  PAIR WEBSITE                    ║
║               http://136.67.120.86:3000/               ║
║   Open it on any phone → enter a number → get a code   ║
╚════════════════════════════════════════════════════════╝
```

How that address is chosen, first hit wins:

1. `PAIR_PUBLIC_URL` in `.env` — always wins.
2. Panel variables (`P_SERVER_ALLOCATION_IP`, `SERVER_IP`, allocation ports).
3. The port the HTTP server **actually bound to** (`PORT` / `SERVER_PORT`, default 3000).
4. Your public IP, looked up over DNS and then HTTPS (2.5 s timeout, cached 10 min).
5. The LAN IP — and the bot says loudly that it is NOT reachable from outside.

**On Pterodactyl** the panel usually maps a different public port than the one
inside the container. If the printed link will not open on your phone: open the
server's **Allocations** tab, copy the `IP:port` listed there, put it in `.env`
as `PAIR_PUBLIC_URL=http://THAT_IP:THAT_PORT/` and restart. That one line
overrides every guess, and `.pair` starts printing it too.

The page is a single self-contained document (inline CSS, JS and SVG — no CDN,
no build step), so it renders the same behind a proxied panel port or with no
internet at all. There is a clickable preview if you want to see it before you
deploy: `node scripts/page-preview.js` writes `pair-page-preview.html`.

### Pairing somebody

From WhatsApp — **anybody** may do this:

| you send | what happens |
|---|---|
| `.pair` | pairs the number that SENT it (no number needed) |
| `.pair 94771234567` | pairs another number — main number only |
| `.pair refresh` | a fresh code for the attempt already on screen |

From the website: type the number, tap **Get code**, copy the 8 characters, then
on that phone open WhatsApp → Settings → Linked devices → Link a device →
"Link with phone number instead" → type the code. The page polls itself and
shows a success state the moment the number links.

### Managing the sessions

| command | who | what |
|---|---|---|
| `.sessions` | main | every session, who is online, what is still waiting to link, seats used, codes issued/linked/refused, the pair link |
| `.unpair <number>` | main | disconnect and delete that session, cancel its pending code, forget its stored branding |
| `.mybot` | everybody | your own bot's name, header, footer, tagline, logo — and `.mybot reset` |
| `.setname` `.setheader` `.setfooter` `.settagline` `.setlogo` `.resetlogo` | everybody | the main number changes the GLOBAL identity; a paired number changes only its own |

Sixteen commands are main-only: `sessions`, `unpair`, `restart`, `shutdown`,
`antiban`, `health`, `mode`, `setprefix`, `setreaction`, `tagperm`,
`autoforward`, `autoreact`, `autoseen`, `statussettings`, `cleanup`,
`proxystatus`. They disappear from the menu for everybody else and are refused
if they are typed anyway. A paired session sees 39 of the 55 commands.

### Locking the website down

```env
PAIR_MODE=public          # public, token, or off
PAIR_TOKEN=               # visitors add ?token=… when PAIR_MODE=token
PAIR_ADMIN_TOKEN=         # /admin and /api/admin/* — EMPTY MEANS LOCKED
PAIR_MAX_SESSIONS=8
PAIR_MAX_PER_IP=6         # codes per visitor IP per 10 minutes
PAIR_HTTP_PER_MIN=12      # pair-api requests per minute per IP
```

Even in `public` mode there is not much to abuse: request bodies are capped at
4 KB, every visitor IP is limited per minute (with `Retry-After` on 429), a code
expires after 60 s, an attempt nobody finished is torn down after 4 minutes, one
number may ask three times per ten minutes, the bot's own number can never be
paired again, and `/admin` serves nothing at all until you set a token. The page
sets `Content-Security-Policy: default-src 'none'`, nosniff, DENY framing and
no-referrer, and every string it interpolates is escaped.

### Endpoints

```
GET  /                     the pair page
POST /api/pair             { number } → { id, code, secondsLeft, state }
GET  /api/pair/status?id=  waiting | linked | expired   (the page polls this)
POST /api/pair/refresh     { id } → a fresh code
GET  /api/pair/info        seats free, mode, code TTL
GET  /logo                 the bot's logo, for the page
GET  /admin                owner console                (token required)
POST /api/admin/unpair     { phone }                    (token required)
GET  /api/status           the original JSON status endpoint, unchanged
GET  /healthz              liveness probe
```

## 9. HTTPS, redesign & the pairing fix (v1.2.1)

**The website is now HTTPS on the same port.** Open the link the terminal prints:

    https://<your-ip>:<port>/

The first time, the browser warns about the bot's self-signed certificate:
tap **Advanced → Continue** (once per device; it is remembered). If you type
`http://` instead, the bot answers with a 301 to the https:// address, so a
wrong-scheme link is never a dead end.

Have a real certificate (Let's Encrypt from the panel, Cloudflare origin cert,
a reverse proxy)? Put it in `.env` and the warning disappears for good:

    SSL_CERT_PATH=/home/container/certs/fullchain.pem
    SSL_KEY_PATH=/home/container/certs/privkey.pem

If your panel already terminates TLS in front of this port, set
`HTTPS_ENABLED=false`.

**Why a code sometimes did not link (fixed).** WhatsApp closes an unregistered
pairing socket after about a minute. The bot now re-opens the attempt and asks
for a fresh code, and the page shows it by itself — you will see
"Fresh code issued automatically". Keep the page open while you find
*Linked devices → Link a device → link with phone number*. An attempt now lives
15 minutes (`PAIR_PENDING_TTL_MS=900000`), and rotates at most 8 times
(`PAIR_MAX_CODE_ROTATIONS`).

**The site is up before WhatsApp is.** `web.start()` is the first thing the bot
does, so `/` is reachable within a second of the process starting — no need for
the main number to finish pairing first.

## 10. Old messages are never answered (v1.2.2)

WhatsApp replays everything a number received while it (or the phone) was
offline, with the ORIGINAL timestamps. If your phone keeps WhatsApp in the
background off, opening it can push hours of traffic to the bot at once.

The bot now refuses all of it, unconditionally:

- anything **stamped before the current connection opened** is a replay,
  however long the bot has been running (`SYNC_GRACE_MS=10000` absorbs clock
  skew);
- anything older than `STALE_COMMAND_SEC` (180 s) is ignored as well;
- the same message id is only ever handled once, even across reconnects;
- status updates follow the same rules, so a day-old status is not reacted to.

Refusals are counted, not silent. `.health` shows them:

    • Replays   : 10 old message(s) ignored (backlog / stale / duplicate)

A non-zero number there is healthy — it means the bot is ignoring the past
instead of replying to it.

## 11. Every downloader repaired + `.sub` (v1.2.3)

**Nothing downloads broken any more.** `.ytv`, `.yta`, `.play`, `.fb`, `.tiktok`
were failing because yt-dlp was told to write to stdout, and a DASH video+audio
merge cannot be written to a pipe (`ffmpeg exited with code -11`). Downloads now
land in `data/tmp/`, are merged on disk, read into memory and cleaned up.

**The bot no longer dies from a missing exec bit.** If `bin/yt-dlp` (or the Xray
binary) cannot run, the bot used to exit with an `EACCES` stack. It now checks
the binary first — size, exec bit, and a real `--version` — repairs or
re-downloads it, and never lets a spawn failure reach the process.

**`.sub` — follow/join from every number at once:**

    .sub https://whatsapp.com/channel/0029Vb…
    .sub https://chat.whatsapp.com/AbCdEf…
    .sub 0029VbAbCdEfGhIjKlMnOp12        (bare channel id)
    .sub AbCdEfGhIjKlMnOpQrStUv          (bare invite code)

Every connected session follows the channel or joins the group. You get a
per-number report (`N/M`), so a number that WhatsApp refuses is named instead of
being hidden behind a tick. Aliases: `.follow`, `.subscribe`, `.join`.
Owner-only and main-only, because it changes where every number belongs.

**The logo is yours.** `assets/logo.jpg` — replace that file and restart.

**Check a tool yourself:** `node scripts/tools-probe.js` runs 16 live checks
(Wikipedia, YouTube search/metadata/download, TikTok, Facebook, MediaFire, APK
search + download, GitHub, stickers, the AI endpoint) and prints PASS/FAIL with
timings.

## 12. The new emblem (v1.2.4)

Branding only. Two files carry the logo:

    assets/logo.jpg      1024x1024, 238 KB  -> the menu card / every WhatsApp send
    assets/logo-web.jpg   512x512, 62 KB    -> pair page, /logo, owner console

Replace assets/logo.jpg and restart to re-brand. Or reply to an image with
.setlogo (owner only, no restart); .resetlogo returns to this emblem.

## 13. The pairing system (v1.3.0)

The code is eight digits now, grouped 4-4 (4821-0937) — a phone keypad has no
letters, so the old pronounceable codes (MILU-KOTA) were hard to type.

For testing, pin one code in .env:

    PAIR_FIXED_CODE=11111111

Every pairing code is then 1111-1111. Leave it EMPTY on a public panel: a code
that never changes can be memorised, and anyone who can open the pair page
could link a device to a number they do not own.

The flow is the official one — WhatsApp > Settings > Linked devices >
Link a device > Link with phone number instead > type the code. The terminal,
the .pair reply and the website all show those same four steps and the number
in the same form (+94 77 123 4567).

The pair page is a form with three steps and one phase at a time: the number
field is replaced by the code, the code is replaced by the result. It asks for
the country first (55 countries, the bot's own country preselected), accepts a
pasted +94... or a local 077... number, and has "Different number" / "Link
another number" so no attempt is a dead end.

## Verify the install

```bash
npm test                          # 335 checks, all local
node scripts/menu-e2e-sim.js      # 19 menu / mode / branding / session scenarios
node scripts/status-e2e-sim.js    # 18 status-saver + tagall scenarios
node scripts/bug-hunt.js          # fuzzes both features with hostile input
node scripts/audit-commands.js    # runs every command, flags the dead ones
node scripts/page-preview.js      # writes a clickable preview of the pair page
```
