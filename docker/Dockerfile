# One image for the API and the web app in development (docker compose). Not a production image:
# deployment is out of scope until Oscar chooses hosting (docs/research/hosting.md).
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate \
 && apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
# APP_ENV and DATABASE_URL are not needed to build; prisma generate only reads the schema.
RUN pnpm --filter @mt/shared build && pnpm --filter @mt/api exec prisma generate
# WEB_ORIGIN is public (not a secret). Static pages bake canonical, Open Graph, hreflang and JSON-LD addresses at build
# time, so the production build must receive it (build.args in deploy/docker-compose.prod.yml).
ARG WEB_ORIGIN
RUN pnpm --filter @mt/api exec tsc -p tsconfig.build.json && pnpm --filter @mt/web build

FROM base AS api
CMD ["bash", "scripts/api-entrypoint.sh"]

FROM base AS web
ARG WEB_ORIGIN
ENV WEB_ORIGIN=${WEB_ORIGIN}
CMD ["pnpm", "--filter", "@mt/web", "start"]
