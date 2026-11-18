FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY backend/ ./
COPY docs/skills/suggestions.json ./suggestions.json
RUN pnpm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOME=/config \
    DOWNLOAD_DIR=/downloads \
    SUGGESTIONS_PATH=/app/suggestions.json \
    YTDLP_PATH=/opt/venv/bin/yt-dlp
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir yt-dlp \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/suggestions.json ./suggestions.json
RUN mkdir -p /config /downloads
EXPOSE 3000
CMD ["node", "dist/main.js"]
