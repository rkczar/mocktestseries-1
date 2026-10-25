# AI Video Studio render container (source: ops/video-worker/).
#
# One short-lived container per render task, started by scripts/video-worker.ts:
#   no network, read-only root filesystem, non-root user, all capabilities dropped,
#   CPU / memory / process limits, only the job folder mounted read-write.
# It holds the two heavy local tools — Chromium (draws every frame from the SAME
# HTML template the admin preview uses) and FFmpeg (H.264/AAC MP4) — so neither
# is installed on the host. The render script itself is mounted read-only from
# the release (render.mjs), so a code deploy never needs an image rebuild.
#
#   docker build -t mts-video-render:1 ops/video-worker
FROM node:24.11.1-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium ffmpeg fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/render
RUN npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund --ignore-scripts playwright-core@1.62.1 \
 && npm cache clean --force \
 && rm -rf /root/.npm

ENV HOME=/tmp XDG_CONFIG_HOME=/tmp XDG_CACHE_HOME=/tmp
USER node
ENTRYPOINT ["node", "/opt/render/render.mjs"]
