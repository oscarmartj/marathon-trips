import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Creates two fresh enrolled owners with the API's e2e script (refuses outside test and ci) and hands them over. */
export default function globalSetup(): void {
  const apiDir = join(__dirname, '..', '..', 'api');
  const create = () =>
    execFileSync('pnpm', ['exec', 'tsx', 'scripts/e2e-staff.ts'], { cwd: apiDir, env: { ...process.env, APP_ENV: process.env.APP_ENV ?? 'test' }, encoding: 'utf8' });
  process.env.E2E_STAFF = create();
  process.env.E2E_STAFF_2 = create();
  process.env.E2E_STAFF_3 = create();
  process.env.E2E_STAFF_4 = create();
  process.env.E2E_STAFF_5 = create();
  process.env.E2E_STAFF_6 = create();
}
