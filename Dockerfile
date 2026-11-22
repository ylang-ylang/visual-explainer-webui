# syntax=docker/dockerfile:1.7-labs
FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
WORKDIR /opt/bridge
COPY remote-app/package.json remote-app/package-lock.json remote-app/.npmrc ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    ./node_modules/.bin/playwright-core install --with-deps chromium-headless-shell && \
    chmod -R a+rX /opt/browsers
COPY LICENSE ./
COPY remote-app/server.mjs remote-app/catalog.mjs remote-app/index.html ./
COPY remote-app/static/ ./static/
ARG SOURCE_REVISION
LABEL org.opencontainers.image.source="https://github.com/ylang-ylang/visual-explainer-webui" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.title="Visual Explainer Web UI"
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.mjs"]
