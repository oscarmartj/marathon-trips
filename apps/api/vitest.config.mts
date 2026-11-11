import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests share one PostgreSQL database, so files run one after another.
    fileParallelism: false,
    // Skipped or todo tests fail the run (CI also checks the JSON report).
    allowOnly: false,
    env: { APP_ENV: process.env.APP_ENV ?? 'test', JOBS_WORKERS: 'off' },
  },
});
