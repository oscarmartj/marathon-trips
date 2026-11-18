import { defineConfig } from '@playwright/test';

// End-to-end tests against the real API and web app (task 0.3: staff sign-in with password and TOTP).
// CI installs Chromium; locally PW_CHANNEL=chrome uses an installed Chrome. Both servers start here unless already
// running (outside CI). The API needs DATABASE_URL and the migrations applied, as for `pnpm test`.
const API_ENV = {
  APP_ENV: process.env.APP_ENV ?? 'test',
  JOBS_WORKERS: 'off',
  WEB_ORIGIN: 'http://localhost:3000',
  API_PORT: '4000',
  // All specs share one IP, and the sign-in limit is per minute and IP: the suite signs in more often than a person would.
  // The limit itself is covered by the API's own tests.
  AUTH_RATE_LIMIT_PER_MINUTE: '120',
};

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3000',
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @mt/api exec tsx src/main.ts',
      url: 'http://localhost:4000/health',
      env: { ...process.env, ...API_ENV } as Record<string, string>,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm start',
      url: 'http://localhost:3000/api/health',
      // ENABLED_LOCALES: the languages spec needs a second language served; production enables none until Oscar decides (task 8.2).
      env: { ...process.env, API_BASE_URL: 'http://localhost:4000', ENABLED_LOCALES: 'es-ES' } as Record<string, string>,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
