#!/usr/bin/env bash
# Container start for the API: migrate as mt_owner, seed demo data (never in production), then serve as mt_app.
set -euo pipefail
cd /app/apps/api
pnpm exec prisma migrate deploy
if [ "${APP_ENV:-}" != "production" ]; then pnpm exec tsx prisma/seed/seed.ts; fi
exec node dist/main.js
