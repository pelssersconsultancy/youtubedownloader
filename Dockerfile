FROM node:24-bookworm-slim AS backend-build
WORKDIR /app
RUN corepack enable
COPY backend/package.json backend/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY backend/ ./
COPY docs/skills/suggestions.json ./suggestions.json
RUN pnpm run build

FROM node:24-bookworm-slim AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOME=/config \
    APP_DATA_DIR=/config \
    DOWNLOAD_DIR=/downloads \
    SUGGESTIONS_PATH=/app/suggestions.json \
    YTDLP_PATH=/opt/venv/bin/yt-dlp \
    YTDLP_USE_BROWSER_COOKIES=false
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg nginx python3 python3-venv supervisor ca-certificates \
    && python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir "yt-dlp[default]" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default
WORKDIR /app
COPY --from=backend-build /app/package.json ./package.json
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY --from=backend-build /app/suggestions.json ./suggestions.json
COPY --from=frontend-build /app/dist/frontend/browser /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/supervisord.conf /etc/supervisor/conf.d/youtubedownloader.conf
RUN mkdir -p /config /downloads
VOLUME ["/config", "/downloads"]
EXPOSE 80
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
