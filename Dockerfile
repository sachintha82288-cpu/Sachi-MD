# Sachi MD v1.3.0 — WhatsApp bot
# Node 20 (Baileys needs >=18.18). Debian slim so the bundled tools can run.
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# ffmpeg = sticker/video/audio work; curl+unzip+zip = downloaded binaries
# (yt-dlp, xray) and archive handling; ca-certificates = TLS everywhere.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip zip ffmpeg tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first (better layer caching). npm ci needs the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Application code
COPY . .

# Runtime state: WhatsApp sessions, proxy cache, downloaded binaries.
# Mount a volume here on hosts that support them, otherwise the link
# has to be redone after a redeploy.
RUN mkdir -p data/tmp sessions bin
VOLUME ["/app/sessions", "/app/data", "/app/bin"]

# 3000 = pair website + status endpoint (HTTPS, self-signed unless you
# mount a real certificate via SSL_CERT_PATH / SSL_KEY_PATH).
EXPOSE 3000

# tini reaps zombies so the crash-watch restarts cleanly.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
