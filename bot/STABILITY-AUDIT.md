# 🩺 Sachi MD — stability & customisation audit (v1.1.4)

Date: 2026-10-21, round 8 added 2026-10-22 · Scope: the whole `src/` tree,
every command, the anti-ban layer (§7 — measured with
`scripts/antiban-bench.js`), the menu delivery ladder, the mode filter and
the settings surface.

---

## 1. The report you sent: "errors, no reply, nothing works, modes broken,
## no typing indicator, the status reaction can't be customised"

Everything in that list had a **real cause** in the code. Here is what was
actually wrong:

### 1.1 The bot muted ITSELF (the big one)

The menu tries several envelopes until one lands (native-flow card → bare
card → plain card → legacy list → image → text). The server **rejecting**
one of them is normal control flow — but every rejection was reported to
the anti-ban health monitor as a **failed send**:

```
after 3 rejected envelopes of ONE .menu request:
  risk = 36  level = elevated  → 45 s of silence
after 9 rejected envelopes (3 menu requests):
  risk = 100 level = critical  → 10 MINUTES of silence
```

The score only decayed 15 % of the time, so the bot stayed quiet long
after the menus. **This is what "the bot looks broken / no reply / nothing
works" was.**

**Fixed:** menu envelopes are now **probes** — they never raise the risk
score, never eat the rate budget and never block. Only the message that
actually reached WhatsApp counts as a send.

### 1.2 The rate limiter could hold a reply for 2 minutes

`beforeOutbound` waited up to **120 s** for the rate cap. The cap was
counted per *envelope attempt*, so 2–3 menu requests exhausted the
12-per-minute budget and the bot then sat in the queue.

**Fixed:** the wait is capped at **15 s**, a late reply beats silence, and
one menu request = one send.

### 1.3 The warm-up penalty was 15–25 s per message

On a fresh account the daily cap (40 messages on day 0) added a
**15–25 second** sleep to *every* message. The bot looked dead.

**Fixed:** 6–9 s, and the cap is now honoured as a soft penalty.

### 1.4 The typing indicator was invisible

- it was only sent for **text** messages — the menu card (the most common
  reply) never showed it;
- the presence socket was only set for the **primary** session, so every
  paired session had no indicator at all;
- the indicator could be on screen for a few milliseconds.

**Fixed:** cards show it, every session uses **its own socket**, and it is
visible for at least 650 ms (`ANTIBAN_TYPING_MIN_MS`).

### 1.5 `.antiban reset` did not unblock the bot

It cleared the risk score but **not** the rate-limiter pause — the bot
stayed silent after a "reset".

**Fixed:** the reset clears both. The preset can also be changed at
runtime (`.antiban aggressive`).

### 1.6 The ban-risk score never recovered

It decayed only 15 % of the time and the worst pause was 10 minutes.

**Fixed:** every good send walks the score down, the decay is time-based
too, and the worst pause is 5 minutes.

### 1.7 Old commands were dropped forever

The stale-backlog guard (`STALE_COMMAND_SEC`, 180 s) was armed for the
whole session, so a command that arrived late (clock skew, a slow
network) was **never answered**.

**Fixed:** the guard is armed for the **first minute after a connect**
only — that is when WhatsApp replays the backlog. Later, a late command
is answered.

### 1.8 The modes could lock the owner out

The control channel was only the **self-chat**. If the bot ran on a
different number than the one you write from, the owner was locked out of
the owner commands — including `.mode` itself.

**Fixed:** the owner's **private chat** is always a control channel.
`.mode` now also says out loud what happens **in the current chat**
("🟢 the bot answers here" / "🔕 the bot stays quiet here").

### 1.9 `.antiban` asked for a confirmation to *show* the status

`antiban` was in the destructive list, so even the read-only status view
produced a "Confirm?" card.

**Fixed:** only `.antiban off` and `.antiban reset` are destructive.

### 1.10 "Something went wrong" with no clue

The command error was swallowed into a generic sentence.

**Fixed:** the reply names the command and the reason, and the new
`.health` command shows the recent warnings/errors from inside WhatsApp.

---

## 2. Dead features — the audit

`scripts/audit-commands.js` runs **every** command through the router
with a fake socket and flags the ones that throw, stay silent or answer
with an error. It is part of the package:

```bash
node scripts/audit-commands.js          # every command
node scripts/audit-commands.js mode     # one command
```

Result on this build: **48/51 commands healthy**; the remaining three
(`download`, `gitclone`, `wiki`) only fail because the audit feeds them
fake URLs — they need the network.

Dead things that were found and fixed:

| Dead thing | Fix |
|---|---|
| the anti-ban module could not even be `require`d from its own folder (`../config` instead of `../../config`) → the whole anti-ban layer was unreachable | fixed |
| `.antiban reset` left the pause in place | fixed |
| `.antiban` (status view) demanded a confirmation | fixed |
| the sticker pack/author was hardcoded `Sachi MD` | follows the bot name now |
| a missing FFmpeg/yt-dlp download produced "Request failed with status code 404" | a readable message now |
| 23 environment knobs the code reads were **not** in `.env.example` | all documented now |
| the mode, the status settings and the anti-ban state were spread over three commands | one `.settings` card + `.health` |

---

## 3. What can be customised — and what cannot

### From WhatsApp (owner only · no restart · saved in `data/settings.json`)

| Thing | Command |
|---|---|
| where the bot listens | `.mode self\|inbox\|public\|groups\|all` |
| the bot name (menus, help, banner, cards, sticker pack) | `.setname` |
| the menu card title | `.setheader` |
| the menu card footer | `.setfooter` |
| the card image / logo | `.setlogo` (reply to an image) · `.resetlogo` |
| the command prefix | `.setprefix` |
| status auto-seen | `.autoseen on\|off` |
| status auto-react + the reaction emoji | `.autoreact on\|off` · `.setreaction 🔥` |
| anti-ban on/off, preset, reset | `.antiban on\|off\|reset\|conservative\|moderate\|aggressive` |
| everything at once | `.settings` |
| why is the bot quiet? | `.health` |

### From `.env` (restart required)

The AI model/persona/API, the downloader limits and quality allowlists,
the proxy subscription, the web status port and token, the rate limits
and delays (`ANTIBAN_*`), the warm-up, the session folder,
`ALLOW_GROUPS`, `OWNER_ONLY`, the YouTube cookies, the sticker size cap.
**Every knob the code reads is now in `.env.example`.**

### Not configurable (hardcoded strings)

- the help text and the command descriptions,
- the AI prompt/persona wording,
- the WhatsApp group/limit messages,
- the `Fast • Smart • Clean` slogan in the owner card,
- the "premium whatsapp bot" line in the menu crest.

These are the only leftovers. Each one is a one-line change to move into
the settings — say the word.

---

## 4. Verification

| Check | Before | After |
|---|---|---|
| unit / integration tests | 136 | **159 passed** |
| menu E2E scenarios | 15 | **17 passed** |
| command audit | – | **48/51 healthy** (3 need the network) |
| clean extract (unzip → npm install → test) | ✓ | ✓ (215 packages / 2 s) |
| live boot + pairing banner | ✓ | ✓ |

---

## 5. Round 6 (v1.1.2) — "look at the status download and tagall, remove
## their restrictions, make the status reaction customisable"

### 5.1 Restrictions found in the status saver

| # | Restriction | Where | Removed by |
|---|---|---|---|
| 1 | exactly one number, 8–15 digits, digits only | `commands/status/status.js` | any format (`+94 77 …`, `0094…`, jid), 4–20 digits, **or a mention** |
| 2 | one person per call | `sendAll()` | `.status all [n]` walks the whole cache (`latest()`) |
| 3 | nothing worked with an empty cache | `sendAll()` returned early | `.status save` downloads the **quoted/forwarded** status straight from the message |
| 4 | no way to see what is cached | – | `.status` alone is a dashboard + a **numbered user list** (reply with a number → download) |
| 5 | no live refresh | – | `requestFresh()` — presence `available` + `presenceSubscribe()` then wait `STATUS_FRESH_WAIT_MS` |
| 6 | image/video/audio/text only | `mediaType()` | **sticker** and **document** statuses are handled |
| 7 | one bad media file aborted the whole batch | `sendAll()` threw | per-item try/catch + a `⚠️ n could not be sent` summary |
| 8 | 80/user · 2000 users · 48 h hard-coded | module constants | env: `STATUS_MAX_PER_USER=200`, `STATUS_MAX_USERS=5000`, `STATUS_TTL_HOURS=72` |
| 9 | statuses only while the bot was online | – | `.autoforward on [number]` re-sends every arrival; `SYNC_FULL_HISTORY=true` pulls them at boot |
| 10 | the cache could not be emptied | – | `.status clear` (owner) |
| 11 | the owner's own status was reacted to / echoed | `handleStatus()` | `key.fromMe` is cached but never seen-marked, reacted or forwarded |
| 12 | a redelivered status could be processed twice | – | unchanged (already de-duplicated) — now covered by a test |

### 5.2 Restrictions found in tagall

| # | Restriction | Removed by |
|---|---|---|
| 1 | **admins only**, hard-coded `⛔ Admin only.` | `.tagperm owner\|admin\|all` (default **all**), owner always allowed |
| 2 | one fixed message | `.tagall <message>`, and a **quoted** message becomes the text |
| 3 | mentions always printed | `.tagall hide …` (alias `.hidetag`) — notify without the `@` list |
| 4 | everybody or nobody | `.tagall admins` |
| 5 | one giant message — large groups failed/truncated | chunked sends (`TAGALL_CHUNK`, default 100) + a summary reply |
| 6 | duplicate / device-suffixed participants tagged twice | `normalizeJid()` + de-duplication |
| 7 | a `groupMetadata()` failure threw a raw error | readable `❌ Could not read the group info — …` |

### 5.3 The status reaction

`.setreaction` existed since v1.1.1 but was still limited: one emoji, and
`String(reaction).slice(0, 8)` **cut complex emoji in half** — 👨‍👩‍👧‍👦
(11 UTF-16 units), 🇱🇰 and 1️⃣ were stored broken and WhatsApp rejected
the reaction. Now:

- grapheme-aware parsing (`Intl.Segmenter`) — families, flags, keycaps and
  skin tones stay whole,
- **several emojis** (`.setreaction 🔥 😍 💯`) → one is picked at random per
  status,
- an **emoji picker** (`.setreaction` with no argument, reply with a
  number; `0` turns auto-react off),
- validation — plain words are refused with an explanation instead of
  being sent to WhatsApp and silently dropped,
- `.autoreact on` (no emoji) keeps the saved list instead of resetting ❤️,
- the list shows in `.settings`, `.statussettings` and `.health`.

### 5.4 Bug fixed outside the two features

`normalizeJid()` in `utils/messages.js` did `String(jid).split(':')[0]`,
which turns `94771234567:12@s.whatsapp.net` into `94771234567` — the domain
disappeared, so a device-suffixed jid never compared equal to the owner
jid. It now strips the device part **and keeps the domain**. This affects
owner detection, `.unpair` and tagall.

### 5.5 Verification (v1.1.2)

| Check | Before | After |
|---|---|---|
| unit / integration tests | 159 | **192 passed** (+21 status, +12 tagall) |
| menu E2E scenarios | 17 | **17 passed** |
| status + tagall E2E scenarios (`scripts/status-e2e-sim.js`) | – | **18 passed** |
| command audit | 48/51 | **49–50/53 healthy** (the flagged ones need the network: `download`, `gitclone`, `play`, `wiki`) |
| registered commands | 51 | **53** (`autoforward`, `tagperm` added) |
| clean extract (unzip → npm install → test → sim) | ✓ | ✓ |

The audit script now snapshots **both** persisted files
(`data/settings.json` and `data/status-settings.json`) so a run can never
leave your automations switched on.

---

## 6. Round 7 (v1.1.3) — "remove the restrictions in .tagall and the status
## downloader, and check what the bugs are"

The restrictions were removed in round 6 (§5). This round is the bug hunt
that followed: a fuzz harness (`scripts/bug-hunt.js`) instead of eyeballing.

### 6.1 What the harness covers

| Area | Cases |
|---|---|
| `.tagall` arguments | 20 shapes: empty, spaces, `hide`/`admins` in every order, `-h`, `--hide`, `hidetag`, 9 000-char text, 500 emoji, RTL text, `ALL`, `Hide`, `undefined`, `null`, `\u0000` |
| participant lists | empty group, 1, 1 000, 20 000, duplicates, device suffixes (`:11@`), string rows, rows without ids, `null` metadata, metadata without `participants`, `groupMetadata()` throwing |
| permission levels | `all`, `admin`, `owner`, `bogus`, empty — each checked for the member **and** the owner |
| `.status` arguments | 31 shapes: `all`/`latest`/`me`/`save`/`clear`/`settings`, bad numbers (`0`, `+`, `abc`, 30 digits), jid forms, limits (`0`, `-3`, `abc`, `1e9`), RTL, NUL |
| status message shapes | empty, null, view-once (v1/v2), ephemeral, document-with-caption, sticker, ptt audio, audio without mimetype, document without filename, reaction message, **protocol revoke**, edited message, 5 000-char caption, missing participant |
| deeper probes | quoted non-status, the bot's own number, every download failing, a 20 000-member tag (time + heap), 3 parallel `.status all`, the send cap, restart survival, expired entries, a corrupt cache file |

### 6.2 Bugs it found (all fixed, all under test)

| # | Bug | Symptom a user would see | Fix |
|---|---|---|---|
| 1 | `.tagall <long text>` built one message over WhatsApp's text limit | the tag **silently fails** | clamp to `TAGALL_MAX_TEXT` (2 400) + `…` |
| 2 | 20 000 members → **2001 messages** | the rate limiter throttles for hours | ≤ `TAGALL_MAX_MESSAGES` (10); too big to print → tag silently and say so |
| 3 | a participant row without an id → `[object Object]` mention | WhatsApp rejects the whole message | invalid rows skipped |
| 4 | reaction / protocol / empty messages cached as statuses | junk in the list, "could not be sent" for every download | only real content is cached (`contentOf()`) |
| 5 | a revoked (deleted) status stayed cached | the saver offers a deleted status | the revoke notice drops that entry (`dropById()`) |
| 6 | `.status save` with a contentless quote returned nothing | **"no reply"** — the round-5 symptom class | it always answers with the reason |
| 7 | the cache was RAM only | every restart lost all saved statuses | `data/status-cache.json` (newest 300, base64-safe so media keys stay Buffers), restored at boot, TTL-checked, corruption-proof |

### 6.3 Safety rails added

- **`STATUS_SEND_MAX` (100)** — one command can no longer fire hundreds of
  messages at WhatsApp; the reply states how many were kept back.
- **Crash watchdog** (`src/utils/crashwatch.js` + `src/utils/crashlog.js`) —
  after `CRASH_LIMIT` (3) uncaught exceptions inside `CRASH_WINDOW_MS`
  (60 s) the process exits(1) so the panel restarts it, instead of staying
  "online but dead". Every crash is appended to `data/crash.log` with the
  recent log lines, capped at 256 KB, and **`.health` shows the last one**.
  `CRASH_RESTART=false` restores the previous log-and-limp behaviour.

### 6.4 Measured after the fixes

| Probe | Result |
|---|---|
| 20 000-member `.tagall` | 42 ms · **11 messages** · +9 MB heap |
| restart with 140 cached statuses | all 140 restored, media key still a Buffer, image downloadable |
| 3 parallel `.status all` | identical results |
| corrupt `status-cache.json` | boot unaffected, cache empty |
| `node scripts/bug-hunt.js` | **no problems found** |

### 6.5 Verification (v1.1.3)

| Check | Result |
|---|---|
| unit / integration tests | **209 passed** (192 + 8 status bugs + 6 watchdog + 3 tagall) |
| menu E2E | 17/17 |
| status + tagall E2E | 18/18 |
| fuzz harness | 0 problems |
| command audit | 49–50/53 healthy (network-only: `download`, `gitclone`, `play`, `wiki`) |
| registered commands | 53 |

### 6.6 Still open (unchanged, documented)

- the downloader's SSRF guard has a DNS-rebind TOCTOU window,
- the web status endpoint listens on `0.0.0.0:3000` and is open unless
  `STATUS_TOKEN` is set (it prints a warning at boot),
- the Xray proxy switch uses a fixed 650 ms sleep,
- the help text, command descriptions, AI persona wording, the
  `Fast • Smart • Clean` slogan and the menu crest line are still
  hardcoded strings.

## 7. Round 8 (v1.1.4) — "check the anti-ban weaknesses, fix them, make the
## protection stronger and make the bot faster"

### 7.1 How it was measured

`scripts/antiban-bench.js` drives the real `AntiBan` object (real `setTimeout`
sleeps, fake socket, isolated `dataDir` per instance) through five scenarios:
single-reply latency across all presets, end-to-end latency with command work
in the middle, burst throughput, per-chat fairness, menu-probe volume, risk
scoring for benign/transient/real signals, idle decay, restart persistence and
hot-path disk I/O. It takes ~10 minutes to run because it does not fake the
waiting. Every number below is from that harness.

### 7.2 Weaknesses found

| # | Weakness | Measured evidence (before) | Why it matters |
|---|---|---|---|
| 1 | The pacing budget was filled by the typing indicator and the **remainder was slept silently** | every short reply paid **1502 ms** (p95 1510) regardless of content; a media reply **2203 ms**; a command that itself took 1.2 s cost the user ~2.7 s | the layer taxed *fast* commands hardest and did nothing useful with the time |
| 2 | **No error classification** — every send failure scored the same | 6 harmless content errors (media expired, missing ffmpeg, yt-dlp exit 1, sticker too big, blocked URL, "give me a number") → risk **48 → PAUSED 20 s** | a missing binary made the bot go silent and look "banned" to its owner |
| 3 | …and real signals scored the same as noise | 3 genuine ban signals (403 / 429 / not authorized) → risk **48 → PAUSED 20 s** — *identical* to the noise above | the one thing that should stop the bot barely did |
| 4 | Ordinary reconnects were treated as trouble | 3 reconnects (515 restart-required, 408 timeout) → risk **30 → PAUSED 20 s** | a flaky VPS network paused the bot repeatedly |
| 5 | **No time decay** | risk 40 after 10 idle minutes → still **40** | one bad morning throttled the whole day |
| 6 | **No escalation** | first and third ban signal both produced a 20 s pause | WhatsApp's "slow down" was answered with a shrug |
| 7 | Protection was **RAM-only** | 10 sends then a restart → minute counter **10 → 0**; risk wiped | combined with the round-7 crash watchdog (which *exits on purpose*) a crash loop reset every limit — the worst possible pattern |
| 8 | One loud chat could starve everybody | a DM after a 14-message group burst waited **17 489 ms** (hit `MAX_BLOCK_WAIT`) | "the bot ignores my private messages" |
| 9 | Menu cards were **unpaced** | 5 `.menu` requests = **30 outbound messages in ~0 ms**, only 6 counted against the rate limit | 30 interactive messages in one second is exactly the traffic shape that gets a number flagged |
| 10 | Warm-up over-cap penalty was flat | every message past the daily cap paid 6 s + up to 1.5 s jitter, again and again | a busy day-0 number stalled on every single reply |
| 11 | Presets were **static** | a healthy 6-month-old number and a day-0 number ran at the same 12/min | no way to be fast *and* safe — the dial was one-dimensional |
| 12 | The typing indicator could hang | nothing cancelled it when a command errored before sending; no TTL | the phone showed "typing…" for 25 s and then nothing |
| 13 | No diagnostics | `.antiban` showed risk/limits only — not *why* anything happened | the owner could not tell "slow by design" from "broken" |

One hypothesis was **disproved** and is recorded so it is not chased again:
synchronous disk I/O on the hot path is *not* a bottleneck — `warmup.recordSend()`
and `capabilities.remember()` measured **0.02 ms** each. They are debounced now
for crash-safety, not for speed.

### 7.3 What changed

- **`health.js` — classification first.** `classifyError()` / `classifyDisconnect()`
  sort every signal into `ban` (401/403/411/419/428/429/440, "not authorized",
  "rate limit", "banned", "logged out", multidevice mismatch), `transient`
  (timeouts, `ECONNRESET`, socket hang up, 5xx, "restart required"), `benign`
  (media expired, ffmpeg, yt-dlp, sticker/webp, blocked URL, DNS/SSRF, JSON,
  "give me", "usage:", "no results") or `unknown`. Points: **25 / 4 / 0 / 8**.
  A strong ban signal cannot be masked by a benign keyword ("403 forbidden while
  downloading media" is still a 403). Disconnect codes are classified too
  (515/408/5xx → +1, 401/403/419/428/440 → ban).
  Risk **decays with time** (1 point per `ANTIBAN_DECAY_MS_PER_POINT`, 15 s) and
  a real ban signal **escalates** the cool-off — 30 s → 2 min → 10 min — even at
  a low score, with a 30-minute "ban memory" (`ANTIBAN_BAN_MEMORY_MS`).
  `throughputFactor()` turns the level into speed: low **×1.25**, elevated ×0.8,
  high ×0.5, critical ×0.25 (clamped 0.15–1.5). `serialize()`/`restore()` keep
  all of it across restarts; state older than an hour is dropped.
- **`rateLimiter.js` — adaptive, fair, budgeted.** Base preset × factor gives
  the *effective* per-minute/hour/day limits, and `delayScale()` shortens or
  lengthens the gaps with the same factor. New per-chat fairness
  (`ANTIBAN_PER_CHAT_PER_MINUTE` 6, `ANTIBAN_PER_CHAT_MIN_MS` 450) so one loud
  group is throttled instead of the whole bot; new probe budget for menu cards
  (`ANTIBAN_PROBE_MAX_PER_WINDOW` 12 per `ANTIBAN_PROBE_WINDOW_MS` 10 s) with
  `probeAllowed()`/`recordProbe()`; `noteOverrun()` counts the times the bot
  sent despite a cap; counters survive a restart.
- **`presence.js` — the wait overlaps the work.** `startTyping()` is called the
  moment a message arrives, `elapsed()` reports how long the indicator has
  already been up, and `beforeSend()` waits only for `max(compose, MIN_VISIBLE)
  − elapsed`. A command that took 1.2 s therefore adds **0 ms**. New
  `cancelTyping()`/`isTyping()` and a 2-minute TTL so a stalled command cannot
  leave "typing…" on screen; a brand-new chat gets a longer compose window
  (`ANTIBAN_NEW_CHAT_TYPING_MS` 2400) than a familiar one (1600).
- **`warmup.js`** — debounced persistence + `flush()` + `serialize()`; the
  over-cap penalty now decays (6 s the first time, 1.5 s for repeats inside a
  minute).
- **`index.js`** — new `onInbound()` / `finishInbound()` (called by
  `sessionManager` and `router`), `probeGate()` (one implementation shared by
  the session and the tests), `warmupFactor()` (day 0 ×0.6 → day 7+ ×1.0)
  multiplied with the health factor, hard wall-time caps per reply
  (`SHORT_MAX_MS` 800, `REPLY_MAX_MS` 1400, `MAX_BLOCK_WAIT_MS` 15 s), a new
  **`turbo` preset** (30/min · 400/hr · 2500/day · 300–1500 ms), a
  re-randomised 45–65 minute background pulse, and the persisted state file
  `data/antiban-state.json` (debounced 2 s, flushed by `stop()`).
- **`sessionManager.js`** — cards go through `antiban.probeGate()`; a spent
  budget throws with `.probeBudget`. `finishInbound()` runs in a `finally` so an
  unanswered message never leaves the indicator up.
- **`router.js`** — `.probeBudget` ends the envelope ladder **without blaming
  the envelope** (no `capabilities.markFailed`), so the user still gets the
  image menu and the card is not permanently disabled for that chat.
  `runCommand()` raises the indicator only when a command will actually run —
  ordinary group chatter never makes the bot look like it is typing.
- **`app.js`** — `flushProtection()` on shutdown, before a watchdog exit, and on
  `process.on('exit')`, so a crash loop cannot reset the protection.
- **`.antiban` / `.health`** — now report the adaptive factor (health × warm-up),
  the effective vs base limits, the per-chat and card budgets, how failures were
  classified, the ban-signal escalation and its memory, whether the state
  survived the restart, and the new `save` sub-command.

### 7.4 Measured after the fixes

| metric | before | after |
|---|---|---|
| short reply (`.ping`), all presets | 1502 ms | **801 ms** (−47 %) |
| long reply (1200 chars) | 2202 ms | **1401 ms** (−36 %) |
| media reply | 2203 ms | **651 ms** (−70 %) |
| message edit | 406–548 ms | **451 ms** (unchanged) |
| first message to a new chat (moderate) | 3241 ms | **2402 ms** (−26 %) |
| end-to-end, command works 400 ms | ~1900 ms | **801 ms** (−58 %) |
| end-to-end, command works 1.2 s | ~2700 ms | **1201 ms — the layer adds 0 ms** |
| DM after a 14-message group burst | 17 489 ms | **2376 ms** (−86 %) |
| 20 replies across 2 chats (deliberate burst) | 77.2 s | **69.9 s** (cap-bound by design) |
| 5 `.menu` requests back to back | 30 cards fired, 6 counted | **12 cards out, 24 held** → image-menu fallback |
| 6 benign content errors | risk 48 → paused 20 s | **risk 0 → no pause** |
| 3 ordinary reconnects | risk 30 → paused 20 s | **risk 3 → no pause** |
| 3 real ban signals | risk 48 → paused 20 s | **risk 75 (high) → paused 600 s**, escalating |
| risk after 10 idle minutes | 40 → 40 | **50 → 10** |
| 10 sends then a restart | counter wiped → 0 | **kept**, risk + pause restored |
| warm-up disk write per send | 0.02 ms sync | **debounced** (0 ms on the hot path) |

### 7.5 Why stronger and faster are not a trade-off here

Both dials read the *same* signal. The effective throughput is

```
preset limits × health factor (1.25 … 0.25) × warm-up factor (0.6 … 1.0)
```

so a quiet, healthy, aged number gets **more** than its preset (12/min → 15/min
and ~20 % shorter gaps), while a day-0 number or a number that just saw a 403
gets far less — and the delays that remain are spent as *visible typing* that
overlaps the command's own work instead of dead air after it. Speed is earned
by good behaviour and withdrawn by bad behaviour, which is why the two goals
moved together instead of against each other.

### 7.6 Verification (v1.1.4)

| Check | Result |
|---|---|
| unit / integration tests | **239 passed** (209 + 30 new in `tests/antiban-strong.test.js`) |
| menu E2E | 17/17 |
| status + tagall E2E | 18/18 |
| fuzz harness (`bug-hunt.js`) | no problems found |
| command audit | 49/53 healthy (network-only: `download`, `gitclone`, `play`, `wiki`) |
| anti-ban benchmark | all five scenarios re-measured (table above) |

### 7.7 Deliberate choices, still open

- **An over-cap message is sent, not dropped.** After `MAX_BLOCK_WAIT_MS` (15 s)
  in the limiter the reply goes out anyway and is counted as an *overrun* in
  `.antiban`. Dropping a user's answer was judged worse than one message over
  the cap; the counter tells the owner the preset is too tight.
- **Reactions still bypass this layer** (fire-and-forget, their own 20/min
  global + 1 s per-chat cooldown, skipped entirely while the bot is paused).
- **A spent card budget degrades to the image menu** — slower for that one
  request, but it never fires 30 interactive messages at WhatsApp.
- `ANTIBAN_TYPING_MIN_MS` (650 ms) is a floor on how human a reply looks; the
  caps can be lowered in `.env` but not below that without editing the file.
- **Upgrade note:** an existing `.env` with `ANTIBAN_FAST_MAX_MS=1500` /
  `ANTIBAN_REPLY_MAX_MS=2200` keeps the old latency — update or delete those
  two lines.
- Unchanged from §6.6: the downloader's SSRF DNS-rebind window, the open web
  status endpoint without `STATUS_TOKEN`, the Xray 650 ms fixed sleep, and the
  hardcoded wording strings.

---

## 8. Round 9 (v1.2.0) — "දැන් අපි මේකේ Multi sessions feature එක හදමු"

The brief, in the words it was given:

1. Host a **pair website** on the Pterodactyl panel's **public IP** — liquid
   glass theme, highest quality.
2. **Anyone** on WhatsApp who sends `.pair` to the bot's number must be able to
   pair normally **via a pair code**; `.pair` with **no number** means the
   **sender's own number**.
3. Only the **main number connected from the terminal** may **manage sessions**
   and do **advanced bot customisations**.
4. **Everyone** can customise **their own bot menu info** — logo, name, header,
   footer.

Three decisions were taken before writing code, because they change the shape of
everything: the pair page is **public with rate limits** (`PAIR_MODE=public`,
per-IP budget, session cap 8, 60 s code TTL); branding applies to **paired
session owners only** (no per-DM-user overrides — a stranger messaging the bot
does not get to restyle it); and because the panel's public IP and port were
unknown, the bot must **detect them and print a dialable link in the terminal**.

### 8.1 What changed structurally

| concern | v1.1.4 | v1.2.0 |
|---|---|---|
| pairing entrance | `.pair` in chat only (owner-ish) | **one service, two entrances**: chat + website (`src/services/sessions/pairing.js`) |
| identity | one global identity in `data/settings.json` | global **plus per-session** overrides (`src/services/branding.js`, `data/branding.json`, logos in `data/branding/`), with inheritance |
| permission tiers | `ownerOnly` (one owner) | `ownerOnly` = owner of **the session you are talking to**, plus a new **`mainOnly`** tier for the terminal number |
| web | JSON status dump on `:3000` | pair page + JSON API + token-gated owner console on the same port; `/api/status` still delegates to the old handler so its contract (and its test) did not move |
| phone normalisation | three separate implementations | one (`src/utils/phone.js`) |
| main-number rule | implicit (`config.owner`) | one definition (`src/utils/mainGate.js`) used by the router *and* by destructive commands |
| terminal output | WhatsApp QR / pairing code | + **pair-URL box and a QR of the website** |

### 8.2 Why the gate is double-locked

A paired session's `config.owner` **is** the person who linked it — that is what
makes `.setname` work for them at all. So "sender == owner" can no longer mean
"this is the main number". `isMainNumber()` now refuses on two independent
signals before it ever compares numbers:

```js
if (cfg.sessionIsPrimary === false) return false;
if (cfg.sessionId && String(cfg.sessionId) !== 'primary') return false;
```

Both are set by `sessionManager.sessionConfigFor()`, which is the only place a
session's config is built. One flag alone would have meant that a single missing
field handed a paired user `.restart`, `.shutdown` and `.unpair`. The commands
that delete files (`.unpair`, `.sessions`) then check the gate **again** for
themselves, because the router is not the only way to reach `execute()`.

Result: a paired session sees **39 of 55** commands; the 16 `mainOnly` ones are
absent from its menu cards, absent from its help text, and refused with a
message that says what it *can* do if typed anyway.

### 8.3 Finding the public address

Layered, cheapest first, every layer timeboxed so the boot can never hang:

| # | source | notes |
|---|---|---|
| 1 | `PAIR_PUBLIC_URL` / `PUBLIC_URL` / `SITE_URL` / `PANEL_PUBLIC_URL` | wins absolutely; protocol added if missing |
| 2 | `P_SERVER_ALLOCATION_IP`, `SERVER_ALLOCATION_IP`, `SERVER_IP`, `PANEL_IP`, `PUBLIC_IP`, `P_SERVER_NODE_FQDN` | what a panel sometimes exports |
| 3 | the port from `server.address().port` | never a guess: it is what actually bound |
| 4 | public IP by **DNS** (`myip.opendns.com` @ 208.67.222.222, 1.1.1.1) then **HTTPS** (`api.ipify.org`, `ifconfig.me`, `icanhazip.com`) | 2.5 s each, cached 10 min |
| 5 | the first non-internal IPv4 of the machine | flagged **private**, with the exact `.env` line to fix it |

The warning matters more than the detection: a bot that prints
`http://10.0.0.4:3000/` and calls it a pair page sends the owner chasing a
WhatsApp bug. Both the banner and `.pair` now say *"that address is private —
set `PAIR_PUBLIC_URL` to the panel's public IP:port"*. The box is measured in
terminal **display cells** (emoji count double) so the right edge does not
wander, and the QR is skipped entirely if `qrcode-terminal` is missing — a
nicety must never break a boot.

### 8.4 Hardening a surface that faces the internet

| control | value |
|---|---|
| request body | 4 KB cap, JSON only, 6 s read timeout, `400` on parse failure |
| per-IP limiter | sliding 60 s window: **12/min** pair API, 90/min other API, 60/min pages; `429` + `Retry-After` |
| per-number budget | 3 codes / 10 min (`PAIR_MAX_PER_PHONE`), **refreshes spend the same budget** |
| per-IP pair budget | 6 codes / 10 min (`PAIR_MAX_PER_IP`), 3× that on refresh |
| code TTL | 60 s; after it, the API returns `codeExpired: true` and an **empty** code |
| abandoned attempt | socket torn down after 240 s by a 15 s janitor (unref'd, so it never holds the process open) |
| session cap | 8 paired sessions; a pending attempt **holds a seat** |
| primary number | can never be paired again (two linked devices of one account answer every message twice) |
| headers | CSP `default-src 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cache-Control: no-store` |
| HTML | every interpolation escaped — a bot name of `<img src=x onerror=alert(1)>` renders as text (tested) |
| owner console | serves **nothing** until `PAIR_ADMIN_TOKEN`/`STATUS_TOKEN` is set; wrong token → `403`; unlinking also calls `branding.forget()` |
| proxy | `X-Forwarded-For` is trusted only when `TRUST_PROXY=true`, otherwise the limiter would key every visitor as the proxy |
| page assets | no CDN, no external font, no build step — inline CSS/JS/SVG, works behind a proxied panel port or with no internet |

### 8.5 Bugs this round found in code that already shipped

| # | bug | why it mattered | fix |
|---|---|---|---|
| 1 | the `menu:help` flow rendered `list()` instead of the caller's filtered list | a paired session was **handed a documented `.sessions` / `.unpair` / `.restart`** — the gate existed but the help text advertised what it hid | render `base.commands`, with that session's brand |
| 2 | `+94 (0) 77 123 4567` was normalised three different ways (terminal prompt dropped the trunk zero, session manager and branding key kept it) | a session could be stored under a key nobody would ever look up again — "my logo disappeared" | one `src/utils/phone.js`, used by all three; it also refuses to let a device suffix (`…:12@s.whatsapp.net`) become part of a number |
| 3 | `.pair` printed a URL discovered **before** the server bound its port | the link showed the configured port, not the real one, and ignored a `PAIR_PUBLIC_URL` set later | `pairUrl()` re-resolves against `server.address().port`; only the IP lookup stays cached |
| 4 | a code kept being advertised after its 60 s TTL while the socket was still open | the page showed a code that could no longer work, and "Copy" copied it | `publicView` blanks `code`/`rawCode` and sets `codeExpired` |
| 5 | a session restored from credentials on disk reported `waiting` | the page would wait forever for a link that had already happened | `linked` is sticky in `stateOf()` |
| 6 | refreshing an already-linked number threw `not-waiting` | the "New code" button answered with an error instead of the success state | `refresh()` returns the linked view |
| 7 | refreshes bypassed the per-number counter | with the cooldown off, one number could farm codes indefinitely | the budget is spent **before** the reuse path |

Bug 1 and bug 2 are the kind that a feature review never catches: both were
correct-looking code that only became wrong when a second session existed.

### 8.6 Verification (v1.2.0)

| Check | Result |
|---|---|
| unit / integration tests | **290 passed** (239 + 51 new: `tests/pair-web.test.js` 12 over **real HTTP** on an ephemeral port, `tests/pairing.test.js` 12, `tests/branding.test.js` 8, `tests/multisession.test.js` 19) |
| menu E2E | **19/19** (two new scenarios: the main-only gate end to end, and per-session branding reaching the card) |
| status + tagall E2E | 18/18 |
| fuzz harness (`bug-hunt.js`) | no problems found |
| command audit | **51/55 healthy** (network-only: `download`, `gitclone`, `play`, `wiki`); `.pair` is skipped by the auditor because it would open a real session |
| live boot | auto-detected the public IP over DNS (`lookup:dns`), printed the banner + QR, served `/` (33 KB), `/logo` (223 KB), `/healthz`, `403` on `/admin` with no token, and issued a **real** WhatsApp code through `POST /api/pair` (`RAMO-CUDI`) — then shut down cleanly on SIGTERM with no stray process |
| clock-sensitive tests | the pairing TTL/janitor test uses `node:test` **mock timers** (60 s code, 240 s socket, 15 s janitor) instead of sleeping, and instead of lowering the production floors |

### 8.7 Deliberate choices, still open

- **`/api/status` stays open by default** (no `STATUS_TOKEN`) for backward
  compatibility — it is the endpoint people's uptime monitors already call. It
  now sits behind the per-IP limiter and the security headers, but it is still
  world-readable JSON about the bot. Set `STATUS_TOKEN` to close it.
- **`/admin` fails closed** (nothing at all without a token) while `/api/status`
  fails open. The asymmetry is intentional: the console lists phone numbers.
- **The pair page is public by default** because that was the choice made for
  this deployment. `PAIR_MODE=token` requires `?token=…` and `PAIR_MODE=off`
  serves a closed notice and refuses every `POST`.
- **A pending attempt holds a session seat.** Otherwise eight people could each
  open a socket and never link, and the ninth real user would be refused.
- **Branding is per session, not per DM user** — a stranger messaging the bot
  cannot restyle it. That was an explicit decision, not an omission.
- **`qrcode-terminal` is a new dependency** (zero transitive deps) for the
  terminal QR; the bot runs without it, it just does not draw the QR.
- Unchanged from §7.7: the downloader's SSRF DNS-rebind window, the Xray 650 ms
  fixed sleep, and the hardcoded wording strings.

---

## 9. Round 10 (v1.2.1) — "web only opens once the number is paired", HTTPS, redesign

Three complaints arrived after v1.2.0 was tried on the panel:

> the site only opens once my (the developer's) number is paired · the bot does
> not work properly in places · the site is ugly — change sizes, fonts, colours,
> make it professional and cool, and put it on HTTPS

Only one of those is cosmetic. The other two were behavioural, and both were
reproducible in the code.

### 9.1 The site was not actually gated on pairing — it just looked that way

`/`, `/api/pair/info` and `POST /api/pair` never checked whether the primary
session was connected. What *did* happen is that `app.start()` ran

```js
router.loadCommands();       // 55 command files
await downloader.init();     // binary checks — can be slow, can fail
web.start();                 // ← the site only appears here
await whatsapp.connect();
```

so any slow or failing download check delayed the listen, and the pairing flow
that normally follows a boot made *"the site works after I paired"* the observed
correlation. `web.start()` is now the first statement in `start()`, wrapped so a
web failure cannot abort the bot, and the page reports `ready:false` + "Bot is
starting" instead of appearing broken.

### 9.2 "I got a code but it does not link" — the pairing socket lifecycle

WhatsApp closes an unregistered socket roughly a minute after it opens (that is
how a QR-less pairing tunnel expires). v1.2.0's `connection.close` handler
treated a *pending pairing attempt* exactly like a linked session: wait 5 s,
rebuild the socket. Rebuilding discards the code WhatsApp had issued — the code
on the user's screen was already dead, the page kept showing it because the
record still said `waiting`, and the next attempt produced a different code.
Nothing in the logs said so; the socket came back "healthy".

| # | defect | fix |
|---|---|---|
| 1 | codes were requested after a **fixed 1 s sleep**, without waiting for pairing mode | `waitForPairingReady()` — polls `qrSeen` / `sock.user` up to 25 s; a code requested too early is a code the server never issued |
| 2 | a pending close rebuilt the socket silently | `pendingCloseAction()` → `reopen` for pending attempts (2 s), `reconnect` for primary and for anything with credentials on disk, `drop` past `PAIR_MAX_CODE_ROTATIONS` (8) |
| 3 | the rotated code never reached the caller | `sessionManager.onPairingCode` → the `pairing` record is updated in place (code, TTL, rotation count), and the page has polled every 2 s all along — so it now updates itself |
| 4 | the attempt's whole life was 4 minutes | `PAIR_PENDING_TTL_MS` default 240 s → **900 s**; a person has to find *Linked devices → link with phone number* |
| 5 | `publicView()` was not idempotent | `rawCode` is stripped, so passing a rendered view back in cannot turn `OLDC-CODE` into something a phone is asked to type |
| 6 | a code that simply **expired on screen** left the page stuck on "code expired" with no rotation at all — the socket-close path never fired because WhatsApp kept the socket open | the 15 s sweep now rotates an expired code itself (`sessionManager.refreshPairingCode`), publishes it through the same `publishCode()` the socket path uses, and the page picks it up on its next 2 s poll |
| 7 | the socket path and the sweep could rotate in the **same millisecond**, issuing two codes and invalidating the first | one shared budget (`PAIR_MAX_CODE_ROTATIONS`, 20) and a 5 s debounce (`PAIR_ROTATE_GAP_MS`) in `publishCode()`, which both paths must pass |

`stateOf()` keeps `linked` sticky, so a rotation arriving after a successful
link can never put a code back on screen (asserted in the lifecycle test).

### 9.3 Typing and presence leaked onto the wrong account

`attachHandlers` called `antiban.setSocket(sock)` for **every** session on
connect. That slot is the *fallback* used when a caller passes no socket, and it
was being overwritten by whichever session connected last — so a paired user's
typing indicator could be sent from a different account. `createSend`, the
router's presence calls and the status handler all pass their own
`session.sock`, so the assignment was simply removed for paired sessions. The
primary still installs itself (it is the only always-present connection). Both
directions are tested.

### 9.4 HTTPS on one allocated port

A panel gives one port and no domain, and the requirement was HTTPS only. The
bot terminates TLS itself:

| layer | behaviour |
|---|---|
| SNI-less plaintext detection | the socket's first byte decides: `0x16` → the TLS server, anything else → a small HTTP server that answers **301** to the `https://` URL. One port, both protocols, no "site can't be reached" |
| certificate | `SSL_CERT_PATH`/`SSL_KEY_PATH` (any real cert) → `data/tls/` (reused) → generated self-signed (RSA-2048, SHA-256, ~1 year — the expiry is read back from the certificate rather than assumed — SANs: localhost, 127.0.0.1, ::1, every local IPv4, the detected public IP) |
| why reuse | the browser warning is accepted **once per device**; regenerating a certificate every boot would re-prompt forever |
| headers | HSTS (`HTTPS_HSTS_MAX_AGE`, 30 days) added to the existing CSP/nosniff/frame-deny set |
| failure mode | no certificate and no generator → **HTTP, loudly logged**, because a bot with no site is worse than a bot with a warning |
| address | `publicUrl.discover({scheme})` and `server.pairUrl()` print the scheme actually served; a stale `http://` in `PAIR_PUBLIC_URL` is rewritten, never printed |

### 9.5 The redesign

The page is rebuilt on WhatsApp's own dark palette (`#0b141a`, `#111b21`,
`#202c33`, `#00a884`, `#25d366`, `#53bdeb`, `#8696a0`) with a light theme that
follows WhatsApp's, then layered: gooey SVG liquid sheet, pointer-tracked
specular highlight, 30 px/165 % backdrop blur, masked engineering grid, scanline
sweep, conic gradient ring, neon focus glow. The three steps are chat bubbles
with tails; success is the blue double tick with a particle burst; the code sits
in WhatsApp-style registration boxes that flip in one character at a time behind
a countdown ring. Type scale is clamped (28→40 px display), every machine-made
string uses tabular monospace, and the owner console was moved to the same
system. Still one self-contained document: no CDN, no webfont, no build step.

### 9.6 Verification (v1.2.1)

| Check | Result |
|---|---|
| unit / integration tests | **303 passed**, 0 skipped (290 + `pair-lifecycle` 9 + `https` 4) |
| lifecycle assertions | pairing-mode wait · reopen/rotate decision · finite budget · rotation published (grouped vs ungrouped asserted) · linked attempt not resurrected · paired session never takes the global socket · primary still does |
| TLS assertions | real handshake over `https://` · `http://` → 301 with the right Location · HSTS present · CSP/frame headers intact · owner console still 403 without a token · env certificate preferred · broken paths degrade instead of throwing |
| live pairing (real WhatsApp) | a web code was issued from a bot whose own number was **not yet paired**; it rotated automatically at 60 s and again at 75 s (rotation 2/20) and the page showed a live code each time, with no button press |
| regressions | the whole v1.2.0 suite (290) still passes unchanged |
| menu / status E2E | 19/19 · 18/18 |
| fuzz / audit | no problems · 51/55 (network-only: `download`, `gitclone`, `play`, `wiki`) |

### 9.7 Deliberate choices, still open

- **A self-signed certificate is not "broken"** — it is the only option on a
  bare IP, and the warning is one tap. Anyone with a domain should put a real
  certificate in `SSL_CERT_PATH`/`SSL_KEY_PATH` (documented in `.env.example`).
- **`HTTPS_ENABLED=false` exists** for panels that already terminate TLS in
  front of the port; blindly forcing TLS there would break a working setup.
- **Rotation is bounded** (8). An attempt that needs more than eight codes is a
  person who is not coming back, and every rotation is a real request to
  WhatsApp from a number that is not linked yet.
- **The pairing socket still belongs to the bot, not to the browser session** —
  closing the tab does not cancel the attempt; it expires (15 min) or links.
- Unchanged from §8.7 and §7.7: the open `/api/status` by default, the
  downloader's SSRF DNS-rebind window, the Xray fixed sleep, hardcoded wording.

---

## 10. Round 11 (v1.2.2) — replay suppression

### 10.1 The report

> a phone with WhatsApp's background running off: open WhatsApp, the messages
> sync, and the bot replies by itself to old commands that are no longer
> relevant

### 10.2 What was actually wrong

`messages.upsert` had a stale guard since v1.1.0, but it was gated on a
one-minute window:

```js
const justConnected = Date.now() - session.connectedAt < 60_000;
if (ageMs > STALE_MS() && justConnected) continue;
```

The window was there for a reason — the author assumed the replay only happens
immediately after a connect. It does not. When the **phone** is offline, the
messages sit on WhatsApp's servers and are pushed to the linked devices
whenever it comes back, which can be hours after the bot connected. Those
replays had original timestamps but arrived outside the window, so they were
routed: the bot sent a full menu for a `.menu` from yesterday, ran `.status`
downloads for an old command, and so on.

Two smaller holes sat next to it:

- `seenIds` lived on the session object, which is thrown away and rebuilt on
  every reconnect — exactly when replays arrive.
- `type: 'append'` (history sync) was dropped, but **not counted**, so nothing
  in the logs or in `.health` explained where the traffic had gone.

### 10.3 The fix

One pure gate, `inboundDecision(msg, session, now)`, evaluated before the
router, the status handler and the de-dupe caches:

| verdict | condition |
|---|---|
| `ignore` | no message body / no id |
| `own` | id in this session's `sentIds` |
| `duplicate` | id in the process-wide `handledIds` cache (8 000 ids, LRU) |
| `backlog` | `timestamp < connectedAt − SYNC_GRACE_MS` — **unconditional** |
| `stale` | `age > STALE_COMMAND_SEC` — **unconditional** |
| `status` | `status@broadcast`, after the two checks above |
| `handle` | everything else |

Design points worth keeping:

- **Timestamp, not "how long have we been connected".** A message that existed
  before this socket opened is a replay by definition, however long the socket
  has been up.
- **Grace, not exactness.** `SYNC_GRACE_MS` (10 s) absorbs clock skew between
  the sender's phone and this server. Without it a fast sender's clock would
  make a live message look like it predates the connection.
- **No timestamp = new.** `messageAgeMs()` returns 0 for a missing or malformed
  stamp, so a bad clock can never make the bot deaf.
- **Statuses obey the same rules.** Reacting to, or auto-forwarding, a status
  that WhatsApp replayed from yesterday is the same bug wearing a different hat.
- **Counted, not silent.** Every refusal increments `session.skipped`, logs one
  readable line, and shows up in `.health` as
  `• Replays : N old message(s) ignored (backlog / stale / duplicate)`.
- **The old behaviour was pinned by a test.** `tests/stale.test.js` had
  "a late command is still answered once the session has been up for a while"
  asserting exactly the reported bug. It is now
  "a command from hours ago is never answered, however long the session has
  been up", plus a counter-assertion that a genuinely recent message is still
  served.

### 10.4 A second error class found while testing

A stored certificate was trusted blindly. An expired certificate, a `key.pem`
that does not match `cert.pem`, or a corrupt file does not fail at
`createServer()` — it fails inside **every TLS handshake**, so the site simply
becomes unreachable and the log says nothing. `tls.stored()` now parses the
certificate, refuses one expiring within a week, and verifies the key pair
(`X509Certificate.checkPrivateKey`), regenerating instead of serving something
broken. Three states are covered by `tests/https.test.js`.

### 10.5 Verification (v1.2.2)

| Check | Result |
|---|---|
| unit / integration tests | **317 passed** (+13 `tests/backlog.test.js`, +1 `tests/https.test.js` — 316 → 317, `tests/stale.test.js` rewritten) |
| the reported scenario | messages from 20 h, 9 h and 30 h ago delivered to a socket connected six hours earlier (notify + append) → all three `backlog`, router helper called **zero** times, `skipped.backlog === 3` |
| live traffic | a message stamped now, delivered on the same socket → `handle` |
| reconnect replay | same id, new session object → `duplicate` |
| clock skew | a 5 s-old message on a 1 s-old socket → `handle` |
| old statuses | a 20 h-old status → `backlog`; a 5 s-old status → `status` |
| menu / status E2E | 19/19 · 18/18 |
| fuzz / audit | no problems · 51/55 (network-only) |

### 10.6 Deliberate choices, still open

- **A message sent while the bot was down is not answered.** That is the point:
  a command from twenty minutes ago is not a request, it is history. The knob
  is `STALE_COMMAND_SEC` if someone wants a wider window.
- **The duplicate cache is process memory**, not disk. After a restart the
  backlog rule still covers it, because every replayed message predates the new
  connection — persistence would add I/O for no additional protection.
- **`SYNC_GRACE_MS` is a 10 s fudge in both directions.** A message really sent
  9 s before the socket opened is treated as new; that is the safe side of the
  trade (one late answer beats a deaf bot).
- Unchanged from §9.7, §8.7 and §7.7: open `/api/status` by default, the
  downloader's SSRF DNS-rebind window, the Xray fixed sleep, hardcoded wording.

---

## 11. Round 12 (v1.2.3) — the tools audit, the logo, and `.sub`

### 11.1 Method

Command audits only prove a command replies without throwing. To find the ones
that *do not work*, every network-backed tool was called for real:
`scripts/tools-probe.js`, 16 checks (Wikipedia, direct download, YouTube search,
yt-dlp itself, metadata, TikTok, Facebook, MediaFire, an actual video merge, an
actual audio merge, sticker conversion both ways, APK search, an actual 11 MB
APK download, GitHub, the AI endpoint). It is deterministic in its verdicts and
prints timings, so it doubles as a regression harness.

`node scripts/tools-probe.js` → **16/16 passing**.

### 11.2 Three real breakages

| # | symptom | cause | fix |
|---|---|---|---|
| 1 | every `.ytv` / `.yta` / `.play` download failed with `ffmpeg exited with code -11` or `Conversion failed!`; `.fb` / `.tiktok` failed on the same path | yt-dlp was given `-o -` (stdout). DASH video and audio are separate streams that have to be **muxed**, and ffmpeg cannot mux into a non-seekable pipe. A panel's `/tmp` is also a small tmpfs (992 MB here) — the intermediate files of one merge filled it, which produced the same error from the other direction | `downloadToTemp()`: download into `data/tmp/<label>/`, merge on disk, read the finished file into memory, delete the directory. The directory is watched while it grows; the largest single artifact is the limit, not the total (a merge legitimately holds video + audio + output at once) |
| 2 | the bot died at random with an `EACCES` stack from `child_process` | `bin/yt-dlp` existed but was not executable; `spawn()` reports that as an `'error'` event and `ytdlpMeta()` had **no** handler, so Node turned it into an uncaught exception and exited. The same hole existed in the Xray lease spawn | `binaries.usable()` — size, exec bit (`chmod +x`), and a real `--version` run; anything that fails is re-downloaded. Both spawn sites now handle `'error'` and fail the operation instead of the process |
| 3 | `.img2sticker` promised an AI cutout it never performed | the model is `@imgly/background-removal-node`, a 130 MB optional dependency that is not installed | the reply now states which method was used and prints the command that enables the AI cutout |

A fourth, self-inflicted during this round: the first version of the size guard
counted the whole temp directory, so a legitimate 9.8 MB merge was rejected as
"larger than the configured limit" because its two source streams were still on
disk. Caught by the probe, fixed to police the largest artifact with a 2.5×
runaway ceiling on the total.

A fifth: the friendly "that media is larger than the 3 MB limit" text was
written for the wrong exit. yt-dlp prints its `File is larger than
max-filesize (…) Aborting.` line to **stdout**, so a stderr-only match never
fired, and the watchdog kill (code −3) had no message of its own — the user
still saw the generic "finished without producing media". Both streams are now
collected and the text is attached to the size kill itself; verified with
`maxMB: 3` → *"That media is larger than the 3 MB limit. Try a lower
quality."*

### 11.3 Defaults that were wrong

- **"best" meant 4K.** `parseVideoQuality('auto')` fell through to `bv*+ba/b`,
  i.e. whatever YouTube ranks first — usually a 4K AV1 stream. That is a
  gigabyte of download and minutes of ffmpeg for a file WhatsApp re-compresses
  to a few MB. Auto now caps at `YTDLP_MAX_HEIGHT` (1080).
- **ffmpeg was only ensured for video**, even though the audio path merges too.

### 11.4 The logo

`assets/logo.jpg` is the uploaded emblem; `assets/logo.png` was removed so two
files cannot disagree about which is the bot. `settings.logoPath()` already
preferred `.jpg`, so every consumer (menu card, pair page `/logo`, owner
console, `.settings`) picks it up with no code change. A 512 px
`assets/logo-web.jpg` is generated for the web pages — the pair page should not
push 1.5 MB over mobile data for a 66 px ring.

### 11.5 `.sub` — an owner command that acts on the fleet

New: `src/services/channels.js` (link parsing + fan-out) and
`src/commands/owner/sub.js`.

| decision | why |
|---|---|
| one command, two protocols | a channel is `newsletterFollow(jid)`, a group is `groupAcceptInvite(code)`; the link decides which |
| bare ids accepted | people paste `0029Vb…` and `AbCdEf…` without the https or the host; rejecting those would be user-hostile |
| per-session report | `N/M` plus a line per number — a partial success must never look like a clean one |
| one failure never stops the batch | concurrency 3, each session isolated; a banned number is reported, not thrown |
| channel name resolved first | `newsletterMetadata` so the confirmation says what was followed |
| `ownerOnly` + `mainOnly` | it changes where **every** number the bot holds is a member — a paired user must not be able to do that to the others |
| aliases `.follow`, `.subscribe`, `.join` | the word people reach for |

### 11.6 Verification (v1.2.3)

| Check | Result |
|---|---|
| unit / integration tests | **324 passed** (+7 `tests/sub.test.js`: parsing, channel fan-out, group fan-out, partial failure, the report, a refused link, the permission flags) |
| live tool probe | **16/16** |
| `.ytv` / `.yta` end to end | driven through `sendYoutube` with a stub socket: 9.8 MB video, 3.7 MB audio, correct mime types |
| quality matrix | all 8 video and 7 audio options resolve on the live site (`--simulate`) |
| media toolkit | image → webp sticker → png, and video → animated webp |
| APK | search across sources, and a real 11.4 MB download verified by its `PK` magic |
| menu / status E2E | 19/19 · 18/18 |
| fuzz / audit | no problems · 51/55 (network-only) |

### 11.7 Deliberate choices, still open

- **The AI cutout stays optional.** 130 MB of model, which a small panel plan
  will not thank you for, and the circle crop is a perfectly good sticker.
- **`.sub` does not verify afterwards.** `newsletterFollow` resolves when
  WhatsApp accepts the request; re-reading the subscription list for eight
  sessions would double the calls for a check nobody reads.
- **A group already joined returns no jid** from `groupAcceptInvite`. That is
  treated as success, because from the owner's point of view the number *is* in
  the group.
- Unchanged from §10.6, §9.7, §8.7 and §7.7: open `/api/status` by default, the
  downloader's SSRF DNS-rebind window, hardcoded wording.

---

## 12. The new emblem (v1.2.4)

Branding only. The upload was 1600×1600, 1.36 MB; sending that as the menu card
on every `.menu` would be a pointless upload, so it is resized with Lanczos and
saved progressive: **1024×1024 q90, 238 KB** for WhatsApp and **512×512 q86,
62 KB** for the web pages. `assets/logo.png` stays deleted — both
`settings.logoPath()` and `menubuttons.logoPath()` fall back to it only when the
JPG is missing, so two files can never disagree about which is the bot.

No behavioural change: **324/324** tests, **19/19** menu E2E, **18/18** status
E2E, probe **16/16**.

---

## 13. The pairing system, rebuilt (v1.3.0)

### 13.1 What was wrong

Nothing crashed. The pairing *worked*, and that is why it survived three rounds:
every test asserted that a code came back, not that a human could use it.

| # | symptom | cause |
|---|---|---|
| 1 | codes were words (`MILU-KOTA`) | the previous round "fixed" unreadable random codes by making them pronounceable. The phone shows a **numeric keypad**. A user had to spell a word on a keypad with no letters on it |
| 2 | the page made you do two jobs at once | the number field, the code and the result were all on screen together, stacked, so the code appeared *below the fold* under a form that was still there |
| 3 | every failure was one line further down | an invalid number, a rate limit and a full bot all wrote into the same red box under the input — the page never said which step you were on |
| 4 | the number was ambiguous | `94771234567` had to be typed internationally, by hand, with no country selector and no handling of the trunk zero — `0771234567` produced `+07712…` |
| 5 | the terminal printed a bare code | the banner had the code and the steps, but not the number it was for, and not in the shape the phone screen shows |
| 6 | the chat reply carried the code inline | `*4821-0937*` in a paragraph; copyable only by selecting a line |

### 13.2 The code

`generateEasyPairingCode()` now returns `String(crypto.randomInt(1,10))` followed
by seven `crypto.randomInt(0,10))` — eight digits, never leading with a zero,
8·10⁷ possibilities. `PAIR_FIXED_CODE` (8 digits, dashes ignored) pins it; a
malformed pin is ignored rather than accepted. 5000 generated codes were
checked: all valid, >98 % unique.

`requestSessionCode()` keeps a **fallback**: if WhatsApp refuses a
client-chosen code (some builds do), the code is requested again without one
and the server's code is used. Before, a refusal turned into "pairing is
broken" after three retries.

### 13.3 The page

Rewritten around a phase machine — `form → code → done` — with the card's own
heading following the phase, a three-step rail that marks itself, the code as
eight cells, a country selector (55 entries, LK first) and a right-hand column
with the exact taps on the phone. Verified in headless Chromium at 1280 px and
390 px, through idle → code → linked; the screenshots in the round-notes are
from that run.

The country selector is built by script, so with JavaScript disabled it is not
rendered at all and the field is the plain international input it always was —
the page degrades instead of breaking.

Two details that were wrong in the first draft and were caught by looking at the
screenshots, not by the tests:

- the mobile top bar wrapped to three lines, because the status pill and the two
  links were all fighting for 390 px — the links are hidden under 640 px;
- the number formatter left an orphan digit (`947 712 3456 7`) because it always
  grouped 3-3-4-4 — it now knows the country.

### 13.4 Tests

`tests/pair-ui.test.js` (11) asserts the code shape, the pin, the grouping
idempotence, the terminal card, `prettyPhone`/`ccOf` agreement, the page's
structure, no external asset, the closed/locked states and the console. One
test compiles the page's inline script with `new Function` — the page ships a
template literal full of escapes, and a single wrong backslash is invisible
until a user opens it. That test has already earned its place twice.

### 13.5 Still open

- The code is still validated by WhatsApp, not by us: a code shown on screen can
  be rejected if the attempt's socket closed first. The page rotates the code
  when that happens, and `.pair refresh` does it on demand.
- `PAIR_FIXED_CODE` is powerful and documented as a testing tool. It is read at
  call time, so it can be changed without a restart — and a panel that sets it
  in production is one `.env` line away from a guessable code.
