# Sachi MD v1.3.0 — deploy guide

The bot has to run as a **long-lived process** (it holds a WhatsApp WebSocket
and a pairing session), not as a serverless function. Any of the options below
works; pick one.

Source: <https://github.com/sachintha82288-cpu/Sachi-MD>

---

## What you must set, on every host

| Variable | Required | Meaning |
|---|---|---|
| `WA_PHONE_NUMBER` | **yes** | the number the bot runs on, digits only, international: `94771234567` |
| `STATUS_TOKEN` | **yes** | protects the web status endpoint on port 3000. Without it that endpoint is public and lists your numbers |
| `BOT_NAME`, `BOT_PREFIX`, `BOT_MODE` | no | `Sachi MD`, `.`, `all` (`self`/`inbox`/`public`/`groups`) |
| `MENU_BUTTONS` | no | `true` = button menu |
| `PAIR_PUBLIC_URL` | recommended | the public URL of the pair page, e.g. `https://sachi-md.onrender.com` |
| `V2RAY_SUB_URL` | optional | v2ray/xray subscription URL **or** one `vmess://` / `vless://` / `trojan://` link |
| `PROXY_ENABLED` | optional | `true` to route outbound HTTP through the V2Ray pool |

The full list (280+ tunables: anti-ban timings, download caps, status saver
limits, tagall, crash-watch) is in `.env.example` with comments.

---

## 1. Render (recommended — free tier, Docker)

`render.yaml` is in the repo, so Render can do it in one step:

1. <https://dashboard.render.com> → **New** → **Blueprint** → connect
   `sachintha82288-cpu/Sachi-MD`.
2. Render reads `render.yaml`, builds the `Dockerfile`, and asks for the
   `sync: false` secrets. Paste `WA_PHONE_NUMBER` and your `V2RAY_SUB_URL`.
3. Deploy. When the log shows the pairing card, open the service URL and pair.
4. Copy the service URL into `PAIR_PUBLIC_URL` and redeploy so the pair page
   prints the right link.

Without a Blueprint: **New → Web Service → Docker**, same repo, and add the
env vars by hand.

> Free instances sleep after ~15 min of inactivity, which drops the WhatsApp
> connection until the next request wakes them. For a bot that must stay
> online, use the Starter plan or Railway/Koyeb.

## 2. Railway

1. <https://railway.app/new> → **Deploy from GitHub repo** → pick the repo.
2. Railway detects `railway.json` and builds the `Dockerfile`.
3. **Variables** tab: add `WA_PHONE_NUMBER`, `STATUS_TOKEN`, `PAIR_PUBLIC_URL`,
   optionally `V2RAY_SUB_URL`.
4. **Settings → Networking → Generate Domain**, then put that domain in
   `PAIR_PUBLIC_URL`.
5. Attach a **Volume** mounted at `/app/sessions` so the link survives
   redeploys. Mount a second one at `/app/data` to keep settings and the
   proxy cache.

## 3. Koyeb / Heroku / Scalingo / Dokku (Procfile)

`Procfile` declares `web: node index.js`. Heroku needs the app's stack to
support a long-running dyno:

```bash
heroku create sachi-md
heroku config:set WA_PHONE_NUMBER=94771234567 STATUS_TOKEN=$(openssl rand -hex 24)
git push heroku main
heroku logs --tail          # pairing card appears here
heroku ps:scale web=1
```

Koyeb: **Create service → GitHub → Node** buildpack, run command
`node index.js`, port `3000`, then add the same variables.

## 4. Pterodactyl / VPS / Docker directly

```bash
git clone https://github.com/sachintha82288-cpu/Sachi-MD.git
cd Sachi-MD
cp .env.example .env        # then edit: WA_PHONE_NUMBER, STATUS_TOKEN
npm install --omit=dev
npm start
```

Docker:

```bash
docker build -t sachi-md .
docker run -d --name sachi-md --restart unless-stopped \
  -p 3000:3000 \
  -e WA_PHONE_NUMBER=94771234567 \
  -e STATUS_TOKEN=change-me \
  -v sachi-sessions:/app/sessions \
  -v sachi-data:/app/data \
  -v sachi-bin:/app/bin \
  sachi-md
docker logs -f sachi-md     # pairing card
```

---

## Pairing the bot

The log prints a QR and a code. On the phone:
**WhatsApp → Settings → Linked devices → Link a device → Link with phone
number instead**, then type the eight digits.

The pair website (port 3000, HTTPS with a self-signed cert by default) does
the same thing in a browser: enter the number, get the code, confirm. Put a
real certificate in `SSL_CERT_PATH` and `SSL_KEY_PATH` to drop the browser
warning, and set `PAIR_MODE=token` plus `PAIR_TOKEN` to lock the page down.

---

## V2Ray / proxy

`V2RAY_SUB_URL` accepts:

* a subscription URL that returns base64-encoded `vmess://` / `vless://` /
  `trojan://` links separated by newlines, or
* a single link, pasted directly.

On boot the bot downloads the Xray core into `bin/`, writes
`data/xray-config.json`, starts a SOCKS lease per config and refreshes the pool
every `PROXY_REFRESH_MINUTES` (30). Downloads fall back to a direct connection
if every config fails, so a dead subscription never breaks the bot. A cached
copy lives in `data/proxy-cache.json`, so a temporary outage of the
subscription URL is survivable.

Keep that URL private: it usually contains your account credentials. Set it as
a host secret (dashboard env var), never commit it to the repo.

---

## After a redeploy

Everything that matters lives on disk:

| Path | Contents |
|---|---|
| `sessions/` | WhatsApp credentials. **Lose this and you must pair again** |
| `data/` | settings, branding, status cache, proxy cache |
| `bin/` | downloaded `yt-dlp`, `ffmpeg`, `xray` |

Mount those three as volumes/allocations if the host supports it. On hosts
without volumes, redeploying means linking the device again — that is normal,
not a bug.

---

## Health check

* `GET /` → pair page (200)
* `GET /healthz` → `{ ok, uptime, sessions, pending, bot }` — no token needed,
  it exposes no phone numbers
* `GET /status` or `/api/status` → status JSON; send `?token=STATUS_TOKEN`
  (or `Authorization: Bearer …`) when a token is set

The process exits if the crash-watch gives up (`CRASH_LIMIT` restarts inside
`CRASH_WINDOW_MS`), so the host's restart policy takes over — that is why the
Dockerfile and `railway.json` set `restart: on-failure`.
