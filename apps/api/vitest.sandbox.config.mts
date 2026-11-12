import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// The payment adapter contract suite against a gateway's real sandbox (plan docs/plans/3.6-adapter-contract-suite.md,
// section 2.4): `pnpm --filter @mt/api test:sandbox` with SANDBOX_ADAPTER and that sandbox's credentials. No
// database and no app: the suite talks to the adapter only. Never in CI (no keys there).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/contract/sandbox/*.sandbox.ts'],
    fileParallelism: false,
    allowOnly: false,
    passWithNoTests: false,
    testTimeout: 60_000,
  },
});
