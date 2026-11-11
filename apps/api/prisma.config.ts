import { defineConfig } from 'prisma/config';

// Migrations run as mt_owner (MIGRATION_DATABASE_URL); the API itself connects as mt_app.
export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed/seed.ts' },
  datasource: { url: process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? '' },
});
