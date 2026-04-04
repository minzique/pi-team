# syntax=docker/dockerfile:1.7

# pi-team container image
# - Node 20 base
# - pi coding agent (global install)
# - tmux for session layout
# - ttyd for web-based tmux observation
# - pi-team (from this repo)
#
# Runtime:
#   docker run --rm -it \
#     -e ANTHROPIC_API_KEY=... \
#     -e OPENAI_API_KEY=... \
#     -e PITEAM_NAME=emotions \
#     -e PITEAM_AGENTS='claude:anthropic/claude-sonnet-4-5,codex:openai-codex/gpt-5.4:xhigh' \
#     -e PITEAM_TOPIC_FILE=/topics/debate.md \
#     -v $(pwd)/topics:/topics:ro \
#     -p 7681:7681 -p 7682:7682 \
#     ghcr.io/minzique/pi-team:latest
#
# Then:
#   open http://localhost:7681/         (watch tmux in the browser)
#   curl -X POST http://localhost:7682/inject -d 'human message'  (inject)

FROM node:20-slim AS build
WORKDIR /app

# Install build deps first for layer caching
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@10.18.2 --activate \
 && pnpm install --frozen-lockfile=false

COPY tsconfig.json ./
COPY src ./src
COPY bin ./bin
RUN pnpm build

# ---- runtime image ----
FROM node:20-slim AS runtime
WORKDIR /app

# System deps: tmux, ttyd (for web observation), netcat (socket inject), tini (PID 1)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux \
      netcat-openbsd \
      tini \
      ca-certificates \
      curl \
      bash \
 && curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.$(uname -m) -o /usr/local/bin/ttyd \
 && chmod +x /usr/local/bin/ttyd \
 && rm -rf /var/lib/apt/lists/*

# Install pi globally
RUN npm install -g @mariozechner/pi-coding-agent@latest

# Copy app artifacts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/bin ./bin
COPY --from=build /app/package.json ./package.json

# Symlink the CLI onto PATH
RUN ln -sf /app/bin/pi-team.js /usr/local/bin/pi-team \
 && chmod +x /app/bin/pi-team.js

# Minimal tmux config for clean rendering
RUN printf 'set -g extended-keys on\nset -g extended-keys-format csi-u\nset -g mouse on\nset -g history-limit 50000\nset -g default-terminal "tmux-256color"\n' > /root/.tmux.conf

ENV PITEAM_HTTP_PORT=7682 \
    PITEAM_TTYD_PORT=7681 \
    PITEAM_SESSIONS_DIR=/data/sessions \
    PATH=/usr/local/bin:/app/bin:$PATH

EXPOSE 7681 7682
VOLUME ["/data"]

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
