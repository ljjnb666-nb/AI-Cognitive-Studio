# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS runtime-base
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get -o Acquire::Retries=3 update && \
    apt-get -o Acquire::Retries=3 install -y --no-install-recommends ca-certificates openssl ffmpeg fonts-wqy-microhei
COPY deploy/fonts.conf /etc/fonts/local.conf
RUN fc-cache -f && npm install --global pnpm@10.30.3
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM runtime-base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/book-intelligence/package.json packages/book-intelligence/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/ingestion/package.json packages/ingestion/
COPY packages/performance/package.json packages/performance/
COPY packages/podcast-generation/package.json packages/podcast-generation/
COPY packages/product-analytics/package.json packages/product-analytics/
COPY packages/provider-gateway/package.json packages/provider-gateway/
COPY packages/shared/package.json packages/shared/
COPY packages/short-video-generation/package.json packages/short-video-generation/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=acs-pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store

FROM dependencies AS build
COPY . .
# Build-only placeholders never configure the runtime. No real secrets enter layers.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build pnpm db:generate
RUN BETTER_AUTH_URL=https://build.invalid BETTER_AUTH_TRUSTED_ORIGINS=https://build.invalid BETTER_AUTH_SECRET=build-only-placeholder-never-use-at-runtime DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build pnpm --filter @ai-cognitive/web build

FROM runtime-base AS production
ENV NODE_ENV=production PORT=3001
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3001
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "--port", "3001", "--hostname", "0.0.0.0"]
