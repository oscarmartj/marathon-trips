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
RUN pnpm --filter @mt/api exec tsc -p tsconfig.build.json && pnpm --filter @mt/web build

FROM base AS api
CMD ["bash", "scripts/api-entrypoint.sh"]

FROM base AS web
CMD ["pnpm", "--filter", "@mt/web", "start"]
